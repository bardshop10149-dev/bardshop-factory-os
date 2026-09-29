// 包裝專區 — D111 回廠卡片顯示入庫日期（純函式：入庫明細彙總、鏡像寫入計畫、套用到待排池卡、卡片顯示文字）
//
// 資料流：
//   ARGO IV_INVENTORYIODETAIL（IO_TYPE='I'、IO_ACTION='BUY'）逐筆採購入庫明細
//     ─ aggregateReceiptDetail ─→ 依「採購單號＋採購行號＋入庫日」彙總（erp_po_receipts 一列；同一天多張入庫單＝數量加總）
//     ─ planReceiptMirrorWrite ─→ 整張採購單重算覆蓋：upsert 新值、刪掉 ARGO 已不存在的（行, 日）
//                                  （作廢的入庫單在 ARGO 會整筆消失，增量累加會永遠多算）
//   待排池讀取時：
//     erp_po_receipts ─ indexReceipts ─→ (採購單號|行號) → 批次（由舊到新）
//     待排池卡 ─ applyReceiptsToCards ─→ 依卡片 sources 的 (docNo, lineNo) 合併所有批次（同日加總），
//       補上 receipts／firstReceiptDate／daysSinceReceipt／receiptPoQty
//   畫面：receiptFace（簡化卡片上的一行）、receiptDetail（卡片詳情／滑過提示的完整批次）
//
// 為什麼「已放 N 天」從最早一批起算：主管要看的是「這批貨最久的已經在廠內躺多久」（先進先出），
//   用最後一批會把放很久的貨蓋掉。
// 為什麼鍵是「採購行」不是「SO＋品號」：同一個 SO 品項行可能拆成多張採購單／多個採購行分批回廠，
//   卡片的 sources 本來就記了 (採購單號, 行號)，用它對最精準（ARGO 入庫明細的 PJD_LINE_NO＝採購行號）。
//
// 不 import supabase、不讀時鐘（today 由呼叫端傳入）；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import type { PackagingCard, PoolBlockId } from './types'
import { argoDate, lineNoStr } from './salesAlloc'

// ─────────────────────────────────────────────────────────────────────
// 可調整的門檻（D111；要改只改這裡）
// ─────────────────────────────────────────────────────────────────────

/** 已放滿這麼多日曆天 → 卡片上的「已放 N 天」變橘色（可調） */
export const RECEIPT_AGE_WARN_DAYS = 14
/** 已放滿這麼多日曆天 → 卡片上的「已放 N 天」變紅色（可調） */
export const RECEIPT_AGE_DANGER_DAYS = 30
/** 簡化卡片上最多列幾批，超過顯示「…共 N 批」（可調；卡片詳情一律列全部） */
export const RECEIPT_FACE_MAX_BATCHES = 3
/** 「已入庫」區塊（可依入庫日排序的區塊）：常平已入庫可包、委外已入庫可包 */
export const RECEIVED_BLOCKS: readonly PoolBlockId[] = ['2', '5b']

const EPS = 1e-9
const r3 = (x: number): number => Math.round(x * 1000) / 1000
const DAY_MS = 86_400_000
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// ─────────────────────────────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────────────────────────────

/** erp_po_receipts 一列（camelCase） */
export interface PoReceiptRow {
  poDocNo: string
  poLineNo: string
  itemCode: string | null
  /** ARGO ISM_MBP_LOT_NO（來源 SO／RO）；可空 */
  sourceSo: string | null
  /** 入庫日 YYYY-MM-DD（ARGO IO_DATE 的日期部分；當地日期） */
  receiptDate: string
  /** 同一採購行、同一天的入庫量合計 */
  qty: number
  /** 同一天不重複的入庫單號數 */
  slipCount: number
}

/** ARGO 採購入庫明細一筆（receiptSync 從 S_QUERY 結果轉來；欄位都可能缺） */
export interface ReceiptDetailRow {
  poDocNo: string | null
  poLineNo: string | number | null
  itemCode: string | null
  lotNo: string | null
  qty: number | string | null
  ioDate: string | null
  slipNo: string | null
}

/** 卡片上的一批入庫 */
export interface CardReceipt {
  /** YYYY-MM-DD */
  date: string
  qty: number
}

/** 鏡像列的鍵（寫入計畫用） */
export interface ReceiptKey {
  poDocNo: string
  poLineNo: string
  receiptDate: string
}

export type ReceiptSyncMode = 'full' | 'incremental'
export const RECEIPT_SYNC_DEFAULT_DAYS = 3
export const RECEIPT_SYNC_MAX_DAYS = 31

export interface ReceiptSyncStats {
  mode: ReceiptSyncMode
  /** incremental 的回看天數；full 為 null */
  days: number | null
  /** full 分片（shards > 1 時只處理 index % shards == shard 的採購單） */
  shard: number
  shards: number
  /** 範圍內的採購單數（erp_pj_sync 中來源 SO／RO 未結案的採購行所屬採購單） */
  scopeDocs: number
  /** 本次要重算的採購單數、批數（每批 ≤ 60 張，ARGO 動態 WHERE 有 4000 字上限） */
  poCount: number
  batches: number
  batchesDone: number
  /** ARGO 回來的入庫明細列數 */
  argoRows: number
  /** 彙總後的鏡像列數（採購行 × 入庫日） */
  mirrorRows: number
  /** 寫入 erp_po_receipts：upsert 列數、刪除的（行, 日）列數（作廢）、整張採購單清空數（ARGO 已無任何入庫） */
  upserted: number
  deleted: number
  clearedDocs: number
  /** full 完整跑完後清掉「已不在範圍內」的採購單數 */
  outOfScopePurged: number
  /** 時間不足略過的批數 */
  skippedBatches: number
  elapsedMs: number
}

export type ReceiptSyncResponse =
  | ({ success: true; partial: boolean; errors: string[] } & ReceiptSyncStats)
  | { success: false; error: string; code?: 'unauthorized' | 'forbidden' | 'bad_request' | 'argo_unconfigured' | 'busy' | 'migration_required' | 'db_error' | 'argo_error' }

// ─────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────

export const normDoc = (v: unknown): string => String(v ?? '').trim().toUpperCase()
const trimOrNull = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}
const num = (v: unknown): number => {
  if (v == null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 採購行的索引鍵：`採購單號(大寫)|行號('3.0'→'3')` */
export function receiptLineKey(docNo: unknown, lineNo: unknown): string | null {
  const d = normDoc(docNo)
  const l = lineNoStr(lineNo)
  return d && l ? `${d}|${l}` : null
}

/** 行號排序：數字依數值、其他依字串，數字在前 */
function compareLineNo(a: string, b: string): number {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b)
  if (na && nb) return Number(a) - Number(b)
  if (na) return -1
  if (nb) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function dayNum(ymd: string): number | null {
  const m = ymd.match(YMD_RE)
  if (!m) return null
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3])
  return Number.isFinite(t) ? t / DAY_MS : null
}

/**
 * 日曆天數差 to − from（同一天＝0）；任一日期不合法回 null。
 * 用 UTC 日序號算：字串本身就是台北的日曆日，不受伺服器時區與日光節約影響。
 */
export function calendarDaysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null
  const a = dayNum(from), b = dayNum(to)
  if (a == null || b == null) return null
  return Math.round(b - a)
}

// ─────────────────────────────────────────────────────────────────────
// 同步：明細彙總與鏡像寫入計畫
// ─────────────────────────────────────────────────────────────────────

/**
 * ARGO 採購入庫明細 → 依（採購單號, 採購行號, 入庫日）彙總。
 * - 同一採購行同一天多張入庫單 → 數量加總、slipCount＝不重複入庫單號數
 * - 沒有採購單號／行號／合法日期的明細略過（無法對到卡片）
 * - 合計 ≤ 0 的不存（同日入庫又沖銷）
 * 品號、來源 SO 取該組第一個非空值（同一採購行本來就只有一個品號）。
 * 排序固定：採購單號 → 行號（數值）→ 入庫日（由舊到新）。
 */
export function aggregateReceiptDetail(rows: readonly ReceiptDetailRow[]): PoReceiptRow[] {
  const acc = new Map<string, { doc: string; line: string; date: string; qty: number; item: string | null; so: string | null; slips: Set<string> }>()
  for (const r of rows) {
    const doc = normDoc(r.poDocNo)
    const line = lineNoStr(r.poLineNo)
    const date = argoDate(r.ioDate)
    if (!doc || !line || !date) continue
    const k = `${doc}\u0000${line}\u0000${date}`
    let a = acc.get(k)
    if (!a) { a = { doc, line, date, qty: 0, item: null, so: null, slips: new Set() }; acc.set(k, a) }
    a.qty += num(r.qty)
    if (a.item == null) a.item = trimOrNull(r.itemCode)
    if (a.so == null) { const so = normDoc(r.lotNo); a.so = so || null }
    const slip = String(r.slipNo ?? '').trim()
    if (slip) a.slips.add(slip)
  }
  const out: PoReceiptRow[] = []
  for (const a of acc.values()) {
    const q = r3(a.qty)
    if (q <= EPS) continue
    out.push({ poDocNo: a.doc, poLineNo: a.line, itemCode: a.item, sourceSo: a.so, receiptDate: a.date, qty: q, slipCount: a.slips.size })
  }
  return out.sort((x, y) => cmpStr(x.poDocNo, y.poDocNo) || compareLineNo(x.poLineNo, y.poLineNo) || cmpStr(x.receiptDate, y.receiptDate))
}

/**
 * 整張採購單重算覆蓋的寫入計畫（一批採購單）：
 * - upserts：這批採購單在 ARGO 的全部彙總列（每次都寫，synced_at 才會更新）
 * - deletes：鏡像裡有、ARGO 已沒有的（採購單, 行, 日）→ 刪（作廢入庫單、改入庫日）；依（採購單, 行）分組
 * - clearDocs：這張採購單在 ARGO 已沒有任何入庫、鏡像還有列 → 整張刪
 * 只處理 batchDocs 內的採購單（fresh 裡的其他採購單忽略，避免誤寫別批）。
 */
export function planReceiptMirrorWrite(
  batchDocs: readonly string[],
  existing: readonly ReceiptKey[],
  fresh: readonly PoReceiptRow[],
): { upserts: PoReceiptRow[]; deletes: { poDocNo: string; poLineNo: string; dates: string[] }[]; clearDocs: string[] } {
  const batch = new Set(batchDocs.map(normDoc))
  const upserts = fresh.filter((r) => batch.has(normDoc(r.poDocNo)))
  const freshKeys = new Set<string>()
  const freshDocs = new Set<string>()
  for (const r of upserts) {
    const doc = normDoc(r.poDocNo)
    freshDocs.add(doc)
    freshKeys.add(`${doc}\u0000${r.poLineNo}\u0000${r.receiptDate}`)
  }
  const staleByLine = new Map<string, { poDocNo: string; poLineNo: string; dates: string[] }>()
  const clear = new Set<string>()
  for (const e of existing) {
    const doc = normDoc(e.poDocNo)
    if (!batch.has(doc)) continue
    if (!freshDocs.has(doc)) { clear.add(doc); continue }
    if (freshKeys.has(`${doc}\u0000${e.poLineNo}\u0000${e.receiptDate}`)) continue
    const lk = `${doc}\u0000${e.poLineNo}`
    let g = staleByLine.get(lk)
    if (!g) { g = { poDocNo: doc, poLineNo: e.poLineNo, dates: [] }; staleByLine.set(lk, g) }
    if (!g.dates.includes(e.receiptDate)) g.dates.push(e.receiptDate)
  }
  const deletes = [...staleByLine.values()]
    .map((g) => ({ ...g, dates: [...g.dates].sort() }))
    .sort((x, y) => cmpStr(x.poDocNo, y.poDocNo) || compareLineNo(x.poLineNo, y.poLineNo))
  return { upserts, deletes, clearDocs: [...clear].sort() }
}

// ─────────────────────────────────────────────────────────────────────
// 待排池：鏡像 → 卡片
// ─────────────────────────────────────────────────────────────────────

/** 鏡像列 → (採購單號|行號) → 批次（同日加總、由舊到新） */
export function indexReceipts(rows: readonly Pick<PoReceiptRow, 'poDocNo' | 'poLineNo' | 'receiptDate' | 'qty'>[]): Map<string, CardReceipt[]> {
  const byLine = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const k = receiptLineKey(r.poDocNo, r.poLineNo)
    if (!k || !YMD_RE.test(r.receiptDate) || !(r.qty > EPS)) continue
    let m = byLine.get(k)
    if (!m) { m = new Map(); byLine.set(k, m) }
    m.set(r.receiptDate, r3((m.get(r.receiptDate) ?? 0) + r.qty))
  }
  const out = new Map<string, CardReceipt[]>()
  for (const [k, m] of byLine) {
    out.set(k, [...m.entries()].map(([date, qty]) => ({ date, qty })).sort((a, b) => cmpStr(a.date, b.date)))
  }
  return out
}

/** 卡片來源裡「是採購行」的來源（常平 POC／PO、委外 PO／MPO，且有行號）；製令（MOT／MOS）不是 */
const PO_DOC_TYPES = new Set(['POC', 'PO', 'MPO'])

/** 卡片來源的採購行鍵（不重複；順序同 sources） */
export function cardPoLineKeys(sources: readonly { docType: string; docNo: string; lineNo: string | null }[]): string[] {
  const out: string[] = []
  for (const s of sources) {
    if (!PO_DOC_TYPES.has(s.docType)) continue
    const k = receiptLineKey(s.docNo, s.lineNo)
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

/**
 * 一張卡的入庫批次：合併所有來源採購行的批次（同一天加總），由舊到新。
 * 同一採購行在 sources 出現多次只算一次（mergeSources 已去重，這裡再防一次）。
 */
export function receiptsForSources(
  sources: readonly { docType: string; docNo: string; lineNo: string | null }[],
  index: ReadonlyMap<string, readonly CardReceipt[]>,
): CardReceipt[] {
  const byDate = new Map<string, number>()
  for (const k of cardPoLineKeys(sources)) {
    for (const b of index.get(k) ?? []) byDate.set(b.date, r3((byDate.get(b.date) ?? 0) + b.qty))
  }
  return [...byDate.entries()].map(([date, qty]) => ({ date, qty })).sort((a, b) => cmpStr(a.date, b.date))
}

/**
 * 自最早一批至今的日曆天數（今天入庫＝0）。沒有批次或日期不合法 → null；
 * 入庫日在未來（ARGO 日期打錯）→ 0，不顯示負數。
 */
export function daysSinceFirstReceipt(receipts: readonly CardReceipt[], today: string): number | null {
  if (receipts.length === 0) return null
  const first = receipts.reduce((m, r) => (r.date < m ? r.date : m), receipts[0].date)
  const d = calendarDaysBetween(first, today)
  return d == null ? null : Math.max(0, d)
}

/**
 * 待排池卡套用入庫批次（D111；classifyPool 最後一步）。
 * - index＝null（鏡像不可用／migration 未套用）→ 每張卡 receipts＝[]、其餘 null（待排池照常出卡）
 * - poQtyByLine：採購行的採購量（erp_pj_sync qty），給卡片詳情「合計 vs 採購量」用
 * 一律回傳新物件、不改傳入的卡。
 */
export function applyReceiptsToCards(
  cards: readonly PackagingCard[],
  index: ReadonlyMap<string, readonly CardReceipt[]> | null,
  today: string,
  poQtyByLine?: ReadonlyMap<string, number> | null,
): PackagingCard[] {
  return cards.map((c) => {
    const keys = cardPoLineKeys(c.sources)
    const receipts = index && keys.length > 0 ? receiptsForSources(c.sources, index) : []
    let poQty: number | null = null
    if (poQtyByLine && keys.length > 0) {
      let sum = 0, hit = false
      for (const k of keys) { const q = poQtyByLine.get(k); if (q != null && q > 0) { sum += q; hit = true } }
      poQty = hit ? r3(sum) : null
    }
    return {
      ...c,
      receipts,
      firstReceiptDate: receipts.length > 0 ? receipts[0].date : null,
      daysSinceReceipt: daysSinceFirstReceipt(receipts, today),
      receiptPoQty: poQty,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────
// 畫面：顯示文字（CardFace／CardDetailDialog／PackagingCard／滑過提示共用）
// ─────────────────────────────────────────────────────────────────────

/** 卡片上讀入庫欄位的最小形狀（舊快取／舊伺服器回的卡沒有這些鍵 → 一律當空） */
export interface ReceiptCardLike {
  receipts?: readonly CardReceipt[] | null
  firstReceiptDate?: string | null
  daysSinceReceipt?: number | null
  receiptPoQty?: number | null
  qtyReady?: number
}

export type ReceiptTone = 'normal' | 'warn' | 'danger'

const fmtQty = (n: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(n)

/** 'YYYY-MM-DD' → '9/09'（月不補零、日補零，D111 Snow 的寫法）；跨年加兩位年 '25/12/31' */
export function receiptMd(ymd: string, today?: string | null): string {
  const m = ymd.match(YMD_RE)
  if (!m) return ymd
  const yy = today && today.slice(0, 4) !== m[1] ? `${m[1].slice(2)}/` : ''
  return `${yy}${Number(m[2])}/${m[3]}`
}

/** 卡片的入庫批次（由舊到新；防呆：過濾不合法的列再排序） */
export function receiptsOf(card: ReceiptCardLike): CardReceipt[] {
  const list = Array.isArray(card.receipts) ? card.receipts : []
  return list
    .filter((r): r is CardReceipt => !!r && typeof r.date === 'string' && YMD_RE.test(r.date) && typeof r.qty === 'number' && Number.isFinite(r.qty))
    .slice()
    .sort((a, b) => cmpStr(a.date, b.date))
}

/** 已放天數 → 顏色：≥ 30 天紅、≥ 14 天橘（門檻見檔頭常數） */
export function receiptAgeTone(days: number | null | undefined): ReceiptTone {
  if (days == null || !Number.isFinite(days)) return 'normal'
  if (days >= RECEIPT_AGE_DANGER_DAYS) return 'danger'
  if (days >= RECEIPT_AGE_WARN_DAYS) return 'warn'
  return 'normal'
}

export interface ReceiptFace {
  /** 批次文字：單批「入庫 9/09」；分批「9/09 入 500、9/15 入 300」（最多 RECEIPT_FACE_MAX_BATCHES 批） */
  batches: string
  /** 超過上限時的「…共 N 批」；沒超過為 null */
  more: string | null
  /** 「已放 21 天」；本卡沒有可包量（同採購行其餘數量尚未入庫的卡）時為 null */
  aged: string | null
  tone: ReceiptTone
  /** 整行文字（batches＋more＋「・」＋aged） */
  text: string
  /** 滑過提示：全部批次＋合計＋已放天數 */
  title: string
}

/**
 * 簡化卡片上的入庫資訊（D111）：
 *   單批：「入庫 9/09・已放 21 天」
 *   分批：「9/09 入 500、9/15 入 300・已放 21 天」（逐批列出，最多 3 批；超過接「…共 N 批」）
 * 「已放 N 天」自最早一批起算；只有本卡有可包量（qtyReady > 0）時才顯示與上色——
 *   同一採購行「尚未入庫的那一部分」另成一張卡（運送中／品檢中…），那張卡的貨還沒到，不算「已放」。
 * 沒有任何批次 → null（卡片不多佔一行）。
 */
export function receiptFace(card: ReceiptCardLike, today?: string | null): ReceiptFace | null {
  const list = receiptsOf(card)
  if (list.length === 0) return null
  const days = today ? daysSinceFirstReceipt(list, today) : (card.daysSinceReceipt ?? null)
  const hasReady = card.qtyReady == null || card.qtyReady > 0
  const aged = hasReady && days != null ? `已放 ${days} 天` : null
  const tone = aged ? receiptAgeTone(days) : 'normal'
  let batches: string
  let more: string | null = null
  if (list.length === 1) {
    batches = `入庫 ${receiptMd(list[0].date, today)}`
  } else {
    batches = list.slice(0, RECEIPT_FACE_MAX_BATCHES).map((r) => `${receiptMd(r.date, today)} 入 ${fmtQty(r.qty)}`).join('、')
    if (list.length > RECEIPT_FACE_MAX_BATCHES) more = `…共 ${list.length} 批`
  }
  const text = `${batches}${more ?? ''}${aged ? `・${aged}` : ''}`
  return { batches, more, aged, tone, text, title: receiptDetail(card, today)?.lines.join('\n') ?? text }
}

export interface ReceiptDetail {
  batches: { date: string; label: string; qty: number; qtyText: string }[]
  total: number
  /** 來源採購行的採購量合計；不知道為 null */
  poQty: number | null
  /** 「合計 800／採購 1,000」或「合計 800」 */
  totalText: string
  /** 已放天數（自最早一批）；本卡沒有可包量時為 null */
  days: number | null
  tone: ReceiptTone
  /** 本卡沒有可包量：以上是同一採購行已入庫的批次，本卡是尚未入庫的數量 */
  pendingCard: boolean
  /** 純文字版（滑過提示 title 用） */
  lines: string[]
}

/** 卡片詳情／滑過提示：全部批次（日期、數量）＋合計 vs 採購量＋已放天數 */
export function receiptDetail(card: ReceiptCardLike, today?: string | null): ReceiptDetail | null {
  const list = receiptsOf(card)
  if (list.length === 0) return null
  const total = r3(list.reduce((s, r) => s + r.qty, 0))
  const poQty = card.receiptPoQty != null && Number.isFinite(card.receiptPoQty) && card.receiptPoQty > 0 ? card.receiptPoQty : null
  const hasReady = card.qtyReady == null || card.qtyReady > 0
  const rawDays = today ? daysSinceFirstReceipt(list, today) : (card.daysSinceReceipt ?? null)
  const days = hasReady ? rawDays : null
  const batches = list.map((r) => ({ date: r.date, label: receiptMd(r.date, today), qty: r.qty, qtyText: fmtQty(r.qty) }))
  const totalText = `合計 ${fmtQty(total)}${poQty != null ? `／採購 ${fmtQty(poQty)}` : ''}`
  const lines = [
    `入庫批次（ARGO 採購入庫，共 ${list.length} 批）`,
    ...batches.map((b) => `${b.label} 入 ${b.qtyText}`),
    totalText,
  ]
  if (days != null) lines.push(`已放 ${days} 天（自最早一批 ${batches[0].label} 起算）`)
  else if (!hasReady) lines.push('本卡是同一採購行尚未入庫的數量')
  return { batches, total, poQty, totalText, days, tone: receiptAgeTone(days), pendingCard: !hasReady, lines }
}

/**
 * 依入庫日由舊到新排序（穩定排序）：最早一批越早的排越前面；沒有入庫日的排最後、維持原順序。
 * 回傳新陣列。
 */
export function sortByReceiptDate<T extends ReceiptCardLike>(cards: readonly T[]): T[] {
  const keyOf = (c: T): string | null => {
    const list = receiptsOf(c)
    return list.length > 0 ? list[0].date : null
  }
  return cards
    .map((c, i) => ({ c, i, k: keyOf(c) }))
    .sort((a, b) => {
      if (a.k === b.k) return a.i - b.i
      if (a.k == null) return 1
      if (b.k == null) return -1
      return a.k < b.k ? -1 : 1
    })
    .map((x) => x.c)
}
