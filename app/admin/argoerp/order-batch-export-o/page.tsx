'use client'

/**
 * 出單表➜委外採購
 * ArgoERP IFAF024 — 採購訂單（PO）介面
 *
 * 一物一單：每個委外品項各自產生一張採購單
 * 採購單號格式：POO + 销售訂單數字部分 + 2位 SO 序號（match_line_no）
 * 例：销售訂單 WO240001 第3序號列 → POO24000103
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../../../lib/supabaseClient'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface SourceRow {
  row_key?: string
  order_number: string; doc_type: string; factory: 'T' | 'C' | 'O'
  receiver: string; is_sample: string; has_material: string
  designer: string; customer: string; line_nickname: string
  handler: string; issuer: string
  item_code: string; item_name: string; note: string
  quantity: string; delivery_date: string; plate_count: string
  upload_ro: string; order_status: string; pm_note: string
  match_line_no?: string | null
}

/** 共用表頭設定（不含 project_id — 每筆各自產生） */
interface PoHeader {
  modify_ver:     string
  begin_date:     string
  hold_status:    'OPEN' | 'HOLD' | 'CLOSE' | 'UNSIGNED'
  tpn_partner_id: string
  department:     string
  sales_id:       string
  po_type:        'GENERAL' | 'IMPORT'
  payment_term:   string
  payment_mode:   'C' | 'L' | 'N' | 'T'
  currency:       string
  exchange_rate:  string
  tax_rate:       string
}

interface LineEdit {
  mbp_ver:    string
  uom:        string
  unit_price: string
  lot_no:     string
  remark2:    string
  so_line_no: string
  packing:    string
}

interface MatchResult {
  status: 'matched' | 'no_order' | 'no_qty_match' | 'exhausted' | null
  line_no: string | null
  reason:  string
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const HEADER_KEY  = 'argoerp_po_o_header_v1'

/** IFAF024 ERP 欄位順序（匯出 CSV/XLSX 用） */
const ERP_KEYS = [
  'PROJECT_ID', 'MODIFY_VER', 'BEGIN_DATE', 'HOLD_STATUS',
  'TPN_PARTNER_ID', 'SEG_SEGMENT_NO_DEPARTMENT', 'SALES_ID', 'PO_TYPE',
  'PAYMENT_TERM', 'PAYMENT_MODE', 'CURRENCY', 'EXCHANGE_RATE', 'TAX_RATE',
  'LINE_NO', 'MBP_PART', 'MBP_VER', 'ORDER_QTY_ORU', 'UNIT_OF_MEASURE_ORU',
  'UNIT_PRICE_ORU', 'DUEDATE', 'MBP_LOT_NO', 'REMARK', 'REMARK2', 'PACKING', 'SO_PROJECT_ID', 'TPN_PART_NO',
] as const

const DEF_EDIT: LineEdit = { mbp_ver: '1', uom: 'PCS', unit_price: '0', lot_no: '', remark2: '', so_line_no: '', packing: '' }

function fmtDate(d: Date) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/** 從銷售訂單號取出數字部分，例：WO240001 → 240001 */
function extractOrderNums(orderNo: string): string {
  return orderNo.replace(/\D/g, '')
}

/** 從「已有採購單號」的列（含尚未回寫本次 session 但已存在於出單表的既有紀錄）
 *  萃取每個銷售訂單數字部分（nums）已用過的最大序號，供 genRowPoNos 的 fallback
 *  計數器接續編號，避免重新載入/重試時計數器從 1 起算而與既有 PO 撞號。 */
function seedUsedSeq(rowsWithPoNo: Array<{ order_number: string; po_number?: string | null }>): Map<string, number> {
  const seed = new Map<string, number>()
  for (const r of rowsWithPoNo) {
    const poNo = (r.po_number ?? '').trim()
    if (!poNo) continue
    const nums = extractOrderNums(r.order_number)
    const prefix = `POO${nums}`
    if (!poNo.startsWith(prefix)) continue
    const seq = parseInt(poNo.slice(prefix.length), 10)
    if (Number.isNaN(seq)) continue
    if (seq > (seed.get(nums) ?? 0)) seed.set(nums, seq)
  }
  return seed
}

/** 為每筆來源列自動產生一物一單的採購單號
 *  最後兩碼 = match_line_no（SO 序號）；無序號時用逐游計數器補上。
 *  `seed` 帶入已使用過的最大序號（見 seedUsedSeq），確保計數器接續編號、不重新從 1 起算。 */
function genRowPoNos(rows: SourceRow[], seed: Map<string, number> = new Map()): string[] {
  const counters = new Map<string, number>(seed)
  return rows.map(row => {
    const nums = extractOrderNums(row.order_number)
    const lineNo = row.match_line_no != null ? parseInt(row.match_line_no, 10) : NaN
    if (!isNaN(lineNo) && lineNo > 0) {
      return `POO${nums}${String(lineNo).padStart(2, '0')}`
    }
    // fallback: sequential counter，接續在 seed（已使用過的最大序號）之後
    const count = (counters.get(nums) ?? 0) + 1
    counters.set(nums, count)
    return `POO${nums}${String(count).padStart(2, '0')}`
  })
}

function makeDefaultHeader(): PoHeader {
  return {
    modify_ver: '1', begin_date: fmtDate(new Date()),
    hold_status: 'UNSIGNED', tpn_partner_id: '42828690', department: 'M1100',
    sales_id: '10149', po_type: 'GENERAL', payment_term: 'PM30',
    payment_mode: 'T', currency: 'CNY', exchange_rate: '4', tax_rate: '0',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export default function PoBatchExportOPage() {
  const [unlocked, setUnlocked] = useState(false)
  const [pwInput, setPwInput]   = useState('')
  const [pwError, setPwError]   = useState(false)

  const [sourceRows, setSourceRows] = useState<SourceRow[]>([])
  const [lineEdits, setLineEdits]   = useState<LineEdit[]>([])
  const [rowPoNos, setRowPoNos]     = useState<string[]>([])   // 一物一單 — 逐列採購單號
  const [header, setHeader]         = useState<PoHeader>(makeDefaultHeader)
  const [headerOpen, setHeaderOpen] = useState(true)

  const [availDates, setAvailDates]       = useState<{ sheet_date: string; row_count: number }[]>([])
  const [datesLoading, setDatesLoading]   = useState(false)
  const [pickerDate, setPickerDate]       = useState('')
  const [loadedDate, setLoadedDate]       = useState<string | null>(null)

  const [importing, setImporting]         = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number; errors: string[] } | null>(null)
  const [matching, setMatching]           = useState(false)
  const [matchResults, setMatchResults]   = useState<MatchResult[]>([])
  const [msg, setMsg]                     = useState('')
  const [bulkPrice, setBulkPrice]         = useState('')
  const [poSearchId, setPoSearchId]       = useState('')
  const [poSearching, setPoSearching]     = useState(false)
  const [poSyncRows, setPoSyncRows]       = useState<Array<Record<string, unknown>> | null>(null)

  // ---- 匯入後自動同步進度 Modal ----
  type PostSyncStep = { label: string; status: 'pending' | 'running' | 'done' | 'error' }
  const [postSyncModal, setPostSyncModal] = useState<{ show: boolean; steps: PostSyncStep[]; error: string | null } | null>(null)

  // ── Init from localStorage（僅還原表頭設定）──
  useEffect(() => {
    try {
      const h = localStorage.getItem(HEADER_KEY)
      if (h) {
        const saved = JSON.parse(h)
        const def = makeDefaultHeader()
        const merged: PoHeader = { ...def, ...saved }
        for (const k of Object.keys(def) as (keyof PoHeader)[]) {
          if ((saved[k] ?? '') === '') (merged as unknown as Record<string, unknown>)[k] = def[k]
        }
        setHeader(merged)
      }
    } catch {}
  }, [])

  useEffect(() => { localStorage.setItem(HEADER_KEY, JSON.stringify(header)) }, [header])

  // ── Fetch sheet dates ──
  useEffect(() => {
    setDatesLoading(true)
    fetch('/api/argoerp/daily-order-sheet')
      .then(r => r.json())
      .then(j => {
        if (j.success) {
          setAvailDates(j.sheets ?? [])
          if (!pickerDate && j.sheets?.length) setPickerDate(j.sheets[0].sheet_date)
        }
      })
      .catch(() => {})
      .finally(() => setDatesLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load from sheet ──
  const loadSheet = useCallback(async (date: string) => {
    if (!date) return
    try {
      const r = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`, { cache: 'no-store' })
      const j = await r.json()
      if (!j.success || !j.sheet) { alert(`找不到 ${date} 的出單表`); return }
      type SheetRowRaw = SourceRow & { po_status?: string; po_number?: string | null; match_line_no?: string | null }
      const allORows = (j.sheet.rows ?? []).filter((x: SheetRowRaw) => x.factory === 'O')
      const rows: SourceRow[] = allORows
        .filter((x: SheetRowRaw) => !x.po_number && x.po_status !== 'matched' && x.po_status !== 'no_po')
        .map((x: SheetRowRaw) => ({ ...x, match_line_no: x.match_line_no ?? null }))
      if (allORows.length === 0) {
        alert(`${date} 出單表中沒有委外廠訂單`)
        return
      }
      if (rows.length === 0) {
        alert(`${date} 所有委外廠訂單（${allORows.length} 筆）均已有採購單紀錄`)
        return
      }
      setSourceRows(rows)
      setLineEdits(rows.map((row) => ({
        ...DEF_EDIT,
        lot_no: row.order_number,
        so_line_no: row.match_line_no ? String(parseInt(row.match_line_no, 10)) : '',
      })))
      // 種子帶入 allORows（含已有採購單號的列，不論是否本次載入）以避免計數器重新歸零撞號
      setRowPoNos(genRowPoNos(rows, seedUsedSeq(allORows)))
      setMatchResults([])
      setLoadedDate(date)
    } catch (e) { alert(`載入失敗：${e}`) }
  }, [])

  // ── Build ERP payload — 一物一單，LINE_NO 固定 1 ──
  const payload = useMemo<Array<Record<string, string>>>(() => {
    return sourceRows.map((row, i) => {
      const e = lineEdits[i] ?? DEF_EDIT
      const rec: Record<string, string> = {}
      rec['PROJECT_ID']                  = rowPoNos[i] ?? ''
      rec['MODIFY_VER']                  = header.modify_ver
      rec['BEGIN_DATE']                  = header.begin_date
      rec['HOLD_STATUS']                 = header.hold_status
      if (header.tpn_partner_id.trim()) rec['TPN_PARTNER_ID']            = header.tpn_partner_id.trim()
      if (header.department.trim())     rec['SEG_SEGMENT_NO_DEPARTMENT'] = header.department.trim()
      if (header.sales_id.trim())       rec['SALES_ID']                  = header.sales_id.trim()
      rec['PO_TYPE']                     = header.po_type
      if (header.payment_term.trim())   rec['PAYMENT_TERM']              = header.payment_term.trim()
      rec['PAYMENT_MODE']                = header.payment_mode
      rec['CURRENCY']                    = header.currency
      rec['EXCHANGE_RATE']               = header.exchange_rate
      rec['TAX_RATE']                    = header.tax_rate
      rec['LINE_NO']                     = '1'   // 一物一單固定 1
      rec['MBP_PART']                    = row.item_code
      rec['MBP_VER']                     = e.mbp_ver || '1'
      rec['ORDER_QTY_ORU']               = String(row.quantity ?? '').replace(/,/g, '')
      rec['UNIT_OF_MEASURE_ORU']         = e.uom || 'PCS'
      rec['UNIT_PRICE_ORU']              = e.unit_price || '0'
      rec['DUEDATE']                     = row.delivery_date
      if ((e.lot_no ?? '').trim())       rec['MBP_LOT_NO']               = e.lot_no.trim()
      const remark = [row.item_name, row.note].filter(Boolean).join(' ')
      if (remark)                        rec['REMARK']                   = remark
      if ((e.remark2 ?? '').trim())      rec['REMARK2']                  = e.remark2.trim()
      rec['SO_PROJECT_ID']               = row.order_number
      if ((e.packing ?? '').trim())      rec['PACKING']                  = e.packing.trim()
      if ((e.so_line_no ?? '').trim())   rec['TPN_PART_NO']              = e.so_line_no.trim()
      return rec
    })
  }, [sourceRows, lineEdits, rowPoNos, header])

  // ── Export CSV / XLSX（批次匯出，每列為一張獨立採購單）──
  const doExport = useCallback((fmt: 'csv' | 'xlsx' = 'csv') => {
    if (payload.length === 0) return
    const now = new Date()
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const fn = `ArgoERP_委外採購單_BATCH_${loadedDate ?? ts}_${ts}`
    const dataRows = payload.map(r => ERP_KEYS.map(k => r[k] ?? ''))
    if (fmt === 'xlsx') {
      const ws = XLSX.utils.aoa_to_sheet([[...ERP_KEYS], ...dataRows])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '委外採購批次')
      XLSX.writeFile(wb, `${fn}.xlsx`)
    } else {
      const lines = [[...ERP_KEYS].join(','), ...dataRows.map(row =>
        row.map(v => (v.includes(',') || v.includes('"') || v.includes('\n'))
          ? `"${v.replace(/"/g, '""')}"` : v).join(','),
      )]
      const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `${fn}.csv`; a.click()
      URL.revokeObjectURL(url)
    }
  }, [payload, loadedDate])

  // ---- 匯入成功後自動執行：ERP 採購單同步 → 整張出單表委外(O)列重新比對 → 存回 ----
  // 涵蓋這批匯入沒觸及到的、出單表裡其他還在等待比對的委外列，讓使用者匯入完直接回出單表
  // 就看得到結果，不用再手動去「ERP同步區」按同步、再回出單表按「一鍵同步」。
  const runPostImportSync = useCallback(async (sheetDate: string) => {
    const steps: PostSyncStep[] = [
      { label: 'ERP 同步：同步採購單', status: 'running' },
      { label: `重新比對採購單（${sheetDate}）`, status: 'pending' },
      { label: '儲存出單表', status: 'pending' },
    ]
    const setStep = (idx: number, status: PostSyncStep['status']) =>
      setPostSyncModal(prev => prev ? {
        ...prev,
        steps: prev.steps.map((s, i) => i === idx ? { ...s, status } : s),
      } : null)

    setPostSyncModal({ show: true, steps, error: null })
    try {
      // ── Step 0: ERP 同步採購單（IFAF044 採購單介面）───────────────
      const syncRes = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_po' }),
      })
      const syncJson = await syncRes.json()
      if (!syncRes.ok || syncJson.status !== 'ok') {
        throw new Error(`ERP 同步失敗：${String(syncJson.error ?? `HTTP ${syncRes.status}`)}`)
      }
      setStep(0, 'done')

      // ── 重新載入指定日期出單表 ───────────────────────────────────
      const sheetRes = await fetch(`/api/argoerp/daily-order-sheet?date=${sheetDate}`, { cache: 'no-store' })
      const sheetJson = await sheetRes.json()
      if (!sheetJson.success || !sheetJson.sheet) {
        setStep(1, 'done'); setStep(2, 'done')
        return
      }
      type DR = Record<string, unknown>
      let rows: DR[] = Array.isArray(sheetJson.sheet.rows) ? (sheetJson.sheet.rows as DR[]) : []
      const rawText: string = (sheetJson.sheet.raw_text as string) ?? ''
      if (rows.length === 0) {
        setStep(1, 'done'); setStep(2, 'done')
        return
      }

      // ── Step 1: 委外(O廠)採購單比對 ──────────────────────────────
      // 對整張出單表裡 factory === 'O' 的列重新比對，涵蓋這批匯入沒觸及到的其他委外列。
      setStep(1, 'running')
      const hasORows = rows.some(r => r.factory === 'O')
      if (hasORows) {
        type PoC = { doc_no: string; sub_no: string; item_code: string | null; qty: number; status: string | null; start_date: string | null; extra: Record<string, unknown> | null; _used: boolean }
        const matchPoRows = (rRows: DR[], pool: PoC[], sDate: string): DR[] => {
          return rRows.map(row => {
            if (row.factory !== 'O') return row
            if (row.po_status === 'no_po') return row
            if (row.po_confirmed && row.po_number) return row  // 使用者已人工確認採購單，保留
            const itemCode = row.item_code as string
            const qty = parseFloat(String(row.quantity ?? '').replace(/,/g, '')) || 0
            const matchLineNo = String(row.match_line_no ?? '').trim()
            const orderNo = String(row.order_number ?? '').trim()
            // P1: 料號 + 數量 + SO_PROJECT_ID
            let hitIdx = pool.findIndex(c =>
              !c._used && c.item_code === itemCode && c.qty === qty &&
              String(c.extra?.SO_PROJECT_ID ?? '').trim() === orderNo
            )
            // P2: 料號 + 數量 + MBP_LOT_NO
            if (hitIdx === -1)
              hitIdx = pool.findIndex(c =>
                !c._used && c.item_code === itemCode && c.qty === qty &&
                String(c.extra?.MBP_LOT_NO ?? '').trim() === orderNo
              )
            // P3（O 廠特有）: 料號 + TPN_PART_NO + SO/LOT 指向同一工單（不要求 qty 完全相符）
            if (hitIdx === -1 && matchLineNo)
              hitIdx = pool.findIndex(c =>
                !c._used && c.item_code === itemCode &&
                String(c.extra?.TPN_PART_NO ?? '') === matchLineNo &&
                (
                  String(c.extra?.SO_PROJECT_ID ?? '').trim() === orderNo ||
                  String(c.extra?.MBP_LOT_NO ?? '').trim() === orderNo
                )
              )
            // fallback: 料號 + 數量
            if (hitIdx === -1)
              hitIdx = pool.findIndex(c => !c._used && c.item_code === itemCode && c.qty === qty)
            if (hitIdx === -1) return { ...row, po_status: 'no_match' }
            const delivDateStr = String(row.delivery_date ?? sDate).replace(/\//g, '-')
            pool[hitIdx]._used = true
            const p3Mismatch = !!matchLineNo &&
              String(pool[hitIdx].extra?.TPN_PART_NO ?? '') === matchLineNo &&
              pool[hitIdx].qty !== qty
            return {
              ...row,
              po_number: pool[hitIdx].doc_no,
              po_sub_no: pool[hitIdx].sub_no,
              po_status: p3Mismatch ? 'qty_mismatch' : 'matched',
              po_qty_erp: p3Mismatch ? pool[hitIdx].qty : null,
              po_start_date: pool[hitIdx].start_date,
              po_extra: pool[hitIdx].extra,
              delivery_date: delivDateStr || sDate,
            }
          })
        }
        const itemCodesO = [...new Set(rows.filter(r => r.factory === 'O').map(r => r.item_code as string).filter(Boolean))]
        if (itemCodesO.length > 0) {
          const { data: poRowsO, error: poErr } = await supabase.from('erp_pj_sync')
            .select('doc_no, sub_no, item_code, qty, status, start_date, extra')
            .eq('doc_type', '採購單號').in('status', ['OPEN', 'UNSIGNED']).neq('customer_vendor', 'C01510').in('item_code', itemCodesO).order('doc_no', { ascending: false })
          if (poErr) throw poErr
          const poolO: PoC[] = (poRowsO ?? []).map((r: Record<string, unknown>) => ({ doc_no: r.doc_no as string, sub_no: r.sub_no as string, item_code: r.item_code as string | null, qty: Number(r.qty ?? 0), status: r.status as string | null, start_date: (r.start_date as string | null) ?? null, extra: (r.extra ?? null) as Record<string, unknown> | null, _used: false }))
          rows = matchPoRows(rows, poolO, sheetDate)
        }
      }
      setStep(1, 'done')

      // ── Step 2: 儲存出單表 ────────────────────────────────────────
      setStep(2, 'running')
      const saveRes = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: sheetDate, raw_text: rawText, rows }),
      })
      const saveJson = await saveRes.json()
      if (!saveRes.ok || !saveJson.success) throw new Error(saveJson.error || `HTTP ${saveRes.status}`)
      setStep(2, 'done')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setPostSyncModal(prev => prev ? {
        ...prev,
        steps: prev.steps.map(s => s.status === 'running' ? { ...s, status: 'error' } : s),
        error: msg,
      } : null)
    }
  }, [supabase])

  // ── Import to ERP — 逐張採購單送出 ──
  const handleImport = useCallback(async () => {
    if (!header.tpn_partner_id.trim()) { alert('請填寫廠商編號'); return }
    if (payload.length === 0) { alert('尚無明細資料'); return }
    const emptyPoNos = rowPoNos.slice(0, payload.length).filter(p => !p.trim())
    if (emptyPoNos.length > 0) { alert(`有 ${emptyPoNos.length} 筆採購單號為空，請確認`); return }
    // 重複單號防呆：同批次內若有重複採購單號，代表產號邏輯異常或手動修改衝突，
    // 一旦送出會有覆蓋 ARGO 既有採購單的風險，直接擋下不允許匯入
    const dupCounts = new Map<string, number>()
    rowPoNos.slice(0, payload.length).forEach(p => {
      const key = p.trim()
      dupCounts.set(key, (dupCounts.get(key) ?? 0) + 1)
    })
    const dupPoNos = [...dupCounts.entries()].filter(([, c]) => c > 1).map(([k]) => k)
    if (dupPoNos.length > 0) {
      alert(`⚠️ 偵測到重複採購單號，可能導致覆蓋既有 ARGO 採購單，請先修正再匯入：\n${dupPoNos.join(', ')}`)
      return
    }
    if (!confirm(`確認逐張匯入 ${payload.length} 張委外採購單至 ArgoERP？`)) return

    setImporting(true); setMsg('')
    setImportProgress({ done: 0, total: payload.length, errors: [] })
    const errors: string[] = []
    const warnings: string[] = []
    const succeededIdx: number[] = []

    for (let i = 0; i < payload.length; i++) {
      try {
        const res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'import', interfaceId: 'IFAF024', data: [payload[i]] }),
        })
        const result = await res.json()
        // 讀取 partialSuccess/anySuccess：ARGO 有時 success=false 但實際已建立資料（帶警示字串），
        // 若只看 success 布林值會把「已成功建立」的列誤判為失敗，導致使用者重試時重複送出、
        // 甚至可能覆蓋 ARGO 中已建立的採購單。anySuccess=true 即視為該列已在 ARGO 建立成功。
        const rowOk = res.ok && (result?.success === true || result?.anySuccess === true)
        if (rowOk) {
          succeededIdx.push(i)
          if (result?.success !== true) {
            const tag = result?.partialSuccess ? '部分成功（ARGO 已建立但明細/其他欄位有警示）' : 'ARGO 已建立但回應含警示'
            warnings.push(`${rowPoNos[i]}: ⚠️ ${tag}${result?.error ? ` — ${result.error}` : ''}`)
          }
        } else {
          const raw = typeof result?.rawText === 'string'
            ? result.rawText.slice(0, 200)
            : JSON.stringify(result?.apiResult ?? '').slice(0, 200)
          errors.push(`${rowPoNos[i]}: ${result?.error || `HTTP ${res.status}`} — ${raw}`)
        }
      } catch (e) {
        errors.push(`${rowPoNos[i]}: ${e instanceof Error ? e.message : String(e)}`)
      }
      setImportProgress({ done: i + 1, total: payload.length, errors: [...errors] })
    }

    // 匯入成功（含部分成功）的列立即回寫採購單號到出單表。
    // 這是避免撞號的關鍵根因修正：若不回寫，下次載入/重試時系統不知道哪些單號已經用過，
    // fallback 計數器會重新從 1 編號，可能與剛剛已成功建立的 PO 撞號甚至覆蓋。
    let writeBackError = ''
    if (succeededIdx.length > 0 && loadedDate) {
      try {
        const updates = succeededIdx
          .filter(i => sourceRows[i]?.row_key)
          .map(i => ({ row_key: sourceRows[i].row_key!, po_number: rowPoNos[i], po_status: 'matched' }))
        if (updates.length > 0) {
          const wbRes = await fetch('/api/argoerp/daily-order-sheet', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sheet_date: loadedDate, updates }),
          })
          const wbJson = await wbRes.json()
          if (!wbJson.success) throw new Error(wbJson.error ?? '回寫失敗')
        }
      } catch (e) {
        writeBackError = e instanceof Error ? e.message : String(e)
      }
    }

    // ── 匯入成功後自動同步 ──
    // 額外再做一次完整的 ERP 採購單同步 + 全表重新比對，涵蓋這批匯入沒觸及到的、
    // 出單表裡其他還在等待比對的委外列，讓使用者匯入完直接回出單表就看得到結果，
    // 不用再手動去「ERP同步區」按同步、再回出單表按「一鍵同步」。
    // loadedDate 為本次實際載入的出單表日期（closure 捕捉的當下值，不受下方 setLoadedDate 影響）。
    if (succeededIdx.length > 0 && loadedDate) {
      void runPostImportSync(loadedDate)
    }

    const succeededSet = new Set(succeededIdx)
    const successCount = succeededIdx.length
    const detailParts: string[] = []
    if (errors.length) detailParts.push(`失敗明細：\n${errors.slice(0, 10).join('\n')}${errors.length > 10 ? `\n…（共 ${errors.length} 筆）` : ''}`)
    if (warnings.length) detailParts.push(`警示明細（已視為成功，不會重複送出）：\n${warnings.slice(0, 10).join('\n')}`)
    if (writeBackError) detailParts.push(`⚠️ 採購單號回寫出單表失敗，成功匯入的項目下次載入時可能無法被排除（請盡快手動執行「回寫採購單號」）：${writeBackError}`)

    if (successCount === payload.length) {
      const m = warnings.length > 0
        ? `✅ 全部 ${payload.length} 張委外採購單已匯入 ERP（${warnings.length} 筆含警示，請確認）`
        : `✅ 全部 ${payload.length} 張委外採購單已匯入 ERP`
      setMsg(m); alert(detailParts.length ? `${m}\n\n${detailParts.join('\n\n')}` : m)
      setSourceRows([]); setLineEdits([]); setRowPoNos([]); setMatchResults([]); setLoadedDate(null)
    } else {
      // 只保留尚未成功的列，避免使用者在同一 session 內立即重試時重複送出已成功的品項
      const keepIndices = sourceRows.map((_, i) => i).filter(i => !succeededSet.has(i))
      setSourceRows(prev => keepIndices.map(i => prev[i]))
      setLineEdits(prev => keepIndices.map(i => prev[i] ?? DEF_EDIT))
      setRowPoNos(prev => keepIndices.map(i => prev[i] ?? ''))
      setMatchResults(prev => keepIndices.map(i => prev[i] ?? { status: null, line_no: null, reason: '' }))
      const m = `⚠️ 匯入完成：${successCount} 成功，${errors.length} 失敗（已成功項目已回寫並自清單移除，避免重複送出）`
      setMsg(m)
      alert(`${m}${detailParts.length ? `\n\n${detailParts.join('\n\n')}` : ''}`)
    }
    setImporting(false)
    setTimeout(() => { setImportProgress(null); if (!msg.startsWith('⚠️')) setMsg('') }, 15000)
  }, [payload, rowPoNos, sourceRows, loadedDate, header.tpn_partner_id, msg, runPostImportSync])

  const setH = useCallback(<K extends keyof PoHeader>(k: K, v: PoHeader[K]) => {
    setHeader(p => ({ ...p, [k]: v }))
  }, [])

  const setLE = useCallback((i: number, k: keyof LineEdit, v: string) => {
    setLineEdits(p => p.map((e, j) => j === i ? { ...e, [k]: v } : e))
  }, [])

  const setRowPoNo = useCallback((i: number, v: string) => {
    setRowPoNos(p => p.map((n, j) => j === i ? v : n))
  }, [])

  const applyBulkPrice = useCallback(() => {
    if (!bulkPrice.trim()) return
    setLineEdits(p => p.map(e => ({ ...e, unit_price: bulkPrice.trim() })))
    setBulkPrice('')
  }, [bulkPrice])

  const handleClearAll = useCallback(() => {
    setSourceRows([]); setLineEdits([]); setRowPoNos([]); setMatchResults([]); setLoadedDate(null)
    setImportProgress(null)
  }, [])

  // ── 移除已匯入項目（查 erp_pj_sync doc_no IN rowPoNos）──
  const [removingImported, setRemovingImported] = useState(false)
  const removeImported = useCallback(async () => {
    if (sourceRows.length === 0) return
    const allPoNos = rowPoNos.filter(p => p.trim())
    if (allPoNos.length === 0) return
    setRemovingImported(true)
    try {
      const { data, error } = await supabase
        .from('erp_pj_sync')
        .select('doc_no')
        .eq('doc_type', '採購單號')
        .in('doc_no', allPoNos)
      if (error) throw error
      const importedPoNos = new Set((data ?? []).map(r => String(r.doc_no ?? '').trim()))
      if (importedPoNos.size === 0) {
        setMsg('⚠️ erp_pj_sync 查無任何已匯入採購單，請先至 ERP 同步區執行 PO 同步')
        setTimeout(() => setMsg(''), 6000)
        return
      }
      const keepIndices = sourceRows.map((_, i) => i).filter(i => !importedPoNos.has(rowPoNos[i] ?? ''))
      const removedCount = sourceRows.length - keepIndices.length
      if (removedCount === 0) {
        setMsg(`ℹ️ 查無已匯入行（erp_pj_sync 有 ${importedPoNos.size} 筆採購單，但採購單號未對應）`)
        setTimeout(() => setMsg(''), 6000)
        return
      }
      setSourceRows(prev => keepIndices.map(i => prev[i]))
      setLineEdits(prev => keepIndices.map(i => prev[i] ?? DEF_EDIT))
      setRowPoNos(prev => keepIndices.map(i => prev[i] ?? ''))
      setMatchResults(prev => keepIndices.map(i => prev[i] ?? { status: null, line_no: null, reason: '' }))
      setMsg(`✅ 已移除 ${removedCount} 筆已匯入採購單（${[...importedPoNos].sort().join(', ')}），剩餘 ${keepIndices.length} 筆`)
      setTimeout(() => setMsg(''), 8000)
    } catch (e) {
      setMsg(`❌ 查詢失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setMsg(''), 6000)
    } finally { setRemovingImported(false) }
  }, [sourceRows, rowPoNos])

  // ── 查詢 ERP 同步区採購單 (erp_pj_sync) ──
  const searchPoSync = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) return
    setPoSearching(true)
    try {
      const { data, error } = await supabase
        .from('erp_pj_sync')
        .select('doc_no,sub_no,item_code,description,qty,unit,status,start_date,end_date,customer_vendor,remark,extra,synced_at')
        .eq('doc_type', '採購單號')
        .ilike('doc_no', `%${trimmed}%`)
        .order('doc_no', { ascending: true })
        .order('sub_no', { ascending: true })
        .limit(200)
      if (error) throw error
      setPoSyncRows(data ?? [])
    } catch (e) {
      setMsg(`❌ 查詢失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setMsg(''), 6000)
    } finally { setPoSearching(false) }
  }, [])

  // ── 回寫採購單號到每日出單表（各列使用自己的採購單號）──
  const [syncingPoBack, setSyncingPoBack] = useState(false)
  const syncPoNumberBack = useCallback(async () => {
    if (!loadedDate) { alert('尚未載入出單表日期'); return }
    if (sourceRows.length === 0) return
    setSyncingPoBack(true); setMsg('')
    try {
      const updates = sourceRows
        .filter((r, i) => r.row_key && (rowPoNos[i] ?? '').trim())
        .map((r, i) => ({ row_key: r.row_key!, po_number: rowPoNos[i], po_status: 'matched' }))
      if (updates.length === 0) { setMsg('⚠️ 來源資料無 row_key，無法回寫'); setTimeout(() => setMsg(''), 5000); return }
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: loadedDate, updates }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error ?? '回寫失敗')
      setMsg(`✅ 已將 ${updates.length} 筆委外訂單的採購單號逐列回寫至 ${loadedDate} 出單表`)
      setTimeout(() => setMsg(''), 8000)
    } catch (e) {
      setMsg(`❌ 回寫失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setMsg(''), 6000)
    } finally { setSyncingPoBack(false) }
  }, [loadedDate, sourceRows, rowPoNos])

  // ── 來源序號比對 (erp_so_lines) ──
  const runSerialMatch = useCallback(async () => {
    if (sourceRows.length === 0) return
    setMatching(true); setMsg('')
    try {
      const orderNumbers = [...new Set(sourceRows.map(r => r.order_number).filter(Boolean))]
      const { data: soLines, error } = await supabase
        .from('erp_so_lines')
        .select('project_id, line_no, mbp_part, order_qty_oru, unit_of_measure_oru, remark2, packing')
        .in('project_id', orderNumbers.length > 0 ? orderNumbers : ['__none__'])
      if (error) throw error
      const lines = soLines ?? []
      const soProjectIds = new Set(lines.map((l: { project_id: string }) => l.project_id))
      type SoLine = { project_id: string; line_no: unknown; mbp_part: string | null; order_qty_oru: unknown; unit_of_measure_oru: string | null; remark2: string | null; packing: string | null }
      const candidateMap = new Map<string, string[]>()
      const soLineInfoMap = new Map<string, { uom: string | null; remark2: string | null; packing: string | null }>()
      for (const line of (lines as SoLine[])) {
        const qty = Number(line.order_qty_oru ?? 0)
        const key = `${line.project_id}|${line.mbp_part ?? ''}|${qty}`
        if (!candidateMap.has(key)) candidateMap.set(key, [])
        candidateMap.get(key)!.push(String(line.line_no ?? ''))
        soLineInfoMap.set(`${line.project_id}|${String(line.line_no ?? '')}`, { uom: line.unit_of_measure_oru, remark2: line.remark2, packing: line.packing })
      }
      for (const arr of candidateMap.values())
        arr.sort((a, b) => (Number(a) || 0) - (Number(b) || 0))
      const usageCounter = new Map<string, number>()

      const results: MatchResult[] = sourceRows.map(src => {
        if (!src.order_number || !soProjectIds.has(src.order_number))
          return { status: 'no_order', line_no: null, reason: '無對應來源單號' }
        const qty = parseFloat(String(src.quantity).replace(/,/g, '')) || 0
        const key = `${src.order_number}|${src.item_code}|${qty}`
        const candidates = candidateMap.get(key) ?? []
        if (candidates.length === 0)
          return { status: 'no_qty_match', line_no: null, reason: '有來源單號但無對應數量' }
        const used = usageCounter.get(key) ?? 0
        usageCounter.set(key, used + 1)
        // 候選數量用盡時不可強制夾住重複使用最後一筆候選，否則兩筆不同來源列會產生
        // 相同的 SO 序號/採購單號，其中一筆需求其實從未在 ARGO 真正建立卻被誤判為比對成功。
        // 用盡時改標記為需人工處理，不指派 line_no。
        if (used >= candidates.length)
          return { status: 'exhausted', line_no: null, reason: `候選序號已用盡（僅 ${candidates.length} 筆符合，本列為第 ${used + 1} 筆重複需求），需人工確認序號` }
        const lineNo = candidates[used]
        return { status: 'matched', line_no: lineNo, reason: '' }
      })
      setMatchResults(results)
      setLineEdits(prev => prev.map((e, i) => {
        if (results[i]?.status !== 'matched' || !results[i].line_no) return e
        const lineNo = results[i].line_no!
        const soInfo = soLineInfoMap.get(`${sourceRows[i]?.order_number ?? ''}|${lineNo}`)
        return {
          ...e,
          so_line_no: lineNo,
          uom:        soInfo?.uom || e.uom,
          remark2:    soInfo?.remark2 ?? e.remark2,
          packing:    soInfo?.packing ?? e.packing,
        }
      }))
      const matched = results.filter(r => r.status === 'matched').length
      const exhausted = results.filter(r => r.status === 'exhausted').length
      setMsg(`✅ 序號比對完成：成功 ${matched} / ${results.length}${exhausted > 0 ? `（${exhausted} 筆候選用盡，需人工確認）` : ''}`)
      setTimeout(() => setMsg(''), 5000)
    } catch (e) {
      setMsg(`❌ 比對失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setMsg(''), 6000)
    } finally { setMatching(false) }
  }, [sourceRows])

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────
  if (!unlocked) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-8 w-80 flex flex-col items-center gap-4">
          <div className="text-2xl">🔒</div>
          <h2 className="text-white font-semibold text-lg">委外請購</h2>
          <p className="text-slate-400 text-sm">請輸入密碼以繼續</p>
          <input
            type="password"
            value={pwInput}
            onChange={e => { setPwInput(e.target.value); setPwError(false) }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (pwInput === '666') { setUnlocked(true) }
                else { setPwError(true); setPwInput('') }
              }
            }}
            placeholder="密碼"
            autoFocus
            className={`w-full px-4 py-2 rounded-lg bg-slate-800 border text-white text-center tracking-widest focus:outline-none ${
              pwError ? 'border-red-500' : 'border-slate-600 focus:border-cyan-500'
            }`}
          />
          {pwError && <p className="text-red-400 text-xs">密碼錯誤</p>}
          <button
            onClick={() => {
              if (pwInput === '666') { setUnlocked(true) }
              else { setPwError(true); setPwInput('') }
            }}
            className="w-full py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors"
          >
            進入
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1800px] mx-auto">

        {/* ── Page Header ── */}
        <div className="mb-6 border-b border-slate-800 pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">出單表➜委外採購</h1>
            <p className="text-slate-400 mt-1 text-sm">
              ArgoERP — 每日出單表（委外 O）→ IFAF024 採購訂單（PO）｜
              <span className="text-orange-400 font-medium">一物一單</span>：採購單號 = POO + 銷售訂單數字 + 序號
            </p>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            {datesLoading ? (
              <span className="text-slate-500 text-sm px-2">讀取出單表…</span>
            ) : (
              <>
                <select
                  value={pickerDate}
                  onChange={e => setPickerDate(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-sm focus:outline-none focus:border-orange-500"
                >
                  <option value="">選擇出單日期…</option>
                  {availDates.map(s => (
                    <option key={s.sheet_date} value={s.sheet_date}>{s.sheet_date}（{s.row_count} 筆）</option>
                  ))}
                </select>
                <button
                  onClick={() => loadSheet(pickerDate)}
                  disabled={!pickerDate}
                  className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
                >
                  📋 載入出單表
                </button>
                {loadedDate && (
                  <span className="text-xs px-2 py-1 rounded border bg-orange-900/40 text-orange-300 border-orange-700/50">
                    已載入 {loadedDate}
                  </span>
                )}
              </>
            )}
            {sourceRows.length > 0 && (
              <>
                <button
                  onClick={() => void runSerialMatch()}
                  disabled={matching || importing}
                  className="px-4 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
                >
                  {matching ? '比對中…' : '🔍 來源序號比對'}
                </button>
                <button
                  onClick={() => void handleImport()}
                  disabled={importing || matching}
                  className="px-4 py-2 rounded-lg bg-orange-700 hover:bg-orange-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold transition-colors text-sm"
                >
                  {importing
                    ? `匯入中 ${importProgress?.done ?? 0}/${importProgress?.total ?? 0}…`
                    : `🚀 逐張匯入 ERP（${sourceRows.length} 張）`}
                </button>
                <button
                  onClick={handleClearAll}
                  className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:bg-red-900/40 hover:text-red-300 hover:border-red-700/50 transition-colors text-sm"
                >
                  全部清空
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Message bar ── */}
        {msg && (
          <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${msg.startsWith('❌') ? 'bg-red-900/30 border border-red-700 text-red-300' : 'bg-emerald-900/30 border border-emerald-700 text-emerald-300'}`}>
            {msg}
          </div>
        )}

        {/* ── Import progress bar ── */}
        {importProgress && (
          <div className="mb-4 bg-slate-900 border border-orange-800/40 rounded-lg px-4 py-3">
            <div className="flex items-center justify-between mb-2 text-xs text-slate-400">
              <span>匯入進度：{importProgress.done} / {importProgress.total} 張</span>
              <span className={importProgress.errors.length > 0 ? 'text-red-400' : 'text-emerald-400'}>
                {importProgress.errors.length > 0 ? `${importProgress.errors.length} 筆失敗` : '全部成功'}
              </span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${importProgress.errors.length > 0 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${(importProgress.done / importProgress.total) * 100}%` }}
              />
            </div>
            {importProgress.errors.length > 0 && (
              <div className="mt-2 text-xs text-red-400 space-y-0.5 max-h-20 overflow-y-auto">
                {importProgress.errors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
          </div>
        )}

        {/* ── PO 共用表頭設定（不含採購單號 — 一物一單各自產生）── */}
        <div className="mb-6 bg-slate-900 border border-orange-800/40 rounded-lg overflow-hidden">
          <button
            onClick={() => setHeaderOpen(p => !p)}
            className="w-full px-4 py-3 flex items-center justify-between text-left bg-orange-900/20 hover:bg-orange-900/30 transition-colors"
          >
            <span className="text-sm font-semibold text-orange-300">
              📋 採購單共用表頭設定（IFAF024 Header）
              <span className="ml-2 text-xs font-normal text-slate-400">採購單號由銷售訂單自動產生，可於明細表逐列修改</span>
            </span>
            <span className="text-slate-400 text-sm">{headerOpen ? '▲ 收起' : '▼ 展開'}</span>
          </button>
          {headerOpen && (
            <div className="px-4 py-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">開立日期 <span className="text-red-400">*</span></label>
                <input value={header.begin_date} onChange={e => setH('begin_date', e.target.value)}
                  placeholder="YYYY/MM/DD"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">訂單狀態 <span className="text-red-400">*</span></label>
                <select value={header.hold_status} onChange={e => setH('hold_status', e.target.value as PoHeader['hold_status'])}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none">
                  <option value="UNSIGNED">UNSIGNED</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">廠商編號 <span className="text-red-400">*</span></label>
                <input value={header.tpn_partner_id} onChange={e => setH('tpn_partner_id', e.target.value)}
                  placeholder="GLAF004 廠商代碼"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">部門 <span className="text-red-400">*</span></label>
                <input value={header.department} onChange={e => setH('department', e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">業務員 <span className="text-red-400">*</span></label>
                <input value={header.sales_id} onChange={e => setH('sales_id', e.target.value)}
                  placeholder="員工編號"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">訂單類別 <span className="text-red-400">*</span></label>
                <select value={header.po_type} onChange={e => setH('po_type', e.target.value as PoHeader['po_type'])}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none">
                  <option value="GENERAL">GENERAL（一般）</option>
                  <option value="IMPORT">IMPORT（進口/L/C）</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">付款條件 <span className="text-red-400">*</span></label>
                <input value={header.payment_term} onChange={e => setH('payment_term', e.target.value)}
                  placeholder="GLAF005 條件代碼"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">付款方式 <span className="text-red-400">*</span></label>
                <select value={header.payment_mode} onChange={e => setH('payment_mode', e.target.value as PoHeader['payment_mode'])}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none">
                  <option value="T">T — T/T</option>
                  <option value="C">C — Cash</option>
                  <option value="L">L — LCM</option>
                  <option value="N">N — Bills</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">幣別 <span className="text-red-400">*</span></label>
                <input value={header.currency} onChange={e => setH('currency', e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">匯率 <span className="text-red-400">*</span></label>
                <input value={header.exchange_rate} onChange={e => setH('exchange_rate', e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">稅率 <span className="text-red-400">*</span></label>
                <input value={header.tax_rate} onChange={e => setH('tax_rate', e.target.value)}
                  placeholder="0.05 / 0.13 / 0"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400" />
              </div>
            </div>
          )}
        </div>

        {/* ── Status bar ── */}
        <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">出單表</div>
              <div className={`font-semibold truncate ${loadedDate ? 'text-orange-300' : 'text-slate-600'}`}>{loadedDate ?? '未載入'}</div>
            </div>
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">模式</div>
              <div className="font-semibold text-orange-300">一物一單</div>
            </div>
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">待匯採購單數</div>
              <div className={`font-bold ${sourceRows.length > 0 ? 'text-orange-300' : 'text-slate-600'}`}>
                {sourceRows.length} <span className="text-slate-500 font-normal text-xs">張</span>
              </div>
            </div>
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">廠商編號</div>
              <div className={`font-mono text-sm ${header.tpn_partner_id ? 'text-white' : 'text-red-400'}`}>
                {header.tpn_partner_id || '⚠ 未填寫'}
              </div>
            </div>
          </div>
        </div>

        {/* ── Line items table ── */}
        {sourceRows.length > 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 bg-orange-900/20 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-orange-300">
                採購明細（{sourceRows.length} 張，一物一單）
                <span className="text-xs text-slate-400 font-normal ml-2">採購單號可逐列修改</span>
              </h2>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => void removeImported()}
                  disabled={removingImported || importing}
                  className="px-3 py-1 rounded bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 disabled:opacity-40 transition-colors text-xs"
                >
                  {removingImported ? '查詢中…' : '移除已匯入'}
                </button>
                <button
                  onClick={() => void syncPoNumberBack()}
                  disabled={syncingPoBack || importing}
                  className="px-3 py-1 rounded bg-sky-900/50 border border-sky-700/50 text-sky-300 hover:bg-sky-800/50 disabled:opacity-40 transition-colors text-xs"
                >
                  {syncingPoBack ? '回寫中…' : '📝 回寫採購單號'}
                </button>
                <button
                  onClick={() => doExport('csv')}
                  className="px-3 py-1 rounded bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 transition-colors text-xs"
                >
                  ↓ CSV
                </button>
                <span className="text-xs text-slate-500">批量單價：</span>
                <input
                  value={bulkPrice}
                  onChange={e => setBulkPrice(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && applyBulkPrice()}
                  placeholder="單價"
                  className="w-20 px-2 py-1 rounded bg-slate-800 border border-orange-700/60 text-orange-200 text-xs text-right focus:outline-none focus:border-orange-400"
                />
                <button
                  onClick={applyBulkPrice}
                  disabled={!bulkPrice.trim()}
                  className="px-3 py-1 rounded bg-orange-800/70 border border-orange-700/50 text-orange-200 hover:bg-orange-700 disabled:opacity-40 transition-colors text-xs"
                >
                  套用
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/80 border-b border-slate-700">
                    <th className="px-2 py-3 text-center text-slate-500 font-mono text-xs w-8">#</th>
                    <th className="px-3 py-3 text-left text-orange-300 font-medium text-xs whitespace-nowrap">採購單號 *</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">銷售訂單</th>
                    <th className="px-3 py-3 text-center text-indigo-300 font-medium text-xs whitespace-nowrap">比對序號</th>
                    <th className="px-3 py-3 text-center text-sky-300 font-medium text-xs whitespace-nowrap">SO序號</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">貨號</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs">品名/規格 / 批號</th>
                    <th className="px-3 py-3 text-right text-slate-300 font-medium text-xs whitespace-nowrap">數量</th>
                    <th className="px-3 py-3 text-center text-orange-300 font-medium text-xs whitespace-nowrap">單位</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">交貨日</th>
                    <th className="px-3 py-3 text-left text-orange-300 font-medium text-xs whitespace-nowrap">備註2 / 包裝</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceRows.map((row, i) => (
                    <tr key={i} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-900/40'} hover:bg-slate-800/50`}>
                      <td className="px-2 py-1.5 text-center text-slate-500 font-mono text-xs">{i + 1}</td>
                      <td className="px-1 py-1">
                        <input
                          value={rowPoNos[i] ?? ''}
                          onChange={e => setRowPoNo(i, e.target.value)}
                          className="w-36 px-2 py-1 rounded bg-slate-800 border border-orange-600/60 text-orange-200 text-xs font-mono focus:outline-none focus:border-orange-400"
                        />
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-300 whitespace-nowrap">{row.order_number || '—'}</td>
                      <td className="px-3 py-1.5 text-center">
                        {matchResults[i]?.status === 'matched' && matchResults[i].line_no ? (
                          <span className="px-2 py-0.5 rounded border text-xs font-mono bg-emerald-900/40 text-emerald-300 border-emerald-700/50">{matchResults[i].line_no}</span>
                        ) : matchResults[i]?.status === 'no_order' ? (
                          <span className="px-1.5 py-0.5 rounded border text-xs bg-red-900/30 text-red-300 border-red-800/50" title={matchResults[i].reason}>無單號</span>
                        ) : matchResults[i]?.status === 'no_qty_match' ? (
                          <span className="px-1.5 py-0.5 rounded border text-xs bg-amber-900/30 text-amber-300 border-amber-700/50" title={matchResults[i].reason}>數量不符</span>
                        ) : matchResults[i]?.status === 'exhausted' ? (
                          <span className="px-1.5 py-0.5 rounded border text-xs bg-fuchsia-900/30 text-fuchsia-300 border-fuchsia-700/50" title={matchResults[i].reason}>候選用盡⚠</span>
                        ) : (
                          <span className="text-slate-700 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-1 py-1">
                        <input value={lineEdits[i]?.so_line_no ?? ''} onChange={e => setLE(i, 'so_line_no', e.target.value)}
                          className="w-14 px-2 py-1 rounded bg-slate-800 border border-sky-700/50 text-sky-200 text-xs text-center focus:outline-none focus:border-sky-400" />
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-300 whitespace-nowrap">{row.item_code || '—'}</td>
                      <td className="px-3 py-1.5 max-w-[220px]">
                        <div className="text-xs text-slate-300 truncate" title={[row.item_name, row.note].filter(Boolean).join(' ')}>
                          {[row.item_name, row.note].filter(Boolean).join(' ') || '—'}
                        </div>
                        <input value={lineEdits[i]?.lot_no ?? ''} onChange={e => setLE(i, 'lot_no', e.target.value)}
                          placeholder="批號…"
                          className="mt-1 w-full px-2 py-0.5 rounded bg-slate-800 border border-orange-700/40 text-white text-xs focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-3 py-1.5 text-right text-xs text-slate-300 whitespace-nowrap">{row.quantity}</td>
                      <td className="px-1 py-1">
                        <input value={lineEdits[i]?.uom ?? 'PCS'} onChange={e => setLE(i, 'uom', e.target.value)}
                          className="w-14 px-2 py-1 rounded bg-slate-800 border border-orange-700/40 text-white text-xs text-center focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-3 py-1.5 text-xs text-yellow-400/80 whitespace-nowrap">{row.delivery_date || '—'}</td>
                      <td className="px-1 py-1.5">
                        <input value={lineEdits[i]?.remark2 ?? ''} onChange={e => setLE(i, 'remark2', e.target.value)}
                          placeholder="備註2…"
                          className="w-28 px-2 py-1 rounded bg-slate-800 border border-orange-700/40 text-white text-xs focus:outline-none focus:border-orange-400" />
                        <input value={lineEdits[i]?.packing ?? ''} onChange={e => setLE(i, 'packing', e.target.value)}
                          placeholder="包裝方式…"
                          className="mt-1 w-28 px-2 py-1 rounded bg-slate-800 border border-sky-700/40 text-sky-200 text-xs focus:outline-none focus:border-sky-400" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-12 text-center">
            <p className="text-slate-500">尚無明細，請選擇出單日期並載入</p>
            <p className="text-slate-600 text-xs mt-2">
              自動篩選廠別「委外（O）」且尚未有採購單紀錄的訂單<br />
              每個品項自動產生獨立採購單號：POO + 銷售訂單數字 + 序號（01、02…）
            </p>
          </div>
        )}

        {/* ── 欄位對應說明 ── */}
        {sourceRows.length > 0 && (
          <details className="mt-6">
            <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-400 mb-2">IFAF024 欄位對應說明</summary>
            <div className="bg-slate-900/50 border border-orange-800/20 rounded-lg p-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
                <div className="col-span-full text-orange-300 font-semibold mb-1">表頭（Header）— 一物一單，每筆各自一張採購單</div>
                {[
                  ['PROJECT_ID', '採購單號（POO+銷售訂單數字+序號，可逐列修改）'],
                  ['MODIFY_VER', '變更版本（預設 1）'],
                  ['BEGIN_DATE', '開立日期（共用設定）'],
                  ['HOLD_STATUS', '訂單狀態（預設 OPEN）'],
                  ['TPN_PARTNER_ID', '廠商編號（共用設定）'],
                  ['SEG_SEGMENT_NO_DEPARTMENT', '部門（共用設定）'],
                  ['SALES_ID', '業務員（共用設定）'],
                  ['PO_TYPE', '訂單類別（GENERAL）'],
                  ['PAYMENT_TERM', '付款條件（共用設定）'],
                  ['PAYMENT_MODE', '付款方式（T=T/T）'],
                  ['CURRENCY', '幣別'],
                  ['EXCHANGE_RATE', '匯率'],
                  ['TAX_RATE', '稅率'],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="text-slate-500 w-36 shrink-0 font-mono">{k}</span>
                    <span className="text-orange-300">{v}</span>
                  </div>
                ))}
                <div className="col-span-full text-orange-300 font-semibold mt-3 mb-1">明細（Line）— 固定 LINE_NO=1（一物一單）</div>
                {[
                  ['LINE_NO', '固定 1（每張採購單僅一筆明細）'],
                  ['MBP_PART', '品項編碼'],
                  ['ORDER_QTY_ORU', '數量'],
                  ['UNIT_OF_MEASURE_ORU', '採購單位（可逐列修改）'],
                  ['UNIT_PRICE_ORU', '單價（可逐列修改）'],
                  ['DUEDATE', '交貨日期'],
                  ['REMARK', '品名規格+備註'],
                  ['SO_PROJECT_ID', '銷售訂單（工單編號）'],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="text-slate-500 w-36 shrink-0 font-mono">{k}</span>
                    <span className="text-orange-300">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}

        {/* ── ERP 採購單同步確認 ── */}
        <div className="mt-8 bg-slate-900 border border-slate-700 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-sm font-semibold text-slate-200">🔎 ERP 同步確認 — 採購單號查詢</h2>
              {poSearching && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-slate-700 text-slate-400 animate-pulse">查詢中…</span>
              )}
              {!poSearching && poSyncRows === null && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-slate-800 border border-slate-700 text-slate-500">未查詢</span>
              )}
              {!poSearching && poSyncRows !== null && poSyncRows.length === 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-red-900/40 border border-red-800/50 text-red-300">查無資料</span>
              )}
              {!poSearching && poSyncRows !== null && poSyncRows.length > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-emerald-900/40 border border-emerald-700/50 text-emerald-300">✓ {poSyncRows.length} 筆</span>
              )}
              <p className="text-xs text-slate-500 w-full mt-0">查詢 erp_pj_sync，doc_type=採購單號；輸入前綴 POO 可查詢全部委外採購單</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={poSearchId}
                onChange={e => setPoSearchId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void searchPoSync(poSearchId)}
                placeholder="輸入採購單號前綴…"
                className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm w-48 focus:outline-none focus:border-orange-400 font-mono placeholder:text-slate-500"
              />
              <button
                onClick={() => void searchPoSync(poSearchId)}
                disabled={poSearching || !poSearchId.trim()}
                className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-medium transition-colors"
              >
                {poSearching ? '查詢中…' : '查詢'}
              </button>
            </div>
          </div>

          {poSyncRows === null ? (
            <div className="px-4 py-8 text-center text-slate-600 text-sm">
              請輸入採購單號（或前綴如 POO）後點「查詢」
            </div>
          ) : poSyncRows.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-500 text-sm">
              ERP 同步區中找不到採購單號含「{poSearchId}」的資料<br />
              <span className="text-xs text-slate-600 mt-1 block">請確認已在 ERP 同步頁面執行「採購單號」同步，或該採購單尚未建立於 ArgoERP</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="px-4 py-2 text-xs text-slate-400 bg-slate-900/50 border-b border-slate-800">
                共 {poSyncRows.length} 筆，同步時間：{poSyncRows[0]?.synced_at ? String(poSyncRows[0].synced_at).slice(0, 19).replace('T', ' ') : '—'}
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-800/60 border-b border-slate-700 text-slate-400">
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">採購單號</th>
                    <th className="px-2 py-2 text-center font-medium">序號</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">品項編碼</th>
                    <th className="px-3 py-2 text-left font-medium">品名/規格</th>
                    <th className="px-2 py-2 text-right font-medium">數量</th>
                    <th className="px-2 py-2 text-center font-medium">單位</th>
                    <th className="px-2 py-2 text-center font-medium">狀態</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">開立日</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">交貨日</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">廠商</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">來源SO</th>
                    <th className="px-2 py-2 text-center font-medium whitespace-nowrap">SO序號</th>
                    <th className="px-3 py-2 text-left font-medium">備註2</th>
                  </tr>
                </thead>
                <tbody>
                  {poSyncRows.map((r, i) => (
                    <tr key={i} className={`border-b border-slate-800/40 ${i % 2 === 0 ? '' : 'bg-slate-900/30'}`}>
                      <td className="px-3 py-1.5 font-mono text-orange-300 whitespace-nowrap">{String(r.doc_no ?? '—')}</td>
                      <td className="px-2 py-1.5 text-center font-mono text-slate-400">{String(r.sub_no ?? '—')}</td>
                      <td className="px-3 py-1.5 font-mono text-purple-300 whitespace-nowrap">{String(r.item_code ?? '—')}</td>
                      <td className="px-3 py-1.5 text-slate-300 max-w-[220px] truncate" title={String(r.description ?? '')}>{String(r.description ?? '—')}</td>
                      <td className="px-2 py-1.5 text-right text-slate-300">{String(r.qty ?? '—')}</td>
                      <td className="px-2 py-1.5 text-center text-slate-400">{String(r.unit ?? '—')}</td>
                      <td className="px-2 py-1.5 text-center">
                        {r.status === 'OPEN'
                          ? <span className="px-1.5 py-0.5 rounded text-xs bg-emerald-900/40 text-emerald-300">OPEN</span>
                          : r.status === 'CLOSE'
                          ? <span className="px-1.5 py-0.5 rounded text-xs bg-slate-700 text-slate-400">CLOSE</span>
                          : r.status
                          ? <span className="px-1.5 py-0.5 rounded text-xs bg-amber-900/40 text-amber-300">{String(r.status)}</span>
                          : <span className="text-slate-600">—</span>
                        }
                      </td>
                      <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{String(r.start_date ?? '—').slice(0, 10)}</td>
                      <td className="px-3 py-1.5 text-yellow-400/80 whitespace-nowrap">{String(r.end_date ?? '—').slice(0, 10)}</td>
                      <td className="px-3 py-1.5 font-mono text-slate-400 whitespace-nowrap">{String(r.customer_vendor ?? '—')}</td>
                      <td className="px-3 py-1.5 font-mono text-sky-300/80 whitespace-nowrap">{String((r.extra as Record<string,unknown>)?.SO_PROJECT_ID ?? '—')}</td>
                      <td className="px-2 py-1.5 text-center font-mono text-sky-200">{String((r.extra as Record<string,unknown>)?.SO_LINE_NO ?? '—')}</td>
                      <td className="px-3 py-1.5 text-slate-500 max-w-[160px] truncate" title={String(r.remark ?? '')}>{String(r.remark ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── 匯入後自動同步進度 Modal（阻擋操作）── */}
      {postSyncModal?.show && (
        <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="p-2 rounded-full bg-orange-900/50 text-orange-400">
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              </div>
              <div>
                <h3 className="text-white font-bold text-base">匯入後自動同步中</h3>
                <p className="text-slate-400 text-xs">全部步驟完成前請勿關閉此視窗</p>
              </div>
            </div>

            <div className="space-y-3">
              {postSyncModal.steps.map((step, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center shrink-0">
                    {step.status === 'done' && (
                      <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                    )}
                    {step.status === 'running' && (
                      <svg className="w-5 h-5 text-cyan-400 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                    )}
                    {step.status === 'error' && (
                      <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    )}
                    {step.status === 'pending' && (
                      <div className="w-3 h-3 rounded-full border-2 border-slate-600 mx-auto" />
                    )}
                  </div>
                  <span className={`text-sm ${
                    step.status === 'done' ? 'text-emerald-400' :
                    step.status === 'running' ? 'text-cyan-300 font-medium' :
                    step.status === 'error' ? 'text-red-400' :
                    'text-slate-500'
                  }`}>{step.label}</span>
                </div>
              ))}
            </div>

            {postSyncModal.error && (
              <div className="mt-4 p-3 bg-red-950/40 border border-red-700/50 rounded-lg text-red-300 text-xs">
                <p className="font-semibold mb-1">錯誤</p>
                <p>{postSyncModal.error}</p>
              </div>
            )}

            {(postSyncModal.steps.every(s => s.status === 'done') || !!postSyncModal.error) && (
              <div className="mt-5 flex justify-end">
                <button
                  onClick={() => setPostSyncModal(null)}
                  className="px-5 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors"
                >
                  關閉
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
