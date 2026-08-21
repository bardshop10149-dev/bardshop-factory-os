'use client'

// 各機台每日產出——生產管理入口。手機版優先：有權限的人自己打開網址查看即可，
// 不依賴寄信服務。
// 資料來源：每天 05:00 排程算好存進 argoerp_daily_machine_output_snapshots 的快照
// （ARGO 製令實際繳庫量 × 本系統機台分配），不即時查 ARGO，開頁面快。
// 詳細計算邏輯見 lib/dailyMachineOutput.ts。

import { useCallback, useEffect, useState } from 'react'

interface ProductQty {
  code: string
  qty: number
  name: string | null
}
interface MachineOutputRow {
  machine: string
  actualQty: number
  moCount: number
  pendingMoCount: number
  products: ProductQty[]
}
interface Snapshot {
  date: string
  rows: MachineOutputRow[]
  packing_list: ProductQty[]
  total_mo_count: number
  unassigned_mo_count: number
  computed_at: string
}

function taipeiDateStr(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const y = parts.find(p => p.type === 'year')!.value
  const m = parts.find(p => p.type === 'month')!.value
  const dd = parts.find(p => p.type === 'day')!.value
  return `${y}-${m}-${dd}`
}

function MachineCard({ row }: { row: MachineOutputRow }) {
  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-slate-100">{row.machine}</div>
          {row.pendingMoCount > 0 && (
            <div className="mt-1 text-xs text-amber-400/90">⚠️ {row.pendingMoCount} 張製令有異動但尚未繳庫</div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold text-emerald-300 font-mono leading-none">{row.actualQty.toLocaleString()}</div>
          <div className="text-[11px] text-slate-500 mt-1">{row.moCount} 張製令</div>
        </div>
      </div>
      {row.products.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-800 space-y-1">
          {row.products.map(p => (
            <div key={p.code} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-slate-300 truncate">
                {p.code}
                {p.name && <span className="text-slate-500"> · {p.name}</span>}
              </span>
              <span className="text-emerald-300/80 font-mono shrink-0">{p.qty.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DailyMachineOutputPage() {
  const [date, setDate] = useState(() => taipeiDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000)))
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [recomputing, setRecomputing] = useState(false)
  const [recomputeMsg, setRecomputeMsg] = useState('')

  const [recipients, setRecipients] = useState<string[]>([])
  const [recipientsLoading, setRecipientsLoading] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [recipientMsg, setRecipientMsg] = useState('')

  const loadSnapshot = useCallback(async (dateStr: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/production/daily-machine-output-snapshot?date=${dateStr}`, { cache: 'no-store' })
      const json = await res.json() as { success: boolean; error?: string; snapshot?: Snapshot | null }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSnapshot(json.snapshot ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSnapshot(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const recomputeSnapshot = useCallback(async (dateStr: string) => {
    setRecomputing(true)
    setRecomputeMsg('')
    setError('')
    try {
      const res = await fetch('/api/production/daily-machine-output-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr }),
      })
      const json = await res.json() as { success: boolean; error?: string; snapshot?: Snapshot }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSnapshot(json.snapshot ?? null)
      setRecomputeMsg(`✅ 已更新（${new Date().toLocaleTimeString('zh-TW')}）`)
      setTimeout(() => setRecomputeMsg(''), 5000)
    } catch (e) {
      setRecomputeMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRecomputing(false)
    }
  }, [])

  const loadRecipients = useCallback(async () => {
    setRecipientsLoading(true)
    try {
      const res = await fetch('/api/production/daily-machine-output-recipients', { cache: 'no-store' })
      const json = await res.json() as { success: boolean; recipients?: string[] }
      if (json.success) setRecipients(json.recipients ?? [])
    } finally {
      setRecipientsLoading(false)
    }
  }, [])

  useEffect(() => { void loadSnapshot(date) }, [date, loadSnapshot])
  useEffect(() => { if (showSettings) void loadRecipients() }, [showSettings, loadRecipients])

  const addRecipient = useCallback(async () => {
    const email = newEmail.trim()
    if (!email) return
    setRecipientMsg('')
    try {
      const res = await fetch('/api/production/daily-machine-output-recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', email }),
      })
      const json = await res.json() as { success: boolean; error?: string; recipients?: string[] }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setRecipients(json.recipients ?? [])
      setNewEmail('')
    } catch (e) {
      setRecipientMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [newEmail])

  const removeRecipient = useCallback(async (email: string) => {
    setRecipientMsg('')
    try {
      const res = await fetch('/api/production/daily-machine-output-recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', email }),
      })
      const json = await res.json() as { success: boolean; error?: string; recipients?: string[] }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setRecipients(json.recipients ?? [])
    } catch (e) {
      setRecipientMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  const shiftDate = (deltaDays: number) => {
    const d = new Date(`${date}T00:00:00+08:00`)
    setDate(taipeiDateStr(new Date(d.getTime() + deltaDays * 24 * 60 * 60 * 1000)))
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* 頂部固定日期列，手機上方便單手操作 */}
      <div className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-4 py-3">
        <h1 className="text-base font-bold text-white">🎯 各機台每日產出</h1>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => shiftDate(-1)}
            className="w-10 h-10 shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-lg active:scale-95 transition-transform"
          >‹</button>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none"
          />
          <button
            onClick={() => shiftDate(1)}
            className="w-10 h-10 shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-lg active:scale-95 transition-transform"
          >›</button>
        </div>
        <button
          onClick={() => void recomputeSnapshot(date)}
          disabled={recomputing}
          className="mt-2 w-full h-10 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-sm font-medium active:scale-95 transition-transform"
        >
          {recomputing ? '更新中…' : '🔄 手動更新這天的資料'}
        </button>
        {(snapshot || recomputeMsg) && (
          <div className="mt-1.5 text-[11px] text-slate-500 space-y-0.5">
            {snapshot && (
              <div>
                快照計算於 {new Date(snapshot.computed_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {snapshot.total_mo_count > 0 && `・共 ${snapshot.total_mo_count} 張製令有繳庫`}
                {snapshot.unassigned_mo_count > 0 && `（${snapshot.unassigned_mo_count} 張無機台分配）`}
              </div>
            )}
            {recomputeMsg && <div className={recomputeMsg.startsWith('❌') ? 'text-red-400' : 'text-emerald-400'}>{recomputeMsg}</div>}
          </div>
        )}
      </div>

      <div className="max-w-2xl mx-auto p-4 space-y-4">
        {error && <div className="px-3 py-2 rounded-lg bg-red-900/30 border border-red-700/40 text-red-300 text-xs">❌ {error}</div>}

        {loading ? (
          <div className="py-16 text-center text-slate-400 text-sm">載入中…</div>
        ) : !snapshot ? (
          <div className="py-16 text-center space-y-1">
            <p className="text-slate-400 text-sm">{date} 還沒有快照資料</p>
            <p className="text-slate-500 text-xs">05:00 的排程可能還沒跑到這天，或當天沒有繳庫紀錄</p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {snapshot.rows.map(row => <MachineCard key={row.machine} row={row} />)}
              {snapshot.rows.length === 0 && (
                <div className="py-8 text-center text-slate-500 text-sm">當天沒有可歸屬到機台的繳庫紀錄</div>
              )}
            </div>

            <div className="space-y-2 pt-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-200">📦 包裝部清單</h2>
                <span className="text-slate-500 text-xs">當天所有繳庫製令的品號加總，不分機台</span>
              </div>
              <div className="rounded-xl bg-slate-900 border border-slate-800 divide-y divide-slate-800/70">
                {snapshot.packing_list.map(p => (
                  <div key={p.code} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="text-slate-100">{p.code}</span>
                      {p.name && <span className="block text-xs text-slate-500 truncate">{p.name}</span>}
                    </span>
                    <span className="text-emerald-300 font-mono shrink-0">{p.qty.toLocaleString()}</span>
                  </div>
                ))}
                {snapshot.packing_list.length === 0 && (
                  <div className="px-4 py-8 text-center text-slate-500 text-sm">無資料</div>
                )}
              </div>
            </div>
          </>
        )}

        {/* 通知信收件人設定——收合，主要用途是自己查看，這個是次要功能 */}
        <div className="pt-2">
          <button
            onClick={() => setShowSettings(v => !v)}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            {showSettings ? '▾' : '▸'} 📧 通知信收件人設定
          </button>
          {showSettings && (
            <div className="mt-2 space-y-2 rounded-xl bg-slate-900 border border-slate-800 p-4">
              <p className="text-slate-500 text-xs">每天 05:30 自動寄出這份報表給以下信箱，可自由新增/刪除（需先設定寄信服務才會真的寄出）。</p>
              <div className="flex items-center gap-2">
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void addRecipient() }}
                  placeholder="name@company.com"
                  className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                />
                <button
                  onClick={() => void addRecipient()}
                  className="px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium transition-colors shrink-0"
                >
                  新增
                </button>
              </div>
              {recipientMsg && <div className="text-red-400 text-xs">{recipientMsg}</div>}
              {recipientsLoading ? (
                <div className="text-slate-500 text-xs">載入中…</div>
              ) : recipients.length === 0 ? (
                <div className="text-slate-500 text-xs">目前沒有收件人，通知信不會寄出</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {recipients.map(email => (
                    <span key={email} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-300 text-xs">
                      {email}
                      <button onClick={() => void removeRecipient(email)} className="text-slate-500 hover:text-red-400 transition-colors">✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
