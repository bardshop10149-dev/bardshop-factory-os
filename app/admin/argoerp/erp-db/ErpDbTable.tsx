'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any> & { id: number }

interface ColDef {
  key: string
  label: string
  align?: 'left' | 'right'
  mono?: boolean
  date?: boolean
}

const PAGE_SIZE = 50

// ─── 每種 docType 的欄位定義 ─────────────────────────────
const COL_MAP: Record<string, ColDef[]> = {
  銷售訂單: [
    { key: 'project_id',       label: '訂單號',   mono: true },
    { key: 'line_no',          label: '行號',     mono: true },
    { key: 'partner_name',     label: '客戶名稱' },
    { key: 'sales_name',       label: '業務' },
    { key: 'mbp_part',         label: '料號',     mono: true },
    { key: 'duedate',          label: '交期',     date: true },
    { key: 'order_qty_oru',    label: '數量',     align: 'right', mono: true },
    { key: 'unit_of_measure_oru', label: '單位' },
    { key: 'synced_at',        label: '同步時間', date: true },
  ],
  製令單號: [
    { key: 'project_id',  label: '製令號',  mono: true },
    { key: 'line_no',     label: '行號',    mono: true },
    { key: 'mbp_part',    label: '料號',    mono: true },
    { key: 'mbp_lot_no',  label: '批號',    mono: true },
    { key: 'order_qty',   label: '數量',    align: 'right', mono: true },
    { key: 'source_order',label: '來源訂單',mono: true },
    { key: 'begin_date',  label: '開始日',  date: true },
    { key: 'end_date',    label: '結束日',  date: true },
    { key: 'hold_status', label: '狀態' },
    { key: 'synced_at',   label: '同步時間',date: true },
  ],
  採購單號: [
    { key: 'doc_no',          label: '採購單號', mono: true },
    { key: 'description',     label: '名稱' },
    { key: 'status',          label: '狀態' },
    { key: 'start_date',      label: '開始日',   date: true },
    { key: 'end_date',        label: '結束日',   date: true },
    { key: 'customer_vendor', label: '供應商' },
    { key: 'synced_at',       label: '同步時間', date: true },
  ],
  委外製令: [
    { key: 'doc_no',          label: '委外製令號', mono: true },
    { key: 'description',     label: '名稱' },
    { key: 'status',          label: '狀態' },
    { key: 'start_date',      label: '開始日',   date: true },
    { key: 'end_date',        label: '結束日',   date: true },
    { key: 'customer_vendor', label: '廠商' },
    { key: 'synced_at',       label: '同步時間', date: true },
  ],
  倉庫庫存: [
    { key: 'item_code',   label: '料號',     mono: true },
    { key: 'item_name',   label: '品名' },
    { key: 'spec',        label: '規格' },
    { key: 'book_count',  label: '帳面庫存', align: 'right', mono: true },
    { key: 'physical_count', label: '實際庫存', align: 'right', mono: true },
    { key: 'unit_of_measure', label: '單位' },
    { key: 'updated_at',  label: '更新時間', date: true },
  ],
  BOM結構: [
    { key: 'parent_part',  label: '母件料號', mono: true },
    { key: 'bom_ver',      label: 'BOM版本',  mono: true, align: 'right' },
    { key: 'line_no',      label: '行號',     mono: true, align: 'right' },
    { key: 'child_part',   label: '子件料號', mono: true },
    { key: 'child_qty',    label: '用量',     align: 'right', mono: true },
    { key: 'child_scrap',  label: '損耗率',   align: 'right', mono: true },
    { key: 'lot_base',     label: '批量基準', align: 'right', mono: true },
    { key: 'synced_at',    label: '同步時間', date: true },
  ],
}

// ─── 每種 docType 的 Supabase 資料來源 ─────────────────────
type SourceConfig =
  | { from: 'erp_so_lines' }
  | { from: 'erp_mo_lines' }
  | { from: 'erp_pj_sync'; docType: string }
  | { from: 'material_inventory_list' }
  | { from: 'mm_bom_structure' }

const SOURCE_MAP: Record<string, SourceConfig> = {
  銷售訂單: { from: 'erp_so_lines' },
  製令單號: { from: 'erp_mo_lines' },
  採購單號: { from: 'erp_pj_sync', docType: '採購單號' },
  委外製令: { from: 'erp_pj_sync', docType: '委外製令' },
  倉庫庫存: { from: 'material_inventory_list' },
  BOM結構:  { from: 'mm_bom_structure' },
}

// ─── 同步動作設定 ────────────────────────────────────────────
type SyncAction =
  | { action: 'sync_so' }
  | { action: 'sync_mo' }
  | { action: 'sync_bom_structure' }
  | { action: 'sync_pj'; table: string; customColumn?: string; filters?: Record<string, string>; mapping: Record<string, string> }
  | { action: 'sync_inventory'; table: string; customColumn?: string; filters?: Record<string, string>; mapping: Record<string, string> }

const SYNC_ACTION_MAP: Record<string, SyncAction> = {
  銷售訂單: { action: 'sync_so' },
  製令單號: { action: 'sync_mo' },
  採購單號: {
    action: 'sync_pj',
    table: 'PJ_PROJECT',
    filters: { PJT_TYPE: "= 'PO'" },
    mapping: { docNoField: 'PROJECT_ID', startDateField: 'BEGIN_DATE', endDateField: 'END_DATE', statusField: 'HOLD_STATUS', customerVendorField: 'IN_CHARGE' },
  },
  委外製令: {
    action: 'sync_pj',
    table: 'PJ_PROJECT',
    filters: { PJT_TYPE: "= 'OO'" },
    mapping: { docNoField: 'PROJECT_ID', startDateField: 'BEGIN_DATE', endDateField: 'END_DATE', statusField: 'HOLD_STATUS', customerVendorField: 'IN_CHARGE' },
  },
  倉庫庫存: {
    action: 'sync_inventory',
    table: 'MM_BOM_BOH_V',
    filters: { ROWNUM: '<= 10000' },
    mapping: { itemCodeField: 'PART', descriptionField: 'PART_DESC', bookCountField: 'BOH', transitCountField: 'PO_ON_ROAD' },
  },
  BOM結構: { action: 'sync_bom_structure' },
}

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleString('zh-TW', { hour12: false })
  } catch {
    return ts
  }
}

function renderCell(row: AnyRow, col: ColDef): string {
  const val = row[col.key]
  if (val === null || val === undefined || val === '') return '-'
  if (col.date) return formatDate(String(val))
  if (typeof val === 'number') return String(val)
  return String(val)
}

interface Props {
  docType: string
  title: string
}

export default function ErpDbTable({ docType, title }: Props) {
  const [rows, setRows] = useState<AnyRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const cols = COL_MAP[docType] ?? []
  const sourceCfg = SOURCE_MAP[docType]
  const syncCfg = SYNC_ACTION_MAP[docType]

  const load = useCallback(async () => {
    if (!sourceCfg) return
    setLoading(true)
    setError('')
    try {
      let query
      if (sourceCfg.from === 'erp_pj_sync') {
        query = supabase.from('erp_pj_sync').select('*').eq('doc_type', sourceCfg.docType).order('synced_at', { ascending: false })
      } else if (sourceCfg.from === 'erp_so_lines') {
        query = supabase.from('erp_so_lines').select('*').order('project_id', { ascending: true }).order('line_no', { ascending: true })
      } else if (sourceCfg.from === 'erp_mo_lines') {
        query = supabase.from('erp_mo_lines').select('*').order('project_id', { ascending: true }).order('line_no', { ascending: true })
      } else if (sourceCfg.from === 'mm_bom_structure') {
        query = supabase.from('mm_bom_structure').select('id,parent_part,bom_ver,line_no,child_part,child_qty,child_scrap,lot_base,synced_at').order('parent_part', { ascending: true }).order('line_no', { ascending: true })
      } else {
        query = supabase.from('material_inventory_list').select('id,item_code,item_name,spec,book_count,physical_count,unit_of_measure,updated_at').order('item_code', { ascending: true })
      }
      const { data, error: err } = await query
      if (err) throw err
      setRows((data as AnyRow[]) ?? [])
      if (data && data.length > 0) {
        const first = data[0] as AnyRow
        setSyncedAt(String(first.synced_at ?? first.updated_at ?? ''))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [docType, sourceCfg])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const handleSync = useCallback(async () => {
    if (!syncCfg) return
    setSyncing(true)
    setSyncMsg(null)
    try {
      let body: Record<string, unknown>
      if (syncCfg.action === 'sync_so' || syncCfg.action === 'sync_mo' || syncCfg.action === 'sync_bom_structure') {
        body = { action: syncCfg.action }
      } else if (syncCfg.action === 'sync_inventory') {
        body = {
          action: 'sync_inventory',
          table: syncCfg.table,
          ...(syncCfg.customColumn ? { customColumn: syncCfg.customColumn } : {}),
          ...(syncCfg.filters ? { filters: syncCfg.filters } : {}),
          mapping: syncCfg.mapping,
        }
      } else {
        body = {
          action: 'sync_pj',
          table: syncCfg.table,
          ...(syncCfg.filters ? { filters: syncCfg.filters } : {}),
          docType,
          mapping: syncCfg.mapping,
        }
      }
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json() as { status: string; syncedCount?: number; totalFromArgo?: number; error?: string }
      if (json.status === 'ok') {
        const msg = json.totalFromArgo != null
          ? `✅ 同步完成：${json.syncedCount ?? 0} 筆（ARGO 取得 ${json.totalFromArgo} 筆）`
          : `✅ 同步完成：${json.syncedCount ?? 0} 筆`
        setSyncMsg(msg)
        void load()
      } else {
        setSyncMsg(`❌ 同步失敗：${json.error ?? '未知錯誤'}`)
      }
    } catch (e) {
      setSyncMsg(`❌ ${e instanceof Error ? e.message : '連線錯誤'}`)
    } finally {
      setSyncing(false)
    }
  }, [docType, syncCfg, load])

  const filtered = rows.filter(r => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return Object.values(r).some(v =>
      typeof v === 'string' && v.toLowerCase().includes(q)
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
                最後同步：{formatDate(syncedAt)}
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
            {syncCfg && (
              <button
                onClick={() => void handleSync()}
                disabled={syncing || loading}
                className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white transition-colors text-sm font-medium"
              >
                {syncing ? '同步中...' : '⟳ 同步 ARGO'}
              </button>
            )}
            {syncMsg && (
              <span className={`text-xs ${syncMsg.startsWith('❌') ? 'text-red-400' : 'text-emerald-400'}`}>{syncMsg}</span>
            )}
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
