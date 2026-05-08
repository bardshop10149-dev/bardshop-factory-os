'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ─── 型別 ─────────────────────────────────────────────
interface SoLine {
  id: number
  project_id: string
  begin_date: string | null
  sales_name: string | null
  tpn_partner_id: string | null
  line_no: string
  description: string | null
  part: string | null
  duedate: string | null
  order_qty: number
  unit_of_measure: string | null
  remark: string | null
  packing: string | null
  remark2: string | null
  synced_at: string
}

type SortCol = 'project_id' | 'begin_date' | 'tpn_partner_id' | 'duedate' | 'synced_at'
type SortDir = 'asc' | 'desc'

// ─── 搜尋篩選 ─────────────────────────────────────────
function filterRows(rows: SoLine[], search: string) {
  if (!search) return rows
  const q = search.toLowerCase()
  return rows.filter(r =>
    r.project_id.toLowerCase().includes(q) ||
    (r.description ?? '').toLowerCase().includes(q) ||
    (r.tpn_partner_id ?? '').toLowerCase().includes(q) ||
    (r.sales_name ?? '').toLowerCase().includes(q) ||
    (r.part ?? '').toLowerCase().includes(q) ||
    (r.remark ?? '').toLowerCase().includes(q) ||
    (r.remark2 ?? '').toLowerCase().includes(q) ||
    (r.packing ?? '').toLowerCase().includes(q)
  )
}

// ─── 頁面 ─────────────────────────────────────────────
export default function SoSyncPage() {
  const [rows, setRows]           = useState<SoLine[]>([])
  const [loading, setLoading]     = useState(false)
  const [syncing, setSyncing]           = useState(false)
  const [syncMsg, setSyncMsg]           = useState<string | null>(null)
  const [syncError, setSyncError]       = useState<string | null>(null)
  const [syncingRemarks, setSyncingRemarks] = useState(false)
  const [syncRemarksMsg, setSyncRemarksMsg] = useState<string | null>(null)
  const [syncRemarksError, setSyncRemarksError] = useState<string | null>(null)
  const [search, setSearch]       = useState('')
  const [sortCol, setSortCol]     = useState<SortCol>('project_id')
  const [sortDir, setSortDir]     = useState<SortDir>('asc')
  const [lastSync, setLastSync]   = useState<string | null>(null)

  const fetchRows = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('erp_so_lines')
      .select('*')
      .order(sortCol, { ascending: sortDir === 'asc' })
      .limit(2000)
    setLoading(false)
    if (error) { console.error(error); return }
    setRows(data ?? [])
    if (data && data.length > 0) {
      const latest = data.reduce((a, b) => a.synced_at > b.synced_at ? a : b)
      setLastSync(latest.synced_at)
    }
  }, [sortCol, sortDir])

  useEffect(() => { void fetchRows() }, [fetchRows])

  async function handleSync() {
    setSyncing(true)
    setSyncMsg(null)
    setSyncError(null)
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_so' }),
      })
      const json = await res.json() as {
        status: string
        syncedCount?: number
        headerCount?: number
        detailTotal?: number
        error?: string
        sampleDetailRow?: unknown
      }
      if (json.status === 'ok') {
        setSyncMsg(`同步完成：${String(json.syncedCount)} 筆 SO 明細（表頭 ${String(json.headerCount)} 筆，明細原始 ${String(json.detailTotal)} 筆）`)
        void fetchRows()
      } else {
        setSyncError(json.error ?? '同步失敗')
        if (json.sampleDetailRow) {
          console.warn('sampleDetailRow', json.sampleDetailRow)
        }
      }
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : '網路錯誤')
    } finally {
      setSyncing(false)
    }
  }

  async function handleSyncRemarks() {
    setSyncingRemarks(true)
    setSyncRemarksMsg(null)
    setSyncRemarksError(null)
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_so_remarks' }),
      })
      const json = await res.json() as {
        status: string
        updatedCount?: number
        skippedProjectCount?: number
        skippedProjects?: string[]
        error?: string
      }
      if (json.status === 'ok') {
        const skippedNote = (json.skippedProjectCount ?? 0) > 0
          ? `，${String(json.skippedProjectCount)} 筆訂單因特殊字元跳過（${(json.skippedProjects ?? []).slice(0, 5).join(', ')}${(json.skippedProjectCount ?? 0) > 5 ? '...' : ''}）`
          : ''
        setSyncRemarksMsg(`備註欄同步完成：更新 ${String(json.updatedCount)} 列${skippedNote}`)
        void fetchRows()
      } else {
        setSyncRemarksError(json.error ?? '備註同步失敗')
      }
    } catch (e) {
      setSyncRemarksError(e instanceof Error ? e.message : '網路錯誤')
    } finally {
      setSyncingRemarks(false)
    }
  }

  function toggleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  const sortableKeys: SortCol[] = ['project_id', 'begin_date', 'tpn_partner_id', 'duedate', 'synced_at']

  const filtered = filterRows(rows, search)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      {/* 標題列 */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">銷售訂單同步</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            ARGO PJ_PROJECT + PJ_PROJECTDETAIL → erp_so_lines
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {lastSync && (
            <span className="text-xs text-gray-500">
              上次同步：{new Date(lastSync).toLocaleString('zh-TW')}
            </span>
          )}
          <button
            onClick={() => void handleSyncRemarks()}
            disabled={syncingRemarks || syncing}
            className="px-4 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-sm transition-colors"
            title="逐訂單查詢 REMARK / PACKING / REMARK2，含特殊字元的訂單自動跳過"
          >
            {syncingRemarks ? '備註同步中...' : '同步備註欄'}
          </button>
          <button
            onClick={() => void handleSync()}
            disabled={syncing}
            className="px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-sm transition-colors"
          >
            {syncing ? '同步中...' : '立即同步'}
          </button>
        </div>
      </div>

      {/* 同步結果訊息 */}
      {syncMsg && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-teal-900/40 border border-teal-700 text-teal-300 text-sm">
          {syncMsg}
        </div>
      )}
      {syncRemarksMsg && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-indigo-900/40 border border-indigo-700 text-indigo-300 text-sm">
          {syncRemarksMsg}
        </div>
      )}
      {syncRemarksError && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm whitespace-pre-wrap">
          ⚠ 備註同步錯誤：{syncRemarksError}
        </div>
      )}
      {syncError && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/40 border border-red-700 text-red-300 text-sm whitespace-pre-wrap">
          ⚠ {syncError}
        </div>
      )}

      {/* 搜尋 + 計數 */}
      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          placeholder="搜尋訂單號 / 品名 / 客戶 / 規格..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 placeholder-gray-500 w-80 focus:outline-none focus:border-teal-500"
        />
        <span className="text-sm text-gray-400">
          {loading ? '載入中...' : `顯示 ${filtered.length.toString()} / ${rows.length.toString()} 筆`}
        </span>
      </div>

      {/* 資料表 */}
      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/80 text-gray-300 text-xs">
              <th className="px-3 py-2.5 text-left font-medium min-w-[150px] cursor-pointer hover:text-white select-none" onClick={() => toggleSort('project_id')}>
                訂單編號 / 開立日期{sortCol === 'project_id' && <span className="ml-1 text-teal-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
              </th>
              <th className="px-3 py-2.5 text-left font-medium min-w-[100px] cursor-pointer hover:text-white select-none" onClick={() => toggleSort('tpn_partner_id')}>
                客戶 / 業務{sortCol === 'tpn_partner_id' && <span className="ml-1 text-teal-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
              </th>
              <th className="px-3 py-2.5 text-center font-medium w-12">序</th>
              <th className="px-3 py-2.5 text-left font-medium min-w-[200px]">品項名稱 / 規格料號</th>
              <th className="px-3 py-2.5 text-left font-medium min-w-[160px]">商品備註 / 包裝方式</th>
              <th className="px-3 py-2.5 text-left font-medium min-w-[100px] cursor-pointer hover:text-white select-none" onClick={() => toggleSort('duedate')}>
                交貨日(預){sortCol === 'duedate' && <span className="ml-1 text-teal-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
              </th>
              <th className="px-3 py-2.5 text-right font-medium w-24">數量 / 單位</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  {rows.length === 0 ? '尚未同步，請點「立即同步」' : '無符合搜尋條件的資料'}
                </td>
              </tr>
            )}
            {filtered.map((row, i) => (
              <tr
                key={row.id}
                className={`border-t border-gray-800/60 hover:bg-gray-800/40 transition-colors ${i % 2 === 0 ? '' : 'bg-gray-900/30'}`}
              >
                {/* 訂單編號 / 開立日期 */}
                <td className="px-3 py-2">
                  <div className="font-mono text-teal-400 text-sm">{row.project_id}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{row.begin_date ?? '—'}</div>
                </td>

                {/* 客戶 / 業務 */}
                <td className="px-3 py-2">
                  <div className="text-gray-200 text-sm">{row.tpn_partner_id ?? '—'}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{row.sales_name ?? '—'}</div>
                </td>

                {/* 序號 */}
                <td className="px-3 py-2 text-center text-gray-400 text-xs">{row.line_no || '—'}</td>

                {/* 品項名稱 / 規格料號 */}
                <td className="px-3 py-2">
                  <div className="text-gray-200 text-sm leading-snug whitespace-pre-wrap break-words max-w-xs">
                    {row.description ?? '—'}
                  </div>
                  {row.part && (
                    <div className="text-xs text-gray-500 mt-0.5 font-mono">{row.part}</div>
                  )}
                </td>

                {/* 商品備註 / 包裝方式 */}
                <td className="px-3 py-2">
                  {row.remark2
                    ? <div className="text-gray-300 text-xs leading-snug whitespace-pre-wrap break-words max-w-[180px]">{row.remark2}</div>
                    : <div className="text-gray-600 text-xs">—</div>
                  }
                  {row.packing && (
                    <div className="text-xs text-amber-400/80 mt-0.5">📦 {row.packing}</div>
                  )}
                </td>

                {/* 交貨日 */}
                <td className="px-3 py-2 text-yellow-400/80 text-sm">{row.duedate ?? '—'}</td>

                {/* 數量 / 單位 */}
                <td className="px-3 py-2 text-right">
                  <span className="text-gray-200 text-sm">{row.order_qty}</span>
                  {row.unit_of_measure && (
                    <span className="text-gray-500 text-xs ml-1">{row.unit_of_measure}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 說明 */}
      <div className="mt-4 text-xs text-gray-600">
        * 每次同步會清除舊資料後重寫。資料來源：ARGO PJ_PROJECT（PJT_TYPE=SO）JOIN PJ_PROJECTDETAIL。
      </div>
    </div>
  )
}
