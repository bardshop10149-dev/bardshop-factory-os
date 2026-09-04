'use client'

import { useState, useCallback } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ===== CSV 欄位型別（對應 wip_record__ 匯出格式）=====
interface WipRecord {
  id_list: string
  work_order: string
  mo_nbr: string
  product_name: string
  product_subname: string
  product_description: string
  lot_nbr: string
  doc_nbr: string
  workcenter_name: string
  job_name: string
  job_sequence: number | null
  status: string
  source_type: string
  wip_qty: number | null
  real_start_time: string | null
  real_end_time: string | null
  report_resources: string
  username: string
  site_label?: string | null
}

const STATUS_LABEL: Record<string, string> = {
  finished: '完成',
  running:  '進行中',
  pause:    '暫停',
}

const STATUS_COLOR: Record<string, string> = {
  finished: 'text-emerald-400',
  running:  'text-yellow-400',
  pause:    'text-amber-400',
}

const SITE_OPTIONS = ['台北', '常平', '委外'] as const
type SiteLabel = typeof SITE_OPTIONS[number]

const SITE_BADGE: Record<SiteLabel, string> = {
  '台北': 'bg-sky-800/60 text-sky-300 border border-sky-700/40',
  '常平': 'bg-orange-800/60 text-orange-300 border border-orange-700/40',
  '委外': 'bg-violet-800/60 text-violet-300 border border-violet-700/40',
}

/** 各廠區對應的製令/採購/請購單號標籤與前綴 */
const SITE_REF: Record<SiteLabel, { label: string; prefix: string; color: string }> = {
  '台北': { label: '製令號',   prefix: 'MOT', color: 'text-cyan-300' },
  '常平': { label: '採購單號', prefix: 'POC', color: 'text-orange-300' },
  '委外': { label: '請購單號', prefix: 'MPO', color: 'text-violet-300' },
}

function refLabel(siteFilter: string): string {
  if (siteFilter in SITE_REF) return SITE_REF[siteFilter as SiteLabel].label
  return '製令/採購/請購號'
}

// ===== 各機台日報 =====
// report_resources 是「機台, 人員」黏在同一個逗號分隔字串裡（順序不固定，兩種都出現過），
// 無法單純用位置判斷；改用 sara_resources 裡登記的機台/產線清單來比對，抓出真正的機台名稱，
// 同機台不同人一律算同一台（不分人）。
interface DailyMachineRow {
  machine: string
  totalQty: number
  reportCount: number
  orderNumbers: Set<string>
  jobNames: Set<string>
}

function taipeiDateStr(d: Date): string {
  // 用 Intl 取得 Asia/Taipei 當地日期字串（YYYY-MM-DD），避免用本機瀏覽器時區猜測
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const y = parts.find(p => p.type === 'year')!.value
  const m = parts.find(p => p.type === 'month')!.value
  const dd = parts.find(p => p.type === 'day')!.value
  return `${y}-${m}-${dd}`
}

function taipeiDayUtcRange(dateStr: string): { startUtc: string; endUtc: string } {
  // Asia/Taipei 為 UTC+8，當地一天的範圍換算成 UTC 區間
  const start = new Date(`${dateStr}T00:00:00+08:00`)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { startUtc: start.toISOString(), endUtc: end.toISOString() }
}

interface ArgoProductQty {
  code: string
  qty: number
  name: string | null
}

interface ArgoMachineOutputRow {
  machine: string
  actualQty: number
  rejectQty: number
  moCount: number
  pendingMoCount: number
  moNumbers: string[]
  products: ArgoProductQty[]
}

// ===== 主元件 =====
export default function SaraWipRecordsPage() {
  const [tab, setTab] = useState<'view' | 'daily' | 'argo-daily'>('view')

  // --- 瀏覽狀態 ---
  const [records, setRecords] = useState<WipRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [wcFilter, setWcFilter] = useState('印刷站2F')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [siteFilter, setSiteFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50

  // --- 各機台日報狀態 ---
  const [dailyDate, setDailyDate] = useState(() => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    return taipeiDateStr(yesterday)
  })
  const [dailySiteFilter, setDailySiteFilter] = useState<string>('all')
  const [dailyLoading, setDailyLoading] = useState(false)
  const [dailyRows, setDailyRows] = useState<DailyMachineRow[]>([])
  const [dailyUnmatched, setDailyUnmatched] = useState<DailyMachineRow[]>([])
  const [dailyLatestDate, setDailyLatestDate] = useState<string | null>(null)  // 資料庫實際最新一筆報工的日期，供新鮮度提示

  // --- 各機台日報（ARGO 實際繳庫版）狀態 ---
  const [argoDate, setArgoDate] = useState(() => taipeiDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000)))
  const [argoLoading, setArgoLoading] = useState(false)
  const [argoRows, setArgoRows] = useState<ArgoMachineOutputRow[]>([])
  const [argoPackingList, setArgoPackingList] = useState<ArgoProductQty[]>([])
  const [argoUnassignedCount, setArgoUnassignedCount] = useState(0)
  const [argoTotalMoCount, setArgoTotalMoCount] = useState(0)
  const [argoError, setArgoError] = useState('')

  // --- 讀取紀錄 ---
  const fetchRecords = useCallback(async () => {
    setLoading(true)
    try {
      let query = supabase
        .from('sara_wip_records')
        .select('id_list,work_order,mo_nbr,product_name,product_subname,product_description,lot_nbr,doc_nbr,workcenter_name,job_name,job_sequence,status,source_type,wip_qty,real_start_time,real_end_time,report_resources,username,site_label')
        .order('real_end_time', { ascending: false })
        .limit(500)

      if (wcFilter) query = query.eq('workcenter_name', wcFilter)
      if (statusFilter !== 'all') query = query.eq('status', statusFilter)
      if (siteFilter !== 'all') query = query.eq('site_label', siteFilter)
      if (search.trim()) {
        const q = search.trim()
        query = query.or(`mo_nbr.ilike.%${q}%,doc_nbr.ilike.%${q}%,product_description.ilike.%${q}%,username.ilike.%${q}%`)
      }

      const { data, error } = await query
      if (error) throw error
      setRecords((data ?? []) as WipRecord[])
      setPage(0)
    } catch (e) {
      console.error('fetchRecords error', e)
    } finally {
      setLoading(false)
    }
  }, [wcFilter, statusFilter, siteFilter, search])

  const pageRecords = records.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const totalPages = Math.ceil(records.length / PAGE_SIZE)

  // --- 各機台日報：讀取指定（台北時區）日期內已完成的報工，依機台彙總 ---
  const fetchDailySummary = useCallback(async (dateStr: string) => {
    setDailyLoading(true)
    try {
      // 已登記的機台／產線清單（同機台不同人不分人，靠這份清單從 report_resources 抓出機台）
      const { data: resourceRows, error: resErr } = await supabase
        .from('sara_resources')
        .select('resource_name, resource_type')
        .in('resource_type', ['Machine', 'Line'])
      if (resErr) throw resErr
      const machineNames = new Set((resourceRows ?? []).map(r => r.resource_name))

      const { startUtc, endUtc } = taipeiDayUtcRange(dateStr)
      let query = supabase
        .from('sara_wip_records')
        .select('mo_nbr,job_name,wip_qty,report_resources,status,real_end_time,site_label')
        .eq('status', 'finished')
        .gte('real_end_time', startUtc)
        .lt('real_end_time', endUtc)
        .limit(5000)
      if (dailySiteFilter !== 'all') query = query.eq('site_label', dailySiteFilter)
      const { data, error } = await query
      if (error) throw error

      const matched = new Map<string, DailyMachineRow>()
      const unmatched = new Map<string, DailyMachineRow>()
      for (const r of (data ?? []) as Array<{ mo_nbr: string | null; job_name: string | null; wip_qty: number | null; report_resources: string | null; status: string | null; real_end_time: string | null; site_label: string | null }>) {
        const pieces = String(r.report_resources ?? '').split(/[,、]/).map(s => s.trim()).filter(Boolean)
        const machinesInRow = pieces.filter(p => machineNames.has(p))
        const targets = machinesInRow.length > 0 ? machinesInRow : [pieces.join('、') || '（無資源資訊）']
        const bucket = machinesInRow.length > 0 ? matched : unmatched
        for (const m of targets) {
          const row = bucket.get(m) ?? { machine: m, totalQty: 0, reportCount: 0, orderNumbers: new Set(), jobNames: new Set() }
          row.totalQty += r.wip_qty ?? 0
          row.reportCount += 1
          if (r.mo_nbr) row.orderNumbers.add(r.mo_nbr)
          if (r.job_name) row.jobNames.add(r.job_name)
          bucket.set(m, row)
        }
      }

      setDailyRows([...matched.values()].sort((a, b) => b.totalQty - a.totalQty))
      setDailyUnmatched([...unmatched.values()].sort((a, b) => b.totalQty - a.totalQty))

      // 順便查一下資料庫實際最新一筆報工的日期，判斷選定日期是否落在有資料的範圍內
      const { data: latest } = await supabase
        .from('sara_wip_records')
        .select('real_end_time')
        .not('real_end_time', 'is', null)
        .order('real_end_time', { ascending: false })
        .limit(1)
      setDailyLatestDate(latest?.[0]?.real_end_time ? taipeiDateStr(new Date(latest[0].real_end_time)) : null)
    } catch (e) {
      console.error('fetchDailySummary error', e)
      setDailyRows([])
      setDailyUnmatched([])
    } finally {
      setDailyLoading(false)
    }
  }, [dailySiteFilter])

  // --- 各機台日報（ARGO 實際繳庫版）：直接查 ARGO 製令繳庫 + 本系統機台分配，不依賴 SARA ---
  const fetchArgoDailyOutput = useCallback(async (dateStr: string) => {
    setArgoLoading(true)
    setArgoError('')
    try {
      const res = await fetch(`/api/argoerp/daily-machine-output?date=${dateStr}`, { cache: 'no-store' })
      const json = await res.json() as {
        success: boolean; error?: string
        rows?: ArgoMachineOutputRow[]; packingList?: ArgoProductQty[]
        totalMoCount?: number; unassignedMoCount?: number
      }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setArgoRows(json.rows ?? [])
      setArgoPackingList(json.packingList ?? [])
      setArgoTotalMoCount(json.totalMoCount ?? 0)
      setArgoUnassignedCount(json.unassignedMoCount ?? 0)
    } catch (e) {
      setArgoError(e instanceof Error ? e.message : String(e))
      setArgoRows([])
      setArgoPackingList([])
    } finally {
      setArgoLoading(false)
    }
  }, [])

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        {/* 頁首 */}
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">塔台報工紀錄</h1>
            <p className="text-slate-400 text-sm mt-0.5">每日自動同步塔台報工（台北時間 09/12/15/18/21 點）・本系統自有資料庫永久保存（塔台端僅保留 6 個月）・預設顯示印刷站2F</p>
          </div>
        </div>

        {/* 分頁標籤 */}
        <div className="flex gap-1 border-b border-slate-800">
          {([['view', '📋 瀏覽紀錄'], ['daily', '📊 各機台日報(SARA)'], ['argo-daily', '🎯 各機台日報(ARGO繳庫)']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setTab(key)
                if (key === 'view') void fetchRecords()
                if (key === 'daily') void fetchDailySummary(dailyDate)
                if (key === 'argo-daily') void fetchArgoDailyOutput(argoDate)
              }}
              className={`px-4 py-2 text-sm rounded-t transition-colors ${tab === key ? 'bg-slate-800 text-white border-t border-x border-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ===== 瀏覽紀錄 ===== */}
        {tab === 'view' && (
          <div className="space-y-3">
            {/* 篩選列 */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2">
                <label className="text-slate-400 text-sm whitespace-nowrap">廠區</label>
                <select
                  value={siteFilter}
                  onChange={e => setSiteFilter(e.target.value)}
                  className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none"
                >
                  <option value="all">全部</option>
                  {SITE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-slate-400 text-sm whitespace-nowrap">站點</label>
                <input
                  type="text"
                  value={wcFilter}
                  onChange={e => setWcFilter(e.target.value)}
                  placeholder="印刷站2F"
                  className="w-32 px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500/60"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-slate-400 text-sm whitespace-nowrap">狀態</label>
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value)}
                  className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none"
                >
                  <option value="all">全部</option>
                  <option value="finished">完成</option>
                  <option value="running">進行中</option>
                  <option value="pause">暫停</option>
                </select>
              </div>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void fetchRecords()}
                placeholder="搜尋單號 / 規格 / 人員…"
                className="flex-1 min-w-[160px] px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500/60"
              />
              <button
                onClick={() => void fetchRecords()}
                disabled={loading}
                className="px-4 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white text-sm transition-colors"
              >
                {loading ? '查詢中…' : '查詢'}
              </button>
            </div>

            {/* 分頁資訊 */}
            {records.length > 0 && (
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>共 {records.length} 筆{records.length >= 500 ? '（顯示最多 500 筆）' : ''}</span>
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30">‹</button>
                    <span>{page + 1} / {totalPages}</span>
                    <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30">›</button>
                  </div>
                )}
              </div>
            )}

            {/* 資料表格 */}
            {loading ? (
              <div className="py-16 text-center text-slate-400 text-sm">載入中…</div>
            ) : records.length === 0 ? (
              <div className="py-16 text-center space-y-2">
                <p className="text-slate-400 text-sm">目前無符合條件的報工紀錄</p>
                <p className="text-slate-500 text-xs">目前無符合的報工資料，請調整篩選條件（資料每日自動同步）</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-700">
                <table className="w-full text-xs">
                  <thead className="bg-slate-800/90 sticky top-0">
                    <tr className="border-b border-slate-700">
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">{refLabel(siteFilter)}</th>
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">來源單號</th>
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">料號</th>
                      <th className="px-3 py-2.5 text-left text-slate-300 max-w-[200px]">規格</th>
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">站點</th>
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">製程</th>
                      <th className="px-3 py-2.5 text-right text-slate-300 whitespace-nowrap">數量</th>
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">狀態</th>
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">報工結束</th>
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">廠區</th>
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">人員</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRecords.map((r, i) => (
                      <tr key={r.work_order} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-800/20'}`}>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {(() => {
                            const ref = r.site_label ? SITE_REF[r.site_label as SiteLabel] : null
                            return (
                              <span className={`font-mono ${ref?.color ?? 'text-cyan-300'}`}>
                                {ref && <span className="text-[9px] opacity-60 mr-1">{ref.prefix}</span>}
                                {r.mo_nbr || '—'}
                              </span>
                            )
                          })()}
                        </td>
                        <td className="px-3 py-2 font-mono text-amber-300/80 whitespace-nowrap">{r.doc_nbr || '—'}</td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{r.product_name || '—'}</td>
                        <td className="px-3 py-2 text-slate-200 max-w-[200px] truncate" title={r.product_description || ''}>{r.product_description || '—'}</td>
                        <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{r.workcenter_name}</td>
                        <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{r.job_name}</td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-300 whitespace-nowrap">
                          {r.wip_qty != null ? r.wip_qty.toLocaleString() : '—'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={STATUS_COLOR[r.status] ?? 'text-slate-400'}>{STATUS_LABEL[r.status] ?? r.status}</span>
                        </td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{r.real_end_time?.slice(0, 16) ?? '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {r.site_label
                            ? <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${SITE_BADGE[r.site_label as SiteLabel] ?? 'bg-slate-700 text-slate-300'}`}>{r.site_label}</span>
                            : <span className="text-slate-600">—</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-400 max-w-[120px] truncate" title={r.username}>{r.username}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ===== 各機台日報 ===== */}
        {tab === 'daily' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-slate-400 text-sm whitespace-nowrap">日期</label>
              <button
                onClick={() => {
                  const d = new Date(`${dailyDate}T00:00:00+08:00`)
                  const prev = taipeiDateStr(new Date(d.getTime() - 24 * 60 * 60 * 1000))
                  setDailyDate(prev)
                  void fetchDailySummary(prev)
                }}
                className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
              >‹</button>
              <input
                type="date"
                value={dailyDate}
                onChange={e => { setDailyDate(e.target.value); void fetchDailySummary(e.target.value) }}
                className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none"
              />
              <button
                onClick={() => {
                  const d = new Date(`${dailyDate}T00:00:00+08:00`)
                  const next = taipeiDateStr(new Date(d.getTime() + 24 * 60 * 60 * 1000))
                  setDailyDate(next)
                  void fetchDailySummary(next)
                }}
                className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
              >›</button>
              <div className="flex items-center gap-2 ml-2">
                <label className="text-slate-400 text-sm whitespace-nowrap">廠區</label>
                <select
                  value={dailySiteFilter}
                  onChange={e => { setDailySiteFilter(e.target.value); void fetchDailySummary(dailyDate) }}
                  className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none"
                >
                  <option value="all">全部</option>
                  {SITE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <button
                onClick={() => void fetchDailySummary(dailyDate)}
                disabled={dailyLoading}
                className="px-4 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white text-sm transition-colors"
              >
                {dailyLoading ? '查詢中…' : '重新查詢'}
              </button>
            </div>

            <p className="text-slate-500 text-xs">
              只計算狀態為「完成」的報工，同一台機台不論由誰報工都算在一起。資料來源是每日自動同步的塔台報工紀錄（台北時間 09/12/15/18/21 點更新）。
            </p>

            {dailyLatestDate && dailyLatestDate < dailyDate && (
              <div className="px-3 py-2 rounded-lg bg-amber-900/30 border border-amber-700/40 text-amber-300 text-xs">
                ⚠ 資料庫目前最新的報工紀錄只到 {dailyLatestDate}，比你選的日期舊——自動同步可能尚未執行到該日，稍後再查看，這份日報才會準確。
              </div>
            )}

            {dailyLoading ? (
              <div className="py-16 text-center text-slate-400 text-sm">載入中…</div>
            ) : dailyRows.length === 0 && dailyUnmatched.length === 0 ? (
              <div className="py-16 text-center space-y-2">
                <p className="text-slate-400 text-sm">{dailyDate} 沒有已完成的報工紀錄</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto rounded-xl border border-slate-700">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-800/90">
                      <tr className="border-b border-slate-700">
                        <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">機台</th>
                        <th className="px-3 py-2.5 text-right text-slate-300 whitespace-nowrap">產出總數</th>
                        <th className="px-3 py-2.5 text-right text-slate-300 whitespace-nowrap">報工筆數</th>
                        <th className="px-3 py-2.5 text-right text-slate-300 whitespace-nowrap">涉及工單數</th>
                        <th className="px-3 py-2.5 text-left text-slate-300">主要製程</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dailyRows.map((row, i) => (
                        <tr key={row.machine} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-800/20'}`}>
                          <td className="px-3 py-2 font-medium text-slate-100 whitespace-nowrap">{row.machine}</td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-300 whitespace-nowrap">{row.totalQty.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{row.reportCount}</td>
                          <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{row.orderNumbers.size}</td>
                          <td className="px-3 py-2 text-slate-400 max-w-[320px] truncate" title={[...row.jobNames].join('、')}>
                            {[...row.jobNames].slice(0, 4).join('、')}{row.jobNames.size > 4 ? ` 等 ${row.jobNames.size} 項` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {dailyUnmatched.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-slate-500 text-xs">
                      以下報工的資源欄位比對不到已登記的機台/產線清單（可能是只記了人員、或機台名稱跟 SARA 資源設定不一致），列出來供核對：
                    </p>
                    <div className="overflow-x-auto rounded-xl border border-slate-800">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-900 text-slate-500">
                          <tr>
                            <th className="px-3 py-2 text-left whitespace-nowrap">原始資源欄位</th>
                            <th className="px-3 py-2 text-right whitespace-nowrap">產出總數</th>
                            <th className="px-3 py-2 text-right whitespace-nowrap">報工筆數</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dailyUnmatched.map(row => (
                            <tr key={row.machine} className="border-b border-slate-800/40 text-slate-400">
                              <td className="px-3 py-2 whitespace-nowrap">{row.machine}</td>
                              <td className="px-3 py-2 text-right font-mono">{row.totalQty.toLocaleString()}</td>
                              <td className="px-3 py-2 text-right">{row.reportCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ===== 各機台日報（ARGO 實際繳庫版）===== */}
        {tab === 'argo-daily' && (
          <div className="space-y-4">
            <div className="px-3 py-2 rounded-lg bg-emerald-900/20 border border-emerald-700/40 text-emerald-300 text-xs">
              這個版本不吃 SARA 的資料——直接查 ARGO 製令實際繳庫量（ACTUAL_QTY），交叉比對每日出單表「儲存機台分配」存的機台，
              兩邊都是目前有在正常運作、即時的資料來源，不會有資料過期的問題。
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="text-slate-400 text-sm whitespace-nowrap">日期</label>
              <button
                onClick={() => {
                  const d = new Date(`${argoDate}T00:00:00+08:00`)
                  const prev = taipeiDateStr(new Date(d.getTime() - 24 * 60 * 60 * 1000))
                  setArgoDate(prev)
                  void fetchArgoDailyOutput(prev)
                }}
                className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
              >‹</button>
              <input
                type="date"
                value={argoDate}
                onChange={e => { setArgoDate(e.target.value); void fetchArgoDailyOutput(e.target.value) }}
                className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none"
              />
              <button
                onClick={() => {
                  const d = new Date(`${argoDate}T00:00:00+08:00`)
                  const next = taipeiDateStr(new Date(d.getTime() + 24 * 60 * 60 * 1000))
                  setArgoDate(next)
                  void fetchArgoDailyOutput(next)
                }}
                className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
              >›</button>
              <button
                onClick={() => void fetchArgoDailyOutput(argoDate)}
                disabled={argoLoading}
                className="px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-sm transition-colors"
              >
                {argoLoading ? '查詢中…' : '重新查詢'}
              </button>
              {argoTotalMoCount > 0 && (
                <span className="text-slate-500 text-xs">
                  當天共 {argoTotalMoCount} 張製令有繳庫紀錄
                  {argoUnassignedCount > 0 && `，其中 ${argoUnassignedCount} 張沒有機台分配紀錄（未計入下表）`}
                </span>
              )}
            </div>

            {argoError && (
              <div className="px-3 py-2 rounded-lg bg-red-900/30 border border-red-700/40 text-red-300 text-xs">❌ {argoError}</div>
            )}

            {argoLoading ? (
              <div className="py-16 text-center text-slate-400 text-sm">查詢 ARGO 中…</div>
            ) : argoRows.length === 0 ? (
              <div className="py-16 text-center space-y-2">
                <p className="text-slate-400 text-sm">{argoDate} 沒有可歸屬到機台的繳庫紀錄</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-700">
                <table className="w-full text-xs">
                  <thead className="bg-slate-800/90">
                    <tr className="border-b border-slate-700">
                      <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">機台</th>
                      <th className="px-3 py-2.5 text-right text-slate-300 whitespace-nowrap">實際繳庫量</th>
                      <th className="px-3 py-2.5 text-right text-slate-300 whitespace-nowrap">製令數</th>
                      <th className="px-3 py-2.5 text-left text-slate-300">品號（品名／數量）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {argoRows.map((row, i) => (
                      <tr key={row.machine} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-800/20'}`}>
                        <td className="px-3 py-2 font-medium text-slate-100 whitespace-nowrap align-top">
                          {row.machine}
                          {row.pendingMoCount > 0 && (
                            <div className="mt-0.5 text-[10px] font-normal text-amber-400/90 whitespace-normal">
                              ⚠️ {row.pendingMoCount} 張製令有異動但尚未繳庫
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-300 whitespace-nowrap align-top">{row.actualQty.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap align-top">{row.moCount}</td>
                        <td className="px-3 py-2 text-slate-400 max-w-[480px] align-top">
                          <div className="flex flex-col gap-0.5">
                            {row.products.map(p => (
                              <span key={p.code} className="whitespace-nowrap">
                                <span className="text-slate-200">{p.code}</span>
                                {p.name && <span className="text-slate-500"> · {p.name}</span>}
                                <span className="text-emerald-300/80"> ({p.qty.toLocaleString()})</span>
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* 包裝部清單：當天所有有繳庫的製令，不分機台，品號+數量整批加總 */}
            {argoPackingList.length > 0 && (
              <div className="space-y-2 pt-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-200">📦 包裝部清單</h2>
                  <span className="text-slate-500 text-xs">{argoDate} 當天所有繳庫製令的品號加總，不分機台</span>
                </div>
                <div className="overflow-x-auto rounded-xl border border-slate-700 max-h-[400px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-800/90 sticky top-0">
                      <tr className="border-b border-slate-700">
                        <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">品號</th>
                        <th className="px-3 py-2.5 text-left text-slate-300">品名</th>
                        <th className="px-3 py-2.5 text-right text-slate-300 whitespace-nowrap">數量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {argoPackingList.map((p, i) => (
                        <tr key={p.code} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-800/20'}`}>
                          <td className="px-3 py-2 text-slate-100 whitespace-nowrap">{p.code}</td>
                          <td className="px-3 py-2 text-slate-400">{p.name ?? '—'}</td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-300 whitespace-nowrap">{p.qty.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
