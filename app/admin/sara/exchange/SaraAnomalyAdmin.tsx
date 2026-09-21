'use client'

// 塔台異常回報（後台）——生管處理現場回報的地方。
//
// 刻意放在交換區頁面、改單面板的正上方：現場回報的異常，處理方式十之八九就是
// 「把這個品項的工序改掉」，所以每一筆都附一顆「帶入改單」，直接把單號/序號
// 送進下方的改單面板並自動查詢，生管不用再手抄一次單號。
// 改完回來按「已完成」，整條處理動線在同一頁走完。

import { useCallback, useEffect, useState } from 'react'

interface Op { seq: string; workcenter: string; job_name: string; job_qty: string; est_time: string }
interface Report {
  id: number
  order_no: string
  line_seq: string | null
  mfg_order_number: string | null
  product_name: string | null
  product_desc: string | null
  factory: string | null
  snapshot: Op[]
  reason: string
  status: string
  handled_note: string | null
  resolved_at: string | null
  resolved_by_name: string | null
  reporter_name: string | null
  created_at: string
}

const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外', S: '集單' }
const fmt = (s: string | null) =>
  s ? new Date(s).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—'

export default function SaraAnomalyAdmin(
  { onPickForChange }: { onPickForChange: (order: string, seq: string) => void }
) {
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({})
  const [busyId, setBusyId] = useState<number | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/sara/anomaly?limit=200', { cache: 'no-store' })
      const j = await res.json() as { success: boolean; reports?: Report[]; error?: string }
      if (!j.success) throw new Error(j.error)
      setReports(j.reports ?? [])
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const setStatus = async (r: Report, resolve: boolean) => {
    if (resolve && !confirm(`確定將 ${r.order_no}${r.line_seq ? `／序號 ${r.line_seq}` : ''} 這筆異常標記為已完成？`)) return
    setBusyId(r.id); setMsg('')
    try {
      const res = await fetch('/api/sara/anomaly', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: r.id,
          action: resolve ? 'resolve' : 'reopen',
          handled_note: resolve ? (noteDrafts[r.id] ?? '').trim() || null : null,
        }),
      })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setMsg(resolve ? '✅ 已標記完成' : '✅ 已重新開啟')
      await load()
      setTimeout(() => setMsg(''), 3000)
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusyId(null) }
  }

  const pending = reports.filter(r => r.status === '待處理')
  const shown = showDone ? reports : pending

  return (
    <div className="mb-6 rounded-xl border border-amber-800/40 bg-amber-950/20 p-5 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold text-amber-300">
            🚨 塔台異常回報
            {pending.length > 0 && <span className="ml-2 text-rose-400">{pending.length} 筆待處理</span>}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            印刷現場回報的工序異常。處理方式多半是改單——按「帶入改單」會把單號直接送進下方的改單面板。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className={`text-xs ${msg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{msg}</span>}
          <button onClick={() => setShowDone(v => !v)}
            className="px-3 py-1.5 rounded text-xs border border-slate-700 bg-slate-900 text-slate-400 hover:text-white transition-colors">
            {showDone ? '只看待處理' : `顯示已完成（${reports.length - pending.length}）`}
          </button>
          <button onClick={() => void load()} disabled={loading}
            className="px-3 py-1.5 rounded text-xs border border-slate-700 bg-slate-900 text-slate-400 hover:text-white disabled:opacity-50 transition-colors">
            {loading ? '載入中…' : '重新整理'}
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="text-xs text-slate-600 py-4 text-center">
          {loading ? '載入中…' : showDone ? '沒有任何回報' : '目前沒有待處理的異常 👍'}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map(r => {
            const done = r.status === '已完成'
            const open = expandedId === r.id
            return (
              <div key={r.id} className={`rounded-lg border overflow-hidden ${done ? 'border-slate-800 bg-slate-900/40 opacity-70' : 'border-amber-700/40 bg-slate-900/60'}`}>
                <div className="px-3.5 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                      done ? 'border-slate-700 text-slate-500' : 'border-amber-500/40 text-amber-400'
                    }`}>{r.status}</span>
                    <span className="font-mono text-sm text-white">{r.order_no}</span>
                    {r.line_seq && <span className="font-mono text-xs text-slate-400">序號 {r.line_seq}</span>}
                    {r.mfg_order_number && <span className="font-mono text-xs text-slate-400">{r.mfg_order_number}</span>}
                    {r.product_name && <span className="font-mono text-xs text-slate-300">{r.product_name}</span>}
                    {r.factory && <span className="text-xs text-slate-500">{FACTORY_LABEL[r.factory] ?? r.factory}</span>}
                    <span className="ml-auto text-[11px] text-slate-500">{r.reporter_name || '—'}・{fmt(r.created_at)}</span>
                  </div>

                  <div className="text-sm text-white mt-1.5 whitespace-pre-wrap break-words">{r.reason}</div>

                  <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                    {!done && (
                      <button
                        onClick={() => onPickForChange(r.order_no, r.line_seq ?? '')}
                        className="px-3 py-1.5 rounded text-xs font-bold bg-rose-700 hover:bg-rose-600 text-white transition-colors"
                        title="把單號帶進下方的改單面板並自動查詢"
                      >🔁 帶入改單</button>
                    )}
                    <button onClick={() => setExpandedId(open ? null : r.id)}
                      className="px-3 py-1.5 rounded text-xs border border-slate-700 text-slate-400 hover:text-white transition-colors">
                      {open ? '收合' : '回報當下的工序'}
                    </button>
                    {!done ? (
                      <>
                        <input
                          value={noteDrafts[r.id] ?? ''}
                          onChange={e => setNoteDrafts(p => ({ ...p, [r.id]: e.target.value }))}
                          placeholder="處理說明（選填）"
                          className="flex-1 min-w-[12rem] px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-white text-xs focus:outline-none focus:border-emerald-500"
                        />
                        <button onClick={() => void setStatus(r, true)} disabled={busyId === r.id}
                          className="px-4 py-1.5 rounded text-xs font-bold bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white transition-colors">
                          {busyId === r.id ? '處理中…' : '✔ 已完成'}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="text-[11px] text-emerald-400">
                          ✅ {r.resolved_by_name || '—'}・{fmt(r.resolved_at)}
                          {r.handled_note && <span className="text-slate-400 ml-2">{r.handled_note}</span>}
                        </span>
                        <button onClick={() => void setStatus(r, false)} disabled={busyId === r.id}
                          className="ml-auto px-3 py-1.5 rounded text-xs border border-slate-700 text-slate-500 hover:text-slate-300 disabled:opacity-50 transition-colors">
                          重新開啟
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {open && (
                  <div className="border-t border-slate-800 px-3.5 py-2.5">
                    {r.product_desc && <div className="text-xs text-slate-400 mb-2">{r.product_desc}</div>}
                    {(r.snapshot?.length ?? 0) === 0 ? (
                      <div className="text-xs text-slate-600">回報時沒有帶出塔台資料（可能當時交換區裡沒有這個品項）</div>
                    ) : (
                      <div className="rounded border border-slate-800 overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-slate-900/80 text-slate-500">
                            <tr>
                              <th className="text-left px-3 py-1.5 w-16">工序</th>
                              <th className="text-left px-3 py-1.5 w-32">站點</th>
                              <th className="text-left px-3 py-1.5">製程名稱</th>
                              <th className="text-right px-3 py-1.5 w-20">數量</th>
                              <th className="text-right px-3 py-1.5 w-24">預估工時</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.snapshot.map((o, i) => (
                              <tr key={i} className="border-t border-slate-800">
                                <td className="px-3 py-1.5 font-mono text-slate-400">{o.seq}</td>
                                <td className="px-3 py-1.5 text-slate-300">{o.workcenter}</td>
                                <td className="px-3 py-1.5 text-white">{o.job_name}</td>
                                <td className="px-3 py-1.5 text-right font-mono text-slate-400">{o.job_qty}</td>
                                <td className="px-3 py-1.5 text-right font-mono text-slate-400">{o.est_time}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="text-[11px] text-slate-600 px-3 py-1.5">
                          這是回報當下的快照——改單後交換區的內容會變，這份不會。
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
