'use client'

// 塔台異常回報（前台）——印刷現場用。
//
// 不設功能權限：誰在塔台上看到工序不對，誰就回報（只要求登入，才知道是誰報的）。
// 流程比照產期詢問記錄的前台：現場登記 → 後台（生管）處理完標記已完成。
//
// 輸入銷售單號＋序號後，會自動帶出該品項「目前在交換區的工序」——那就是塔台
// 螢幕上現在顯示的內容，現場看到什麼、這裡就顯示什麼，不用自己抄。
// 回報當下會把那組工序存成快照：生管處理方式通常是改單，改完舊工序就沒了，
// 沒有快照事後會看不出當初現場到底看到什麼。

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Op { seq: string; workcenter: string; job_name: string; job_qty: string; est_time: string }
interface LookupItem {
  order_number: string
  mfg_order_number: string
  product_name: string
  product_desc: string
  lot_number: string
  factory: string
  qty: string
  due: string
  ops: Op[]
}
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
  reporter_email: string | null
  created_at: string
}

const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外', S: '集單' }
const fmt = (s: string | null) =>
  s ? new Date(s).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—'

export default function SaraAnomalyPage() {
  const router = useRouter()
  const [me, setMe] = useState<{ email: string; real_name?: string } | null>(null)
  const [checking, setChecking] = useState(true)

  const [orderNo, setOrderNo] = useState('')
  const [lineSeq, setLineSeq] = useState('')
  const [looking, setLooking] = useState(false)
  const [lookupMsg, setLookupMsg] = useState('')
  const [items, setItems] = useState<LookupItem[]>([])
  const [picked, setPicked] = useState<LookupItem | null>(null)

  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState('')

  const [reports, setReports] = useState<Report[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [editId, setEditId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.status === 401) { router.replace('/login'); return }
        const j = await res.json() as { email?: string; real_name?: string }
        setMe({ email: j.email ?? '', real_name: j.real_name })
      } catch { /* 靜默：下面的送出仍會由伺服器擋 */ }
      finally { setChecking(false) }
    })()
  }, [router])

  const loadReports = useCallback(async () => {
    try {
      const res = await fetch('/api/sara/anomaly?limit=100', { cache: 'no-store' })
      const j = await res.json() as { success: boolean; reports?: Report[] }
      if (j.success) setReports(j.reports ?? [])
    } catch { /* 列表載不出來不影響回報 */ }
  }, [])
  useEffect(() => { void loadReports() }, [loadReports])

  // ── 帶出交換區資訊 ──
  const handleLookup = useCallback(async () => {
    const o = orderNo.trim()
    if (!o) return
    setLooking(true); setLookupMsg(''); setItems([]); setPicked(null)
    try {
      const qs = new URLSearchParams({ order_no: o })
      if (lineSeq.trim()) qs.set('line_seq', lineSeq.trim())
      const res = await fetch(`/api/sara/anomaly/lookup?${qs}`, { cache: 'no-store' })
      const j = await res.json() as { success: boolean; items?: LookupItem[]; seq_matched?: boolean | null; error?: string }
      if (!j.success) throw new Error(j.error)
      const list = j.items ?? []
      if (list.length === 0) {
        setLookupMsg(`⚠️ 交換區裡找不到「${o}」的工序——可能還沒轉單，或已經被塔台處理完移除`)
        return
      }
      setItems(list)
      if (list.length === 1) setPicked(list[0])
      if (lineSeq.trim() && j.seq_matched === false) {
        setLookupMsg(`序號 ${lineSeq.trim()} 對不到，以下列出這張單的全部 ${list.length} 個品項，請點選正確的那一個`)
      }
    } catch (e) {
      setLookupMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLooking(false)
    }
  }, [orderNo, lineSeq])

  const handleSubmit = async () => {
    if (!reason.trim()) { alert('請填寫異常原因'); return }
    if (!orderNo.trim()) { alert('請填寫銷售單號'); return }
    setSubmitting(true); setMsg('')
    try {
      const res = await fetch('/api/sara/anomaly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_no: orderNo.trim(),
          line_seq: lineSeq.trim() || null,
          mfg_order_number: picked?.mfg_order_number ?? null,
          product_name: picked?.product_name ?? null,
          product_desc: picked?.product_desc ?? null,
          factory: picked?.factory ?? null,
          snapshot: picked?.ops ?? [],
          reason: reason.trim(),
        }),
      })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setMsg('✅ 已回報，生管會處理')
      setReason(''); setItems([]); setPicked(null); setOrderNo(''); setLineSeq(''); setLookupMsg('')
      await loadReports()
      setTimeout(() => setMsg(''), 5000)
    } catch (e) {
      setMsg(`❌ 回報失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  const saveEdit = async (id: number) => {
    if (!editText.trim()) { alert('異常原因不可為空'); return }
    try {
      const res = await fetch('/api/sara/anomaly', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, reason: editText.trim() }),
      })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setEditId(null); setEditText('')
      await loadReports()
    } catch (e) {
      alert(`修改失敗：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (checking) {
    return <div className="min-h-screen bg-[#050b14] flex items-center justify-center">
      <div className="text-orange-400 font-mono text-sm animate-pulse">載入中…</div>
    </div>
  }

  const inputCls = 'px-3 py-2.5 rounded-lg bg-[#08101c] border border-[#1e2a3f] text-white text-base focus:outline-none focus:border-orange-500/70'
  const pending = reports.filter(r => r.status === '待處理')

  const opTable = (ops: Op[]) => (
    <div className="rounded-lg border border-[#1c2739] overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-[#101a2c] text-[#7f93b3]">
          <tr>
            <th className="text-left px-3 py-1.5 w-16">工序</th>
            <th className="text-left px-3 py-1.5 w-32">站點</th>
            <th className="text-left px-3 py-1.5">製程名稱</th>
            <th className="text-right px-3 py-1.5 w-20">數量</th>
            <th className="text-right px-3 py-1.5 w-24">預估工時</th>
          </tr>
        </thead>
        <tbody>
          {ops.map((o, i) => (
            <tr key={i} className="border-t border-[#1c2739]">
              <td className="px-3 py-1.5 font-mono text-[#7f93b3]">{o.seq}</td>
              <td className="px-3 py-1.5 text-[#b7c4da]">{o.workcenter}</td>
              <td className="px-3 py-1.5 text-white">{o.job_name}</td>
              <td className="px-3 py-1.5 text-right font-mono text-[#7f93b3]">{o.job_qty}</td>
              <td className="px-3 py-1.5 text-right font-mono text-[#7f93b3]">{o.est_time}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#050b14] text-white p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <button onClick={() => router.push('/')}
          className="mb-4 text-xs font-mono text-[#5f7290] hover:text-white transition-colors">← 返回首頁</button>

        <div className="mb-6">
          <h1 className="text-2xl font-bold">塔台異常回報</h1>
          <p className="text-[#7f93b3] text-sm mt-1">
            在塔台上看到工序不對（途程錯、站點錯、數量對不上…）就在這裡回報，生管處理完會標記已完成。
            {me?.real_name && <span className="ml-2 text-[#5f7290]">目前登入：{me.real_name}</span>}
          </p>
        </div>

        {/* 回報表單 */}
        <div className="rounded-[14px] border border-orange-800/40 bg-orange-950/10 p-5 space-y-4 mb-8">
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label className="block text-[11px] text-[#5f7290] mb-1">銷售單號 *</label>
              <input value={orderNo} onChange={e => setOrderNo(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleLookup() }}
                placeholder="例：SO260901015" className={`${inputCls} w-56 font-mono`} />
            </div>
            <div>
              <label className="block text-[11px] text-[#5f7290] mb-1">序號</label>
              <input value={lineSeq} onChange={e => setLineSeq(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleLookup() }}
                placeholder="例：2" className={`${inputCls} w-24 font-mono`} />
            </div>
            <button onClick={() => void handleLookup()} disabled={looking || !orderNo.trim()}
              className="px-5 py-2.5 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-bold transition-colors">
              {looking ? '查詢中…' : '帶出塔台資料'}
            </button>
          </div>
          {lookupMsg && <div className="text-xs text-amber-400">{lookupMsg}</div>}

          {/* 多個品項時讓現場點選 */}
          {items.length > 1 && (
            <div className="flex flex-col gap-1.5">
              {items.map((it, i) => (
                <button key={i} onClick={() => setPicked(it)}
                  className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                    picked === it ? 'bg-orange-900/40 border-orange-600 text-white' : 'bg-[#0b1220] border-[#1c2739] text-[#b7c4da] hover:border-[#334a6b]'
                  }`}>
                  <span className="font-mono">{it.mfg_order_number}</span>
                  <span className="mx-2 text-[#5f7290]">|</span>
                  <span className="font-mono">{it.product_name}</span>
                  <span className="mx-2 text-[#5f7290]">|</span>
                  <span>{it.ops.length} 道工序</span>
                  {it.lot_number && <><span className="mx-2 text-[#5f7290]">|</span><span>批號 {it.lot_number}</span></>}
                </button>
              ))}
            </div>
          )}

          {/* 帶出的塔台現況 */}
          {picked && (
            <div className="rounded-lg border border-[#1c2739] bg-[#080e18] p-4 space-y-3">
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                <span className="text-[#5f7290]">工單號 <span className="text-white font-mono ml-1">{picked.mfg_order_number}</span></span>
                <span className="text-[#5f7290]">品號 <span className="text-white font-mono ml-1">{picked.product_name}</span></span>
                <span className="text-[#5f7290]">數量 <span className="text-white ml-1">{picked.qty}</span></span>
                <span className="text-[#5f7290]">需求日 <span className="text-white ml-1">{picked.due}</span></span>
                <span className="text-[#5f7290]">廠區 <span className="text-white ml-1">{FACTORY_LABEL[picked.factory] ?? '—'}</span></span>
              </div>
              {picked.product_desc && <div className="text-xs text-[#b7c4da]">{picked.product_desc}</div>}
              <div>
                <div className="text-[11px] text-[#5f7290] mb-1.5">目前塔台上的工序（{picked.ops.length} 道）</div>
                {opTable(picked.ops)}
              </div>
            </div>
          )}

          <div>
            <label className="block text-[11px] text-[#5f7290] mb-1">異常原因 *</label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={4}
              placeholder="例：途程錯了，這個要走雷切不是貼合；或：工序 2 的站點應該是印刷站6F"
              className={`${inputCls} w-full resize-y`} />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => void handleSubmit()} disabled={submitting || !reason.trim() || !orderNo.trim()}
              className="px-6 py-2.5 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-base font-bold transition-colors">
              {submitting ? '送出中…' : '送出回報'}
            </button>
            {!picked && orderNo.trim() && (
              <span className="text-[11px] text-[#5f7290]">沒有帶出塔台資料也可以送出，生管會自己查</span>
            )}
            {msg && <span className={`text-sm ${msg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{msg}</span>}
          </div>
        </div>

        {/* 回報紀錄 */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-[#b7c4da]">
            回報紀錄
            {pending.length > 0 && <span className="ml-2 text-amber-400">{pending.length} 筆待處理</span>}
          </h2>
          <button onClick={() => void loadReports()} className="text-xs text-[#5f7290] hover:text-white">重新整理</button>
        </div>

        <div className="flex flex-col gap-2">
          {reports.length === 0 && (
            <div className="text-center py-10 text-[#5f7290] text-sm">還沒有任何回報</div>
          )}
          {reports.map(r => {
            const done = r.status === '已完成'
            const open = expandedId === r.id
            const mine = !!me?.email && me.email === r.reporter_email
            return (
              <div key={r.id} className={`rounded-[12px] border overflow-hidden ${done ? 'border-[#1c2739] bg-[#080e18] opacity-70' : 'border-amber-700/40 bg-amber-950/10'}`}>
                <button onClick={() => setExpandedId(open ? null : r.id)} className="w-full text-left px-4 py-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                      done ? 'border-[#26344a] text-[#5f7290]' : 'border-amber-500/40 text-amber-400'
                    }`}>{r.status}</span>
                    <span className="font-mono text-sm text-white">{r.order_no}</span>
                    {r.line_seq && <span className="font-mono text-xs text-[#7f93b3]">序號 {r.line_seq}</span>}
                    {r.product_name && <span className="font-mono text-xs text-[#7f93b3]">{r.product_name}</span>}
                    <span className="ml-auto text-[11px] text-[#5f7290]">{r.reporter_name || '—'}・{fmt(r.created_at)}</span>
                  </div>
                  <div className="text-sm text-[#e7edf5] mt-1.5 whitespace-pre-wrap break-words">{r.reason}</div>
                </button>

                {open && (
                  <div className="border-t border-[#1c2739] px-4 py-3 space-y-3">
                    {r.mfg_order_number && (
                      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                        <span className="text-[#5f7290]">工單號 <span className="text-white font-mono ml-1">{r.mfg_order_number}</span></span>
                        {r.factory && <span className="text-[#5f7290]">廠區 <span className="text-white ml-1">{FACTORY_LABEL[r.factory] ?? r.factory}</span></span>}
                      </div>
                    )}
                    {r.product_desc && <div className="text-xs text-[#b7c4da]">{r.product_desc}</div>}
                    {(r.snapshot?.length ?? 0) > 0 && (
                      <div>
                        <div className="text-[11px] text-[#5f7290] mb-1.5">回報當下塔台上的工序（快照）</div>
                        {opTable(r.snapshot)}
                      </div>
                    )}
                    {done && (
                      <div className="text-xs text-emerald-400">
                        ✅ 已完成・{r.resolved_by_name || '—'}・{fmt(r.resolved_at)}
                        {r.handled_note && <div className="text-[#b7c4da] mt-1 whitespace-pre-wrap">處理說明：{r.handled_note}</div>}
                      </div>
                    )}
                    {/* 未完成且是自己報的才可以更正（已完成就鎖起來） */}
                    {!done && mine && (
                      editId === r.id ? (
                        <div className="flex flex-col gap-2">
                          <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3}
                            className={`${inputCls} w-full text-sm resize-y`} />
                          <div className="flex gap-2">
                            <button onClick={() => void saveEdit(r.id)}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold border border-sky-500/40 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25">儲存</button>
                            <button onClick={() => { setEditId(null); setEditText('') }}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold border border-[#26344a] text-[#93a4c0] hover:bg-white/5">取消</button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => { setEditId(r.id); setEditText(r.reason) }}
                          className="text-xs text-sky-400 hover:text-sky-300 underline underline-offset-2">修改異常原因</button>
                      )
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
