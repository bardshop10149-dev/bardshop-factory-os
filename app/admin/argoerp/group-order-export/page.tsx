'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ==================== 型別 ====================
interface GroupRow {
  row_key: string
  order_number: string
  doc_type: string
  factory: 'T' | 'C' | 'O'
  customer: string
  item_code: string
  item_name: string
  note: string
  quantity: string
  delivery_date: string
  plate_count: string
  handler: string
  issuer: string
  is_sample: string
  has_material: string
  designer: string
  line_nickname: string
  upload_ro: string
  order_status: string
  pm_note: string
  receiver: string
  mo_status: '已匯入製令' | '暫緩區' | null
  mo_number?: string
  sheet_date: string  // 來源出單日期（本地注入）
}

type PostSyncStep = { label: string; status: 'pending' | 'running' | 'done' | 'error' }

type PreviewGroup = {
  mo: string
  rows: Array<{ row: GroupRow; lineNo: number }>
}

// ==================== 多製品製令工作區型別 ====================
interface MoDetailLine {
  id: string          // 本地唯一 id（非 ERP）
  item_code: string
  item_name: string
  note: string
  order_number: string  // 批號 / 來源銷售訂單
  quantity: string
  delivery_date: string
}

interface MoWorkarea {
  mo_number: string
  department: string
  cost_department: string
  start_date: string      // BEGIN_DATE
  end_date: string        // END_DATE
  lines: MoDetailLine[]
}

const defaultWorkarea = (): MoWorkarea => ({
  mo_number: '',
  department: 'M1100',
  cost_department: 'M1000',
  start_date: '',
  end_date: '',
  lines: [],
})

const defaultLine = (): MoDetailLine => ({
  id: Math.random().toString(36).slice(2),
  item_code: '',
  item_name: '',
  note: '',
  order_number: '',
  quantity: '',
  delivery_date: '',
})

// ==================== 工具函式 ====================
function fmtDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function nextBizDay(from: Date): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

function truncateToBytes(text: string, maxBytes: number): string {
  const enc = new TextEncoder()
  const bytes = enc.encode(text)
  if (bytes.length <= maxBytes) return text
  const dec = new TextDecoder('utf-8')
  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
  return dec.decode(bytes.slice(0, cut))
}

// 建立送往 ERP IFAF028 介面的 payload record（多製品製令）
// ERP 要求：同一 PROJECT_ID 下每行都必須帶完整表頭欄位（開立日期/部門等），LINE_NO 不同即不蓋掉
function buildErpRecord(row: GroupRow, moNumber: string, lineNo: number = 1): Record<string, string> {
  const today = new Date()
  const rec: Record<string, string> = {}
  rec['PROJECT_ID'] = moNumber
  // 表頭欄位：每行都要帶
  rec['BEGIN_DATE'] = fmtDate(nextBizDay(today))
  if (row.delivery_date) rec['END_DATE'] = row.delivery_date.replace(/\//g, '-')
  rec['HOLD_STATUS'] = 'OPEN'
  rec['SEG_SEGMENT_NO_DEPARTMENT'] = 'M1100'
  rec['PJT_SEG_SEGMENT_NO'] = 'M1000'
  rec['MO_BEGIN_DATE'] = fmtDate(today)
  rec['AUTO_PREPARE'] = 'N'
  // 表身欄位
  rec['LINE_NO'] = String(lineNo)
  if (row.item_code) rec['MBP_PART'] = row.item_code
  rec['MBP_VER'] = '1'
  if (row.order_number) rec['MBP_LOT_NO'] = truncateToBytes(row.order_number, 30)
  if (row.quantity) rec['ORDER_QTY'] = row.quantity
  rec['BOM_LEVELS'] = '99'
  rec['EQUIVALENT_RATIO'] = '1'
  rec['EQUIVALENT_RATIO_M'] = '1'
  if (row.order_number) rec['PJT_PROJECT_ID_MO_SO'] = row.order_number
  const noteStr = [row.item_name, row.note].filter(Boolean).join(' ')
  if (noteStr) rec['REMARK_LINE'] = noteStr
  return rec
}

// 2026-06-18 前的出單表若在 packing 欄加入 code 後才儲存，會造成欄位錯位：
// packing←quantity, quantity←delivery_date, delivery_date←plate_count, ...
// 偵測方式：quantity 存了日期字串（如 "2026/7/1"）即判定為錯位，往回移一格還原。
function fixPackingShift(row: GroupRow, sheetDate: string): GroupRow {
  if (sheetDate >= '2026-06-18') return row
  if (!row.quantity || !/^\d{4}[\/\-]/.test(row.quantity)) return row
  return {
    ...row,
    packing:          '',
    quantity:         row.packing         ?? '',
    delivery_date:    row.quantity        ?? '',
    plate_count:      row.delivery_date   ?? '',
    upload_ro:        row.plate_count     ?? '',
    order_status:     row.upload_ro       ?? '',
    pm_note:          row.order_status    ?? '',
    assigned_machine: row.pm_note         ?? '',
  }
}

function FactoryBadge({ factory }: { factory: 'T' | 'C' | 'O' }) {
  const map: Record<string, string> = {
    T: 'bg-blue-900/40 text-blue-300',
    C: 'bg-orange-900/40 text-orange-300',
    O: 'bg-purple-900/40 text-purple-300',
  }
  const label: Record<string, string> = { T: '台北', C: '常平', O: '委外' }
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${map[factory]}`}>
      {label[factory]}
    </span>
  )
}

// ==================== 頁面元件 ====================
export default function GroupOrderExportPage() {
  const [rows, setRows] = useState<GroupRow[]>([])
  const [loading, setLoading] = useState(false)
  const [manualMo, setManualMo] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [postSyncModal, setPostSyncModal] = useState<{ show: boolean; steps: PostSyncStep[]; error: string | null } | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'imported'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [batchMoInput, setBatchMoInput] = useState('')   // 批量指定製令單號
  const [importPreview, setImportPreview] = useState<PreviewGroup[] | null>(null)  // 預覽 Modal
  const [forceReimport, setForceReimport] = useState(false) // 強制重新匯入已匯入的列
  const [autoMatching, setAutoMatching] = useState(false)
  const [autoMatchMsg, setAutoMatchMsg] = useState('')
  const [moQtyMismatch, setMoQtyMismatch] = useState<Set<string>>(new Set())

  // ==================== 多製品製令工作區 ====================
  const [workarea, setWorkarea] = useState<MoWorkarea>(defaultWorkarea)
  const [workareaImporting, setWorkareaImporting] = useState(false)
  const [workareaMsg, setWorkareaMsg] = useState('')
  const [showWorkarea, setShowWorkarea] = useState(false)

  const waSetLine = (id: string, field: keyof MoDetailLine, value: string) =>
    setWorkarea(prev => ({ ...prev, lines: prev.lines.map(l => l.id === id ? { ...l, [field]: value } : l) }))

  const waAddLine = () => setWorkarea(prev => ({ ...prev, lines: [...prev.lines, defaultLine()] }))

  const waRemoveLine = (id: string) => setWorkarea(prev => ({ ...prev, lines: prev.lines.filter(l => l.id !== id) }))

  // 從勾選集單列帶入工作區表身（包含已匯入的列）
  const waImportFromSelected = () => {
    const targets = displayRows.filter(r => selectedKeys.has(r.row_key))
    if (targets.length === 0) { alert('請先勾選集單列'); return }
    const newLines: MoDetailLine[] = targets.map(r => ({
      id: Math.random().toString(36).slice(2),
      item_code: r.item_code ?? '',
      item_name: r.item_name ?? '',
      note: r.note ?? '',
      order_number: r.order_number ?? '',
      quantity: r.quantity ?? '',
      delivery_date: r.delivery_date ?? '',
    }))
    // 若表身為空直接取代，否則追加
    setWorkarea(prev => ({
      ...prev,
      lines: prev.lines.length === 0 ? newLines : [...prev.lines, ...newLines],
    }))
    setShowWorkarea(true)
  }

  const handleWorkareaImport = useCallback(async () => {
    const mo = workarea.mo_number.trim()
    if (!mo) { setWorkareaMsg('❌ 請填入製令單號'); return }
    const validLines = workarea.lines.filter(l => l.item_code.trim())
    if (validLines.length === 0) { setWorkareaMsg('❌ 請至少填入一筆表身明細（生產貨號必填）'); return }

    setWorkareaImporting(true)
    setWorkareaMsg('')
    const today = new Date()
    const fmtD = (d: Date) => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`
    const nextBiz = (d: Date) => { const x = new Date(d); x.setDate(x.getDate()+1); while(x.getDay()===0||x.getDay()===6) x.setDate(x.getDate()+1); return x }

    try {
      // IFAF028 每筆 DATA 都對應一張獨立 MO（會 INSERT PJ_PROJECT）
      // 多行時自動加 -L1/-L2/-L3 後綴，讓每行各自是不同 PROJECT_ID，避免 PK 衝突
      const multiLine = validLines.length > 1
      const moIds = validLines.map((_, i) => multiLine ? `${mo}-L${i + 1}` : mo)

      const payload: Record<string, string>[] = validLines.map((l, i) => {
        const rec: Record<string, string> = { PROJECT_ID: moIds[i] }
        // 表頭欄位
        rec['BEGIN_DATE'] = workarea.start_date
          ? workarea.start_date.replace(/-/g, '/')
          : fmtD(nextBiz(today))
        rec['HOLD_STATUS'] = 'OPEN'
        rec['SEG_SEGMENT_NO_DEPARTMENT'] = workarea.department || 'M1100'
        rec['PJT_SEG_SEGMENT_NO'] = workarea.cost_department || 'M1000'
        rec['MO_BEGIN_DATE'] = fmtD(today)
        rec['AUTO_PREPARE'] = 'N'
        // 表身（每張 MO 只有 1 行，LINE_NO 固定 1）
        rec['LINE_NO'] = '1'
        rec['MBP_PART'] = l.item_code.trim()
        rec['MBP_VER'] = '1'
        if (l.order_number.trim()) {
          rec['MBP_LOT_NO'] = l.order_number.trim().slice(0, 30)
          rec['PJT_PROJECT_ID_MO_SO'] = l.order_number.trim()
        }
        if (l.quantity.trim()) rec['ORDER_QTY'] = l.quantity.trim()
        rec['BOM_LEVELS'] = '99'
        rec['EQUIVALENT_RATIO'] = '1'
        rec['EQUIVALENT_RATIO_M'] = '1'
        const noteStr = [l.item_name, l.note].filter(Boolean).join(' ')
        if (noteStr) rec['REMARK_LINE'] = noteStr
        // 每行用自己的交付日（若有）覆蓋 END_DATE；否則用表頭結案日
        const endDate = l.delivery_date
          ? l.delivery_date.replace(/-/g, '/')
          : workarea.end_date
            ? workarea.end_date.replace(/-/g, '/')
            : undefined
        if (endDate) rec['END_DATE'] = endDate
        return rec
      })

      const resp = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId: 'IFAF028', data: payload }),
      })
      const res = await resp.json()
      const argoRows: Record<string, unknown>[] = Array.isArray(res?.apiResult?.RESULT) ? res.apiResult.RESULT : []
      const failedRows = argoRows.filter((x: Record<string, unknown>) => String(x.CHECK_FLAG ?? '').toUpperCase() === 'N')
      if (failedRows.length === 0 && (resp.ok || argoRows.length > 0)) {
        const moList = multiLine ? `（${moIds.join('、')}）` : `（${mo}）`
        setWorkareaMsg(`✅ 全部 ${validLines.length} 筆匯入成功 ${moList}`)
      } else if (failedRows.length > 0) {
        const errSummary = failedRows.slice(0, 5)
          .map((x: Record<string, unknown>) => String(x.ERROR_CODE ?? x.ERROR ?? '').trim())
          .filter(Boolean).join(' / ')
        setWorkareaMsg(`⚠ 成功 ${validLines.length - failedRows.length}，失敗 ${failedRows.length}：${errSummary}`)
      } else {
        setWorkareaMsg(`❌ ${res?.error || `HTTP ${resp.status}`}`)
      }
    } catch (e) {
      setWorkareaMsg(`❌ ${e}`)
    } finally {
      setWorkareaImporting(false)
    }
  }, [workarea])

  // ---- 從 Supabase 載入所有含「集單」的列 ----
  const loadRows = useCallback(async () => {
    setLoading(true)
    setSaveMsg('')
    try {
      const { data: sheets, error } = await supabase
        .from('daily_order_sheets')
        .select('sheet_date, rows')
        .order('sheet_date', { ascending: false })
      if (error) throw error

      const allRows: GroupRow[] = []
      for (const sheet of (sheets ?? [])) {
        const sheetRows = Array.isArray(sheet.rows) ? (sheet.rows as GroupRow[]) : []
        for (const rawRow of sheetRows) {
          if ((rawRow.doc_type ?? '').includes('集單')) {
            // 2026-06-18 前的資料若 quantity 欄存了日期字串，代表欄位因 packing 欄錯位，
            // 需要把各欄往回移一格還原正確對應
            const row = fixPackingShift({ ...rawRow, sheet_date: sheet.sheet_date }, sheet.sheet_date)
            allRows.push(row)
          }
        }
      }
      setRows(allRows)

      // 預填已有的製令單號
      const mo: Record<string, string> = {}
      for (const r of allRows) {
        if (r.mo_number) mo[r.row_key] = r.mo_number
      }
      setManualMo(mo)
    } catch (e) {
      setSaveMsg(`❌ 載入失敗：${e}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadRows() }, [loadRows])

  // ---- 計算顯示列 ----
  const displayRows = rows.filter(r => {
    if (filterStatus === 'pending' && r.mo_status === '已匯入製令') return false
    if (filterStatus === 'imported' && r.mo_status !== '已匯入製令') return false
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      return (
        r.order_number?.toLowerCase().includes(q) ||
        r.item_code?.toLowerCase().includes(q) ||
        r.item_name?.toLowerCase().includes(q) ||
        r.customer?.toLowerCase().includes(q) ||
        r.doc_type?.toLowerCase().includes(q) ||
        (manualMo[r.row_key] ?? '').toLowerCase().includes(q)
      )
    }
    return true
  }).sort((a, b) => {
    const aPin = a.mo_status === '已匯入製令' ? 0 : 1
    const bPin = b.mo_status === '已匯入製令' ? 0 : 1
    return aPin - bPin
  })

  const allSelected = displayRows.length > 0 && displayRows.every(r => selectedKeys.has(r.row_key))
  const toggleAll = () => {
    if (allSelected) setSelectedKeys(new Set())
    else setSelectedKeys(new Set(displayRows.map(r => r.row_key)))
  }

  function getTargetRows(requireMo: boolean): GroupRow[] {
    const base = selectedKeys.size > 0
      ? displayRows.filter(r => selectedKeys.has(r.row_key))
      : displayRows
    if (requireMo) return base.filter(r => (manualMo[r.row_key] ?? '').trim() !== '')
    return base
  }

  // ---- 自動比對製令單號（查 erp_mo_lines：批號=銷售單號 + 品項 + 數量）----
  const handleAutoMatch = useCallback(async () => {
    setAutoMatching(true)
    setAutoMatchMsg('')
    try {
      // 步驟 0：只把「已匯入製令」的 rows 直接填回 manualMo（這些已進 ERP，信任儲存值）
      // 尚未匯入的列即使有 mo_number 也要重查 ERP，避免儲存了錯誤值
      let prefilled = 0
      setManualMo(prev => {
        const next = { ...prev }
        for (const r of rows) {
          if (r.mo_status === '已匯入製令' && r.mo_number && !next[r.row_key]) {
            next[r.row_key] = r.mo_number
            prefilled++
          }
        }
        return next
      })

      // 步驟 1：所有有訂單號且「尚未匯入」的列都重新向 ERP 比對（不管是否已有 mo_number）
      const needMatch = rows.filter(r => r.order_number?.trim() && r.mo_status !== '已匯入製令')
      if (needMatch.length === 0) {
        setAutoMatchMsg(prefilled > 0
          ? `✅ 已從集單資料填入 ${prefilled} 筆製令單號（均為已匯入製令）`
          : 'ℹ️ 所有列都已有製令單號')
        setTimeout(() => setAutoMatchMsg(''), 6000)
        return
      }

      const orderNumbers = [...new Set(needMatch.map(r => r.order_number.trim()))]

      // 同時查兩個欄位：
      //   source_order = PJT_PROJECT_ID_MO_SO（我們送 IFAF028 時填的 SO 號）
      //   mbp_lot_no   = MBP_LOT_NO（批號，也會填 SO 號）
      const [res1, res2, resCount] = await Promise.all([
        supabase.from('erp_mo_lines')
          .select('project_id, source_order, mbp_lot_no, mbp_part, order_qty')
          .in('source_order', orderNumbers),
        supabase.from('erp_mo_lines')
          .select('project_id, source_order, mbp_lot_no, mbp_part, order_qty')
          .in('mbp_lot_no', orderNumbers),
        supabase.from('erp_mo_lines').select('project_id', { count: 'exact', head: true }),
      ])
      if (res1.error) throw res1.error
      if (res2.error) throw res2.error

      const totalInTable = resCount.count ?? 0
      const moLines = [
        ...(res1.data ?? []),
        ...(res2.data ?? []).filter(r2 =>
          !(res1.data ?? []).some(r1 => r1.project_id === r2.project_id)
        ),
      ]

      if (moLines.length === 0) {
        const diagMsg = totalInTable === 0
          ? `⚠ erp_mo_lines 尚無資料（請先到「ERP 同步」頁執行製令同步）${prefilled > 0 ? `（已從集單資料填入 ${prefilled} 筆）` : ''}`
          : `⚠ ERP 同步區 ${totalInTable} 筆製令中，無 source_order 或 mbp_lot_no 符合集單訂單號（請確認已執行最新一次製令同步）${prefilled > 0 ? `，已從集單資料填入 ${prefilled} 筆` : ''}`
        setAutoMatchMsg(diagMsg)
        setTimeout(() => setAutoMatchMsg(''), 10000)
        return
      }

      // 建比對 map：key = `來源訂單號|品項碼`（必須兩者都符合）
      // 同時記錄 ERP 的數量，用來判斷是否數量不符
      // source_order 優先，其次 mbp_lot_no；只接受 MOT/MOM 開頭的製令
      const matchMap = new Map<string, { project_id: string; erp_qty: number }>()
      for (const line of moLines) {
        const so   = (line.source_order ?? line.mbp_lot_no ?? '').trim()
        const part = (line.mbp_part ?? '').trim()
        if (!so || !part || !line.project_id) continue
        if (!/^MO[TM]/i.test(line.project_id)) continue
        const key = `${so}|${part}`
        const existing = matchMap.get(key)
        if (!existing || line.project_id > existing.project_id) {
          matchMap.set(key, { project_id: line.project_id, erp_qty: Number(line.order_qty ?? 0) })
        }
      }

      let matched = 0
      let qtyMismatch = 0
      let dupSkipped = 0
      const newMismatchKeys = new Set<string>()
      const newlyMatched: Record<string, string> = {}
      // 防止同一個 MO 被分配給多筆集單列（一個 MO 只能對應一筆）
      const usedProjectIds = new Set<string>()

      for (const r of needMatch) {
        const key = `${r.order_number.trim()}|${r.item_code.trim()}`
        const hit = matchMap.get(key)
        if (!hit) continue
        if (usedProjectIds.has(hit.project_id)) {
          // 同一 MO 已被另一筆列使用，跳過並計數警告
          dupSkipped++
          continue
        }
        usedProjectIds.add(hit.project_id)
        newlyMatched[r.row_key] = hit.project_id
        matched++
        // 數量比對（出單表的數量可能是日期偏移，只在明顯是數字時比）
        const rowQty = Math.round(Number(r.quantity ?? 0))
        const erpQty = Math.round(hit.erp_qty)
        if (!isNaN(rowQty) && rowQty > 0 && rowQty !== erpQty) {
          newMismatchKeys.add(r.row_key)
          qtyMismatch++
        }
      }

      setManualMo(prev => ({ ...prev, ...newlyMatched }))
      setMoQtyMismatch(prev => {
        const next = new Set(prev)
        for (const k of newMismatchKeys) next.add(k)
        return next
      })

      // 自動儲存新比對到的製令單號（step1 新增的）
      if (matched > 0) {
        const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
        for (const r of needMatch) {
          const mo = newlyMatched[r.row_key]
          if (!mo) continue
          const arr = byDate.get(r.sheet_date) ?? []
          arr.push({ row_key: r.row_key, mo_number: mo })
          byDate.set(r.sheet_date, arr)
        }
        for (const [date, updates] of byDate) {
          await fetch('/api/argoerp/daily-order-sheet', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sheet_date: date, updates }),
          })
        }
        setRows(prev => prev.map(r => {
          const mo = newlyMatched[r.row_key]
          return mo ? { ...r, mo_number: mo } : r
        }))
      }

      const total = matched
      const prefilledNote = prefilled > 0 ? `（另從集單資料取回 ${prefilled} 筆）` : ''
      const dupNote = dupSkipped > 0 ? `⚠ 另有 ${dupSkipped} 筆因 ERP 製令重複使用被跳過（同一 MO 僅允許對應一筆集單列）` : ''
      if (total === 0 && dupSkipped === 0) {
        // 診斷：取第一筆 erp_mo_lines 樣本 vs 第一筆集單列
        const sampleMo = moLines.find(l => /^MO[TM]/i.test(l.project_id ?? '')) ?? moLines[0]
        const sampleRow = needMatch[0]
        const diagLines = [
          `ERP 樣本：so=${sampleMo?.source_order ?? '(null)'}  lot=${sampleMo?.mbp_lot_no ?? '(null)'}  part=${sampleMo?.mbp_part ?? '(null)'}`,
          `集單樣本：order=${sampleRow?.order_number}  item=${sampleRow?.item_code}`,
        ]
        setAutoMatchMsg(`⚠ ERP 比對 ${needMatch.length} 筆無符合${prefilledNote}（需批號+品項均符合）｜${diagLines.join('｜')}`)
      } else {
        const mismatchNote = qtyMismatch > 0 ? `，其中 ${qtyMismatch} 筆數量不符（已標橘色警示）` : ''
        const savedNote = total > 0 ? ` 並已自動儲存` : ''
        const msgs = [`✅ ERP 比對符合 ${total} 筆${prefilledNote}${mismatchNote}${savedNote}`]
        if (dupNote) msgs.push(dupNote)
        setAutoMatchMsg(msgs.join('｜'))
      }
      setTimeout(() => setAutoMatchMsg(''), 12000)
    } catch (e) {
      setAutoMatchMsg(`❌ 比對失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setAutoMatchMsg(''), 8000)
    } finally {
      setAutoMatching(false)
    }
  }, [rows])

  // ---- 儲存製令單號至出單表（不匯入 ERP）----
  const handleSaveMo = useCallback(async () => {
    const targets = getTargetRows(true).filter(r => r.mo_status !== '已匯入製令')
    if (targets.length === 0) {
      setSaveMsg('ℹ️ 沒有可儲存的列（請確認已填寫製令單號）')
      setTimeout(() => setSaveMsg(''), 3000)
      return
    }
    setSaving(true)
    setSaveMsg('')
    try {
      const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
      for (const r of targets) {
        const arr = byDate.get(r.sheet_date) ?? []
        arr.push({ row_key: r.row_key, mo_number: (manualMo[r.row_key] ?? '').trim() })
        byDate.set(r.sheet_date, arr)
      }
      for (const [date, updates] of byDate) {
        const res = await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheet_date: date,
            updates: updates.map(u => ({ row_key: u.row_key, mo_number: u.mo_number })),
          }),
        })
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      }
      setRows(prev => prev.map(r => {
        const hit = targets.find(t => t.row_key === r.row_key)
        if (!hit) return r
        return { ...r, mo_number: manualMo[r.row_key] }
      }))
      setSaveMsg(`✅ 已儲存 ${targets.length} 筆製令單號`)
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ 儲存失敗：${e}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally {
      setSaving(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selectedKeys, displayRows, manualMo])

  // ---- 匯入後自動同步 ----
  const runPostImportSync = useCallback(async (sheetDate: string) => {
    const steps: PostSyncStep[] = [
      { label: 'ERP 同步：製令', status: 'running' },
      { label: `重新載入出單表（${sheetDate}）`, status: 'pending' },
    ]
    const setStep = (idx: number, status: PostSyncStep['status']) =>
      setPostSyncModal(prev => prev ? {
        ...prev,
        steps: prev.steps.map((s, i) => i === idx ? { ...s, status } : s),
      } : null)
    setPostSyncModal({ show: true, steps, error: null })
    try {
      const syncRes = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_mo' }),
      })
      const syncJson = await syncRes.json() as { status?: string; error?: unknown }
      if (!syncRes.ok || syncJson.status !== 'ok') {
        throw new Error(`ERP 同步失敗：${String(syncJson.error ?? `HTTP ${syncRes.status}`)}`)
      }
      setStep(0, 'done')
      setStep(1, 'running')
      await loadRows()
      setStep(1, 'done')
    } catch (e) {
      setPostSyncModal(prev => prev ? { ...prev, error: e instanceof Error ? e.message : String(e) } : null)
    }
  }, [loadRows])

  // ---- 預覽（建立分組，不呼叫 ERP）----
  const handleShowPreview = useCallback(() => {
    const targets = forceReimport ? getTargetRows(true) : getTargetRows(true).filter(r => r.mo_status !== '已匯入製令')
    if (targets.length === 0) {
      alert('⚠️ 沒有可匯入的列（請確認已填寫製令單號且尚未匯入）')
      return
    }
    const moGroups = new Map<string, GroupRow[]>()
    for (const r of targets) {
      const mo = (manualMo[r.row_key] ?? '').trim()
      if (!moGroups.has(mo)) moGroups.set(mo, [])
      moGroups.get(mo)!.push(r)
    }
    const groups: PreviewGroup[] = []
    for (const [mo, groupRows] of moGroups) {
      groups.push({ mo, rows: groupRows.map((r, i) => ({ row: r, lineNo: i + 1 })) })
    }
    setImportPreview(groups)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selectedKeys, displayRows, manualMo, forceReimport])
  const handleImport = useCallback(async () => {
    const targets = forceReimport ? getTargetRows(true) : getTargetRows(true).filter(r => r.mo_status !== '已匯入製令')
    if (targets.length === 0) {
      alert('⚠️ 沒有可匯入的列（請確認已填寫製令單號且尚未匯入）')
      return
    }
    setImporting(true)
    setSaveMsg('')
    try {
      // 按 MO 號分組，同一 MO 下的列依序指定 LINE_NO
      // 每行都帶完整表頭欄位（ERP 要求），全部放進單一 DATA 陣列一次送出
      const moGroups = new Map<string, GroupRow[]>()
      for (const r of targets) {
        const mo = (manualMo[r.row_key] ?? '').trim()
        if (!moGroups.has(mo)) moGroups.set(mo, [])
        moGroups.get(mo)!.push(r)
      }
      const payload: Record<string, string>[] = []
      for (const [mo, groupRows] of moGroups) {
        groupRows.forEach((r, i) => {
          payload.push(buildErpRecord(r, mo, i + 1))
        })
      }
      const response = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId: 'IFAF028', data: payload }),
      })
      const result = await response.json()
      const argoResults: Record<string, unknown>[] = Array.isArray(result?.apiResult?.RESULT)
        ? (result.apiResult.RESULT as Record<string, unknown>[]) : []
      const hasN = argoResults.some(r => String(r.CHECK_FLAG ?? '').toUpperCase() === 'N')
      const lineResults: Array<{ row: GroupRow; ok: boolean; error?: string }> = []
      if (argoResults.length > 0 && !hasN) {
        // 全部成功
        for (const r of targets) lineResults.push({ row: r, ok: true })
      } else if (hasN) {
        // 有失敗：收集明確失敗的 PROJECT_ID
        const failedMos = new Map<string, string[]>()
        for (const r of argoResults) {
          if (String(r.CHECK_FLAG ?? '').toUpperCase() === 'N') {
            const slip = String(r.SLIP_NO ?? '').trim()
            const err = String(r.ERROR_CODE ?? r.ERROR ?? '').trim()
            if (slip) { if (!failedMos.has(slip)) failedMos.set(slip, []); failedMos.get(slip)!.push(err) }
          }
        }
        for (const r of targets) {
          const mo = (manualMo[r.row_key] ?? '').trim()
          if (failedMos.has(mo)) lineResults.push({ row: r, ok: false, error: failedMos.get(mo)!.join(' / ') })
          else lineResults.push({ row: r, ok: true })
        }
      } else if (result?.success === true) {
        for (const r of targets) lineResults.push({ row: r, ok: true })
      } else {
        throw new Error(result?.error || result?.message || `HTTP ${response.status}`)
      }

      const successRows: GroupRow[] = lineResults.filter(x => x.ok).map(x => x.row)
      const failedRows: Array<{ row: GroupRow; error: string }> = lineResults.filter(x => !x.ok).map(x => ({ row: x.row, error: x.error ?? '未知錯誤' }))

      if (successRows.length > 0) {
        const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
        for (const r of successRows) {
          const arr = byDate.get(r.sheet_date) ?? []
          arr.push({ row_key: r.row_key, mo_number: (manualMo[r.row_key] ?? '').trim() })
          byDate.set(r.sheet_date, arr)
        }
        for (const [date, updates] of byDate) {
          await fetch('/api/argoerp/daily-order-sheet', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sheet_date: date,
              updates: updates.map(u => ({
                row_key: u.row_key,
                mo_status: '已匯入製令',
                mo_number: u.mo_number,
              })),
            }),
          }).catch(() => {})
        }

        const now = new Date()
        fetch('/api/argoerp/mo-upload-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: successRows.map(r => ({
              mo_number: (manualMo[r.row_key] ?? '').trim(),
              factory: r.factory,
              product_code: r.item_code,
              planned_qty: r.quantity,
              source_order: r.order_number,
              lot_number: truncateToBytes(r.order_number, 30),
              mo_note: [r.item_name, r.note].filter(Boolean).join(' '),
              planned_start_date: fmtDate(nextBizDay(now)),
              planned_end_date: r.delivery_date,
              create_date: fmtDate(now),
              interface_id: 'IFAF028',
            })),
          }),
        }).catch(() => {})

        const successKeys = new Set(successRows.map(r => r.row_key))
        setRows(prev => prev.map(r => {
          if (!successKeys.has(r.row_key)) return r
          return { ...r, mo_status: '已匯入製令', mo_number: manualMo[r.row_key] }
        }))
      }

      const msg = `✅ 成功 ${successRows.length} 筆${failedRows.length > 0 ? `，❌ 失敗 ${failedRows.length} 筆` : ''}`
      setSaveMsg(msg)
      if (failedRows.length > 0) {
        alert(`${msg}\n\n失敗明細：\n${failedRows.slice(0, 10).map(f => `${f.row.order_number} [${f.row.item_code}]: ${f.error}`).join('\n')}`)
      }
      if (successRows.length > 0) {
        const today = new Date().toISOString().slice(0, 10)
        void runPostImportSync(today)
      }
      setTimeout(() => setSaveMsg(''), 8000)
    } catch (e) {
      setSaveMsg(`❌ 匯入失敗：${e}`)
      setTimeout(() => setSaveMsg(''), 8000)
    } finally {
      setImporting(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selectedKeys, displayRows, manualMo, forceReimport])

  // ---- 列印（套用製令工單格式）----
  const handlePrint = useCallback(() => {
    const targets = selectedKeys.size > 0
      ? displayRows.filter(r => selectedKeys.has(r.row_key))
      : displayRows
    if (targets.length === 0) return

    const moRecords = targets.map(r => {
      const moNumber = (manualMo[r.row_key] ?? '').trim() || (r.mo_number ?? '').trim() || r.order_number
      return {
        mo_number: moNumber,
        planned_start_date: '',
        planned_end_date: r.delivery_date,
        mo_status: r.mo_status || '',
        department: '',
        product_code: r.item_code,
        lot_number: r.customer,
        planned_qty: String(r.quantity ?? ''),
        source_order: r.order_number,
        mo_note: [r.item_name, r.note, r.plate_count ? `盤數：${r.plate_count}` : ''].filter(Boolean).join(' | '),
        create_date: r.sheet_date,
        factory: r.factory,
        prep_status: '',
        machine: '',
      }
    })

    sessionStorage.setItem('mo_print_selection', JSON.stringify(moRecords))
    window.open('/admin/argoerp/mo-summary/print', '_blank')
  }, [displayRows, selectedKeys, manualMo])

  const importedCount = rows.filter(r => r.mo_status === '已匯入製令').length
  const pendingCount = rows.length - importedCount

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto space-y-4">

        {/* 標題區 */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">集合單 ➜ 製令工單</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              顯示所有出單表中單據種類含「集單」的項目，不限日期。按「自動比對製令」填入製令單號後可匯入 ERP。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={loadRows}
              disabled={loading}
              className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-white text-xs disabled:opacity-50"
            >
              {loading ? '載入中…' : '🔄 重新載入'}
            </button>
            <button
              onClick={() => void handleAutoMatch()}
              disabled={autoMatching || loading}
              className="px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-600 text-white text-xs font-semibold disabled:opacity-50"
            >
              {autoMatching ? '比對中…' : '🔍 自動比對製令'}
            </button>
            <button
              onClick={handleSaveMo}
              disabled={saving || importing || loading}
              className="px-4 py-1.5 rounded bg-slate-600 hover:bg-slate-500 text-white text-xs font-semibold disabled:opacity-50"
            >
              {saving ? '儲存中…' : '💾 儲存製令單號'}
            </button>
            <button
              onClick={handleShowPreview}
              disabled={importing || saving || loading}
              className="px-4 py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold disabled:opacity-50"
            >
              {importing ? '匯入中…' : '⬆ 匯入 ERP 製令工單'}
            </button>
            <label className={`flex items-center gap-1.5 cursor-pointer px-3 py-1.5 rounded border text-xs font-medium select-none transition-colors ${
              forceReimport
                ? 'bg-red-900/60 border-red-600 text-red-300'
                : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'
            }`}>
              <input
                type="checkbox"
                checked={forceReimport}
                onChange={e => setForceReimport(e.target.checked)}
                className="accent-red-500 cursor-pointer"
              />
              強制重新匯入
            </label>
            <button
              onClick={handlePrint}
              disabled={loading || displayRows.length === 0}
              className="px-4 py-1.5 rounded bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-semibold disabled:opacity-50"
            >
              🖨 套用製令格式列印{selectedKeys.size > 0 ? ` (${selectedKeys.size})` : ''}
            </button>
            <button
              onClick={() => setShowWorkarea(v => !v)}
              className={`px-4 py-1.5 rounded text-xs font-semibold border transition-colors ${
                showWorkarea
                  ? 'bg-violet-700 border-violet-500 text-white'
                  : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-violet-500 hover:text-violet-300'
              }`}
            >
              🗂 多製品製令工作區
            </button>
          </div>
        </div>

        {/* ====== 多製品製令工作區 ====== */}
        {showWorkarea && (
          <div className="border border-violet-700/60 rounded-xl bg-violet-950/20 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-violet-200">🗂 多製品製令工作區（IFAF028）</h2>
              <div className="flex items-center gap-2">
                {selectedKeys.size > 0 && (
                  <button
                    onClick={waImportFromSelected}
                    className="px-3 py-1.5 rounded bg-violet-800 hover:bg-violet-700 text-violet-100 text-xs font-semibold border border-violet-600"
                  >
                    ⬇ 帶入已勾選 {selectedKeys.size} 筆
                  </button>
                )}
                <button
                  onClick={() => { setWorkarea(defaultWorkarea()); setWorkareaMsg('') }}
                  className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs border border-slate-600"
                >
                  清空
                </button>
              </div>
            </div>

            {/* 表頭 */}
            <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-4">
              <div className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wide">表頭（PJ_PROJECT）</div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <div className="lg:col-span-2">
                  <label className="block text-[11px] text-slate-400 mb-1">＊製令單號 PROJECT_ID</label>
                  <input value={workarea.mo_number} onChange={e => setWorkarea(p => ({...p, mo_number: e.target.value}))}
                    placeholder="MOM2026…"
                    className="w-full bg-slate-800 border border-violet-600/60 text-violet-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-violet-400 font-mono placeholder-slate-600" />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">部門 SEG_DEPT</label>
                  <input value={workarea.department} onChange={e => setWorkarea(p => ({...p, department: e.target.value}))}
                    className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-slate-400 font-mono" />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">成本部門 PJT_SEG</label>
                  <input value={workarea.cost_department} onChange={e => setWorkarea(p => ({...p, cost_department: e.target.value}))}
                    className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-slate-400 font-mono" />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">預計投產日 BEGIN_DATE</label>
                  <input type="date" value={workarea.start_date} onChange={e => setWorkarea(p => ({...p, start_date: e.target.value}))}
                    className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-slate-400" />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">預計結案日 END_DATE</label>
                  <input type="date" value={workarea.end_date} onChange={e => setWorkarea(p => ({...p, end_date: e.target.value}))}
                    className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-slate-400" />
                </div>
              </div>
            </div>

            {/* 表身 */}
            <div className="bg-slate-900/60 border border-slate-700 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-700 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">表身明細（PJ_PROJECTDETAIL）</span>
                <button onClick={waAddLine}
                  className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs border border-slate-600">
                  ＋ 新增行
                </button>
              </div>
              {workarea.lines.length === 0 ? (
                <div className="px-4 py-6 text-center text-slate-600 text-xs">尚無明細。按「新增行」或「帶入已勾選」來新增。</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-800/60 text-slate-400 text-[11px]">
                        <th className="px-2 py-2 text-center w-10">LINE</th>
                        <th className="px-2 py-2 text-left min-w-[120px]">＊生產貨號 MBP_PART</th>
                        <th className="px-2 py-2 text-left min-w-[160px]">品名 REMARK（前段）</th>
                        <th className="px-2 py-2 text-left min-w-[120px]">備註 REMARK（後段）</th>
                        <th className="px-2 py-2 text-left min-w-[120px]">批號/銷售訂單 MBP_LOT_NO</th>
                        <th className="px-2 py-2 text-right w-24">數量 ORDER_QTY</th>
                        <th className="px-2 py-2 text-left w-32">交付日 END_DATE</th>
                        <th className="px-2 py-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {workarea.lines.map((l, i) => (
                        <tr key={l.id} className="border-t border-slate-800/60">
                          <td className="px-2 py-1.5 text-center text-violet-400 font-mono font-bold">{i + 1}</td>
                          <td className="px-2 py-1.5">
                            <input value={l.item_code} onChange={e => waSetLine(l.id, 'item_code', e.target.value)}
                              placeholder="P3CCADC-…"
                              className="w-full bg-slate-800 border border-slate-600 text-purple-300 text-xs rounded px-2 py-1 focus:outline-none focus:border-purple-400 font-mono placeholder-slate-600" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input value={l.item_name} onChange={e => waSetLine(l.id, 'item_name', e.target.value)}
                              placeholder="品名…"
                              className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-slate-400 placeholder-slate-600" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input value={l.note} onChange={e => waSetLine(l.id, 'note', e.target.value)}
                              placeholder="規格備註…"
                              className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-slate-400 placeholder-slate-600" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input value={l.order_number} onChange={e => waSetLine(l.id, 'order_number', e.target.value)}
                              placeholder="RO / SO…"
                              className="w-full bg-slate-800 border border-slate-600 text-cyan-300 text-xs rounded px-2 py-1 focus:outline-none focus:border-cyan-400 font-mono placeholder-slate-600" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input type="number" value={l.quantity} onChange={e => waSetLine(l.id, 'quantity', e.target.value)}
                              placeholder="0"
                              className="w-full bg-slate-800 border border-slate-600 text-white text-xs rounded px-2 py-1 focus:outline-none focus:border-slate-400 text-right placeholder-slate-600" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input type="date" value={l.delivery_date} onChange={e => waSetLine(l.id, 'delivery_date', e.target.value)}
                              className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-slate-400" />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button onClick={() => waRemoveLine(l.id)}
                              className="text-slate-600 hover:text-red-400 text-sm leading-none">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 匯入按鈕 */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={() => void handleWorkareaImport()}
                disabled={workareaImporting || !workarea.mo_number.trim() || workarea.lines.filter(l => l.item_code.trim()).length === 0}
                className="px-5 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white text-sm font-semibold flex items-center gap-2"
              >
                {workareaImporting
                  ? <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>匯入中…</>
                  : '⬆ 送出匯入 ERP'
                }
              </button>
              <span className="text-xs text-slate-500">
                共 {workarea.lines.filter(l => l.item_code.trim()).length} 筆有效明細 / {workarea.lines.length} 行
                {workarea.lines.filter(l => l.item_code.trim()).length > 1 && (
                  <span className="ml-1 text-violet-400">（多行時自動加 -L1/-L2 後綴，各自一張 MO）</span>
                )}
              </span>
              {workareaMsg && (
                <span className={`text-xs px-3 py-1.5 rounded border ${
                  workareaMsg.startsWith('✅') ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50'
                  : workareaMsg.startsWith('⚠') ? 'bg-yellow-900/50 text-yellow-300 border-yellow-700/50'
                  : 'bg-red-900/50 text-red-300 border-red-700/50'
                }`}>{workareaMsg}</span>
              )}
            </div>
          </div>
        )}
        {saveMsg && (
          <div className={`px-4 py-2 rounded text-sm border ${
            saveMsg.startsWith('✅') ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50'
            : saveMsg.startsWith('ℹ️') ? 'bg-slate-800 text-slate-300 border-slate-700'
            : 'bg-red-900/50 text-red-300 border-red-700/50'
          }`}>
            {saveMsg}
          </div>
        )}
        {autoMatchMsg && (
          <div className={`px-4 py-2 rounded text-sm border ${
            autoMatchMsg.startsWith('✅') ? 'bg-teal-900/50 text-teal-300 border-teal-700/50'
            : autoMatchMsg.startsWith('⚠') ? 'bg-yellow-900/50 text-yellow-300 border-yellow-700/50'
            : autoMatchMsg.startsWith('ℹ️') ? 'bg-slate-800 text-slate-300 border-slate-700'
            : 'bg-red-900/50 text-red-300 border-red-700/50'
          }`}>
            {autoMatchMsg}
          </div>
        )}

        {/* 統計 + 篩選 */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-300">
            共 <span className="text-cyan-300 font-bold">{rows.length}</span> 筆・
            已匯入：<span className="text-emerald-400">{importedCount}</span>・
            待匯入：<span className="text-amber-400">{pendingCount}</span>
          </span>
          <div className="flex gap-1 text-xs">
            {(['all', 'pending', 'imported'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilterStatus(f)}
                className={`px-2.5 py-1 rounded border transition-colors ${
                  filterStatus === f
                    ? 'bg-cyan-800 border-cyan-600 text-cyan-200'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {f === 'all' ? '全部' : f === 'pending' ? '待匯入' : '已匯入'}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜尋工單、品項、客戶、製令…"
            className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded px-3 py-1.5 w-56 focus:outline-none focus:border-cyan-500 placeholder-slate-500"
          />
          {selectedKeys.size > 0 && (
            <span className="text-xs text-cyan-400">已選 {selectedKeys.size} 筆</span>
          )}
        </div>

        {/* 表格 */}
        {loading ? (
          <div className="text-center py-20 text-slate-500 text-sm">載入中…</div>
        ) : displayRows.length === 0 ? (
          <div className="text-center py-20 text-slate-500 text-sm">
            {rows.length === 0 ? '所有出單表中目前無「集單」類型的資料' : '篩選條件下無符合的列'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-slate-900 text-slate-400 uppercase text-[11px]">
                  <th className="px-2 py-2 border-b border-slate-800 w-8 text-center">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-cyan-500 cursor-pointer" />
                  </th>
                  <th className="px-3 py-2 border-b border-slate-800 w-8">#</th>
                  <th className="px-3 py-2 border-b border-slate-800 whitespace-nowrap"><div className="text-slate-500">出單日期</div><div className="text-cyan-400">工單編號</div></th>
                  <th className="px-3 py-2 border-b border-slate-800">客戶</th>
                  <th className="px-3 py-2 border-b border-slate-800 text-purple-300 min-w-[260px]">品項編碼 / 品名規格</th>
                  <th className="px-3 py-2 border-b border-slate-800">備註</th>
                  <th className="px-3 py-2 border-b border-slate-800 text-right">數量</th>
                  <th className="px-3 py-2 border-b border-slate-800 whitespace-nowrap">交付日</th>
                  <th className="px-3 py-2 border-b border-slate-800">承辦人</th>
                  <th className="px-3 py-2 border-b border-slate-800 text-teal-300 min-w-[160px]">製令單號（自動比對）</th>
                  <th className="px-3 py-2 border-b border-slate-800 w-24">狀態</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // 預先計算 MO 分組（只計有填製令且多筆的 MO）
                  const moLineMap = new Map<string, number>() // row_key → LINE_NO within its MO
                  const moCountMap = new Map<string, number>() // mo → total count
                  for (const r of displayRows) {
                    const mo = (manualMo[r.row_key] ?? r.mo_number ?? '').trim()
                    if (!mo) continue
                    moCountMap.set(mo, (moCountMap.get(mo) ?? 0) + 1)
                  }
                  const moLineCounter = new Map<string, number>()
                  for (const r of displayRows) {
                    const mo = (manualMo[r.row_key] ?? r.mo_number ?? '').trim()
                    if (!mo || (moCountMap.get(mo) ?? 0) <= 1) continue
                    const next = (moLineCounter.get(mo) ?? 0) + 1
                    moLineCounter.set(mo, next)
                    moLineMap.set(r.row_key, next)
                  }
                  // 為每個多筆 MO 指定顏色
                  const moColorMap = new Map<string, string>()
                  const colorPalette = ['border-l-violet-500', 'border-l-cyan-500', 'border-l-amber-500', 'border-l-rose-500', 'border-l-teal-500']
                  let colorIdx = 0
                  for (const mo of moCountMap.keys()) {
                    if ((moCountMap.get(mo) ?? 0) > 1) {
                      moColorMap.set(mo, colorPalette[colorIdx % colorPalette.length])
                      colorIdx++
                    }
                  }

                  return displayRows.map((row, idx) => {
                    const isImported = row.mo_status === '已匯入製令'
                    const hasMo = !!(manualMo[row.row_key] ?? '').trim()
                    const currentMo = (manualMo[row.row_key] ?? row.mo_number ?? '').trim()
                    const lineNo = moLineMap.get(row.row_key)
                    const isMulti = lineNo !== undefined
                    const borderColor = isMulti ? moColorMap.get(currentMo) ?? '' : ''
                    return (
                      <tr
                        key={row.row_key}
                        className={`border-b border-slate-800/60 transition-colors border-l-2 ${borderColor} ${
                          isImported ? 'bg-emerald-950/20' : isMulti ? 'bg-violet-950/10' : hasMo ? 'bg-cyan-950/10' : 'hover:bg-slate-900/50'
                        }`}
                      >
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={selectedKeys.has(row.row_key)}
                            onChange={() => setSelectedKeys(prev => {
                              const next = new Set(prev)
                              next.has(row.row_key) ? next.delete(row.row_key) : next.add(row.row_key)
                              return next
                            })}
                            className="accent-cyan-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          <div>{idx + 1}</div>
                          {isMulti && (
                            <div className="text-[10px] text-violet-400 font-mono mt-0.5">L{lineNo}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap"><div className="font-mono text-slate-500 text-[11px]">{row.sheet_date}</div><div className="font-mono text-cyan-300">{row.order_number}</div></td>
                        <td className="px-3 py-2 text-slate-300">{row.customer}</td>
                        <td className="px-3 py-2">
                          <div className="text-purple-300 font-mono">{row.item_code}</div>
                          {row.item_name && <div className="text-slate-400 mt-0.5">{row.item_name}</div>}
                        </td>
                        <td className="px-3 py-2 text-slate-400 max-w-[160px] truncate" title={row.note}>{row.note}</td>
                        <td className="px-3 py-2 text-right text-white whitespace-nowrap">{row.quantity}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-300">{row.delivery_date}</td>
                        <td className="px-3 py-2 text-slate-400">{row.handler}</td>
                        <td className="px-3 py-2">
                          {currentMo ? (
                            <div>
                              <span className={`font-mono text-xs ${
                                isImported ? 'text-emerald-300' : 'text-teal-300'
                              }`}>{currentMo}</span>
                              {moQtyMismatch.has(row.row_key) && (
                                <div className="text-[10px] text-amber-400 mt-0.5">⚠ 數量與 ERP 不符</div>
                              )}
                            </div>
                          ) : null}
                          {isMulti && <div className="text-[10px] text-violet-400 mt-0.5">多製品 L{lineNo}/{moCountMap.get(currentMo)}</div>}
                        </td>
                        <td className="px-3 py-2">
                          {isImported ? (
                            <span className="px-2 py-0.5 rounded text-xs bg-emerald-900/50 text-emerald-300 border border-emerald-700/50 whitespace-nowrap">已匯入製令</span>
                          ) : isMulti ? (
                            <span className="px-2 py-0.5 rounded text-xs bg-violet-900/50 text-violet-300 border border-violet-700/50 whitespace-nowrap">多製品 待匯入</span>
                          ) : hasMo ? (
                            <span className="px-2 py-0.5 rounded text-xs bg-cyan-900/50 text-cyan-300 border border-cyan-700/50 whitespace-nowrap">待匯入</span>
                          ) : (
                            <span className="text-slate-600 text-xs">— —</span>
                          )}
                        </td>
                      </tr>
                    )
                  })
                })()}
              </tbody>
            </table>
          </div>
        )}

        {/* 說明 */}
        <div className="text-xs text-slate-600 space-y-1 pt-2">
          <p>・「儲存製令單號」：將自動比對結果存回出單表資料庫，不呼叫 ERP API（適合補登已在 ERP 建立的製令）。</p>
          <p>・「匯入 ERP 製令工單」：呼叫 IFAF028 介面將製令送入 ERP，成功後自動更新出單表狀態為「已匯入製令」。</p>
          <p>・「套用製令格式列印」：沿用製令列印版型；有勾選時只列印勾選列，未勾選時列印目前篩選結果。</p>
          <p>・若僅勾選部分列，操作只影響勾選的列；未勾選時則操作全部顯示中的列。</p>
        </div>
      </div>

      {/* ── 匯入後自動同步進度 Modal ── */}
      {postSyncModal?.show && (
        <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="p-2 rounded-full bg-teal-900/50 text-teal-400">
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

      {/* ── 匯入預覽 Modal ── */}
      {importPreview && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4" onClick={() => setImportPreview(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[88vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-700 flex items-start justify-between">
              <div>
                <h2 className="text-base font-bold text-white">
                  匯入預覽 — 集單多製品製令
                </h2>
                <p className="text-xs text-slate-400 mt-1 flex flex-wrap gap-2 items-center">
                  共 <span className="text-violet-300 font-semibold">{importPreview.length}</span> 張製令・
                  <span className="text-cyan-300 font-semibold">{importPreview.reduce((n, g) => n + g.rows.length, 0)}</span> 筆明細
                  <span className="px-2 py-0.5 rounded text-[11px] bg-violet-900/60 text-violet-300">IFAF028 多製品格式</span>
                </p>
              </div>
              <button onClick={() => setImportPreview(null)} className="text-slate-500 hover:text-white text-xl leading-none mt-0.5">✕</button>
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {importPreview.map((group, gi) => (
                <div key={group.mo} className="border border-violet-800/50 rounded-lg overflow-hidden">
                  {/* MO 表頭 */}
                  <div className="flex items-center gap-3 px-4 py-2.5 bg-violet-950/60 border-b border-violet-800/40">
                    <span className="text-xs text-slate-400 font-medium">製令單號</span>
                    <span className="font-mono text-violet-300 font-bold tracking-wide">{group.mo}</span>
                    <span className="ml-auto text-xs text-slate-500">{group.rows.length} 筆明細（LINE {group.rows.map(r => r.lineNo).join(' / ')}）</span>
                  </div>
                  {/* 明細表 */}
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-800/60 text-slate-400 text-[11px]">
                        <th className="px-3 py-2 text-center w-10">LINE</th>
                        <th className="px-3 py-2 text-left">品項編碼</th>
                        <th className="px-3 py-2 text-left min-w-[160px]">品名規格</th>
                        <th className="px-3 py-2 text-left">來源工單</th>
                        <th className="px-3 py-2 text-left">客戶</th>
                        <th className="px-3 py-2 text-right">數量</th>
                        <th className="px-3 py-2 text-left">交付日</th>
                        <th className="px-3 py-2 text-left">出單日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map(({ row, lineNo }) => (
                        <tr key={row.row_key} className="border-t border-slate-800/50 hover:bg-slate-800/30">
                          <td className="px-3 py-2 text-center font-mono text-violet-400 font-bold">{lineNo}</td>
                          <td className="px-3 py-2 font-mono text-purple-300">{row.item_code}</td>
                          <td className="px-3 py-2 text-slate-300 max-w-[200px]">
                            <div className="truncate">{row.item_name}</div>
                            {row.note && <div className="text-slate-500 truncate">{row.note}</div>}
                          </td>
                          <td className="px-3 py-2 font-mono text-cyan-300">{row.order_number}</td>
                          <td className="px-3 py-2 text-slate-400">{row.customer}</td>
                          <td className="px-3 py-2 text-right text-white whitespace-nowrap">{row.quantity}</td>
                          <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{row.delivery_date}</td>
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{row.sheet_date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-slate-700 flex items-center justify-end gap-3">
              <button
                onClick={() => setImportPreview(null)}
                className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => { setImportPreview(null); void handleImport() }}
                disabled={importing}
                className="px-5 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 disabled:bg-slate-700 disabled:text-slate-400 text-white text-sm font-semibold transition-colors flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                確認匯入 ERP
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

