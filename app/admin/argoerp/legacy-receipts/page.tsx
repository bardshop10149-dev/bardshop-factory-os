'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'

interface ParsedRow {
  entry_no: string
  entry_date: string | null
  entry_seq: number | null
  order_number: string
  source_location: string
  receiving_location: string
  handler_name: string
  item_name: string
  good_qty: number
  labor_time: number
  pretax_total: number
  unit_price: number
  total_cost: number
  production_amount: number
  remark: string
}

// "2024/01/01 -1" → { entry_date: "2024-01-01", entry_seq: 1 }
function parseEntryNo(raw: string): { entry_date: string | null; entry_seq: number | null } {
  const match = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})\s*-\s*(\d+)$/)
  if (!match) return { entry_date: null, entry_seq: null }
  return {
    entry_date: `${match[1]}-${match[2]}-${match[3]}`,
    entry_seq: parseInt(match[4]),
  }
}

// 每行 20 個 tab 欄位：6 個字串欄位各占 2 個位置（"value\t" + "\t"）、
// 6 個數值欄位各 1 個位置、1 個備註欄位占 2 個位置
function parseTsvLine(line: string): ParsedRow | null {
  const parts = line.split('\t')
  if (parts.length < 18) return null

  const c = (s: string) => s.replace(/^"/, '').trim()
  const toNum = (s: string) => { const v = parseFloat(s.trim()); return isNaN(v) ? 0 : v }
  const toInt = (s: string) => { const v = parseInt(s.trim()); return isNaN(v) ? 0 : v }

  const entryNo = c(parts[0])
  // 排除標題列（不以 YYYY/ 開頭）
  if (!entryNo.match(/^\d{4}\//)) return null

  const { entry_date, entry_seq } = parseEntryNo(entryNo)

  return {
    entry_no:           entryNo,
    entry_date,
    entry_seq,
    order_number:       c(parts[2]),
    source_location:    c(parts[4]),
    receiving_location: c(parts[6]),
    handler_name:       c(parts[8]),
    item_name:          c(parts[10]),
    good_qty:           toInt(parts[12]),
    labor_time:         toInt(parts[13]),
    pretax_total:       toNum(parts[14]),
    unit_price:         toNum(parts[15]),
    total_cost:         toNum(parts[16]),
    production_amount:  toNum(parts[17]),
    remark:             parts.length > 18 ? c(parts[18]) : '',
  }
}

const TABLE = 'legacy_inventory_receipts'
const BATCH_SIZE = 500

export default function LegacyReceiptsPage() {
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [fileName, setFileName] = useState('')
  const [parseError, setParseError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState(0)
  const [importedCount, setImportedCount] = useState(0)
  const [importDone, setImportDone] = useState(false)
  const [importError, setImportError] = useState('')
  const [existingCount, setExistingCount] = useState<number | null>(null)
  const [existingDateRange, setExistingDateRange] = useState<{ min: string; max: string } | null>(null)
  const [clearing, setClearing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadExistingStats = useCallback(async () => {
    const { count } = await supabase
      .from(TABLE)
      .select('*', { count: 'exact', head: true })
    setExistingCount(count ?? 0)

    if ((count ?? 0) > 0) {
      const { data } = await supabase
        .from(TABLE)
        .select('entry_date')
        .order('entry_date', { ascending: true })
        .limit(1)
      const { data: last } = await supabase
        .from(TABLE)
        .select('entry_date')
        .order('entry_date', { ascending: false })
        .limit(1)
      if (data?.[0]?.entry_date && last?.[0]?.entry_date) {
        setExistingDateRange({ min: data[0].entry_date, max: last[0].entry_date })
      }
    } else {
      setExistingDateRange(null)
    }
  }, [])

  useEffect(() => { void loadExistingStats() }, [loadExistingStats])

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setFileName(file.name)
    setParseError('')
    setRows([])
    setImportDone(false)
    setImportError('')
    setImportedCount(0)

    try {
      const buffer = await file.arrayBuffer()
      const text = new TextDecoder('big5').decode(buffer)
      const lines = text.split(/\r?\n/).filter(l => l.trim())

      const parsed: ParsedRow[] = []
      for (const line of lines) {
        const row = parseTsvLine(line)
        if (row) parsed.push(row)
      }

      if (parsed.length === 0) {
        setParseError('解析後無有效資料，請確認檔案格式（需為 Big5 編碼的 TSV）')
        return
      }

      setRows(parsed)
    } catch (err) {
      setParseError(`讀取失敗：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const handleImport = useCallback(async () => {
    if (rows.length === 0) return
    setImporting(true)
    setImportProgress(0)
    setImportDone(false)
    setImportError('')
    setImportedCount(0)

    try {
      let inserted = 0
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE)
        const { error } = await supabase.from(TABLE).insert(chunk)
        if (error) throw error
        inserted += chunk.length
        setImportedCount(inserted)
        setImportProgress(Math.min(100, Math.round((inserted / rows.length) * 100)))
      }
      setImportDone(true)
      await loadExistingStats()
    } catch (err) {
      setImportError(`匯入失敗：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
    }
  }, [rows, loadExistingStats])

  const handleClear = useCallback(async () => {
    if (!confirm('確定要刪除資料庫中所有入庫紀錄嗎？此操作無法復原。')) return
    setClearing(true)
    try {
      const { error } = await supabase.from(TABLE).delete().neq('id', 0)
      if (error) throw error
      await loadExistingStats()
    } catch (err) {
      alert(`清除失敗：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setClearing(false)
    }
  }, [loadExistingStats])

  const firstDate = rows[0]?.entry_date
  const lastDate = rows[rows.length - 1]?.entry_date

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">舊系統入庫紀錄 匯入</h1>
        <p className="text-slate-400 text-sm mt-1">
          將舊系統匯出的 Big5 TSV 入庫紀錄匯入至 Supabase，供後續與 ARGO ERP 資料比對使用
        </p>
      </div>

      {/* DB 現有狀態 */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <span className="text-slate-500 text-xs">資料庫現有紀錄</span>
            <div className="text-cyan-300 font-mono font-semibold text-lg">
              {existingCount === null ? '讀取中…' : `${existingCount.toLocaleString()} 筆`}
            </div>
          </div>
          {existingDateRange && (
            <div>
              <span className="text-slate-500 text-xs">日期範圍</span>
              <div className="text-slate-300 text-sm">
                {existingDateRange.min} ～ {existingDateRange.max}
              </div>
            </div>
          )}
          {(existingCount ?? 0) > 0 && (
            <div className="ml-auto flex items-center gap-3">
              <span className="text-amber-400 text-xs">⚠ 重複匯入會產生重複列</span>
              <button
                onClick={handleClear}
                disabled={clearing}
                className="px-3 py-1.5 rounded bg-red-900/60 hover:bg-red-800/80 border border-red-700/50 text-red-300 text-xs transition-colors disabled:opacity-50"
              >
                {clearing ? '清除中…' : '清除全部資料'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 檔案上傳 */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 space-y-4">
        <h2 className="text-sm font-semibold text-white">選擇檔案</h2>
        <label className="flex flex-col items-center gap-3 p-8 border-2 border-dashed border-slate-700 rounded-lg cursor-pointer hover:border-cyan-600 transition-colors">
          <svg className="w-8 h-8 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <div className="text-center">
            <p className="text-slate-300 text-sm">{fileName || '點此選擇 Big5 TSV/CSV 檔案'}</p>
            <p className="text-slate-600 text-xs mt-1">支援舊系統匯出的入庫紀錄格式（Big5 編碼）</p>
          </div>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" onChange={handleFileChange} className="hidden" />
        </label>

        {parseError && <p className="text-red-300 text-sm">{parseError}</p>}

        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5 text-emerald-300">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              解析成功
            </span>
            <span className="text-slate-300 font-mono">{rows.length.toLocaleString()} 筆</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400 text-xs">{firstDate} ～ {lastDate}</span>
          </div>
        )}
      </div>

      {/* 資料預覽 */}
      {rows.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">資料預覽（前 10 筆）</h2>
            <span className="text-slate-500 text-xs">共 {rows.length.toLocaleString()} 筆</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-800/60 border-b border-slate-700">
                  <th className="px-3 py-2 text-left text-slate-300 whitespace-nowrap">日期-號碼</th>
                  <th className="px-3 py-2 text-left text-slate-300 whitespace-nowrap">訂貨單號</th>
                  <th className="px-3 py-2 text-left text-slate-300 whitespace-nowrap">出庫工廠</th>
                  <th className="px-3 py-2 text-left text-slate-300 whitespace-nowrap">收貨倉</th>
                  <th className="px-3 py-2 text-left text-slate-300 whitespace-nowrap">承辦人</th>
                  <th className="px-3 py-2 text-left text-slate-300 whitespace-nowrap">品項名[規格]</th>
                  <th className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">良品數</th>
                  <th className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">勞務時間</th>
                  <th className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">稅前總價</th>
                  <th className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">生產金額</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 10).map((row, i) => (
                  <tr key={i} className={`border-b border-slate-800/40 ${i % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/10'}`}>
                    <td className="px-3 py-1.5 font-mono text-cyan-300 whitespace-nowrap">{row.entry_no}</td>
                    <td className="px-3 py-1.5 font-mono text-amber-300/80 whitespace-nowrap">{row.order_number}</td>
                    <td className="px-3 py-1.5 text-slate-300 whitespace-nowrap">{row.source_location}</td>
                    <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{row.receiving_location}</td>
                    <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{row.handler_name}</td>
                    <td className="px-3 py-1.5 text-slate-300 max-w-[260px] truncate" title={row.item_name}>{row.item_name}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-300 whitespace-nowrap">{row.good_qty.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-400 whitespace-nowrap">{row.labor_time.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-400 whitespace-nowrap">{row.pretax_total.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-400 whitespace-nowrap">{row.production_amount.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 匯入操作 */}
      {rows.length > 0 && !importDone && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-4">
            <button
              onClick={handleImport}
              disabled={importing}
              className="px-5 py-2.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
            >
              {importing
                ? `匯入中… ${importedCount.toLocaleString()} / ${rows.length.toLocaleString()} 筆`
                : `匯入 ${rows.length.toLocaleString()} 筆資料至 Supabase`}
            </button>
            {importing && (
              <span className="text-slate-400 text-sm font-mono">{importProgress}%</span>
            )}
          </div>
          {importing && (
            <div className="w-full bg-slate-700 rounded-full h-1.5">
              <div
                className="bg-cyan-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${importProgress}%` }}
              />
            </div>
          )}
          {importError && <p className="text-red-300 text-sm">{importError}</p>}
        </div>
      )}

      {/* 完成 */}
      {importDone && (
        <div className="bg-emerald-950/30 border border-emerald-800/40 rounded-lg p-4 space-y-1">
          <p className="text-emerald-300 font-medium">
            ✅ 匯入完成，共寫入 {rows.length.toLocaleString()} 筆入庫紀錄
          </p>
          <p className="text-slate-400 text-sm">
            已保存至 <code className="font-mono text-slate-300">{TABLE}</code> 資料表
          </p>
        </div>
      )}
    </div>
  )
}
