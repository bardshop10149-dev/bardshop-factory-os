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
  extra: Record<string, unknown> | null
}

interface PrCandidate {
  doc_no: string
  sub_no: string
  item_code: string | null
}

const BATCH = 1000
const IN_CHUNK = 200
const CHANGPING_VENDOR = 'C01510'   // 常平廠內部供應商代碼

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
 * 1000 行批次抓 OPEN 採購明細；可用下單日(start_date)區間先在伺服器端收斂，
 * 大幅減少後續 PR/MO/供應商 enrich 的資料量（下單日為 YYYY/MM/DD，字典序可比）。
 */
async function fetchAllOpenPoRows(supabase: SupabaseAdmin, range?: { orderFrom?: string | null; orderTo?: string | null }): Promise<PjSyncRow[]> {
  const from = toSlashDate(range?.orderFrom)
  const to = toSlashDate(range?.orderTo)
  const rows: PjSyncRow[] = []
  for (let offset = 0; ; offset += BATCH) {
    let q = supabase
      .from('erp_pj_sync')
      .select('doc_no, sub_no, item_code, description, qty, unit, status, start_date, end_date, customer_vendor, extra')
      .eq('doc_type', '採購單號')
      .eq('status', 'OPEN')
    if (from) q = q.gte('start_date', from)
    if (to) q = q.lte('start_date', to)
    const { data, error } = await q
      .order('doc_no', { ascending: true })
      .order('sub_no', { ascending: true })
      .range(offset, offset + BATCH - 1)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as PjSyncRow[]))
    if (!data || data.length < BATCH) break
  }
  return rows
}

const strField = (extra: Record<string, unknown> | null, key: string): string | null => {
  const v = String(extra?.[key] ?? '').trim()
  return v || null
}

/** PO 明細的來源單號（SO/RO）：SO_PROJECT_ID 優先，常平 PO 批號（MBP_LOT_NO）看起來像單號時退用 */
function sourceOrderOf(extra: Record<string, unknown> | null): string | null {
  const so = strField(extra, 'SO_PROJECT_ID')
  if (so) return so
  const lot = strField(extra, 'MBP_LOT_NO')
  if (lot && /^(SO|RO)[A-Z0-9-]{4,}$/i.test(lot)) return lot.toUpperCase()
  return null
}

const extractRo = (v: unknown): string | null => {
  const m = String(v ?? '').match(/RO\d{6,}/i)
  return m ? m[0].toUpperCase() : null
}

/** SO/RO 清單 → 請購候選索引（直接比對 + RO 橋接，皆分塊查詢） */
async function buildPrIndex(supabase: SupabaseAdmin, soNos: string[]): Promise<Map<string, PrCandidate[]>> {
  const index = new Map<string, PrCandidate[]>()
  if (soNos.length === 0) return index
  const push = (key: string, r: PrCandidate) => {
    const k = key.trim().toUpperCase()
    if (!k) return
    const list = index.get(k) ?? []
    if (!list.some((c) => c.doc_no === r.doc_no && c.sub_no === r.sub_no)) list.push(r)
    index.set(k, list)
  }

  // 直接比對（3 欄位）＋ RO 橋接的 so_lines 查詢——彼此獨立，全部平行以省往返時間
  const fieldChunks = (['PROJECT_ID', 'MBP_LOT_NO', 'SO_PROJECT_ID'] as const)
    .flatMap((field) => chunk(soNos, IN_CHUNK).map((part) => ({ field, part })))
  const [fieldResults, soLineResults] = await Promise.all([
    Promise.all(fieldChunks.map(async ({ field, part }) => {
      const { data, error } = await supabase
        .from('erp_pj_sync').select('doc_no, sub_no, item_code, extra')
        .eq('doc_type', '請購單號').in(`extra->>${field}`, part)
      if (error) throw new Error(error.message)
      return { field, data: data ?? [] as { doc_no: string; sub_no: string; item_code: string | null; extra: Record<string, unknown> | null }[] }
    })),
    Promise.all(chunk(soNos, IN_CHUNK).map(async (part) => {
      const { data, error } = await supabase
        .from('erp_so_lines').select('project_id, mbp_part, tpn_part_no').in('project_id', part)
      if (error) throw new Error(error.message)
      return data ?? [] as { project_id: string; mbp_part: string | null; tpn_part_no: string | null }[]
    })),
  ])
  for (const { field, data } of fieldResults) {
    for (const r of data) {
      const key = String((r.extra as Record<string, unknown> | null)?.[field] ?? '').trim()
      push(key, { doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code })
    }
  }

  // RO 橋接：SO → erp_so_lines.tpn_part_no(RO) → 請購 extra.SO_PROJECT_ID(RO)
  const soToRo = new Map<string, string>()   // `${SO}|${item}` 與 SO 兩種 key
  const ros = new Set<string>()
  for (const data of soLineResults) {
    for (const l of data) {
      const ro = extractRo(l.tpn_part_no)
      if (!ro) continue
      ros.add(ro)
      const so = String(l.project_id ?? '').trim().toUpperCase()
      const item = String(l.mbp_part ?? '').trim()
      if (item && !soToRo.has(`${so}|${item}`)) soToRo.set(`${so}|${item}`, ro)
      if (!soToRo.has(so)) soToRo.set(so, ro)
    }
  }
  if (ros.size > 0) {
    const roIndex = new Map<string, PrCandidate[]>()
    for (const part of chunk([...ros], IN_CHUNK)) {
      const { data, error } = await supabase
        .from('erp_pj_sync')
        .select('doc_no, sub_no, item_code, extra')
        .eq('doc_type', '請購單號')
        .in('extra->>SO_PROJECT_ID', part)
      if (error) throw new Error(error.message)
      for (const r of data ?? []) {
        const ro = extractRo((r.extra as Record<string, unknown> | null)?.SO_PROJECT_ID)
        if (!ro) continue
        const list = roIndex.get(ro) ?? []
        if (!list.some((c) => c.doc_no === r.doc_no && c.sub_no === r.sub_no))
          list.push({ doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code })
        roIndex.set(ro, list)
      }
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

/** 查詢建議清單（頁面 datalist 用）：承辦人工號+姓名、OPEN PO 料號+品名 */
export async function loadLookups(supabase: SupabaseAdmin): Promise<{
  buyers: { id: string; name: string | null }[]
  items: { code: string; name: string | null }[]
}> {
  const poRows = await fetchAllOpenPoRows(supabase)

  const buyerMap = new Map<string, string>()   // SALES_ID → SALES_NAME（取自 PO extra，不查 erp_so_lines）
  const buyerIds = new Set<string>()
  const itemMap = new Map<string, string | null>()
  for (const r of poRows) {
    const id = strField(r.extra, 'SALES_ID')
    if (id) {
      buyerIds.add(id)
      const name = strField(r.extra, 'SALES_NAME')
      if (name && !buyerMap.has(id)) buyerMap.set(id, name)
    }
    const code = (r.item_code ?? '').trim()
    if (code && !itemMap.has(code)) itemMap.set(code, r.description)
  }

  return {
    buyers: [...buyerIds].sort().map((id) => ({ id, name: buyerMap.get(id) ?? null })),
    items: [...itemMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([code, name]) => ({ code, name })),
  }
}

/** SO/RO 清單 → 製令索引（source_order → 該單所有 MO 行） */
async function buildMoIndex(supabase: SupabaseAdmin, soNos: string[]): Promise<Map<string, { project_id: string; mbp_part: string | null }[]>> {
  const index = new Map<string, { project_id: string; mbp_part: string | null }[]>()
  for (const part of chunk(soNos, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('erp_mo_lines')
      .select('project_id, source_order, mbp_part')
      .in('source_order', part)
    if (error) throw new Error(error.message)
    for (const r of data ?? []) {
      const so = String(r.source_order ?? '').trim().toUpperCase()
      if (!so) continue
      const list = index.get(so) ?? []
      list.push({ project_id: r.project_id, mbp_part: r.mbp_part })
      index.set(so, list)
    }
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
}

/** 讀取 OPEN 採購明細（可依下單日區間收斂）並組裝追蹤資訊（全量；到期提醒/統計用） */
export async function loadPoTrackingLines(supabase: SupabaseAdmin, opts: LoadOptions = {}): Promise<PoTrackingLine[]> {
  const poRows = await fetchAllOpenPoRows(supabase, { orderFrom: opts.orderFrom, orderTo: opts.orderTo })
  return enrichRows(supabase, poRows, opts.countOnly ? { skipPrMo: true, skipVendor: true } : {})
}

/**
 * 對「一批」PO 列組裝 追蹤/付款/供應商/PR/MO —— 全量與分頁共用。
 * tracking/payment/vendor 只查本批 doc_no/vendor（分頁時僅 100 筆，很快）。
 */
async function enrichRows(
  supabase: SupabaseAdmin,
  poRows: PjSyncRow[],
  opts: { skipPrMo?: boolean; skipVendor?: boolean } = {},
): Promise<PoTrackingLine[]> {
  const today = todayTaipei()
  if (poRows.length === 0) return []
  const docNos = [...new Set(poRows.map((r) => r.doc_no))]

  const trackingMap = new Map<string, { sent_at: string | null; shipped_at: string | null; ship_method: string | null; expected_ship_date: string | null; updated_by: string | null; updated_at: string | null }>()
  const paymentMap = new Map<string, number>()
  const vendorMap = new Map<string, string>()
  let prIndex = new Map<string, PrCandidate[]>()
  let moIndex = new Map<string, { project_id: string; mbp_part: string | null }[]>()
  const buyerMap = new Map<string, string>()
  for (const r of poRows) {
    const id = strField(r.extra, 'SALES_ID'); const name = strField(r.extra, 'SALES_NAME')
    if (id && name && !buyerMap.has(id)) buyerMap.set(id, name)
  }

  const vendorCodes = [...new Set(poRows.map((r) => (r.customer_vendor ?? '').trim()).filter(Boolean))]
  const soNos = [...new Set(poRows.map((r) => sourceOrderOf(r.extra)).filter((v): v is string => Boolean(v)))]

  await Promise.all([
    // tracking
    (async () => {
      for (const part of chunk(docNos, IN_CHUNK)) {
        const { data, error } = await supabase
          .from('po_line_tracking')
          .select('doc_no, sub_no, sent_at, shipped_at, ship_method, expected_ship_date, updated_by, updated_at')
          .in('doc_no', part)
        if (error) throw new Error(error.message)
        for (const r of data ?? []) trackingMap.set(`${r.doc_no}|${r.sub_no}`, r)
      }
    })(),
    // payment
    (async () => {
      for (const part of chunk(docNos, IN_CHUNK)) {
        const { data, error } = await supabase.from('po_payment').select('doc_no, payment_pct').in('doc_no', part)
        if (error) throw new Error(error.message)
        for (const r of data ?? []) paymentMap.set(r.doc_no, Number(r.payment_pct) || 0)
      }
    })(),
    // vendor names
    (async () => {
      if (opts.skipVendor) return
      for (const part of chunk(vendorCodes, IN_CHUNK)) {
        const { data, error } = await supabase.from('erp_vendors').select('partner_id, cname').in('partner_id', part)
        if (error) throw new Error(error.message)
        for (const v of data ?? []) vendorMap.set(v.partner_id, v.cname)
      }
    })(),
    // PR / MO 比對
    (async () => { if (!opts.skipPrMo) prIndex = await buildPrIndex(supabase, soNos) })(),
    (async () => { if (!opts.skipPrMo) moIndex = await buildMoIndex(supabase, soNos) })(),
  ])

  return poRows.map((r) => {
    const tracking = trackingMap.get(`${r.doc_no}|${r.sub_no}`)
    const so = sourceOrderOf(r.extra)
    const dueDate = normalizeDateText(r.end_date)
    const pr = opts.skipPrMo ? null : pickPr(prIndex, so, r.item_code)
    return {
      doc_no: r.doc_no,
      sub_no: r.sub_no,
      item_code: r.item_code,
      description: r.description,
      qty: r.qty,
      unit: r.unit,
      received_qty: (() => {
        const v = Number(r.extra?.RECEIVED_QTY)
        return Number.isFinite(v) ? v : null
      })(),
      po_status: r.status,
      order_date: normalizeDateText(r.start_date),
      due_date: dueDate,
      due_days: daysUntil(dueDate, today),
      vendor_code: r.customer_vendor,
      vendor_name: r.customer_vendor ? vendorMap.get(r.customer_vendor.trim()) ?? null : null,
      so_no: so,
      so_line: strField(r.extra, 'SO_LINE_NO'),
      pr_no: pr?.doc_no ?? null,
      pr_sub: pr?.sub_no ?? null,
      mo_no: opts.skipPrMo ? null : pickMo(moIndex, so, r.item_code),
      buyer: strField(r.extra, 'SALES_NAME') ?? (() => { const id = strField(r.extra, 'SALES_ID'); return id ? buyerMap.get(id) ?? null : null })(),
      buyer_id: strField(r.extra, 'SALES_ID'),
      sent_at: tracking?.sent_at ?? null,
      shipped_at: tracking?.shipped_at ?? null,
      ship_method: (tracking?.ship_method ?? null) as ShipMethod | null,
      expected_ship_date: tracking?.expected_ship_date ?? null,
      payment_pct: (paymentMap.get(r.doc_no) ?? 0) as PaymentPct,
      updated_by: tracking?.updated_by ?? null,
      updated_at: tracking?.updated_at ?? null,
    }
  })
}

/** 分頁查詢參數（伺服器端過濾/排序/分頁，只 enrich 當頁 → 快） */
export interface PageParams {
  page: number
  pageSize: number
  orderFrom?: string | null
  orderTo?: string | null
  dueFrom?: string | null
  dueTo?: string | null
  vendorCode?: string | null
  vendorName?: string | null
  itemCode?: string | null
  buyer?: string | null
  poNo?: string | null
  poFrom?: string | null
  poTo?: string | null
  cp?: 'all' | 'only' | 'exclude'
  sortDue?: 'asc' | 'desc' | null
}

/** 伺服器端過濾/排序/分頁；只 enrich 當頁 100 筆。回傳 { lines, total }。 */
export async function loadPoPage(supabase: SupabaseAdmin, p: PageParams): Promise<{ lines: PoTrackingLine[]; total: number }> {
  // 廠商名稱 → 先解析成供應商代碼清單
  let vendorNameCodes: string[] | null = null
  if (p.vendorName && p.vendorName.trim()) {
    const { data, error } = await supabase.from('erp_vendors').select('partner_id').ilike('cname', `%${p.vendorName.trim()}%`)
    if (error) throw new Error(error.message)
    vendorNameCodes = (data ?? []).map((v) => v.partner_id)
    if (vendorNameCodes.length === 0) return { lines: [], total: 0 }
  }

  let q = supabase
    .from('erp_pj_sync')
    .select('doc_no, sub_no, item_code, description, qty, unit, status, start_date, end_date, customer_vendor, extra', { count: 'exact' })
    .eq('doc_type', '採購單號')
    .eq('status', 'OPEN')

  const oFrom = toSlashDate(p.orderFrom), oTo = toSlashDate(p.orderTo)
  if (oFrom) q = q.gte('start_date', oFrom)
  if (oTo) q = q.lte('start_date', oTo)
  const dFrom = toSlashDate(p.dueFrom), dTo = toSlashDate(p.dueTo)
  if (dFrom) q = q.gte('end_date', dFrom)
  if (dTo) q = q.lte('end_date', dTo)
  if (p.vendorCode && p.vendorCode.trim()) q = q.ilike('customer_vendor', `%${p.vendorCode.trim()}%`)
  if (vendorNameCodes) q = q.in('customer_vendor', vendorNameCodes)
  if (p.itemCode && p.itemCode.trim()) q = q.ilike('item_code', `%${p.itemCode.trim()}%`)
  if (p.poNo && p.poNo.trim()) q = q.ilike('doc_no', `%${p.poNo.trim()}%`)
  if (p.poFrom && p.poFrom.trim()) q = q.gte('doc_no', p.poFrom.trim())
  if (p.poTo && p.poTo.trim()) q = q.lte('doc_no', p.poTo.trim() + '￿')
  if (p.buyer && p.buyer.trim()) {
    const b = p.buyer.trim().replace(/[%,()*]/g, '')
    if (b) q = q.or(`extra->>SALES_ID.ilike.*${b}*,extra->>SALES_NAME.ilike.*${b}*`)
  }
  if (p.cp === 'only') q = q.eq('customer_vendor', CHANGPING_VENDOR)
  else if (p.cp === 'exclude') q = q.neq('customer_vendor', CHANGPING_VENDOR)

  if (p.sortDue) q = q.order('end_date', { ascending: p.sortDue === 'asc', nullsFirst: false })
  else q = q.order('doc_no', { ascending: true }).order('sub_no', { ascending: true })

  const offset = Math.max(0, (p.page - 1) * p.pageSize)
  const { data, error, count } = await q.range(offset, offset + p.pageSize - 1)
  if (error) throw new Error(error.message)

  const lines = await enrichRows(supabase, (data ?? []) as PjSyncRow[])
  return { lines, total: count ?? 0 }
}

/** 到期提醒用：只抓交期在 10 天內（含逾期）的 OPEN 列，enrich 不含 PR/MO（較快）。 */
export async function loadReminders(supabase: SupabaseAdmin): Promise<PoTrackingLine[]> {
  const d = new Date(Date.now() + (8 * 3600 + 10 * 86400) * 1000)  // 台北 +10 天
  const pad = (n: number) => String(n).padStart(2, '0')
  const cutoff = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`
  const rows: PjSyncRow[] = []
  for (let offset = 0; ; offset += BATCH) {
    const { data, error } = await supabase
      .from('erp_pj_sync')
      .select('doc_no, sub_no, item_code, description, qty, unit, status, start_date, end_date, customer_vendor, extra')
      .eq('doc_type', '採購單號')
      .eq('status', 'OPEN')
      .lte('end_date', cutoff)
      .order('end_date', { ascending: true })
      .range(offset, offset + BATCH - 1)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as PjSyncRow[]))
    if (!data || data.length < BATCH) break
  }
  return enrichRows(supabase, rows, { skipPrMo: true })
}
