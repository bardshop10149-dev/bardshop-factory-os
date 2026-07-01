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

// ===== CSV 解析 =====
function parseWipCsv(text: string): WipRecord[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 3) return []   // 至少需要英文 header + 中文 header + 1 筆資料

  const headers = splitCsvLine(lines[0])
  const colIdx = (names: string[]): number => {
    for (const n of names) {
      const i = headers.indexOf(n)
      if (i !== -1) return i
    }
    return -1
  }

  const COL = {
    id_list:             colIdx(['id_list']),
    work_order:          colIdx(['work_order']),
    mo_nbr:              colIdx(['mo_nbr']),
    product_name:        colIdx(['product_name']),
    product_subname:     colIdx(['product_subname']),
    product_description: colIdx(['product_description']),
    lot_nbr:             colIdx(['lot_nbr']),
    doc_nbr:             colIdx(['doc_nbr']),
    workcenter_name:     colIdx(['workcenter_name']),
    job_name:            colIdx(['job_name']),
    job_sequence:        colIdx(['job_sequence']),
    status:              colIdx(['status']),
    source_type:         colIdx(['source_type']),
    wip_qty:             colIdx(['wip_qty']),
    real_start_time:     colIdx(['real_start_time']),
    real_end_time:       colIdx(['real_end_time']),
    report_resources:    colIdx(['report_resources']),
    username:            colIdx(['username']),
  }

  const records: WipRecord[] = []
  // 第 2 行是中文標頭，跳過；從第 3 行開始是資料
  for (let i = 2; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    const g = (col: number): string => (col >= 0 && col < cells.length ? cells[col].trim() : '')
    const workOrder = g(COL.work_order)
    if (!workOrder) continue

    records.push({
      id_list:             g(COL.id_list),
      work_order:          workOrder,
      mo_nbr:              g(COL.mo_nbr),
      product_name:        g(COL.product_name),
      product_subname:     g(COL.product_subname),
      product_description: g(COL.product_description),
      lot_nbr:             g(COL.lot_nbr),
      doc_nbr:             g(COL.doc_nbr),
      workcenter_name:     g(COL.workcenter_name),
      job_name:            g(COL.job_name),
      job_sequence:        g(COL.job_sequence) ? parseInt(g(COL.job_sequence), 10) : null,
      status:              g(COL.status),
      source_type:         g(COL.source_type),
      wip_qty:             g(COL.wip_qty) !== '' ? parseFloat(g(COL.wip_qty)) : null,
      real_start_time:     g(COL.real_start_time) || null,
      real_end_time:       g(COL.real_end_time) || null,
      report_resources:    g(COL.report_resources),
      username:            g(COL.username),
    })
  }
  return records
}

function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      result.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  result.push(cur)
  return result
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
  '常平': 'bg-violet-800/60 text-violet-300 border border-violet-700/40',
  '委外': 'bg-orange-800/60 text-orange-300 border border-orange-700/40',
}

/** 各廠區對應的製令/採購/請購單號標籤與前綴 */
const SITE_REF: Record<SiteLabel, { label: string; prefix: string; color: string }> = {
  '台北': { label: '製令號',   prefix: 'MOT', color: 'text-cyan-300' },
  '常平': { label: '採購單號', prefix: 'POC', color: 'text-violet-300' },
  '委外': { label: '請購單號', prefix: 'MPO', color: 'text-orange-300' },
}

function refLabel(siteFilter: string): string {
  if (siteFilter in SITE_REF) return SITE_REF[siteFilter as SiteLabel].label
  return '製令/採購/請購號'
}

// ===== 主元件 =====
export default function SaraWipRecordsPage() {
  const [tab, setTab] = useState<'upload' | 'view'>('view')

  // --- 上傳狀態 ---
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<WipRecord[]>([])
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [importSiteLabel, setImportSiteLabel] = useState<SiteLabel>('台北')

  // --- 瀏覽狀態 ---
  const [records, setRecords] = useState<WipRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [wcFilter, setWcFilter] = useState('印刷站2F')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [siteFilter, setSiteFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50

  // --- 解析 CSV ---
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setImportMsg('')
    if (!f) { setPreview([]); return }
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const rows = parseWipCsv(text)
      setPreview(rows)
    }
    reader.readAsText(f, 'utf-8')
  }, [])

  // --- 匯入到 Supabase ---
  const handleImport = useCallback(async () => {
    if (preview.length === 0) return
    setImporting(true)
    setImportMsg('')
    try {
      // 以 work_order 去重（CSV 可能含重複行，後者覆蓋前者）
      const seen = new Map<string, typeof preview[0]>()
      for (const r of preview) seen.set(r.work_order, r)
      const deduped = Array.from(seen.values())

      const payload = deduped.map(r => ({
        id_list:             r.id_list || null,
        work_order:          r.work_order,
        mo_nbr:              r.mo_nbr || null,
        product_name:        r.product_name || null,
        product_subname:     r.product_subname || null,
        product_description: r.product_description || null,
        lot_nbr:             r.lot_nbr || null,
        doc_nbr:             r.doc_nbr || null,
        workcenter_name:     r.workcenter_name || null,
        job_name:            r.job_name || null,
        job_sequence:        r.job_sequence,
        status:              r.status || null,
        source_type:         r.source_type || null,
        wip_qty:             r.wip_qty,
        real_start_time:     r.real_start_time || null,
        real_end_time:       r.real_end_time || null,
        report_resources:    r.report_resources || null,
        username:            r.username || null,
        site_label:          importSiteLabel,
      }))

      const CHUNK = 200
      let upserted = 0
      for (let i = 0; i < payload.length; i += CHUNK) {
        const chunk = payload.slice(i, i + CHUNK)
        const { error } = await supabase
          .from('sara_wip_records')
          .upsert(chunk, { onConflict: 'work_order' })
        if (error) throw new Error(error.message ?? error.details ?? JSON.stringify(error))
        upserted += chunk.length
      }

      setImportMsg(`✅ 匯入完成：共 ${upserted} 筆（去重後，重複的已更新）`)
      setFile(null)
      setPreview([])
      if (tab === 'view') void fetchRecords()
    } catch (e) {
      const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? JSON.stringify(e)
      setImportMsg(`❌ 匯入失敗：${msg}`)
    } finally {
      setImporting(false)
    }
  }, [preview, tab, importSiteLabel])

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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        {/* 頁首 */}
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">塔台報工紀錄</h1>
            <p className="text-slate-400 text-sm mt-0.5">從 SARA 系統匯出的 CSV 定期更新・預設顯示印刷站2F</p>
          </div>
        </div>

        {/* 分頁標籤 */}
        <div className="flex gap-1 border-b border-slate-800">
          {([['view', '📋 瀏覽紀錄'], ['upload', '📤 匯入 CSV']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => { setTab(key); if (key === 'view') void fetchRecords() }}
              className={`px-4 py-2 text-sm rounded-t transition-colors ${tab === key ? 'bg-slate-800 text-white border-t border-x border-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ===== 匯入 CSV ===== */}
        {tab === 'upload' && (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 space-y-4">
              <h2 className="text-base font-semibold text-slate-200">上傳 SARA 報工 CSV</h2>
              <p className="text-slate-400 text-sm">
                從 SARA 系統匯出 <span className="font-mono text-amber-300">wip_record__*.csv</span>，
                以 <span className="text-cyan-300">work_order</span> 作為唯一鍵，重複匯入會自動更新。
              </p>
              <div className="flex items-center gap-3">
                <label className="text-sm text-slate-400 whitespace-nowrap">廠區標籤</label>
                {SITE_OPTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => setImportSiteLabel(s)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                      importSiteLabel === s
                        ? SITE_BADGE[s] + ' ring-2 ring-offset-1 ring-offset-slate-900 ring-current'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {s}
                  </button>
                ))}
                <span className="text-slate-500 text-xs">此次匯入的所有紀錄將標記為「{importSiteLabel}」</span>
              </div>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="block text-sm text-slate-400 file:mr-3 file:px-3 file:py-1.5 file:rounded file:bg-slate-700 file:border-slate-600 file:text-slate-200 file:text-sm hover:file:bg-slate-600 cursor-pointer"
              />

              {preview.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="text-slate-300 text-sm">解析到 <span className="font-mono text-cyan-300">{preview.length}</span> 筆資料</span>
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${SITE_BADGE[importSiteLabel]}`}>{importSiteLabel}</span>
                    <button
                      onClick={() => void handleImport()}
                      disabled={importing}
                      className="px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
                    >
                      {importing ? '匯入中…' : '確認匯入'}
                    </button>
                  </div>

                  {/* 預覽前 10 筆 */}
                  <div className="overflow-x-auto rounded-lg border border-slate-700">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-800 text-slate-300">
                        <tr>
                          <th className="px-3 py-2 text-left whitespace-nowrap">{refLabel(importSiteLabel)}</th>
                          <th className="px-3 py-2 text-left whitespace-nowrap">來源單號</th>
                          <th className="px-3 py-2 text-left whitespace-nowrap">站點</th>
                          <th className="px-3 py-2 text-left whitespace-nowrap">製程</th>
                          <th className="px-3 py-2 text-right whitespace-nowrap">數量</th>
                          <th className="px-3 py-2 text-left whitespace-nowrap">狀態</th>
                          <th className="px-3 py-2 text-left whitespace-nowrap">報工結束</th>
                          <th className="px-3 py-2 text-left whitespace-nowrap">人員</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.slice(0, 10).map((r, i) => (
                          <tr key={i} className={`border-t border-slate-800 ${i % 2 === 0 ? '' : 'bg-slate-800/30'}`}>
                            <td className="px-3 py-1.5 font-mono text-cyan-300">{r.mo_nbr}</td>
                            <td className="px-3 py-1.5 font-mono text-amber-300/80">{r.doc_nbr}</td>
                            <td className="px-3 py-1.5 text-slate-300">{r.workcenter_name}</td>
                            <td className="px-3 py-1.5 text-slate-300">{r.job_name}</td>
                            <td className="px-3 py-1.5 text-right font-mono text-emerald-300">{r.wip_qty ?? '—'}</td>
                            <td className="px-3 py-1.5">
                              <span className={STATUS_COLOR[r.status] ?? 'text-slate-400'}>{STATUS_LABEL[r.status] ?? r.status}</span>
                            </td>
                            <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{r.real_end_time?.slice(0, 16) ?? '—'}</td>
                            <td className="px-3 py-1.5 text-slate-400">{r.username}</td>
                          </tr>
                        ))}
                        {preview.length > 10 && (
                          <tr>
                            <td colSpan={8} className="px-3 py-2 text-center text-slate-500 text-xs">…共 {preview.length} 筆，僅顯示前 10 筆預覽</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {importMsg && (
                <p className={`text-sm ${importMsg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{importMsg}</p>
              )}
            </div>
          </div>
        )}

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
                <p className="text-slate-500 text-xs">請先至「匯入 CSV」分頁上傳報工資料，或調整篩選條件</p>
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
      </div>
    </div>
  )
}
