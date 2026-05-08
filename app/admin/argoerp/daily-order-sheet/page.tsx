'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ===== 型別定義（與 order-batch-export 一致）=====
interface SourceRow {
  order_number: string
  doc_type: string
  factory: 'T' | 'C' | 'O'
  receiver: string
  is_sample: string
  has_material: string
  designer: string
  customer: string
  line_nickname: string
  handler: string
  issuer: string
  item_code: string
  item_name: string
  note: string
  quantity: string
  delivery_date: string
  plate_count: string
  upload_ro: string
  order_status: string
  pm_note: string
}

export type MatchStatus = 'matched' | 'no_order' | 'no_qty_match'

export interface SheetRow extends SourceRow {
  row_key: string
  mo_status: '已匯入製令' | '暫緩區' | null
  mo_number?: string
  // 序號比對結果（對應 erp_so_lines）
  match_status?: MatchStatus | null
  match_line_no?: string | null
  match_pdl_seq?: number | null
  match_reason?: string | null
  // 批備料狀態（對應 argoerp_material_prep_log 最近一筆）
  material_prep_status?: '已備料' | '無需備料' | null
  // 機台分配（對應 argoerp_mo_machine_assign）
  machine?: string
}

interface SheetMeta {
  sheet_date: string
  row_count: number
  updated_at: string
}

// ===== 工具函式 =====
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function detectFactory(docType: string): 'T' | 'C' | 'O' {
  if (docType.includes('常平')) return 'C'
  if (docType.includes('委外')) return 'O'
  return 'T'
}

function createRowKey(row: SourceRow): string {
  return [
    row.order_number,
    row.doc_type,
    row.factory,
    row.item_code,
    row.item_name,
    row.note,
    row.quantity,
    row.delivery_date,
  ].join('||')
}

function parseTSV(text: string): string[][] {
  const rows: string[][] = []
  let current = ''
  let cells: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = false
      } else { current += ch }
    } else {
      if (ch === '"' && current.trim() === '') { inQuotes = true; current = '' }
      else if (ch === '\t') { cells.push(current.trim()); current = '' }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        if (ch === '\r') i++
        cells.push(current.trim())
        if (cells.some(c => c !== '')) rows.push(cells)
        cells = []; current = ''
      } else if (ch === '\r') {
        cells.push(current.trim())
        if (cells.some(c => c !== '')) rows.push(cells)
        cells = []; current = ''
      } else { current += ch }
    }
  }
  cells.push(current.trim())
  if (cells.some(c => c !== '')) rows.push(cells)
  return rows
}

function parseSourceRows(text: string): { rows: SourceRow[]; error: string } {
  const allRows = parseTSV(text.trim())
  if (allRows.length === 0) return { rows: [], error: '未偵測到有效資料行' }

  const headerKeywords = ['工單編號', '品項編碼', '單據種類', '品名/規格', '交付日期', '訂單狀態', '生產廠別', '承辦人', '開單人員', '客戶', '美編', '序號', '備註']
  let startIdx = 0
  for (let h = 0; h < Math.min(allRows.length, 3); h++) {
    const rowCells = allRows[h]
    const lineText = rowCells.join('\t')
    const firstCell = rowCells[0]?.trim() ?? ''
    const looksLikeOrderNo = /^[A-Za-z]{1,4}\d/.test(firstCell)
    if (headerKeywords.some(kw => lineText.includes(kw)) || (!looksLikeOrderNo && h === startIdx)) {
      startIdx = h + 1
    } else break
  }

  const parsed: SourceRow[] = []
  for (let i = startIdx; i < allRows.length; i++) {
    const cells = allRows[i]
    const docType = (cells[2] ?? '').trim()
    const row: SourceRow = {
      order_number: (cells[0] ?? '').trim(),
      doc_type: docType,
      factory: detectFactory(docType),
      receiver: (cells[3] ?? '').trim(),
      is_sample: (cells[4] ?? '').trim(),
      has_material: (cells[5] ?? '').trim(),
      designer: (cells[6] ?? '').trim(),
      customer: (cells[7] ?? '').trim(),
      line_nickname: (cells[8] ?? '').trim(),
      handler: (cells[9] ?? '').trim(),
      issuer: (cells[10] ?? '').trim(),
      item_code: (cells[11] ?? '').trim(),
      item_name: (cells[12] ?? '').trim(),
      note: (cells[13] ?? '').trim(),
      quantity: (cells[14] ?? '').trim(),
      delivery_date: (cells[15] ?? '').trim(),
      plate_count: (cells[16] ?? '').trim(),
      upload_ro: (cells[17] ?? '').trim(),
      order_status: (cells[18] ?? '').trim(),
      pm_note: (cells[19] ?? '').trim(),
    }
    if (row.order_number || row.item_code) parsed.push(row)
  }

  if (parsed.length === 0) return { rows: [], error: '未解析到有效資料，請確認資料是從 Excel 以 Tab 分隔複製' }
  return { rows: parsed, error: '' }
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  '已匯入製令': { label: '已匯入製令', cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50' },
  '暫緩區': { label: '暫緩區', cls: 'bg-amber-900/50 text-amber-300 border-amber-700/50' },
}

// ===== 頁面元件 =====
export default function DailyOrderSheetPage() {
  const [selectedDate, setSelectedDate] = useState(todayStr())
  const [availableSheets, setAvailableSheets] = useState<SheetMeta[]>([])
  const [sheetRows, setSheetRows] = useState<SheetRow[]>([])
  const [rawText, setRawText] = useState('')
  const [currentRawText, setCurrentRawText] = useState('')   // stored raw_text for this date
  const [showPasteArea, setShowPasteArea] = useState(false)
  const [parseError, setParseError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [editFactoryIdx, setEditFactoryIdx] = useState<number | null>(null)
  const [matching, setMatching] = useState(false)
  const [syncingMo, setSyncingMo] = useState(false)
  const [machines, setMachines] = useState<string[]>([])
  const [moMachines, setMoMachines] = useState<Record<string, string>>({})
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  // ---- 讀取所有日期清單 ----
  const loadSheetList = useCallback(async () => {
    try {
      const res = await fetch('/api/argoerp/daily-order-sheet')
      const json = await res.json()
      if (json.success) setAvailableSheets(json.sheets ?? [])
    } catch {}
  }, [])

  // ---- 讀取指定日期的出單表 ----
  const loadSheet = useCallback(async (date: string) => {
    setLoading(true)
    setSheetRows([])
    setSelectedKeys(new Set())
    setCurrentRawText('')
    setShowPasteArea(false)
    setParseError('')
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`)
      const json = await res.json()
      if (json.success && json.sheet) {
        setSheetRows(Array.isArray(json.sheet.rows) ? json.sheet.rows as SheetRow[] : [])
        setCurrentRawText(json.sheet.raw_text ?? '')
      } else {
        setSheetRows([])
        setCurrentRawText('')
        setShowPasteArea(true)  // 此日尚無資料，直接展開貼上區
      }
    } catch (e) {
      setSaveMsg(`❌ 讀取失敗：${e}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadSheetList() }, [loadSheetList])
  useEffect(() => { loadSheet(selectedDate) }, [selectedDate, loadSheet])

  // 載入機台清單
  useEffect(() => {
    fetch('/api/argoerp/machines')
      .then(r => r.json())
      .then(j => { if (j.success) setMachines((j.machines as { name: string }[]).map(m => m.name)) })
      .catch(() => {})
  }, [])

  // 當出單表載入後，載入對應製令的機台分配
  useEffect(() => {
    const moNums = [...new Set(sheetRows.map(r => r.mo_number).filter((v): v is string => !!v && v.startsWith('MO')))]
    if (moNums.length === 0) return
    fetch('/api/argoerp/mo-machine-assign')
      .then(r => r.json())
      .then(j => {
        if (j.success) {
          const map: Record<string, string> = {}
          ;(j.assignments as { mo_number: string; machine: string }[]).forEach(a => {
            if (a.machine) map[a.mo_number] = a.machine
          })
          setMoMachines(map)
        }
      })
      .catch(() => {})
  }, [sheetRows])

  const setMoMachine = useCallback(async (moNumber: string, machine: string) => {
    setMoMachines(prev => ({ ...prev, [moNumber]: machine }))
    await fetch('/api/argoerp/mo-machine-assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: [{ mo_number: moNumber, machine }] }),
    }).catch(() => {})
  }, [])

  // ---- 解析貼上資料 ----
  const handleParse = useCallback(() => {
    setParseError('')
    if (!rawText.trim()) { setParseError('請先貼上資料'); return }
    const { rows, error } = parseSourceRows(rawText)
    if (error) { setParseError(error); return }

    const sheetRowsNew: SheetRow[] = rows.map(r => ({
      ...r,
      row_key: createRowKey(r),
      mo_status: null,
    }))

    // 保留已有狀態（相同 row_key 的保留舊狀態）
    const existingMap = new Map(sheetRows.map(r => [r.row_key, r]))
    const merged = sheetRowsNew.map(r => {
      const old = existingMap.get(r.row_key)
      return old ? { ...r, mo_status: old.mo_status, mo_number: old.mo_number } : r
    })
    setSheetRows(merged)
    setShowPasteArea(false)
    setParseError('')
  }, [rawText, sheetRows])

  // ---- 儲存至 Supabase ----
  const handleSave = useCallback(async () => {
    if (sheetRows.length === 0) { setSaveMsg('❌ 沒有可儲存的資料'); return }
    setSaving(true)
    setSaveMsg('')
    try {
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: rawText || currentRawText, rows: sheetRows }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSaveMsg(`✅ 已儲存 ${sheetRows.length} 筆至 ${selectedDate}`)
      setCurrentRawText(rawText || currentRawText)
      setRawText('')
      await loadSheetList()
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ 儲存失敗：${e}`)
      setTimeout(() => setSaveMsg(''), 5000)
    } finally {
      setSaving(false)
    }
  }, [sheetRows, selectedDate, rawText, currentRawText, loadSheetList])

  // ---- 列印（使用製令工單 A4 格式）----
  const handlePrint = () => {
    const printRows = sheetRows.filter((r, i) => selectedKeys.has(r.row_key || String(i)))
    if (printRows.length === 0) return

    const moRecords = printRows.map(r => ({
      mo_number: r.mo_number || r.order_number,
      planned_start_date: '',
      planned_end_date: r.delivery_date,
      mo_status: r.mo_status || '',
      department: '',
      product_code: r.item_code,
      lot_number: r.customer,
      planned_qty: String(r.quantity),
      source_order: r.order_number,
      mo_note: [r.item_name, r.plate_count ? `盤數：${r.plate_count}` : ''].filter(Boolean).join(' | '),
      create_date: selectedDate,
      factory: r.factory,
      prep_status: r.material_prep_status || '',
      machine: r.mo_number ? (moMachines[r.mo_number] || '') : '',
      line_no_override: r.match_line_no || undefined,
    }))

    sessionStorage.setItem('mo_print_selection', JSON.stringify(moRecords))
    window.open('/admin/argoerp/mo-summary/print', '_blank')
  }

  // ---- 刪除整張出單表 ----
  const handleDelete = useCallback(async () => {
    if (!confirm(`確定要刪除 ${selectedDate} 的出單表（${sheetRows.length} 筆）？此操作不可復原。`)) return
    setSaving(true)
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${selectedDate}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSheetRows([])
      setCurrentRawText('')
      setShowPasteArea(true)
      setSaveMsg(`✅ 已刪除 ${selectedDate} 出單表`)
      await loadSheetList()
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ 刪除失敗：${e}`)
    } finally {
      setSaving(false)
    }
  }, [selectedDate, sheetRows.length, loadSheetList])

  // ---- 刪除單列 ----
  const handleDeleteRow = useCallback((idx: number) => {
    setSheetRows(prev => prev.filter((_, i) => i !== idx))
  }, [])

  // ---- 序號比對：對 erp_so_lines 比對品項+數量 → 寫回 match_* 欄位後立即儲存 ----
  const runSerialMatch = useCallback(async () => {
    if (sheetRows.length === 0) return
    setMatching(true)
    setSaveMsg('')
    try {
      const orderNumbers = [...new Set(sheetRows.map(r => r.order_number).filter(Boolean))]
      const { data: soLines, error } = await supabase
        .from('erp_so_lines')
        .select('project_id, line_no, mbp_part, order_qty_oru, pdl_seq')
        .in('project_id', orderNumbers.length > 0 ? orderNumbers : ['__none__'])
      if (error) throw error
      const lines = soLines ?? []
      const soProjectIds = new Set(lines.map(l => l.project_id))
      const candidateMap = new Map<string, Array<{ line_no: string; pdl_seq: number | null }>>()
      for (const line of lines) {
        const qty = Number(line.order_qty_oru ?? 0)
        const key = `${line.project_id}|${line.mbp_part ?? ''}|${qty}`
        if (!candidateMap.has(key)) candidateMap.set(key, [])
        candidateMap.get(key)!.push({ line_no: String(line.line_no ?? ''), pdl_seq: line.pdl_seq != null ? Number(line.pdl_seq) : null })
      }
      for (const arr of candidateMap.values()) arr.sort((a, b) => (Number(a.line_no) || 0) - (Number(b.line_no) || 0))
      const usageCounter = new Map<string, number>()

      const next: SheetRow[] = sheetRows.map(src => {
        if (!src.order_number || !soProjectIds.has(src.order_number)) {
          return { ...src, match_status: 'no_order', match_line_no: null, match_pdl_seq: null, match_reason: '無對應來源單號' }
        }
        const qty = parseFloat(String(src.quantity).replace(/,/g, '')) || 0
        const key = `${src.order_number}|${src.item_code}|${qty}`
        const candidates = candidateMap.get(key) ?? []
        if (candidates.length === 0) {
          return { ...src, match_status: 'no_qty_match', match_line_no: null, match_pdl_seq: null, match_reason: '有來源單號但無對應數量' }
        }
        const used = usageCounter.get(key) ?? 0
        const candidate = candidates[Math.min(used, candidates.length - 1)]
        usageCounter.set(key, used + 1)
        return { ...src, match_status: 'matched', match_line_no: candidate.line_no, match_pdl_seq: candidate.pdl_seq, match_reason: '' }
      })
      setSheetRows(next)

      // 立即儲存
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: currentRawText, rows: next }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      const matched = next.filter(r => r.match_status === 'matched').length
      setSaveMsg(`✅ 序號比對完成並儲存：成功 ${matched} / ${next.length}`)
      setTimeout(() => setSaveMsg(''), 5000)
    } catch (e) {
      setSaveMsg(`❌ 比對失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally {
      setMatching(false)
    }
  }, [sheetRows, selectedDate, currentRawText])

  // ---- 同步製令狀態：
  //   1. argoerp_mo_upload_log（本系統建立的製令，source_order+product_code 比對）
  //   2. erp_mo_lines（ARGO 同步區的製令，source_order+mbp_part 比對 → 可抓到 ARGO 直接建立的製令）
  //   3. argoerp_material_prep_log（批備料狀態，mo_number 比對）
  const runMoSync = useCallback(async () => {
    if (sheetRows.length === 0) return
    setSyncingMo(true)
    setSaveMsg('')
    try {
      const orderNumbers = [...new Set(sheetRows.map(r => r.order_number).filter(Boolean))]
      const noNone = orderNumbers.length > 0 ? orderNumbers : ['__none__']

      // 1. 查本系統製令上傳紀錄
      const { data: moLogs, error: moErr } = await supabase
        .from('argoerp_mo_upload_log')
        .select('mo_number, source_order, product_code, planned_qty, uploaded_at')
        .in('source_order', noNone)
        .order('uploaded_at', { ascending: false })
      if (moErr) throw moErr
      const moMap = new Map<string, { mo_number: string }>()
      for (const log of (moLogs ?? [])) {
        if (!log.mo_number?.startsWith('MO')) continue  // 排除非製令單號的資料
        const qty = String(log.planned_qty ?? '').trim()
        const k1 = `${log.source_order}|${log.product_code}|${qty}`
        const k2 = `${log.source_order}|${log.product_code}`
        if (!moMap.has(k1)) moMap.set(k1, { mo_number: log.mo_number })
        if (!moMap.has(k2)) moMap.set(k2, { mo_number: log.mo_number })
      }

      // 2. 查 erp_mo_lines（ARGO 同步區），source_order = 工單編號，mbp_part = 品項編碼
      const { data: erp_mo, error: erpErr } = await supabase
        .from('erp_mo_lines')
        .select('project_id, source_order, mbp_part, order_qty, line_no')
        .in('source_order', noNone)
      if (erpErr) throw erpErr
      // erp_mo_lines.project_id 就是製令單號 (e.g. MOT260507004 02)
      // 製令單號末 2 碼即為對應序號（e.g. 01=序號1, 02=序號2）
      // key = source_order|mbp_part|末2碼  →  精準對應序號
      // 同時維護 baseMap（唯一製令時才允許無序號 fallback）
      const erpMoMap = new Map<string, string>()       // source_order|mbp_part|seq → mo_number
      const erpMoBaseMap = new Map<string, string[]>() // source_order|mbp_part → [mo_numbers]
      for (const mo of (erp_mo ?? [])) {
        if (!mo.source_order || !mo.mbp_part || !mo.project_id) continue
        if (!mo.project_id.startsWith('MO')) continue  // 排除非製令單號的資料
        const seq = mo.project_id.slice(-2)             // 末 2 碼 = 序號 (e.g. "01", "02")
        const seqKey = `${mo.source_order}|${mo.mbp_part}|${seq}`
        if (!erpMoMap.has(seqKey)) erpMoMap.set(seqKey, mo.project_id)
        const baseKey = `${mo.source_order}|${mo.mbp_part}`
        const arr = erpMoBaseMap.get(baseKey) ?? []
        if (!arr.includes(mo.project_id)) erpMoBaseMap.set(baseKey, [...arr, mo.project_id])
      }

      // 3. 對每列嘗試找出 mo_number（不覆蓋已有值；但若現有值非 MO 開頭則視為無效重新比對）
      const next: SheetRow[] = sheetRows.map(r => {
        if (r.mo_number?.startsWith('MO')) return r
        const qty = String(r.quantity).trim()
        // 優先查上傳 log
        const k1 = `${r.order_number}|${r.item_code}|${qty}`
        const logHit = moMap.get(k1) ?? moMap.get(`${r.order_number}|${r.item_code}`)
        if (logHit) return { ...r, mo_number: logHit.mo_number, mo_status: '已匯入製令' as const }
        // fallback: 查 erp_mo_lines，優先以序號（match_line_no 末2碼）精準比對
        const matchSeq = r.match_line_no
          ? String(parseInt(r.match_line_no, 10)).padStart(2, '0')
          : null
        const erpHitBySeq = matchSeq
          ? erpMoMap.get(`${r.order_number}|${r.item_code}|${matchSeq}`)
          : undefined
        if (erpHitBySeq) return { ...r, mo_number: erpHitBySeq, mo_status: '已匯入製令' as const }
        // 若該 SO+品項只有唯一一筆製令（不需序號也能確定），允許 fallback
        const baseHits = erpMoBaseMap.get(`${r.order_number}|${r.item_code}`) ?? []
        if (baseHits.length === 1) return { ...r, mo_number: baseHits[0], mo_status: '已匯入製令' as const }
        // 若原本有非 MO 開頭的無效值，清除它
        if (r.mo_number && !r.mo_number.startsWith('MO')) {
          return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
        }
        return r
      })

      // 3. 對所有有 mo_number 的列查批備料狀態
      const moNumbers = [...new Set(next.map(r => r.mo_number).filter((v): v is string => !!v))]
      if (moNumbers.length > 0) {
        const { data: prepLogs, error: prepErr } = await supabase
          .from('argoerp_material_prep_log')
          .select('mo_number, status, logged_at')
          .in('mo_number', moNumbers)
          .order('logged_at', { ascending: false })
        if (prepErr) throw prepErr
        const prepMap = new Map<string, '已備料' | '無需備料'>()
        for (const log of (prepLogs ?? [])) {
          if (!prepMap.has(log.mo_number)) prepMap.set(log.mo_number, log.status as '已備料' | '無需備料')
        }
        for (let i = 0; i < next.length; i++) {
          const moNo = next[i].mo_number
          if (moNo && prepMap.has(moNo)) next[i] = { ...next[i], material_prep_status: prepMap.get(moNo)! }
        }
      }

      setSheetRows(next)

      // 立即儲存
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: currentRawText, rows: next }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      const newMo = next.filter((r, i) => r.mo_number && !sheetRows[i]?.mo_number).length
      const prepCount = next.filter(r => r.material_prep_status).length
      setSaveMsg(`✅ 製令狀態同步完成：新增 ${newMo} 筆製令連結，批備料狀態 ${prepCount} 筆`)
      setTimeout(() => setSaveMsg(''), 5000)
    } catch (e) {
      setSaveMsg(`❌ 同步失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally {
      setSyncingMo(false)
    }
  }, [sheetRows, selectedDate, currentRawText])

  // ---- 切換廠別 ----
  const handleChangeFactory = useCallback((idx: number, factory: 'T' | 'C' | 'O') => {
    setSheetRows(prev => prev.map((r, i) => {
      if (i !== idx) return r
      return { ...r, factory, row_key: createRowKey({ ...r, factory }) }
    }))
    setEditFactoryIdx(null)
  }, [])

  const factoryBadge = (f: 'T' | 'C' | 'O') => {
    const m = { T: 'bg-blue-900/40 text-blue-300', C: 'bg-orange-900/40 text-orange-300', O: 'bg-purple-900/40 text-purple-300' }
    const l = { T: '台北', C: '常平', O: '委外' }
    return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${m[f]}`}>{l[f]}</span>
  }

  const hasUnsaved = sheetRows.length > 0 && (rawText.trim() ? true : false)
  const hasData = sheetRows.length > 0
  const allSelected = sheetRows.length > 0 && sheetRows.every((r, i) => selectedKeys.has(r.row_key || String(i)))
  const toggleAll = () => {
    if (allSelected) setSelectedKeys(new Set())
    else setSelectedKeys(new Set(sheetRows.map((r, i) => r.row_key || String(i))))
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto">

        {/* Header */}
        <div className="mb-6 border-b border-slate-800 pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">每日出單表</h1>
            <p className="text-slate-400 mt-1 text-sm">貼上每日工單清單 → 儲存 → 在「訂單批量轉製令匯出」頁面選取日期載入</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* 日期選擇 */}
            <div className="flex items-center gap-2">
              <label className="text-slate-400 text-sm whitespace-nowrap">出單日期</label>
              <input
                type="date"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-cyan-500"
              />
            </div>
            {hasData && (
              <>
                <button
                  onClick={runSerialMatch}
                  disabled={matching || syncingMo || saving}
                  className="px-4 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 disabled:bg-slate-700 text-white text-sm font-medium transition-colors"
                  title="比對 erp_so_lines（品項+數量）寫回序號 LINE_NO，立即儲存"
                >
                  {matching ? '比對中…' : '🔍 序號比對'}
                </button>
                <button
                  onClick={runMoSync}
                  disabled={matching || syncingMo || saving}
                  className="px-4 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 disabled:bg-slate-700 text-white text-sm font-medium transition-colors"
                  title="從製令上傳紀錄＋批備料紀錄回填本表，立即儲存"
                >
                  {syncingMo ? '同步中…' : '🔄 同步製令/批備料'}
                </button>
                <button
                  onClick={() => { setShowPasteArea(v => !v); setRawText('') }}
                  className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-medium transition-colors"
                >
                  {showPasteArea ? '收合貼上區' : '🔄 重新貼上取代'}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 text-white text-sm font-medium transition-colors"
                >
                  {saving ? '儲存中…' : `💾 更新儲存 (${sheetRows.length} 筆)`}
                </button>
                <button
                  onClick={handlePrint}
                  disabled={selectedKeys.size === 0}
                  className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-medium transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
                  列印{selectedKeys.size > 0 ? ` (${selectedKeys.size})` : ''}
                </button>
                <button
                  onClick={handleDelete}
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-red-900/60 border border-red-700/50 text-red-300 hover:bg-red-800 hover:text-white text-sm transition-colors"
                >
                  🗑 刪除此日出單表
                </button>
              </>
            )}
            {saveMsg && (
              <span className={`text-sm ${saveMsg.startsWith('❌') ? 'text-red-400' : 'text-emerald-400'}`}>{saveMsg}</span>
            )}
          </div>
        </div>

        <div>
          {/* 水平日期列 */}
          {availableSheets.length > 0 && (
            <div className="mb-4 flex gap-2 flex-wrap">
              {availableSheets.map(s => (
                <button
                  key={s.sheet_date}
                  onClick={() => setSelectedDate(s.sheet_date)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                    s.sheet_date === selectedDate
                      ? 'bg-cyan-700 text-white border-cyan-600'
                      : 'bg-slate-900 text-slate-300 border-slate-700 hover:bg-slate-800'
                  }`}
                >
                  {s.sheet_date} <span className="opacity-60">{s.row_count}筆</span>
                </button>
              ))}
            </div>
          )}

          {/* 主內容 */}
          <div className="min-w-0">
            {/* 貼上區 */}
            {(showPasteArea || (!hasData && !loading)) && (
              <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-4">
                <h2 className="text-lg font-semibold text-white mb-2">
                  📋 貼上 {selectedDate} 的工單資料
                </h2>
                <p className="text-xs text-slate-500 mb-3">
                  從 Excel / Google Sheet 複製工單表格後貼上（Tab 分隔）。儲存後可在「訂單批量轉製令匯出」頁面選取此日期載入。
                </p>
                <textarea
                  value={rawText}
                  onChange={e => setRawText(e.target.value)}
                  placeholder="從 Excel 複製工單表格後貼上此處..."
                  className="w-full h-44 bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 font-mono resize-y focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30 placeholder:text-slate-600"
                />
                {parseError && (
                  <p className="mt-2 text-red-400 text-sm">{parseError}</p>
                )}
                <div className="mt-3 flex gap-2 flex-wrap">
                  <button
                    onClick={handleParse}
                    disabled={!rawText.trim()}
                    className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium text-sm"
                  >
                    解析資料
                  </button>
                  <button
                    onClick={() => setRawText('')}
                    className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-white text-sm"
                  >
                    清除
                  </button>
                  {hasData && (
                    <button
                      onClick={() => setShowPasteArea(false)}
                      className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-white text-sm"
                    >
                      取消
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* 載入中 */}
            {loading && (
              <div className="flex items-center justify-center py-20 text-slate-500">
                <svg className="animate-spin w-6 h-6 mr-2" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                載入中…
              </div>
            )}

            {/* 解析後未儲存提示 */}
            {!loading && sheetRows.length > 0 && (
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-slate-300 text-sm font-medium">共 <span className="text-cyan-300 font-bold">{sheetRows.length}</span> 筆</span>
                  <span className="text-xs text-slate-500">
                    已匯入製令：<span className="text-emerald-400">{sheetRows.filter(r => r.mo_status === '已匯入製令').length}</span>
                    ／暫緩區：<span className="text-amber-400">{sheetRows.filter(r => r.mo_status === '暫緩區').length}</span>
                    ／尚未轉單：<span className="text-slate-400">{sheetRows.filter(r => !r.mo_status).length}</span>
                  </span>
                </div>
                {!showPasteArea && currentRawText && (
                  <button
                    onClick={() => { setRawText(currentRawText); setShowPasteArea(true) }}
                    className="text-xs text-slate-400 hover:text-slate-200 underline"
                  >
                    查看原始資料
                  </button>
                )}
              </div>
            )}

            {/* 資料表格 */}
            {!loading && sheetRows.length > 0 && (
              <>
                {/* 未儲存提示 */}
                {rawText && sheetRows.length > 0 && (
                  <div className="mb-3 px-4 py-2 rounded-lg bg-yellow-900/30 border border-yellow-700/50 text-yellow-300 text-sm flex items-center justify-between">
                    <span>⚠️ 資料已解析但尚未儲存，請點「更新儲存」</span>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs"
                    >
                      {saving ? '儲存中…' : '立即儲存'}
                    </button>
                  </div>
                )}
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-900 text-slate-400 uppercase text-[11px]">
                        <th className="px-2 py-2 border-b border-slate-800 w-8 text-center">
                          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-cyan-500 cursor-pointer" />
                        </th>
                        <th className="px-3 py-2 border-b border-slate-800 w-8">#</th>
                        <th className="px-3 py-2 border-b border-slate-800 text-cyan-400">工單 / 廠別</th>
                        <th className="px-3 py-2 border-b border-slate-800">序號</th>
                        <th className="px-3 py-2 border-b border-slate-800 text-purple-300 min-w-[280px]">品項編碼 / 品名規格</th>
                        <th className="px-3 py-2 border-b border-slate-800">數量</th>
                        <th className="px-3 py-2 border-b border-slate-800 text-yellow-400">盤數</th>
                        <th className="px-3 py-2 border-b border-slate-800">客戶</th>
                        <th className="px-3 py-2 border-b border-slate-800">交付日</th>
                        <th className="px-3 py-2 border-b border-slate-800">製令單號</th>
                        <th className="px-3 py-2 border-b border-slate-800">批備料</th>
                        <th className="px-3 py-2 border-b border-slate-800">機台</th>
                        <th className="px-3 py-2 border-b border-slate-800">狀態</th>
                        <th className="px-3 py-2 border-b border-slate-800">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sheetRows.map((row, idx) => {
                        const statusInfo = row.mo_status ? STATUS_LABELS[row.mo_status] : null
                        const sk = row.row_key || String(idx)
                        return (
                          <tr
                            key={row.row_key || idx}
                            className={`border-b border-slate-800/60 transition-colors ${
                              row.mo_status === '已匯入製令'
                                ? 'bg-emerald-950/20'
                                : row.mo_status === '暫緩區'
                                ? 'bg-amber-950/20'
                                : 'hover:bg-slate-900/50'
                            }`}
                          >
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={selectedKeys.has(sk)}
                                onChange={() => setSelectedKeys(prev => {
                                  const next = new Set(prev)
                                  next.has(sk) ? next.delete(sk) : next.add(sk)
                                  return next
                                })}
                                className="accent-cyan-500 cursor-pointer"
                              />
                            </td>
                            <td className="px-3 py-2 text-slate-600">{idx + 1}</td>
                            <td className="px-3 py-2">
                              <div className="font-mono text-cyan-300 whitespace-nowrap">{row.order_number}</div>
                              <div className="mt-0.5">
                                {editFactoryIdx === idx ? (
                                  <div className="flex gap-1">
                                    {(['T', 'C', 'O'] as const).map(f => (
                                      <button key={f} onClick={() => handleChangeFactory(idx, f)}
                                        className={`px-2 py-0.5 rounded text-xs border ${row.factory === f ? 'bg-cyan-700 text-white border-cyan-600' : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'}`}>
                                        {f === 'T' ? '台北' : f === 'C' ? '常平' : '委外'}
                                      </button>
                                    ))}
                                    <button onClick={() => setEditFactoryIdx(null)} className="px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-400 border border-slate-700">✕</button>
                                  </div>
                                ) : (
                                  <button onClick={() => setEditFactoryIdx(idx)}>
                                    {factoryBadge(row.factory)}
                                  </button>
                                )}
                              </div>
                              <div className="text-slate-500 text-[10px] mt-0.5">{row.doc_type}</div>
                            </td>
                            <td className="px-3 py-2">
                              {row.match_status === 'matched' && row.match_line_no ? (
                                <span className="px-2 py-0.5 rounded border text-xs font-mono bg-emerald-900/40 text-emerald-300 border-emerald-700/50">{row.match_line_no}</span>
                              ) : row.match_status === 'no_order' ? (
                                <span className="px-2 py-0.5 rounded border text-xs bg-red-900/30 text-red-300 border-red-800/50" title={row.match_reason ?? ''}>無單號</span>
                              ) : row.match_status === 'no_qty_match' ? (
                                <span className="px-2 py-0.5 rounded border text-xs bg-amber-900/30 text-amber-300 border-amber-700/50" title={row.match_reason ?? ''}>數量不符</span>
                              ) : (
                                <span className="text-slate-600 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="font-mono text-purple-300">{row.item_code}</div>
                              <div className="text-slate-200 text-[10px] mt-0.5 max-w-[320px] truncate" title={row.item_name}>{row.item_name}</div>
                            </td>
                            <td className="px-3 py-2 text-slate-300 text-right">{row.quantity}</td>
                            <td className="px-3 py-2 text-yellow-400 text-center font-mono font-semibold">{row.plate_count || '—'}</td>
                            <td className="px-3 py-2 text-slate-400 max-w-[120px] truncate" title={row.customer}>{row.customer}</td>
                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{row.delivery_date}</td>
                            <td className="px-3 py-2 font-mono text-xs">
                              {row.mo_number ? (
                                <span className="text-violet-300">{row.mo_number}</span>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {row.material_prep_status === '已備料' ? (
                                <span className="px-2 py-0.5 rounded border text-xs bg-emerald-900/40 text-emerald-300 border-emerald-700/50">已備料</span>
                              ) : row.material_prep_status === '無需備料' ? (
                                <span className="px-2 py-0.5 rounded border text-xs bg-slate-800 text-slate-400 border-slate-700">無需備料</span>
                              ) : (
                                <span className="text-slate-600 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-2 py-2">
                              {row.mo_number ? (
                                <select
                                  value={moMachines[row.mo_number] || ''}
                                  onChange={e => setMoMachine(row.mo_number!, e.target.value)}
                                  className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-cyan-500 min-w-[90px]"
                                >
                                  <option value="">— —</option>
                                  {machines.map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                              ) : (
                                <span className="text-slate-600 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {statusInfo ? (
                                <span className={`px-2 py-0.5 rounded border text-xs font-medium ${statusInfo.cls}`}>
                                  {statusInfo.label}
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded border border-slate-700 text-slate-500 text-xs">尚未轉單</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                onClick={() => handleDeleteRow(idx)}
                                className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-900/30 hover:text-red-300 transition-colors"
                                title="刪除此列"
                              >
                                🗑
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* 空白狀態 */}
            {!loading && !hasData && !showPasteArea && (
              <div className="text-center py-20 text-slate-600">
                <div className="text-4xl mb-3">📋</div>
                <p>{selectedDate} 尚無出單表資料</p>
                <button
                  onClick={() => setShowPasteArea(true)}
                  className="mt-4 px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm"
                >
                  + 新增出單表
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
