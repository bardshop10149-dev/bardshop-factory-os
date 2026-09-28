// 包裝專區 P1 分線輪 — D66 手動加入的待排池區塊 'mn'（純函式，lines.md §六.4～§六.6）
//
// 手動加入的是「供給」（待排池的卡），不是「排定」：做成待排池卡後，排定、拆卡、預排、完成、快照全部沿用既有路徑，
// 不必寫特例（lines.md §1.6）。消失條件（勾完成扣到 0、ERP 結案、手動移出）全部是讀取時推導，GET 不寫。
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import { MANUAL_BLOCK_ID, type ManualInclusion, type ManualInclusionMeta, type ManualRouteType, type Placement, type YMD } from './scheduleTypes'
import { POOL_BLOCK_META, type DangerFlag, type PackagingCard, type PoolBlock, type PoolResponse, type SourceKind } from './types'
import type { RawSoLine, WorkEstimator } from './classify'
import { isNonPhysicalLine, nameSaysSample, normDate } from './classify'
import { allocateSoldToLines, applySoldToCards, type SoSalesRow } from './salesAlloc'
import { workdaysBetween } from './workdays'
import { r3, unreflectedCompletedQty } from './scheduleAllocate'

type PoolOk = Extract<PoolResponse, { success: true }>

const EPS = 1e-9

/** D9／D11：交期 5 個工作天內算緊張、打樣類 3 天（同 classify.ts） */
const URGENT_WORKDAYS = 5
const URGENT_WORKDAYS_SAMPLE = 3

const round1 = (x: number): number => Math.round(x * 10) / 10
const mdOf = (ymd: string) => `${+ymd.slice(5, 7)}/${+ymd.slice(8, 10)}`
const trimOrNull = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}
/** 項次統一成字串（'3.0' → '3'；同 classify.ts lineStr） */
export const soLineNoStr = (v: unknown): string | null => {
  const s = trimOrNull(v)
  if (!s) return null
  return /^\d+(\.0+)?$/.test(s) ? String(parseInt(s, 10)) : s
}

export const sourceKindOfRoute = (r: ManualRouteType): SourceKind => (r === '常平' ? 'changping' : r === '委外' ? 'outsource' : 'inhouse')

export function manualMetaOf(inc: ManualInclusion): ManualInclusionMeta {
  return {
    inclusionId: inc.inclusionId, qty: inc.qty, routeType: inc.routeType, reason: inc.reason,
    addedBy: inc.addedBy, addedByName: inc.addedByName, addedAt: inc.addedAt,
  }
}

/**
 * 一筆有效手動加入 → 一張 'mn' 卡（lines.md §六.4）：
 * cardId＝`${soLineKey}#mn`、status 'ready'、statusLabel '手動加入'（不新增 CardStatus，避免牽動不能改的 PackagingCard.tsx）、
 * qtyCard＝qtyReady＝手動數量（解讀：主管手動加入＝可包，實線不預排，待確認 §十一第 7 題）、estReadyDate null、
 * 客戶／品號／品名／PACKING／單位／交期取自 erp_so_lines、工時用 routeType 估、sources []、hasSketch false。
 */
export function manualCardOf(inc: ManualInclusion, sl: RawSoLine, estimate: WorkEstimator, today: YMD): PackagingCard {
  const itemName = trimOrNull(sl.description)
  const packingRaw = trimOrNull(sl.packing)
  const packing = packingRaw && packingRaw !== '.' ? packingRaw : null // 1,600 列佔位「.」（同 classify.ts）
  const dueDate = normDate(sl.duedate)
  let workdaysLeft: number | null = null
  try { workdaysLeft = dueDate ? workdaysBetween(today, dueDate) : null } catch { workdaysLeft = null }
  const isSample = nameSaysSample(sl.description)
  const flags: DangerFlag[] = []
  if (dueDate && dueDate < today) {
    flags.push({ code: 'overdue', level: 'danger', label: `已逾期${workdaysLeft != null && workdaysLeft < 0 ? ` ${-workdaysLeft} 個工作天` : ''}（交期 ${mdOf(dueDate)}）` })
  } else if (workdaysLeft != null && workdaysLeft <= (isSample ? URGENT_WORKDAYS_SAMPLE : URGENT_WORKDAYS)) {
    flags.push({ code: 'due_soon', level: 'warn', label: `交期剩 ${workdaysLeft} 個工作天（${mdOf(dueDate as string)}）` })
  }
  const work = estimate({
    routeType: inc.routeType,
    itemCode: trimOrNull(sl.mbp_part),
    itemName: itemName ?? '',
    packing,
    qty: inc.qty,
    cpShipNote: null,
  })
  if (work.minutes == null) flags.push({ code: 'hours_unknown', level: 'info', label: '工時未知（途程與品名都對不到包裝工序）' })
  const orderQty = Number(sl.order_qty_oru)
  return {
    cardId: `${inc.soLineKey}#${MANUAL_BLOCK_ID}`,
    soLineKey: inc.soLineKey,
    block: MANUAL_BLOCK_ID,
    status: 'ready',
    statusLabel: '手動加入',
    so: inc.so,
    soLine: inc.lineNo,
    customer: sl.partner_name ?? null,
    itemCode: trimOrNull(sl.mbp_part),
    itemName,
    packing,
    unit: sl.unit_of_measure_oru ?? null,
    qtyTotal: Number.isFinite(orderQty) && orderQty > 0 ? orderQty : inc.qty,
    qtyCard: inc.qty,
    qtyReady: inc.qty,
    split: null,
    dueDate,
    workdaysLeft,
    estReadyDate: null,
    work,
    sourceKind: sourceKindOfRoute(inc.routeType),
    sources: [],
    ship: null,
    receivedQty: null,
    cpShipNote: null,
    orderRemark: trimOrNull(sl.remark2),
    preStation: null,
    sample: { isSample, reason: isSample ? 'line_name' : null },
    flags,
    hasSketch: false,
    // D103：手動量＝這筆訂單的總量（含已完成）。D73 銷貨封頂只改 qtyCard，這個值不動（applySoldToCards 用 spread 會保留）
    manualTotalQty: inc.qty,
  }
}

/**
 * D66 手動區塊組裝（lines.md §六.4～§六.6）：
 * - 該行已在正常區塊（含不可排的 3／5c）→ 不出卡（backInPool，以正常區塊的供給為準，避免同一批貨算兩次；紀錄保留）
 * - ERP 查無此行（erp_so_lines 結案會被同步刪除）→ 不出卡（soGone；ERP 重開時自動回來）
 * - D73：ARGO 已全數銷貨 → 不出卡（soldOut；紀錄保留）；部分銷貨 → 卡片數量以未出貨量為上限、標「部分已出貨」
 *   （同 classifyPool，applySoldToCards；soLines 是這些 SO 的全部行，同品號多行才分配得對）
 * - 費用行／訂單量 0 仍出卡（加入時已擋；歷史資料不在讀取時再判）
 * meta 只含「有出卡」的行（BoardCard.manual／PoolCardMeta.manual 用）。
 */
export function buildManualBlock(input: {
  inclusions: readonly ManualInclusion[]
  soLines: readonly RawSoLine[]
  normalLineKeys: ReadonlySet<string>
  estimate: WorkEstimator
  today: YMD
  /** D73 這些 SO 的銷貨鏡像；null／省略＝銷貨同步未啟用（不排除） */
  soSales?: readonly SoSalesRow[] | null
}): {
  block: PoolBlock
  meta: Record<string, ManualInclusionMeta>
  backInPoolKeys: Set<string>
  skipped: { soGone: number; backInPool: number; soldOut: number }
} {
  const bySoLine = new Map<string, RawSoLine>()
  for (const sl of input.soLines) {
    const line = soLineNoStr(sl.line_no)
    if (line) bySoLine.set(`${sl.project_id.trim().toUpperCase()}-${line}`, sl)
  }
  let cards: PackagingCard[] = []
  const meta: Record<string, ManualInclusionMeta> = {}
  const backInPoolKeys = new Set<string>()
  const skipped = { soGone: 0, backInPool: 0, soldOut: 0 }
  const incByKey = new Map<string, ManualInclusion>()
  const sorted = [...input.inclusions].sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.inclusionId - b.inclusionId))
  for (const inc of sorted) {
    if (inc.removedAt) continue
    if (input.normalLineKeys.has(inc.soLineKey)) { skipped.backInPool++; backInPoolKeys.add(inc.soLineKey); continue }
    const sl = bySoLine.get(`${inc.so.trim().toUpperCase()}-${inc.lineNo}`) ?? bySoLine.get(inc.soLineKey.toUpperCase())
    if (!sl) { skipped.soGone++; continue }
    cards.push(manualCardOf(inc, sl, input.estimate, input.today))
    incByKey.set(inc.soLineKey, inc)
  }
  if (input.soSales && cards.length > 0) {
    const { byLine } = allocateSoldToLines(input.soLines, input.soSales)
    const sold = applySoldToCards(cards, byLine, (c, qty) => input.estimate({
      routeType: incByKey.get(c.soLineKey)?.routeType ?? '自製',
      itemCode: c.itemCode,
      itemName: c.itemName ?? '',
      packing: c.packing,
      qty,
      cpShipNote: null,
    }))
    cards = sold.cards
    skipped.soldOut = sold.soldOutLines
  }
  for (const c of cards) {
    const inc = incByKey.get(c.soLineKey)
    if (inc) meta[c.soLineKey] = manualMetaOf(inc)
  }
  return { block: manualBlockOf(cards, input.today), meta, backInPoolKeys, skipped }
}

/**
 * 'mn' 區塊的彙總（張數、工時、工時未知、逾期、打樣）。從 buildManualBlock 抽出來，
 * D102 待排池頁把「已全數完成」的卡拆出去後要用同一套規則重算，兩處共用才不會算法分岔。
 */
export function manualBlockOf(cards: PackagingCard[], today: YMD): PoolBlock {
  const m = POOL_BLOCK_META[MANUAL_BLOCK_ID]
  return {
    id: MANUAL_BLOCK_ID,
    title: m.title,
    hint: m.hint,
    cards,
    cardCount: cards.length,
    totalMinutes: round1(cards.reduce((s, c) => s + (c.work.minutes ?? 0), 0)),
    unknownMinutesCards: cards.filter((c) => c.work.minutes == null).length,
    overdueCount: cards.filter((c) => !!c.dueDate && c.dueDate < today).length,
    sampleCount: cards.filter((c) => c.sample.isSample).length,
  }
}

// ─────────────────────────────────────────────────────────────────────
// D102：待排池頁是可排卡片的唯一控制台（手動加入的改數量／移出都在那一頁）
// ─────────────────────────────────────────────────────────────────────
// 型別放這裡而不是 scheduleTypes.ts：只有待排池頁與它的 API 用；scheduleTypes 是多人共用的大檔，
// 放這裡改動面最小。本檔本來就同時 import types 與 scheduleTypes，不會形成型別循環。

/** D102 待排池頁：一筆「有出卡」的手動加入的管理資訊 */
export interface PoolManualLine {
  meta: ManualInclusionMeta
  /**
   * 未完成擺放合計。伺服器 PATCH 檢查 qty_below_placed 用的就是這個數字（原始擺放量、不修剪），
   * 所以直接傳給 ManualEditDialog 的 placedQty，畫面預警與伺服器判斷才一致。
   */
  placedQty: number
  /** 已勾完成的擺放合計（顯示用） */
  completedQty: number
  /**
   * 還可排＝max(0, 卡片量 − U − 未完成擺放)，U＝scheduleAllocate.unreflectedCompletedQty（已完成但待排池還沒扣掉的量）。
   * 為什麼不直接用「卡片量 − 已完成量」：D73 部分銷貨時卡片量已扣掉出貨量，而出貨的多半就是已包完的那批；
   * 用 U 才和工作台 cardMeta.remainingQty（assembleBoard → allocateLine）一模一樣，兩頁數字不會對不起來。
   * D103：沒有銷貨時＝max(0, 總量 − 已完成 − 未完成擺放)（U 帶卡上的 manualTotalQty，與 lineSupply 同一個來源）。
   */
  remainingQty: number
}

export interface PoolManualEnded {
  card: PackagingCard
  line: PoolManualLine
}

export interface PoolManualSection {
  /** false＝手動加入表不存在（migration 未套用）或讀取失敗；待排池其他區塊照常顯示 */
  available: boolean
  error: string | null
  /** key＝soLineKey；只含 'mn' 區塊（仍可排）的卡 */
  lines: Record<string, PoolManualLine>
  /** 已全數完成：不在 'mn' 區塊、不計入張數與工時，可移出清理（紀錄的終點，lines.md §6.3） */
  ended: PoolManualEnded[]
  skipped: { soGone: number; backInPool: number; soldOut: number }
}

/** GET /api/packaging/pool 的回應（D102：多了 manual；PoolResponse 本身不改，其他使用者不受影響） */
export type PoolPageResponse =
  | (PoolOk & { manual: PoolManualSection })
  | { success: false; error: string; code?: string }

/** 手動層讀不到時的 section（路由降級、前端遇到舊回應都用它） */
export function unavailableManualSection(error: string): PoolManualSection {
  return { available: false, error, lines: {}, ended: [], skipped: { soGone: 0, backInPool: 0, soldOut: 0 } }
}

/**
 * D102 待排池頁：'mn' 區塊依擺放拆成「仍可排」與「已全數完成」，並算出每一行的已排／已完成／可排量。
 * - 已全數完成＝沒有未完成擺放、至少一筆已完成、而且可排量 ≤ 0（同工作台「剩 0 就不出卡」）→ 拆到 ended，
 *   不算進張數與工時；否則「可立即開包」會一直把早就包完的手動卡算進去。
 * - 已完成量 ≥ 卡片量但還有未完成擺放 → 留在區塊（那些排定卡還沒做，不能當完成）。
 * - block 來自 getManualMergedPool（多個請求共用的快取物件）→ 一律產生新物件，絕不修改輸入。
 * 名額判定（manualRecordEnded，用 inc.qty）不改：那是「佔不佔 300 格」的規則，和這裡的顯示分開。
 */
export function splitManualForPoolPage(input: {
  block: PoolBlock
  meta: Readonly<Record<string, ManualInclusionMeta>>
  placements: readonly Placement[]
  today: YMD
}): { block: PoolBlock; lines: Record<string, PoolManualLine>; ended: PoolManualEnded[] } {
  const byLine = new Map<string, Placement[]>()
  for (const p of input.placements) {
    const arr = byLine.get(p.soLineKey)
    if (arr) arr.push(p)
    else byLine.set(p.soLineKey, [p])
  }
  const keep: PackagingCard[] = []
  const lines: Record<string, PoolManualLine> = {}
  const ended: PoolManualEnded[] = []
  for (const card of input.block.cards) {
    const ps = byLine.get(card.soLineKey) ?? []
    const open = ps.filter((p) => !p.completed)
    const done = ps.filter((p) => !!p.completed)
    const placedQty = r3(open.reduce((s, p) => s + p.qty, 0))
    const completedQty = r3(done.reduce((s, p) => s + p.qty, 0))
    // D103：與 lineSupply 同一個來源（卡上的手動總量），工作台／待排池頁／AI 三處數字才一致
    const u = unreflectedCompletedQty(done, card.qtyCard, card.manualTotalQty)
    const remainingQty = r3(Math.max(0, card.qtyCard - u - placedQty))
    const meta = input.meta[card.soLineKey]
    // meta 只含有出卡的行，理論上一定有；萬一沒有就照常顯示卡、不給管理按鈕（不能憑空組 inclusionId）
    if (!meta) { keep.push(card); continue }
    const line: PoolManualLine = { meta, placedQty, completedQty, remainingQty }
    if (open.length === 0 && done.length > 0 && remainingQty <= EPS) ended.push({ card, line })
    else {
      keep.push(card)
      lines[card.soLineKey] = line
    }
  }
  return { block: manualBlockOf(keep, input.today), lines, ended }
}

/** 正常區塊（不含 'mn'）已有卡的 SO 行 */
export function normalPoolLineKeys(pool: Pick<PoolOk, 'blocks'>): Set<string> {
  const out = new Set<string>()
  for (const b of pool.blocks) if (b.id !== MANUAL_BLOCK_ID) for (const c of b.cards) out.add(c.soLineKey)
  return out
}

/** 把 'mn' 區塊放在待排池最前面（不改原物件：P0 快取裡的 pool 是多個請求共用的） */
export function mergeManualIntoPool(pool: PoolOk, block: PoolBlock): PoolOk {
  return { ...pool, blocks: [block, ...pool.blocks.filter((b) => b.id !== MANUAL_BLOCK_ID)] }
}

const fmtQ = (n: number): string => String(r3(n))
const MOVE_BACK_HINT = '請先到排程工作台把排定卡拖回待排池'

/**
 * D103 改總量的下限（PATCH 寫前檢查、寫後回讀共用；待排池頁 ManualEditDialog 的預警用同樣兩個數字、同樣的判斷順序）：
 * - 總量 < 已完成 → qty_below_completed「已完成 X，總量不能少於 X」
 * - 總量 < 已完成＋未完成擺放 → qty_below_placed（沿用既有代碼；已完成 0 時訊息與 D102 逐字相同）
 * - 總量＝已完成（沒有未完成擺放）→ 允許：剩 0，卡片從待排池消失、進「已全數完成」
 * 已完成＝這一行全部已勾完成擺放（含舊紀錄時期完成的；同 U 公式看的範圍），未完成＝原始 qty、不修剪。
 * concurrent：寫後回讀才發現（排程工作台剛好在排）→ 訊息講清楚「這次沒有修改」。
 */
export function manualQtyFloorError(
  qty: number,
  completedQty: number,
  placedQty: number,
  opts: { concurrent?: boolean } = {},
): { code: 'qty_below_completed' | 'qty_below_placed'; error: string; minQty: number } | null {
  let code: 'qty_below_completed' | 'qty_below_placed'
  let core: string
  let minQty: number
  if (qty + EPS < completedQty) {
    code = 'qty_below_completed'
    minQty = r3(completedQty)
    core = `已完成 ${fmtQ(completedQty)}，總量不能少於 ${fmtQ(completedQty)}（數量是這筆訂單的總量、含已完成）`
  } else if (qty + EPS < completedQty + placedQty) {
    code = 'qty_below_placed'
    minQty = r3(completedQty + placedQty)
    core = completedQty > EPS
      ? `已完成 ${fmtQ(completedQty)}、已排出 ${fmtQ(placedQty)}（未完成），總量不能少於 ${fmtQ(minQty)}`
      : `已排出 ${fmtQ(placedQty)}（未完成），數量不可低於已排量`
  } else {
    return null
  }
  // 已完成的量拖不回待排池 → 只有「低於已排」才給「拖回待排池」的指引
  const hint = code === 'qty_below_placed' ? `；${MOVE_BACK_HINT}` : ''
  const error = opts.concurrent ? `排程工作台剛好在排這個品項，${core}，這次沒有修改${hint}` : `${core}${hint}`
  return { code, error, minQty }
}

/** D12／訂單量：加入時「不可勾選」的判斷（查詢與加入 API 共用） */
export function manualBlockedReason(sl: Pick<RawSoLine, 'mbp_part' | 'description' | 'order_qty_oru'>): string | null {
  if (isNonPhysicalLine(sl.mbp_part, sl.description)) return '費用行（運費、設計費等）不需包裝'
  if (!(Number(sl.order_qty_oru) > 0)) return '訂單量為 0'
  return null
}

/**
 * D66 手動加入紀錄的「終點」（讀取時推導，不寫 DB）：
 * - 'done'：這行已完成擺放合計 ≥ 手動數量、且沒有未完成擺放（待排池 'mn' 卡剩 0 → 已不出卡）
 * - 'so_gone'：ERP 查無此行（結案被同步刪除 → 不出卡）
 * - null：仍在作用中（含 backInPool：正常區塊有卡時紀錄保留，之後可能回來）
 * 用途：MAX_ACTIVE_MANUAL 名額只算作用中的紀錄，已結束的紀錄不再佔位（否則 300 格會被完成的紀錄塞滿、畫面又清不掉）。
 * D103：inc.qty＝總量（含已完成），這裡本來就是總量語意；D103 起工作台／待排池頁／AI 的剩餘量也改成同一個語意，不再互相矛盾。
 */
export function manualRecordEnded(
  inc: Pick<ManualInclusion, 'soLineKey' | 'qty'>,
  placements: readonly Pick<Placement, 'soLineKey' | 'qty' | 'completed'>[],
  soLineExists: boolean,
): 'done' | 'so_gone' | null {
  if (!soLineExists) return 'so_gone'
  let doneQty = 0
  for (const p of placements) {
    if (p.soLineKey !== inc.soLineKey) continue
    if (!p.completed) return null
    doneQty += p.qty
  }
  return doneQty + 1e-9 >= inc.qty ? 'done' : null
}

// ─────────────────────────────────────────────────────────────────────
// D102 寫後回讀（write-then-read-back）：待排池頁的移出／改量不再拿編輯鎖，與工作台（持鎖者）寫擺放可能交錯
// ─────────────────────────────────────────────────────────────────────
// 兩邊原本都是「先讀、後寫」：移出讀到「沒有未完成排定卡」、工作台讀到「手動紀錄還在」，兩個寫入各自成功 →
//   排定卡沒了供給，讀取時被當成「行已不在待排池」略過（卡從畫面消失）。改量同理：已排量超過新數量，剛排的卡被靜默修剪。
// 關法（不需要 migration、也不恢復編輯鎖，照 Snow 的決定）：兩邊都改成「先寫、再讀對方的表」。
//   PostgREST 每個請求各自 commit；read committed 下，兩個「寫→讀」至少有一邊的「讀」看得到另一邊已 commit 的寫入：
//   - 移出／改量那邊看到了 → 撤回自己（manual/remove、manual PATCH 回 409／422）；
//   - 工作台那邊看到了 → 以排程為準，把供給恢復（紀錄恢復有效、數量恢復成排程驗證時的值），記 op_log 說明。
//   兩邊都看到就兩邊都撤回，最後一定是「有未完成排定卡的手動行，一定有有效紀錄、數量不低於已排量」。

/** 排程寫入後要回讀的手動行：這批寫入過（inserts／updates）、只靠手動加入供給（不在正常區塊）、寫入後仍有未完成擺放 */
export interface ManualReconcileCandidate {
  soLineKey: string
  /** 排程驗證時讀到的有效紀錄 */
  inclusionId: number
  validatedQty: number
  /** 寫入後這一行未完成擺放合計（原始 qty，與 PATCH 的 qty_below_placed 同一個算法） */
  openQty: number
}

export function manualReconcileCandidates(input: {
  /** getManualMergedPool 的 meta（排程驗證時的手動供給） */
  meta: Readonly<Record<string, ManualInclusionMeta>>
  /** 正常區塊（不含 'mn'）有卡的行：這些行有正常供給，手動紀錄在不在都不會讓卡消失 */
  normalKeys: ReadonlySet<string>
  written: Iterable<Pick<Placement, 'soLineKey'>>
  /** 寫入後的整行狀態（applyOps 的 next：已讀進觸及行的全部擺放＋這批的修改） */
  next: Iterable<Pick<Placement, 'soLineKey' | 'qty' | 'completed'>>
}): ManualReconcileCandidate[] {
  const keys = new Set<string>()
  for (const p of input.written) if (input.meta[p.soLineKey] && !input.normalKeys.has(p.soLineKey)) keys.add(p.soLineKey)
  if (keys.size === 0) return []
  const open = new Map<string, number>()
  for (const p of input.next) if (keys.has(p.soLineKey) && !p.completed) open.set(p.soLineKey, (open.get(p.soLineKey) ?? 0) + p.qty)
  const out: ManualReconcileCandidate[] = []
  for (const k of [...keys].sort()) {
    const q = open.get(k) ?? 0
    if (q <= EPS) continue
    const m = input.meta[k]
    out.push({ soLineKey: k, inclusionId: m.inclusionId, validatedQty: m.qty, openQty: r3(q) })
  }
  return out
}

/**
 * 回讀到的有效紀錄 → 要恢復什麼：
 * - restore：這行已沒有有效紀錄（排程驗證之後被移出）→ 恢復排程驗證時那筆紀錄
 * - requantify：數量在排程驗證之後被改低、低於寫入後的已排量 → 恢復成排程驗證時的數量（CAS：數量仍是回讀到的值）
 *   D103：手動量是總量（含已完成）→「已排量」＝已完成＋未完成擺放（completedByKey；省略＝0，與 D102 相同）
 * 有效紀錄換了一筆（被移出又重新加入）→ 新紀錄已提供供給，不動（新紀錄的數量是別人剛輸入的事實，不覆寫）。
 */
export function planManualReconcile(
  candidates: readonly ManualReconcileCandidate[],
  active: readonly Pick<ManualInclusion, 'soLineKey' | 'inclusionId' | 'qty'>[],
  /** D103：寫入後各行「已勾完成」擺放合計；省略＝0（D102 舊行為） */
  completedByKey?: ReadonlyMap<string, number>,
): {
  restore: { soLineKey: string; inclusionId: number }[]
  requantify: { soLineKey: string; inclusionId: number; from: number; to: number }[]
} {
  const byKey = new Map(active.map((a) => [a.soLineKey, a]))
  const restore: { soLineKey: string; inclusionId: number }[] = []
  const requantify: { soLineKey: string; inclusionId: number; from: number; to: number }[] = []
  for (const c of candidates) {
    const a = byKey.get(c.soLineKey)
    if (!a) { restore.push({ soLineKey: c.soLineKey, inclusionId: c.inclusionId }); continue }
    const need = r3(c.openQty + (completedByKey?.get(c.soLineKey) ?? 0)) // D103：總量要蓋住已完成＋未完成
    if (a.inclusionId === c.inclusionId && a.qty + EPS < need && a.qty + EPS < c.validatedQty) {
      requantify.push({ soLineKey: c.soLineKey, inclusionId: a.inclusionId, from: a.qty, to: c.validatedQty })
    }
  }
  return { restore, requantify }
}
