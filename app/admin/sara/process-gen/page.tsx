'use client'

import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ── 型別 ─────────────────────────────────────────────────────────

interface InputRow {
  order_number: string
  item_code: string
  item_spec: string
  quantity: number
  due: string
  pan_count: number
  mo_number?: string            // 製令單號（MOT...）/ 採購單號（POC...）/ 請購單號（POO...）
  line_seq?: string             // 銷售訂單序號（match_line_no）；C/O 廠 fallback 為採購單行號
  customer?: string             // 客戶名稱
  factory?: 'T' | 'C' | 'O'   // 廠區：T=台北 C=常平 O=委外（僅預覽，不匯出）
}

interface SaraRow {
  order_number: string
  mfg_order_number: string
  product_name: string
  product_desc: string
  lot_number: string
  prod_qty: number
  due: string
  priority: string
  earliest_start: string
  job_seq: number | string
  workcenter: string
  job_name: string
  job_qty: number
  outsourcing: string
  est_time: number
  time_unit: string
  bom: string
  mat_req_qty: string
  customer?: string
  factory?: 'T' | 'C' | 'O'   // 廠區（僅預覽，不匯出）
  _noRoute?: boolean
}

interface SingleRow {
  job_sequence: number
  workcenter: string
  job_name: string
  job_quantity: number
  est_time: number
}

// ── CSV 解析（支援引號欄位） ──────────────────────────────────────

function parseCSV(text: string): string[][] {
  const result: string[][] = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const cells: string[] = []
    let i = 0, cell = ''
    while (i <= line.length) {
      const ch = line[i] ?? ''
      if (ch === '"') {
        i++
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2 }
          else if (line[i] === '"') { i++; break }
          else cell += line[i++]
        }
      } else if (ch === ',' || ch === '') {
        cells.push(cell.trim()); cell = ''; i++
      } else {
        cell += ch; i++
      }
    }
    if (cells.length > 1 || cells[0]) result.push(cells)
  }
  return result
}

// ── 欄位索引偵測 ─────────────────────────────────────────────────

function detectCols(header: string[]): Record<string, number> {
  const m: Record<string, number> = {}
  let specFound = false
  for (let i = 0; i < header.length; i++) {
    const h = header[i].trim()
    if (!('order' in m) && ['工單編號', '訂單編號', '訂貨單號'].includes(h)) m.order = i
    if (!('item' in m)  && h === '品項編碼') m.item = i
    if (!('qty' in m)   && ['數量', '生產需求數量'].includes(h)) m.qty = i
    if (!('due' in m)   && ['交付日期', '需求日', '交期'].includes(h)) m.due = i
    if (!('pan' in m)   && h === '盤數') m.pan = i
    if (!specFound && ['備註', '品項名稱', '規格'].includes(h)) { m.spec = i; specFound = true }
  }
  return m
}

// ── 輔助函式 ─────────────────────────────────────────────────────

const isPackagingStation = (s: string) => s.includes('包裝站')
const isTransitStation   = (s: string) => s.includes('轉運')

// 工時計算：轉運站固定qty=1；計算結果不足10分鐘時補至10分鐘（std_time有值時）
function calcEst(std: number, qty: number, panCount: number, station: string): number {
  if (std === 0) return 0
  const isPacking = isPackagingStation(station)
  const isTransit = isTransitStation(station)
  const effQty    = isTransit ? 1 : (panCount > 0 && !isPacking) ? panCount : qty
  return Math.max(10, Math.round(std * effQty * 10) / 10)
}

function fmtToday(): string {
  const d = new Date()
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function escCsv(v: string | number): string {
  const s = String(v ?? '')
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外' }
const FACTORY_BADGE: Record<string, string> = {
  T: 'bg-sky-800/70 text-sky-300 border border-sky-700/50',
  C: 'bg-orange-800/70 text-orange-300 border border-orange-700/50',
  O: 'bg-violet-800/70 text-violet-300 border border-violet-700/50',
}

// ── 頁面 ─────────────────────────────────────────────────────────

export default function ProcessGenPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [activeTab, setActiveTab] = useState<'batch' | 'single'>('batch')

  // Batch state
  const [dataSource, setDataSource]   = useState<'csv' | 'sheet'>('sheet')
  const [fileName, setFileName]       = useState('')
  const [sheetDate, setSheetDate]     = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [sheetLoading, setSheetLoading]     = useState(false)
  const [sheetLoadError, setSheetLoadError] = useState('')
  const [inputRows, setInputRows]   = useState<InputRow[]>([])
  const [saraRows, setSaraRows]     = useState<SaraRow[]>([])
  const [genWarns, setGenWarns]         = useState<string[]>([])
  const [confirmWarns, setConfirmWarns] = useState<string[]>([])
  const [flaggedItems, setFlaggedItems] = useState<Set<string>>(new Set())
  const [generating, setGenerating]     = useState(false)
  const [dlDone, setDlDone]         = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  // No-route override state
  const [noRouteRows, setNoRouteRows]             = useState<InputRow[]>([])
  const [noRouteCodes, setNoRouteCodes]           = useState<Record<string, string>>({})  // key = rowKey()
  const [noRouteApplying, setNoRouteApplying]     = useState<Record<string, boolean>>({})
  const [noRouteApplyWarns, setNoRouteApplyWarns] = useState<Record<string, string>>({})
  const [noRouteModes, setNoRouteModes]           = useState<Record<string, 'item' | 'route'>>({})  // 'item'=品號, 'route'=途程名稱
  const [selectedReroute, setSelectedReroute]     = useState<Record<string, boolean>>({})   // key = order|item

  // Single lookup state
  const [itemCode, setItemCode]         = useState('')
  const [quantity, setQuantity]         = useState('1')
  const [moNumber, setMoNumber]         = useState('')
  const [singleRows, setSingleRows]     = useState<SingleRow[] | null>(null)
  const [singleRoute, setSingleRoute]   = useState('')
  const [singleWarns, setSingleWarns]   = useState<string[]>([])
  const [singleError, setSingleError]   = useState('')
  const [singleLoading, setSingleLoading] = useState(false)
  const [copied, setCopied]             = useState(false)

  // ── 解析 CSV ──────────────────────────────────────────────────

  const handleFile = useCallback((file: File) => {
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = e => {
      const text = e.target?.result as string
      const rows = parseCSV(text)
      if (!rows.length) return

      let hIdx = -1
      let cols: Record<string, number> = {}
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        cols = detectCols(rows[i])
        if ('order' in cols && 'item' in cols) { hIdx = i; break }
      }
      // 若無法偵測，使用 0630C.csv 固定欄位
      if (hIdx === -1) {
        cols = { order: 0, item: 11, spec: 12, qty: 14, due: 15, pan: 16 }
      }

      const parsed: InputRow[] = []
      for (let i = hIdx + 1; i < rows.length; i++) {
        const c = rows[i]
        const order = (c[cols.order] ?? '').trim()
        const item  = (c[cols.item]  ?? '').trim()
        if (!order || !item || order === '工單編號' || order === '訂單編號') continue
        const qty = parseFloat((c[cols.qty] ?? '').replace(/,/g, '')) || 0
        if (qty <= 0) continue
        const panStr = (c[cols.pan ?? -1] ?? '').trim()
        parsed.push({
          order_number: order,
          item_code:    item,
          item_spec:    (c[cols.spec ?? -1] ?? '').trim(),
          quantity:     qty,
          due:          (c[cols.due ?? -1] ?? '').trim(),
          pan_count:    panStr ? parseFloat(panStr) || 0 : 0,
        })
      }
      setInputRows(parsed)
      setSaraRows([])
      setGenWarns([])
    }
    reader.readAsText(file, 'UTF-8')
  }, [])

  // ── 從出單表載入 ────────────────────────────────────────────────

  const handleLoadFromSheet = useCallback(async () => {
    if (!sheetDate) return
    setSheetLoading(true)
    setSheetLoadError('')
    setInputRows([])
    setSaraRows([])
    setGenWarns([])
    setConfirmWarns([])
    setFlaggedItems(new Set())
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${sheetDate}`)
      const json = await res.json() as { success: boolean; sheet?: { rows?: Record<string, unknown>[] } }
      if (!json.success || !json.sheet?.rows?.length) {
        setSheetLoadError(`找不到 ${sheetDate} 的出單資料，請確認日期正確`)
        return
      }
      const parsed: InputRow[] = []
      for (const r of json.sheet.rows) {
        const order = String(r.order_number ?? '').trim()
        const item  = String(r.item_code   ?? '').trim()
        if (!order || !item) continue
        const qty  = parseFloat(String(r.quantity   ?? '').replace(/,/g, '')) || 0
        if (qty <= 0) continue
        const pan  = parseFloat(String(r.plate_count ?? '').replace(/,/g, '')) || 0
        const factory = (['T', 'C', 'O'].includes(String(r.factory ?? ''))) ? String(r.factory) as 'T'|'C'|'O' : undefined
        // 依廠區選擇對應單號：台北=製令號MOT / 常平=採購單號POC / 委外=請購單號MPO
        const refNumber =
          factory === 'C' ? String(r.po_number ?? '').trim() || undefined :
          factory === 'O' ? String(r.pr_number ?? '').trim() || undefined :
                            String(r.mo_number ?? '').trim() || undefined
        parsed.push({
          order_number: order,
          item_code:    item,
          item_spec:    String(r.item_name ?? r.note ?? '').trim(),
          quantity:     qty,
          due:          String(r.delivery_date ?? '').trim(),
          pan_count:    pan,
          mo_number:    refNumber,
          // 銷售訂單序號（match_line_no = SO 項次，所有廠別通用）
          line_seq:     String(r.match_line_no ?? '').trim() || undefined,
          customer:     String(r.customer  ?? '').trim() || undefined,
          factory,
        })
      }
      if (!parsed.length) {
        setSheetLoadError(`${sheetDate} 出單表無有效品項資料`)
        return
      }

      // ── 從 erp_pj_sync 查詢 C/O 廠列的請購/採購單序號（lot_number 用）────
      const coRows = parsed.filter(r => (r.factory === 'C' || r.factory === 'O') && r.mo_number)
      if (coRows.length > 0) {
        const docNos = [...new Set(coRows.map(r => r.mo_number!))]
        const { data: syncRows } = await supabase
          .from('erp_pj_sync')
          .select('doc_no, sub_no, item_code')
          .in('doc_no', docNos)
          .in('doc_type', ['採購單號', '請購單號'])
        if (syncRows?.length) {
          // key = doc_no|item_code → sub_no（若同一 doc+item 有多筆，取第一筆）
          const syncMap = new Map<string, string>()
          for (const sr of syncRows) {
            const k = `${sr.doc_no}|${sr.item_code ?? ''}`
            if (!syncMap.has(k)) syncMap.set(k, String(sr.sub_no ?? ''))
          }
          for (const r of parsed) {
            if ((r.factory === 'C' || r.factory === 'O') && r.mo_number && !r.line_seq) {
              // 僅在 match_line_no 未能提供序號時，才以採購單行號作為 fallback
              const seq = syncMap.get(`${r.mo_number}|${r.item_code}`)
              if (seq) r.line_seq = seq
            }
          }
        }
      }

      setInputRows(parsed)
      setNoRouteRows([])
      setSaraRows([])
      setFileName(`出單表 ${sheetDate}（${parsed.length} 筆）`)
    } catch (e) {
      setSheetLoadError(`載入失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSheetLoading(false)
    }
  }, [sheetDate])

  // ── 批量產生 SARA ──────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (!inputRows.length) return
    setGenerating(true)
    setGenWarns([])
    setConfirmWarns([])
    setFlaggedItems(new Set())
    setSaraRows([])
    setNoRouteRows([])
    setNoRouteCodes({})
    setNoRouteApplying({})
    setNoRouteApplyWarns({})
    setNoRouteModes({})
    setSelectedReroute({})
    const warns: string[] = []
    const confirms: string[] = []
    const today = fmtToday()

    try {
      const uniqueItems = [...new Set(inputRows.map(r => r.item_code))]

      // 1. item_routes
      type IrRow = { item_code: string; route_id: string }
      const { data: irData } = await supabase
        .from('item_routes').select('item_code,route_id').in('item_code', uniqueItems)
      const irMap = new Map<string, string>(((irData ?? []) as IrRow[]).map(r => [r.item_code, r.route_id]))

      const missing = uniqueItems.filter(c => !irMap.has(c))
      if (missing.length) warns.push(`${missing.length} 個品號無途程（item_routes）：${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}`)

      // 廠區與途程相符性確認（規則 4/5/6）
      const fakeKo = inputRows.filter(r => r.factory === 'T' && r.item_spec.includes('仿柯'))
      if (fakeKo.length) {
        const uniq = [...new Set(fakeKo.map(r => `${r.order_number}/${r.item_code}`))]
        confirms.push(`廠區為台北但品名規格含「仿柯」，請確認是否應改為委外（${fakeKo.length} 筆 / ${uniq.length} 品項）：${uniq.slice(0, 4).join('、')}${uniq.length > 4 ? '…' : ''}`)
      }
      const CP_ROUTE = '常平一般壓克力製程'
      const cpMis = inputRows.filter(r => r.factory === 'C' && irMap.has(r.item_code) && irMap.get(r.item_code) !== CP_ROUTE)
      if (cpMis.length) {
        // 依 order_number|item_code|mo_number 去重，方便使用者定位
        const uniqKeys = [...new Set(cpMis.map(r => `${r.order_number}/${r.item_code}（${irMap.get(r.item_code)}）`))]
        confirms.push(`廠區為常平但套用途程非「${CP_ROUTE}」，請確認（共 ${cpMis.length} 筆，${uniqKeys.length} 項品號）：${uniqKeys.slice(0, 4).join('、')}${uniqKeys.length > 4 ? '…' : ''}`)
      }
      const O_ROUTES = new Set(['委外/7天回', '委外/9天回', '委外/11天回'])
      const ouMis = inputRows.filter(r => r.factory === 'O' && irMap.has(r.item_code) && !O_ROUTES.has(irMap.get(r.item_code)!))
      if (ouMis.length) {
        const uniq = [...new Set(ouMis.map(r => `${r.order_number}/${r.item_code}（${irMap.get(r.item_code)}）`))]
        confirms.push(`廠區為委外但套用途程非標準委外途程，請確認（${ouMis.length} 筆，${uniq.length} 項品號）：${uniq.slice(0, 4).join('、')}${uniq.length > 4 ? '…' : ''}`)
      }

      // 標記問題列（含製令號 + 數量 + 批號，不同序號獨立影響）
      const inputFlagKey = (r: InputRow) =>
        `${r.order_number}||${r.item_code}||${r.mo_number || r.order_number}||${r.quantity}||${r.line_seq || r.order_number}`
      const flagged = new Set<string>()
      fakeKo.forEach(r => flagged.add(inputFlagKey(r)))
      cpMis.forEach(r => flagged.add(inputFlagKey(r)))
      ouMis.forEach(r => flagged.add(inputFlagKey(r)))
      setFlaggedItems(flagged)

      // 2. route_operations
      const uniqueRoutes = [...new Set([...irMap.values()])]
      type RoRow = { route_id: string; sequence: number; op_name: string }
      const { data: roData } = uniqueRoutes.length
        ? await supabase.from('route_operations').select('route_id,sequence,op_name').in('route_id', uniqueRoutes).order('sequence')
        : { data: [] as RoRow[] }
      const roMap = new Map<string, { sequence: number; op_name: string }[]>()
      for (const r of (roData ?? []) as RoRow[]) {
        const arr = roMap.get(r.route_id) ?? []
        arr.push({ sequence: r.sequence, op_name: r.op_name })
        roMap.set(r.route_id, arr)
      }

      // 3. operation_times
      const uniqueOps = [...new Set(((roData ?? []) as RoRow[]).map(r => r.op_name))]
      type OtRow = { op_name: string; station: string; std_time_min: number }
      const { data: otData } = uniqueOps.length
        ? await supabase.from('operation_times').select('op_name,station,std_time_min').in('op_name', uniqueOps)
        : { data: [] as OtRow[] }
      const otMap = new Map<string, { station: string; std_time_min: number }>(
        ((otData ?? []) as OtRow[]).map(r => [r.op_name, { station: r.station ?? '', std_time_min: Number(r.std_time_min ?? 0) }])
      )

      const missingTimes = uniqueOps.filter(op => !otMap.has(op))
      if (missingTimes.length) warns.push(`${missingTimes.length} 個工序無生產時間（operation_times）：${missingTimes.slice(0, 4).join('、')}${missingTimes.length > 4 ? '…' : ''}`)

      // 4. 產生輸出列
      const out: SaraRow[] = []
      const noRoute: InputRow[] = []
      for (const row of inputRows) {
        const routeId = irMap.get(row.item_code)
        if (!routeId) {
          noRoute.push(row)
          out.push({
            order_number: row.order_number, mfg_order_number: row.mo_number || row.order_number,
            product_name: row.item_code, product_desc: row.item_spec,
            lot_number: row.line_seq || row.order_number,
            prod_qty: row.quantity, due: row.due,
            priority: '', earliest_start: today,
            job_seq: '', workcenter: '', job_name: '', job_qty: row.quantity,
            outsourcing: '', est_time: 0, time_unit: '分鐘', bom: '', mat_req_qty: '',
            customer: row.customer,
            factory: row.factory,
            _noRoute: true,
          })
          continue
        }
        const ops = roMap.get(routeId) ?? []
        for (const op of ops) {
          const ot      = otMap.get(op.op_name)
          const station = ot?.station ?? ''
          const std     = ot?.std_time_min ?? 0
          // 包裝站→生產數量；轉運站→固定1；其他站點→盤數（盤數為0時用生產數量）；最低10分鐘
          const jobQty  = (row.pan_count > 0 && !isPackagingStation(station)) ? row.pan_count : row.quantity
          const est     = calcEst(std, row.quantity, row.pan_count, station)
          out.push({
            order_number: row.order_number, mfg_order_number: row.mo_number || row.order_number,
            product_name: row.item_code, product_desc: row.item_spec,
            lot_number: row.line_seq || row.order_number,
            prod_qty: row.quantity, due: row.due,
            priority: '', earliest_start: today,
            job_seq: op.sequence, workcenter: station, job_name: op.op_name,
            job_qty: jobQty, outsourcing: '', est_time: est, time_unit: '分鐘',
            bom: '', mat_req_qty: '',
            customer: row.customer,
            factory: row.factory,
          })
        }
      }
      setSaraRows(out)
      setNoRouteRows(noRoute)
      setGenWarns(warns)
      setConfirmWarns(confirms)
    } catch (e) {
      setGenWarns([`錯誤：${e instanceof Error ? e.message : String(e)}`])
    } finally {
      setGenerating(false)
    }
  }, [inputRows])

  // ── 套用臨時途程至単一無途程訂單 ─────────────────────────────────────

  const rowKey = (r: InputRow) => `${r.order_number}||${r.item_code}||${r.quantity}`
  // 連字號分险5節，避免孕值中有 | 符號導致切錯
  // 綁定原則：同一訂單號 + 同一品號 + 同一製令/採購單號 + 同一數量 + 同一批號(序號) 的所有工序列才綁定勾選
  // 同訂單不同序號（不同製令號 / 不同數量 / 不同批號）必須可分開勾選
  const rerouteKey = (r: { order_number: string; product_name: string; mfg_order_number?: string; prod_qty?: number; lot_number?: string }) =>
    `${r.order_number}||${r.product_name}||${r.mfg_order_number ?? ''}||${r.prod_qty ?? ''}||${r.lot_number ?? ''}`

  // ── 將已有途程的列移回無途程區（修改途程） ─────────────────────────

  const handleMoveToNoRoute = useCallback(() => {
    const groupKeys = new Set(Object.entries(selectedReroute).filter(([, v]) => v).map(([k]) => k))
    if (!groupKeys.size) return
    const today = fmtToday()
    const newInputRows: InputRow[] = []
    const placeholders: SaraRow[] = []
    for (const gk of groupKeys) {
      const [orderNum, itemCode, moNumber, qty, lotNum] = gk.split('||')
      const orig = inputRows.find(r =>
        r.order_number === orderNum &&
        r.item_code === itemCode &&
        (r.mo_number ?? '') === (moNumber ?? '') &&
        String(r.quantity) === (qty ?? '') &&
        (r.line_seq || r.order_number) === (lotNum ?? '')
      )
      if (!orig) continue
      if (noRouteRows.some(r =>
        r.order_number === orderNum &&
        r.item_code === itemCode &&
        (r.mo_number ?? '') === (moNumber ?? '') &&
        String(r.quantity) === (qty ?? '') &&
        (r.line_seq || r.order_number) === (lotNum ?? '')
      )) continue
      newInputRows.push(orig)
      placeholders.push({
        order_number: orig.order_number, mfg_order_number: orig.mo_number || orig.order_number,
        product_name: orig.item_code, product_desc: orig.item_spec,
        lot_number: orig.line_seq || orig.order_number,
        prod_qty: orig.quantity, due: orig.due,
        priority: '', earliest_start: today,
        job_seq: '', workcenter: '', job_name: '', job_qty: orig.quantity,
        outsourcing: '', est_time: 0, time_unit: '分鐘', bom: '', mat_req_qty: '',
        customer: orig.customer, factory: orig.factory, _noRoute: true,
      })
    }
    setSaraRows(prev => [
      ...prev.filter(r => !groupKeys.has(rerouteKey(r))),
      ...placeholders,
    ])
    setNoRouteRows(prev => [...prev, ...newInputRows])
    setSelectedReroute({})
  }, [selectedReroute, inputRows, noRouteRows])

  // ── 將所有異常項目移到無途程區 ──────────────────────────────────────

  const handleMoveAllFlaggedToNoRoute = useCallback(() => {
    if (!flaggedItems.size) return
    const today = fmtToday()
    const flaggedSaraKeys = new Set(
      saraRows.filter(r => !r._noRoute && flaggedItems.has(rerouteKey(r))).map(r => rerouteKey(r))
    )
    if (!flaggedSaraKeys.size) return
    const newInputRows: InputRow[] = []
    const placeholders: SaraRow[] = []
    for (const rk of flaggedSaraKeys) {
      const [orderNum, itemCode, moNumber, qty, lotNum] = rk.split('||')
      const orig = inputRows.find(r =>
        r.order_number === orderNum && r.item_code === itemCode &&
        (r.mo_number ?? '') === (moNumber ?? '') && String(r.quantity) === (qty ?? '') &&
        (r.line_seq || r.order_number) === (lotNum ?? '')
      )
      if (!orig) continue
      if (noRouteRows.some(r =>
        r.order_number === orderNum && r.item_code === itemCode &&
        (r.mo_number ?? '') === (moNumber ?? '') && String(r.quantity) === (qty ?? '') &&
        (r.line_seq || r.order_number) === (lotNum ?? '')
      )) continue
      newInputRows.push(orig)
      placeholders.push({
        order_number: orig.order_number, mfg_order_number: orig.mo_number || orig.order_number,
        product_name: orig.item_code, product_desc: orig.item_spec,
        lot_number: orig.line_seq || orig.order_number,
        prod_qty: orig.quantity, due: orig.due,
        priority: '', earliest_start: today,
        job_seq: '', workcenter: '', job_name: '', job_qty: orig.quantity,
        outsourcing: '', est_time: 0, time_unit: '分鐘', bom: '', mat_req_qty: '',
        customer: orig.customer, factory: orig.factory, _noRoute: true,
      })
    }
    if (!newInputRows.length) return
    setSaraRows(prev => [...prev.filter(r => !flaggedSaraKeys.has(rerouteKey(r))), ...placeholders])
    setNoRouteRows(prev => [...prev, ...newInputRows])
    setSelectedReroute({})
  }, [flaggedItems, saraRows, inputRows, noRouteRows])

  // ── 套用臨時途程至単一無途程訂單 ─────────────────────────────────────

  const handleApplyTempRoute = useCallback(async (row: InputRow) => {
    const key  = rowKey(row)
    const raw  = (noRouteCodes[key] ?? '').trim()
    const mode = noRouteModes[key] ?? 'item'
    const code = mode === 'item' ? raw.toUpperCase() : raw
    if (!code) return
    setNoRouteApplying(prev => ({ ...prev, [key]: true }))
    setNoRouteApplyWarns(prev => ({ ...prev, [key]: '' }))
    const today = fmtToday()
    try {
      let routeId: string
      if (mode === 'route') {
        routeId = code   // 直接指定途程名稱（route_id）
      } else {
        const { data: irData, error: irErr } = await supabase
          .from('item_routes').select('route_id').eq('item_code', code).limit(1).single()
        if (irErr || !irData) throw new Error(`找不到品號 ${code} 的途程`)
        routeId = (irData as { route_id: string }).route_id
      }

      type SOp = { sequence: number; op_name: string }
      const { data: roData } = await supabase
        .from('route_operations').select('sequence,op_name')
        .eq('route_id', routeId).order('sequence')
      const ops = (roData ?? []) as SOp[]
      if (!ops.length) throw new Error(`途程「${routeId}」無工序資料`)

      type OtRow = { op_name: string; station: string; std_time_min: number }
      const { data: otData } = await supabase
        .from('operation_times').select('op_name,station,std_time_min')
        .in('op_name', ops.map(o => o.op_name))
      const otMap = new Map<string, { station: string; std_time_min: number }>(
        ((otData ?? []) as OtRow[]).map(r => [r.op_name, { station: r.station ?? '', std_time_min: Number(r.std_time_min ?? 0) }])
      )

      const newRows: SaraRow[] = ops.map(op => {
        const ot      = otMap.get(op.op_name)
        const station = ot?.station ?? ''
        const std     = ot?.std_time_min ?? 0
        const jobQty  = (row.pan_count > 0 && !isPackagingStation(station)) ? row.pan_count : row.quantity
        const est     = calcEst(std, row.quantity, row.pan_count, station)
        return {
          order_number: row.order_number, mfg_order_number: row.mo_number || row.order_number,
          product_name: row.item_code, product_desc: row.item_spec,
          lot_number: row.line_seq || row.order_number,
          prod_qty: row.quantity, due: row.due,
          priority: '', earliest_start: today,
          job_seq: op.sequence, workcenter: station, job_name: op.op_name,
          job_qty: jobQty, outsourcing: '', est_time: est, time_unit: '分鐘',
          bom: '', mat_req_qty: '',
          customer: row.customer,
          factory: row.factory,
        }
      })

      // 廠區途程確認警告（規則 4/5/6）
      const applyConfirms: string[] = []
      if (row.factory === 'T' && row.item_spec.includes('仿柯'))
        applyConfirms.push(`【${row.item_code}】廠區台北但品名規格含「仿柯」，請確認`)
      if (row.factory === 'C' && routeId !== '常平一般壓克力製程')
        applyConfirms.push(`【${row.item_code}】廠區常平但途程非「常平一般壓克力製程」（套用：${routeId}），請確認`)
      if (row.factory === 'O' && !new Set(['委外/7天回', '委外/9天回', '委外/11天回']).has(routeId))
        applyConfirms.push(`【${row.item_code}】廠區委外但途程非標準委外途程（套用：${routeId}），請確認`)
      if (applyConfirms.length) {
        setConfirmWarns(prev => [...prev, ...applyConfirms])
        setFlaggedItems(prev => new Set([...prev, `${row.order_number}||${row.item_code}||${row.mo_number || row.order_number}||${row.quantity}||${row.line_seq || row.order_number}`]))
      }

      // 從 saraRows 移除此行的 _noRoute 佔位，加入新產生列
      const origLot = row.line_seq || row.order_number
      setSaraRows(prev => [
        ...prev.filter(r => !(r._noRoute && r.order_number === row.order_number && r.product_name === row.item_code && r.mfg_order_number === (row.mo_number || row.order_number) && r.prod_qty === row.quantity && r.lot_number === origLot)),
        ...newRows,
      ])
      setNoRouteRows(prev => prev.filter(r => rowKey(r) !== key))
      setNoRouteCodes(prev => { const n = { ...prev }; delete n[key]; return n })
    } catch (e) {
      setNoRouteApplyWarns(prev => ({ ...prev, [key]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setNoRouteApplying(prev => ({ ...prev, [key]: false }))
    }
  }, [noRouteCodes, noRouteModes, noRouteRows])

  // ── 下載 SARA CSV ─────────────────────────────────────────────

  const handleDownload = useCallback(() => {
    const rows = saraRows.filter(r => !r._noRoute)
    if (!rows.length) return
    const h1 = 'Order Number,Manufacturing Order Number,Product Name,Product Description,Lot Number,Production Quantity,Due,Priority Level,Earliest Start Time,Job Sequence,Workcenter,Job Name,Job Quantity,Out Sourcing,Est. Time,Time Unit,BOM Components,Material Required Quantity,customer_id'
    const h2 = '訂單編號,(必填)工單編號,(必填)品號,規格,生產批號,(必填)生產需求數量,(必填)需求日,排程優先等級(1-99),最早可開始時間,(必填)工序,(必填)站點,(必填)製程名稱,製程數量,製程委外,(必填)預估工時,工時單位,BOM元件品號,物料需求數量,客戶名稱'
    const data = rows.map(r =>
      [r.order_number, r.mfg_order_number, r.product_name, r.product_desc,
       r.lot_number, r.prod_qty, r.due, r.priority, r.earliest_start,
       r.job_seq, r.workcenter, r.job_name, r.job_qty, r.outsourcing,
       r.est_time, r.time_unit, r.bom, r.mat_req_qty, r.customer ?? ''].map(escCsv).join(',')
    )
    const csv = [h1, h2, ...data].join('\r\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `SARA_101_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setDlDone(true)
    setTimeout(() => setDlDone(false), 2000)
  }, [saraRows])

  // ── 單品查詢 ──────────────────────────────────────────────────

  const handleSingleGenerate = useCallback(async () => {
    const code = itemCode.trim().toUpperCase()
    const qty  = parseFloat(quantity) || 1
    if (!code) { setSingleError('請輸入品項編碼'); return }
    setSingleLoading(true); setSingleError(''); setSingleRows(null); setSingleWarns([])

    try {
      const { data: irData, error: irErr } = await supabase
        .from('item_routes').select('item_code,route_id').eq('item_code', code).limit(1).single()
      if (irErr || !irData) throw new Error(`找不到品項 ${code} 的途程（item_routes 無資料）`)
      setSingleRoute(irData.route_id as string)

      type SOp = { sequence: number; op_name: string }
      const { data: roData } = await supabase
        .from('route_operations').select('sequence,op_name').eq('route_id', irData.route_id).order('sequence')
      if (!(roData as unknown[])?.length) throw new Error(`途程 ${irData.route_id} 無工序資料`)

      type OtRow = { op_name: string; station: string; std_time_min: number }
      const opNames = (roData as SOp[]).map(r => r.op_name)
      const { data: otData } = await supabase
        .from('operation_times').select('op_name,station,std_time_min').in('op_name', opNames)
      const otM = new Map<string, { station: string; std_time_min: number }>(
        ((otData ?? []) as OtRow[]).map(r => [r.op_name, { station: r.station ?? '', std_time_min: Number(r.std_time_min ?? 0) }])
      )

      const warns: string[] = []
      const result: SingleRow[] = (roData as SOp[]).map(op => {
        const ot  = otM.get(op.op_name)
        if (!ot) warns.push(`工序「${op.op_name}」無生產時間`)
        const std = ot?.std_time_min ?? 0
        return { job_sequence: op.sequence, workcenter: ot?.station ?? '', job_name: op.op_name, job_quantity: qty, est_time: calcEst(std, qty, 0, ot?.station ?? '') }
      })
      setSingleRows(result); setSingleWarns(warns)
    } catch (e) {
      setSingleError(e instanceof Error ? e.message : String(e))
    } finally {
      setSingleLoading(false)
    }
  }, [itemCode, quantity])

  const handleCopyTsv = useCallback(() => {
    if (!singleRows) return
    const mo  = moNumber.trim() || '(未填)'
    const qty = parseFloat(quantity) || 1
    const hdr = ['manufacturing_order_number', 'product_name', 'production_quantity', 'job_sequence', 'workcenter', 'job_name', 'job_quantity', 'out_sourcing', 'est_time', 'time_unit']
    const data = singleRows.map(r => [mo, itemCode.trim(), qty, r.job_sequence, r.workcenter, r.job_name, r.job_quantity, 'N', r.est_time, '分鐘'])
    navigator.clipboard.writeText([hdr, ...data].map(r => r.join('\t')).join('\n')).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }, [singleRows, moNumber, quantity, itemCode])

  // ── 統計 ──────────────────────────────────────────────────────

  const successCount = saraRows.filter(r => !r._noRoute).length
  const noRouteCount = saraRows.filter(r => r._noRoute).length

  // ── 渲染 ──────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6 space-y-4">

      <div>
        <h1 className="text-xl font-bold text-emerald-300">SARA 工序格式產生器</h1>
        <p className="text-xs text-slate-400 mt-0.5">由每日出單表 CSV 查詢途程，自動產出塔台 SARA_101 匯入格式</p>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 bg-slate-900 p-1 rounded-lg w-fit border border-slate-800">
        {(['batch', 'single'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${activeTab === t ? 'bg-emerald-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
            {t === 'batch' ? '📄 CSV 批量轉換' : '🔍 單品查詢'}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════ BATCH */}
      {activeTab === 'batch' && (
        <div className="space-y-4">

          {/* 資料來源切換 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 whitespace-nowrap">資料來源</span>
            <div className="flex gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
              {(['sheet', 'csv'] as const).map(src => (
                <button key={src} onClick={() => { setDataSource(src); setInputRows([]); setSaraRows([]); setGenWarns([]); setConfirmWarns([]); setFlaggedItems(new Set()); setSheetLoadError('') }}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${dataSource === src ? 'bg-emerald-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                  {src === 'sheet' ? '📅 從出單表載入' : '📂 CSV 上傳'}
                </button>
              ))}
            </div>
          </div>

          {/* 從出單表載入 */}
          {dataSource === 'sheet' && (
            <div className="flex flex-wrap items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
              <label className="text-xs text-slate-400 whitespace-nowrap">出單表日期</label>
              <input
                type="date"
                value={sheetDate}
                onChange={e => { setSheetDate(e.target.value); setInputRows([]); setSaraRows([]); setSheetLoadError('') }}
                className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-emerald-500"
              />
              <button
                onClick={() => void handleLoadFromSheet()}
                disabled={sheetLoading || !sheetDate}
                className="px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {sheetLoading ? '⏳ 載入中…' : '載入'}
              </button>
              {inputRows.length > 0 && (
                <span className="text-emerald-400 text-sm">✓ 已載入 {inputRows.length} 筆</span>
              )}
              {sheetLoadError && (
                <span className="text-red-400 text-sm">{sheetLoadError}</span>
              )}
            </div>
          )}

          {/* CSV 上傳 */}
          {dataSource === 'csv' && (
            <div
              onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={e => { e.preventDefault(); setIsDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${isDragOver ? 'border-emerald-400 bg-emerald-950/20' : 'border-slate-700 hover:border-emerald-600'}`}
            >
              <input ref={fileRef} type="file" accept=".csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }} />
              <p className="text-slate-400 text-sm">拖曳 CSV 或點此上傳</p>
              <p className="text-xs text-slate-600 mt-1">每日出單表格式（0630C.csv 等）</p>
              {fileName && <p className="mt-2 text-emerald-400 text-sm font-mono">📄 {fileName}</p>}
            </div>
          )}

          {/* 解析摘要 + 產生按鈕 */}
          {inputRows.length > 0 && (
            <div className="flex flex-wrap gap-3 items-center">
              <span className="text-xs bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
                解析 <span className="text-white font-bold">{inputRows.length}</span> 筆
              </span>
              <span className="text-xs bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
                品號 <span className="text-cyan-300 font-bold">{new Set(inputRows.map(r => r.item_code)).size}</span> 種
              </span>
              <span className="text-xs bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
                訂單 <span className="text-indigo-300 font-bold">{new Set(inputRows.map(r => r.order_number)).size}</span> 張
              </span>
              <button onClick={() => void handleGenerate()} disabled={generating}
                className="px-5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold">
                {generating ? '⏳ 查詢途程中…' : '⚙ 產生 SARA 格式'}
              </button>
            </div>
          )}

          {/* 確認警告（廠區/途程不符） */}
          {confirmWarns.length > 0 && (
            <div className="px-4 py-3 bg-red-600/25 border-2 border-red-500/80 rounded-lg space-y-0.5 shadow-lg shadow-red-900/40">
              <div className="text-red-200 text-xs font-bold mb-1">🔴 請確認以下異常</div>
              {confirmWarns.map((w, i) => <div key={i} className="text-red-100 text-xs">・{w}</div>)}
            </div>
          )}

          {/* 一般警告 */}
          {genWarns.length > 0 && (
            <div className="px-4 py-2 bg-amber-950/40 border border-amber-700/40 rounded-lg space-y-0.5">
              {genWarns.map((w, i) => <div key={i} className="text-amber-300 text-xs">⚠ {w}</div>)}
            </div>
          )}

          {/* 輸出結果 */}
          {saraRows.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3 items-center">
                <span className="text-xs bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
                  輸出 <span className="text-emerald-300 font-bold">{successCount}</span> 工序列
                </span>
                {noRouteCount > 0 && (
                  <span className="text-xs bg-red-600/30 px-3 py-1.5 rounded-lg border-2 border-red-500/70 text-red-100 font-semibold shadow shadow-red-900/40">
                    ⚠ {noRouteCount} 筆品號無途程（見下方）
                  </span>
                )}
                {Object.values(selectedReroute).some(Boolean) && (
                  <button
                    onClick={handleMoveToNoRoute}
                    className="px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs font-semibold"
                  >
                    ✓ {Object.values(selectedReroute).filter(Boolean).length} 筆→移至無途程區
                  </button>
                )}
                {flaggedItems.size > 0 && saraRows.some(r => !r._noRoute && flaggedItems.has(rerouteKey(r))) && (
                  <button
                    onClick={handleMoveAllFlaggedToNoRoute}
                    className="px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white text-xs font-semibold"
                    title="將所有標記為紅色異常的項目移到無途程區"
                  >
                    ⚠ {[...new Set(saraRows.filter(r => !r._noRoute && flaggedItems.has(rerouteKey(r))).map(r => rerouteKey(r)))].length} 筆異常全部移至無途程區
                  </button>
                )}
                <button onClick={handleDownload}
                  className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-semibold">
                  {dlDone ? '✅ 已下載' : '⬇ 下載 SARA CSV'}
                </button>
              </div>

              {/* 預覽表（僅有途程的列）*/}
              <div className="overflow-x-auto rounded-xl border border-slate-800 max-h-[450px] overflow-y-auto">
                <table className="w-full text-xs text-left border-collapse min-w-max">
                  <thead className="sticky top-0 bg-slate-900 z-10">
                    <tr className="text-slate-400 text-[10px] uppercase">
                      <th className="px-2 py-2 border-b border-slate-800 text-amber-400/70 w-6">✓</th>
                      <th className="px-2 py-2 border-b border-slate-800">廠區</th>
                      <th className="px-2 py-2 border-b border-slate-800">訂單</th>
                      <th className="px-2 py-2 border-b border-slate-800">製令號</th>
                      <th className="px-2 py-2 border-b border-slate-800">品號</th>
                      <th className="px-2 py-2 border-b border-slate-800">品名規格</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-right">生產量</th>
                      <th className="px-2 py-2 border-b border-slate-800">交期</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-center">工序</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-cyan-400">站點</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-emerald-400">製程名稱</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-right">製程量</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-right text-amber-300">工時(min)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {saraRows.filter(r => !r._noRoute).slice(0, 600).map((r, i) => (
                      <tr key={i} className={`border-b border-slate-800/40 hover:bg-slate-900/50 ${flaggedItems.has(rerouteKey(r)) ? 'bg-red-600/20 border-l-2 border-l-red-500' : ''}`}>
                        <td className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={selectedReroute[rerouteKey(r)] ?? false}
                            onChange={e => setSelectedReroute(prev => ({ ...prev, [rerouteKey(r)]: e.target.checked }))}
                            className="accent-amber-400 cursor-pointer"
                          />
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {r.factory
                            ? <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${FACTORY_BADGE[r.factory] ?? ''}`}>{FACTORY_LABEL[r.factory]}</span>
                            : <span className="text-slate-700">—</span>}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-slate-300 whitespace-nowrap">{r.order_number}</td>
                        <td className="px-2 py-1.5 font-mono text-cyan-300/70 whitespace-nowrap text-[10px]">{r.mfg_order_number !== r.order_number ? r.mfg_order_number : '—'}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-200 whitespace-nowrap">{r.product_name}</td>
                        <td className="px-2 py-1.5 text-slate-400 max-w-[160px] truncate text-[10px]" title={r.product_desc}>{r.product_desc || <span className="text-slate-700">—</span>}</td>
                        <td className="px-2 py-1.5 text-right text-white font-mono">{r.prod_qty}</td>
                        <td className="px-2 py-1.5 text-slate-400 whitespace-nowrap">{r.due}</td>
                        <td className="px-2 py-1.5 text-center text-slate-400 font-mono">{r.job_seq}</td>
                        <td className="px-2 py-1.5 text-cyan-300 whitespace-nowrap">{r.workcenter}</td>
                        <td className="px-2 py-1.5 text-emerald-300 whitespace-nowrap">{r.job_name}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{r.job_qty || '—'}</td>
                        <td className="px-2 py-1.5 text-right text-amber-300 font-mono">
                          {r.est_time > 0 ? r.est_time : <span className="text-slate-600">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {successCount > 600 && (
                  <p className="text-center text-xs text-slate-500 py-2">
                    僅顯示前 600 列，下載 CSV 包含全部 {successCount} 工序列
                  </p>
                )}
              </div>
            </div>
          )}

          {/* 無途程訂單 ── 每列獨立套用臨時料號 */}
          {noRouteRows.length > 0 && (
            <div className="bg-amber-600/15 border-2 border-amber-500/60 rounded-xl p-4 space-y-3 shadow shadow-amber-900/30">
              <div className="flex items-center gap-2">
                <span className="text-amber-200 font-bold text-sm">⚠ {noRouteRows.length} 筆訂單無對應途程</span>
                <span className="text-slate-500 text-xs">每筆可套用不同料號的途程，套用後納入匯出</span>
              </div>

              <div className="overflow-x-auto rounded-lg border border-amber-700/20">
                <table className="w-full text-xs">
                  <thead className="bg-amber-900/20 sticky top-0">
                    <tr className="text-amber-300/70 text-[10px] uppercase">
                      <th className="px-2 py-1.5 text-left whitespace-nowrap">廠區</th>
                      <th className="px-2 py-1.5 text-left whitespace-nowrap">訂單</th>
                      <th className="px-2 py-1.5 text-left whitespace-nowrap">品號</th>
                      <th className="px-2 py-1.5 text-left">品名/規格</th>
                      <th className="px-2 py-1.5 text-right whitespace-nowrap">數量</th>
                      <th className="px-2 py-1.5 text-left whitespace-nowrap">指定方式 · 途程</th>
                    </tr>
                  </thead>
                  <tbody>
                    {noRouteRows.map((r) => {
                      const key = rowKey(r)
                      const applying = noRouteApplying[key] ?? false
                      const warn = noRouteApplyWarns[key] ?? ''
                      const code = noRouteCodes[key] ?? ''
                      return (
                        <tr key={key} className="border-t border-amber-700/10">
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            {r.factory
                              ? <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${FACTORY_BADGE[r.factory] ?? ''}`}>{FACTORY_LABEL[r.factory]}</span>
                              : <span className="text-slate-700">—</span>}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-slate-300 whitespace-nowrap">{r.order_number}</td>
                          <td className="px-2 py-1.5 font-mono text-amber-300/80 whitespace-nowrap">{r.item_code}</td>
                          <td className="px-2 py-1.5 text-slate-400 max-w-[200px] truncate" title={r.item_spec}>{r.item_spec || '—'}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-white whitespace-nowrap">{r.quantity}</td>
                          <td className="px-2 py-1.5">
                            <div className="space-y-1">
                              {/* 模式切換 */}
                              <div className="flex gap-1">
                                {(['item', 'route'] as const).map(m => (
                                  <button key={m}
                                    onClick={() => setNoRouteModes(prev => ({ ...prev, [key]: m }))}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors ${
                                      (noRouteModes[key] ?? 'item') === m
                                        ? m === 'item' ? 'bg-emerald-800 text-emerald-200' : 'bg-cyan-800 text-cyan-200'
                                        : 'bg-slate-700 text-slate-500 hover:text-slate-300'
                                    }`}
                                  >
                                    {m === 'item' ? '品號' : '途程名稱'}
                                  </button>
                                ))}
                              </div>
                              {/* 輸入框 + 按鈕 */}
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <input
                                  type="text"
                                  value={code}
                                  onChange={e => setNoRouteCodes(prev => ({ ...prev, [key]: e.target.value }))}
                                  onKeyDown={e => e.key === 'Enter' && void handleApplyTempRoute(r)}
                                  placeholder={(noRouteModes[key] ?? 'item') === 'item' ? '已有途程的料號…' : '途程名稱，如：常平一般壓克力製程'}
                                  className="w-52 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-100 text-xs focus:outline-none focus:border-emerald-500 font-mono"
                                />
                                <button
                                  onClick={() => void handleApplyTempRoute(r)}
                                  disabled={applying || !code.trim()}
                                  className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs font-medium transition-colors whitespace-nowrap"
                                >
                                  {applying ? '套用中…' : '套用 →'}
                                </button>
                                {warn && <span className="text-red-400 text-[10px]">{warn}</span>}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════ SINGLE */}
      {activeTab === 'single' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">品項編碼 <span className="text-red-400">*</span></label>
              <input type="text" value={itemCode} onChange={e => setItemCode(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && void handleSingleGenerate()}
                placeholder="例：PACRTSPE3-55S"
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500 font-mono" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">製令號（選填）</label>
              <input type="text" value={moNumber} onChange={e => setMoNumber(e.target.value)}
                placeholder="例：MOT26070101"
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500 font-mono" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">生產數量</label>
              <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} min={1}
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500" />
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => void handleSingleGenerate()} disabled={singleLoading}
              className="px-5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold">
              {singleLoading ? '查詢中…' : '🔍 查詢工序'}
            </button>
            {singleRows && (
              <button onClick={handleCopyTsv} className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm">
                {copied ? '✅ 已複製 TSV' : '📋 複製 TSV'}
              </button>
            )}
          </div>

          {singleError && (
            <div className="px-4 py-3 bg-red-950/50 border border-red-700/50 rounded-lg text-red-300 text-sm">{singleError}</div>
          )}

          {singleRows && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">途程：<span className="text-cyan-300 font-mono">{singleRoute}</span></span>
                <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">工序數：<span className="font-bold">{singleRows.length}</span></span>
                <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">
                  總工時：<span className="text-amber-300 font-bold">{singleRows.reduce((s, r) => s + r.est_time, 0).toFixed(1)} min</span>
                </span>
              </div>
              {singleWarns.length > 0 && (
                <div className="px-4 py-2 bg-amber-950/40 border border-amber-700/40 rounded-lg">
                  {singleWarns.map((w, i) => <div key={i} className="text-amber-300 text-xs">⚠ {w}</div>)}
                </div>
              )}
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-900/80 text-slate-400 text-[11px] uppercase">
                      <th className="px-3 py-2.5 border-b border-slate-800 w-12 text-center">工序</th>
                      <th className="px-3 py-2.5 border-b border-slate-800">站點</th>
                      <th className="px-3 py-2.5 border-b border-slate-800 text-emerald-400">製程名稱</th>
                      <th className="px-3 py-2.5 border-b border-slate-800 text-right">數量</th>
                      <th className="px-3 py-2.5 border-b border-slate-800 text-right text-amber-300">工時 (min)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {singleRows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-900/50">
                        <td className="px-3 py-2 text-center text-slate-400 font-mono">{r.job_sequence}</td>
                        <td className="px-3 py-2 text-slate-300">{r.workcenter || <span className="text-slate-600">—</span>}</td>
                        <td className="px-3 py-2 text-emerald-300 font-medium">{r.job_name}</td>
                        <td className="px-3 py-2 text-right font-mono">{r.job_quantity}</td>
                        <td className="px-3 py-2 text-right text-amber-300 font-mono">
                          {r.est_time > 0 ? r.est_time : <span className="text-slate-600">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-900/60">
                      <td colSpan={4} className="px-3 py-2 text-right text-xs text-slate-400">合計工時</td>
                      <td className="px-3 py-2 text-right font-bold text-amber-300 font-mono">
                        {singleRows.reduce((s, r) => s + r.est_time, 0).toFixed(1)} min
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="text-[11px] text-slate-600 space-y-0.5 pt-2 border-t border-slate-800/50">
        <p>・工序資料來源：item_routes（品號↔途程）、route_operations（途程→工序順序）、operation_times（工序→站點＋標準工時）</p>
        <p>・製程量：包裝站以生產數量計；其他站點以盤數計（盤數未填時使用生產數量）</p>
        <p>・預估工時 = std_time_min × 製程量；最早開始時間 = 產生時的當日日期</p>
      </div>
    </div>
  )
}
