// 採購專區 — 伺服器端資料組裝（僅供 /api/purchasing/* 使用，走 service_role）
//
// erp_pj_sync 每小時整批重建、無穩定 id → 使用者覆蓋層（po_line_tracking / po_payment）
// 以自然鍵 (doc_no, sub_no) / doc_no 連結，於此檔 join。
//
// PR / MO 對應沿用 daily-order-sheet 已驗證的比對鏈：
//   PO extra.SO_PROJECT_ID（來源 SO/RO）
//     → PR extra.PROJECT_ID / MBP_LOT_NO / SO_PROJECT_ID 直接比對
//     → 或 SO → erp_so_lines.tpn_part_no(RO) → PR extra.SO_PROJECT_ID(RO) 橋接
//   MO：erp_mo_lines.source_order = 來源 SO，優先 mbp_part 與 PO 料號一致者

import type { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import {
  type PaymentPct,
  type PoTrackingLine,
  type ShipMethod,
  daysUntil,
  normalizeDateText,
  todayTaipei,
} from './types'

type SupabaseAdmin = ReturnType<typeof getSupabaseAdminClient>

// 只取需要的 extra 欄位（PostgREST alias:extra->>KEY 展開）——
// 整包 extra JSONB 有數十欄，幾千列全抓是列表 5 秒+ 的主因之一
interface PjSyncRow {
  doc_no: string
  sub_no: string
  item_code: string | null
  description: string | null
  qty: number | null
  unit: string | null
  status: string | null
  start_date: string | null
  end_date: string | null
  customer_vendor: string | null
  so_project_id: string | null
  mbp_lot_no: string | null
  sales_id: string | null
  sales_name: string | null
  so_line_no: string | null
  received_qty: string | null
}

const PO_SELECT = 'doc_no, sub_no, item_code, description, qty, unit, status, start_date, end_date, customer_vendor, '
  + 'so_project_id:extra->>SO_PROJECT_ID, mbp_lot_no:extra->>MBP_LOT_NO, sales_id:extra->>SALES_ID, '
  + 'sales_name:extra->>SALES_NAME, so_line_no:extra->>SO_LINE_NO, received_qty:extra->>RECEIVED_QTY'

interface PrCandidate {
  doc_no: string
  sub_no: string
  item_code: string | null
}

const BATCH = 1000
const IN_CHUNK = 200

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** YYYY-MM-DD → YYYY/MM/DD（erp_pj_sync.start_date 存斜線格式，可字典序比較） */
function toSlashDate(d?: string | null): string | null {
  if (!d) return null
  const s = d.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, '/')
  return null
}

/**
 * 抓指定狀態（預設 OPEN）採購明細；可用下單日(start_date)區間先在伺服器端收斂。
 * 第一頁帶 exact count，其餘頁並行抓（每頁都帶 order 確保 range 分頁穩定）。
 */
async function fetchAllOpenPoRows(supabase: SupabaseAdmin, range?: { orderFrom?: string | null; orderTo?: string | null; poStatus?: string | null }): Promise<PjSyncRow[]> {
  const from = toSlashDate(range?.orderFrom)
  const to = toSlashDate(range?.orderTo)
  const buildQuery = (withCount: boolean) => {
    let q = supabase
      .from('erp_pj_sync')
      .select(PO_SELECT, withCount ? { count: 'exact' } : undefined)
      .eq('doc_type', '採購單號')
      .eq('status', range?.poStatus || 'OPEN')
    if (from) q = q.gte('start_date', from)
    if (to) q = q.lte('start_date', to)
    return q.order('doc_no', { ascending: true }).order('sub_no', { ascending: true })
  }

  const first = await buildQuery(true).range(0, BATCH - 1)
  if (first.error) throw new Error(first.error.message)
  const rows: PjSyncRow[] = [...((first.data ?? []) as unknown as PjSyncRow[])]
  const total = first.count ?? rows.length
  if (total > BATCH) {
    const offsets: number[] = []
    for (let offset = BATCH; offset < total; offset += BATCH) offsets.push(offset)
    const pages = await Promise.all(offsets.map(async (offset) => {
      const { data, error } = await buildQuery(false).range(offset, offset + BATCH - 1)
      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as PjSyncRow[]
    }))
    for (const p of pages) rows.push(...p)
  }
  return rows
}

const trimOrNull = (v: string | null | undefined): string | null => {
  const s = String(v ?? '').trim()
  return s || null
}

/** PO 明細的來源單號（SO/RO）：SO_PROJECT_ID 優先，常平 PO 批號（MBP_LOT_NO）看起來像單號時退用 */
function sourceOrderOf(row: PjSyncRow): string | null {
  const so = trimOrNull(row.so_project_id)
  if (so) return so
  const lot = trimOrNull(row.mbp_lot_no)
  if (lot && /^(SO|RO)[A-Z0-9-]{4,}$/i.test(lot)) return lot.toUpperCase()
  return null
}

const extractRo = (v: unknown): string | null => {
  const m = String(v ?? '').match(/RO\d{6,}/i)
  return m ? m[0].toUpperCase() : null
}

interface PrRawRow {
  doc_no: string
  sub_no: string
  item_code: string | null
  pj: string | null
  lot: string | null
  so: string | null
}

/** 一次撈出全部請購列（僅取比對需要的 3 個 extra 欄位，1000 行批次）。
 *  取代原本「3 欄位 × SO 分塊」的多次 jsonb .in() 查詢——那條路在
 *  expression index 未建時會反覆全表掃描，是列表 10 秒+ 的主因。 */
async function fetchAllPrRows(supabase: SupabaseAdmin): Promise<PrRawRow[]> {
  const buildQuery = (withCount: boolean) => supabase
    .from('erp_pj_sync')
    .select('doc_no, sub_no, item_code, pj:extra->>PROJECT_ID, lot:extra->>MBP_LOT_NO, so:extra->>SO_PROJECT_ID', withCount ? { count: 'exact' } : undefined)
    .eq('doc_type', '請購單號')
    .order('doc_no', { ascending: true })
    .order('sub_no', { ascending: true })

  const first = await buildQuery(true).range(0, BATCH - 1)
  if (first.error) throw new Error(first.error.message)
  const rows: PrRawRow[] = [...((first.data ?? []) as unknown as PrRawRow[])]
  const total = first.count ?? rows.length
  if (total > BATCH) {
    const offsets: number[] = []
    for (let offset = BATCH; offset < total; offset += BATCH) offsets.push(offset)
    const pages = await Promise.all(offsets.map(async (offset) => {
      const { data, error } = await buildQuery(false).range(offset, offset + BATCH - 1)
      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as PrRawRow[]
    }))
    for (const p of pages) rows.push(...p)
  }
  return rows
}

/** SO/RO 清單 → 請購候選索引（直接比對 + RO 橋接）。
 *  請購列已整批在記憶體（fetchAllPrRows），這裡只建 JS 索引；
 *  唯一的額外查詢是 SO → erp_so_lines 的 RO 橋接（分塊並行）。 */
async function buildPrIndex(supabase: SupabaseAdmin, soNos: string[], prRows: PrRawRow[]): Promise<Map<string, PrCandidate[]>> {
  const index = new Map<string, PrCandidate[]>()
  if (soNos.length === 0) return index
  const soSet = new Set(soNos.map((s) => s.trim().toUpperCase()))
  const push = (key: string, r: PrCandidate) => {
    const k = key.trim().toUpperCase()
    if (!k) return
    const list = index.get(k) ?? []
    if (!list.some((c) => c.doc_no === r.doc_no && c.sub_no === r.sub_no)) list.push(r)
    index.set(k, list)
  }

  // 直接比對：請購 PROJECT_ID / MBP_LOT_NO / SO_PROJECT_ID 帶 SO/RO 號（記憶體比對）
  // 同時建 RO → 請購 索引（供下方橋接用）
  const roIndex = new Map<string, PrCandidate[]>()
  for (const r of prRows) {
    const cand: PrCandidate = { doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code }
    for (const v of [r.pj, r.lot, r.so]) {
      const key = String(v ?? '').trim().toUpperCase()
      if (key && soSet.has(key)) push(key, cand)
    }
    const ro = extractRo(r.so)
    if (ro) {
      const list = roIndex.get(ro) ?? []
      if (!list.some((c) => c.doc_no === cand.doc_no && c.sub_no === cand.sub_no)) list.push(cand)
      roIndex.set(ro, list)
    }
  }

  // RO 橋接：SO → erp_so_lines.tpn_part_no(RO) → 請購 SO_PROJECT_ID(RO)（分塊並行查）
  const soToRo = new Map<string, string>()   // `${SO}|${item}` 與 SO 兩種 key
  const soLineParts = await Promise.all(chunk(soNos, IN_CHUNK).map(async (part) => {
    const { data, error } = await supabase
      .from('erp_so_lines')
      .select('project_id, mbp_part, tpn_part_no')
      .in('project_id', part)
    if (error) throw new Error(error.message)
    return data ?? []
  }))
  for (const l of soLineParts.flat()) {
    const ro = extractRo(l.tpn_part_no)
    if (!ro) continue
    const so = String(l.project_id ?? '').trim().toUpperCase()
    const item = String(l.mbp_part ?? '').trim()
    if (item && !soToRo.has(`${so}|${item}`)) soToRo.set(`${so}|${item}`, ro)
    if (!soToRo.has(so)) soToRo.set(so, ro)
  }
  // 把橋接到的候選掛回 SO / SO|item key，供 pickPr 以同一介面查
  for (const [key, ro] of soToRo) {
    const cands = roIndex.get(ro)
    if (!cands) continue
    for (const c of cands) {
      const list = index.get(key) ?? []
      if (!list.some((x) => x.doc_no === c.doc_no && x.sub_no === c.sub_no)) list.push(c)
      index.set(key, list)
    }
  }
  return index
}

/** 候選中挑最合適的請購：料號精準相符 → PR 無料號（整張請購）→ 不配 */
function pickPr(index: Map<string, PrCandidate[]>, so: string | null, itemCode: string | null): PrCandidate | null {
  if (!so) return null
  const key = so.trim().toUpperCase()
  const cands = [...(index.get(key) ?? [])]
  const item = (itemCode ?? '').trim()
  if (item) {
    const byItemKey = index.get(`${key}|${item}`) ?? []
    for (const c of byItemKey) if (!cands.some((x) => x.doc_no === c.doc_no && x.sub_no === c.sub_no)) cands.push(c)
  }
  if (cands.length === 0) return null
  const exact = cands.find((c) => (c.item_code ?? '').trim() === item && item)
  if (exact) return exact
  const blank = cands.find((c) => !(c.item_code ?? '').trim())
  if (blank) return blank
  return null
}

/** 查詢建議清單（頁面 datalist 用）：承辦人（EIP 採購部門成員）、OPEN PO 料號+品名。
 *  承辦人來源 = EIP members 表中部門含「採購」者（Snow 2026-07-14：之後新增採購人員
 *  要進 EIP 採購部門即可出現，不看 ERP）；工號以 OPEN PO 的 SALES_NAME 反查補上。 */
export async function loadLookups(supabase: SupabaseAdmin): Promise<{
  buyers: { id: string; name: string | null }[]
  items: { code: string; name: string | null }[]
}> {
  const [poRows, membersRes] = await Promise.all([
    fetchAllOpenPoRows(supabase),
    supabase.from('members').select('real_name, department').ilike('department', '%採購%'),
  ])
  if (membersRes.error) throw new Error(membersRes.error.message)

  const nameToId = new Map<string, string>()   // SALES_NAME → SALES_ID（取自 OPEN PO extra）
  const itemMap = new Map<string, string | null>()
  for (const r of poRows) {
    const id = trimOrNull(r.sales_id)
    const name = trimOrNull(r.sales_name)
    if (id && name && !nameToId.has(name)) nameToId.set(name, id)
    const code = (r.item_code ?? '').trim()
    if (code && !itemMap.has(code)) itemMap.set(code, r.description)
  }

  const buyers = (membersRes.data ?? [])
    .map((m) => String(m.real_name ?? '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
    .map((name) => ({ id: nameToId.get(name) ?? '', name }))

  return {
    buyers,
    items: [...itemMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([code, name]) => ({ code, name })),
  }
}

/** SO/RO 清單 → 製令索引（source_order → 該單所有 MO 行）；分塊並行查 */
async function buildMoIndex(supabase: SupabaseAdmin, soNos: string[]): Promise<Map<string, { project_id: string; mbp_part: string | null }[]>> {
  const index = new Map<string, { project_id: string; mbp_part: string | null }[]>()
  const parts = await Promise.all(chunk(soNos, IN_CHUNK).map(async (part) => {
    const { data, error } = await supabase
      .from('erp_mo_lines')
      .select('project_id, source_order, mbp_part')
      .in('source_order', part)
    if (error) throw new Error(error.message)
    return data ?? []
  }))
  for (const r of parts.flat()) {
    const so = String(r.source_order ?? '').trim().toUpperCase()
    if (!so) continue
    const list = index.get(so) ?? []
    list.push({ project_id: r.project_id, mbp_part: r.mbp_part })
    index.set(so, list)
  }
  return index
}

function pickMo(index: Map<string, { project_id: string; mbp_part: string | null }[]>, so: string | null, itemCode: string | null): string | null {
  if (!so) return null
  const cands = index.get(so.trim().toUpperCase())
  if (!cands || cands.length === 0) return null
  const item = (itemCode ?? '').trim()
  const exact = item ? cands.find((c) => (c.mbp_part ?? '').trim() === item) : undefined
  return (exact ?? cands[0]).project_id
}

export interface LoadOptions {
  /** true = 只組提醒統計所需欄位（略過 PR/MO/供應商 enrich），首頁徽章用 */
  countOnly?: boolean
  /** 下單日區間（YYYY-MM-DD）：伺服器端先收斂，加速 enrich */
  orderFrom?: string | null
  orderTo?: string | null
  /** 單據狀態（ARGO HOLD_STATUS，OPEN/CLOSE/VOID）；未給預設 OPEN */
  poStatus?: string | null
}

/** 讀取 OPEN 採購明細（可依下單日區間收斂）並組裝追蹤資訊。
 *  各資料來源盡量並行查詢；耗時分段記在 console（Vercel function log 可見）。 */
export async function loadPoTrackingLines(supabase: SupabaseAdmin, opts: LoadOptions = {}, timings?: Record<string, number>): Promise<PoTrackingLine[]> {
  const t0 = Date.now()
  const poRows = await fetchAllOpenPoRows(supabase, { orderFrom: opts.orderFrom, orderTo: opts.orderTo, poStatus: opts.poStatus })
  const tPo = Date.now()
  const today = todayTaipei()

  const trackingMap = new Map<string, { sent_at: string | null; shipped_at: string | null; ship_method: string | null; expected_ship_date: string | null; note: string | null; updated_by: string | null; updated_at: string | null }>()
  const paymentMap = new Map<string, number>()
  const vendorMap = new Map<string, string>()
  let prIndex = new Map<string, PrCandidate[]>()
  let moIndex = new Map<string, { project_id: string; mbp_part: string | null }[]>()
  // 承辦人姓名直接取自 PO extra.SALES_NAME（sync_po 已帶入）；用本頁資料建 SALES_ID→姓名
  // 記憶體 fallback（不查 erp_so_lines，其 sales_id 為 null 無用且是全表掃描）
  const buyerMap = new Map<string, string>()

  // 覆蓋層：po_line_tracking / po_payment（表都有界，整表抓）
  const loadTracking = async () => {
    let { data, error } = await supabase
      .from('po_line_tracking')
      .select('doc_no, sub_no, sent_at, shipped_at, ship_method, expected_ship_date, note, updated_by, updated_at')
    if (error && /note/i.test(error.message)) {
      // 降級相容：note 欄位 migration（20260714_po_line_note.sql）尚未執行時，
      // 改抓舊欄位讓列表照常運作（備註欄暫顯示空白），不讓整個查詢掛掉
      const legacy = await supabase
        .from('po_line_tracking')
        .select('doc_no, sub_no, sent_at, shipped_at, ship_method, expected_ship_date, updated_by, updated_at')
      data = (legacy.data ?? []).map((r) => ({ ...r, note: null }))
      error = legacy.error
    }
    if (error) throw new Error(error.message)
    for (const r of data ?? []) trackingMap.set(`${r.doc_no}|${r.sub_no}`, r)
  }
  const loadPayment = async () => {
    const { data, error } = await supabase.from('po_payment').select('doc_no, payment_pct')
    if (error) throw new Error(error.message)
    for (const r of data ?? []) paymentMap.set(r.doc_no, Number(r.payment_pct) || 0)
  }

  if (opts.countOnly) {
    await Promise.all([loadTracking(), loadPayment()])
  } else {
    for (const r of poRows) {
      const id = trimOrNull(r.sales_id)
      const name = trimOrNull(r.sales_name)
      if (id && name && !buyerMap.has(id)) buyerMap.set(id, name)
    }
    const vendorCodes = [...new Set(poRows.map((r) => (r.customer_vendor ?? '').trim()).filter(Boolean))]
    const soNos = [...new Set(poRows.map((r) => sourceOrderOf(r)).filter((v): v is string => Boolean(v)))]

    const loadVendors = async () => {
      const parts = await Promise.all(chunk(vendorCodes, IN_CHUNK).map(async (part) => {
        const { data, error } = await supabase.from('erp_vendors').select('partner_id, cname').in('partner_id', part)
        if (error) throw new Error(error.message)
        return data ?? []
      }))
      for (const v of parts.flat()) vendorMap.set(v.partner_id, v.cname)
    }

    // 全部並行：覆蓋層×2、供應商、請購（整批載入+索引）、製令
    ;[, , , prIndex, moIndex] = await Promise.all([
      loadTracking(),
      loadPayment(),
      loadVendors(),
      fetchAllPrRows(supabase).then((prRows) => buildPrIndex(supabase, soNos, prRows)),
      buildMoIndex(supabase, soNos),
    ])
  }
  const tEnrich = Date.now()
  if (timings) {
    timings.po_ms = tPo - t0
    timings.enrich_ms = tEnrich - tPo
    timings.total_ms = tEnrich - t0
    timings.rows = poRows.length
  }
  console.log(`[purchasing/list] po=${poRows.length} rows ${tPo - t0}ms, enrich ${tEnrich - tPo}ms, total ${tEnrich - t0}ms${opts.countOnly ? ' (countOnly)' : ''}`)

  return poRows.map((r) => {
    const tracking = trackingMap.get(`${r.doc_no}|${r.sub_no}`)
    const so = sourceOrderOf(r)
    const dueDate = normalizeDateText(r.end_date)
    const pr = opts.countOnly ? null : pickPr(prIndex, so, r.item_code)
    return {
      doc_no: r.doc_no,
      sub_no: r.sub_no,
      item_code: r.item_code,
      description: r.description,
      qty: r.qty,
      unit: r.unit,
      received_qty: (() => {
        const v = Number(r.received_qty)
        return r.received_qty != null && r.received_qty !== '' && Number.isFinite(v) ? v : null
      })(),
      po_status: r.status,
      order_date: normalizeDateText(r.start_date),
      due_date: dueDate,
      due_days: daysUntil(dueDate, today),
      vendor_code: r.customer_vendor,
      vendor_name: r.customer_vendor ? vendorMap.get(r.customer_vendor.trim()) ?? null : null,
      so_no: so,
      so_line: trimOrNull(r.so_line_no),
      pr_no: pr?.doc_no ?? null,
      pr_sub: pr?.sub_no ?? null,
      mo_no: opts.countOnly ? null : pickMo(moIndex, so, r.item_code),
      buyer: trimOrNull(r.sales_name) ?? (() => { const id = trimOrNull(r.sales_id); return id ? buyerMap.get(id) ?? null : null })(),
      buyer_id: trimOrNull(r.sales_id),
      sent_at: tracking?.sent_at ?? null,
      shipped_at: tracking?.shipped_at ?? null,
      ship_method: (tracking?.ship_method ?? null) as ShipMethod | null,
      expected_ship_date: tracking?.expected_ship_date ?? null,
      note: tracking?.note ?? null,
      payment_pct: (paymentMap.get(r.doc_no) ?? 0) as PaymentPct,
      updated_by: tracking?.updated_by ?? null,
      updated_at: tracking?.updated_at ?? null,
    }
  })
}
