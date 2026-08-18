'use client'

import { useState, useEffect, useCallback } from 'react'
import { NavButton } from '../../../components/NavButton'

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
  author_email: string | null
  department: string | null
  created_at: string
  updated_at: string
}

const REPLY_CONFIG: Record<string, { label: string; class: string }> = {
  pending:   { label: '待回覆', class: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  approved:  { label: '已同意', class: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  rejected:  { label: '已拒絕', class: 'bg-red-500/20 text-red-400 border-red-500/30' },
  completed: { label: '已完成', class: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' },
}

const DEFAULT_ITEM: ProductItem = { item_code: '', item_name: '', quantity: '' }

export default function ScheduleInquiryPage() {
  const [records, setRecords] = useState<Inquiry[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [currentUser, setCurrentUser] = useState<{ real_name: string; department: string; email: string } | null>(null)
  const [notifyPreview, setNotifyPreview] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // 表單欄位
  const [formDate, setFormDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [formSalesperson, setFormSalesperson] = useState('')
  const [formCustomer, setFormCustomer] = useState('')
  const [formOrderNo, setFormOrderNo] = useState('')
  const [formItems, setFormItems] = useState<ProductItem[]>([{ ...DEFAULT_ITEM }])
  const [formExpectedDate, setFormExpectedDate] = useState('')
  const [formPlannedOrderDate, setFormPlannedOrderDate] = useState('')
  const [formRemark, setFormRemark] = useState('')

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (!res.ok) return
        const me = await res.json() as { real_name?: string | null; department?: string | null; email?: string }
        setCurrentUser({ real_name: me.real_name || '-', department: me.department || '-', email: me.email || '' })
        setFormSalesperson(prev => prev || me.real_name || '')
      } catch { /* 靜默 */ }
    }
    fetchUser()
  }, [])

  const fetchRecords = useCallback(async () => {
    setLoading(true)
    setErrorMessage('')
    try {
      const res = await fetch('/api/production/schedule-confirm', { cache: 'no-store' })
      const json = await res.json()
      if (!json?.success) throw new Error(json?.error || '載入失敗')
      setRecords((json.records as Inquiry[]) || [])
    } catch (e) {
      setErrorMessage(`載入失敗：${e instanceof Error ? e.message : String(e)}`)
      setRecords([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchRecords() }, [fetchRecords])

  const resetForm = () => {
    setFormDate(new Date().toISOString().slice(0, 10))
    setFormSalesperson(currentUser?.real_name || '')
    setFormCustomer('')
    setFormOrderNo('')
    setFormItems([{ ...DEFAULT_ITEM }])
    setFormExpectedDate('')
    setFormPlannedOrderDate('')
    setFormRemark('')
    setEditingId(null)
    setShowForm(false)
  }

  const openEdit = (rec: Inquiry) => {
    setEditingId(rec.id)
    setFormDate(rec.inquiry_date || new Date().toISOString().slice(0, 10))
    setFormSalesperson(rec.salesperson || currentUser?.real_name || '')
    setFormCustomer(rec.customer_name || '')
    setFormOrderNo(rec.order_no || '')
    setFormItems(rec.items && rec.items.length > 0 ? rec.items : [{ ...DEFAULT_ITEM }])
    setFormExpectedDate(rec.expected_date || '')
    setFormPlannedOrderDate(rec.planned_order_date || '')
    setFormRemark(rec.remark || '')
    setShowForm(true)
  }

  const addItem    = () => setFormItems(items => [...items, { ...DEFAULT_ITEM }])
  const removeItem = (idx: number) => setFormItems(items => items.filter((_, i) => i !== idx))
  const updateItem = (idx: number, field: keyof ProductItem, value: string) =>
    setFormItems(items => { const next = [...items]; next[idx] = { ...next[idx], [field]: value }; return next })

  const handleSubmit = async () => {
    const cleanItems = formItems.filter(it => it.item_code.trim() || it.item_name.trim() || it.quantity.trim())
    if (!formCustomer.trim() || cleanItems.length === 0 || !currentUser) return
    setSubmitting(true)

    const payload = {
      inquiry_date: formDate,
      salesperson: formSalesperson.trim() || null,
      customer_name: formCustomer.trim(),
      order_no: formOrderNo.trim() || null,
      items: cleanItems,
      planned_order_date: formPlannedOrderDate || null,
      expected_date: formExpectedDate || null,
      remark: formRemark.trim() || null,
      updated_at: new Date().toISOString(),
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
        alert('送出失敗: ' + (json?.error ?? '未知錯誤'))
        setSubmitting(false)
        return
      }

      // 組合通知訊息（僅新增時提示，編輯不重複打擾）
      if (!editingId) {
        const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
        const itemLines = cleanItems.map(it => `　・${it.item_name || it.item_code || '—'}　x${it.quantity || '-'}`).join('\n')
        const lines = [
          '📋 【產期詢問/預留單】',
          '',
          `📅 填單日期：${formDate}`,
          `👤 承辦業務：${formSalesperson.trim() || '-'}`,
          `🏢 客戶名稱：${formCustomer.trim()}`,
          `🔢 訂單編號：${formOrderNo.trim() || '-'}`,
          `📦 品項：\n${itemLines}`,
          `📅 預計發單日：${formPlannedOrderDate || '-'}`,
          `📅 希望交期(寄出日期)：${formExpectedDate || '-'}`,
          `💬 備註：${formRemark.trim() || '-'}`,
          '',
          `🏢 部門：${currentUser.department}`,
          `👤 填單人：${currentUser.real_name}`,
          `📌 狀態：🟡 待回覆`,
          `🕐 建立時間：${now}`,
        ]
        setNotifyPreview(lines.join('\n'))
      }

      resetForm()
      fetchRecords()
    } catch (e) {
      alert('送出失敗: ' + (e instanceof Error ? e.message : String(e)))
    }
    setSubmitting(false)
  }

  const handleCopyNotify = async () => {
    if (!notifyPreview) return
    try {
      await navigator.clipboard.writeText(notifyPreview)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = notifyPreview
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('確定要刪除此單據？')) return
    setDeletingId(id)
    try {
      const res = await fetch(`/api/production/schedule-confirm?id=${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!json?.success) alert('刪除失敗: ' + (json?.error ?? '未知錯誤'))
      else fetchRecords()
    } catch (e) {
      alert('刪除失敗: ' + (e instanceof Error ? e.message : String(e)))
    }
    setDeletingId(null)
  }

  const isAuthor = (record: Inquiry) => !!currentUser?.email && currentUser.email === record.author_email
  // 生管已回覆（同意/拒絕/完成）後，內容代表的是「回覆當下」的登記狀態，
  // 業務不應再靜默修改，避免回覆跟實際登記內容對不上
  const isEditable = (record: Inquiry) => isAuthor(record) && !record.planner_reply

  return (
    <div className="min-h-screen bg-[#050b14] text-slate-300">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.18),_transparent_45%)] pointer-events-none"></div>
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#030812_0%,#050d18_30%,#060f1d_70%,#050b14_100%)] pointer-events-none"></div>

      {/* Header */}
      <div className="bg-slate-900/70 border-b border-slate-800 backdrop-blur-xl sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <NavButton href="/" direction="home" title="回系統入口" className="px-3 py-1.5" />
            <div>
              <h1 className="text-3xl md:text-4xl font-black text-white tracking-wide">產期詢問/預留</h1>
              <p className="text-xs md:text-sm text-cyan-300 uppercase tracking-widest">產期詢問登記，回覆請至生產管理入口查看</p>
            </div>
          </div>
          <NavButton href="/" direction="home" title="回到首頁" className="px-4 py-2" />
        </div>
      </div>

      <div className="relative z-10 max-w-5xl mx-auto px-4 py-6">
        {errorMessage && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-red-600 bg-red-950/40 text-red-300">
            <div className="font-bold text-sm mb-1">載入失敗</div>
            <div className="text-xs leading-relaxed">{errorMessage}</div>
          </div>
        )}

        {/* 新增按鈕 */}
        <div className="mb-6">
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            className="flex items-center gap-2 px-5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold text-sm rounded-xl transition-colors shadow-lg shadow-amber-900/30"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            新增詢問/預留單
          </button>
        </div>

        {/* 新增/編輯表單 Modal */}
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-16 bg-black/70 backdrop-blur-sm overflow-y-auto">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl my-4">
              <div className="bg-slate-800 p-4 flex justify-between items-center border-b border-slate-700 rounded-t-2xl sticky top-0 z-10">
                <h3 className="text-white font-bold flex items-center gap-2">
                  <span className="w-2 h-6 bg-amber-500 rounded-full"></span>
                  {editingId ? `編輯詢問/預留單 #${editingId}` : '新增詢問/預留單'}
                </h3>
                <button onClick={resetForm} className="text-slate-400 hover:text-white transition-colors">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="p-6 space-y-4">
                {/* 填單日期 & 承辦業務 */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">填單日期 *</label>
                    <input
                      type="date"
                      value={formDate}
                      readOnly
                      className="w-full bg-slate-800/50 border border-slate-600 rounded-lg px-4 py-2.5 text-slate-400 cursor-not-allowed focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">承辦業務</label>
                    <input
                      value={formSalesperson}
                      onChange={e => setFormSalesperson(e.target.value)}
                      placeholder="請輸入承辦業務"
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors"
                      maxLength={50}
                    />
                  </div>
                </div>

                {/* 客戶名稱 & 訂單編號 */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">客戶名稱 *</label>
                    <input
                      value={formCustomer}
                      onChange={e => setFormCustomer(e.target.value)}
                      placeholder="請輸入客戶名稱"
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors"
                      maxLength={100}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">訂單編號（選填）</label>
                    <input
                      value={formOrderNo}
                      onChange={e => setFormOrderNo(e.target.value)}
                      placeholder="請輸入訂單編號"
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors"
                      maxLength={50}
                    />
                  </div>
                </div>

                {/* 品項（可多筆） */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs text-slate-400">品項 *</label>
                    <button
                      onClick={addItem}
                      className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      新增品項
                    </button>
                  </div>
                  <div className="space-y-2">
                    {formItems.map((item, idx) => (
                      <div key={idx} className="grid grid-cols-[1fr_1.5fr_80px_32px] gap-2 items-center">
                        <input
                          value={item.item_code}
                          onChange={e => updateItem(idx, 'item_code', e.target.value)}
                          placeholder="編碼（選填）"
                          className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:border-amber-500 focus:outline-none transition-colors"
                        />
                        <input
                          value={item.item_name}
                          onChange={e => updateItem(idx, 'item_name', e.target.value)}
                          placeholder="品名/規格"
                          className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:border-amber-500 focus:outline-none transition-colors"
                        />
                        <input
                          value={item.quantity}
                          onChange={e => updateItem(idx, 'quantity', e.target.value)}
                          placeholder="數量"
                          className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:border-amber-500 focus:outline-none transition-colors"
                        />
                        <button
                          onClick={() => removeItem(idx)}
                          disabled={formItems.length === 1}
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

                {/* 預計發單日 & 希望交期(寄出日期) */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">預計發單日</label>
                    <input
                      type="date"
                      value={formPlannedOrderDate}
                      onChange={e => setFormPlannedOrderDate(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">希望交期(寄出日期)</label>
                    <input
                      type="date"
                      value={formExpectedDate}
                      onChange={e => setFormExpectedDate(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors"
                    />
                  </div>
                </div>

                {/* 備註 */}
                <div>
                  <label className="block text-xs text-slate-400 mb-1">備註</label>
                  <textarea
                    value={formRemark}
                    onChange={e => setFormRemark(e.target.value)}
                    placeholder="其他備註事項"
                    rows={3}
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors resize-none"
                    maxLength={1000}
                  />
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button onClick={resetForm} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">取消</button>
                  <button
                    onClick={handleSubmit}
                    disabled={submitting || !formCustomer.trim() || formItems.every(it => !it.item_code.trim() && !it.item_name.trim() && !it.quantity.trim())}
                    className="px-6 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg transition-colors"
                  >
                    {submitting ? '處理中...' : '送出'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 記錄列表 */}
        {loading ? (
          <div className="text-center text-slate-500 py-20 text-sm">載入中...</div>
        ) : records.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-slate-600 text-4xl mb-4">📅</div>
            <div className="text-slate-500 text-sm">目前沒有詢問/預留單</div>
            <div className="text-slate-600 text-xs mt-1">點擊上方「新增詢問/預留單」開始建立</div>
          </div>
        ) : (
          <div className="space-y-3">
            {records.map(record => {
              const replyInfo = REPLY_CONFIG[record.planner_reply ?? 'pending']
              const items = record.items || []
              return (
                <div
                  key={record.id}
                  className="bg-slate-900/60 border border-slate-700 rounded-xl p-4 transition-all hover:border-slate-600"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {/* 標籤列 */}
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${replyInfo.class}`}>{replyInfo.label}</span>
                        <span className="text-xs text-slate-400">{record.author_name}</span>
                        {record.department && (
                          <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{record.department}</span>
                        )}
                        <span className="text-[10px] text-slate-600 font-mono ml-auto shrink-0">
                          {new Date(record.created_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      {/* 主要資訊 */}
                      <h3 className="text-white font-bold text-sm mb-1">{record.customer_name || '—'}</h3>
                      {record.inquiry_date && <div className="text-[10px] text-slate-500 mb-1">填單日期：{record.inquiry_date}</div>}
                      {items.length > 0 && (
                        <ul className="text-xs text-slate-300 mb-1 space-y-0.5">
                          {items.map((it, i) => (
                            <li key={i}>・{it.item_name || it.item_code || '—'}{it.quantity ? `　x${it.quantity}` : ''}</li>
                          ))}
                        </ul>
                      )}
                      <div className="flex items-center gap-4 text-xs text-slate-400 mb-1 flex-wrap">
                        {record.order_no && <span>訂單：{record.order_no}</span>}
                        {record.salesperson && <span>承辦業務：{record.salesperson}</span>}
                        {record.expected_date && <span>希望交期(寄出日期)：{record.expected_date}</span>}
                        {record.planned_order_date && <span>預計發單：{record.planned_order_date}</span>}
                      </div>
                      {record.remark && (
                        <p className="text-slate-500 text-xs mt-1 whitespace-pre-wrap">{record.remark}</p>
                      )}
                    </div>
                    {/* 操作：僅限本人、且生管尚未回覆時可編輯/刪除 */}
                    {isEditable(record) && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => openEdit(record)}
                          className="px-2.5 py-1 text-xs font-bold rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
                        >
                          編輯
                        </button>
                        <button
                          onClick={() => handleDelete(record.id)}
                          disabled={deletingId === record.id}
                          className="p-1.5 text-slate-600 hover:text-red-400 transition-colors disabled:opacity-40"
                          title="刪除"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 通知訊息預覽 Modal */}
      {notifyPreview && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-lg w-full space-y-4">
            <h2 className="text-lg font-bold text-white text-center">📨 通知訊息預覽</h2>
            <p className="text-xs text-slate-400 text-center">新增成功！可複製以下訊息貼到 LINE 群組通知相關人員</p>
            <pre className="bg-slate-950 border border-slate-700 rounded-lg p-4 text-sm text-slate-200 whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto select-all">{notifyPreview}</pre>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => setNotifyPreview(null)}
                className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm"
              >
                關閉
              </button>
              <button
                onClick={() => void handleCopyNotify()}
                className={`px-4 py-2 rounded font-bold text-sm transition-colors ${
                  copied
                    ? 'bg-emerald-600 text-white'
                    : 'bg-cyan-600 hover:bg-cyan-500 text-white'
                }`}
              >
                {copied ? '✅ 已複製！' : '📋 複製訊息'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
