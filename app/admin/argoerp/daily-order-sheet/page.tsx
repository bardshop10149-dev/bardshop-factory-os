'use client'

import { useState, useEffect, useCallback } from 'react'

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

export interface SheetRow extends SourceRow {
  row_key: string
  mo_status: '已匯入製令' | '暫緩區' | null
  mo_number?: string
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

        <div className="flex gap-4">
          {/* 左側：日期清單 */}
          <aside className="hidden lg:block w-48 shrink-0">
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">已儲存日期</h3>
              {availableSheets.length === 0 ? (
                <p className="text-slate-600 text-xs">（尚無資料）</p>
              ) : (
                <ul className="space-y-1">
                  {availableSheets.map(s => (
                    <li key={s.sheet_date}>
                      <button
                        onClick={() => setSelectedDate(s.sheet_date)}
                        className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                          s.sheet_date === selectedDate
                            ? 'bg-cyan-700 text-white'
                            : 'text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        <div className="font-medium">{s.sheet_date}</div>
                        <div className="text-slate-400">{s.row_count} 筆</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {/* 主內容 */}
          <div className="flex-1 min-w-0">
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
                        <th className="px-3 py-2 border-b border-slate-800 w-8">#</th>
                        <th className="px-3 py-2 border-b border-slate-800">工單編號</th>
                        <th className="px-3 py-2 border-b border-slate-800">廠別</th>
                        <th className="px-3 py-2 border-b border-slate-800">品項編碼</th>
                        <th className="px-3 py-2 border-b border-slate-800">品名/規格</th>
                        <th className="px-3 py-2 border-b border-slate-800">數量</th>
                        <th className="px-3 py-2 border-b border-slate-800">交付日期</th>
                        <th className="px-3 py-2 border-b border-slate-800">客戶</th>
                        <th className="px-3 py-2 border-b border-slate-800">狀態</th>
                        <th className="px-3 py-2 border-b border-slate-800">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sheetRows.map((row, idx) => {
                        const statusInfo = row.mo_status ? STATUS_LABELS[row.mo_status] : null
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
                            <td className="px-3 py-2 text-slate-600">{idx + 1}</td>
                            <td className="px-3 py-2 font-mono text-cyan-300 whitespace-nowrap">{row.order_number}</td>
                            <td className="px-3 py-2">
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
                            </td>
                            <td className="px-3 py-2 text-slate-300 font-mono">{row.item_code}</td>
                            <td className="px-3 py-2 text-slate-200 max-w-[200px] truncate" title={row.item_name}>{row.item_name}</td>
                            <td className="px-3 py-2 text-slate-300 text-right">{row.quantity}</td>
                            <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{row.delivery_date}</td>
                            <td className="px-3 py-2 text-slate-400 max-w-[120px] truncate" title={row.customer}>{row.customer}</td>
                            <td className="px-3 py-2">
                              {statusInfo ? (
                                <span className={`px-2 py-0.5 rounded border text-xs font-medium ${statusInfo.cls}`}>
                                  {statusInfo.label}
                                  {row.mo_number && <span className="ml-1 opacity-70">{row.mo_number}</span>}
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
