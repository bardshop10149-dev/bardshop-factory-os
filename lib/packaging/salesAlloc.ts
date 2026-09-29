// 包裝專區 — D73 待排池排除已銷貨：ARGO 銷貨彙總、分配到 SO 行、套用到待排池卡（純函式）
//
// 資料流：
//   ARGO IV_INVENTORYIODETAIL（IO_TYPE='O'、IO_ACTION='SELL'）逐筆明細
//     ─ aggregateSalesDetail ─→ 依「來源 SO＋品號」彙總（erp_so_sales 一列）
//     ─ planMirrorWrite ─→ 整張 SO 重算覆蓋：upsert 新值、刪掉 ARGO 已不存在的（SO, 品號）（作廢銷貨單會連明細刪除）
//   待排池讀取時：
//     erp_so_sales ＋ erp_so_lines ─ allocateSoldToLines ─→ 每個 SO 行的「已銷貨量／未出貨量」
//       （同 SO 同品號多行 → 依項次由小到大扣；超出全部訂單量的部分算在最後一行）
//     待排池卡 ─ applySoldToCards ─→ 未出貨量 ≤ 0 整行不出卡（excluded.soldOut）；部分銷貨 → 卡片數量以未出貨量為上限、
//       標「部分已出貨 X/Y」
//
// 為什麼部分銷貨是「封頂」（min(卡片合計, 未出貨量)）而不是「卡片數量 − 已銷貨」：
//   待排池的卡片數量可能已經反映過同一批貨（塔台已報包裝完工的量會先從卡片扣掉；採購只開了部分數量）。
//   用減的會重複扣；用「未出貨量當上限」只有在卡片比剩下要出的還多時才扣，不會重複。
// 卡片合計 > 訂單量（包裝數量與訂單單位不同，例：訂單 30 張、包裝 2100 件）時改用比例：卡片合計 × 未出貨量 ÷ 訂單量。
//
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import type { DangerFlag, PackagingCard, PoolBlockId, WorkEstimate } from './types'

const EPS = 1e-9
const r3 = (x: number): number => Math.round(x * 1000) / 1000

/** erp_so_sales 一列（camelCase） */
export interface SoSalesRow {
  so: string
  itemCode: string
  soldQty: number
  lastSaleDate: string | null
  slipCount: number
}

/** ARGO 銷貨明細一筆（salesSync 從 S_QUERY 結果轉來） */
export interface SalesDetailRow {
  so: string | null
  itemCode: string | null
  qty: number | null
  priceQty: number | null
  ioDate: string | null
  slipNo: string | null
}

/** 分配到一個 SO 行的結果 */
export interface LineSold {
  soLineKey: string
  so: string
  lineNo: string
  itemCode: string
  /** ERP 訂單量（order_qty_oru） */
  orderQty: number
  /** 分配到這一行的已銷貨量（最後一行可能超過訂單量＝超額銷貨） */
  soldQty: number
  /** 未出貨量＝訂單量 − 已銷貨量（≤ 0＝已全數銷貨） */
  unshippedQty: number
  lastSaleDate: string | null
  slipCount: number
}

/** allocateSoldToLines 需要的 erp_so_lines 欄位（RawSoLine 的子集） */
export interface SoLineLike {
  project_id: string
  line_no: string | number | null
  mbp_part: string | null
  order_qty_oru: number | string | null
}

export const normSo = (v: unknown): string => String(v ?? '').trim().toUpperCase()
export const normItem = (v: unknown): string => String(v ?? '').trim()
const itemKey = (v: unknown): string => normItem(v).toUpperCase()

const num = (v: unknown): number => {
  if (v == null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 行號統一成字串（'3.0' → '3'；同 classify.ts lineStr） */
export function lineNoStr(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  return /^\d+(\.0+)?$/.test(s) ? String(parseInt(s, 10)) : s
}

/** ARGO 日期 '2026/09/20 00:00:00'、'2026-09-20…' → 'YYYY-MM-DD'；不合法 null */
export function argoDate(v: unknown): string | null {
  const m = String(v ?? '').trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/**
 * ARGO 銷貨明細 → 依（來源 SO, 品號）彙總。
 * 數量：QTY，沒有（空／0）時用 PRICE_QTY（同 argo-tool sales_data.fetch_shipment_lines 的 `_num(QTY) or _num(PRICE_QTY)`）。
 * 最後銷貨日＝最大 IO_DATE；銷貨單數＝不重複 SLIP_NO。沒有來源 SO 或品號的明細略過；合計 ≤ 0 的不存。
 */
export function aggregateSalesDetail(rows: readonly SalesDetailRow[]): SoSalesRow[] {
  const acc = new Map<string, { so: string; itemCode: string; qty: number; last: string | null; slips: Set<string> }>()
  for (const r of rows) {
    const so = normSo(r.so)
    const item = normItem(r.itemCode)
    if (!so || !item) continue
    const k = `${so}\u0000${item}`
    let a = acc.get(k)
    if (!a) { a = { so, itemCode: item, qty: 0, last: null, slips: new Set() }; acc.set(k, a) }
    a.qty += num(r.qty) || num(r.priceQty)
    const d = argoDate(r.ioDate)
    if (d && (a.last == null || d > a.last)) a.last = d
    const slip = String(r.slipNo ?? '').trim()
    if (slip) a.slips.add(slip)
  }
  const out: SoSalesRow[] = []
  for (const a of acc.values()) {
    const q = r3(a.qty)
    if (q <= EPS) continue
    out.push({ so: a.so, itemCode: a.itemCode, soldQty: q, lastSaleDate: a.last, slipCount: a.slips.size })
  }
  return out.sort((x, y) => (x.so < y.so ? -1 : x.so > y.so ? 1 : x.itemCode < y.itemCode ? -1 : x.itemCode > y.itemCode ? 1 : 0))
}

/**
 * 整張 SO 重算覆蓋的寫入計畫（一批 SO）：
 * - upserts：這批 SO 在 ARGO 的全部彙總列（每次都寫，synced_at 才會更新）
 * - deletePairs：鏡像裡有、ARGO 已沒有的（SO, 品號）→ 刪（作廢銷貨單、改品號）
 * - clearSos：這張 SO 在 ARGO 已沒有任何銷貨、鏡像還有列 → 整張刪
 * 只處理 batchSos 內的 SO（fresh 裡的其他 SO 忽略，避免誤寫別批）。
 */
export function planMirrorWrite(
  batchSos: readonly string[],
  existing: readonly { so: string; itemCode: string }[],
  fresh: readonly SoSalesRow[],
): { upserts: SoSalesRow[]; deletePairs: { so: string; itemCodes: string[] }[]; clearSos: string[] } {
  const batch = new Set(batchSos.map(normSo))
  const upserts = fresh.filter((r) => batch.has(normSo(r.so)))
  const freshItems = new Map<string, Set<string>>()
  for (const r of upserts) {
    const so = normSo(r.so)
    let s = freshItems.get(so)
    if (!s) { s = new Set(); freshItems.set(so, s) }
    s.add(r.itemCode)
  }
  const staleBySo = new Map<string, string[]>()
  for (const e of existing) {
    const so = normSo(e.so)
    if (!batch.has(so)) continue
    if (freshItems.get(so)?.has(e.itemCode)) continue
    let arr = staleBySo.get(so)
    if (!arr) { arr = []; staleBySo.set(so, arr) }
    if (!arr.includes(e.itemCode)) arr.push(e.itemCode)
  }
  const deletePairs: { so: string; itemCodes: string[] }[] = []
  const clearSos: string[] = []
  for (const [so, items] of staleBySo) {
    if (!freshItems.has(so)) clearSos.push(so)
    else deletePairs.push({ so, itemCodes: items.sort() })
  }
  return { upserts, deletePairs, clearSos: clearSos.sort() }
}

/** 項次排序：數字依數值、其他依字串，數字在前 */
function compareLineNo(a: string, b: string): number {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b)
  if (na && nb) return Number(a) - Number(b)
  if (na) return -1
  if (nb) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 已銷貨量 → 各 SO 行（D73）：同一張 SO、同品號的行依項次由小到大扣，每行最多扣到自己的訂單量；
 * 扣完所有行還有剩（超額銷貨）→ 全算在最後一行（未出貨量 < 0＝全數銷貨）。
 * 訂單量 ≤ 0 的行不分配（本來就不進待排池）。對不到任何行的銷貨（SO 上沒有這個品號、或 SO 已結案）回在 unmatched。
 */
export function allocateSoldToLines(
  lines: readonly SoLineLike[],
  sales: readonly SoSalesRow[],
): { byLine: Map<string, LineSold>; unmatched: SoSalesRow[] } {
  const groups = new Map<string, { so: string; line: string; item: string; order: number }[]>()
  for (const l of lines) {
    const so = normSo(l.project_id)
    const line = lineNoStr(l.line_no)
    const ik = itemKey(l.mbp_part)
    if (!so || !line || !ik) continue
    const order = num(l.order_qty_oru)
    if (order <= EPS) continue
    const gk = `${so}\u0000${ik}`
    let arr = groups.get(gk)
    if (!arr) { arr = []; groups.set(gk, arr) }
    if (!arr.some((x) => x.line === line)) arr.push({ so, line, item: normItem(l.mbp_part), order })
  }
  for (const arr of groups.values()) arr.sort((a, b) => compareLineNo(a.line, b.line))

  // 同一組（SO＋品號，品號不分大小寫）的銷貨先合計，再一次分配（避免兩列各自從第一行重扣）
  const soldByGroup = new Map<string, { qty: number; last: string | null; slips: number; rows: SoSalesRow[] }>()
  for (const s of sales) {
    if (!(s.soldQty > EPS)) continue
    const gk = `${normSo(s.so)}\u0000${itemKey(s.itemCode)}`
    const g = soldByGroup.get(gk) ?? { qty: 0, last: null, slips: 0, rows: [] }
    g.qty = r3(g.qty + s.soldQty)
    if (s.lastSaleDate && (g.last == null || s.lastSaleDate > g.last)) g.last = s.lastSaleDate
    g.slips += s.slipCount
    g.rows.push(s)
    soldByGroup.set(gk, g)
  }

  const byLine = new Map<string, LineSold>()
  const unmatched: SoSalesRow[] = []
  for (const [gk, g] of soldByGroup) {
    const arr = groups.get(gk)
    if (!arr || arr.length === 0) { unmatched.push(...g.rows); continue }
    let left = g.qty
    arr.forEach((l, i) => {
      const last = i === arr.length - 1
      const take = last ? left : Math.min(l.order, left)
      if (take <= EPS) return
      left = r3(left - take)
      const key = `${l.so}-${l.line}`
      byLine.set(key, {
        soLineKey: key, so: l.so, lineNo: l.line, itemCode: l.item,
        orderQty: l.order, soldQty: r3(take), unshippedQty: r3(l.order - take),
        lastSaleDate: g.last, slipCount: g.slips,
      })
    })
  }
  return { byLine, unmatched }
}

const fmtQty = (n: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(n)

/** 「部分已出貨 X/Y」旗標（warn） */
export function partialSoldFlag(l: Pick<LineSold, 'soldQty' | 'orderQty'>): DangerFlag {
  const sold = Math.min(l.soldQty, l.orderQty)
  return { code: 'partial_sold', level: 'warn', label: `部分已出貨 ${fmtQty(sold)}/${fmtQty(l.orderQty)}（ARGO 銷貨，待排池只留未出貨量）` }
}

/** 部分銷貨時先扣可包量（出貨的一定是已就緒的貨），同為可包時依這個區塊順序 */
const READY_TAKE_ORDER: readonly PoolBlockId[] = ['2', '5b', '4', '4x', 'mn', '1b', '1', '5a', 'ns', '3', '5c']
const blockRank = (b: PoolBlockId): number => {
  const i = READY_TAKE_ORDER.indexOf(b)
  return i < 0 ? 99 : i
}

/**
 * 待排池卡套用已銷貨（D73；classifyPool 與 D66 手動區塊共用）：
 * - 該行未出貨量 ≤ 0 → 整行不出卡（soldOutLines＋1、soldOutCards＋張數）
 * - 部分銷貨 → 該行卡片合計以「上限」封頂（見檔頭），超出的量先從可包量扣（區塊 2／5b／4…），
 *   再扣未就緒量（預估可包日最晚／未知的先扣）；扣到 0 的卡不出；該行剩下的卡都加「部分已出貨」旗標。
 *   數量有變的卡用 reestimate 重算工時（同 P0 出卡時的估法）。
 * 沒有銷貨紀錄的行原樣回傳（同一個物件）；有變動的卡一律複製，不改傳入的物件。
 */
export function applySoldToCards(
  cards: readonly PackagingCard[],
  byLine: ReadonlyMap<string, LineSold>,
  reestimate: (card: PackagingCard, qty: number) => WorkEstimate,
): { cards: PackagingCard[]; soldOutLines: number; soldOutCards: number; partialLines: number; cappedLines: number } {
  const groups = new Map<string, PackagingCard[]>()
  for (const c of cards) {
    let arr = groups.get(c.soLineKey)
    if (!arr) { arr = []; groups.set(c.soLineKey, arr) }
    arr.push(c)
  }
  const replaced = new Map<PackagingCard, PackagingCard | null>()
  let soldOutLines = 0, soldOutCards = 0, partialLines = 0, cappedLines = 0

  for (const [key, list] of groups) {
    const sold = byLine.get(key)
    if (!sold || !(sold.soldQty > EPS)) continue
    if (sold.unshippedQty <= EPS) {
      soldOutLines++
      soldOutCards += list.length
      for (const c of list) replaced.set(c, null)
      continue
    }
    partialLines++
    const total = r3(list.reduce((s, c) => s + Math.max(0, c.qtyCard), 0))
    const cap = total <= sold.orderQty + EPS
      ? Math.min(total, sold.unshippedQty)
      : r3((total * sold.unshippedQty) / sold.orderQty)
    let excess = r3(total - cap)
    // 每張卡的可包／未就緒量（可變副本）
    const st = list.map((c) => {
      const qty = Math.max(0, c.qtyCard)
      const ready = Math.min(qty, Math.max(0, c.qtyReady))
      return { c, ready, pending: r3(qty - ready) }
    })
    if (excess > EPS) {
      cappedLines++
      const byReady = [...st].sort((a, b) => blockRank(a.c.block) - blockRank(b.c.block) || (a.c.cardId < b.c.cardId ? -1 : 1))
      for (const x of byReady) {
        if (excess <= EPS) break
        const t = Math.min(x.ready, excess)
        x.ready = r3(x.ready - t)
        excess = r3(excess - t)
      }
      // 未就緒量：預估可包日最晚（未知＝最晚）的先扣——已經出貨的是別的貨，最晚才到的最用不到
      const byPendingLate = [...st].sort((a, b) => {
        const da = a.c.estReadyDate, db = b.c.estReadyDate
        if (da !== db) {
          if (da == null) return -1
          if (db == null) return 1
          return da > db ? -1 : 1
        }
        return a.c.cardId < b.c.cardId ? -1 : 1
      })
      for (const x of byPendingLate) {
        if (excess <= EPS) break
        const t = Math.min(x.pending, excess)
        x.pending = r3(x.pending - t)
        excess = r3(excess - t)
      }
    }
    const flag = partialSoldFlag(sold)
    for (const x of st) {
      const qty = r3(x.ready + x.pending)
      if (qty <= EPS) { replaced.set(x.c, null); continue }
      const changed = Math.abs(qty - x.c.qtyCard) > EPS
      const flags = [...x.c.flags.filter((f) => f.code !== 'partial_sold'), flag]
      replaced.set(x.c, changed
        ? { ...x.c, qtyCard: qty, qtyReady: r3(Math.min(qty, x.ready)), work: reestimate(x.c, qty), flags }
        : { ...x.c, flags })
    }
  }

  const out: PackagingCard[] = []
  for (const c of cards) {
    if (!replaced.has(c)) { out.push(c); continue }
    const r = replaced.get(c)
    if (r) out.push(r)
  }
  return { cards: out, soldOutLines, soldOutCards, partialLines, cappedLines }
}
