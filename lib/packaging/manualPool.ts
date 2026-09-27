// 包裝專區 P1 分線輪 — D66 手動加入的待排池區塊 'mn'（純函式，lines.md §六.4～§六.6）
//
// 手動加入的是「供給」（待排池的卡），不是「排定」：做成待排池卡後，排定、拆卡、預排、完成、快照全部沿用既有路徑，
// 不必寫特例（lines.md §1.6）。消失條件（勾完成扣到 0、ERP 結案、手動移出）全部是讀取時推導，GET 不寫。
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import { MANUAL_BLOCK_ID, type ManualInclusion, type ManualInclusionMeta, type ManualRouteType, type Placement, type YMD } from './scheduleTypes'
import { POOL_BLOCK_META, type DangerFlag, type PackagingCard, type PoolBlock, type PoolResponse, type SourceKind } from './types'
import type { RawSoLine, WorkEstimator } from './classify'
import { isNonPhysicalLine, nameSaysSample, normDate } from './classify'
import { workdaysBetween } from './workdays'

type PoolOk = Extract<PoolResponse, { success: true }>

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
  }
}

/**
 * D66 手動區塊組裝（lines.md §六.4～§六.6）：
 * - 該行已在正常區塊（含不可排的 3／5c）→ 不出卡（backInPool，以正常區塊的供給為準，避免同一批貨算兩次；紀錄保留）
 * - ERP 查無此行（erp_so_lines 結案會被同步刪除）→ 不出卡（soGone；ERP 重開時自動回來）
 * - 費用行／訂單量 0 仍出卡（加入時已擋；歷史資料不在讀取時再判）
 * meta 只含「有出卡」的行（BoardCard.manual／PoolCardMeta.manual 用）。
 */
export function buildManualBlock(input: {
  inclusions: readonly ManualInclusion[]
  soLines: readonly RawSoLine[]
  normalLineKeys: ReadonlySet<string>
  estimate: WorkEstimator
  today: YMD
}): {
  block: PoolBlock
  meta: Record<string, ManualInclusionMeta>
  backInPoolKeys: Set<string>
  skipped: { soGone: number; backInPool: number }
} {
  const bySoLine = new Map<string, RawSoLine>()
  for (const sl of input.soLines) {
    const line = soLineNoStr(sl.line_no)
    if (line) bySoLine.set(`${sl.project_id.trim().toUpperCase()}-${line}`, sl)
  }
  const cards: PackagingCard[] = []
  const meta: Record<string, ManualInclusionMeta> = {}
  const backInPoolKeys = new Set<string>()
  const skipped = { soGone: 0, backInPool: 0 }
  const sorted = [...input.inclusions].sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.inclusionId - b.inclusionId))
  for (const inc of sorted) {
    if (inc.removedAt) continue
    if (input.normalLineKeys.has(inc.soLineKey)) { skipped.backInPool++; backInPoolKeys.add(inc.soLineKey); continue }
    const sl = bySoLine.get(`${inc.so.trim().toUpperCase()}-${inc.lineNo}`) ?? bySoLine.get(inc.soLineKey.toUpperCase())
    if (!sl) { skipped.soGone++; continue }
    cards.push(manualCardOf(inc, sl, input.estimate, input.today))
    meta[inc.soLineKey] = manualMetaOf(inc)
  }
  const m = POOL_BLOCK_META[MANUAL_BLOCK_ID]
  const block: PoolBlock = {
    id: MANUAL_BLOCK_ID,
    title: m.title,
    hint: m.hint,
    cards,
    cardCount: cards.length,
    totalMinutes: round1(cards.reduce((s, c) => s + (c.work.minutes ?? 0), 0)),
    unknownMinutesCards: cards.filter((c) => c.work.minutes == null).length,
    overdueCount: cards.filter((c) => !!c.dueDate && c.dueDate < input.today).length,
    sampleCount: cards.filter((c) => c.sample.isSample).length,
  }
  return { block, meta, backInPoolKeys, skipped }
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
