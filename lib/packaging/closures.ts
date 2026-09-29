// 包裝專區 — D104 結案（純函式；lines.md 第十四章）
//
// 主管在排程工作台對「SO-項次」按結案 → packaging_closures 記一筆（未復原） → 該行永久不再進待排池（含 D66 手動加入）。
// 本檔只有純函式：把「未復原的結案行集合」套到待排池、把該行從模擬區 jsonb 拿掉、列 ↔ API 形狀、備註驗證。
// I/O（讀寫 packaging_closures、刪排定卡、CAS 模擬區）在 closuresDb.ts；路由在 app/api/packaging/closures/route.ts。
//
// 為什麼在「讀取時」套用、而不是在 classifyPool（pool.ts 那一層）排除：
//   待排池有 120 秒讀取快取、寫入驗證吃 10 分鐘的舊資料（poolCache.ts）。放在 classify 裡，結案後主管在工作台
//   最多要等 2 分鐘卡才消失、10 分鐘內還能把已結案的行排進去。改在 manualCache.getManualMergedPool 併入手動區塊時
//   套用（那一層每次讀都重新查結案表、只有一個小查詢），結案後下一次讀取就消失、寫入驗證也立刻擋下
//   （該行不在待排池 → applyOps 回「行已不在待排池」）。代價：同一 SO 行拆卡的 i/n 標示在 classify 已算好，
//   結案整行一起消失所以不受影響。
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum。

import type { Closure, ClosureRow, YMD } from './scheduleTypes'
import { CLOSURE_NOTE_MAX } from './scheduleTypes'
import type { PackagingCard, PoolBlock, PoolBlockId, PoolResponse } from './types'
import { POOL_BLOCK_META } from './types'

type PoolOk = Extract<PoolResponse, { success: true }>

const round1 = (x: number): number => Math.round(x * 10) / 10
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
// 用 hasOwn 而不是 in：'constructor'、'toString' 這類原型上的鍵不是區塊（D110 起 block 會由前端帶入，不能被矇過）
const isBlockId = (v: unknown): v is PoolBlockId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(POOL_BLOCK_META, v)

/** DB 列 → API 形狀（email 不回、只回名字；數字欄 PostgREST 可能回字串） */
export function rowToClosure(r: ClosureRow): Closure {
  return {
    id: Number(r.id),
    soLineKey: r.so_line_key,
    so: r.so,
    soLine: r.so_line,
    itemCode: r.item_code ?? null,
    itemName: r.item_name ?? null,
    customer: r.customer ?? null,
    qtyAtClose: num(r.qty_at_close),
    dueDate: r.due_date ? String(r.due_date).slice(0, 10) : null,
    blockAtClose: isBlockId(r.block_at_close) ? r.block_at_close : null,
    soldQtyAtClose: r.sold_qty_at_close == null ? null : num(r.sold_qty_at_close),
    note: r.note ?? null,
    closedByName: r.closed_by_name ?? null,
    closedAt: String(r.closed_at),
    restoredAt: r.restored_at ? String(r.restored_at) : null,
    restoredByName: r.restored_by_name ?? null,
  }
}

/**
 * 備註驗證：undefined／null／空白 → null；非字串或超過上限 → 回錯誤訊息。
 * 回 { ok: true, note } 或 { ok: false, message }。
 */
export function parseClosureNote(v: unknown): { ok: true; note: string | null } | { ok: false; message: string } {
  if (v == null) return { ok: true, note: null }
  if (typeof v !== 'string') return { ok: false, message: '備註格式錯誤' }
  const t = v.trim()
  if (t.length > CLOSURE_NOTE_MAX) return { ok: false, message: `備註最多 ${CLOSURE_NOTE_MAX} 字` }
  return { ok: true, note: t || null }
}

// ─────────────────────────────────────────────────────────────────────
// D110 結案加速：快照不再從待排池取（冷實例重組 9 秒），改由「單張 SO 的 ERP 鏡像＋前端提示」組
// ─────────────────────────────────────────────────────────────────────
// 前端提示（hint）只收兩個欄位：主管按下結案時卡片所在的區塊、整行在待排池的數量（各卡原始量合計＝qty_at_close 一直以來的定義；前端從工作台資料的 pool.cardMeta 加總）。
// 其餘快照欄位（客戶、品名、品號、交期、已銷貨量）一律由伺服器自己查，不信任前端。

/** 前端提示數量的上限（packaging_closures.qty_at_close 是 numeric(14,3)；這裡取遠低於欄位上限的合理值） */
export const CLOSURE_HINT_QTY_MAX = 9_999_999

export interface ClosureHint {
  block: PoolBlockId | null
  qty: number | null
}

/**
 * 解析 ClosureRequest.hint。**逐欄位容錯、不整包拒絕**：不合法的欄位當作沒給（退回伺服器自己查的值）。
 * 為什麼不回 400：舊版前端不帶 hint；「已由待排池扣完」的排定卡數量是 0（不是正數）——這些都要能照常結案。
 * qty：有限數、> 0、≤ CLOSURE_HINT_QTY_MAX，四捨五入到 3 位小數（同欄位精度）。
 */
export function parseClosureHint(v: unknown): ClosureHint {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { block: null, qty: null }
  const o = v as { block?: unknown; qty?: unknown }
  const block = isBlockId(o.block) ? o.block : null
  let qty: number | null = null
  if (typeof o.qty === 'number' && Number.isFinite(o.qty) && o.qty > 0 && o.qty <= CLOSURE_HINT_QTY_MAX) {
    const r = Math.round(o.qty * 1000) / 1000
    if (r > 0) qty = r
  }
  return { block, qty }
}

/** 'YYYY/MM/DD'（erp_so_lines.duedate）、'YYYY-MM-DD'、'YYYYMMDD' → 'YYYY-MM-DD'；不合法（含 2/30 這種）回 null */
export function closureDueDate(v: unknown): YMD | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return null
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/) ?? s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/** 結案快照（寫進 packaging_closures 的欄位；closuresDb.insertClosure 的輸入） */
export interface ClosureSnapshot {
  soLineKey: string
  so: string
  soLine: string
  itemCode: string | null
  itemName: string | null
  customer: string | null
  qtyAtClose: number
  dueDate: YMD | null
  blockAtClose: string | null
  soldQtyAtClose: number | null
  note: string | null
}

/** erp_so_lines 取用的欄位（classify.RawSoLine 的子集；這裡不 import classify——它用 '@/…' 別名且很大） */
export interface ClosureSoLine {
  mbp_part: string | null
  description: string | null
  partner_name: string | null
  order_qty_oru: number | string | null
  duedate: string | null
}

const trimOrNull = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}
const r3 = (x: number): number => Math.round(x * 1000) / 1000

/**
 * 組結案快照。回 null＝這一行哪裡都查不到（路由回 404 not_found）。
 * 「查得到」的依序退路（任一成立即可）：
 *   ① erp_so_lines 有這一行（SO＋項次）→ 客戶／品名／品號／交期取它，數量預設＝ERP 訂單量
 *   ② D66 有效的手動加入紀錄 → 數量預設＝手動總量、區塊預設 'mn'
 *   ③ 排程系統認得這一行（正式區有它的排定卡、或某人的模擬區有它的模擬卡）→ 只有單號與前端提示
 * 數量：hint.qty（整行在待排池的數量，前端帶入）優先，其次上面的預設，都沒有＝0。
 * 區塊：hint.block 優先；沒有時手動行＝'mn'，其餘 null。
 * sold：D73 鏡像分配到本行的已銷貨量（鏡像未啟用／本行沒有銷貨＝null）。
 */
export function buildClosureSnapshot(input: {
  soLineKey: string
  so: string
  soLine: string
  erpLine: ClosureSoLine | null
  manualQty: number | null
  knownToSchedule: boolean
  soldQty: number | null
  hint: ClosureHint
  note: string | null
}): ClosureSnapshot | null {
  const { erpLine: sl, manualQty, hint } = input
  if (!sl && manualQty == null && !input.knownToSchedule) return null
  const fallbackQty = sl ? Math.max(0, num(sl.order_qty_oru)) : Math.max(0, manualQty ?? 0)
  return {
    soLineKey: input.soLineKey,
    so: input.so,
    soLine: input.soLine,
    itemCode: trimOrNull(sl?.mbp_part),
    itemName: trimOrNull(sl?.description),
    customer: trimOrNull(sl?.partner_name),
    qtyAtClose: r3(hint.qty ?? fallbackQty),
    dueDate: sl ? closureDueDate(sl.duedate) : null,
    blockAtClose: hint.block ?? (!sl && manualQty != null ? 'mn' : null),
    soldQtyAtClose: input.soldQty != null && Number.isFinite(input.soldQty) && input.soldQty >= 0 ? r3(input.soldQty) : null,
    note: input.note,
  }
}

/** 未復原的結案行集合（一律大寫；輸入可能是列或 key 字串） */
export function closedKeySet(items: readonly (string | { soLineKey: string; restoredAt?: string | null })[]): Set<string> {
  const out = new Set<string>()
  for (const it of items) {
    if (typeof it === 'string') { const k = it.trim().toUpperCase(); if (k) out.add(k) }
    else if (!it.restoredAt) { const k = it.soLineKey.trim().toUpperCase(); if (k) out.add(k) }
  }
  return out
}

/** 區塊彙總重算（與 classify.ts 區塊合計、manualPool.manualBlockOf 同一套規則） */
export function blockWithCards(block: PoolBlock, cards: PackagingCard[], today: YMD): PoolBlock {
  return {
    ...block,
    cards,
    cardCount: cards.length,
    totalMinutes: round1(cards.reduce((a, c) => a + (c.work.minutes ?? 0), 0)),
    unknownMinutesCards: cards.filter((c) => c.work.minutes == null).length,
    overdueCount: cards.filter((c) => !!c.dueDate && c.dueDate < today).length,
    sampleCount: cards.filter((c) => c.sample.isSample).length,
  }
}

/**
 * 把「未復原的結案行」套到待排池：這些 SO 行的卡（任何區塊，含 'mn'）一律不出，excluded.closed＝被拿掉的「SO 行」數。
 * - closedKeys 為空、或池裡沒有任何一張命中 → 回傳「同一個」pool 物件（不是複本）：
 *   manualCache 的 WeakMap 記憶與 scheduleBoard.poolDigest 都以 blocks 陣列參考為鍵，沒變就不該換新物件。
 * - 有命中 → 全新物件（blocks 陣列、命中的區塊、excluded 都是新的；未命中的區塊沿用原物件）。絕不修改輸入。
 * 回傳 removedKeys：實際被拿掉的行（op_log／統計用）。
 */
export function applyClosuresToPool(pool: PoolOk, closedKeys: ReadonlySet<string>): { pool: PoolOk; removedKeys: Set<string> } {
  const removedKeys = new Set<string>()
  if (closedKeys.size === 0) return { pool, removedKeys }
  const hit = (c: PackagingCard) => closedKeys.has(c.soLineKey.toUpperCase())
  let changed = false
  const blocks = pool.blocks.map((b) => {
    if (!b.cards.some(hit)) return b
    changed = true
    const keep: PackagingCard[] = []
    for (const c of b.cards) {
      if (hit(c)) removedKeys.add(c.soLineKey.toUpperCase())
      else keep.push(c)
    }
    return blockWithCards(b, keep, pool.today)
  })
  if (!changed) return { pool, removedKeys }
  return {
    pool: { ...pool, blocks, excluded: { ...pool.excluded, closed: removedKeys.size } },
    removedKeys,
  }
}

/** 結案表未建（migration 未套用）時放在頁尾註腳最前面的說明 */
export const CLOSURES_MISSING_NOTE = '結案功能尚未啟用（sql/20260928d_packaging_closures.sql 尚未套用）：待排池暫不排除主管結案的品項。'

// ─────────────────────────────────────────────────────────────────────
// 模擬區（packaging_sim_sessions）：從 jsonb 拿掉該行的模擬卡
// ─────────────────────────────────────────────────────────────────────
// 模擬列的形狀＝lib/packaging/ai/types.ts SimPlacement（PlacementSnapshotRow ＋ 模擬欄），這裡只認 id／soLineKey 兩個鍵，
// 其他鍵原樣保留（不 import ai/*，那些檔另一位代理在改）。locks.placementIds 裡被拿掉的列 id 一併清掉
// （鎖定一張已不存在的卡沒有意義，留著會讓 normalizeLocks 之類的檢查對不上）。

export interface SimStripResult<P, L> {
  placements: P[]
  locks: L
  removed: number
}

export function stripSimPlacementsForLine<P extends { id?: unknown; soLineKey?: unknown }, L extends { placementIds?: unknown }>(
  placements: readonly P[],
  locks: L,
  soLineKey: string,
): SimStripResult<P, L> {
  const key = soLineKey.trim().toUpperCase()
  const removedIds = new Set<string>()
  const keep: P[] = []
  for (const p of placements) {
    const k = typeof p.soLineKey === 'string' ? p.soLineKey.trim().toUpperCase() : ''
    if (k === key) { if (typeof p.id === 'string') removedIds.add(p.id); continue }
    keep.push(p)
  }
  const removed = placements.length - keep.length
  if (removed === 0) return { placements: [...placements], locks, removed: 0 }
  const ids = Array.isArray(locks.placementIds) ? (locks.placementIds as unknown[]) : null
  const nextLocks = ids && ids.some((id) => typeof id === 'string' && removedIds.has(id))
    ? { ...locks, placementIds: ids.filter((id) => !(typeof id === 'string' && removedIds.has(id))) }
    : locks
  return { placements: keep, locks: nextLocks, removed }
}

// ─────────────────────────────────────────────────────────────────────
// 台北日 ↔ UTC 區間（GET 清單的 from／to；D105 通知信「當天新結案」延後實作時也用同一套）
// ─────────────────────────────────────────────────────────────────────

const TAIPEI_OFFSET_MS = 8 * 3600_000
export const isYmd = (s: unknown): s is YMD => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

/** 台北日 'YYYY-MM-DD' 的 UTC 起訖（[start, end)）ISO 字串 */
export function taipeiDayRange(fromYmd: YMD, toYmd: YMD = fromYmd): { startIso: string; endIso: string } {
  const start = Date.parse(`${fromYmd}T00:00:00Z`) - TAIPEI_OFFSET_MS
  const end = Date.parse(`${toYmd}T00:00:00Z`) - TAIPEI_OFFSET_MS + 86_400_000
  return { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() }
}

/** ISO 時間 → 台北日 'YYYY-MM-DD' */
export function taipeiDayOf(iso: string): YMD {
  return new Date(Date.parse(iso) + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
}
