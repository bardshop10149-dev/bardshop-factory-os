// 包裝專區 P3 AI 模擬排程 — D101 模擬區產線時數（純函式；設計：scratchpad d101-d102/d101-design.md §二～§五）
//
// 核心概念：模擬產能＝正式產能表「已設定列」的草稿（SimCapacity.cells），「疊在」正式各線列上再跑同一個 resolveLineCapacity。
//   - 為什麼是「疊列」而不是「逐格取代結果」：採用時寫進正式表的也是「列」，列一定會沿用到後面（D49）；用列疊加，
//     模擬區看到的＝採用後正式產能表在範圍內會長的樣子，產能表 UI（沿用灰字、D64 批次填寫）也能原封不動重用。
//   - 單一注入點 withSimCapacity(world, session)：把覆寫疊進 SimWorld.capacityRows／lineRows。組合工作台（負荷條）、
//     buildSimOpsContext（模擬開的週末＝可排日）、validateAiResult（產能削減）、buildAiPayload（各線各日分鐘）原本就只從
//     world 讀產能 → 全部自動變成模擬值，validate／payload／adopt 都不用改。
//   - 模擬開的週末（weekendsOpened）：只能開「模擬範圍內」（夾在第一天與最後一天之間、非國定假日）的週末；開了就插進
//     window_dates（工作日集合、起訖日不變，horizon 語意不變）。正式已開的週末在模擬區只能改時數、不能關（Snow 確認）。
//
// 硬規則：不 import supabase、不讀時鐘（today／nowIso 由參數傳入）、相對路徑 import、不用 enum。
// 注意：resolveDayCapacity 對 daily 用二分搜尋 → 疊後的 daily 一定依 date 升冪；groupLineRows 以陣列參照做快取 →
//   疊加每次產生新陣列，快取自然分開，不會拿到正式的結果。

import type {
  CapacityInput,
  DailyCapacity,
  EffectiveLineCapacity,
  LineCapacity,
  PackagingLine,
  YMD,
} from '../scheduleTypes'
import { addDays, isHolidayWeekend, isValidYmd, isWeekend, openWeekendDaysOf, shortDate } from '../scheduleCalendar'
import { groupLineRows, resolveDayCapacity, resolveLineCapacity, validateCapacityDayInput, weekendOpenOn } from '../scheduleCapacity'
import { activeLinesOf, lineNameOf } from '../scheduleLines'
import { composeSimState } from './simState'
import {
  EMPTY_SIM_CAPACITY,
  SIM_CAPACITY_MAX_ROWS,
  type AiApiErrorCode,
  type SimCapacity,
  type SimCapacityCell,
  type SimCapacityView,
  type SimSession,
  type SimStamp,
  type SimWorld,
} from './types'

const EPS = 1e-6
const round2 = (x: number): number => Math.round(x * 100) / 100
/** 小時 → 分鐘（同 scheduleCapacity.toMinutes） */
const toMinutes = (hours: number): number => Math.round(hours * 60 * 100) / 100
const byDate = <T extends { date: YMD }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
const byDateLine = <T extends { date: YMD; lineId: number }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.lineId - b.lineId)
const cellKey = (date: YMD, lineId: number): string => `${date}|${lineId}`
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const hasAtMost2Decimals = (x: number): boolean => Math.abs(Math.round(x * 100) - x * 100) < 1e-6
const validHours = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 5000 && hasAtMost2Decimals(x)

/** 新的空覆寫（EMPTY_SIM_CAPACITY 是凍結的，要改就拿這個） */
export function emptySimCapacity(): SimCapacity {
  return { v: 1, cells: [], weekendsOpened: [] }
}

export function isEmptySimCapacity(c: SimCapacity | null | undefined): boolean {
  return !c || (c.cells.length === 0 && c.weekendsOpened.length === 0)
}

/** 深拷貝（undo 快照、run 快照用：之後改 session 不會改到快照） */
export function cloneSimCapacity(c: SimCapacity): SimCapacity {
  return { v: 1, cells: c.cells.map((x) => ({ ...x, base: { ...x.base } })), weekendsOpened: [...c.weekendsOpened] }
}

/**
 * jsonb → SimCapacity（DB 內容理論上都由本系統寫入，但壞一筆不能讓整個模擬區打不開）：
 * 形狀壞的格略過；同一格重複時後者為準；週末格的正常時數一律 0；週末清單只留真的週六／週日。
 */
export function parseSimCapacity(raw: unknown): SimCapacity {
  if (!isObj(raw)) return emptySimCapacity()
  const cells = new Map<string, SimCapacityCell>()
  for (const x of Array.isArray(raw.cells) ? raw.cells : []) {
    if (!isObj(x)) continue
    const date = typeof x.date === 'string' ? x.date.slice(0, 10) : null
    const lineId = typeof x.lineId === 'number' && Number.isInteger(x.lineId) && x.lineId >= 1 ? x.lineId : null
    if (!date || !isValidYmd(date) || lineId == null) continue
    if (!validHours(x.regularHours) || !validHours(x.overtimeHoursMax)) continue
    const b = isObj(x.base) ? x.base : null
    const baseReg = b && (b.regularHours === null || validHours(b.regularHours)) ? (b.regularHours as number | null) : null
    const baseOt = b && validHours(b.overtimeHoursMax) ? b.overtimeHoursMax : 0
    cells.set(cellKey(date, lineId), {
      date,
      lineId,
      regularHours: isWeekend(date) ? 0 : x.regularHours,
      overtimeHoursMax: x.overtimeHoursMax,
      base: { regularHours: baseReg, overtimeHoursMax: baseOt },
      at: typeof x.at === 'string' ? x.at : '',
    })
  }
  const weekends = new Set<YMD>()
  for (const d of Array.isArray(raw.weekendsOpened) ? raw.weekendsOpened : []) {
    if (typeof d === 'string' && isValidYmd(d) && isWeekend(d)) weekends.add(d)
  }
  return { v: 1, cells: [...cells.values()].sort(byDateLine), weekendsOpened: [...weekends].sort() }
}

/**
 * 只留「日期在 window_dates、線在模擬線」的格與「在 window_dates 內、非國定假日」的週末。
 * 為什麼讀取時要過濾：舊程式（穩定站）重設模擬區不會清這欄，靠這裡過濾，殘留的格就不會作用到新範圍。
 */
export function normalizeSimCapacity(c: SimCapacity | null | undefined, scope: { windowDates: readonly YMD[]; lineIds: readonly number[] }): SimCapacity {
  if (!c) return emptySimCapacity()
  const win = new Set(scope.windowDates)
  const lines = new Set(scope.lineIds)
  const cells = new Map<string, SimCapacityCell>()
  for (const x of c.cells) if (win.has(x.date) && lines.has(x.lineId)) cells.set(cellKey(x.date, x.lineId), x)
  const weekends = [...new Set(c.weekendsOpened)].filter((d) => win.has(d) && isWeekend(d) && !isHolidayWeekend(d)).sort()
  return { v: 1, cells: [...cells.values()].sort(byDateLine), weekendsOpened: weekends }
}

/** 兩份覆寫的「值」是否相同（只比日期、線、時數與模擬開的週末；base／at 是附註，不算變更） */
export function sameSimCapacity(a: SimCapacity | null | undefined, b: SimCapacity | null | undefined): boolean {
  const ca = [...(a?.cells ?? [])].sort(byDateLine)
  const cb = [...(b?.cells ?? [])].sort(byDateLine)
  if (ca.length !== cb.length) return false
  for (let i = 0; i < ca.length; i++) {
    const x = ca[i], y = cb[i]
    if (x.date !== y.date || x.lineId !== y.lineId || x.regularHours !== y.regularHours || x.overtimeHoursMax !== y.overtimeHoursMax) return false
  }
  const wa = [...new Set(a?.weekendsOpened ?? [])].sort()
  const wb = [...new Set(b?.weekendsOpened ?? [])].sort()
  return wa.length === wb.length && wa.every((d, i) => d === wb[i])
}

/**
 * 疊加：正式各線列中被覆寫的（date, line）換成模擬列（沒有就新增）；模擬開的週末把 daily 旗標設 true（沒有 daily 列就合成一列）。
 * 兩個陣列都依日期升冪（resolveDayCapacity 的 daily 二分搜尋需要）。回傳新陣列，不改輸入。
 */
export function overlayCapacity(
  rows: { capacityRows: readonly DailyCapacity[]; lineRows: readonly LineCapacity[] },
  c: SimCapacity,
  stamp: SimStamp,
): { capacityRows: DailyCapacity[]; lineRows: LineCapacity[] } {
  const lineMap = new Map<string, LineCapacity>()
  for (const r of rows.lineRows) lineMap.set(cellKey(r.date, r.lineId), r)
  for (const x of c.cells) {
    const prev = lineMap.get(cellKey(x.date, x.lineId))
    lineMap.set(cellKey(x.date, x.lineId), {
      date: x.date,
      lineId: x.lineId,
      regularHours: isWeekend(x.date) ? 0 : x.regularHours,
      overtimeHoursMax: x.overtimeHoursMax,
      note: prev?.note ?? null,
      updatedBy: stamp.email,
      updatedByName: stamp.name,
      updatedAt: stamp.at,
    })
  }
  const daily = new Map<YMD, DailyCapacity>()
  for (const d of rows.capacityRows) daily.set(d.date, d)
  for (const w of c.weekendsOpened) {
    const prev = daily.get(w)
    if (prev) {
      if (!prev.isSaturdayOpen) daily.set(w, { ...prev, isSaturdayOpen: true })
      continue
    }
    // 合成的 daily 列：只為了帶週末旗標（openWeekendDaysOf 給了 lineRows 時加班看各線加總；相容欄照填加總，防呆）
    let ot = 0
    for (const r of lineMap.values()) if (r.date === w) ot += r.overtimeHoursMax
    daily.set(w, {
      date: w, headcount: null, regularHours: 0, overtimeHoursMax: round2(ot), isSaturdayOpen: true, note: null,
      updatedBy: stamp.email, updatedByName: stamp.name, updatedAt: stamp.at,
    })
  }
  return { capacityRows: [...daily.values()].sort(byDate), lineRows: [...lineMap.values()].sort(byDateLine) }
}

type SimScopeSession = Pick<SimSession, 'windowDates' | 'lineIds' | 'ownerEmail' | 'ownerName' | 'updatedAt'> & { simCapacity?: SimCapacity }

const stampOf = (s: Pick<SimSession, 'ownerEmail' | 'ownerName' | 'updatedAt'>): SimStamp => ({ email: s.ownerEmail, name: s.ownerName, at: s.updatedAt })

/**
 * SimWorld（正式）→ 模擬產能下的 SimWorld：只換 capacityRows／lineRows，其餘同一個物件參照。
 * simCapacity 先 normalize（只留窗內、線內）；沒有任何覆寫 → 原封不動回傳同一個 world（D101 前的行為逐位元相同）。
 */
export function withSimCapacity(world: SimWorld, session: SimScopeSession): SimWorld {
  const c = normalizeSimCapacity(session.simCapacity ?? EMPTY_SIM_CAPACITY, session)
  if (isEmptySimCapacity(c)) return world
  const o = overlayCapacity({ capacityRows: world.capacityRows, lineRows: world.lineRows }, c, stampOf(session))
  return { ...world, capacityRows: o.capacityRows, lineRows: o.lineRows }
}

/** window_dates 第一天～最後一天之間所有的週六、週日（含國定假日的週末：產能表要列出但不能開） */
function weekendsBetween(windowDates: readonly YMD[]): YMD[] {
  if (windowDates.length === 0) return []
  const sorted = [...windowDates].sort()
  const out: YMD[] = []
  for (let d = sorted[0]; d <= sorted[sorted.length - 1]; d = addDays(d, 1)) if (isWeekend(d)) out.push(d)
  return out
}

/**
 * 兩組模擬日期的「工作日」是否相同（D101：模擬開的週末會改變 window_dates，但不改工作日集合）。
 * 載入 AI 歷史結果、runs/[id] 的 canLoad 用它判斷「是不是同一個範圍」。
 */
export function sameWorkdays(a: readonly YMD[], b: readonly YMD[]): boolean {
  const wa = [...a].filter((d) => !isWeekend(d)).sort()
  const wb = [...b].filter((d) => !isWeekend(d)).sort()
  return wa.length === wb.length && wa.every((d, i) => d === wb[i])
}

/** 模擬產能表列出的日期：window_dates ∪ 其間所有週末（依日期） */
export function simCapacityDates(session: Pick<SimSession, 'windowDates'>): YMD[] {
  return [...new Set([...session.windowDates, ...weekendsBetween(session.windowDates)])].sort()
}

/**
 * 可以在模擬區調整的日期：window_dates 中 ≥ 今天的日子 ∪ 夾在第一天與最後一天之間、非國定假日、≥ 今天的週末。
 * 範圍外的日子不開放（不影響模擬、採用也只看範圍，開放只會製造「改了卻沒用」的困惑）；範圍外的週末也不能開
 * （會改變起訖日與 horizon 語意，也讓採用範圍變大）。
 * liveOpen（正式已開加班的週末）：「正式已開、卻不在 window_dates」＝模擬區建立之後正式才開的週末 → 不開放（D101 驗證修正）。
 *   設計 §3.3：D101 不自動同步這種週末（改個時數，範圍卻被正式區悄悄改掉）。若開放編輯，存檔時它會被當成「模擬開的週末」
 *   插進 window → 那天的正式卡被組合狀態當成範圍內而藏起來（session.placements 又沒有它）＝從模擬區消失，
 *   採用時被 unplace 回待排池（違反 D87 範圍外不動）。要在模擬區用這天，請重設模擬區（重設會照正式已開的週末重算範圍）。
 */
export function editableCapacityDates(session: Pick<SimSession, 'windowDates'>, today: YMD, liveOpen?: ReadonlySet<YMD>): YMD[] {
  const win = new Set(session.windowDates)
  const out = new Set(session.windowDates.filter((d) => d >= today))
  for (const d of weekendsBetween(session.windowDates)) {
    if (d < today || isHolidayWeekend(d)) continue
    if (liveOpen?.has(d) && !win.has(d)) continue
    out.add(d)
  }
  return [...out].sort()
}

const sameMinutes = (a: number | null, b: number | null): boolean => (a == null || b == null ? a === b : Math.abs(a - b) < EPS)
/** 兩個有效值的正常／加班分鐘是否相同（null＝未設定，只和 null 相同） */
export function sameEffective(a: Pick<EffectiveLineCapacity, 'regularMinutes' | 'overtimeMinutes'>, b: Pick<EffectiveLineCapacity, 'regularMinutes' | 'overtimeMinutes'>): boolean {
  return sameMinutes(a.regularMinutes, b.regularMinutes) && sameMinutes(a.overtimeMinutes, b.overtimeMinutes)
}

/** 這格的 base（覆寫當時記下的正式值）與正式現值不同 → 「正式在你調整之後被改過」 */
export function baseDiffers(base: SimCapacityCell['base'], live: Pick<EffectiveLineCapacity, 'regularMinutes' | 'overtimeMinutes'>): boolean {
  const reg = base.regularHours == null ? null : toMinutes(base.regularHours)
  return !sameMinutes(reg, live.regularMinutes) || !sameMinutes(toMinutes(base.overtimeHoursMax), live.overtimeMinutes)
}

/** 有效值（分鐘）→ 小時（base 用；平日未設定＝null） */
export function effectiveToHours(e: Pick<EffectiveLineCapacity, 'regularMinutes' | 'overtimeMinutes'>): { regularHours: number | null; overtimeHoursMax: number } {
  return { regularHours: e.regularMinutes == null ? null : round2(e.regularMinutes / 60), overtimeHoursMax: round2(e.overtimeMinutes / 60) }
}

/**
 * SimView.capacity：模擬產能表（CapacityResponse 同形，CapacityEditor 直接吃）＋正式值（灰字）＋覆寫格＋差異（橫幅）。
 * liveWorld＝正式（未疊加）；session 的覆寫在這裡疊。
 */
export function simCapacityViewOf(liveWorld: SimWorld, session: SimScopeSession & Pick<SimSession, 'locks'>): SimCapacityView {
  const c = normalizeSimCapacity(session.simCapacity ?? EMPTY_SIM_CAPACITY, session)
  const dates = simCapacityDates(session)
  const lines = liveWorld.lines
  const scopeLines = new Set(session.lineIds)
  const viewLines = lines.map((l) => (l.active && !scopeLines.has(l.id) ? { ...l, active: false } : l))
  const liveDaily = [...liveWorld.capacityRows].sort(byDate)
  const simWorld = withSimCapacity(liveWorld, { ...session, simCapacity: c })
  const simDaily = [...simWorld.capacityRows].sort(byDate)
  const liveEff = dates.map((d) => resolveDayCapacity(d, { daily: liveDaily, lineRows: liveWorld.lineRows, lines }))
  const simEff = dates.map((d) => resolveDayCapacity(d, { daily: simDaily, lineRows: simWorld.lineRows, lines }))
  const from = dates[0] ?? ''
  const to = dates[dates.length - 1] ?? ''
  const inRange = (d: YMD) => dates.length > 0 && d >= from && d <= to
  const activeIds = new Set(activeLinesOf(lines).map((l) => l.id))
  const liveOpen = openWeekendDaysOf(liveDaily, liveWorld.lineRows, activeIds)
  const cellOf = new Map(c.cells.map((x) => [cellKey(x.date, x.lineId), x]))
  const locked = new Set(session.locks.lineIds)
  const diffs: SimCapacityView['diffs'] = []
  dates.forEach((d, i) => {
    for (const s of simEff[i].lines ?? []) {
      if (!scopeLines.has(s.lineId)) continue
      const l = (liveEff[i].lines ?? []).find((x) => x.lineId === s.lineId)
      if (!l || sameEffective(l, s)) continue
      const cell = cellOf.get(cellKey(d, s.lineId))
      diffs.push({
        date: d,
        lineId: s.lineId,
        live: { regularMinutes: l.regularMinutes, overtimeMinutes: l.overtimeMinutes },
        sim: { regularMinutes: s.regularMinutes, overtimeMinutes: s.overtimeMinutes },
        liveChangedSinceEdit: !!cell && baseDiffers(cell.base, l),
        lockedLine: locked.has(s.lineId),
      })
    }
  })
  return {
    sim: {
      rows: simDaily.filter((r) => inRange(r.date)),
      effective: simEff,
      lines: viewLines,
      lineRows: simWorld.lineRows.filter((r) => inRange(r.date)),
    },
    live: { effective: liveEff },
    cells: c.cells,
    weekendsOpened: c.weekendsOpened,
    editableDates: editableCapacityDates(session, liveWorld.today, liveOpen),
    liveOpenWeekends: dates.filter((d) => liveOpen.has(d)),
    diffs,
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST session/capacity 的核心（route 只負責讀寫與 CAS）
// ─────────────────────────────────────────────────────────────────────

export type ApplySimCapacityResult =
  | {
      ok: true
      simCapacity: SimCapacity
      windowDates: YMD[]
      /** 值或 window 有變（沒變的請求不寫入、不推 undo） */
      changed: boolean
      /** undo 標籤與 op_log label（例「模擬產線時數：9/30 A 線 6h 等 3 項」） */
      label: string
      /** op_log 用（正規化後的格，不放原始 body） */
      changes: { date: YMD; lineId: number; before: { regularHours: number; overtimeHoursMax: number } | null; after: { regularHours: number; overtimeHoursMax: number } | null }[]
      weekendsAdded: YMD[]
      weekendsRemoved: YMD[]
    }
  | { ok: false; code: AiApiErrorCode; message: string; date?: YMD; cardCount?: number }

const mdLabel = (d: YMD): string => shortDate(d)

/**
 * 模擬區改產線時數（D101 §3.1）。rows 與正式 PUT /api/packaging/capacity 同形；伺服器用同一個 validateCapacityDayInput 驗證
 * （時數範圍、2 位小數、週末只填加班、國定假日、開週末加總 > 0、關週末有卡擋下），訊息與正式產能表一致。再加模擬專屬規則：
 *   - 日期必須在 editableCapacityDates（模擬範圍內、≥ 今天；其間的週末）→ 否則 out_of_window
 *   - 線必須在這次模擬的線（session.lineIds）→ 否則 line_invalid
 *   - 正式已開的週末不能在模擬區關（sim_weekend_live_open）；模擬開的週末可以關，但那天的模擬卡要先移走（weekend_has_cards）
 * 合併：{date, clear} ＝拿掉那天所有模擬格（模擬開的週末＝關閉）；lines[i].clear＝拿掉那格（回到正式值）；其餘＝upsert
 *   （base 記正式當下的有效值）；與正式「列」完全相同的覆寫直接丟掉；備註忽略（備註屬正式產能表）。
 * 週末開／關 → window_dates 只增減那個週末日（工作日集合、起訖日不變）。
 * world＝正式（未疊加）；session＝目前模擬區（含 placements：算「那天還有幾張卡」用組合狀態）。
 */
export function applySimCapacityInputs(input: {
  world: SimWorld
  session: Pick<SimSession, 'windowDates' | 'lineIds' | 'placements' | 'ownerEmail' | 'ownerName' | 'updatedAt'> & { simCapacity?: SimCapacity }
  rows?: unknown
  clearAll?: boolean
  today: YMD
  nowIso: string
}): ApplySimCapacityResult {
  const { world, session, today, nowIso } = input
  const fail = (code: AiApiErrorCode, message: string, extra: { date?: YMD; cardCount?: number } = {}): ApplySimCapacityResult => ({ ok: false, code, message, ...extra })
  const scope = { windowDates: session.windowDates, lineIds: session.lineIds }
  const cur = normalizeSimCapacity(session.simCapacity ?? EMPTY_SIM_CAPACITY, scope)
  const activeIds = new Set(activeLinesOf(world.lines).map((l) => l.id))
  const liveDaily = [...world.capacityRows].sort(byDate)
  const liveOpen = openWeekendDaysOf(liveDaily, world.lineRows, activeIds)
  const editable = new Set(editableCapacityDates(session, today, liveOpen))
  const winAtStart = new Set(session.windowDates)
  const liveGrouped = groupLineRows(world.lineRows)
  const stamp: SimStamp = { email: session.ownerEmail, name: session.ownerName, at: nowIso }

  // 關閉週末前要先移卡：組合狀態（模擬列＋正式唯讀列）在那天未完成的卡數
  const composed = composeSimState(world.live, session)
  const openCount = new Map<YMD, number>()
  for (const p of composed.placements) if (!p.completed && p.planDate) openCount.set(p.planDate, (openCount.get(p.planDate) ?? 0) + 1)
  const openCardCountOn = (d: YMD): number => openCount.get(d) ?? 0

  const cells = new Map<string, SimCapacityCell>(cur.cells.map((x) => [cellKey(x.date, x.lineId), x]))
  const opened = new Set(cur.weekendsOpened)
  const dropDay = (d: YMD) => { for (const k of [...cells.keys()]) if (k.startsWith(`${d}|`)) cells.delete(k) }
  const liveRowOf = (d: YMD, lineId: number): LineCapacity | null => (liveGrouped.get(lineId) ?? []).find((r) => r.date === d) ?? null

  if (input.clearAll) {
    cells.clear()
    opened.clear()
  } else {
    const rows = input.rows
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > SIM_CAPACITY_MAX_ROWS) {
      return fail('bad_request', `一次 1～${SIM_CAPACITY_MAX_ROWS} 天`)
    }
    const dates = rows.map((r) => (isObj(r) ? r.date : null))
    if (dates.some((d) => !isValidYmd(d))) return fail('bad_request', '日期格式錯誤（須為 YYYY-MM-DD）')
    if (new Set(dates).size !== dates.length) return fail('bad_request', '同一天不可重複')
    // 目前（含本批前面各天已合併的）模擬列：驗證「週末合併後加班加總」用
    const simRowsOn = (d: YMD): LineCapacity[] => {
      const out = new Map<number, LineCapacity>()
      for (const r of world.lineRows) if (r.date === d) out.set(r.lineId, r)
      for (const x of cells.values()) {
        if (x.date !== d) continue
        out.set(x.lineId, { date: d, lineId: x.lineId, regularHours: x.regularHours, overtimeHoursMax: x.overtimeHoursMax, note: null, updatedBy: stamp.email, updatedByName: stamp.name, updatedAt: nowIso })
      }
      return [...out.values()]
    }
    for (const raw of rows as CapacityInput[]) {
      const d = raw.date
      if (!editable.has(d) && d >= today && isWeekend(d) && liveOpen.has(d) && !winAtStart.has(d)) {
        // D101 驗證修正：正式在模擬區建立後才開的週末不自動併進模擬範圍（見 editableCapacityDates）→ 講清楚怎麼辦
        return fail('out_of_window', `${mdLabel(d)} 的加班是正式產能表在建立模擬區之後才開的，不在這次模擬的日期裡；要在模擬區使用這天，請重設模擬區`, { date: d })
      }
      if (!editable.has(d)) return fail('out_of_window', `${mdLabel(d)} 不在模擬範圍內（只能調整模擬範圍內、今天以後的日子）`, { date: d })
      const wk = isWeekend(d)
      if ('clear' in raw) {
        if (raw.clear !== true) return fail('bad_request', 'clear 只能是 true', { date: d })
        // 回到正式值：拿掉那天全部模擬格；模擬開的週末＝關閉（有卡在下面統一擋）
        dropDay(d)
        opened.delete(d)
        continue
      }
      if (wk && raw.isSaturdayOpen === false && liveOpen.has(d)) {
        return fail('sim_weekend_live_open', `${mdLabel(d)} 正式產能表已開加班，不能在模擬區關閉（可把各線時數調低；要關請到正式工作台的產能表）`, { date: d })
      }
      const v = validateCapacityDayInput(raw, { today, lines: world.lines, openCardCountOn, existingLineRows: simRowsOn })
      if (!v.ok) {
        const code: AiApiErrorCode = v.code
        return fail(code, v.message, { date: d, ...(v.cardCount != null ? { cardCount: v.cardCount } : {}) })
      }
      for (const x of raw.lines ?? []) {
        if (!('clear' in x) && !session.lineIds.includes(x.lineId)) {
          return fail('line_invalid', `${lineNameOf(world.lines, x.lineId)}不在這次模擬的範圍（建立模擬區之後才啟用的線），請重設模擬區後再調整`, { date: d })
        }
      }
      if (wk && !raw.isSaturdayOpen) {
        // 關閉（或本來就沒開）：模擬開的週末拿掉、那天的模擬格全部拿掉（正式沒開 → 格子沒有作用）
        opened.delete(d)
        dropDay(d)
        continue
      }
      // 模擬才開的週末：正式的旗標沒開才記（旗標已開、只是各線加班 0 的怪狀態 → 靠格子就會開）
      if (wk && raw.isSaturdayOpen && !weekendOpenOn(d, liveDaily)) opened.add(d)
      for (const x of raw.lines ?? []) {
        const k = cellKey(d, x.lineId)
        if ('clear' in x) { cells.delete(k); continue }
        const reg = wk ? 0 : x.regularHours
        const liveRow = liveRowOf(d, x.lineId)
        // 與正式「列」完全相同的覆寫：沒有意義，不留（正式之後改了，模擬就跟著正式）
        if (liveRow && liveRow.regularHours === reg && liveRow.overtimeHoursMax === x.overtimeHoursMax) { cells.delete(k); continue }
        const prev = cells.get(k)
        // 值沒變就保留原格（base／at 不更新，免得沒改卻多一格退回上一步）
        if (prev && prev.regularHours === reg && prev.overtimeHoursMax === x.overtimeHoursMax) continue
        const live = resolveLineCapacity(d, x.lineId, liveGrouped.get(x.lineId) ?? [], weekendOpenOn(d, liveDaily))
        cells.set(k, { date: d, lineId: x.lineId, regularHours: reg, overtimeHoursMax: x.overtimeHoursMax, base: effectiveToHours(live), at: nowIso })
      }
    }
  }

  // 週末：模擬裡開著的放進 window、模擬關掉（且正式沒開）的拿出來；拿出來前那天不能有卡
  const provisional: SimCapacity = { v: 1, cells: [...cells.values()].sort(byDateLine), weekendsOpened: [...opened].sort() }
  const liveRows = { capacityRows: liveDaily, lineRows: world.lineRows }
  const beforeOv = overlayCapacity(liveRows, cur, stamp)
  const afterOv = overlayCapacity(liveRows, provisional, stamp)
  const openBefore = openWeekendDaysOf(beforeOv.capacityRows, beforeOv.lineRows, activeIds)
  const openAfter = openWeekendDaysOf(afterOv.capacityRows, afterOv.lineRows, activeIds)
  const win = new Set(session.windowDates)
  const weekendsAdded: YMD[] = []
  const weekendsRemoved: YMD[] = []
  for (const w of [...openAfter].sort()) {
    // 只收「這次在模擬裡打開」的週末：正式已開的（含模擬區建立後才開、不在 window 的）不算——openAfter 是正式＋模擬疊出來的，
    //   直接全收會把正式新開的週末悄悄塞進 window（D101 驗證修正；editable 已排除它們，這裡再明寫一次防回歸）
    if (isWeekend(w) && editable.has(w) && !win.has(w) && !liveOpen.has(w)) { win.add(w); weekendsAdded.push(w) }
  }
  for (const w of [...openBefore].sort()) {
    if (openAfter.has(w) || !isWeekend(w) || liveOpen.has(w) || !win.has(w)) continue
    const n = openCardCountOn(w)
    if (n > 0) {
      return fail('weekend_has_cards', `${mdLabel(w)} 還有 ${n} 張卡，請先移到其他日期再關閉這天的模擬加班`, { date: w, cardCount: n })
    }
    win.delete(w)
    weekendsRemoved.push(w)
  }
  const windowDates = [...win].sort()
  const next = normalizeSimCapacity(provisional, { windowDates, lineIds: session.lineIds })

  // 變更清單（op_log）與標籤
  const beforeMap = new Map(cur.cells.map((x) => [cellKey(x.date, x.lineId), x]))
  const afterMap = new Map(next.cells.map((x) => [cellKey(x.date, x.lineId), x]))
  const changes: Extract<ApplySimCapacityResult, { ok: true }>['changes'] = []
  for (const k of [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()) {
    const b = beforeMap.get(k) ?? null
    const a = afterMap.get(k) ?? null
    if (b && a && b.regularHours === a.regularHours && b.overtimeHoursMax === a.overtimeHoursMax) continue
    const [date, lid] = k.split('|')
    changes.push({
      date, lineId: Number(lid),
      before: b ? { regularHours: b.regularHours, overtimeHoursMax: b.overtimeHoursMax } : null,
      after: a ? { regularHours: a.regularHours, overtimeHoursMax: a.overtimeHoursMax } : null,
    })
  }
  const lineName = (id: number) => lineNameOf(world.lines, id)
  const parts: string[] = [
    ...weekendsAdded.map((w) => `${mdLabel(w)} 開加班`),
    ...weekendsRemoved.map((w) => `${mdLabel(w)} 關加班`),
    ...changes.map((c) => c.after
      ? `${mdLabel(c.date)} ${lineName(c.lineId)} ${isWeekend(c.date) ? `加班 ${c.after.overtimeHoursMax}h` : `${c.after.regularHours}h${c.after.overtimeHoursMax > 0 ? `＋加班 ${c.after.overtimeHoursMax}h` : ''}`}`
      : `${mdLabel(c.date)} ${lineName(c.lineId)} 回到正式值`),
  ]
  const label = input.clearAll
    ? '模擬產線時數全部回到正式值'
    : `模擬產線時數：${parts.slice(0, 2).join('、') || '沒有變更'}${parts.length > 2 ? ` 等 ${parts.length} 項` : ''}`
  const oldWindow = [...session.windowDates].sort()
  const changed = !sameSimCapacity(cur, next) || windowDates.length !== oldWindow.length || windowDates.some((d, i) => d !== oldWindow[i])
  return { ok: true, simCapacity: next, windowDates, changed, label, changes, weekendsAdded, weekendsRemoved }
}

// ─────────────────────────────────────────────────────────────────────
// 採用成功後：清掉「模擬值已等於正式值」的格（D101 §6.4 第 15 步）
// ─────────────────────────────────────────────────────────────────────

/**
 * 採用成功後，採用範圍內（adoptLineIds）模擬值已與正式相同的格都拿掉——否則之後組長在正式改了 9/30，模擬區還被舊覆寫壓在 6h，
 * 下一次採用會把組長的修改蓋回去。模擬開的週末若正式已開也拿掉。
 * 防呆：拿掉之後模擬區任何一天任何一條線的有效值都不能變；變了就整份不清（回傳原本的覆寫）。
 */
export function pruneAdoptedCells(input: {
  simCapacity: SimCapacity
  session: SimScopeSession
  liveAfter: { capacityRows: readonly DailyCapacity[]; lineRows: readonly LineCapacity[] }
  adoptLineIds: readonly number[]
  lines: readonly PackagingLine[]
}): SimCapacity {
  const { session, liveAfter, lines } = input
  const c = normalizeSimCapacity(input.simCapacity, session)
  if (isEmptySimCapacity(c)) return c
  const stamp = stampOf(session)
  const liveDaily = [...liveAfter.capacityRows].sort(byDate)
  const liveGrouped = groupLineRows(liveAfter.lineRows)
  const simOv = overlayCapacity({ capacityRows: liveDaily, lineRows: liveAfter.lineRows }, c, stamp)
  const simGrouped = groupLineRows(simOv.lineRows)
  const adopt = new Set(input.adoptLineIds)
  const cells = c.cells.filter((x) => {
    if (!adopt.has(x.lineId)) return true
    const live = resolveLineCapacity(x.date, x.lineId, liveGrouped.get(x.lineId) ?? [], weekendOpenOn(x.date, liveDaily))
    const sim = resolveLineCapacity(x.date, x.lineId, simGrouped.get(x.lineId) ?? [], weekendOpenOn(x.date, simOv.capacityRows))
    return !sameEffective(live, sim)
  })
  const weekendsOpened = c.weekendsOpened.filter((w) => !weekendOpenOn(w, liveDaily))
  const candidate: SimCapacity = { v: 1, cells, weekendsOpened }
  if (sameSimCapacity(candidate, c)) return c
  // 拿掉之後模擬值一格都不能變
  const candOv = overlayCapacity({ capacityRows: liveDaily, lineRows: liveAfter.lineRows }, candidate, stamp)
  for (const d of simCapacityDates(session)) {
    const a = resolveDayCapacity(d, { daily: simOv.capacityRows, lineRows: simOv.lineRows, lines })
    const b = resolveDayCapacity(d, { daily: candOv.capacityRows, lineRows: candOv.lineRows, lines })
    const al = a.lines ?? [], bl = b.lines ?? []
    if (al.length !== bl.length) return c
    for (let i = 0; i < al.length; i++) if (al[i].lineId !== bl[i].lineId || !sameEffective(al[i], bl[i])) return c
  }
  return candidate
}

// ─────────────────────────────────────────────────────────────────────
// 模擬區其他寫入路徑的產能規則（route 只照結果寫；抽成純函式才能單元測試）
// ─────────────────────────────────────────────────────────────────────

/**
 * 退回上一步（session/undo）要不要寫 sim_capacity：只有快照有這欄、且值與目前不同才寫。
 * 沒變就不帶 → migration 20260928c 套用前、沒調過時數的退回都不會碰到新欄。
 * 快照沒有這欄＝穩定站舊程式（3711）推的格；或舊程式推 undo 時把「解析過的整個堆疊」寫回，連新程式格裡的產能快照也被洗掉
 *   （D101 驗證發現，過渡期 3710／3711 混用同一個模擬區才會發生）→ 不知道當時的時數：保留目前產能。
 *   目前有模擬時數時回 capacityUnknown，route 據此提示「這一步的產線時數無法還原」——不能默默保留、讓人以為已經退回。
 *   目前沒有模擬時數就不提示（最常見的是 D101 之前的舊格，當時本來就沒有模擬時數）。
 */
export function undoCapacityPatch(snapshot: { simCapacity?: SimCapacity }, current: SimCapacity | undefined): { simCapacity?: SimCapacity; capacityUnknown?: true } {
  if (snapshot.simCapacity !== undefined) {
    return !sameSimCapacity(snapshot.simCapacity, current) ? { simCapacity: snapshot.simCapacity } : {}
  }
  return isEmptySimCapacity(current) ? {} : { capacityUnknown: true }
}

/**
 * 載入 AI 歷史（session/load-run）時的範圍與產能（D101）：
 *   - horizon 相同且「工作日」相同才能載（模擬開的週末會改變 window，但不改工作日集合；runs/[id] 的 canLoad 同一個判斷）；
 *   - 一律連同那次的 windowDates 與「那次 AI 用的覆寫」一起載回（AI 是在那組時數下排的，負荷條才對得上）。
 *   - run.simCapacity 為 null＝建 run 時沒有覆寫（只有非空才寫入）或舊程式的 run（舊 runner 只用正式產能）→ 當成空覆寫，
 *     與 runner.baseStateOf 同一個解讀（D101 驗證修正：原本 null 時「保留目前產能」，載入的結果與 AI 當時的時數對不上；
 *     canLoad 為 true 時 load-run 卻回 window_mismatch 也是同一個根因）。
 */
export function planLoadRunCapacity(
  run: { horizon: number; windowDates: readonly YMD[]; simCapacity: SimCapacity | null },
  session: Pick<SimSession, 'horizon' | 'windowDates' | 'lineIds'> & { simCapacity?: SimCapacity },
): { ok: false } | { ok: true; windowDates: YMD[]; simCapacity: SimCapacity; windowChanged: boolean; capChanged: boolean } {
  if (run.horizon !== session.horizon || !sameWorkdays(run.windowDates, session.windowDates)) return { ok: false }
  const current = session.simCapacity ?? emptySimCapacity()
  const same = (a: readonly YMD[], b: readonly YMD[]) => a.length === b.length && a.every((d, i) => d === b[i])
  const windowDates = [...run.windowDates]
  const simCapacity = normalizeSimCapacity(run.simCapacity ?? emptySimCapacity(), { windowDates, lineIds: session.lineIds })
  return {
    ok: true,
    windowDates,
    simCapacity,
    windowChanged: !same(windowDates, session.windowDates),
    capChanged: !sameSimCapacity(simCapacity, current),
  }
}

/**
 * 重設模擬區（session POST 帶 version）時的範圍與產能（D101 §4.3）：
 *   baseWindow＝用正式的開加班週末算出的新範圍 W0；keepCapacity（預設 true）→ 把舊覆寫中「夾在 W0 第一天與最後一天之間」、
 *   ≥ 今天、非國定假日的模擬週末插回去（插入不改變起訖，所以不會循環），再只留新範圍內、≥ 今天的格；否則空覆寫。
 */
export function planResetCapacity(input: {
  existing: SimCapacity | undefined
  baseWindow: readonly YMD[]
  lineIds: readonly number[]
  today: YMD
  keepCapacity: boolean
}): { windowDates: YMD[]; simCapacity: SimCapacity } {
  const base = [...input.baseWindow]
  if (!input.keepCapacity || !input.existing || base.length === 0) return { windowDates: base, simCapacity: emptySimCapacity() }
  const first = base[0]
  const last = base[base.length - 1]
  const kept = input.existing.weekendsOpened
    .filter((d) => d > first && d < last && d >= input.today && isWeekend(d) && !isHolidayWeekend(d) && !base.includes(d))
  const windowDates = [...new Set([...base, ...kept])].sort()
  const n = normalizeSimCapacity(input.existing, { windowDates, lineIds: input.lineIds })
  return { windowDates, simCapacity: { ...n, cells: n.cells.filter((c) => c.date >= input.today) } }
}
