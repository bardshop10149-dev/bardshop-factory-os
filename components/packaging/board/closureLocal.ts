// D110 結案的「本地暫時狀態」（純函式；正式工作台與 AI 模擬區共用）。
//
// 為什麼需要：結案以前是「按確定 → 等伺服器 → 整張重抓」，卡片要等兩趟網路才消失（實測 2.6～26.9 秒＋重抓），
//   這段時間卡片還能再按一次結案（→ 409「這一行已經結案」）。改成樂觀更新後，畫面不等伺服器：
//   ① 按下確定：該 SO-項次記為 pending → 這一行的卡（待排池卡、排定卡、模擬列）立刻從畫面濾掉
//   ② 伺服器成功（或 409 already_closed＝本來就結案了）：改記 confirmed，繼續濾
//   ③ 伺服器失敗：拿掉記號 → 底下的資料沒動過，卡片自然回到原位
//   ④ 之後任何一份伺服器回應「本身已不含該行」→ 記號功成身退（pruneMarks）
// 為什麼用「記號＋每次套用」而不是直接改資料：輪詢或較早發出的回應可能晚到，整份資料被換掉時
//   直接改過的結果會被蓋回去（已結案的卡又跑出來）；記號套在「每一份」資料上，不管回應何時到都一樣。
// 這裡不 import React、不讀時鐘、不打 API；hook 在 useClosures.ts（工作台）與 ai/useSim.ts（模擬區）。

import type { BoardCard, BoardDay } from '@/lib/packaging/scheduleTypes'
import type { PoolBlock, PoolBlockId } from '@/lib/packaging/types'
import { blockWithCards } from '@/lib/packaging/closures'
import { recomputeDay } from './boardLocal'

/** 正式工作台（BoardOk）與模擬區（BoardBody）共有的欄位；兩邊都能套 */
export interface ClosableBoard {
  today: string
  days: BoardDay[]
  holding: BoardCard[]
  pool: { blocks: PoolBlock[] }
}

export const closureKey = (soLineKey: string): string => soLineKey.trim().toUpperCase()

// ─────────────────────────────────────────────────────────────────────
// 記號（pending／confirmed）
// ─────────────────────────────────────────────────────────────────────

export type ClosedMark = 'pending' | 'confirmed'
export type ClosedMarks = ReadonlyMap<string, ClosedMark>

export const NO_MARKS: ClosedMarks = new Map()

/** 設定記號；內容沒變就回同一個 Map（React state 不必多重畫一次） */
export function setMark(marks: ClosedMarks, soLineKey: string, mark: ClosedMark): ClosedMarks {
  const k = closureKey(soLineKey)
  if (!k || marks.get(k) === mark) return marks
  const next = new Map(marks)
  next.set(k, mark)
  return next
}

/** 拿掉記號（結案失敗＝卡片回原位；復原結案＝該行回待排池） */
export function clearMark(marks: ClosedMarks, soLineKey: string): ClosedMarks {
  const k = closureKey(soLineKey)
  if (!marks.has(k)) return marks
  const next = new Map(marks)
  next.delete(k)
  return next
}

/** 這份資料裡出現的 SO 行（待排池卡、各天排定卡、待排區；一律大寫） */
export function linesPresent(body: ClosableBoard): Set<string> {
  const out = new Set<string>()
  for (const b of body.pool.blocks) for (const c of b.cards) out.add(closureKey(c.soLineKey))
  for (const d of body.days) for (const c of d.cards) out.add(closureKey(c.soLineKey))
  for (const c of body.holding) out.add(closureKey(c.soLineKey))
  return out
}

/**
 * 伺服器回應（或由它推導的畫面資料）已不含該行 → confirmed 的記號可以拿掉。
 * pending 的不動：伺服器還沒回話，資料裡有沒有那一行都不代表結果（失敗時要靠記號還在才知道要還原誰）。
 * 沒有任何變動時回同一個 Map。
 */
export function pruneMarks(marks: ClosedMarks, body: ClosableBoard): ClosedMarks {
  if (marks.size === 0) return marks
  let present: Set<string> | null = null
  let next: Map<string, ClosedMark> | null = null
  for (const [k, m] of marks) {
    if (m !== 'confirmed') continue
    present ??= linesPresent(body)
    if (present.has(k)) continue
    next ??= new Map(marks)
    next.delete(k)
  }
  return next ?? marks
}

// ─────────────────────────────────────────────────────────────────────
// 套用：把有記號的行從畫面資料濾掉
// ─────────────────────────────────────────────────────────────────────

/**
 * 回傳濾掉這些 SO 行之後的資料；**絕不修改輸入**（拿掉記號後要能原樣回來）。
 * - 沒有記號、或資料裡沒有任何一張命中 → 回同一個物件（useMemo／memo 的卡片不必重畫）
 * - 待排池區塊合計（張數、工時、逾期、打樣）與各天／各線的已排工時、負荷燈號都跟著重算，
 *   否則卡片不見了、欄頭的工時還算著它
 * - 已完成的卡也一起濾：伺服器端結案後整行不在待排池，該行的卡（含已完成）讀取時一律略過，畫面要一致
 * pool.cardMeta 不動（以 cardId 查，留著沒有副作用）。
 */
export function hideClosedLines<T extends ClosableBoard>(body: T, marks: ClosedMarks): T {
  if (marks.size === 0) return body
  const hit = (soLineKey: string) => marks.has(closureKey(soLineKey))
  let changed = false
  const blocks = body.pool.blocks.map(b => {
    if (!b.cards.some(c => hit(c.soLineKey))) return b
    changed = true
    return blockWithCards(b, b.cards.filter(c => !hit(c.soLineKey)), body.today)
  })
  const days = body.days.map(d => {
    if (!d.cards.some(c => hit(c.soLineKey))) return d
    changed = true
    return recomputeDay(d, d.cards.filter(c => !hit(c.soLineKey)))
  })
  let holding = body.holding
  if (holding.some(c => hit(c.soLineKey))) {
    changed = true
    holding = holding.filter(c => !hit(c.soLineKey))
  }
  if (!changed) return body
  return { ...body, pool: { ...body.pool, blocks }, days, holding }
}

/** 這一行目前在畫面資料上有幾張卡（待排池卡＋排定卡＋待排區）；失敗提示「N 張卡已放回原位」用 */
export function countLineCards(body: ClosableBoard, soLineKey: string): number {
  const k = closureKey(soLineKey)
  let n = 0
  for (const b of body.pool.blocks) for (const c of b.cards) if (closureKey(c.soLineKey) === k) n++
  for (const d of body.days) for (const c of d.cards) if (closureKey(c.soLineKey) === k) n++
  for (const c of body.holding) if (closureKey(c.soLineKey) === k) n++
  return n
}

/**
 * 這一行在待排池的「整行數量」（各卡原始量合計，含已排出去的）；待排池裡沒有這一行＝null。
 * 這就是 packaging_closures.qty_at_close 一直以來的定義（D110 前由伺服器重組待排池後加總）；
 * D110 起伺服器不重組待排池，改由前端把同一個數字當提示帶過去——D105 通知信「結案後 ARGO 仍未銷貨」拿它比對，定義不能變。
 * 來源是 pool.cardMeta：它涵蓋待排池的每一張卡（已全數排出、不在 blocks 裡的也有）；
 * cardId＝`${soLineKey}`，同一行拆成多卡時是 `${soLineKey}#區塊…`（classify.ts／manualPool.ts）。
 */
export function linePoolQty(body: { pool: { cardMeta?: Record<string, { originalQty: number }> } }, soLineKey: string): number | null {
  const k = closureKey(soLineKey)
  let sum = 0
  let n = 0
  for (const [id, m] of Object.entries(body.pool.cardMeta ?? {})) {
    const u = id.toUpperCase()
    if (u !== k && !u.startsWith(`${k}#`)) continue
    if (!Number.isFinite(m.originalQty)) continue
    sum += m.originalQty
    n++
  }
  return n > 0 ? Math.round(sum * 1000) / 1000 : null
}

// ─────────────────────────────────────────────────────────────────────
// 伺服器回應 → 要怎麼處理
// ─────────────────────────────────────────────────────────────────────

/** 網路錯誤／5xx 的重試間隔（同工作台操作佇列：1s、3s、9s） */
export const CLOSURE_RETRY_DELAYS = [1000, 3000, 9000] as const

/** boardApi.ApiResult 與 simApi.AiApiResult 共有的欄位（兩邊的 call() 都回這個形狀） */
export interface CloseCallResult {
  status: number
  network: boolean
  error: string | null
  json: unknown
}

export type CloseOutcome =
  /**
   * 結案成立。already＝409 already_closed（資料本來就已結案，視為成功）；
   * warning＝結案成立但附帶清理沒做完（伺服器回 closed: true）；
   * simVersion：number＝自己的模擬區的新 version、null＝沒被動到、undefined＝伺服器沒說（要自己重讀）。
   */
  | { kind: 'closed'; already: boolean; warning: string | null; unplaced: number; simRemoved: number; simVersion: number | null | undefined; closure: unknown }
  /** 暫時性失敗（網路／5xx）：delayMs 後重送同一個請求（重送若回 409＝上一次其實成功了 → 視為成功） */
  | { kind: 'retry'; delayMs: number; message: string }
  /** 確定失敗：卡片回原位、顯示 message */
  | { kind: 'failed'; message: string }
  /** 登入逾時：卡片回原位、導去登入 */
  | { kind: 'unauthorized' }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const countOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : 0)

/**
 * attempts＝這個請求已經失敗過幾次（第一次送＝0）。
 * 為什麼暫時性失敗要重試而不是直接把卡放回去：請求可能其實已經寫進資料庫、只是回應沒送到（逾時、斷線）；
 * 重送時伺服器會回 409 already_closed，就知道「已經結案了」。直接放回去的話主管會再按一次、看到「這一行已經結案」。
 */
export function classifyCloseResult(r: CloseCallResult, attempts: number): CloseOutcome {
  const j = isObj(r.json) ? r.json : null
  if (j && j.success === true) {
    return {
      kind: 'closed', already: false, warning: null,
      unplaced: countOf(j.unplaced), simRemoved: countOf(j.simRemoved),
      simVersion: typeof j.simVersion === 'number' ? j.simVersion : j.simVersion === null ? null : undefined,
      closure: j.closure ?? null,
    }
  }
  const code = j && typeof j.code === 'string' ? j.code : null
  if (r.status === 409 && code === 'already_closed') {
    return { kind: 'closed', already: true, warning: null, unplaced: 0, simRemoved: 0, simVersion: undefined, closure: null }
  }
  if (j && j.closed === true) {
    return { kind: 'closed', already: false, warning: r.error ?? '已結案，但附帶清理未完成，請重新整理確認', unplaced: 0, simRemoved: 0, simVersion: undefined, closure: null }
  }
  if (r.status === 401) return { kind: 'unauthorized' }
  const message = r.error ?? '結案失敗'
  const transient = r.network || (r.status >= 500 && r.status !== 501)
  if (transient && attempts < CLOSURE_RETRY_DELAYS.length) return { kind: 'retry', delayMs: CLOSURE_RETRY_DELAYS[attempts], message }
  return { kind: 'failed', message }
}

// ─────────────────────────────────────────────────────────────────────
// 請求內容
// ─────────────────────────────────────────────────────────────────────

/** 主管按下「確定結案」的那一行（對話框上看到的內容） */
export interface ClosureIntent {
  soLineKey: string
  /** 畫面顯示用：單號-項次 */
  label: string
  note: string | null
  /** 卡片所在區塊、整行在待排池的數量（linePoolQty；找不到才用這張卡的量）。伺服器當提示用，不合法的值會忽略 */
  block: PoolBlockId | null
  qty: number | null
  /** 按下結案當時，這一行在畫面上的未完成排定卡張數（伺服器沒回張數時，用它決定要不要清 Undo）；不知道就省略 */
  openPlacements?: number
}

export function closeRequestOf(i: ClosureIntent): { action: 'close'; soLineKey: string; note: string | null; hint: { block: PoolBlockId | null; qty: number | null } } {
  return {
    action: 'close',
    soLineKey: i.soLineKey,
    note: i.note && i.note.trim() ? i.note.trim() : null,
    hint: { block: i.block, qty: typeof i.qty === 'number' && Number.isFinite(i.qty) && i.qty > 0 ? i.qty : null },
  }
}

// ─────────────────────────────────────────────────────────────────────
// 結案佇列（正式工作台用；不依賴 React，方便單獨測）
// ─────────────────────────────────────────────────────────────────────
// 一次只送一個請求、照按下的順序送：主管可以連續結好幾張，不必等前一張回來。
// 模擬區不用這個——結案會讓模擬區 version +1，必須跟模擬區自己的操作排在同一條佇列（ai/useSim.ts）。

export type ClosedOutcome = Extract<CloseOutcome, { kind: 'closed' }>

export interface ClosureRunnerDeps {
  send: (intent: ClosureIntent) => Promise<CloseCallResult>
  /** 記號的讀寫（useClosedMarks 提供） */
  has: (soLineKey: string) => boolean
  mark: (soLineKey: string, m: ClosedMark) => void
  clear: (soLineKey: string) => void
  /** 結案成立（含 409 本來就結案了、含附帶清理未完成的警告） */
  onClosed: (intent: ClosureIntent, outcome: ClosedOutcome) => void
  /** 結案失敗：記號已拿掉、卡片已回原位 */
  onFailed: (intent: ClosureIntent, message: string) => void
  onUnauthorized: () => void
  /** 佇列長度變了（含送出中的那一個） */
  onPending?: (n: number) => void
  /** 重試的計時器（測試時注入；預設 setTimeout） */
  schedule?: (fn: () => void, ms: number) => void
}

export interface ClosureRunner {
  /** 排入結案：立刻記 pending（卡片消失）、背景依序送出。這一行已在結案中／已結案 → 不重複排，回 false */
  close: (intent: ClosureIntent) => boolean
  /** 還沒送完的筆數（含送出中、等重試的） */
  pending: () => number
}

export function createClosureRunner(deps: ClosureRunnerDeps): ClosureRunner {
  const queue: { intent: ClosureIntent; attempts: number }[] = []
  let busy = false
  /** 重試等待中：時間到才送；期間新排入的結案排在後面，不讓第一個提早重送 */
  let waiting = false
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms) })

  const pump = async (): Promise<void> => {
    if (busy || waiting) return
    const item = queue[0]
    if (!item) return
    busy = true
    let out: CloseOutcome
    try {
      out = classifyCloseResult(await deps.send(item.intent), item.attempts)
    } catch (e) {
      // send 自己丟錯（理論上 call() 會把網路錯誤包成結果，不會丟）：當成暫時性失敗處理
      out = classifyCloseResult({ status: 0, network: true, json: null, error: `網路連線失敗：${e instanceof Error ? e.message : String(e)}` }, item.attempts)
    } finally {
      busy = false
    }
    if (out.kind === 'retry') {
      item.attempts++
      waiting = true
      schedule(() => {
        waiting = false
        void pump()
      }, out.delayMs)
      return
    }
    queue.shift()
    deps.onPending?.(queue.length)
    if (out.kind === 'closed') {
      deps.mark(item.intent.soLineKey, 'confirmed')
      deps.onClosed(item.intent, out)
    } else {
      // 失敗：拿掉記號＝卡片回到原位（底下的資料沒動過）；後面排隊的結案與這一筆無關，照常送
      deps.clear(item.intent.soLineKey)
      if (out.kind === 'unauthorized') deps.onUnauthorized()
      else deps.onFailed(item.intent, out.message)
    }
    return pump()
  }

  return {
    close(intent) {
      if (deps.has(intent.soLineKey)) return false
      deps.mark(intent.soLineKey, 'pending')
      queue.push({ intent, attempts: 0 })
      deps.onPending?.(queue.length)
      void pump()
      return true
    },
    pending: () => queue.length,
  }
}

// ─────────────────────────────────────────────────────────────────────
// 結案池清單（面板）
// ─────────────────────────────────────────────────────────────────────

export type ClosureRange = 'today' | '7d' | '30d'
export const CLOSURE_RANGE_LABEL: Record<ClosureRange, string> = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' }
const RANGE_DAYS: Record<ClosureRange, number> = { today: 1, '7d': 7, '30d': 30 }

const TAIPEI_OFFSET_MS = 8 * 3600_000
/** ISO 時間 → 台北日 'YYYY-MM-DD'（同 lib/packaging/closures.taipeiDayOf） */
export function taipeiDay(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t + TAIPEI_OFFSET_MS).toISOString().slice(0, 10) : ''
}
const addDays = (ymd: string, n: number): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

export interface ClosureListItem {
  id: number
  soLineKey: string
  closedAt: string
  restoredAt: string | null
}

/** 範圍內的結案（台北日、含首尾；today＝伺服器的台北今天）；最新在前 */
export function closuresInRange<T extends ClosureListItem>(list: readonly T[], range: ClosureRange, today: string): T[] {
  const from = addDays(today, -(RANGE_DAYS[range] - 1))
  return list
    .filter(c => { const d = taipeiDay(c.closedAt); return d >= from && d <= today })
    .sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : b.id - a.id))
}

/** 「結案池（N）」的 N＝今天結案、目前仍未復原的筆數 */
export function todayClosedCount(list: readonly ClosureListItem[], today: string): number {
  return list.filter(c => !c.restoredAt && taipeiDay(c.closedAt) === today).length
}

/** 把一筆（新結案或剛復原的）併進清單：同 id 取代、沒有就加在最前面 */
export function upsertClosure<T extends ClosureListItem>(list: readonly T[], item: T): T[] {
  const i = list.findIndex(c => c.id === item.id)
  if (i < 0) return [item, ...list]
  const next = [...list]
  next[i] = item
  return next
}
