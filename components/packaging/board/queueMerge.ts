// 工作台存檔佇列的純邏輯（D98 ①④）：合併判斷、觸及 id、合併標籤、延遲送出與「停手才重抓」的計時判斷（含例外 needsPromptReload）。
//
// 為什麼抽成純函式：useBoard 是 React hook（計時器、ref、網路），不好直接測；
// 「能不能併成一次存檔」一旦判斷錯，就是假的 version_conflict、Undo 錯亂或操作遺失，所以規則集中在這裡用 node:test 逐條測。
// hook 只負責：何時呼叫這些函式、何時啟動／清掉計時器。
//
// ④ 合併存檔的正確性論證（為什麼「分開送」與「併成一批依序送」結果相同）：
//   伺服器 applyOps 對一批 ops「逐一模擬」，後一個看得到前一個的結果；分開送時第二批的起點＝第一批寫完的狀態，
//   所以每個 op 看到的「當下狀態」兩種送法都一樣。兩者只差在：
//   (a) 版本號、(b) 以「本批開始時」為基準的檢查、(c) 本批共用的時間戳（createdAt）、(d) 一批一個 Undo 單位、(e) 失敗時丟多少。
//   (a) 每個 op 只驗「自己觸及的列」的 version（getRow），伺服器也只 stamp（version+1）這些列。
//       兩批觸及的 id 完全不重疊時，第一批寫完不會改到第二批任何一列的版本 → 送出前 rebaseOpVersions 算出的 version
//       與分開送時完全相同，不會製造 version_conflict；也不會出現「先放回、再以原 id 重建」的假 id_exists（applyOps 以批開始時判斷 id 是否存在）。
//   (b) D7 守恆的上限＝max(可排量 E, 本批開始時的 Σ未完成)、每行張數上限＝max(30, 本批開始時的張數)、全表 5000 張上限看整批淨增量。
//       規則：「會變多」與「會變少」的操作不併在同一批（qtyEffect）。
//       · 後一批有「變多」的操作 ⇒ 前一批只增不減：前一批每個增加都已通過 Σ ≤ max(E, Σ0)，結束時 Σ1 ≥ Σ0 且 Σ1 ≤ max(E, Σ0)，
//         所以 max(E, Σ1) ＝ max(E, Σ0)——第二批以哪個起點算上限都一樣（張數同理）。
//       · 後一批只減或不動 ⇒ 它根本不觸發這些檢查；全表上限則因「前增後減」也不併而不會變寬。
//       （反例見測試：超排的行「先放回 A 再排入 C」分開送會被擋、併批會過 → 所以不併。）
//   (c) 同一批新建的列 createdAt 相同；分配（allocateLine）同一天同一行依 createdAt、再依 id 排先後。
//       兩邊都有新建列、且可能在同一個 SO 行時，併批會把「先排的先分配」變成依 uuid 決定（D22 預排判定跟著變）→ 不併。
//       D69 學習紀錄以「整批寫完後」的分配算有效數量：前一批改工時、後一批又動到分配時也不併。
//   (d) Snow 已接受「復原一次退回整批」（D98）；整批的反向操作仍要能一次送出（≤ MAX_OPS_PER_REQUEST）→ 以 undoChainSize 估上限。
//   (e) applyOps 任一步失敗整批不寫：併批裡第 k 個操作被擋時，前 k−1 個在分開送時早就存好了。
//       useBoard 依伺服器回的 opIndex（splitBatchAtOp）把前段另成一批重送，只丟失敗的那個與之後排隊的——與分開送相同。

import { MAX_OPS_PER_REQUEST, type PlacementOp } from '@/lib/packaging/scheduleTypes'

/** ④ 一般操作送出前等多久（最後一次排入起算）；期間的連續操作併成一次存檔 */
export const MERGE_HOLD_MS = 1500
/**
 * ④ 一批最長壓多久（這一批第一個操作排入起算）。
 * 拖曳中會繼續等（放開後緊接著的排入才併得進來，不然「放下 A → 抓起 B」幾乎都超過 1.5 秒），但不能無限延後：
 * 未存的操作越久，被接手編輯權、關分頁、驗證失敗時一次丟掉的就越多。
 */
export const MERGE_MAX_HOLD_MS = 10_000
/** ① 佇列清空、使用者停手多久才重抓整張工作台（期間有新操作或正在拖曳就延後） */
export const RELOAD_SETTLE_MS = 3000
/** 伺服器寫進 op_log 的 label 上限（lib/packaging/scheduleWrite.ts 的 LABEL_MAX；超過會被伺服器截斷） */
export const OP_LABEL_MAX = 120

export type QueueEndpoint = 'placements' | 'complete'
export type QueueMode = 'normal' | 'undo' | 'redo'

/** 判斷合併需要的佇列項目欄位（useBoard 的 QueueItem 是它的超集） */
export interface MergeableItem {
  endpoint: QueueEndpoint
  mode: QueueMode
  ops: readonly PlacementOp[]
  /** 已送出過（送出中、失敗重試中、等重新取得編輯權）：伺服器可能已看過／寫入這批，內容不可再改 */
  sent: boolean
}

/** 會延遲送出、可以被併入的項目：只有一般操作走 placements；勾完成（complete API）、Undo／Redo 立刻送 */
export function isDeferrable(item: Pick<MergeableItem, 'endpoint' | 'mode'>): boolean {
  return item.endpoint === 'placements' && item.mode === 'normal'
}

/**
 * 一批 ops 觸及的所有擺放 id（含新建的）：
 * place／restore＝新建的 id；split＝原卡＋拆出的每張新卡；merge＝目標＋每張來源；其他＝op.id。
 * 漏加新 op 種類時編譯期就會報錯（never），不會悄悄把沒列到的 id 當成「不重疊」。
 */
export function touchedIds(ops: readonly PlacementOp[]): Set<string> {
  const ids = new Set<string>()
  for (const op of ops) {
    switch (op.op) {
      case 'place': ids.add(op.id); break
      case 'restore': ids.add(op.row.id); break
      case 'split': ids.add(op.id); for (const p of op.parts) ids.add(p.id); break
      case 'merge': ids.add(op.targetId); for (const s of op.sources) ids.add(s.id); break
      case 'move':
      case 'unplace':
      case 'setQty':
      case 'complete':
      case 'uncomplete':
      case 'setMinutes':
      case 'reorder':
        ids.add(op.id)
        break
      default: {
        const unknownOp: never = op
        throw new Error(`touchedIds：不認得的操作 ${JSON.stringify(unknownOp)}`)
      }
    }
  }
  return ids
}

/**
 * 操作對「某 SO 行的未完成總量 Σ／未完成張數」的方向（applyOps 的 checkConserve／checkLineCount 與全表上限都只看這兩個數）：
 * - grows：place、restore、uncomplete（Σ 與張數都增）、split（張數增）、setQty（可能增）
 * - shrinks：unplace、complete（Σ 與張數都減）、merge（張數減）、setQty（可能減）
 * - 都不是：move、setMinutes、reorder（不改數量也不改張數）
 */
export function qtyEffect(op: PlacementOp): { grows: boolean; shrinks: boolean } {
  switch (op.op) {
    case 'place':
    case 'restore':
    case 'uncomplete':
    case 'split':
      return { grows: true, shrinks: false }
    case 'unplace':
    case 'complete':
    case 'merge':
      return { grows: false, shrinks: true }
    case 'setQty':
      return { grows: true, shrinks: true }
    case 'move':
    case 'setMinutes':
    case 'reorder':
      return { grows: false, shrinks: false }
    default: {
      const unknownOp: never = op
      throw new Error(`qtyEffect：不認得的操作 ${JSON.stringify(unknownOp)}`)
    }
  }
}

/** 會影響 allocateLine 結果的操作（分配看日期、數量、完成與否、createdAt；工時覆寫與線內順序不看） */
function affectsAllocation(op: PlacementOp): boolean {
  return op.op !== 'setMinutes' && op.op !== 'reorder'
}

/** 新建列所在的 SO 行；split 的行要查原卡才知道 → UNKNOWN_LINE（保守：不和另一邊的新建列併） */
const UNKNOWN_LINE = '\u0000unknown'
function createdLines(ops: readonly PlacementOp[]): Set<string> {
  const lines = new Set<string>()
  for (const op of ops) {
    if (op.op === 'place') lines.add(op.soLineKey)
    else if (op.op === 'restore') lines.add(op.row.soLineKey)
    else if (op.op === 'split') lines.add(UNKNOWN_LINE)
  }
  return lines
}

/**
 * 這個操作「正向、Undo、Redo、再 Undo…」一路下去，單次請求最多會有幾個 op（伺服器 applyOps 的 inverse 規則）：
 * - merge（n 張來源）：反向＝setQty＋n 個 restore，再反向＝n 個 unplace＋setQty → n + 1
 * - split（p 張新卡）：反向＝merge（＋原卡有覆寫時再一個 setQty），再反向＝setQty＋p 個 restore（＋setQty）→ 最多 p + 2
 * - 其他：一對一 → 1
 * 併批後整批的反向操作是各 op 反向的串接，數量相加；超過 MAX_OPS_PER_REQUEST 時 Undo 會被伺服器以 too_many_ops 擋下，
 * 分開送就不會 → 併之前先用這個上限檢查。
 */
export function undoChainSize(ops: readonly PlacementOp[]): number {
  let n = 0
  for (const op of ops) {
    if (op.op === 'merge') n += op.sources.length + 1
    else if (op.op === 'split') n += op.parts.length + 2
    else n += 1
  }
  return n
}

export type MergeRefusal =
  | 'no_prev'        // 佇列是空的
  | 'not_deferrable' // 任一邊不是一般 placements 操作（勾完成、Undo／Redo）
  | 'sent'           // 前一批已送出過
  | 'too_many_ops'   // 併完（含 Undo／Redo 的反向操作）會超過單次請求上限
  | 'overlap'        // 觸及同一張卡
  | 'qty_direction'  // 一邊讓數量／張數變多、另一邊變少
  | 'created_same_line' // 兩邊都新建列，且可能在同一個 SO 行（createdAt 相同會改變分配先後）
  | 'minutes_then_allocation' // 前一批改工時、後一批又動到分配（D69 學習紀錄的有效數量會不同）

export type MergeVerdict = { ok: true } | { ok: false; reason: MergeRefusal }

/**
 * 新操作 next 能否併進佇列最後一個項目 prev（併完仍是「prev 的 ops 在前、next 在後」依序套用）。
 * 條件與理由見檔頭 (a)～(d)。
 */
export function canMerge(
  prev: MergeableItem | undefined,
  next: Pick<MergeableItem, 'endpoint' | 'mode' | 'ops'>,
  maxOps: number = MAX_OPS_PER_REQUEST,
): MergeVerdict {
  if (!prev || prev.ops.length === 0) return { ok: false, reason: 'no_prev' }
  if (!isDeferrable(prev) || !isDeferrable(next)) return { ok: false, reason: 'not_deferrable' }
  if (prev.sent) return { ok: false, reason: 'sent' }
  if (undoChainSize(prev.ops) + undoChainSize(next.ops) > maxOps) return { ok: false, reason: 'too_many_ops' }

  const a = touchedIds(prev.ops)
  for (const id of touchedIds(next.ops)) if (a.has(id)) return { ok: false, reason: 'overlap' }

  const pe = prev.ops.map(qtyEffect)
  const ne = next.ops.map(qtyEffect)
  const prevGrows = pe.some(e => e.grows)
  const prevShrinks = pe.some(e => e.shrinks)
  const nextGrows = ne.some(e => e.grows)
  const nextShrinks = ne.some(e => e.shrinks)
  if ((prevGrows && nextShrinks) || (prevShrinks && nextGrows)) return { ok: false, reason: 'qty_direction' }

  const pc = createdLines(prev.ops)
  const nc = createdLines(next.ops)
  if (pc.size > 0 && nc.size > 0) {
    if (pc.has(UNKNOWN_LINE) || nc.has(UNKNOWN_LINE)) return { ok: false, reason: 'created_same_line' }
    for (const k of nc) if (pc.has(k)) return { ok: false, reason: 'created_same_line' }
  }

  if (prev.ops.some(o => o.op === 'setMinutes') && next.ops.some(affectsAllocation)) {
    return { ok: false, reason: 'minutes_then_allocation' }
  }
  return { ok: true }
}

/** 併進一批的一個使用者操作：標籤與它貢獻的 op 數（依序；用來把伺服器回的 opIndex 對回是哪個操作） */
export interface BatchPart {
  label: string
  opCount: number
}

export interface Batch {
  ops: PlacementOp[]
  parts: BatchPart[]
  label: string
}

/** 單一操作的批 */
export function singleBatch(ops: readonly PlacementOp[], label: string): Batch {
  return { ops: [...ops], parts: [{ label, opCount: ops.length }], label }
}

/** 併入：prev 的 ops 在前、next 在後（順序＝使用者操作順序，伺服器依序套用） */
export function appendToBatch(
  prev: { ops: readonly PlacementOp[]; parts: readonly BatchPart[] },
  next: { ops: readonly PlacementOp[]; label: string },
): Batch {
  const parts = [...prev.parts, { label: next.label, opCount: next.ops.length }]
  return { ops: [...prev.ops, ...next.ops], parts, label: mergeLabels(parts.map(p => p.label)) }
}

/**
 * 併批被伺服器以「某個 op 沒通過」擋下（applyOps 逐一驗證、任一步失敗整批不寫）時，切出「失敗那個操作之前」的部分。
 * 分開送的話，前面那些操作早就各自存好了；只有失敗的那個（與之後排隊的）會被丟掉——
 * 所以前段要另成一批重送，才不會因為「併了批」多丟使用者的操作。
 * 前段在同一個起點狀態下已逐一驗證通過，單獨重送會得到同樣的結果。
 * 回傳 null：opIndex 不在範圍內（對不回是哪個操作）；kept null：失敗的就是第一個操作（沒有前段可存）。
 */
export function splitBatchAtOp(
  batch: { ops: readonly PlacementOp[]; parts: readonly BatchPart[] },
  opIndex: number,
): { kept: Batch | null; failedIndex: number; failedLabel: string } | null {
  if (!Number.isInteger(opIndex) || opIndex < 0 || opIndex >= batch.ops.length) return null
  let start = 0
  for (let k = 0; k < batch.parts.length; k++) {
    const end = start + batch.parts[k].opCount
    if (opIndex < end) {
      const failedLabel = batch.parts[k].label
      if (k === 0) return { kept: null, failedIndex: 0, failedLabel }
      const parts = batch.parts.slice(0, k)
      return { kept: { ops: batch.ops.slice(0, start), parts, label: mergeLabels(parts.map(p => p.label)) }, failedIndex: k, failedLabel }
    }
    start = end
  }
  return null // parts 與 ops 對不上（不該發生）→ 呼叫端照舊整批處理
}

/**
 * 合併批的標籤（寫進 op_log 與 Undo 按鈕提示）：
 * - 1 個操作 → 原標籤
 * - 開頭動詞都一樣（例：都是「移動」）→「移動 3 張卡：A → 9/30、B → 10/1…」
 * - 否則 →「3 個操作：移動 A → 9/30、改工時 B…」
 * 一律截到 max 字（伺服器同樣會截），數量放在最前面，截斷也看得到共幾個。
 */
export function mergeLabels(labels: readonly string[], max: number = OP_LABEL_MAX): string {
  const list = labels.map(l => l.trim()).filter(l => l.length > 0)
  if (list.length === 0) return ''
  if (list.length === 1) return cut(list[0], max)
  const verbOf = (l: string) => { const m = l.match(/^(\S+)\s+\S/); return m ? m[1] : null }
  const verb = verbOf(list[0])
  const sameVerb = verb != null && list.every(l => verbOf(l) === verb)
  const text = sameVerb
    ? `${verb} ${list.length} 張卡：${list.map(l => l.slice(verb.length).trim()).join('、')}`
    : `${list.length} 個操作：${list.join('、')}`
  return cut(text, max)
}

function cut(s: string, max: number): string {
  const chars = Array.from(s) // 以字元計（不把 emoji 等代理對切成兩半）
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/**
 * ④ 佇列最前面的項目還要等多久才送（0＝現在送）。
 * holdUntil 0＝不等（勾完成、Undo／Redo、已被放行）；拖曳中先不送（回傳下次再檢查的間隔），但最長只壓到 firstAt + maxHold。
 */
export function holdDelayMs(
  item: { holdUntil: number; firstAt: number },
  now: number,
  dragging: boolean,
  hold: number = MERGE_HOLD_MS,
  maxHold: number = MERGE_MAX_HOLD_MS,
): number {
  if (item.holdUntil <= 0) return 0
  const cap = item.firstAt + maxHold
  if (now >= cap) return 0
  if (dragging) return Math.max(1, Math.min(hold, cap - now))
  return Math.max(0, Math.min(item.holdUntil, cap) - now)
}

/**
 * ① 的例外：這一批存完後，畫面沒辦法靠「樂觀更新＋寫入回應的版本號」呈現正確結果 → 佇列清空時立刻重抓（不等停手 3 秒），
 * 等合併中的後續操作也一併放行（不等 1.5 秒），讓重抓盡快落地。
 * - Undo／Redo：送的是伺服器回的反向操作，本機沒有套用（applyLocal），卡片要重抓才會動。
 *   晚 3 秒以上＝畫面停在復原前、Undo 鈕卻已經能再按：主管以為沒按到而連按，一次退好幾步；
 *   被復原「刪掉」的卡（例：復原排入＝unplace）還留在畫面上，拖它會拿到 not_found，連帶丟掉同批其他操作。
 * - 放回待排池（unplace）：applyLocal 只把卡從日期欄拿掉，待排池剩餘量要重抓才回來（前端不重算分配）；
 *   晚了主管會照舊的剩餘量排卡（排少了），剩 0 的行在池裡整個看不到。
 * 這兩種在連續拖曳中都不常見，排除在 ① 之外不影響「連續拖曳少重抓」。
 */
export function needsPromptReload(item: { mode: QueueMode; ops: readonly PlacementOp[] }): boolean {
  return item.mode !== 'normal' || item.ops.some(o => o.op === 'unplace')
}

export type SettleDecision = 'reload' | 'defer' | 'skip'

/**
 * ① 「停手 3 秒」計時到時要不要重抓：
 * - skip：沒有待校正的東西，或佇列還沒清空（清空時 pump 會重新計時）
 * - defer：正在拖曳（重畫會換掉被拖的卡）→ 再等一輪
 * - reload：重抓一次（force，跳過 revision 比對）
 */
export function settleDecision(s: { dirty: boolean; queueLength: number; busy: boolean; dragging: boolean }): SettleDecision {
  if (!s.dirty) return 'skip'
  if (s.queueLength > 0 || s.busy) return 'skip'
  if (s.dragging) return 'defer'
  return 'reload'
}

/** 畫面上的「尚未儲存 N」：以使用者操作（合併前）計，不是以請求數計 */
export function countActions(queue: readonly { parts: readonly BatchPart[] }[]): number {
  let n = 0
  for (const it of queue) n += Math.max(1, it.parts.length)
  return n
}
