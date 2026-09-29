// 包裝專區 P1 — 產能表單的純函式（CapacityEditor 用；D49／D63／D64／D65；分線輪 D67／D71）
//
// 為什麼獨立成檔：表單的「字串 ↔ 數值」換算、逐格檢查、D64「套用到全部平日」的預覽與套用規則細，
// 抽成純函式才能用 node --experimental-strip-types 直接跑單元測試（畫面元件只管顯示與送出）。
// 不 import supabase、不讀時鐘；只用相對路徑 import、不用 enum。
//
// 分線輪（lines.md §5.3）：一個日期一列，列內「每條啟用線一格（正常／加班）」＋唯讀合計（D71：總時數＝各線加總）。
// - 每一格各自記 explicit／dirty／clear：送出時只帶「改過的線」——沒動的線不送，伺服器保留原本的列（或繼續沿用），
//   D49「各線各自沿用最近一次填的平日值」才不會因為改了 A 線就把 B 線的沿用值寫死。
// - 週末開加班旗標、備註是「一天一個」（不分線，D63），放在列上。
// - 合計只看這一列畫面上的值（含沿用值）；後面沿用這一天的日期要儲存後重新載入才會跟著變。
//
// D65：組長直接填總時數（沒有人數欄，送出時 headcount 一律 null）。
// D63：週六、週日只有「開加班」＋各線加班；國定假日的週末不能開。
// D64：批次填寫只套用到平日（非週末、台灣工作日），可選「全部線」或某一條線；週末逐日決定。

import type {
  CapacityInput,
  CapacitySource,
  DailyCapacity,
  EffectiveCapacity,
  LineCapacity,
  LineCapacityInput,
  YMD,
} from './scheduleTypes'
import { isHolidayWeekend, isWeekend } from './scheduleCalendar'
import { isWorkday } from './workdays'

/** 一天 × 一條線的輸入格 */
export interface CapacityLineCell {
  /** 正常時數（小時，字串＝輸入框內容；週末恆 '0'、不顯示） */
  regular: string
  /** 加班時數（小時；空白＝0） */
  ot: string
  source: CapacitySource
  inheritedFrom: YMD | null
  /** 這條線這天有填過（有才可「清除」回到沿用） */
  explicit: boolean
  /** 改過、待儲存 */
  dirty: boolean
  /** 待儲存的「清除這條線這天」（回到該線沿用最近較早平日值） */
  clear: boolean
}

export interface CapacityFormRow {
  date: YMD
  kind: 'weekday' | 'weekend'
  /** 週末開加班（DB 欄 is_saturday_open；一天一個、不分線） */
  weekendOpen: boolean
  note: string
  /** 整天的來源（伺服器 resolveDayCapacity 算的；列標籤用） */
  source: CapacitySource
  inheritedFrom: YMD | null
  /** 國定假日的週末（例：10/10 國慶日逢週六）：不能開加班 */
  holidayWeekend: boolean
  /** 當天有沒有任何填過的資料（daily 列或任一線列；有才可整天「清除」） */
  explicit: boolean
  /** 這一天有任何待儲存的修改（格子、備註、週末旗標、整天清除） */
  dirty: boolean
  /** 待儲存的「整天清除」（刪 daily 列與全部線列） */
  clear: boolean
  /** 啟用中各線的格子（key＝lineId） */
  lines: Record<number, CapacityLineCell>
}

const round2 = (x: number): number => Math.round(x * 100) / 100

/** 分鐘 → '38.5'（小時，最多 2 位小數、去掉多餘的 0；表單初值用） */
function minutesToHoursText(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return ''
  return String(round2(min / 60))
}

/**
 * 伺服器資料 → 表單列。
 * @param e        這天的有效產能（含 e.lines：各啟用線的有效值）
 * @param daily    這天的 daily 列（週末旗標、備註）
 * @param lineRows 這天實際填過的各線列（explicit；多給其他日期的列也無妨，會依日期篩）
 * @param lineIds  產能表的欄＝啟用中的線（依 sortOrder）
 */
export function toFormRow(
  e: EffectiveCapacity,
  daily: DailyCapacity | undefined,
  lineRows: readonly LineCapacity[],
  lineIds: readonly number[],
): CapacityFormRow {
  const weekend = e.kind === 'weekend'
  const todays = lineRows.filter((x) => x.date === e.date)
  const lines: Record<number, CapacityLineCell> = {}
  for (const id of lineIds) {
    const lr = todays.find((x) => x.lineId === id)
    const eff = e.lines?.find((x) => x.lineId === id)
    if (lr) {
      lines[id] = {
        regular: weekend ? '0' : String(lr.regularHours),
        ot: String(lr.overtimeHoursMax),
        source: 'explicit', inheritedFrom: null, explicit: true, dirty: false, clear: false,
      }
    } else if (weekend) {
      // 週末不沿用（D49）：沒填＝0，輸入框留白
      lines[id] = { regular: '0', ot: '', source: eff?.source ?? 'weekend_default', inheritedFrom: null, explicit: false, dirty: false, clear: false }
    } else if (!eff || eff.regularMinutes == null) {
      lines[id] = { regular: '', ot: '', source: 'unset', inheritedFrom: null, explicit: false, dirty: false, clear: false }
    } else {
      lines[id] = {
        regular: minutesToHoursText(eff.regularMinutes),
        ot: minutesToHoursText(eff.overtimeMinutes),
        source: eff.source,
        inheritedFrom: eff.inheritedFrom,
        explicit: false, dirty: false, clear: false,
      }
    }
  }
  return {
    date: e.date,
    kind: e.kind,
    weekendOpen: weekend ? (daily?.isSaturdayOpen ?? false) : false,
    note: daily?.note ?? '',
    source: e.source,
    inheritedFrom: e.inheritedFrom,
    holidayWeekend: weekend && isHolidayWeekend(e.date),
    explicit: !!daily || todays.length > 0,
    dirty: false,
    clear: false,
    lines,
  }
}

const HOURS_RE = /^\d{1,4}(\.\d{1,2})?$/

/** 小時字串是否合法（0～5000、最多 2 位小數） */
export function isHoursText(x: string): boolean {
  const t = x.trim()
  return HOURS_RE.test(t) && Number(t) <= 5000
}

/** 空白＝0 的小時字串 → 數值；不合法 → NaN */
function hoursOr0(x: string): number {
  const t = x.trim()
  if (t === '') return 0
  return isHoursText(t) ? Number(t) : Number.NaN
}

// ─────────────────────────────────────────────────────────────────────
// 編輯（回傳新列，不改原物件）
// ─────────────────────────────────────────────────────────────────────

/** 改一格（正常／加班／清除）：該格與整列標為待儲存；整天清除作廢（改成逐線） */
export function patchCell(
  row: CapacityFormRow,
  lineId: number,
  p: Partial<Pick<CapacityLineCell, 'regular' | 'ot' | 'clear'>>,
): CapacityFormRow {
  const cur = row.lines[lineId]
  if (!cur) return row
  return {
    ...row,
    dirty: true,
    clear: false,
    lines: { ...row.lines, [lineId]: { ...cur, ...p, dirty: true, clear: p.clear ?? false } },
  }
}

/** 改列層級欄位（週末開加班、備註、整天清除） */
export function patchRow(row: CapacityFormRow, p: Partial<Pick<CapacityFormRow, 'weekendOpen' | 'note' | 'clear'>>): CapacityFormRow {
  return { ...row, ...p, dirty: true, clear: p.clear ?? false }
}

// ─────────────────────────────────────────────────────────────────────
// 合計（D71：唯讀，即時加總）
// ─────────────────────────────────────────────────────────────────────

export interface RowTotals {
  /** 正常合計（小時）；平日全部線都未設定 → null；週末恆 0 */
  regular: number | null
  /** 加班合計（小時）；週末沒開加班 → 0 */
  ot: number
  /** 有格子不是合法數字（合計只算合法的格子） */
  invalid: boolean
  /** 有待儲存的「清除」（清除後的沿用值要儲存後才知道，合計暫不含它） */
  pending: boolean
}

export function rowTotals(row: CapacityFormRow, lineIds: readonly number[]): RowTotals {
  if (row.clear) return { regular: null, ot: 0, invalid: false, pending: true }
  const weekend = row.kind === 'weekend'
  let reg = 0
  let anyReg = false
  let ot = 0
  let invalid = false
  let pending = false
  for (const id of lineIds) {
    const c = row.lines[id]
    if (!c) continue
    if (c.clear) { pending = true; continue }
    if (weekend) {
      if (!row.weekendOpen) continue
      const o = hoursOr0(c.ot)
      if (Number.isNaN(o)) invalid = true
      else ot += o
      continue
    }
    if (c.regular.trim() === '') {
      // 這條線未設定：加班也不計（沒有正常時數的線不算進總時數）
      if (c.ot.trim() !== '') invalid = true
      continue
    }
    const r = hoursOr0(c.regular)
    const o = hoursOr0(c.ot)
    if (Number.isNaN(r) || Number.isNaN(o)) { invalid = true; continue }
    anyReg = true
    reg += r
    ot += o
  }
  return { regular: weekend ? 0 : anyReg ? round2(reg) : null, ot: round2(ot), invalid, pending }
}

// ─────────────────────────────────────────────────────────────────────
// 檢查與送出
// ─────────────────────────────────────────────────────────────────────

/** 這一列能不能存；lines＝啟用中的線（依畫面順序，錯誤訊息帶線名） */
export function formRowError(row: CapacityFormRow, lines: readonly { id: number; name: string }[]): string | null {
  if (row.clear) return null
  const weekend = row.kind === 'weekend'
  if (weekend && row.weekendOpen && row.holidayWeekend) return '國定假日不能開加班'
  for (const l of lines) {
    const c = row.lines[l.id]
    if (!c || !c.dirty || c.clear) continue
    if (weekend) {
      if (!row.weekendOpen) continue
      if (!isHoursText(c.ot || '0')) return `${l.name}加班時數須為 0~5000（最多 2 位小數）`
      continue
    }
    if (c.regular.trim() === '') return `${l.name}正常時數未填（這天不排班請填 0）`
    if (!isHoursText(c.regular)) return `${l.name}正常時數須為 0~5000（最多 2 位小數）`
    if (!isHoursText(c.ot || '0')) return `${l.name}加班時數須為 0~5000（最多 2 位小數）`
  }
  if (weekend && row.weekendOpen) {
    const t = rowTotals(row, lines.map((l) => l.id))
    if (!t.invalid && !(t.ot > 0)) return '開加班時各線加班時數合計要大於 0'
  }
  return null
}

/**
 * 表單列 → PUT 的 CapacityInput（lines.md §4.3）。
 * - 只帶 dirty 的線（清除的線送 { lineId, clear: true }）；沒動的線不送，伺服器保留原列／繼續沿用。
 * - 週末沒開加班：不送任何線（輸入框是停用的，改過也不存）。
 * - regularHours／overtimeHoursMax＝畫面合計（型別必填；伺服器忽略並自己重算）。
 */
export function formRowToInput(row: CapacityFormRow, lineIds: readonly number[]): CapacityInput {
  if (row.clear) return { date: row.date, clear: true }
  const weekend = row.kind === 'weekend'
  const lines: LineCapacityInput[] = []
  if (!weekend || row.weekendOpen) {
    for (const id of lineIds) {
      const c = row.lines[id]
      if (!c || !c.dirty) continue
      if (c.clear) {
        lines.push({ lineId: id, clear: true })
        continue
      }
      lines.push({
        lineId: id,
        regularHours: weekend ? 0 : Number(c.regular.trim()),
        overtimeHoursMax: Number((c.ot || '0').trim()),
      })
    }
  }
  const t = rowTotals(row, lineIds)
  return {
    date: row.date,
    headcount: null, // D65：不再填人數
    regularHours: weekend ? 0 : (t.regular ?? 0),
    overtimeHoursMax: t.ot,
    isSaturdayOpen: weekend ? row.weekendOpen : false,
    note: row.note.trim() || null,
    lines,
  }
}

// ─────────────────────────────────────────────────────────────────────
// D64：批次填寫「套用到全部平日」（分線：可選全部線或某一條線）
// ─────────────────────────────────────────────────────────────────────

/** 批次填寫的兩欄；空字串＝這一欄不變 */
export interface BulkFillValues {
  regular: string
  ot: string
}

/** D64 套用對象：平日（非週末）且是台灣工作日——國定假日的平日、週六、週日都不套用 */
export function isBulkFillTarget(r: Pick<CapacityFormRow, 'date' | 'kind'>): boolean {
  return r.kind === 'weekday' && !isWeekend(r.date) && isWorkday(r.date)
}

export function bulkFillError(v: BulkFillValues): string | null {
  const reg = v.regular.trim()
  const ot = v.ot.trim()
  if (reg === '' && ot === '') return '請至少填一欄（正常時數或加班時數）'
  if (reg !== '' && !isHoursText(reg)) return '正常時數須為 0~5000（最多 2 位小數）'
  if (ot !== '' && !isHoursText(ot)) return '加班時數須為 0~5000（最多 2 位小數）'
  return null
}

/**
 * 連同表格內容一起檢查（lineIds＝要套用的線：全部啟用線或其中一條）：
 * - 只填加班、但目標線有平日從沒設定過正常時數（空白）→ 套用後那天存不了，先擋下
 * - 表內沒有任何平日、沒有選線 → 擋下
 */
export function bulkFillRowsError(rows: readonly CapacityFormRow[], v: BulkFillValues, lineIds: readonly number[]): string | null {
  const e = bulkFillError(v)
  if (e) return e
  if (lineIds.length === 0) return '沒有可套用的線'
  const targets = rows.filter(isBulkFillTarget)
  if (targets.length === 0) return '表內沒有可套用的平日'
  if (v.regular.trim() === '' && targets.some((r) => lineIds.some((id) => (r.lines[id]?.regular ?? '').trim() === ''))) {
    return '有平日的線尚未設定正常時數，請一併填寫正常時數'
  }
  return null
}

/** 一格（日×線）在批次填寫後會怎麼變（預覽用） */
export interface BulkFillCellChange {
  lineId: number
  /** 正常時數的數值會改變（原本空白／未設定、待清除也算） */
  regular: boolean
  /** 加班時數的數值會改變 */
  ot: boolean
  /** 這格原本已設定（explicit），套用會覆蓋 */
  overwritesExplicit: boolean
}

/** 一個平日在批次填寫後會怎麼變 */
export interface BulkFillChange {
  date: YMD
  cells: BulkFillCellChange[]
}

const sameHours = (a: string, b: string): boolean => a.trim() !== '' && b.trim() !== '' && Number(a) === Number(b)

/**
 * 預覽：列出所有會被填入的平日（isBulkFillTarget）與各目標格是否改變。
 * 數值相同的格也列入（套用後變成「已設定」，不再沿用前一天），但 regular／ot 為 false，畫面不標「將覆蓋」。
 * 值不合法（bulkFillRowsError）時回空陣列。
 */
export function planBulkFill(rows: readonly CapacityFormRow[], v: BulkFillValues, lineIds: readonly number[]): BulkFillChange[] {
  if (bulkFillRowsError(rows, v, lineIds)) return []
  const reg = v.regular.trim()
  const ot = v.ot.trim()
  const out: BulkFillChange[] = []
  for (const r of rows) {
    if (!isBulkFillTarget(r)) continue
    const cells: BulkFillCellChange[] = []
    for (const id of lineIds) {
      const c = r.lines[id]
      if (!c) continue
      const clearing = r.clear || c.clear
      cells.push({
        lineId: id,
        regular: reg !== '' && (clearing || !sameHours(c.regular, reg)),
        ot: ot !== '' && (clearing || !sameHours(c.ot || '0', ot)),
        overwritesExplicit: c.explicit,
      })
    }
    out.push({ date: r.date, cells })
  }
  return out
}

/** 套用：把所有平日的目標線（有填的那欄）填成批次值、標為待儲存；週末與其他列原樣回傳 */
export function applyBulkFill(rows: readonly CapacityFormRow[], v: BulkFillValues, lineIds: readonly number[]): CapacityFormRow[] {
  if (bulkFillRowsError(rows, v, lineIds)) return [...rows]
  const reg = v.regular.trim()
  const ot = v.ot.trim()
  return rows.map((r) => {
    if (!isBulkFillTarget(r)) return r
    const lines = { ...r.lines }
    for (const id of lineIds) {
      const c = lines[id]
      if (!c) continue
      lines[id] = {
        ...c,
        regular: reg !== '' ? reg : c.regular,
        ot: ot !== '' ? ot : c.ot,
        dirty: true,
        clear: false,
      }
    }
    return { ...r, lines, dirty: true, clear: false }
  })
}

/** 預覽摘要：會改變的格數（正常、加班各算一格）、其中原本已設定而被覆蓋的「日×線」數 */
export function bulkFillSummary(plan: readonly BulkFillChange[]): { cells: number; overwrites: number; days: number } {
  let cells = 0
  let overwrites = 0
  for (const d of plan) {
    for (const c of d.cells) {
      cells += (c.regular ? 1 : 0) + (c.ot ? 1 : 0)
      if (c.overwritesExplicit && (c.regular || c.ot)) overwrites++
    }
  }
  return { cells, overwrites, days: plan.length }
}
