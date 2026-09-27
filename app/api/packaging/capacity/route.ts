import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { CapacityInput, CapacityResponse, DailyCapacity, DailyCapacityRow, LockState, YMD } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { addDays, isValidYmd, weekdayOf } from '@/lib/packaging/scheduleCalendar'
import { resolveCapacity, validateCapacityInput } from '@/lib/packaging/scheduleCapacity'
import {
  countOpenByDates,
  deleteCapacity,
  insertOpLog,
  loadCapacityRows,
  publicDbError,
  upsertCapacity,
  verifyAndTouchLock,
} from '@/lib/packaging/scheduleDb'
import { isWorkday, todayTaipei } from '@/lib/packaging/workdays'

export const dynamic = 'force-dynamic'

// 包裝專區 P1：每日產能表（D48／D49）。規格 §四.4
//
// GET ?from=&to=   （讀；預設 today ～ today+60，最長 180 天）→ CapacityResponse { rows, effective }
//   effective：區間內每個台灣工作日＋區間內「所有」週六（產能對話框要能開關週六加班）
// PUT CapacityPutRequest { lockToken, rows: CapacityInput[1..60] }（packaging_admin＋編輯鎖）
//   每列 validateCapacityInput → upsert；{ date, clear: true } 刪除該日（回到沿用／預設）
//   錯誤：date_not_workday（422）、saturday_has_cards（409，附 date、cardCount）
// 產能修改不進 Undo（產能是事實輸入，有自己的表單，D33 規格 §3.8）。只寫 packaging_daily_capacity／op_log。

const DEFAULT_SPAN_DAYS = 60
const MAX_SPAN_DAYS = 180
const MAX_PUT_ROWS = 60
/** 算「沿用最近一次填的平日值」要往前看的天數 */
const LOOKBACK_DAYS = 400

type Fail = Extract<CapacityResponse, { success: false }>
const fail = (status: number, body: Omit<Fail, 'success'>) => noStore<Fail>({ success: false, ...body }, status)

function daySpan(from: YMD, to: YMD): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

async function buildRange(sb: ReturnType<typeof getSupabaseAdminClient>, from: YMD, to: YMD, lock?: LockState): Promise<CapacityResponse> {
  const all: DailyCapacity[] = await loadCapacityRows(sb, addDays(from, -LOOKBACK_DAYS), to)
  const rows = all.filter((r) => r.date >= from && r.date <= to)
  const effective = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isWorkday(d) || weekdayOf(d) === 6) effective.push(resolveCapacity(d, all))
  }
  return lock ? { success: true, rows, effective, lock } : { success: true, rows, effective }
}

export async function GET(request: NextRequest) {
  const g = await guardPackaging('read')
  if (!g.ok) return g.res
  const sp = request.nextUrl.searchParams
  const today = todayTaipei()
  const fromRaw = sp.get('from')
  const toRaw = sp.get('to')
  const from = isValidYmd(fromRaw) ? fromRaw : today
  const to = isValidYmd(toRaw) ? toRaw : addDays(from, DEFAULT_SPAN_DAYS)
  if (to < from) return fail(400, { code: 'bad_request', error: 'to 不可早於 from' })
  if (daySpan(from, to) > MAX_SPAN_DAYS) return fail(400, { code: 'bad_request', error: `一次最多查 ${MAX_SPAN_DAYS} 天` })
  try {
    const sb = getSupabaseAdminClient()
    return noStore(await buildRange(sb, from, to))
  } catch (e) {
    console.error('[packaging/capacity GET]', describeError(e))
    return fail(500, { code: 'db_error', error: publicDbError(e) })
  }
}

export async function PUT(request: NextRequest) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body || !Array.isArray(body.rows)) return fail(400, { code: 'bad_request', error: '請求格式錯誤（rows 必須是陣列）' })
  const rows = body.rows as CapacityInput[]
  if (rows.length < 1 || rows.length > MAX_PUT_ROWS) return fail(400, { code: 'bad_request', error: `一次 1～${MAX_PUT_ROWS} 筆` })
  const dates = rows.map((r) => (r && typeof r === 'object' ? r.date : null))
  if (dates.some((d) => !isValidYmd(d))) return fail(400, { code: 'bad_request', error: '日期格式錯誤（須為 YYYY-MM-DD）' })
  if (new Set(dates).size !== dates.length) return fail(400, { code: 'bad_request', error: '同一天不可重複' })

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  const actor = { email: g.member.email, name: g.member.realName }
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: typeof body.lockToken === 'string' ? body.lockToken : null }, nowMs)
    if (!lk.ok) {
      return fail(409, { code: lk.code, error: lk.code === 'lock_lost' ? '編輯權已被其他人接手' : '沒有編輯權或已逾時釋放，請重新取得編輯權' })
    }

    // 週六才需要查卡數（關閉週六加班前要先移卡，D48）
    const satDates = (dates as YMD[]).filter((d) => weekdayOf(d) === 6)
    const counts = await countOpenByDates(sb, satDates)
    const upserts: Omit<DailyCapacityRow, 'updated_at'>[] = []
    const clears: YMD[] = []
    for (const r of rows) {
      const v = validateCapacityInput(r, { today, openCardCountOn: (d) => counts.get(d) ?? 0 })
      if (!v.ok) {
        const status = v.code === 'saturday_has_cards' ? 409 : 422
        return fail(status, { code: v.code, error: v.message, date: r.date, ...(v.cardCount != null ? { cardCount: v.cardCount } : {}) })
      }
      if ('clear' in r) { clears.push(r.date); continue }
      upserts.push({
        date: r.date,
        headcount: r.headcount ?? null,
        regular_hours: r.regularHours,
        overtime_hours_max: r.overtimeHoursMax,
        is_saturday_open: r.isSaturdayOpen,
        note: r.note?.trim() || null,
        updated_by: actor.email,
        updated_by_name: actor.name,
      })
    }

    await upsertCapacity(sb, upserts, nowIso)
    await deleteCapacity(sb, clears)
    // op_log 只記正規化後的欄位（不寫原始 body：客戶端夾帶的多餘鍵或大字串會永久留在正式站）
    const logged = [
      ...upserts.map((u) => ({
        date: u.date, headcount: u.headcount, regularHours: u.regular_hours, overtimeHoursMax: u.overtime_hours_max,
        isSaturdayOpen: u.is_saturday_open, note: u.note,
      })),
      ...clears.map((d) => ({ date: d, clear: true as const })),
    ]
    await insertOpLog(sb, { actorEmail: actor.email, actorName: actor.name, kind: 'capacity', label: '產能表', ops: logged })

    const sorted = [...(dates as YMD[])].sort()
    return noStore(await buildRange(sb, sorted[0], sorted[sorted.length - 1], lk.lock))
  } catch (e) {
    console.error('[packaging/capacity PUT]', describeError(e))
    return fail(500, { code: 'db_error', error: publicDbError(e) })
  }
}
