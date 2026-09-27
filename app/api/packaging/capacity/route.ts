import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type {
  CapacityInput,
  CapacityResponse,
  DailyCapacity,
  DailyCapacityRow,
  LineCapacity,
  LineCapacityRow,
  LockState,
  YMD,
} from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { addDays, isValidYmd, isWeekend } from '@/lib/packaging/scheduleCalendar'
import { resolveDayCapacity, validateCapacityDayInput } from '@/lib/packaging/scheduleCapacity'
import {
  countOpenByDates,
  deleteCapacity,
  deleteLineCapacity,
  deleteLineCapacityDates,
  insertOpLog,
  isMissingSchema,
  linesMigrationMessage,
  loadCapacityRows,
  loadLineCapacityRows,
  loadLines,
  publicDbError,
  upsertCapacity,
  upsertLineCapacity,
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
/** packaging_daily_capacity 的 regular_hours／overtime_hours_max check 上限（sql/20260927_packaging_schedule.sql） */
const DAILY_TOTAL_HOURS_MAX = 5000
/** 算「沿用最近一次填的平日值」要往前看的天數 */
const LOOKBACK_DAYS = 400

type Fail = Extract<CapacityResponse, { success: false }>
const fail = (status: number, body: Omit<Fail, 'success'>) => noStore<Fail>({ success: false, ...body }, status)
const byDate = <T extends { date: YMD }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
const toHours = (min: number | null): number => (min == null ? 0 : Math.round((min / 60) * 100) / 100)

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

type LineUpsert = Omit<LineCapacityRow, 'updated_at'>
type DailyUpsert = Omit<DailyCapacityRow, 'updated_at'>

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
    const lineRowsOn = (d: YMD) => lineAll.filter((r) => r.date === d)

    // 1. 逐日驗證（任何一天不過 → 整批不寫）
    for (const r of rows) {
      const v = validateCapacityDayInput(r, { today, lines, openCardCountOn: (d) => counts.get(d) ?? 0, existingLineRows: lineRowsOn })
      if (!v.ok) {
        const status = v.code === 'weekend_has_cards' ? 409 : 422
        return fail(status, { code: v.code, error: v.message, date: r.date, ...(v.cardCount != null ? { cardCount: v.cardCount } : {}) })
      }
    }

    // 2. 以「寫入後」的資料在記憶體算好每天的總時數（D71：啟用線有效值加總，含沿用值），再決定寫入順序
    const lineUpserts: LineUpsert[] = []
    const lineDeletes: { date: YMD; lineId: number }[] = []
    const clearDates: YMD[] = []
    const after = new Map<string, LineCapacity>()
    for (const r of lineAll) after.set(`${r.date}|${r.lineId}`, r)
    const dailyAfter = new Map<YMD, DailyCapacity>(dailyAll.map((d) => [d.date, d]))
    for (const r of rows) {
      if ('clear' in r) {
        clearDates.push(r.date)
        for (const k of [...after.keys()]) if (k.startsWith(`${r.date}|`)) after.delete(k)
        dailyAfter.delete(r.date)
        continue
      }
      for (const x of r.lines ?? []) {
        if ('clear' in x) {
          lineDeletes.push({ date: r.date, lineId: x.lineId })
          after.delete(`${r.date}|${x.lineId}`)
          continue
        }
        const note = typeof x.note === 'string' ? x.note.trim() || null : null
        lineUpserts.push({
          date: r.date, line_id: x.lineId, regular_hours: x.regularHours, overtime_hours_max: x.overtimeHoursMax,
          note, updated_by: actor.email, updated_by_name: actor.name,
        })
        after.set(`${r.date}|${x.lineId}`, {
          date: r.date, lineId: x.lineId, regularHours: x.regularHours, overtimeHoursMax: x.overtimeHoursMax,
          note, updatedBy: actor.email, updatedByName: actor.name, updatedAt: nowIso,
        })
      }
      // 週末旗標與備註先放進 daily（總時數下面再填）
      dailyAfter.set(r.date, {
        date: r.date, headcount: null, regularHours: 0, overtimeHoursMax: 0, isSaturdayOpen: isWeekend(r.date) && r.isSaturdayOpen,
        note: r.note?.trim() || null, updatedBy: actor.email, updatedByName: actor.name, updatedAt: nowIso,
      })
    }
    const lineRowsAfter = [...after.values()]
    const dailySorted = [...dailyAfter.values()].sort(byDate)
    const dailyUpserts: DailyUpsert[] = []
    for (const r of rows) {
      if ('clear' in r) continue
      const eff = resolveDayCapacity(r.date, { daily: dailySorted, lineRows: lineRowsAfter, lines })
      // 各線各自 ≤ 5000 已在第 1 步驗過，但加總（含沿用值）寫回 daily 相容欄時也受 daily 表的 ≤ 5000 check 約束；
      // 在任何寫入之前擋下，避免「各線已寫、daily 失敗」的半套狀態（本 API 沒有交易）
      if (toHours(eff.regularMinutes) > DAILY_TOTAL_HOURS_MAX || toHours(eff.overtimeMinutes) > DAILY_TOTAL_HOURS_MAX) {
        return fail(422, { code: 'bad_request', error: `${r.date} 各線合計不可超過 ${DAILY_TOTAL_HOURS_MAX} 小時（正常、加班分開計）`, date: r.date })
      }
      const d = dailyAfter.get(r.date)!
      dailyUpserts.push({
        date: r.date,
        headcount: null, // D65：不再使用（欄位保留）
        regular_hours: isWeekend(r.date) ? 0 : toHours(eff.regularMinutes),
        overtime_hours_max: toHours(eff.overtimeMinutes),
        is_saturday_open: d.isSaturdayOpen,
        note: d.note,
        updated_by: actor.email,
        updated_by_name: actor.name,
      })
    }

    // 3. 寫入順序（無交易，偏向「週末沒開」）：
    //   a. 關閉週末的 daily（旗標 false）與整天清除的 daily 先寫／先刪
    //   b. 各線列（upsert、delete）
    //   c. 其餘 daily（含開週末：線列已在，最後才打開旗標）
    const closesFirst = dailyUpserts.filter((u) => isWeekend(u.date) && !u.is_saturday_open)
    const rest = dailyUpserts.filter((u) => !(isWeekend(u.date) && !u.is_saturday_open))
    await upsertCapacity(sb, closesFirst, nowIso)
    await deleteCapacity(sb, clearDates)
    await upsertLineCapacity(sb, lineUpserts, nowIso)
    await deleteLineCapacity(sb, lineDeletes)
    await deleteLineCapacityDates(sb, clearDates)
    await upsertCapacity(sb, rest, nowIso)

    // op_log 只記正規化後的欄位（不寫原始 body：客戶端夾帶的多餘鍵或大字串會永久留在正式站）
    const logged = [
      ...dailyUpserts.map((u) => ({
        date: u.date, regularHours: u.regular_hours, overtimeHoursMax: u.overtime_hours_max, isSaturdayOpen: u.is_saturday_open, note: u.note,
        lines: [
          ...lineUpserts.filter((l) => l.date === u.date).map((l) => ({ lineId: l.line_id, regularHours: l.regular_hours, overtimeHoursMax: l.overtime_hours_max })),
          ...lineDeletes.filter((l) => l.date === u.date).map((l) => ({ lineId: l.lineId, clear: true as const })),
        ],
      })),
      ...clearDates.map((d) => ({ date: d, clear: true as const })),
    ]
    await insertOpLog(sb, { actorEmail: actor.email, actorName: actor.name, kind: 'capacity', label: '產能表', ops: logged })

    return noStore(await buildRange(sb, sorted[0], sorted[sorted.length - 1], lk.lock))
  } catch (e) {
    console.error('[packaging/capacity PUT]', describeError(e))
    if (isMissingSchema(e)) return fail(409, { code: 'migration_required', error: `${linesMigrationMessage(e)}；這次沒有儲存任何一天` })
    return fail(500, { code: 'db_error', error: publicDbError(e) })
  }
}
