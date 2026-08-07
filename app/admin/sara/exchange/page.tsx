'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

interface ExchangeRow {
  id: number
  data_type: string
  ref_key: string | null
  payload: unknown
  status: 'pending' | 'consumed'
  note: string | null
  created_at: string
  consumed_at: string | null
  expires_at: string | null
}

const STATUS_BADGE: Record<string, string> = {
  pending:  'bg-amber-900/40 text-amber-300 border-amber-700/50',
  consumed: 'bg-slate-800 text-slate-400 border-slate-700',
}

export default function SaraExchangePage() {
  const [rows, setRows]         = useState<ExchangeRow[]>([])
  const [loading, setLoading]   = useState(false)
  const [statusFilter, setStatusFilter] = useState<'pending' | 'consumed' | 'all'>('all')
  const [typeFilter, setTypeFilter]     = useState('')
  const [total, setTotal]       = useState(0)

  // 新增表單
  const [showAdd, setShowAdd]   = useState(false)
  const [addType, setAddType]   = useState('')
  const [addRef, setAddRef]     = useState('')
  const [addNote, setAddNote]   = useState('')
  const [addPayload, setAddPayload] = useState('{}')
  const [addMsg, setAddMsg]     = useState('')
  const [adding, setAdding]     = useState(false)

  // 選取刪除
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [delMsg, setDelMsg]     = useState('')

  const [expandedId, setExpandedId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      let q = supabase
        .from('sara_exchange')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(200)
      if (statusFilter !== 'all') q = q.eq('status', statusFilter)
      if (typeFilter.trim()) q = q.ilike('data_type', `%${typeFilter.trim()}%`)
      const { data, count, error } = await q
      if (error) throw error
      setRows((data ?? []) as ExchangeRow[])
      setTotal(count ?? 0)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, typeFilter])

  useEffect(() => { void load() }, [load])

  const handleAdd = async () => {
    if (!addType.trim()) { setAddMsg('❌ 請填寫資料類型'); return }
    let parsed: unknown
    try { parsed = JSON.parse(addPayload) } catch { setAddMsg('❌ Payload 不是合法 JSON'); return }
    setAdding(true); setAddMsg('')
    try {
      const res = await fetch('/api/sara/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data_type: addType.trim(), ref_key: addRef.trim() || undefined, payload: parsed, note: addNote.trim() || undefined }),
      })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setAddMsg('✅ 已新增')
      setAddType(''); setAddRef(''); setAddNote(''); setAddPayload('{}')
      setShowAdd(false)
      void load()
    } catch (e) {
      setAddMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setAdding(false) }
  }

  const handleDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`確定刪除 ${selected.size} 筆？`)) return
    setDeleting(true); setDelMsg('')
    try {
      const res = await fetch('/api/sara/exchange', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] }),
      })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setDelMsg(`✅ 已刪除 ${selected.size} 筆`)
      setSelected(new Set())
      void load()
    } catch (e) {
      setDelMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setDeleting(false) }
  }

  const handleClearConsumed = async () => {
    if (!confirm('確定清除所有 consumed 的資料？')) return
    setDeleting(true)
    try {
      await fetch('/api/sara/exchange', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'consumed' }),
      })
      void load()
    } finally { setDeleting(false) }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-domain.vercel.app'
  const apiUrl = `${origin}/api/sara/exchange`

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold">SARA 資料交換區</h1>
          <p className="text-slate-400 text-sm mt-1">將轉換後的塔台格式資料放入此區，塔台透過 API Key 呼叫端口拉取</p>
        </div>

        {/* API 端口說明卡片 */}
        <div className="mb-6 rounded-xl border border-cyan-800/40 bg-cyan-950/20 p-5">
          <h2 className="text-sm font-semibold text-cyan-300 mb-3">📡 塔台呼叫端口</h2>
          <div className="space-y-3 text-xs">
            <div>
              <span className="text-slate-400">端口 URL：</span>
              <code className="ml-2 px-2 py-0.5 rounded bg-slate-900 text-cyan-200 font-mono select-all">{apiUrl}</code>
            </div>
            <div>
              <span className="text-slate-400">方法：</span>
              <code className="ml-2 px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 font-mono">GET</code>
            </div>
            <div>
              <span className="text-slate-400">認證 Header：</span>
              <code className="ml-2 px-2 py-0.5 rounded bg-slate-900 text-amber-200 font-mono">Authorization: Bearer {'<'}SARA_EXCHANGE_API_KEY{'>'}</code>
            </div>
            <div className="rounded-lg bg-slate-900/60 border border-slate-700 p-3 font-mono text-slate-300 space-y-1">
              <div className="text-slate-500"># 拉取所有 pending 資料</div>
              <div>GET {apiUrl}</div>
              <div className="text-slate-500 mt-2"># 篩選特定類型</div>
              <div>GET {apiUrl}?type=mo_list</div>
              <div className="text-slate-500 mt-2"># 拉取後自動標記 consumed</div>
              <div>GET {apiUrl}?mark_consumed=true</div>
              <div className="text-slate-500 mt-2"># 時間篩選</div>
              <div>GET {apiUrl}?since=2026-08-01</div>
            </div>
            <div>
              <span className="text-slate-400">回傳格式：</span>
              <code className="ml-2 px-2 py-0.5 rounded bg-slate-900 text-slate-300 font-mono">{'{ "success": true, "count": N, "data": [...], "fetched_at": "..." }'}</code>
            </div>
            <div className="text-amber-300/80">
              ⚠️ API Key 請至 Vercel 環境變數設定 <code className="font-mono">SARA_EXCHANGE_API_KEY</code>
            </div>
          </div>
        </div>

        {/* 控制列 */}
        <div className="mb-4 flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-2 items-center flex-wrap">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as 'pending' | 'consumed' | 'all')}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none"
            >
              <option value="all">全部狀態</option>
              <option value="pending">⏳ pending</option>
              <option value="consumed">✅ consumed</option>
            </select>
            <input
              type="text"
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              placeholder="篩選資料類型..."
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 w-44 focus:outline-none focus:border-cyan-500/50"
            />
            <span className="text-xs text-slate-500">共 <span className="text-cyan-300 font-mono font-semibold">{total}</span> 筆</span>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            {delMsg && <span className={`text-xs ${delMsg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{delMsg}</span>}
            {selected.size > 0 && (
              <button onClick={() => void handleDelete()} disabled={deleting}
                className="px-3 py-2 rounded-lg bg-red-900/50 border border-red-700/50 text-red-300 text-sm hover:bg-red-800/60 disabled:opacity-50 transition-colors">
                🗑 刪除 {selected.size} 筆
              </button>
            )}
            <button onClick={() => void handleClearConsumed()} disabled={deleting}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 text-sm hover:bg-slate-700 disabled:opacity-50 transition-colors">
              清除已消費
            </button>
            <button onClick={() => setShowAdd(v => !v)}
              className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-medium transition-colors">
              + 新增資料
            </button>
          </div>
        </div>

        {/* 新增表單 */}
        {showAdd && (
          <div className="mb-5 rounded-xl border border-cyan-800/40 bg-slate-900 p-5 space-y-3">
            <h3 className="text-sm font-semibold text-cyan-300">新增交換資料</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">資料類型 *</label>
                <input value={addType} onChange={e => setAddType(e.target.value)}
                  placeholder="如 mo_list, schedule, order_status"
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">參考鍵</label>
                <input value={addRef} onChange={e => setAddRef(e.target.value)}
                  placeholder="如 2026-08-06, MOT2601234..."
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">備註</label>
                <input value={addNote} onChange={e => setAddNote(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50" />
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Payload（JSON）</label>
              <textarea
                value={addPayload}
                onChange={e => setAddPayload(e.target.value)}
                rows={6}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500/50 resize-y"
              />
            </div>
            <div className="flex gap-3 items-center">
              <button onClick={() => void handleAdd()} disabled={adding}
                className="px-5 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm font-medium transition-colors">
                {adding ? '新增中...' : '確認新增'}
              </button>
              <button onClick={() => setShowAdd(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 text-sm hover:bg-slate-700 transition-colors">
                取消
              </button>
              {addMsg && <span className={`text-sm ${addMsg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{addMsg}</span>}
            </div>
          </div>
        )}

        {/* 資料表格 */}
        <div className="rounded-xl border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 bg-slate-900 text-slate-400 text-xs">
                <th className="px-3 py-2 w-8">
                  <input type="checkbox"
                    checked={rows.length > 0 && rows.every(r => selected.has(r.id))}
                    onChange={() => {
                      if (rows.every(r => selected.has(r.id))) setSelected(new Set())
                      else setSelected(new Set(rows.map(r => r.id)))
                    }}
                    className="accent-cyan-500 cursor-pointer" />
                </th>
                <th className="px-3 py-2 text-left w-16">ID</th>
                <th className="px-3 py-2 text-left">資料類型</th>
                <th className="px-3 py-2 text-left">參考鍵</th>
                <th className="px-3 py-2 text-left w-24">狀態</th>
                <th className="px-3 py-2 text-left w-40">建立時間</th>
                <th className="px-3 py-2 text-left w-40">拉取時間</th>
                <th className="px-3 py-2 text-left">備註</th>
                <th className="px-3 py-2 text-center w-16">Payload</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={9} className="text-center py-10 text-slate-500">載入中...</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-slate-500">暫無資料</td></tr>}
              {!loading && rows.map(r => (
                <>
                  <tr key={r.id} className="border-b border-slate-800 hover:bg-slate-900/40 transition-colors">
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" checked={selected.has(r.id)}
                        onChange={() => setSelected(prev => {
                          const n = new Set(prev); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n
                        })}
                        className="accent-cyan-500 cursor-pointer" />
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-500 text-xs">{r.id}</td>
                    <td className="px-3 py-2 font-mono text-cyan-300 text-xs">{r.data_type}</td>
                    <td className="px-3 py-2 font-mono text-slate-300 text-xs">{r.ref_key ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded border text-[10px] font-medium ${STATUS_BADGE[r.status] ?? ''}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-400 text-xs whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString('zh-TW', { hour12: false })}
                    </td>
                    <td className="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">
                      {r.consumed_at ? new Date(r.consumed_at).toLocaleString('zh-TW', { hour12: false }) : '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-400 text-xs">{r.note ?? ''}</td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                        className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-xs text-slate-300 hover:bg-slate-700 transition-colors"
                      >
                        {expandedId === r.id ? '收起' : '展開'}
                      </button>
                    </td>
                  </tr>
                  {expandedId === r.id && (
                    <tr key={`${r.id}-payload`} className="bg-slate-900/60">
                      <td colSpan={9} className="px-6 py-3">
                        <pre className="text-xs font-mono text-slate-300 overflow-x-auto max-h-80 bg-slate-950 rounded p-3 border border-slate-800">
                          {JSON.stringify(r.payload, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  )
}
