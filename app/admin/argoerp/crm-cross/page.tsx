'use client'

import { useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import * as XLSX from 'xlsx-js-style'

// ============================================================
// CRM × 訂單明細交叉比對
// 流程：
//   1. 貼上 CRM 待完成表格（含「工單號碼」欄）
//   2. 貼上 訂單明細總表（前 2 行為公司資訊，第 3 行為標題；工單欄為「訂貨單號」）
//   3. 自動：取出 CRM 工單主鍵 → 篩出訂單明細所有相符列 → 依品項編碼排序
// ============================================================

// 從含後綴的字串中擷取主工單號（RO + 6~12 位數字）
function extractMoKey(raw: string): string | null {
  if (!raw) return null
  const m = String(raw).toUpperCase().match(/RO\d{6,12}/)
  return m ? m[0] : null
}

// 解析貼上的表格文字
//   - skipLines：跳過前 N 行（用於訂單明細的公司資訊列）
//   - 跳過後再找第一個非空行當標題
function parseTable(text: string, skipLines = 0): { headers: string[]; rows: string[][] } {
  const allLines = text.split(/\r?\n/).map(l => l.replace(/\r$/, ''))
  const usable = allLines.slice(skipLines)
  const headerIdx = usable.findIndex(l => l.trim().length > 0)
  if (headerIdx < 0) return { headers: [], rows: [] }

  const headerLine = usable[headerIdx]
  const sep = headerLine.includes('\t') ? '\t' : ','
  const splitLine = (line: string) => line.split(sep).map(c => c.trim())

  const headers = splitLine(headerLine)
  const rows = usable
    .slice(headerIdx + 1)
    .filter(l => l.trim().length > 0)
    .map(splitLine)
  return { headers, rows }
}

function findColumnIndex(headers: string[], candidates: string[]): number {
  for (const cand of candidates) {
    const idx = headers.findIndex(h => h.replace(/\s/g, '').includes(cand))
    if (idx >= 0) return idx
  }
  return -1
}

interface MatchedRow {
  moKey: string
  itemCode: string
  rowData: string[]
}

// 結果表要顯示的欄位（label → 訂單明細表頭候選詞）
const DISPLAY_FIELDS: { label: string; candidates: string[] }[] = [
  { label: '訂貨單號', candidates: ['訂貨單號', '工單編號', '工單號碼', '工單'] },
  { label: '序號',     candidates: ['序號', '項次', '行號', 'LINE NO', 'LINE_NO', '編號'] },
  { label: '客戶名稱', candidates: ['客戶/供應商', '客戶名稱', '客戶', '供應商'] },
  { label: '品項編碼', candidates: ['品項編碼', '品項代碼', '料號', '貨號'] },
  { label: '品項名稱', candidates: ['品項名稱', '品名', '商品名稱'] },
  { label: '加工備註', candidates: ['商品(加工)備註', '加工備註', '商品備註', '備註'] },
  { label: '數量',     candidates: ['數量(包含單位)', '數量'] },
  { label: '日期',     candidates: ['交付日期', '印刷交期', '交期', '日期'] },
]

export default function CrmCrossPage() {
  const [crmText, setCrmText] = useState('')
  const [orderText, setOrderText] = useState('')
  const [orderSkipLines, setOrderSkipLines] = useState(2)
  // 排除「訂單備註內含供單編號」的列（預設開啟）
  const [excludeSupplyRef, setExcludeSupplyRef] = useState(true)
  // 排除無「品項編碼」的列（多行備註延續行預設開啟）
  const [requireItemCode, setRequireItemCode] = useState(true)

  const [crmCustomCol, setCrmCustomCol] = useState<number | null>(null)
  const [orderMoCustomCol, setOrderMoCustomCol] = useState<number | null>(null)
  const [orderItemCustomCol, setOrderItemCustomCol] = useState<number | null>(null)

  const crmParsed = useMemo(() => parseTable(crmText, 0), [crmText])
  const orderParsed = useMemo(() => parseTable(orderText, orderSkipLines), [orderText, orderSkipLines])

  const crmAutoMoCol = useMemo(
    () => findColumnIndex(crmParsed.headers, ['工單號碼', '工單編號', '訂貨單號', '工單']),
    [crmParsed.headers],
  )
  const orderAutoMoCol = useMemo(
    () => findColumnIndex(orderParsed.headers, ['訂貨單號', '工單編號', '工單號碼', '工單']),
    [orderParsed.headers],
  )
  const orderAutoItemCol = useMemo(
    () => findColumnIndex(orderParsed.headers, ['品項編碼', '品項代碼', '料號', '貨號']),
    [orderParsed.headers],
  )
  // 訂單備註欄（用於判斷供單編號）
  const orderRemarkCol = useMemo(
    () => findColumnIndex(orderParsed.headers, ['訂單備註', '備註說明']),
    [orderParsed.headers],
  )

  const crmMoCol = crmCustomCol ?? crmAutoMoCol
  const orderMoCol = orderMoCustomCol ?? orderAutoMoCol
  const orderItemCol = orderItemCustomCol ?? orderAutoItemCol

  // 計算結果欄位 → 訂單明細欄 index 的對應
  const displayFieldMap = useMemo(() => {
    return DISPLAY_FIELDS.map(f => ({
      ...f,
      colIdx: findColumnIndex(orderParsed.headers, f.candidates),
    }))
  }, [orderParsed.headers])

  const crmKeys = useMemo(() => {
    if (crmMoCol < 0) return new Set<string>()
    const set = new Set<string>()
    for (const row of crmParsed.rows) {
      const key = extractMoKey(row[crmMoCol] ?? '')
      if (key) set.add(key)
    }
    return set
  }, [crmParsed.rows, crmMoCol])

  // 排除統計
  const [matchedRows, excludedCount] = useMemo<[MatchedRow[], number]>(() => {
    if (orderMoCol < 0 || crmKeys.size === 0) return [[], 0]
    const result: MatchedRow[] = []
    let excluded = 0
    for (const row of orderParsed.rows) {
      const moRaw = (row[orderMoCol] ?? '').trim()
      // 嚴格校驗：有效訂貨單號應以 RO + 數字 開頭，後続可能接空格、V、其他記號
      // 但不接中文、【】、（）等 —— 這些是多行備註被拆行的延續內容
      const isStrictMo = /^RO\d{6,12}(?:\s|V|$|-)/i.test(moRaw)
      if (!isStrictMo) {
        excluded++
        continue
      }
      const key = extractMoKey(moRaw)
      if (!key || !crmKeys.has(key)) continue
      // 若啟用排除，且訂單備註內含「供單編號」字樣 → 跳過
      if (excludeSupplyRef && orderRemarkCol >= 0) {
        const remark = row[orderRemarkCol] ?? ''
        if (remark.includes('供單編號')) {
          excluded++
          continue
        }
      }
      const itemCode = orderItemCol >= 0 ? (row[orderItemCol] ?? '').trim() : ''
      // 若要求品項編碼且是空 → 跳過（多為多行備註延續行）
      if (requireItemCode && orderItemCol >= 0 && !itemCode) {
        excluded++
        continue
      }
      result.push({
        moKey: key,
        itemCode,
        rowData: row,
      })
    }
    result.sort((a, b) => {
      if (a.itemCode === b.itemCode) return a.moKey.localeCompare(b.moKey)
      return a.itemCode.localeCompare(b.itemCode)
    })
    return [result, excluded]
  }, [orderParsed.rows, orderMoCol, orderItemCol, orderRemarkCol, crmKeys, excludeSupplyRef, requireItemCode])

  const missingKeys = useMemo(() => {
    if (matchedRows.length === 0) return Array.from(crmKeys)
    const found = new Set(matchedRows.map(r => r.moKey))
    return Array.from(crmKeys).filter(k => !found.has(k))
  }, [crmKeys, matchedRows])

  const itemCodeStats = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of matchedRows) {
      const k = r.itemCode || '(無編碼)'
      map.set(k, (map.get(k) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [matchedRows])

  // 匯出（僅匯出顯示欄位）
  const handleExport = useCallback((format: 'csv' | 'xlsx') => {
    if (matchedRows.length === 0) return
    const headers = displayFieldMap.map(f => f.label)
    const dataRows = matchedRows.map(r => displayFieldMap.map(f => f.colIdx >= 0 ? (r.rowData[f.colIdx] ?? '') : ''))

    if (format === 'xlsx') {
      const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
      const colCount = headers.length

      // ── 欄寬：品項編碼 20、訂貨單號 16、品項名稱/加工備註 36、其餘 14 ──
      ws['!cols'] = headers.map(h => {
        if (h === '品項名稱' || h === '加工備註') return { wch: 36 }
        if (h === '品項編碼') return { wch: 20 }
        if (h === '訂貨單號') return { wch: 16 }
        return { wch: 14 }
      })

      // ── 標題列樣式：粗體 + 底色 ──
      const headerFill  = { fgColor: { rgb: '1E293B' } }   // slate-800
      const headerFont  = { bold: true, color: { rgb: 'F1F5F9' } }
      for (let c = 0; c < colCount; c++) {
        const addr = XLSX.utils.encode_cell({ r: 0, c })
        if (!ws[addr]) continue
        ws[addr].s = { fill: headerFill, font: headerFont, alignment: { horizontal: 'center' } }
      }

      // ── 資料列樣式：群組分隔線（品項編碼換組時加粗上框線）──
      const borderThin   = { style: 'thin',   color: { rgb: 'CBD5E1' } }  // slate-300
      const borderGroup  = { style: 'medium', color: { rgb: 'F59E0B' } }  // amber-500

      for (let r = 0; r < dataRows.length; r++) {
        const isNewGroup = r === 0 || matchedRows[r].itemCode !== matchedRows[r - 1].itemCode
        for (let c = 0; c < colCount; c++) {
          const addr = XLSX.utils.encode_cell({ r: r + 1, c })
          if (!ws[addr]) ws[addr] = { t: 's', v: '' }

          const isItemCodeCol = headers[c] === '品項編碼'
          ws[addr].s = {
            font: isItemCodeCol ? { bold: true, color: { rgb: 'F59E0B' } } : undefined,
            border: {
              top:    isNewGroup ? borderGroup : borderThin,
              bottom: borderThin,
              left:   borderThin,
              right:  borderThin,
            },
            alignment: { wrapText: true, vertical: 'top' },
          }
        }
      }

      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'CRM比對結果')
      const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      XLSX.writeFile(wb, `CRM_交叉比對_${ts}.xlsx`)
    } else {
      const csvLines = [headers.join(',')]
      dataRows.forEach(cells => {
        csvLines.push(cells.map(v => {
          const s = String(v ?? '')
          if (s.includes(',') || s.includes('\n') || s.includes('"')) return `"${s.replace(/"/g, '""')}"`
          return s
        }).join(','))
      })
      const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      a.download = `CRM_交叉比對_${ts}.csv`
      a.click()
      URL.revokeObjectURL(url)
    }
  }, [matchedRows, displayFieldMap])

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1800px] mx-auto">
        <div className="mb-6 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3 mb-3">
            <Link
              href="/"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-colors text-xs font-medium"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              回到首頁
            </Link>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">CRM × 訂單交叉比對</h1>
          <p className="text-slate-400 mt-1 text-sm">
            貼上 CRM 待完成表格與訂單明細總表（直接從 Excel 複製），系統會依工單號碼擷取符合品項並依品項編碼排序，方便同編碼批次製作。
          </p>
        </div>

        {/* 兩個貼上區塊 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-cyan-300">① CRM 待完成表格</h2>
              <span className="text-xs text-slate-500">
                {crmParsed.rows.length > 0 ? `${crmParsed.rows.length} 列、${crmKeys.size} 筆唯一工單` : '尚未貼上'}
              </span>
            </div>
            <textarea
              value={crmText}
              onChange={e => { setCrmText(e.target.value); setCrmCustomCol(null) }}
              placeholder="貼上 CRM 表格（含表頭，建議直接從 Excel 複製）..."
              className="w-full h-44 px-3 py-2 rounded bg-slate-950 border border-slate-700 text-xs text-slate-200 font-mono resize-y focus:outline-none focus:border-cyan-500/50"
            />
            {crmParsed.headers.length > 0 && (
              <div className="mt-2 flex items-center gap-2 text-xs flex-wrap">
                <span className="text-slate-400">工單號碼欄位：</span>
                <select
                  value={crmMoCol}
                  onChange={e => setCrmCustomCol(Number(e.target.value))}
                  className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200"
                >
                  <option value={-1}>(請選擇)</option>
                  {crmParsed.headers.map((h, i) => (
                    <option key={i} value={i}>{i + 1}. {h || '(空)'}</option>
                  ))}
                </select>
                {crmAutoMoCol >= 0 && crmCustomCol === null && (
                  <span className="text-emerald-400">✓ 自動偵測</span>
                )}
              </div>
            )}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-amber-300">② 訂單明細總表</h2>
              <span className="text-xs text-slate-500">
                {orderParsed.rows.length > 0 ? `${orderParsed.rows.length} 列` : '尚未貼上'}
              </span>
            </div>
            <textarea
              value={orderText}
              onChange={e => { setOrderText(e.target.value); setOrderMoCustomCol(null); setOrderItemCustomCol(null) }}
              placeholder="貼上訂單明細總表（前 2 行為公司資訊，第 3 行為標題）..."
              className="w-full h-44 px-3 py-2 rounded bg-slate-950 border border-slate-700 text-xs text-slate-200 font-mono resize-y focus:outline-none focus:border-amber-500/50"
            />
            <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-400 whitespace-nowrap">跳過前</span>
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={orderSkipLines}
                  onChange={e => setOrderSkipLines(Math.max(0, Number(e.target.value) || 0))}
                  className="w-14 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200"
                />
                <span className="text-slate-400">行</span>
              </div>
              {orderParsed.headers.length > 0 && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 whitespace-nowrap">訂貨單號：</span>
                    <select
                      value={orderMoCol}
                      onChange={e => setOrderMoCustomCol(Number(e.target.value))}
                      className="flex-1 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200"
                    >
                      <option value={-1}>(請選擇)</option>
                      {orderParsed.headers.map((h, i) => (
                        <option key={i} value={i}>{i + 1}. {h || '(空)'}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 whitespace-nowrap">品項編碼：</span>
                    <select
                      value={orderItemCol}
                      onChange={e => setOrderItemCustomCol(Number(e.target.value))}
                      className="flex-1 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200"
                    >
                      <option value={-1}>(請選擇)</option>
                      {orderParsed.headers.map((h, i) => (
                        <option key={i} value={i}>{i + 1}. {h || '(空)'}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={excludeSupplyRef}
                onChange={e => setExcludeSupplyRef(e.target.checked)}
                className="accent-amber-500"
              />
              <span className="text-slate-300">
                訂單備註含「<span className="text-amber-300 font-medium">供單編號</span>」的列不納入統整
                {orderRemarkCol < 0 && orderParsed.headers.length > 0 && (
                  <span className="ml-2 text-red-400">（找不到「訂單備註」欄）</span>
                )}
              </span>
            </label>
            <label className="mt-1 flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={requireItemCode}
                onChange={e => setRequireItemCode(e.target.checked)}
                className="accent-amber-500"
              />
              <span className="text-slate-300">
                嚴格模式：必須有「<span className="text-amber-300 font-medium">品項編碼</span>」且訂貨單號為標準格式（自動排除多行備註延續行）
              </span>
            </label>
          </div>
        </div>

        {/* 顯示欄位偵測狀態 */}
        {orderParsed.headers.length > 0 && (
          <div className="mb-4 p-3 rounded-lg bg-slate-900/50 border border-slate-800 text-xs">
            <div className="text-slate-400 mb-1.5">結果顯示欄位偵測：</div>
            <div className="flex flex-wrap gap-1.5">
              {displayFieldMap.map(f => (
                <span
                  key={f.label}
                  className={`px-2 py-0.5 rounded border ${
                    f.colIdx >= 0
                      ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-300'
                      : 'bg-red-900/30 border-red-700/50 text-red-300'
                  }`}
                  title={f.colIdx >= 0 ? `對應到欄 ${f.colIdx + 1}: ${orderParsed.headers[f.colIdx]}` : '找不到對應欄位'}
                >
                  {f.label} {f.colIdx >= 0 ? `→ ${orderParsed.headers[f.colIdx]}` : '✗'}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 統計列 */}
        {matchedRows.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            <span className="px-3 py-1.5 rounded bg-emerald-900/40 border border-emerald-700/50 text-emerald-300">
              ✓ 比對成功 <b className="text-white">{matchedRows.length}</b> 筆品項
            </span>
            <span className="px-3 py-1.5 rounded bg-cyan-900/40 border border-cyan-700/50 text-cyan-300">
              涵蓋 <b className="text-white">{new Set(matchedRows.map(r => r.moKey)).size}</b> 張工單
            </span>
            <span className="px-3 py-1.5 rounded bg-purple-900/40 border border-purple-700/50 text-purple-300">
              不同品項編碼 <b className="text-white">{itemCodeStats.length}</b> 種
            </span>
            {excludedCount > 0 && (
              <span className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-slate-300">
                已排除（含供單編號）<b className="text-white">{excludedCount}</b> 筆
              </span>
            )}
            {missingKeys.length > 0 && (
              <span className="px-3 py-1.5 rounded bg-red-900/40 border border-red-700/50 text-red-300" title={missingKeys.join(', ')}>
                ⚠ CRM 有 <b className="text-white">{missingKeys.length}</b> 張工單在訂單明細中查無
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => handleExport('csv')}
                className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-sm"
              >匯出 CSV</button>
              <button
                onClick={() => handleExport('xlsx')}
                className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm"
              >匯出 XLSX</button>
            </div>
          </div>
        )}

        {/* 缺漏工單 */}
        {missingKeys.length > 0 && matchedRows.length > 0 && (
          <details className="mb-4 bg-red-950/20 border border-red-900/50 rounded-lg p-3">
            <summary className="cursor-pointer text-sm text-red-300 hover:text-red-200">
              查看 {missingKeys.length} 張查無對應的工單號碼
            </summary>
            <div className="mt-2 flex flex-wrap gap-1 text-xs font-mono">
              {missingKeys.map(k => (
                <span key={k} className="px-2 py-0.5 rounded bg-red-900/40 text-red-300">{k}</span>
              ))}
            </div>
          </details>
        )}

        {/* 品項編碼分佈 */}
        {itemCodeStats.length > 0 && (
          <details className="mb-4 bg-slate-900/50 border border-slate-800 rounded-lg p-3" open>
            <summary className="cursor-pointer text-sm text-slate-300 hover:text-white font-medium">
              品項編碼分佈（共 {itemCodeStats.length} 種）
            </summary>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {itemCodeStats.map(([code, count]) => (
                <span key={code} className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300">
                  <span className="font-mono text-cyan-300">{code}</span>
                  <span className="ml-1.5 text-slate-500">×{count}</span>
                </span>
              ))}
            </div>
          </details>
        )}

        {/* 結果表格 */}
        {matchedRows.length > 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-xs">
                <thead className="sticky top-0">
                  <tr className="bg-slate-800 border-b border-slate-700">
                    <th className="px-2 py-2 text-center text-slate-500 font-mono w-10">#</th>
                    {displayFieldMap.map(f => (
                      <th
                        key={f.label}
                        className={`px-2 py-2 text-left font-medium whitespace-nowrap ${
                          f.label === '品項編碼' ? 'text-amber-300' : f.label === '訂貨單號' ? 'text-cyan-300' : 'text-slate-300'
                        }`}
                      >
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matchedRows.map((r, idx) => {
                    const prev = matchedRows[idx - 1]
                    const isNewGroup = !prev || prev.itemCode !== r.itemCode
                    return (
                      <tr
                        key={idx}
                        className={`border-b border-slate-800/50 hover:bg-slate-800/40 ${
                          isNewGroup ? 'border-t-2 border-t-amber-700/30' : ''
                        }`}
                      >
                        <td className="px-2 py-1.5 text-center text-slate-500 font-mono align-top">{idx + 1}</td>
                        {displayFieldMap.map(f => {
                          const value = f.colIdx >= 0 ? (r.rowData[f.colIdx] ?? '') : ''
                          return (
                            <td
                              key={f.label}
                              className={`px-2 py-1.5 align-top max-w-[320px] ${
                                f.label === '品項編碼' ? 'text-amber-300 font-mono font-bold whitespace-nowrap' :
                                f.label === '訂貨單號' ? 'text-cyan-300 font-mono whitespace-nowrap' :
                                f.label === '品項名稱' || f.label === '加工備註' ? 'text-slate-300 whitespace-pre-wrap break-words' :
                                'text-slate-300 whitespace-nowrap'
                              }`}
                              title={value}
                            >
                              {value}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-slate-900/50 border border-dashed border-slate-700 rounded-lg p-8 text-center text-slate-500">
            {crmParsed.rows.length === 0 || orderParsed.rows.length === 0
              ? '請貼上兩份表格以開始比對'
              : crmMoCol < 0 || orderMoCol < 0
                ? '請選擇兩份表格的工單欄位'
                : '無相符的品項'}
          </div>
        )}
      </div>
    </div>
  )
}
