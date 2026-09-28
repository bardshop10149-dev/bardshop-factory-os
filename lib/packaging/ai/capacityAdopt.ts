// 包裝專區 P3 AI 模擬排程 — D101 採用時把模擬產線時數寫進正式產能表、退回時還原（純函式；設計 §六、§七）
//
// 這裡只算「要寫哪些格」（CapacityInput[]），真正的驗證、寫入順序、daily 相容總時數一律交給
// lib/packaging/capacityPlan.planCapacityPut ＋ capacityWrite.executeCapacityPlan——與產能表手動儲存同一套規則。
//
// 採用（planCapacityAdoption）：只寫「有差異的格」＋保值列，不是把整個範圍寫死：
//   - 整個範圍都寫成已設定列 → 沿用值被寫死（之後組長改前一天，範圍內不再跟著沿用），退回面也變大；
//   - 只寫模擬格本身又不夠：寫一筆「列」會改變它之後所有沒填日子的沿用值，包括模擬範圍外的日子（違反 D87 範圍外不動）。
//   → 逐線逐日貪婪法：依日期由早到晚，「正式照目前的列算出來 ≠ 模擬」才寫一筆列；範圍後第一個台灣工作日再補一筆
//     「保值列（anchor）」＝它原本的沿用值，範圍外就不會跟著變。
//   正確性：resolveLineCapacity 只往回看（當天或更早的平日列），寫在 d 只影響 d 與之後；處理完範圍內每一天＋anchor 後，
//     範圍內每天＝模擬值、anchor＝原值；anchor 之後沒有自己列的日子，最近的較早列要嘛是原本就有的列（不變），
//     要嘛落在 ≤ anchor 且值＝anchor 原值＝它原本沿用的值 → 範圍外全部不變。週末列不參與沿用，各自獨立、不需要 anchor。
// 退回（planCapacityRevert）：每格三態——目前＝採用後的值 → 還原；目前＝採用前 → 已還原（略過，重試冪等）；
//   其他＝組長在採用後改過 → 保留組長的新值（Snow 確認：時數多半是現場事實，倒回會抹掉事實）。
//   保值列只在該線較早的平日格都還原（或本來就是採用前）時才還原，否則保留（刪了會讓範圍外改沿用那個沒還原的值）。
//
// 硬規則：不 import supabase、不讀時鐘、相對路徑 import、不用 enum。

import type { CapacityInput, DailyCapacity, LineCapacity, LineCapacityInput, PackagingLine, YMD } from '../scheduleTypes'
import { addDays, isHolidayWeekend, isWeekend, shortDate, weekendName } from '../scheduleCalendar'
import { groupLineRows, resolveLineCapacity, weekendOpenOn } from '../scheduleCapacity'
import { isWorkday } from '../workdays'
import { baseDiffers, overlayCapacity, sameEffective } from './simCapacity'
import type {
  CapacityAdoptCell,
  CapacityAdoptPreview,
  CapacityCellChange,
  CapacityChangeRecord,
  CapacityHoursView,
  CapacityRevertCell,
  CapacityRevertPreview,
  CapacityWeekendChange,
  SimCapacity,
  SimStamp,
} from './types'

/** 採用寫進正式產能表的線列備註（原本那格沒有列、沒有備註時） */
export const ADOPT_CAPACITY_NOTE = '採用 AI 模擬'
export const ADOPT_ANCHOR_NOTE = '採用 AI 模擬（保值）'
/** 退回時補的「恢復列」備註（已過的日子不能改，從今天起補回採用前的值；見 planCapacityRevert） */
export const REVERT_FIX_NOTE = '退回 AI 採用（恢復原值）'

/** d 當天或之後的第一個台灣工作日（恢復列要落在能填產能的平日；國定假日不能填，D48） */
function firstWorkdayOnOrAfter(d: YMD): YMD {
  let x = d
  for (let i = 0; i < 60 && !isWorkday(x); i++) x = addDays(x, 1)
  return x
}

const byDate = <T extends { date: YMD }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
const round2 = (x: number): number => Math.round(x * 100) / 100
const SYSTEM_STAMP: SimStamp = { email: 'system', name: null, at: '' }

function exactRow<T extends { date: YMD }>(d: YMD | null, rows: readonly T[]): T | null {
  if (!d) return null
  for (const r of rows) if (r.date === d) return r
  return null
}

/** 範圍最後一天之後的第一個台灣工作日（anchor；60 天內一定有） */
export function anchorDateAfter(last: YMD): YMD {
  let d = addDays(last, 1)
  for (let i = 0; i < 60 && !isWorkday(d); i++) d = addDays(d, 1)
  return d
}

/** 一組擺放在各日期的未完成卡數（關閉週末加班前檢查用） */
export function openCountByDate(placements: Iterable<{ planDate: YMD | null; completed: unknown }>): (d: YMD) => number {
  const m = new Map<YMD, number>()
  for (const p of placements) if (!p.completed && p.planDate) m.set(p.planDate, (m.get(p.planDate) ?? 0) + 1)
  return (d) => m.get(d) ?? 0
}

const hoursView = (e: { regularMinutes: number | null; overtimeMinutes: number; inheritedFrom: YMD | null }): CapacityHoursView => ({
  regularHours: e.regularMinutes == null ? null : round2(e.regularMinutes / 60),
  overtimeHoursMax: round2(e.overtimeMinutes / 60),
  inheritedFrom: e.inheritedFrom,
})

/** upsert 到「依日期升冪」的一條線的列（resolveLineCapacity 用二分搜尋，要保持排序） */
function upsertSorted(rows: LineCapacity[], r: LineCapacity): void {
  const i = rows.findIndex((x) => x.date >= r.date)
  if (i < 0) rows.push(r)
  else if (rows[i].date === r.date) rows[i] = r
  else rows.splice(i, 0, r)
}

export interface CapacityAdoptionPlan {
  /** 交給 capacityPlan.planCapacityPut（與 PUT 同一套驗證、寫入順序、daily 相容欄）；空＝不用寫產能 */
  inputs: CapacityInput[]
  /** 存 packaging_ai_adoptions.capacity_changes；沒有任何要寫的格＝null */
  record: CapacityChangeRecord | null
  preview: CapacityAdoptPreview
  /** 採用前就知道會失敗的原因（例：模擬開的週末只在鎖定線上有加班）；非 null＝不能採用（preview.error 同一句） */
  blocker: { date: YMD; message: string } | null
}

/**
 * 採用時要寫進正式產能表的格（D101 §6.2）。
 * 範圍＝windowDates（≥ 今天）× 採用的線（模擬線扣掉鎖定線，adoptScopeOf）× 仍啟用的線；鎖定線、停用線上的模擬格不匯入（預覽列出）。
 * 以模擬版為準（D86）：正式在模擬後被改過的格照樣以模擬值寫入，不擋，預覽標出（liveChangedSinceEdit）。
 * 組 CapacityInput 時 daily 的備註與週末旗標一定帶正式現值（PUT 會用輸入覆寫 daily 的備註與旗標，給空值會把已開的週末關掉、備註清掉）。
 */
export function planCapacityAdoption(input: {
  today: YMD
  windowDates: readonly YMD[]
  adoptLineIds: readonly number[]
  lockedLineIds: readonly number[]
  lines: readonly PackagingLine[]
  liveDaily: readonly DailyCapacity[]
  liveLineRows: readonly LineCapacity[]
  /** 已 normalize（窗內、模擬線內）的模擬覆寫 */
  simCapacity: SimCapacity
}): CapacityAdoptionPlan {
  const { today, lines, simCapacity: sim } = input
  const daily = [...input.liveDaily].sort(byDate)
  const activeIds = new Set(lines.filter((l) => l.active).map((l) => l.id))
  const lockedSet = new Set(input.lockedLineIds)
  const adoptSet = new Set(input.adoptLineIds)
  const countBy = (pred: (lineId: number) => boolean) => {
    const m = new Map<number, number>()
    for (const c of sim.cells) if (pred(c.lineId)) m.set(c.lineId, (m.get(c.lineId) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([lineId, cellCount]) => ({ lineId, cellCount }))
  }
  const preview: CapacityAdoptPreview = {
    cells: [],
    weekendsOpened: [],
    lockedLinesIgnored: countBy((id) => lockedSet.has(id)),
    inactiveLinesSkipped: countBy((id) => adoptSet.has(id) && !activeIds.has(id)),
    anchorImpossible: [],
    error: null,
  }
  const window = [...new Set(input.windowDates)].filter((d) => d >= today).sort()
  if (window.length === 0 || (sim.cells.length === 0 && sim.weekendsOpened.length === 0)) {
    return { inputs: [], record: null, preview, blocker: null }
  }
  const windowSet = new Set(window)
  const liveFlag = (d: YMD) => weekendOpenOn(d, daily)
  const opened = new Set(sim.weekendsOpened.filter((d) => windowSet.has(d)))
  /** 採用後的週末旗標：正式已開或模擬開的（國定假日的週末不算） */
  const afterOpen = (d: YMD) => isWeekend(d) && !isHolidayWeekend(d) && (liveFlag(d) || opened.has(d))
  const liveGrouped = groupLineRows(input.liveLineRows)
  const simOv = overlayCapacity({ capacityRows: daily, lineRows: input.liveLineRows }, sim, SYSTEM_STAMP)
  const simGrouped = groupLineRows(simOv.lineRows)
  const cellOf = new Map(sim.cells.map((c) => [`${c.date}|${c.lineId}`, c]))
  const anchor = anchorDateAfter(window[window.length - 1])
  const adoptLines = input.adoptLineIds.filter((id) => activeIds.has(id)).sort((a, b) => a - b)

  const writes: CapacityCellChange[] = []
  for (const L of adoptLines) {
    const liveRows = liveGrouped.get(L) ?? []
    const simRows = simGrouped.get(L) ?? []
    const rows: LineCapacity[] = [...liveRows] // 依序寫入後的「正式列」（逐步 upsert）
    for (const d of [...window, anchor]) {
      const isAnchor = !windowSet.has(d)
      const have = resolveLineCapacity(d, L, rows, afterOpen(d))
      const want = isAnchor
        ? resolveLineCapacity(d, L, liveRows, liveFlag(d)) // anchor：保持採用前的值
        : resolveLineCapacity(d, L, simRows, afterOpen(d))
      if (sameEffective(have, want)) continue
      if (want.regularMinutes == null) {
        // 只可能發生在 anchor：原本「未設定」，列無法表達未設定 → 只提示（範圍外會沿用新值）
        if (isAnchor) preview.anchorImpossible.push({ date: d, lineId: L })
        continue
      }
      // 取來源「列」的小時原值（避免分鐘 → 小時的小數誤差）
      const srcRows = isAnchor ? liveRows : simRows
      const src = exactRow(want.source === 'inherited' ? want.inheritedFrom : d, srcRows)
      const after = src
        ? { regularHours: isWeekend(d) ? 0 : src.regularHours, overtimeHoursMax: src.overtimeHoursMax }
        : { regularHours: 0, overtimeHoursMax: 0 } // 週末沒有列＝0（理論上不會走到：have 有列時 want 也一定有列）
      const beforeRow = exactRow(d, liveRows)
      upsertSorted(rows, {
        date: d, lineId: L, regularHours: after.regularHours, overtimeHoursMax: after.overtimeHoursMax,
        note: null, updatedBy: '', updatedByName: null, updatedAt: '',
      })
      writes.push({
        date: d,
        lineId: L,
        kind: isAnchor ? 'anchor' : 'sim',
        before: beforeRow ? { regularHours: beforeRow.regularHours, overtimeHoursMax: beforeRow.overtimeHoursMax, note: beforeRow.note } : null,
        after,
      })
      const cell = isAnchor ? undefined : cellOf.get(`${d}|${L}`)
      const liveEff = resolveLineCapacity(d, L, liveRows, liveFlag(d))
      const changed = !!cell && baseDiffers(cell.base, liveEff)
      const pc: CapacityAdoptCell = {
        date: d, lineId: L, kind: isAnchor ? 'anchor' : 'sim',
        before: hoursView(liveEff), after,
        liveChangedSinceEdit: changed,
        baseAtEdit: changed && cell ? { ...cell.base } : null,
      }
      preview.cells.push(pc)
    }
  }
  const weekends: CapacityWeekendChange[] = [...opened].sort()
    .filter((d) => !liveFlag(d) && afterOpen(d))
    .map((d) => ({ date: d, beforeOpen: false, afterOpen: true }))
  preview.weekendsOpened = weekends.map((w) => w.date)
  // 模擬開的週末：採用後（只匯入採用線）各線加班加總要 > 0，否則正式產能表開不了這天（D63）。
  //   會發生在「加班只填在鎖定線或停用線上」——那些格不匯入。先講清楚原因（否則只會看到產能表的通用驗證訊息）。
  let blocker: CapacityAdoptionPlan['blocker'] = null
  for (const w of weekends) {
    let ot = 0
    for (const L of activeIds) {
      // 採用線：正式列＋這次要寫的格（有寫才取代那天的正式列）；其他線：正式列（旗標一開，那些線那天的正式列也算數）
      const w8 = adoptLines.includes(L) ? writes.find((x) => x.lineId === L && x.date === w.date) : undefined
      const rows = w8
        ? [...(liveGrouped.get(L) ?? []).filter((r) => r.date !== w.date),
          { date: w.date, lineId: L, regularHours: w8.after.regularHours, overtimeHoursMax: w8.after.overtimeHoursMax, note: null, updatedBy: '', updatedByName: null, updatedAt: '' }]
          .sort(byDate)
        : liveGrouped.get(L) ?? []
      ot += resolveLineCapacity(w.date, L, rows, true).overtimeMinutes
    }
    if (!(ot > 0)) {
      blocker = { date: w.date, message: `${shortDate(w.date)}（${weekendName(w.date)}）的模擬加班只填在鎖定或停用的線上，採用時那些線不匯入，這天在正式產能表開不了加班；請解除那條線的鎖定，或把加班改填在其他線` }
      preview.error = blocker.message
      break
    }
  }
  preview.cells.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.lineId - b.lineId))
  writes.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.lineId - b.lineId))
  if (writes.length === 0 && weekends.length === 0) return { inputs: [], record: null, preview, blocker }

  const dates = [...new Set([...writes.map((w) => w.date), ...weekends.map((w) => w.date)])].sort()
  const inputs: CapacityInput[] = dates.map((d) => ({
    date: d,
    headcount: null,
    regularHours: 0, // 伺服器忽略、自己以各線加總重算（同產能表）
    overtimeHoursMax: 0,
    isSaturdayOpen: isWeekend(d) ? afterOpen(d) : false,
    note: exactRow(d, daily)?.note ?? null,
    lines: writes.filter((w) => w.date === d).map((w): LineCapacityInput => ({
      lineId: w.lineId,
      regularHours: w.after.regularHours,
      overtimeHoursMax: w.after.overtimeHoursMax,
      note: w.before?.note ?? (w.kind === 'anchor' ? ADOPT_ANCHOR_NOTE : ADOPT_CAPACITY_NOTE),
    })),
  }))
  return { inputs, record: { v: 1, cells: writes, weekends }, preview, blocker }
}

/**
 * 採用寫產能成功、但之後寫排程失敗 → 把產能改回採用前（D101 §6.4 第 10～11 步的補償）。
 * 回傳的 inputs 要以「採用前」的正式列當 ctx 交給 planCapacityPut（openCardCountOn 給 0：排程還沒寫，關回模擬開的週末不必移卡）。
 */
export function capacityRollbackInputs(record: CapacityChangeRecord, liveDailyBefore: readonly DailyCapacity[]): CapacityInput[] {
  const daily = [...liveDailyBefore].sort(byDate)
  const dates = [...new Set([...record.cells.map((c) => c.date), ...record.weekends.map((w) => w.date)])].sort()
  return dates.map((d) => ({
    date: d,
    headcount: null,
    regularHours: 0,
    overtimeHoursMax: 0,
    isSaturdayOpen: isWeekend(d) ? weekendOpenOn(d, daily) : false,
    note: exactRow(d, daily)?.note ?? null,
    lines: record.cells.filter((c) => c.date === d).map((c): LineCapacityInput => (c.before
      ? { lineId: c.lineId, regularHours: c.before.regularHours, overtimeHoursMax: c.before.overtimeHoursMax, note: c.before.note }
      : { lineId: c.lineId, clear: true })),
  }))
}

export interface CapacityRevertPlan {
  inputs: CapacityInput[]
  preview: CapacityRevertPreview
}

type Hours = { regularHours: number; overtimeHoursMax: number }

const sameHours = (a: Hours | null, b: Hours | null): boolean =>
  a == null || b == null ? a === b : Math.abs(a.regularHours - b.regularHours) < 1e-9 && Math.abs(a.overtimeHoursMax - b.overtimeHoursMax) < 1e-9

const hoursOfBefore = (c: CapacityCellChange): Hours | null =>
  c.before ? { regularHours: c.before.regularHours, overtimeHoursMax: c.before.overtimeHoursMax } : null

/** 一條線（依日期升冪）的列，把指定的格換回採用前（before 為 null＝刪列）；回新陣列，不改輸入 */
function withBefore(rows: readonly LineCapacity[], cells: readonly CapacityCellChange[]): LineCapacity[] {
  const m = new Map(rows.map((r) => [r.date, r]))
  for (const c of cells) {
    if (c.before) {
      m.set(c.date, {
        date: c.date, lineId: c.lineId, regularHours: c.before.regularHours, overtimeHoursMax: c.before.overtimeHoursMax,
        note: c.before.note, updatedBy: '', updatedByName: null, updatedAt: '',
      })
    } else m.delete(c.date)
  }
  return [...m.values()].sort(byDate)
}

/**
 * 退回採用時的產能（D101 §7.1）。每條線依日期由早到晚：
 *   - 保值列（anchor）：同線較早的平日格有任何一格沒還原（組長改過／線停用／已過又無法補回）→ 保留
 *   - 日期 < 今天 → 不還原（過去的產能是歷史；且 PUT 只收 today−30 起）
 *   - 目前＝採用後 → 還原（before 為 null＝刪列、回到沿用）；目前＝採用前 → 已還原；其他 → 組長在採用後改過 → 保留組長的新值
 *   - 要寫回 before 的線已停用 → 保留（停用線不能填產能）
 * 已過的日子（D101 驗證修正）：已過的格不改，但「列」會沿用到後面沒填的平日（D49）——採用第一天改 6h、隔天才退回，
 *   不處理的話今天以後整段仍是 6h，等於沒退。所以：已過、而且組長沒動過（目前＝採用後）的平日格，若它讓「今天起第一個
 *   台灣工作日 R」的值和「採用前」不同，就在 R 補一筆恢復列＝採用前在 R 的值（用目前的列、把紀錄格換回 before 算，
 *   組長在別的日子的修改照樣算數）。R 本來就是紀錄格（before 為 null）時，改成把那格寫成恢復值（刪列會讓它沿用已過的格）。
 *   補得回來 → 這些已過的格不再讓保值列跟著保留；補不回來（採用前沒有設定時數、線已停用、R 那天整天保留）→ 照舊保留保值列，
 *   預覽列在 pastUnfixable。要不要補只看「R 的值」是否和採用前不同：已過的格影響不到 R（中間有別的列擋住，例如範圍後本來就有的
 *   列或保值列）就不補——所以不必另外限定 R 要落在範圍內（隨機性質測試抓到：範圍後本來就有列、沒有保值列時，週末才退回也要補）。
 * keepDays（D101 驗證修正）：capacityFlow 逐日驗證後「還原後會通不過產能表規則」的日子（例：週末開著但各線加班合計 0）→
 *   那天的格全部保留（算「沒還原」：平日格會讓保值列跟著保留）、週末保持開著，其他日子照退；原本是一天不過整份產能都不退。
 * 週末（採用時才開的）：目前旗標已關 → 已關閉；那天有格被組長改過 → 保留開著；排程退回後那天仍有未完成卡 → 保留開著；
 *   否則關閉。保留開著的週末，它的各格也不動（不能留下「開著但加總 0」）。
 * openCardCountAfter＝排程退回「之後」各日未完成卡數（用 planAndApply 的 run.res.next 在記憶體算 → GET 預覽與 POST 一致）。
 */
export function planCapacityRevert(input: {
  today: YMD
  record: CapacityChangeRecord
  lines: readonly PackagingLine[]
  liveDaily: readonly DailyCapacity[]
  liveLineRows: readonly LineCapacity[]
  openCardCountAfter: (d: YMD) => number
  /** 整天保留的日子 → 原因（產能表驗證訊息）；省略＝沒有 */
  keepDays?: ReadonlyMap<YMD, string>
}): CapacityRevertPlan {
  const { today, record } = input
  const keepDays: ReadonlyMap<YMD, string> = input.keepDays ?? new Map()
  const daily = [...input.liveDaily].sort(byDate)
  const active = new Set(input.lines.filter((l) => l.active).map((l) => l.id))
  const liveGrouped = groupLineRows(input.liveLineRows)
  const nowOf = (d: YMD, L: number): Hours | null => {
    const r = exactRow(d, liveGrouped.get(L) ?? [])
    return r ? { regularHours: r.regularHours, overtimeHoursMax: r.overtimeHoursMax } : null
  }
  const item = (c: CapacityCellChange): CapacityRevertCell => ({
    date: c.date, lineId: c.lineId, kind: c.kind,
    before: hoursOfBefore(c),
    after: { ...c.after },
  })
  const preview: CapacityRevertPreview = {
    restore: [], alreadyRestored: [], keptChangedAfter: [], keptPast: [], keptAnchors: [], keptWithWeekend: [], keptInvalid: [],
    pastFixes: [], pastUnfixable: [],
    invalidDays: [...keepDays.entries()].map(([date, message]) => ({ date, message })).sort(byDate),
    weekendsClose: [], weekendsKeptOpen: [], error: null,
  }
  /** 要寫的紀錄格：target＝寫進去的值（null＝刪列）；fix＝它其實是恢復列（R 那格，寫恢復值而不是 before） */
  let restoreCells: { cell: CapacityCellChange; target: Hours | null; note: string | null; fix: boolean }[] = []
  /** 不在紀錄裡的恢復列（R 那天這條線沒有紀錄格） */
  const fixRows: { date: YMD; lineId: number; hours: Hours }[] = []
  const R = firstWorkdayOnOrAfter(today)

  const byLine = new Map<number, CapacityCellChange[]>()
  for (const c of record.cells) {
    let arr = byLine.get(c.lineId)
    if (!arr) { arr = []; byLine.set(c.lineId, arr) }
    arr.push(c)
  }
  for (const L of [...byLine.keys()].sort((a, b) => a - b)) {
    const cells = [...byLine.get(L)!].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'anchor' ? 1 : -1) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const liveRowsL = liveGrouped.get(L) ?? []

    // ── 已過的日子：要不要在 R 補恢復列（見函式說明）
    const pastUntouched = cells.filter((c) => c.date < today && !isWeekend(c.date) && sameHours(nowOf(c.date, L), c.after))
    const rCell = cells.find((c) => c.date === R) ?? null
    let fix: Hours | null = null
    let fixBlocked = false
    // 不限 R 落在範圍內：R 之前若有別的列（範圍後本來就有的列、保值列）擋住，have 與 want 一定相同 → 自然不補
    if (pastUntouched.length > 0) {
      const rowsR = rCell ? withBefore(liveRowsL, [rCell]) : [...liveRowsL] // R 那格照常還原後
      const ideal = withBefore(rowsR, pastUntouched) //                        ＋已過的格也換回採用前（假想）
      const have = resolveLineCapacity(R, L, rowsR, false)
      const want = resolveLineCapacity(R, L, ideal, false)
      if (!sameEffective(have, want)) {
        const src = want.regularMinutes == null ? null : exactRow(want.source === 'inherited' ? want.inheritedFrom : R, ideal)
        if (!src || !active.has(L) || keepDays.has(R)) fixBlocked = true
        else fix = { regularHours: src.regularHours, overtimeHoursMax: src.overtimeHoursMax }
      }
    }
    const pastDates = pastUntouched.map((c) => c.date)
    if (fixBlocked) preview.pastUnfixable.push({ date: R, lineId: L, pastDates })
    if (fix && !rCell) {
      fixRows.push({ date: R, lineId: L, hours: fix })
      preview.pastFixes.push({ date: R, lineId: L, hours: fix, pastDates })
    }

    let broken = false
    for (const c of cells) {
      // 週末格不參與沿用 → 不影響保值列
      const breaks = !isWeekend(c.date)
      if (keepDays.has(c.date)) { preview.keptInvalid.push(item(c)); if (breaks) broken = true; continue }
      if (c.kind === 'anchor' && broken) { preview.keptAnchors.push(item(c)); continue }
      if (c.date < today) {
        preview.keptPast.push(item(c))
        // 組長沒動過、而且影響已由恢復列處理（或根本影響不到今天以後）→ 不必讓保值列跟著保留
        const handled = pastUntouched.includes(c) && !fixBlocked
        if (breaks && !handled) broken = true
        continue
      }
      const now = nowOf(c.date, L)
      const isFixCell = fix != null && c === rCell
      const target: Hours | null = isFixCell ? fix : hoursOfBefore(c)
      // R 那格目前已是 before（null＝被清掉，會沿用已過的格）也要寫恢復值
      if (sameHours(now, c.after) || (isFixCell && sameHours(now, hoursOfBefore(c)))) {
        if (target && !active.has(L)) {
          // 要寫回的線已停用：停用線不能填產能 → 保留
          preview.keptChangedAfter.push({ ...item(c), now })
          if (breaks) broken = true
          continue
        }
        restoreCells.push({ cell: c, target, note: isFixCell ? REVERT_FIX_NOTE : (c.before?.note ?? null), fix: isFixCell })
        if (isFixCell && fix) preview.pastFixes.push({ date: c.date, lineId: L, hours: fix, pastDates })
      } else if (sameHours(now, target)) {
        preview.alreadyRestored.push(item(c))
      } else {
        preview.keptChangedAfter.push({ ...item(c), now })
        if (breaks) broken = true
      }
    }
  }

  // 週末（採用時才開的）
  const changedAfterDates = new Set(preview.keptChangedAfter.map((c) => c.date))
  const keepCellsOn = new Set<YMD>()
  for (const w of [...record.weekends].sort(byDate)) {
    if (w.beforeOpen || !w.afterOpen) continue
    if (keepDays.has(w.date)) {
      // 那天還原後通不過產能表規則 → 整天保留（格已在 keptInvalid）
      preview.weekendsKeptOpen.push({ date: w.date, reason: 'invalid' })
    } else if (!weekendOpenOn(w.date, daily)) {
      // 旗標已關（組長關了，或上一次退回寫到一半）：不必再關；那天的格照三態還原（重試時才會收乾淨）
      preview.weekendsKeptOpen.push({ date: w.date, reason: 'already_closed' })
    } else if (w.date < today) {
      preview.weekendsKeptOpen.push({ date: w.date, reason: 'past' })
      keepCellsOn.add(w.date)
    } else if (changedAfterDates.has(w.date)) {
      preview.weekendsKeptOpen.push({ date: w.date, reason: 'changed_after' })
      keepCellsOn.add(w.date)
    } else if (input.openCardCountAfter(w.date) > 0) {
      preview.weekendsKeptOpen.push({ date: w.date, reason: 'has_cards' })
      keepCellsOn.add(w.date)
    } else {
      preview.weekendsClose.push(w.date)
    }
  }
  restoreCells = restoreCells.filter((x) => {
    if (!keepCellsOn.has(x.cell.date)) return true
    preview.keptWithWeekend.push(item(x.cell))
    return false
  })
  // 恢復列另列在 pastFixes（預覽要講清楚「為什麼多寫一筆」），不重複列在 restore
  preview.restore = restoreCells.filter((x) => !x.fix).map((x) => item(x.cell))
  const sortCells = (xs: { date: YMD; lineId: number }[]) => xs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.lineId - b.lineId))
  for (const k of ['restore', 'alreadyRestored', 'keptChangedAfter', 'keptPast', 'keptAnchors', 'keptWithWeekend', 'keptInvalid', 'pastFixes', 'pastUnfixable'] as const) sortCells(preview[k])

  const closeSet = new Set(preview.weekendsClose)
  // 重試（上一次退回寫到一半）：已還原的格所在的日子也送一筆（lines 空）——PUT 會以寫入後的各線值重算 daily 相容總時數
  //   （穩定站舊程式只看 daily 表；上一次可能在寫 daily 之前就失敗）。旗標與備註帶正式現值，不會改到別的東西。
  const refresh = preview.alreadyRestored.filter((c) => c.date >= today && !keepDays.has(c.date)).map((c) => c.date)
  const dates = [...new Set([...restoreCells.map((x) => x.cell.date), ...fixRows.map((f) => f.date), ...preview.weekendsClose, ...refresh])].sort()
  const inputs: CapacityInput[] = dates.map((d) => ({
    date: d,
    headcount: null,
    regularHours: 0,
    overtimeHoursMax: 0,
    isSaturdayOpen: isWeekend(d) ? (closeSet.has(d) ? false : weekendOpenOn(d, daily)) : false,
    note: exactRow(d, daily)?.note ?? null,
    lines: [
      ...restoreCells.filter((x) => x.cell.date === d).map((x): LineCapacityInput => (x.target
        ? { lineId: x.cell.lineId, regularHours: x.target.regularHours, overtimeHoursMax: x.target.overtimeHoursMax, note: x.note }
        : { lineId: x.cell.lineId, clear: true })),
      ...fixRows.filter((f) => f.date === d).map((f): LineCapacityInput => ({
        lineId: f.lineId, regularHours: f.hours.regularHours, overtimeHoursMax: f.hours.overtimeHoursMax, note: REVERT_FIX_NOTE,
      })),
    ].sort((a, b) => a.lineId - b.lineId),
  }))
  return { inputs, preview }
}

/** 解析 packaging_ai_adoptions.capacity_changes（形狀壞的格略過；整份不是物件＝null） */
export function parseCapacityChangeRecord(raw: unknown): CapacityChangeRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const ymd = (v: unknown): YMD | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  const cells: CapacityCellChange[] = []
  for (const x of Array.isArray(o.cells) ? o.cells : []) {
    if (!x || typeof x !== 'object') continue
    const c = x as Record<string, unknown>
    const date = ymd(c.date)
    const lineId = num(c.lineId)
    const a = c.after && typeof c.after === 'object' ? c.after as Record<string, unknown> : null
    const ar = a ? num(a.regularHours) : null
    const ao = a ? num(a.overtimeHoursMax) : null
    if (!date || lineId == null || ar == null || ao == null) continue
    let before: CapacityCellChange['before'] = null
    if (c.before && typeof c.before === 'object') {
      const b = c.before as Record<string, unknown>
      const br = num(b.regularHours), bo = num(b.overtimeHoursMax)
      if (br == null || bo == null) continue
      before = { regularHours: br, overtimeHoursMax: bo, note: typeof b.note === 'string' ? b.note : null }
    }
    cells.push({ date, lineId, kind: c.kind === 'anchor' ? 'anchor' : 'sim', before, after: { regularHours: ar, overtimeHoursMax: ao } })
  }
  const weekends: CapacityWeekendChange[] = []
  for (const x of Array.isArray(o.weekends) ? o.weekends : []) {
    if (!x || typeof x !== 'object') continue
    const w = x as Record<string, unknown>
    const date = ymd(w.date)
    if (!date) continue
    weekends.push({ date, beforeOpen: w.beforeOpen === true, afterOpen: w.afterOpen === true })
  }
  return { v: 1, cells, weekends }
}
