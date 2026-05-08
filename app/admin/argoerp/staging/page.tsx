'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import SoOrderModal from '../../../../components/SoOrderModal'

// ==================== 型別 ====================
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

interface StagingRow extends SourceRow {
  id: number
  hold_reason: string
  staged_at: string // ISO datetime
}

const EXPORT_KEY = 'argoerp_order_batch_export_v2'

function formatStagedAt(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return iso }
}

// ==================== 元件 ====================
export default function StagingPage() {
  const [rows, setRows] = useState<StagingRow[]>([])
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')
  const [soModalId, setSoModalId] = useState<string | null>(null)
  const reasonTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  // 從 Supabase 載入
  const reload = useCallback(async () => {
    setLoading(true)
    setErrorMsg('')
    try {
      const res = await fetch('/api/argoerp/staging', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setRows(json.rows ?? [])
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const toggleSelectAll = useCallback(() => {
    if (selectedRows.size === rows.length) setSelectedRows(new Set())
    else setSelectedRows(new Set(rows.map((_, i) => i)))
  }, [selectedRows, rows])

  const toggleRow = useCallback((idx: number) => {
    setSelectedRows(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }, [])

  const handleUpdateReason = useCallback((idx: number, value: string) => {
    setRows(prev => {
      const updated = prev.map((r, i) => i === idx ? { ...r, hold_reason: value } : r)
      const row = updated[idx]
      if (row) {
        clearTimeout(reasonTimers.current[row.id])
        reasonTimers.current[row.id] = setTimeout(() => {
          fetch('/api/argoerp/staging', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: row.id, hold_reason: value }),
          }).catch(() => {})
        }, 800)
      }
      return updated
    })
  }, [])

  const handleDeleteSelected = useCallback(async () => {
    if (selectedRows.size === 0) return
    if (!confirm(`確定要刪除選取的 ${selectedRows.size} 筆暫緩訂單？此動作無法復原。`)) return
    const ids = [...selectedRows].map(i => rows[i]?.id).filter(Boolean) as number[]
    const res = await fetch('/api/argoerp/staging', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (res.ok) {
      setRows(prev => prev.filter((_, i) => !selectedRows.has(i)))
      setSelectedRows(new Set())
    } else {
      const j = await res.json()
      alert(`刪除失敗：${j.error}`)
    }
  }, [selectedRows, rows])

  const handleClearAll = useCallback(async () => {
    if (rows.length === 0) return
    if (!confirm(`確定要清空全部 ${rows.length} 筆暫緩訂單？此動作無法復原。`)) return
    const ids = rows.map(r => r.id)
    const res = await fetch('/api/argoerp/staging', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (res.ok) {
      setRows([])
      setSelectedRows(new Set())
    } else {
      const j = await res.json()
      alert(`清空失敗：${j.error}`)
    }
  }, [rows])

  // 退回到匯出區（刪除 Supabase 紀錄 + 寫回 order-batch-export localStorage）
  const handleReturnToExport = useCallback(async () => {
    if (selectedRows.size === 0) return
    const returning = rows.filter((_, i) => selectedRows.has(i))
    try {
      const raw = localStorage.getItem(EXPORT_KEY)
      const existing: SourceRow[] = raw ? JSON.parse(raw) : []
      // 從 StagingRow 取出原 SourceRow 欄位（去除 id / hold_reason / staged_at）
      const sourceOnly: SourceRow[] = returning.map(({ id, hold_reason, staged_at, ...rest }) => rest)
      const merged = [...existing, ...sourceOnly]
      localStorage.setItem(EXPORT_KEY, JSON.stringify(merged))
    } catch {
      alert('退回失敗：無法寫入匯出區')
      return
    }
    const ids = returning.map(r => r.id)
    const res = await fetch('/api/argoerp/staging', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (res.ok) {
      setRows(prev => prev.filter((_, i) => !selectedRows.has(i)))
      setSelectedRows(new Set())
    }
  }, [selectedRows, rows])

  // 顯示欄位
  const DISPLAY_COLS: { key: keyof SourceRow; label: string }[] = [
    { key: 'order_number', label: '工單編號' },
    { key: 'doc_type', label: '單據種類' },
    { key: 'item_code', label: '品項編碼' },
    { key: 'item_name', label: '品名/規格' },
    { key: 'quantity', label: '數量' },
    { key: 'delivery_date', label: '交付日期' },
    { key: 'customer', label: '客戶/供應商名' },
    { key: 'designer', label: '美編' },
    { key: 'handler', label: '承辦人' },
  ]

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1800px] mx-auto">
        {/* Header */}
        <div className="mb-6 border-b border-slate-800 pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
              <span className="text-amber-400">⏸</span> 訂單暫緩區
            </h1>
            <p className="text-slate-400 mt-1 text-sm">
              從「訂單批量轉製令匯出」移過來的訂單，可填寫暫緩原因等候下一步指令
            </p>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <button
              onClick={reload}
              disabled={loading}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-50 transition-colors text-sm"
            >
              {loading ? '讀取中…' : '🔄 重新整理'}
            </button>
            {rows.length > 0 && (
              <>
                {selectedRows.size > 0 && (
                  <>
                    <button
                      onClick={handleReturnToExport}
                      className="px-4 py-2 rounded-lg bg-cyan-900/60 border border-cyan-700/50 text-cyan-300 hover:bg-cyan-800 hover:text-white transition-colors text-sm"
                    >
                      退回匯出區 ({selectedRows.size})
                    </button>
                    <button
                      onClick={handleDeleteSelected}
                      className="px-4 py-2 rounded-lg bg-red-900/60 border border-red-700/50 text-red-300 hover:bg-red-800 hover:text-white transition-colors text-sm"
                    >
                      刪除選取 ({selectedRows.size})
                    </button>
                  </>
                )}
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

        {errorMsg && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-950/40 border border-red-700/50 text-red-300 text-sm">
            ⚠ {errorMsg}
          </div>
        )}

        {/* 統計 */}
        {rows.length > 0 && (
          <div className="mb-4 flex items-center gap-4 text-sm">
            <span className="text-slate-400">
              共 <span className="text-amber-400 font-bold">{rows.length}</span> 筆暫緩訂單
            </span>
            {selectedRows.size > 0 && (
              <>
                <span className="text-slate-600">|</span>
                <span className="text-orange-400">已選取 {selectedRows.size} 筆</span>
              </>
            )}
          </div>
        )}

        {/* 表格 */}
        {loading ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-12 text-center">
            <p className="text-slate-500">讀取中…</p>
          </div>
        ) : rows.length > 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/80 border-b border-slate-700">
                    <th className="px-2 py-3 text-center sticky left-0 bg-slate-800/80 z-10 w-10">
                      <input
                        type="checkbox"
                        checked={selectedRows.size === rows.length && rows.length > 0}
                        onChange={toggleSelectAll}
                        className="rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500/30"
                      />
                    </th>
                    <th className="px-2 py-3 text-center text-slate-500 font-mono text-xs w-10">#</th>
                    <th className="px-3 py-3 text-center text-slate-300 font-medium whitespace-nowrap text-xs">廠別</th>
                    {DISPLAY_COLS.map(col => (
                      <th key={col.key} className="px-3 py-3 text-left text-slate-300 font-medium whitespace-nowrap text-xs">
                        {col.label}
                      </th>
                    ))}
                    <th className="px-3 py-3 text-left text-amber-300 font-semibold whitespace-nowrap text-xs min-w-[240px]">
                      暫緩原因 ✎
                    </th>
                    <th className="px-3 py-3 text-left text-slate-400 font-medium whitespace-nowrap text-xs">暫緩時間</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    <tr
                      key={row.id}
                      className={`border-b border-slate-800/50 transition-colors ${
                        selectedRows.has(idx)
                          ? 'bg-amber-950/30'
                          : idx % 2 === 0 ? 'bg-slate-900/50' : 'bg-slate-900/20'
                      } hover:bg-slate-800/50`}
                    >
                      <td className="px-2 py-2 text-center sticky left-0 bg-inherit z-10">
                        <input
                          type="checkbox"
                          checked={selectedRows.has(idx)}
                          onChange={() => toggleRow(idx)}
                          className="rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500/30"
                        />
                      </td>
                      <td className="px-2 py-2 text-center text-slate-500 font-mono text-xs">{idx + 1}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                          row.factory === 'C'
                            ? 'bg-orange-900/60 text-orange-300 border border-orange-700/50'
                            : row.factory === 'O'
                            ? 'bg-purple-900/60 text-purple-300 border border-purple-700/50'
                            : 'bg-blue-900/60 text-blue-300 border border-blue-700/50'
                        }`}>
                          {row.factory === 'C' ? 'C 常平' : row.factory === 'O' ? 'O 委外' : 'T 台北'}
                        </span>
                      </td>
                      {DISPLAY_COLS.map(col => (
                        <td
                          key={col.key}
                          className="px-3 py-2 text-slate-300 whitespace-nowrap max-w-[250px] truncate text-xs"
                          title={row[col.key] || ''}
                        >
                          {col.key === 'order_number' && row[col.key]
                            ? (
                              <button
                                onClick={() => setSoModalId(row.order_number)}
                                className="font-mono text-cyan-300 hover:text-cyan-100 hover:underline underline-offset-2 text-left"
                              >
                                {row[col.key]}
                              </button>
                            )
                            : row[col.key] || <span className="text-slate-700">—</span>
                          }
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={row.hold_reason}
                          onChange={e => handleUpdateReason(idx, e.target.value)}
                          placeholder="輸入暫緩原因..."
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-amber-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30"
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-500 whitespace-nowrap text-xs font-mono">
                        {formatStagedAt(row.staged_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-12 text-center">
            <p className="text-slate-500">
              目前沒有暫緩訂單。請至「訂單批量轉製令匯出」勾選訂單後點擊「移至暫緩區」。
            </p>
          </div>
        )}
      </div>
      <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />
    </div>
  )
}
