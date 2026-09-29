// 包裝專區 P1 分線輪 — 產線（線別）的純函式（lines.md §3.1、§3.3、§3.4；D67／D71／D72）
//
// 前後端共用：伺服器（applyOps 驗證、工作台組裝、線別 API）與畫面（拖到日期欄頭自動選線）用同一套規則，
// 樂觀更新與伺服器結果才會一致。
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import { LINE_NAME_MAX, type EffectiveLineCapacity, type PackagingLine, type YMD } from './scheduleTypes'

/** code 格式（同 migration check）：1～4 個大寫英數 */
const LINE_CODE_RE = /^[A-Z0-9]{1,4}$/

const byOrder = (a: PackagingLine, b: PackagingLine): number => a.sortOrder - b.sortOrder || a.id - b.id

/** 啟用中的線，依 sortOrder、id 排序（工作台 lanes、產能表欄位的順序） */
export function activeLinesOf(lines: readonly PackagingLine[]): PackagingLine[] {
  return lines.filter((l) => l.active).sort(byOrder)
}

/**
 * 預設線＝啟用中 sortOrder 最小（平手看 id）的線；種子資料下就是 A 線（lines.md §1.1）。
 * 用途：停用線上殘留卡的顯示位置、v1 快照還原、待排區卡直接勾完成時沒指定線。
 */
export function defaultLineIdOf(lines: readonly PackagingLine[]): number | null {
  return activeLinesOf(lines)[0]?.id ?? null
}

/** 線是否存在且啟用 */
export function isActiveLine(lines: readonly PackagingLine[], id: number | null | undefined): boolean {
  return id != null && lines.some((l) => l.id === id && l.active)
}

/**
 * D72 讀取時推導「卡片實際顯示在哪條線」（GET 不寫入）：
 * - 待排區（planDate null）→ 不屬於任何線
 * - lineId 指向啟用中的線 → 原樣
 * - 否則（null、已停用、不存在）→ 預設線，fallback＝true（組裝時加 line_inactive 旗標，請主管改排）
 */
export function resolveLaneId(
  lineId: number | null | undefined,
  planDate: YMD | null,
  lines: readonly PackagingLine[],
  defaultId: number | null,
): { laneId: number | null; fallback: boolean } {
  if (planDate == null) return { laneId: null, fallback: false }
  if (isActiveLine(lines, lineId)) return { laneId: lineId as number, fallback: false }
  return { laneId: defaultId, fallback: true }
}

/** D71 新增線時自動取代碼：第一個沒用過的 A～Z（含停用線的代碼，代碼唯一且建立後不改）；全用完回 null */
export function nextLineCode(lines: readonly PackagingLine[]): string | null {
  const used = new Set(lines.map((l) => l.code.toUpperCase()))
  for (let c = 65; c <= 90; c++) {
    const code = String.fromCharCode(c)
    if (!used.has(code)) return code
  }
  return null
}

/** 代碼格式（同 migration check）；正規化成大寫後檢查 */
export function isValidLineCode(code: unknown): code is string {
  return typeof code === 'string' && LINE_CODE_RE.test(code)
}

/** 線名驗證：trim 後 1～LINE_NAME_MAX 字（同 migration check）；通過回 null，否則回中文原因 */
export function validateLineName(name: unknown): string | null {
  if (typeof name !== 'string') return '線名必須是文字'
  const n = name.trim()
  if (n.length < 1) return '線名不可空白'
  if (n.length > LINE_NAME_MAX) return `線名最多 ${LINE_NAME_MAX} 字`
  return null
}

/** 顯示用線名（找不到回 `#id`） */
export function lineNameOf(lines: readonly PackagingLine[], id: number | null | undefined): string {
  if (id == null) return ''
  return lines.find((l) => l.id === id)?.name ?? `#${id}`
}

/**
 * D72 自動選線用的剩餘工時（分鐘，可為負）：
 * - 平日：正常工時 − 已排；該線 unset（從沒填過）→ null
 * - 週末：加班上限 − 已排（週末本來就只有加班額度）
 * 為什麼平日只看正常工時（lines.md §3.4 解讀，待 Snow 確認 §十一第 3 題）：
 *   用「正常＋加班」剩餘會把卡放到正常已滿、只剩加班額度的線，等於別線還有正常工時時就先排加班。
 */
export function laneRemaining(
  cap: Pick<EffectiveLineCapacity, 'kind' | 'regularMinutes' | 'overtimeMinutes'>,
  usedMinutes: number,
): number | null {
  if (cap.kind === 'weekend') return Math.round((cap.overtimeMinutes - usedMinutes) * 10) / 10
  if (cap.regularMinutes == null) return null
  return Math.round((cap.regularMinutes - usedMinutes) * 10) / 10
}

/**
 * 這條線當天「明確填了 0 h」（停工／未排班）：正常（週末視為 0）與加班都 ≤ 0，且不是 unset。
 * 同 laneScale 的 nominal／zero。pickAutoLane 用來把停工的線排在 unset 之後。
 */
export function laneStopped(cap: Pick<EffectiveLineCapacity, 'kind' | 'regularMinutes' | 'overtimeMinutes'>): boolean {
  const R = cap.kind === 'weekend' ? 0 : cap.regularMinutes
  if (R == null) return false
  return R <= 0 && (cap.overtimeMinutes || 0) <= 0
}

/**
 * D72 週／兩週把卡拖到日期欄頭（沒指定線）時自動選線：取「剩餘＋delta」最大的線。
 * - 排序層級：有值且沒停工的線 ＞ unset（remaining null）＞ 停工的線（stopped，明確填 0 h）；
 *   停工的線不收自動放入的卡（否則別線 unset 或已超排時，剩餘 0−已排 的停工線會被選中）
 * - 全部都 unset → 第一條（依 sortOrder）
 * - 平手依 sortOrder、再依 lineId
 * - deltaByLane：同一天內重新放下「本來就在這天」的卡時，把它自己的工時加回原線（+minutes），
 *   避免「因為自己佔著所以跳到別線」
 * 沒有任何線回 null。伺服器不自動選線（前端一律送明確 lineId，lines.md §3.4 第 4 點）。
 */
export function pickAutoLane(
  lanes: readonly { lineId: number; sortOrder: number; remainingMinutes: number | null; stopped?: boolean }[],
  opts: { deltaByLane?: ReadonlyMap<number, number> } = {},
): number | null {
  let best: Cand | null = null
  for (const l of lanes) {
    const delta = opts.deltaByLane?.get(l.lineId) ?? 0
    const rem = l.remainingMinutes == null ? null : l.remainingMinutes + delta
    const cand: Cand = { lineId: l.lineId, sortOrder: l.sortOrder, rem, tier: l.stopped && rem != null ? 2 : rem == null ? 1 : 0 }
    if (!best) { best = cand; continue }
    if (better(cand, best)) best = cand
  }
  return best?.lineId ?? null
}

/** tier：0＝有值且沒停工、1＝unset、2＝停工（數字小者優先） */
type Cand = { lineId: number; sortOrder: number; rem: number | null; tier: 0 | 1 | 2 }

function better(a: Cand, b: Cand): boolean {
  if (a.tier !== b.tier) return a.tier < b.tier
  if (a.rem != null && b.rem != null && Math.abs(a.rem - b.rem) > 1e-9) return a.rem > b.rem
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder
  return a.lineId < b.lineId
}
