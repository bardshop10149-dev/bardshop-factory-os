'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

interface ErpPjSyncRow {
  id: number
  doc_type: string
  doc_no: string
  sub_no: string
  item_code: string | null
  description: string | null
  qty: number
  unit: string | null
  status: string | null
  start_date: string | null
  end_date: string | null
  customer_vendor: string | null
  remark: string | null
  synced_at: string
}

interface ColDef {
  key: keyof ErpPjSyncRow
  label: string
  align?: 'left' | 'right'
  mono?: boolean
  className?: string
}

const PAGE_SIZE = 50

// 每種 doc_type 顯示的欄位
const COL_MAP: Record<string, ColDef[]> = {
  銷售訂單: [
    { key: 'doc_no', label: '訂單號', mono: true },
    { key: 'start_date', label: '建單日期' },
    { key: 'customer_vendor', label: '客戶代號' },
    { key: 'remark', label: '業務' },
    { key: 'synced_at', label: '同步時間' },
  ],
  製令單號: [
    { key: 'doc_no', label: '製令單號', mono: true },
    { key: 'description', label: '名稱' },
    { key: 'status', label: '狀態' },
    { key: 'start_date', label: '開始日' },
    { key: 'end_date', label: '結束日' },
    { key: 'customer_vendor', label: '負責人' },
    { key: 'synced_at', label: '同步時間' },
  ],
  採購單號: [
    { key: 'doc_no', label: '採購單號', mono: true },
    { key: 'description', label: '名稱' },
    { key: 'status', label: '狀態' },
    { key: 'start_date', label: '開始日' },
    { key: 'end_date', label: '結束日' },
    { key: 'customer_vendor', label: '供應商' },
    { key: 'synced_at', label: '同步時間' },
  ],
  委外製令: [
    { key: 'doc_no', label: '委外製令號', mono: true },
    { key: 'description', label: '名稱' },
    { key: 'status', label: '狀態' },
    { key: 'start_date', label: '開始日' },
    { key: 'end_date', label: '結束日' },
    { key: 'customer_vendor', label: '廠商' },
    { key: 'synced_at', label: '同步時間' },
  ],
  倉庫庫存: [
    { key: 'doc_no', label: '料號', mono: true },
    { key: 'description', label: '品名/規格' },
    { key: 'qty', label: '庫存數量', align: 'right', mono: true },
    { key: 'customer_vendor', label: '在途數量', align: 'right', mono: true },
    { key: 'synced_at', label: '同步時間' },
  ],
}

function formatSyncedAt(ts: string): string {
  try {
    return new Date(ts).toLocaleString('zh-TW', { hour12: false })
  } catch {
    return ts
  }
}

function renderCell(row: ErpPjSyncRow, col: ColDef): string {
  const val = row[col.key]
  if (val === null || val === undefined || val === '') return '-'
  if (col.key === 'synced_at') return formatSyncedAt(String(val))
  if (typeof val === 'number') return String(val)
  return String(val)
}

interface Props {
  docType: string
  title: string
}

export default function ErpDbTable({ docType, title }: Props) {
  const [rows, setRows] = useState<ErpPjSyncRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)

  const cols = COL_MAP[docType] ?? []

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data, error: err } = await supabase
        .from('erp_pj_sync')
        .select('*')
        .eq('doc_type', docType)
        .order('synced_at', { ascending: false })
      if (err) throw err
      setRows((data as ErpPjSyncRow[]) ?? [])
      if (data && data.length > 0) setSyncedAt((data[0] as ErpPjSyncRow).synced_at)
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [docType])

  useEffect(() => { void load() }, [load])

  const filtered = rows.filter(r => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      r.doc_no.toLowerCase().includes(q) ||
      (r.description ?? '').toLowerCase().includes(q) ||
      (r.item_code ?? '').toLowerCase().includes(q) ||
      (r.customer_vendor ?? '').toLowerCase().includes(q) ||
      (r.remark ?? '').toLowerCase().includes(q)
    )
  })

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto">
        {/* 頁頭 */}
        <div className="mb-6 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">{title}</h1>
            {syncedAt && (
              <p className="mt-1 text-xs text-slate-400">
                最後同步：{formatSyncedAt(syncedAt)}
              </p>
            )}
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <input
              type="text"
              placeholder="搜尋..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(0) }}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50 w-48"
            />
            <button
              onClick={() => void load()}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 disabled:opacity-50 transition-colors text-sm"
            >
              {loading ? '讀取中...' : '🔄 重新整理'}
            </button>
          </div>
        </div>

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        {/* 統計 */}
        <div className="mb-4 flex items-center gap-4 text-xs text-slate-400">
          <span>共 <span className="text-cyan-300 font-mono font-semibold">{filtered.length}</span> 筆</span>
          {search && <span>（篩選自 {rows.length} 筆）</span>}
        </div>

        {/* 表格 */}
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 bg-slate-900">
                {cols.map(col => (
                  <th
                    key={col.key}
                    className={`px-3 py-3 text-xs text-slate-300 whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={cols.length} className="px-3 py-8 text-center text-slate-500">讀取中...</td>
                </tr>
              )}
              {!loading && pageRows.length === 0 && (
                <tr>
                  <td colSpan={cols.length} className="px-3 py-8 text-center text-slate-500">
                    {rows.length === 0 ? '尚無資料，請先至 ERP 同步區執行同步' : '無符合條件的資料'}
                  </td>
                </tr>
              )}
              {!loading && pageRows.map((row, idx) => (
                <tr
                  key={row.id}
                  className={`border-b border-slate-800/50 ${idx % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/20'} hover:bg-slate-800/40`}
                >
                  {cols.map(col => (
                    <td
                      key={col.key}
                      className={`px-3 py-2 text-xs whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'} ${col.mono ? 'font-mono text-cyan-300' : 'text-slate-300'}`}
                    >
                      {renderCell(row, col)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 分頁 */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
            <span>第 {page + 1} / {totalPages} 頁</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 disabled:opacity-40 transition-colors"
              >
                ← 上一頁
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 disabled:opacity-40 transition-colors"
              >
                下一頁 →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
