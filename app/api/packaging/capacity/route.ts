import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type {
  CapacityInput,
  CapacityResponse,
  DailyCapacity,
  LockState,
  YMD,
} from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { addDays, isValidYmd, isWeekend } from '@/lib/packaging/scheduleCalendar'
import { resolveDayCapacity } from '@/lib/packaging/scheduleCapacity'
import { planCapacityPut } from '@/lib/packaging/capacityPlan'
import { executeCapacityPlan } from '@/lib/packaging/capacityWrite'
import {
  countOpenByDates,
  insertOpLog,
  isMissingSchema,
  linesMigrationMessage,
  loadCapacityRows,
  loadLineCapacityRows,
  loadLines,
  publicDbError,
  verifyAndTouchLock,
  type SupabaseAdmin,
} from '@/lib/packaging/scheduleDb'
import { isWorkday, todayTaipei } from '@/lib/packaging/workdays'

export const dynamic = 'force-dynamic'

// 包裝專區 P1：產能表（D48／D49；D63 週日比照週六；D64 批次填寫仍走同一個 PUT；D65 總時數、不填人數）。規格 §四.4
// 分線輪（lines.md §3.2、§4.3；D67／D71）：產能改為「一天 × 一條線」填寫，總時數＝啟用線加總（伺服器算，唯讀）。
//
// GET ?from=&to=   （讀；預設 today ～ today+60，最長 180 天）→ CapacityResponse
//   { rows（daily 列）, effective（每個工作日＋所有週末；含 lines[]、unsetLineCount）, lines（全部線，含停用）, lineRows（區間內各線列） }
// PUT CapacityPutRequest { lockToken, rows: CapacityInput[1..60] }（packaging_admin＋編輯鎖）
//   每天必須帶 lines（各線時數，權威值）；沒帶 → bad_request「產能表已改為分線填寫，請重新整理頁面」。
//   input.regularHours／overtimeHoursMax 忽略：伺服器以「寫入後」的各線有效值（含沿用）加總，同步寫回 packaging_daily_capacity
//   的相容欄（Snow 的穩定站仍是舊程式、只看 daily 表）；週末開加班旗標仍在 daily 列（一天一個，不分線）。
//   { date, clear: true } 刪該日 daily 列與全部線列（回到沿用／預設）。
//   錯誤：date_not_workday（422）、line_invalid（422）、weekend_has_cards（409，附 date、cardCount）、
//         migration_required（409：分線輪新表不存在＝sql/20260927b_packaging_p1_extend.sql 尚未套用）。
// 多列無交易（lines.md §3.2）：寫入順序偏向安全——關閉週末「先旗標、後線列」、其餘「先線列、後 daily」，
//   任何中途失敗都偏向「週末沒開」，不會出現沒有產能卻開著的週末。
// 產能修改不進 Undo（產能是事實輸入，有自己的表單）。只寫 packaging_daily_capacity／packaging_line_capacity／op_log。

const DEFAULT_SPAN_DAYS = 60
const MAX_SPAN_DAYS = 180
const MAX_PUT_ROWS = 60
/** 算「沿用最近一次填的平日值」要往前看的天數 */
const LOOKBACK_DAYS = 400

type Fail = Extract<CapacityResponse, { success: false }>
const fail = (status: number, body: Omit<Fail, 'success'>) => noStore<Fail>({ success: false, ...body }, status)
const byDate = <T extends { date: YMD }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)

function daySpan(from: YMD, to: YMD): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

async function buildRange(sb: SupabaseAdmin, from: YMD, to: YMD, lock?: LockState): Promise<CapacityResponse> {
  const [daily, lineRowsAll, lines] = await Promise.all([
    loadCapacityRows(sb, addDays(from, -LOOKBACK_DAYS), to),
    loadLineCapacityRows(sb, addDays(from, -LOOKBACK_DAYS), to),
    loadLines(sb),
  ])
  const all: DailyCapacity[] = [...daily].sort(byDate)
  const effective = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isWorkday(d) || isWeekend(d)) effective.push(resolveDayCapacity(d, { daily: all, lineRows: lineRowsAll, lines }))
  }
  const body: CapacityResponse = {
    success: true,
    rows: all.filter((r) => r.date >= from && r.date <= to),
    effective,
    lines,
    lineRows: lineRowsAll.filter((r) => r.date >= from && r.date <= to),
  }
  return lock ? { ...body, lock } : body
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
    if (isMissingSchema(e)) return fail(409, { code: 'migration_required', error: linesMigrationMessage(e) })
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
  const sorted = [...(dates as YMD[])].sort()
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: typeof body.lockToken === 'string' ? body.lockToken : null }, nowMs)
    if (!lk.ok) {
      return fail(409, { code: lk.code, error: lk.code === 'lock_lost' ? '編輯權已被其他人接手' : '沒有編輯權或已逾時釋放，請重新取得編輯權' })
    }

    // 週末才需要查卡數（關閉週六／週日加班前要先移卡，D48／D63）
    const weekendDates = sorted.filter((d) => isWeekend(d))
    const lookFrom = addDays(sorted[0], -LOOKBACK_DAYS)
    const lookTo = sorted[sorted.length - 1]
    const [lines, dailyAll, lineAll, counts] = await Promise.all([
      loadLines(sb),
      loadCapacityRows(sb, lookFrom, lookTo),
      loadLineCapacityRows(sb, lookFrom, lookTo),
      countOpenByDates(sb, weekendDates),
    ])
    // D101：第 1～3 步（逐日驗證 → 記憶體算寫入後的列與總時數 → 寫入順序）抽到 lib/packaging/capacityPlan.ts，
    //   AI 採用／退回採用寫產能也走同一個函式（不長出第二套產能規則）；抽出前後輸出逐欄相同（回歸比對測試）。
    const planned = planCapacityPut(rows, {
      today, nowIso, actor, lines, dailyAll, lineAll, openCardCountOn: (d) => counts.get(d) ?? 0,
    })
    if (!planned.ok) {
      return fail(planned.status, { code: planned.code, error: planned.message, date: planned.date, ...(planned.cardCount != null ? { cardCount: planned.cardCount } : {}) })
    }
    const { plan } = planned
    await executeCapacityPlan(sb, plan, nowIso)
    const logged = plan.logged

    await insertOpLog(sb, { actorEmail: actor.email, actorName: actor.name, kind: 'capacity', label: '產能表', ops: logged })

    return noStore(await buildRange(sb, sorted[0], sorted[sorted.length - 1], lk.lock))
  } catch (e) {
    console.error('[packaging/capacity PUT]', describeError(e))
    if (isMissingSchema(e)) return fail(409, { code: 'migration_required', error: `${linesMigrationMessage(e)}；這次沒有儲存任何一天` })
    return fail(500, { code: 'db_error', error: publicDbError(e) })
  }
}
