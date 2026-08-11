'use client'

import Link from 'next/link'
import { useState } from 'react'

interface ApiResult {
  ok: boolean
  action: string
  elapsedMs?: number
  count?: number | null
  error?: string
  rawResult?: unknown
  message?: string
  hint?: string
}

// ── 結構化預覽元件 ──────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-1.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap border-b border-slate-700">{children}</th>
}
function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <td className={`px-3 py-1.5 text-xs border-b border-slate-800/60 ${mono ? 'font-mono' : ''}`}>{children}</td>
}

function PreviewResource({ data }: { data: unknown }) {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  type ResRow = { id: number; resource_name: string; resource_type: string; capacity_type: string; standard_capacity: number; disabled: boolean; job_name?: Array<{ id: number | null; job_name: string; type: string; line: string | null }>; events?: unknown[] }
  const arr = (data as { data?: ResRow[] })?.data ?? []
  if (!arr.length) return <div className="text-slate-500 text-xs">（無資料）</div>
  return (
    <div className="overflow-auto max-h-[500px] rounded border border-slate-700">
      <table className="w-full text-white border-collapse">
        <thead className="sticky top-0 bg-slate-900 z-10">
          <tr><Th>ID</Th><Th>資源名稱</Th><Th>類型</Th><Th>容量模式</Th><Th>容量</Th><Th>製程數</Th><Th>事件數</Th><Th>狀態</Th></tr>
        </thead>
        <tbody>
          {arr.map(r => {
            const nullJobs = (r.job_name ?? []).filter(j => j.id == null)
            const isOpen = expandedId === r.id
            return (
              <>
                <tr key={r.id} className={`cursor-pointer hover:bg-slate-800/50 ${isOpen ? 'bg-slate-800/40' : ''}`} onClick={() => setExpandedId(isOpen ? null : r.id)}>
                  <Td mono>{r.id}</Td>
                  <Td><span className="text-emerald-300">{r.resource_name}</span></Td>
                  <Td><span className="text-slate-300">{r.resource_type}</span></Td>
                  <Td><span className="text-slate-400">{r.capacity_type}</span></Td>
                  <Td mono>{r.standard_capacity}</Td>
                  <Td>
                    <span className={nullJobs.length ? 'text-amber-300' : 'text-slate-300'}>
                      {(r.job_name ?? []).length}
                      {nullJobs.length > 0 && <span className="ml-1 text-amber-400 text-[10px]">⚠ {nullJobs.length} null-id</span>}
                    </span>
                  </Td>
                  <Td><span className="text-slate-400">{(r.events ?? []).length}</span></Td>
                  <Td>
                    {r.disabled
                      ? <span className="px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 text-[10px] border border-red-700/40">停用</span>
                      : <span className="px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 text-[10px] border border-emerald-700/40">啟用</span>
                    }
                  </Td>
                </tr>
                {isOpen && (r.job_name ?? []).length > 0 && (
                  <tr key={`${r.id}-jobs`}>
                    <td colSpan={8} className="bg-slate-900/60 px-4 py-2">
                      <div className="text-[10px] text-slate-500 mb-1">製程能力 (job_name)</div>
                      <table className="w-full border-collapse">
                        <thead>
                          <tr><Th>job_id</Th><Th>製程名稱</Th><Th>類型</Th><Th>生產線</Th></tr>
                        </thead>
                        <tbody>
                          {(r.job_name ?? []).map((j, ji) => (
                            <tr key={ji} className={j.id == null ? 'bg-amber-950/30' : ''}>
                              <Td mono>{j.id == null ? <span className="text-amber-400">null ⚠</span> : j.id}</Td>
                              <Td>{j.job_name}</Td>
                              <Td><span className={j.type === 'primary' ? 'text-cyan-300' : 'text-slate-400'}>{j.type}</span></Td>
                              <Td>{j.line ?? <span className="text-slate-600">—</span>}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PreviewOrder({ data }: { data: unknown }) {
  type OrderRow = { mo_nbr: string; product_name?: string; lot_nbr?: string; doc_nbr?: string; required_qty?: number; due?: string; plan_start_time?: string; is_internal?: boolean }
  const arr = (data as { data?: OrderRow[] })?.data ?? []
  if (!arr.length) return <div className="text-slate-500 text-xs">（無資料）</div>
  return (
    <div className="overflow-auto max-h-[500px] rounded border border-slate-700">
      <table className="w-full text-white border-collapse">
        <thead className="sticky top-0 bg-slate-900 z-10">
          <tr><Th>#</Th><Th>製令號</Th><Th>品名</Th><Th>批號</Th><Th>單號</Th><Th>數量</Th><Th>交期</Th><Th>預計開工</Th></tr>
        </thead>
        <tbody>
          {arr.map((r, i) => (
            <tr key={r.mo_nbr} className="hover:bg-slate-800/50">
              <Td><span className="text-slate-600">{i + 1}</span></Td>
              <Td mono><span className="text-cyan-300">{r.mo_nbr}</span></Td>
              <Td>{r.product_name}</Td>
              <Td mono>{r.lot_nbr ?? <span className="text-slate-600">—</span>}</Td>
              <Td mono>{r.doc_nbr ?? <span className="text-slate-600">—</span>}</Td>
              <Td mono>{r.required_qty ?? <span className="text-slate-600">—</span>}</Td>
              <Td><span className="text-amber-300">{r.due?.slice(0, 10) ?? '—'}</span></Td>
              <Td>{r.plan_start_time?.slice(0, 10) ?? <span className="text-slate-600">—</span>}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PreviewWorkcenter({ data }: { data: unknown }) {
  type WcRow = { id: number; workcenter_name: string }
  const arr = (data as { data?: WcRow[] })?.data ?? []
  if (!arr.length) return <div className="text-slate-500 text-xs">（無資料）</div>
  return (
    <div className="overflow-auto max-h-[400px] rounded border border-slate-700">
      <table className="w-full text-white border-collapse">
        <thead className="sticky top-0 bg-slate-900 z-10">
          <tr><Th>ID</Th><Th>站點名稱</Th></tr>
        </thead>
        <tbody>
          {arr.map(r => (
            <tr key={r.id} className="hover:bg-slate-800/50">
              <Td mono>{r.id}</Td>
              <Td><span className="text-purple-300">{r.workcenter_name}</span></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PreviewJlb({ data }: { data: unknown }) {
  type JlbRow = { id: number; job_name: string; sourcing: string; est_time_mode: string; workcenter_id?: number; workcenter_name?: string }
  const arr = (data as { data?: JlbRow[] })?.data ?? []
  if (!arr.length) return <div className="text-slate-500 text-xs">（無資料）</div>
  return (
    <div className="overflow-auto max-h-[500px] rounded border border-slate-700">
      <table className="w-full text-white border-collapse">
        <thead className="sticky top-0 bg-slate-900 z-10">
          <tr><Th>ID</Th><Th>製程名稱</Th><Th>Sourcing</Th><Th>時間模式</Th><Th>站點 ID</Th><Th>站點名稱</Th></tr>
        </thead>
        <tbody>
          {arr.map(r => (
            <tr key={r.id} className="hover:bg-slate-800/50">
              <Td mono>{r.id}</Td>
              <Td><span className="text-teal-300">{r.job_name}</span></Td>
              <Td><span className="text-slate-400">{r.sourcing}</span></Td>
              <Td><span className="text-slate-400">{r.est_time_mode}</span></Td>
              <Td mono>{r.workcenter_id ?? <span className="text-slate-600">—</span>}</Td>
              <Td>{r.workcenter_name ?? <span className="text-slate-600">—</span>}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PreviewLotDetail({ data }: { data: unknown }) {
  type RouteRow = {
    mo_nbr?: string; lot_nbr?: string; seq?: number; job_name?: string
    workcenter_name?: string; plan_start?: string; plan_end?: string; qty?: number
    status?: string
    primary_resources?: unknown; assigned_resources?: unknown
  }

  function extractResourceName(r: unknown): string {
    if (!r) return '—'
    if (typeof r === 'string') return r
    if (Array.isArray(r)) {
      const names = r.map((item: unknown) => {
        if (typeof item === 'object' && item !== null) {
          const o = item as Record<string, unknown>
          return String(o.resource_name ?? o.name ?? o.id ?? '?')
        }
        return String(item)
      }).filter(Boolean)
      return names.join(', ') || '—'
    }
    if (typeof r === 'object') {
      const o = r as Record<string, unknown>
      return String(o.resource_name ?? o.name ?? o.id ?? JSON.stringify(r))
    }
    return String(r)
  }

  const arr = (data as { data?: RouteRow[] })?.data ?? []
  if (!arr.length) return <div className="text-slate-500 text-xs">（無資料）</div>
  return (
    <div className="overflow-auto max-h-[500px] rounded border border-slate-700">
      <table className="w-full text-white border-collapse">
        <thead className="sticky top-0 bg-slate-900 z-10">
          <tr>
            <Th>製令號</Th><Th>批號</Th><Th>Seq</Th><Th>製程</Th><Th>站點</Th>
            <Th>分配機台/資源</Th>
            <Th>預計開始</Th><Th>預計結束</Th><Th>數量</Th><Th>狀態</Th>
          </tr>
        </thead>
        <tbody>
          {arr.map((r, i) => {
            const resource = extractResourceName(r.assigned_resources ?? r.primary_resources)
            return (
              <tr key={i} className="hover:bg-slate-800/50">
                <Td mono><span className="text-cyan-300">{r.mo_nbr}</span></Td>
                <Td mono>{r.lot_nbr ?? '—'}</Td>
                <Td mono>{r.seq ?? '—'}</Td>
                <Td><span className="text-teal-300">{r.job_name}</span></Td>
                <Td>{r.workcenter_name}</Td>
                <Td>
                  {resource !== '—'
                    ? <span className="px-1.5 py-0.5 rounded bg-sky-900/50 border border-sky-700/50 text-sky-300 text-[11px] font-mono">{resource}</span>
                    : <span className="text-slate-600 text-xs">未排程</span>
                  }
                </Td>
                <Td>{r.plan_start?.slice(0, 16) ?? '—'}</Td>
                <Td>{r.plan_end?.slice(0, 16) ?? '—'}</Td>
                <Td mono>{r.qty ?? '—'}</Td>
                <Td>
                  {r.status
                    ? <span className={`text-[10px] px-1.5 py-0.5 rounded border ${r.status === 'done' ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40' : r.status === 'in_progress' ? 'bg-amber-900/40 text-amber-300 border-amber-700/40' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>{r.status}</span>
                    : <span className="text-slate-600 text-xs">—</span>
                  }
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PreviewReport({ data }: { data: unknown }) {
  type ReportRow = {
    report_id?: string | number
    mo_nbr?: string
    lot_nbr?: string
    item_no?: string
    product_name?: string
    job_name?: string
    resource_name?: string
    reported_qty?: number
    good_qty?: number
    ng_qty?: number
    started_on?: string
    ended_on?: string
    reported_at?: string
    operator_name?: string
    status?: string
  }
  const arr = (data as { data?: ReportRow[] })?.data ?? []
  if (!arr.length) return <div className="text-slate-500 text-xs">（無資料）</div>
  return (
    <div className="overflow-auto max-h-[500px] rounded border border-slate-700">
      <table className="w-full text-white border-collapse">
        <thead className="sticky top-0 bg-slate-900 z-10">
          <tr>
            <Th>#</Th><Th>報工單號</Th><Th>製令號</Th><Th>批號</Th><Th>品項</Th><Th>製程</Th><Th>資源</Th>
            <Th>報工數</Th><Th>良品</Th><Th>不良</Th><Th>開始</Th><Th>結束</Th><Th>報工時間</Th><Th>人員</Th><Th>狀態</Th>
          </tr>
        </thead>
        <tbody>
          {arr.map((r, i) => (
            <tr key={`${r.report_id ?? 'na'}-${i}`} className="hover:bg-slate-800/50">
              <Td>{i + 1}</Td>
              <Td mono>{r.report_id ?? '—'}</Td>
              <Td mono><span className="text-cyan-300">{r.mo_nbr ?? '—'}</span></Td>
              <Td mono>{r.lot_nbr ?? '—'}</Td>
              <Td mono>{r.item_no ?? '—'}</Td>
              <Td><span className="text-teal-300">{r.job_name ?? '—'}</span></Td>
              <Td>{r.resource_name ?? '—'}</Td>
              <Td mono>{r.reported_qty ?? '—'}</Td>
              <Td mono>{r.good_qty ?? '—'}</Td>
              <Td mono>{r.ng_qty ?? '—'}</Td>
              <Td>{r.started_on?.slice(0, 16) ?? '—'}</Td>
              <Td>{r.ended_on?.slice(0, 16) ?? '—'}</Td>
              <Td>{r.reported_at?.slice(0, 16) ?? '—'}</Td>
              <Td>{r.operator_name ?? '—'}</Td>
              <Td>{r.status ?? '—'}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StructuredPreview({ action, data }: { action: string; data: unknown }) {
  switch (action) {
    case 'resource':    return <PreviewResource data={data} />
    case 'order':       return <PreviewOrder data={data} />
    case 'report':      return <PreviewReport data={data} />
    case 'workcenter':  return <PreviewWorkcenter data={data} />
    case 'jlb':         return <PreviewJlb data={data} />
    case 'lot_detail':  return <PreviewLotDetail data={data} />
    default: return (
      <pre className="max-h-80 overflow-auto bg-slate-950 border border-slate-800 rounded p-2 text-[11px] text-slate-300">
        {JSON.stringify(data, null, 2)}
      </pre>
    )
  }
}

const ACTIONS: { key: string; label: string; desc: string; needsBody?: boolean; syncAction?: string }[] = [
  { key: 'ping',       label: '🔌 測試連線（取 api_key）', desc: 'POST /api/data_export/temp_token' },
  { key: 'order',      label: '📋 工單列表',             desc: '/data/order',     syncAction: 'sync_order' },
  { key: 'report',     label: '📝 報工列表',             desc: '/data/report（支援多路徑 fallback）',    syncAction: 'sync_report' },
  { key: 'workcenter', label: '🏭 站點列表',             desc: '/data/workcenter', syncAction: 'sync_workcenter' },
  { key: 'jlb',        label: '⚙️ 製程列表',             desc: '/data/jlb',        syncAction: 'sync_jlb' },
  { key: 'resource',   label: '🔧 資源列表',             desc: '/data/resource (含 events / job_name)', syncAction: 'sync_resource' },
  { key: 'lot_detail', label: '🧭 途程列表',             desc: '/data/lot_detail（需 items）', needsBody: true, syncAction: 'sync_lot_detail' },
]

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export default function SaraSyncPage() {
  const [results, setResults] = useState<Record<string, ApiResult>>({})
  const [loading, setLoading] = useState<string | null>(null)
  const [reportPathsText, setReportPathsText] = useState<string>([
    '/data/report',
    '/data/work_report',
    '/data/reports',
    '/data/workreport',
    '/data/report_list',
    '/data/reporting',
  ].join('\n'))
  const [reportBodyText, setReportBodyText] = useState<string>('{}')
  const [lotItems, setLotItems] = useState<string>(JSON.stringify([
    { mo_nbr: 'A001', product_name: 'P1', lot_nbr: 'L1' },
  ], null, 2))

  const reportBodyTemplates = (() => {
    const today = new Date()
    const from7 = new Date(today)
    from7.setDate(today.getDate() - 7)
    const from30 = new Date(today)
    from30.setDate(today.getDate() - 30)

    return [
      { label: '空參數 {}', value: {} },
      {
        label: 'date_from / date_to（近 7 天）',
        value: { date_from: formatDateOnly(from7), date_to: formatDateOnly(today) },
      },
      {
        label: 'start_date / end_date（近 30 天）',
        value: { start_date: formatDateOnly(from30), end_date: formatDateOnly(today) },
      },
      {
        label: 'from / to（近 7 天）',
        value: { from: formatDateOnly(from7), to: formatDateOnly(today) },
      },
      {
        label: 'started_on / ended_on（完整時間）',
        value: {
          started_on: `${formatDateOnly(from7)}T00:00:00`,
          ended_on: `${formatDateOnly(today)}T23:59:59`,
        },
      },
    ]
  })()

  const callApi = async (action: string, isSync = false) => {
    const stateKey = isSync ? `sync:${action}` : action
    setLoading(stateKey)
    try {
      let body: unknown = {}
      if (action === 'lot_detail' || action === 'sync_lot_detail') {
        try {
          const items = JSON.parse(lotItems)
          body = { items }
        } catch {
          setResults(prev => ({ ...prev, [stateKey]: { ok: false, action, error: 'items JSON 格式錯誤' } }))
          return
        }
      }
      if (action === 'report' || action === 'sync_report') {
        const reportPaths = reportPathsText
          .split(/[\r\n,]+/)
          .map(s => s.trim())
          .filter(Boolean)
        let reportBody: unknown = {}
        try {
          reportBody = reportBodyText.trim() ? JSON.parse(reportBodyText) : {}
        } catch {
          setResults(prev => ({ ...prev, [stateKey]: { ok: false, action, error: '報工 request body JSON 格式錯誤' } }))
          return
        }
        body = { reportPaths, reportBody }
      }

      const res = await fetch('/api/sara', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, body }),
      })
      const json = await res.json().catch(() => ({}))
      setResults(prev => ({
        ...prev,
        [stateKey]: {
          ok: !!json.ok,
          action,
          elapsedMs: json.elapsedMs,
          count: json.count,
          error: json.error,
          message: json.message,
          hint: json.hint,
          rawResult: json.result ?? null,
        },
      }))
    } catch (e) {
      setResults(prev => ({
        ...prev,
        [stateKey]: { ok: false, action, error: e instanceof Error ? e.message : String(e) },
      }))
    } finally {
      setLoading(null)
    }
  }

  const syncAll = async () => {
    for (const a of ACTIONS) {
      if (!a.syncAction || a.key === 'lot_detail') continue // 途程需要 items 不自動跑
      await callApi(a.syncAction, true)
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="border-b border-slate-800/60 bg-slate-900/60 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-emerald-300">塔台 SARA · 同步區</h1>
          <p className="text-sm text-slate-400 mt-1">與 SARA Factory API 的連線測試與資料抓取面板</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/sara/schema"
            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm border border-slate-600"
          >
            📋 欄位檢視
          </Link>
          <Link
            href="/admin"
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm border border-slate-700"
          >
            ← 返回管理首頁
          </Link>
        </div>
      </div>

      <div className="p-6 max-w-6xl space-y-6">
        <div className="flex justify-end">
          <button
            onClick={syncAll}
            disabled={!!loading}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold"
          >
            {loading?.startsWith('sync:') ? '同步進行中…' : '🚀 一鍵同步全部（不含途程）'}
          </button>
        </div>
        {/* 環境變數提示 */}
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 text-sm">
          <div className="font-semibold text-amber-300 mb-1">⚙️ 環境變數設定</div>
          <p className="text-slate-300 leading-relaxed">
            請在 <code className="px-1 bg-slate-800 rounded">.env.local</code> 設定：
          </p>
          <pre className="mt-2 bg-slate-900 rounded p-3 text-xs text-emerald-200 overflow-x-auto">
SARA_CLIENT_SECRET=你的_client_secret
# 可選，預設即為下方網址
SARA_BASE_URL=https://sara-factory.com/api/data_export
          </pre>
          <p className="text-slate-400 mt-2 text-xs">
            client_secret 請至 SARA 系統產生或聯絡塔台同仁。設定後重新啟動 dev server 即可。
          </p>
        </div>

        <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 p-4 text-sm">
          <div className="font-semibold text-sky-300 mb-2">🧪 報工端點測試參數（本頁即時生效）</div>
          <p className="text-slate-300 text-xs mb-2">可直接輸入候選路徑與 request body，不需重啟服務。按「報工列表」的預覽/同步入庫會使用這裡的值。</p>
          <div className="mb-3 flex flex-wrap gap-2">
            {reportBodyTemplates.map(t => (
              <button
                key={t.label}
                type="button"
                onClick={() => setReportBodyText(JSON.stringify(t.value, null, 2))}
                className="px-2.5 py-1 rounded border border-sky-700/60 bg-sky-900/30 hover:bg-sky-800/40 text-[11px] text-sky-100"
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400">候選路徑（每行一個，或逗號分隔）</label>
              <textarea
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded p-2 text-xs font-mono"
                rows={7}
                value={reportPathsText}
                onChange={e => setReportPathsText(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-slate-400">報工 request body（JSON）</label>
              <textarea
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded p-2 text-xs font-mono"
                rows={7}
                value={reportBodyText}
                onChange={e => setReportBodyText(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* 動作按鈕區 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ACTIONS.map(a => {
            const r = results[a.key]
            const sr = a.syncAction ? results[`sync:${a.syncAction}`] : undefined
            const busy = loading === a.key
            const syncBusy = a.syncAction ? loading === `sync:${a.syncAction}` : false
            return (
              <div
                key={a.key}
                className={`rounded-xl border p-4 transition ${
                  r?.ok ? 'border-emerald-500/40 bg-emerald-950/20'
                  : r && !r.ok ? 'border-rose-500/40 bg-rose-950/20'
                  : 'border-slate-700 bg-slate-900/40'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="font-semibold">{a.label}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{a.desc}</div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => callApi(a.key)}
                      disabled={busy || syncBusy}
                      className="px-3 py-1.5 rounded-lg text-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="呼叫 API 並預覽回應"
                    >
                      {busy ? '預覽中…' : '預覽'}
                    </button>
                    {a.syncAction && (
                      <button
                        onClick={() => callApi(a.syncAction!, true)}
                        disabled={busy || syncBusy}
                        className="px-3 py-1.5 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="呼叫 API 並寫入 Supabase"
                      >
                        {syncBusy ? '入庫中…' : '同步入庫'}
                      </button>
                    )}
                  </div>
                </div>

                {a.needsBody && (
                  <div className="mt-2">
                    <label className="text-xs text-slate-400">items（JSON 陣列）</label>
                    <textarea
                      className="w-full mt-1 bg-slate-950 border border-slate-700 rounded p-2 text-xs font-mono"
                      rows={5}
                      value={lotItems}
                      onChange={e => setLotItems(e.target.value)}
                    />
                  </div>
                )}

                {sr && (
                  <div className="mt-3 text-xs">
                    {sr.ok ? (
                      <div className="text-emerald-300">
                        🗄️ 入庫成功 · {sr.elapsedMs}ms{sr.count != null ? ` · ${sr.count} 筆` : ''}
                        {sr.message ? ` · ${sr.message}` : ''}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="text-rose-300 break-all">🗄️ 入庫失敗：{sr.error}</div>
                        {sr.hint && <div className="text-amber-300 break-all">💡 {sr.hint}</div>}
                        {sr.error?.includes('找不到可用的報工端點') && (
                          <div className="text-slate-400 break-all">
                            可在 .env.local 設定：SARA_REPORT_PATHS=/實際路徑A,/實際路徑B（重啟服務後生效）
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {r && (
                  <div className="mt-3 text-xs">
                    {r.ok ? (
                      <div className="text-emerald-300">
                        ✓ 預覽成功 · {r.elapsedMs}ms{r.count != null ? ` · ${r.count} 筆` : ''}
                      </div>
                    ) : (
                      <div className="text-rose-300 break-all">✗ {r.error}</div>
                    )}
                    {r.rawResult != null && (
                      <div className="mt-2">
                        <StructuredPreview action={a.key} data={r.rawResult} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </main>
  )
}
