'use client'

// 每日出單表「修改歷程」面板：列出這一天出單表每一次寫入是誰、何時、哪種操作，
// 以及哪幾列被新增/刪除、廠區/數量/交期/單據類型從什麼改成什麼。
// 也可輸入訂單號跨日期查「這張單的廠區何時被誰改過」。
// 資料來源 daily_order_sheet_history（寫入端 lib/argoerp/sheetHistory.ts）。

import { useCallback, useEffect, useState } from 'react'

interface RowRef { order_number: string; line: string; item_code: string; factory?: string }
interface FieldChange extends RowRef { field: string; from: string; to: string }
interface Entry {
  id: number
  sheet_date: string
  action: string
  changed_by: string | null
  changed_by_name: string | null
  row_count_before: number
  row_count_after: number
  added_count: number
  removed_count: number
  factory_change_count: number
  raw_text_changed: boolean
  changes: { added?: RowRef[]; removed?: RowRef[]; field_changes?: FieldChange[] }
  note: string | null
  created_at: string
}

const ACTION_LABEL: Record<string, string> = {
  save: '儲存／重貼整張表',
  patch: '局部修改',
  change_order: '改單專區',
  'cron:auto-doc': '自動轉單排程回寫',
  'cron:design-transfer': '美編出單表轉入',
}
const FIELD_LABEL: Record<string, string> = { factory: '廠區', quantity: '數量', delivery_date: '交期', doc_type: '單據類型', item_code: '品號' }
const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外' }
const fv = (field: string, v: string) => (field === 'factory' ? (FACTORY_LABEL[v] ?? (v || '—')) : (v || '—'))

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function SheetHistoryPanel({ sheetDate, onClose }: { sheetDate: string; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [orderQuery, setOrderQuery] = useState('')
  const [mode, setMode] = useState<'date' | 'order'>('date')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const load = useCallback(async (q: { date?: string; order?: string }) => {
    setLoading(true)
    setError('')
    try {
      const qs = q.order ? `order=${encodeURIComponent(q.order)}` : `date=${q.date}`
      const res = await fetch(`/api/argoerp/daily-order-sheet/history?${qs}`, { cache: 'no-store' })
      const j = await res.json() as { success: boolean; entries?: Entry[]; error?: string }
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setEntries(j.entries ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { setMode('date'); void load({ date: sheetDate }) }, [sheetDate, load])

  const searchOrder = () => {
    const q = orderQuery.trim()
    if (!q) { setMode('date'); void load({ date: sheetDate }); return }
    setMode('order')
    void load({ order: q })
  }

  const toggle = (id: number) => setExpanded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return (
    <div className="mb-4 bg-slate-900 border border-amber-800/50 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 bg-amber-900/20 border-b border-amber-800/30 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-semibold text-amber-300">
          🕘 修改歷程 — {mode === 'date' ? sheetDate : `訂單 ${orderQuery.trim()}（跨日期）`}
        </span>
        <input
          value={orderQuery}
          onChange={e => setOrderQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') searchOrder() }}
          placeholder="輸入訂單號跨日期查這張單被誰改過…"
          className="px-2 py-1 rounded bg-slate-950 border border-slate-700 text-xs text-slate-200 w-64 focus:outline-none focus:border-amber-500/60"
        />
        <button onClick={searchOrder} className="px-2.5 py-1 rounded text-xs bg-amber-800/60 hover:bg-amber-700 text-amber-100 border border-amber-700/50">查詢</button>
        {mode === 'order' && (
          <button onClick={() => { setOrderQuery(''); setMode('date'); void load({ date: sheetDate }) }} className="text-xs text-slate-400 hover:text-slate-200">← 回到 {sheetDate}</button>
        )}
        <button onClick={onClose} className="ml-auto text-slate-500 hover:text-slate-300 text-xs">✕ 關閉</button>
      </div>
      <p className="px-4 py-1.5 text-[11px] text-slate-500 border-b border-slate-800">
        自 2026-09-07 起，每次儲存／重貼／局部修改／改單專區／排程回寫都會留一筆；廠區異動以橘色標示。此功能上線前的修改無紀錄。
      </p>

      {loading && <div className="px-4 py-3 text-xs text-slate-400">載入中…</div>}
      {error && <div className="px-4 py-3 text-xs text-red-400">❌ {error}</div>}
      {!loading && !error && entries.length === 0 && (
        <div className="px-4 py-3 text-xs text-slate-500">沒有紀錄</div>
      )}

      {entries.length > 0 && (
        <div className="divide-y divide-slate-800 max-h-[28rem] overflow-y-auto">
          {entries.map(en => {
            const fc = en.changes?.field_changes ?? []
            const factoryChanges = fc.filter(c => c.field === 'factory')
            const otherChanges = fc.filter(c => c.field !== 'factory')
            const added = en.changes?.added ?? []
            const removed = en.changes?.removed ?? []
            const hasDetail = fc.length > 0 || added.length > 0 || removed.length > 0
            const open = expanded.has(en.id)
            return (
              <div key={en.id} className={`px-4 py-2 ${en.factory_change_count > 0 ? 'bg-orange-950/20' : ''}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-mono text-slate-400">{fmtTime(en.created_at)}</span>
                  {mode === 'order' && <span className="font-mono text-cyan-300">{en.sheet_date}</span>}
                  <span className="text-white font-medium">{en.changed_by_name ?? en.changed_by ?? '—'}</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">{ACTION_LABEL[en.action] ?? en.action}</span>
                  {en.raw_text_changed && <span className="text-amber-300">原始貼上內容有變</span>}
                  <span className="text-slate-500">{en.row_count_before} → {en.row_count_after} 列</span>
                  {en.added_count > 0 && <span className="text-emerald-300">+{en.added_count} 新增</span>}
                  {en.removed_count > 0 && <span className="text-red-300">−{en.removed_count} 刪除</span>}
                  {en.factory_change_count > 0 && <span className="text-orange-300 font-bold">廠區異動 {en.factory_change_count} 列</span>}
                  {otherChanges.length > 0 && <span className="text-slate-400">欄位變更 {otherChanges.length}</span>}
                  {en.note && <span className="text-slate-500">{en.note}</span>}
                  {hasDetail && (
                    <button onClick={() => toggle(en.id)} className="ml-auto text-[11px] text-cyan-400 hover:text-cyan-200">
                      {open ? '收合' : '明細 ▾'}
                    </button>
                  )}
                </div>
                {/* 廠區異動一律直接展開顯示，不用點 */}
                {factoryChanges.length > 0 && (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {factoryChanges.map((c, i) => (
                      <div key={i} className="text-xs text-orange-200">
                        <span className="font-mono text-cyan-300">{c.order_number}{c.line ? ` #${c.line}` : ''}</span>
                        <span className="font-mono text-purple-300 ml-2">{c.item_code}</span>
                        <span className="ml-2">廠區 <b>{fv('factory', c.from)}</b> → <b>{fv('factory', c.to)}</b></span>
                      </div>
                    ))}
                  </div>
                )}
                {open && (
                  <div className="mt-1 flex flex-col gap-0.5 text-[11px]">
                    {otherChanges.map((c, i) => (
                      <div key={`f${i}`} className="text-slate-300">
                        <span className="font-mono text-cyan-300">{c.order_number}{c.line ? ` #${c.line}` : ''}</span>
                        <span className="font-mono text-purple-300 ml-2">{c.item_code}</span>
                        <span className="ml-2">{FIELD_LABEL[c.field] ?? c.field}：{fv(c.field, c.from)} → {fv(c.field, c.to)}</span>
                      </div>
                    ))}
                    {added.map((r, i) => (
                      <div key={`a${i}`} className="text-emerald-300/90">＋ <span className="font-mono">{r.order_number}{r.line ? ` #${r.line}` : ''}</span> <span className="font-mono text-purple-300">{r.item_code}</span> {r.factory ? FACTORY_LABEL[r.factory] ?? r.factory : ''}</div>
                    ))}
                    {removed.map((r, i) => (
                      <div key={`r${i}`} className="text-red-300/90">－ <span className="font-mono">{r.order_number}{r.line ? ` #${r.line}` : ''}</span> <span className="font-mono text-purple-300">{r.item_code}</span> {r.factory ? FACTORY_LABEL[r.factory] ?? r.factory : ''}</div>
                    ))}
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
