'use client'

import { NavButton } from '../../../../../components/NavButton'
import { useCallback, useEffect, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductItem { item_code: string; item_name: string; quantity: string }

interface Inquiry {
  id: number
  inquiry_date: string | null
  customer_name: string | null
  order_no: string | null
  salesperson: string | null
  items: ProductItem[] | null
  planned_order_date: string | null
  expected_date: string | null
  remark: string | null
  planner_reply: 'approved' | 'rejected' | 'completed' | null
  author_name: string
  department: string | null
  created_at: string
  updated_at: string
}

type ActiveTab = 'records' | 'create' | 'settings'
type ReplyFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'completed'

interface FormState {
  inquiry_date: string
  customer_name: string
  order_no: string
  salesperson: string
  items: ProductItem[]
  planned_order_date: string
  expected_date: string
  remark: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TODAY = () => new Date().toISOString().slice(0, 10)
const DEFAULT_ITEM: ProductItem = { item_code: '', item_name: '', quantity: '' }
const DEFAULT_FORM: FormState = {
  inquiry_date: TODAY(), customer_name: '', order_no: '', salesperson: '', items: [{ ...DEFAULT_ITEM }],
  planned_order_date: '', expected_date: '', remark: '',
}

const REPLY_CONFIG = {
  approved:  { label: '同意',   cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700' },
  rejected:  { label: '拒絕',   cls: 'bg-red-900/40     text-red-300     border-red-700'     },
  completed: { label: '已完成', cls: 'bg-slate-700/60   text-slate-400   border-slate-600'   },
  pending:   { label: '待回覆', cls: 'bg-amber-900/40   text-amber-300   border-amber-700'   },
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScheduleInquiryPage() {
  const [tab, setTab]           = useState<ActiveTab>('records')
  const [records, setRecords]   = useState<Inquiry[]>([])
  const [loading, setLoading]   = useState(true)
  const [filter, setFilter]     = useState<ReplyFilter>('all')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm]         = useState<FormState>(DEFAULT_FORM)
  const [saving, setSaving]     = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [salespersons, setSalespersons] = useState<string[]>([])
  const [spNewName, setSpNewName]       = useState('')
  const [spAdding, setSpAdding]         = useState(false)
  const [spDeleting, setSpDeleting]     = useState<string | null>(null)

  // ─── Fetch ────────────────────────────────────────────────────────────────

  const fetchRecords = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/production/schedule-confirm')
      const json = await res.json()
      if (json?.success) setRecords((json.records as Inquiry[]) || [])
    } catch {
      // 保留原本行為：讀取失敗時不特別提示，僅維持既有列表
    }
    setLoading(false)
  }, [])

  const fetchSalespersons = useCallback(async () => {
    try {
      const res = await fetch('/api/production/schedule-confirm/salespersons')
      const json = await res.json()
      if (json?.success) setSalespersons((json.salespersons as string[]) || [])
    } catch {
      // 保留原本行為：讀取失敗時不特別提示
    }
  }, [])

  useEffect(() => { void fetchRecords() }, [fetchRecords])
  useEffect(() => { void fetchSalespersons() }, [fetchSalespersons])

  // ─── Form helpers ────────────────────────────────────────────────────────

  const resetForm = () => {
    setForm({ ...DEFAULT_FORM, inquiry_date: TODAY(), salesperson: '', items: [{ ...DEFAULT_ITEM }] })
    setEditingId(null)
  }

  const openCreate = () => { resetForm(); setTab('create') }

  const openEdit = (rec: Inquiry) => {
    setEditingId(rec.id)
    setForm({
      inquiry_date:       rec.inquiry_date       || TODAY(),
      customer_name:      rec.customer_name      || '',
      order_no:           rec.order_no           || '',
      salesperson:        rec.salesperson        || '',
      items:              rec.items && rec.items.length > 0 ? rec.items : [{ ...DEFAULT_ITEM }],
      planned_order_date: rec.planned_order_date || '',
      expected_date:      rec.expected_date      || '',
      remark:             rec.remark             || '',
    })
    setTab('create')
  }

  const addItem    = () => setForm(f => ({ ...f, items: [...f.items, { ...DEFAULT_ITEM }] }))
  const removeItem = (idx: number) => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))
  const updateItem = (idx: number, field: keyof ProductItem, value: string) =>
    setForm(f => { const items = [...f.items]; items[idx] = { ...items[idx], [field]: value }; return { ...f, items } })

  // ─── Save ─────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    const cleanItems = form.items.filter(it => it.item_code.trim() || it.item_name.trim() || it.quantity.trim())
    setSaving(true)
    const payload = {
      inquiry_date:       form.inquiry_date       || null,
      customer_name:      form.customer_name.trim() || null,
      order_no:           form.order_no.trim()    || null,
      salesperson:        form.salesperson        || null,
      items:              cleanItems,
      planned_order_date: form.planned_order_date || null,
      expected_date:      form.expected_date      || null,
      remark:             form.remark.trim()      || null,
      updated_at:         new Date().toISOString(),
    }
    try {
      const res = editingId
        ? await fetch('/api/production/schedule-confirm', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: editingId, fields: payload }),
          })
        : await fetch('/api/production/schedule-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
      const json = await res.json()
      if (!json?.success) {
        alert(`儲存失敗：${json?.error ?? '未知錯誤'}`)
      } else {
        resetForm()
        await fetchRecords()
        setTab('records')
      }
    } catch (e) {
      alert(`儲存失敗：${e instanceof Error ? e.message : String(e)}`)
    }
    setSaving(false)
  }

  // ─── Reply ────────────────────────────────────────────────────────────────

  const handleReply = async (id: number, reply: 'approved' | 'rejected' | 'completed' | null) => {
    try {
      const res = await fetch('/api/production/schedule-confirm', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          fields: { planner_reply: reply, updated_at: new Date().toISOString() },
        }),
      })
      const json = await res.json()
      if (!json?.success) alert(`更新失敗：${json?.error ?? '未知錯誤'}`)
      else await fetchRecords()
    } catch (e) {
      alert(`更新失敗：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  const handleDelete = async (id: number) => {
    if (!confirm('確定要刪除此筆紀錄？此操作無法復原。')) return
    setDeletingId(id)
    try {
      const res = await fetch(`/api/production/schedule-confirm?id=${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!json?.success) alert(`刪除失敗：${json?.error ?? '未知錯誤'}`)
      else await fetchRecords()
    } catch (e) {
      alert(`刪除失敗：${e instanceof Error ? e.message : String(e)}`)
    }
    setDeletingId(null)
  }

  // ─── Filtered list ────────────────────────────────────────────────────────

  // Sort helper: by planned_order_date asc (nulls last); completed pinned to bottom
  const sortedRecords = [...records].sort((a, b) => {
    const aDone = a.planner_reply === 'completed'
    const bDone = b.planner_reply === 'completed'
    if (aDone !== bDone) return aDone ? 1 : -1
    const aDate = a.planned_order_date ?? '9999-99-99'
    const bDate = b.planned_order_date ?? '9999-99-99'
    return aDate < bDate ? -1 : aDate > bDate ? 1 : 0
  })

  const filtered = sortedRecords.filter(r => {
    if (filter === 'pending')   return !r.planner_reply
    if (filter === 'approved')  return r.planner_reply === 'approved'
    if (filter === 'rejected')  return r.planner_reply === 'rejected'
    if (filter === 'completed') return r.planner_reply === 'completed'
    return true
  })

  const replyBadge = (r: Inquiry) => {
    const cfg = r.planner_reply ? REPLY_CONFIG[r.planner_reply] : REPLY_CONFIG.pending
    return (
      <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-semibold ${cfg.cls}`}>
        {cfg.label}
      </span>
    )
  }

  // ─── Salesperson management ─────────────────────────────────────────────

  const handleAddSalesperson = async () => {
    const name = spNewName.trim()
    if (!name) return
    setSpAdding(true)
    try {
      const res = await fetch('/api/production/schedule-confirm/salespersons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const json = await res.json()
      if (!json?.success) {
        alert(`新增失敗：${json?.error ?? '未知錯誤'}`)
      } else {
        setSpNewName('')
        await fetchSalespersons()
      }
    } catch (e) {
      alert(`新增失敗：${e instanceof Error ? e.message : String(e)}`)
    }
    setSpAdding(false)
  }

  const handleDeleteSalesperson = async (name: string) => {
    if (!confirm(`確定刪除業務「${name}」？`)) return
    setSpDeleting(name)
    try {
      const res = await fetch(`/api/production/schedule-confirm/salespersons?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      const json = await res.json()
      if (!json?.success) alert(`刪除失敗：${json?.error ?? '未知錯誤'}`)
      else await fetchSalespersons()
    } catch (e) {
      alert(`刪除失敗：${e instanceof Error ? e.message : String(e)}`)
    }
    setSpDeleting(null)
  }

  // ─── Records Tab ─────────────────────────────────────────────────────────

  const renderRecords = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        {/* Filter tabs */}
        <div className="flex gap-1 p-1 bg-slate-800/60 rounded-xl border border-slate-700">
          {([['all','全部'],['pending','待回覆'],['approved','同意'],['rejected','拒絕'],['completed','已完成']] as [ReplyFilter,string][]).map(([key,label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                filter === key ? 'bg-orange-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              {label}
              {key !== 'all' && (
                <span className="ml-1.5 text-xs opacity-70">
                  {key === 'pending'   ? records.filter(r => !r.planner_reply).length
                  : key === 'approved'  ? records.filter(r => r.planner_reply === 'approved').length
                  : key === 'rejected'  ? records.filter(r => r.planner_reply === 'rejected').length
                  : records.filter(r => r.planner_reply === 'completed').length}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-orange-600 hover:bg-orange-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          新增詢問
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-500 animate-pulse">載入中…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-600 border-2 border-dashed border-slate-700 rounded-2xl">
          目前沒有符合條件的紀錄
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(rec => {
            const items = rec.items || []
            const isCompleted = rec.planner_reply === 'completed'
            return (
              <div key={rec.id} className={`rounded-2xl border transition-colors ${
                isCompleted
                  ? 'border-slate-700/40 bg-slate-900/20 opacity-50 hover:opacity-70'
                  : 'border-slate-700 bg-slate-900/50 hover:bg-slate-800/40'
              }`}>
                {/* Card header */}
                <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-slate-700/60 flex-wrap">
                  <div className="flex items-center gap-3 flex-wrap">
                    {replyBadge(rec)}
                    <span className="text-xs text-slate-500 font-mono">#{rec.id}</span>
                    <span className="text-sm text-slate-300">
                      詢問日：<span className="text-white">{rec.inquiry_date ?? '—'}</span>
                    </span>
                    {rec.customer_name && (
                      <span className="text-sm text-slate-300">
                        客戶：<span className="text-white font-semibold">{rec.customer_name}</span>
                      </span>
                    )}
                    {rec.salesperson && (
                      <span className="text-sm text-slate-400">
                        業務：<span className="text-sky-400">{rec.salesperson}</span>
                      </span>
                    )}
                    {rec.order_no && (
                      <span className="text-sm text-slate-400">
                        訂單：<span className="text-cyan-400 font-mono">{rec.order_no}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-slate-500">
                      {rec.author_name}{rec.department ? ` · ${rec.department}` : ''}
                    </span>
                    {/* Reply + Complete buttons */}
                    {rec.planner_reply === 'completed' ? (
                      <button
                        onClick={() => void handleReply(rec.id, null)}
                        className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg transition-colors"
                      >取消完成</button>
                    ) : (
                      <>
                        {rec.planner_reply !== 'approved' && (
                          <button
                            onClick={() => void handleReply(rec.id, 'approved')}
                            className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold rounded-lg transition-colors"
                          >同意</button>
                        )}
                        {rec.planner_reply !== 'rejected' && (
                          <button
                            onClick={() => void handleReply(rec.id, 'rejected')}
                            className="px-3 py-1 bg-red-800 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition-colors"
                          >拒絕</button>
                        )}
                        {rec.planner_reply && (
                          <button
                            onClick={() => void handleReply(rec.id, null)}
                            className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg transition-colors"
                          >清除回覆</button>
                        )}
                        <button
                          onClick={() => void handleReply(rec.id, 'completed')}
                          className="px-3 py-1 bg-slate-600 hover:bg-slate-500 text-slate-200 text-xs rounded-lg transition-colors"
                        >標記完成</button>
                      </>
                    )}
                    <button
                      onClick={() => openEdit(rec)}
                      className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg transition-colors"
                    >編輯</button>
                    <button
                      onClick={() => void handleDelete(rec.id)}
                      disabled={deletingId === rec.id}
                      className="px-3 py-1 bg-red-900/50 hover:bg-red-800/60 text-red-300 text-xs rounded-lg transition-colors disabled:opacity-40"
                    >{deletingId === rec.id ? '…' : '刪除'}</button>
                  </div>
                </div>

                {/* Card body */}
                <div className="px-5 py-3 space-y-2">
                  {items.length === 0 ? (
                    <p className="text-slate-600 text-sm">（無品項）</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-500 text-xs">
                          <th className="text-left pb-1 pr-4">品項編碼</th>
                          <th className="text-left pb-1 pr-4">名稱/規格</th>
                          <th className="text-left pb-1">數量</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it, i) => (
                          <tr key={i} className="border-t border-slate-800/60">
                            <td className="py-1 pr-4 text-slate-400 font-mono">{it.item_code || '—'}</td>
                            <td className="py-1 pr-4 text-white">{it.item_name || '—'}</td>
                            <td className="py-1 text-slate-300">{it.quantity || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="flex gap-6 flex-wrap text-sm pt-1">
                    <div>
                      <span className="text-slate-500 text-xs">預計發單日</span>
                      <p className="text-slate-200">{rec.planned_order_date || '—'}</p>
                    </div>
                    <div>
                      <span className="text-slate-500 text-xs">希望交期</span>
                      <p className="text-slate-200">{rec.expected_date || '—'}</p>
                    </div>
                    {rec.remark && (
                      <div>
                        <span className="text-slate-500 text-xs">備註</span>
                        <p className="text-slate-300">{rec.remark}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  // ─── Create / Edit Tab ───────────────────────────────────────────────────

  const renderForm = () => (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">
          {editingId ? `編輯紀錄 #${editingId}` : '新增詢問紀錄'}
        </h2>
        <button
          onClick={() => { resetForm(); setTab('records') }}
          className="text-slate-500 hover:text-white text-sm transition-colors"
        >← 返回列表</button>
      </div>

      {/* 客戶名稱 */}
      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">客戶名稱</label>
          <input
            type="text"
            value={form.customer_name}
            onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
            placeholder="請輸入客戶名稱"
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder-slate-600"
          />
        </div>
      </div>

      {/* 詢問日期 + 業務 + 訂單編號 */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">詢問日期</label>
          <input
            type="date"
            value={form.inquiry_date}
            onChange={e => setForm(f => ({ ...f, inquiry_date: e.target.value }))}
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">詢問業務</label>
          <select
            value={form.salesperson}
            onChange={e => setForm(f => ({ ...f, salesperson: e.target.value }))}
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500"
          >
            <option value="">請選擇業務</option>
            {salespersons.map(sp => (
              <option key={sp} value={sp}>{sp}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">訂單編號</label>
          <input
            type="text"
            value={form.order_no}
            onChange={e => setForm(f => ({ ...f, order_no: e.target.value }))}
            placeholder="選填"
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder-slate-600"
          />
        </div>
      </div>

      {/* 產品資訊 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-slate-400">產品資訊</label>
          <button
            onClick={addItem}
            className="flex items-center gap-1 text-xs text-orange-400 hover:text-orange-300 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            新增品項
          </button>
        </div>
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1.5fr_80px_32px] gap-2 px-1">
            <span className="text-xs text-slate-500">品項編碼</span>
            <span className="text-xs text-slate-500">名稱/規格</span>
            <span className="text-xs text-slate-500">數量</span>
            <span></span>
          </div>
          {form.items.map((item, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_1.5fr_80px_32px] gap-2 items-center">
              <input
                type="text"
                value={item.item_code}
                onChange={e => updateItem(idx, 'item_code', e.target.value)}
                placeholder="編碼"
                className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder-slate-600"
              />
              <input
                type="text"
                value={item.item_name}
                onChange={e => updateItem(idx, 'item_name', e.target.value)}
                placeholder="品名/規格"
                className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder-slate-600"
              />
              <input
                type="text"
                value={item.quantity}
                onChange={e => updateItem(idx, 'quantity', e.target.value)}
                placeholder="數量"
                className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder-slate-600"
              />
              <button
                onClick={() => removeItem(idx)}
                disabled={form.items.length === 1}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-30"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 預計發單日 + 希望交期 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">預計發單日</label>
          <input
            type="date"
            value={form.planned_order_date}
            onChange={e => setForm(f => ({ ...f, planned_order_date: e.target.value }))}
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">希望交期</label>
          <input
            type="date"
            value={form.expected_date}
            onChange={e => setForm(f => ({ ...f, expected_date: e.target.value }))}
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500"
          />
        </div>
      </div>

      {/* 備註 */}
      <div>
        <label className="block text-sm text-slate-400 mb-1">備註</label>
        <textarea
          rows={3}
          value={form.remark}
          onChange={e => setForm(f => ({ ...f, remark: e.target.value }))}
          placeholder="選填"
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder-slate-600"
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={() => { resetForm(); setTab('records') }}
          disabled={saving}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-colors"
        >取消</button>
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-2 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors"
        >
          {saving && (
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582M20 20v-5h-.581M4.582 9a8 8 0 0115.357 5M19.418 15a8 8 0 01-15.357-5" />
            </svg>
          )}
          {saving ? '儲存中…' : '儲存'}
        </button>
      </div>
    </div>
  )
  // ─── Settings Tab ─────────────────────────────────────────────────────────

  const renderSettings = () => (
    <div className="max-w-md space-y-5">
      <h2 className="text-lg font-bold text-white">業務人員管理</h2>
      {/* Add */}
      <div className="flex gap-2">
        <input
          type="text"
          value={spNewName}
          onChange={e => setSpNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void handleAddSalesperson()}
          placeholder="輸入業務姓名…"
          className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder-slate-600"
        />
        <button
          onClick={() => void handleAddSalesperson()}
          disabled={spAdding || !spNewName.trim()}
          className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors"
        >{spAdding ? '新增中…' : '新增'}</button>
      </div>
      {/* List */}
      {salespersons.length === 0 ? (
        <p className="text-slate-600 text-sm">(尚未新增任何業務)</p>
      ) : (
        <ul className="space-y-2">
          {salespersons.map(sp => (
            <li key={sp} className="flex items-center justify-between bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-2">
              <span className="text-white text-sm">{sp}</span>
              <button
                onClick={() => void handleDeleteSalesperson(sp)}
                disabled={spDeleting === sp}
                className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 transition-colors"
              >{spDeleting === sp ? '刪除中…' : '刪除'}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  // ─── Main ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto min-h-screen space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">產期詢問記錄</h1>
          <p className="text-orange-400 mt-1 font-mono text-sm uppercase">
            SCHEDULE INQUIRY // 產期詢問與生管回覆
          </p>
        </div>
        <NavButton href="/admin" direction="home" title="回到首頁" className="px-3 py-2" />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-slate-800/60 rounded-xl w-fit border border-slate-700">
        {([['records','詢問列表'],['create', editingId ? `編輯 #${editingId}` : '新增詢問'],['settings','選項設定']] as [ActiveTab,string][]).map(([key,label]) => (
          <button
            key={key}
            onClick={() => {
              if (key === 'records') { resetForm(); setTab('records') }
              else if (key === 'create') openCreate()
              else setTab('settings')
            }}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === key ? 'bg-orange-600 text-white shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'records' ? renderRecords() : tab === 'settings' ? renderSettings() : renderForm()}
    </div>
  )
}