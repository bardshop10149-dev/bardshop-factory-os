'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

// 工程維護/維修表：開單 → 填進度 → 結案（API 見 app/api/engineering/maintenance/route.ts）

interface MaintenanceRecord {
  id: number
  record_no: string
  type: string
  type_other: string | null
  machine: string | null
  title: string
  description: string | null
  start_date: string | null
  expected_end_date: string | null
  needs_purchase: boolean
  pr_number: string | null
  progress: string | null
  status: string
  closed_at: string | null
  closed_by: string | null
  created_by_name: string | null
  created_at: string
  updated_by: string | null
}

const TYPES = ['機台維修', '其他類型']

const fmtDT = (s: string | null) =>
  s ? new Date(s).toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

/** 台北時間的今天（YYYY-MM-DD），給 date input 當預設值 */
const todayStr = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

type Draft = Partial<MaintenanceRecord>

export default function MaintenancePage() {
  const router = useRouter()
  const [auth, setAuth] = useState<'checking' | 'allowed' | 'denied'>('checking')
  const [records, setRecords] = useState<MaintenanceRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  const [statusFilter, setStatusFilter] = useState('進行中')
  const [keyword, setKeyword] = useState('')

  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.status === 401) { router.replace('/login'); return }
        if (!res.ok) { setAuth('denied'); return }
        const me = await res.json() as { is_admin?: boolean; permissions?: string[] }
        const perms = Array.isArray(me.permissions) ? me.permissions : []
        setAuth(Boolean(me.is_admin) || perms.includes('engineering') ? 'allowed' : 'denied')
      } catch { setAuth('denied') }
    }
    void check()
  }, [router])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (keyword.trim()) qs.set('keyword', keyword.trim())
      const res = await fetch(`/api/engineering/maintenance?${qs}`, { cache: 'no-store' })
      const j = await res.json() as { success: boolean; records?: MaintenanceRecord[]; error?: string }
      if (!j.success) throw new Error(j.error)
      setRecords(j.records ?? [])
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setLoading(false) }
  }, [keyword])

  useEffect(() => { if (auth === 'allowed') void load() }, [auth, load])

  // 狀態篩選在前端做，切頁籤不用重打 API
  const shown = useMemo(
    () => statusFilter === 'all' ? records : records.filter(r => r.status === statusFilter),
    [records, statusFilter]
  )
  const counts = useMemo(() => {
    const c: Record<string, number> = { 進行中: 0, 已結案: 0 }
    for (const r of records) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [records])

  // 機台建議：從既有紀錄收集（報修對象不限生產機台，所以不接機台 API）
  const machineOptions = useMemo(
    () => [...new Set(records.map(r => r.machine).filter((m): m is string => !!m))].sort(),
    [records]
  )

  const save = async () => {
    if (!draft) return
    setSaving(true); setMsg('')
    try {
      const isNew = draft.id === undefined
      const res = await fetch('/api/engineering/maintenance', {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setMsg(isNew ? '✅ 已建立' : '✅ 已更新')
      setDraft(null)
      await load()
      setTimeout(() => setMsg(''), 3000)
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setSaving(false) }
  }

  /** 結案／取消結案：走 API 的 action，不經過一般欄位驗證 */
  const setClosed = async (r: MaintenanceRecord | Draft, close: boolean) => {
    if (close && !confirm(`確定將「${r.title}」結案？`)) return
    setSaving(true); setMsg('')
    try {
      const res = await fetch('/api/engineering/maintenance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, action: close ? 'close' : 'reopen' }),
      })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setMsg(close ? '✅ 已結案' : '✅ 已重新開啟')
      setDraft(null)
      await load()
      setTimeout(() => setMsg(''), 3000)
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setSaving(false) }
  }

  const remove = async (r: Draft) => {
    if (!confirm(`確定刪除 ${r.record_no}「${r.title}」？此操作無法復原。`)) return
    try {
      const res = await fetch(`/api/engineering/maintenance?id=${r.id}`, { method: 'DELETE' })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setDraft(null)
      await load()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (auth === 'checking') {
    return <div className="min-h-screen bg-[#050b14] flex items-center justify-center">
      <div className="text-orange-400 font-mono text-sm animate-pulse">驗證權限中...</div>
    </div>
  }
  if (auth === 'denied') {
    return <div className="min-h-screen bg-[#050b14] flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-red-800 rounded-2xl p-10 max-w-md w-full text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h1 className="text-xl font-bold text-red-400 mb-3">存取被拒絕</h1>
        <p className="text-slate-400 text-sm mb-6">你沒有<span className="text-orange-400 font-mono mx-1">工程專區</span>的存取權限。</p>
        <button onClick={() => router.push('/')} className="px-6 py-2 rounded border border-slate-600 text-slate-300 text-sm font-mono hover:bg-slate-700">← 返回首頁</button>
      </div>
    </div>
  }

  const input = 'w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-orange-500'
  const label = 'block text-xs text-slate-400 mb-1'
  const isOther = (draft?.type ?? '機台維修') === '其他類型'
  const closed = draft?.status === '已結案'

  return (
    <div className="min-h-screen bg-[#050b14] text-white p-4 md:p-6">
      <div className="max-w-7xl mx-auto">

        <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
          <div>
            <button onClick={() => router.push('/engineering')}
              className="mb-2 text-xs font-mono text-slate-400 hover:text-white transition-colors">← 工程專區</button>
            <h1 className="text-2xl font-bold">工程維護/維修表</h1>
            <p className="text-slate-400 text-sm mt-1">機台維修與其他工程維護的開單、進度與結案紀錄</p>
          </div>
          <button onClick={() => setDraft({ type: '機台維修', needs_purchase: false, start_date: todayStr() })}
            className="px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-sm font-medium transition-colors">
            ＋ 新增
          </button>
        </div>

        {/* 篩選列 */}
        <div className="flex items-center gap-2 flex-wrap mb-4">
          {['進行中', '已結案', 'all'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                statusFilter === s ? 'bg-orange-600 border-orange-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
              }`}>
              {s === 'all' ? '全部' : s}
              {s !== 'all' && counts[s] ? <span className="ml-1.5 opacity-70">{counts[s]}</span> : null}
            </button>
          ))}
          <div className="flex-1" />
          <input value={keyword} onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void load() }}
            placeholder="搜尋單號／項目／機台／請購單號…"
            className="px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-white text-xs w-64 focus:outline-none focus:border-orange-500" />
          <button onClick={() => void load()} disabled={loading}
            className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs hover:text-white disabled:opacity-50">
            {loading ? '載入中…' : '重新整理'}
          </button>
          {msg && <span className={`text-xs ${msg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{msg}</span>}
        </div>

        {/* 列表 */}
        <div className="rounded-xl border border-slate-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/80">
              <tr className="text-left text-xs text-slate-400">
                <th className="px-3 py-2.5 whitespace-nowrap">單號</th>
                <th className="px-3 py-2.5 whitespace-nowrap">狀態</th>
                <th className="px-3 py-2.5 whitespace-nowrap">類型</th>
                <th className="px-3 py-2.5 whitespace-nowrap">機台／種類‧原因</th>
                <th className="px-3 py-2.5">維護／維修項目</th>
                <th className="px-3 py-2.5 whitespace-nowrap">開始日</th>
                <th className="px-3 py-2.5 whitespace-nowrap">預計完成日</th>
                <th className="px-3 py-2.5 whitespace-nowrap">請購</th>
                <th className="px-3 py-2.5">進度</th>
                <th className="px-3 py-2.5 whitespace-nowrap">開單人</th>
                <th className="px-3 py-2.5 whitespace-nowrap text-center">結案</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={11} className="px-3 py-10 text-center text-slate-600 text-sm">
                  {loading ? '載入中…' : '沒有符合條件的紀錄'}
                </td></tr>
              )}
              {shown.map(r => {
                // 預計完成日已過且還沒結案 → 標紅提醒
                const overdue = r.status === '進行中' && r.expected_end_date && r.expected_end_date < todayStr()
                return (
                  <tr key={r.id} onClick={() => setDraft({ ...r })}
                    className={`border-t border-slate-800 hover:bg-slate-900/60 cursor-pointer transition-colors ${r.status === '已結案' ? 'opacity-60' : ''}`}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-300 whitespace-nowrap">{r.record_no}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] border ${
                        r.status === '已結案' ? 'bg-slate-800 text-slate-400 border-slate-700' : 'bg-amber-900/40 text-amber-300 border-amber-700/50'
                      }`}>{r.status}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{r.type}</td>
                    <td className="px-3 py-2 text-xs text-slate-300 whitespace-nowrap">{r.machine || r.type_other || '—'}</td>
                    <td className="px-3 py-2 text-slate-200">{r.title}</td>
                    <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{r.start_date || '—'}</td>
                    <td className={`px-3 py-2 text-xs whitespace-nowrap ${overdue ? 'text-rose-400 font-semibold' : 'text-slate-400'}`}>
                      {r.expected_end_date || '—'}{overdue ? ' ⚠' : ''}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {r.needs_purchase
                        ? <span className="text-cyan-300">有{r.pr_number ? `・${r.pr_number}` : ''}</span>
                        : <span className="text-slate-600">無</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-300 max-w-[18rem] truncate" title={r.progress ?? ''}>{r.progress || '—'}</td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{r.created_by_name || '—'}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      {r.status === '已結案' ? (
                        <span className="text-[11px] text-slate-600" title={`${fmtDT(r.closed_at)}${r.closed_by ? `・${r.closed_by}` : ''}`}>
                          {r.closed_at ? r.closed_at.slice(0, 10) : '已結案'}
                        </span>
                      ) : (
                        <button onClick={e => { e.stopPropagation(); void setClosed(r, true) }} disabled={saving}
                          className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-[11px] font-medium transition-colors">
                          結案
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-600 mt-2">顯示 {shown.length} 筆（共 {records.length} 筆）・點任一列可編輯</p>

        {/* 新增／編輯 */}
        {draft && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
              <div className="sticky top-0 bg-slate-900 border-b border-slate-700 px-5 py-4 flex items-center justify-between">
                <h2 className="font-bold text-white">
                  {draft.id === undefined ? '新增維護／維修單' : `${draft.record_no}`}
                  {closed && <span className="ml-2 px-2 py-0.5 rounded-full text-[11px] bg-slate-800 text-slate-400 border border-slate-700">已結案</span>}
                </h2>
                <button onClick={() => setDraft(null)} className="text-slate-500 hover:text-white text-xl leading-none">×</button>
              </div>

              <div className="p-5 space-y-4">
                {/* 類型 */}
                <div>
                  <label className={label}>類型 *</label>
                  <div className="flex gap-2">
                    {TYPES.map(t => (
                      <button key={t} onClick={() => setDraft({ ...draft, type: t })}
                        className={`px-4 py-2 rounded text-sm border transition-colors ${
                          (draft.type ?? '機台維修') === t
                            ? 'bg-orange-600 border-orange-500 text-white'
                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                        }`}>{t}</button>
                    ))}
                  </div>
                </div>

                {isOther ? (
                  <div>
                    <label className={label}>種類／原因 *（手填）</label>
                    <input value={draft.type_other ?? ''} onChange={e => setDraft({ ...draft, type_other: e.target.value })}
                      placeholder="例：廠務電力、空調、治具改善、環境安全…" className={input} />
                  </div>
                ) : (
                  <div>
                    <label className={label}>機台 *</label>
                    <input value={draft.machine ?? ''} onChange={e => setDraft({ ...draft, machine: e.target.value })}
                      list="machine-options" placeholder="機台名稱" className={input} />
                    <datalist id="machine-options">
                      {machineOptions.map(m => <option key={m} value={m} />)}
                    </datalist>
                  </div>
                )}

                <div>
                  <label className={label}>維護／維修項目 *</label>
                  <input value={draft.title ?? ''} onChange={e => setDraft({ ...draft, title: e.target.value })}
                    placeholder="例：UV 機噴頭出墨不順，需更換噴頭" className={input} />
                </div>

                <div>
                  <label className={label}>詳細說明</label>
                  <textarea value={draft.description ?? ''} onChange={e => setDraft({ ...draft, description: e.target.value })}
                    rows={2} className={input} />
                </div>

                {/* 期程 */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>開始日</label>
                    <input type="date" value={draft.start_date ?? ''} onChange={e => setDraft({ ...draft, start_date: e.target.value })} className={input} />
                  </div>
                  <div>
                    <label className={label}>預計完成日</label>
                    <input type="date" value={draft.expected_end_date ?? ''} onChange={e => setDraft({ ...draft, expected_end_date: e.target.value })} className={input} />
                  </div>
                </div>

                {/* 請購 */}
                <div className="border-t border-slate-800 pt-4">
                  <label className={label}>是否須請購</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {[false, true].map(v => (
                      <button key={String(v)} onClick={() => setDraft({ ...draft, needs_purchase: v, ...(v ? {} : { pr_number: null }) })}
                        className={`px-4 py-2 rounded text-sm border transition-colors ${
                          Boolean(draft.needs_purchase) === v
                            ? 'bg-orange-600 border-orange-500 text-white'
                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                        }`}>{v ? '有' : '無'}</button>
                    ))}
                    {draft.needs_purchase && (
                      <input value={draft.pr_number ?? ''} onChange={e => setDraft({ ...draft, pr_number: e.target.value })}
                        placeholder="請購單號 *" className={`${input} flex-1 min-w-[12rem]`} />
                    )}
                  </div>
                </div>

                {/* 進度 */}
                <div className="border-t border-slate-800 pt-4">
                  <label className={label}>進度（手填）</label>
                  <textarea value={draft.progress ?? ''} onChange={e => setDraft({ ...draft, progress: e.target.value })}
                    rows={3} placeholder="例：9/16 已叫料，零件約 9/20 到，到料後排休停機更換" className={input} />
                </div>

                {draft.id !== undefined && (
                  <div className="text-[11px] text-slate-600 border-t border-slate-800 pt-3 space-y-0.5">
                    <div>開單：{draft.created_by_name || '—'}・{fmtDT(draft.created_at ?? null)}</div>
                    {draft.closed_at && <div>結案：{draft.closed_by || '—'}・{fmtDT(draft.closed_at)}</div>}
                    {draft.updated_by && <div>最後修改：{draft.updated_by}</div>}
                  </div>
                )}
              </div>

              <div className="sticky bottom-0 bg-slate-900 border-t border-slate-700 px-5 py-4 flex items-center justify-between gap-3">
                {draft.id !== undefined ? (
                  <button onClick={() => void remove(draft)}
                    className="px-3 py-2 rounded text-xs text-red-400 hover:bg-red-950/40 border border-red-900/50 transition-colors">
                    刪除
                  </button>
                ) : <span />}
                <div className="flex gap-2">
                  <button onClick={() => setDraft(null)} className="px-4 py-2 rounded border border-slate-600 text-slate-300 text-sm hover:bg-slate-800">取消</button>
                  <button onClick={() => void save()} disabled={saving}
                    className="px-5 py-2 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white text-sm font-medium transition-colors">
                    {saving ? '儲存中…' : '儲存'}
                  </button>
                  {draft.id !== undefined && (
                    closed ? (
                      <button onClick={() => void setClosed(draft, false)} disabled={saving}
                        className="px-5 py-2 rounded border border-slate-600 text-slate-300 text-sm hover:bg-slate-800 disabled:opacity-50">
                        取消結案
                      </button>
                    ) : (
                      <button onClick={() => void setClosed(draft, true)} disabled={saving}
                        className="px-5 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-medium transition-colors">
                        結案
                      </button>
                    )
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
