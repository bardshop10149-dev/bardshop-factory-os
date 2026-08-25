'use client'

import { useState, useEffect, useCallback, type ReactNode } from 'react'
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

const REPLY_CONFIG: Record<string, { label: string; class: string; icon: ReactNode }> = {
  pending: {
    label: '待回覆', class: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3" /><circle cx="12" cy="12" r="9" /></svg>,
  },
  approved: {
    label: '已同意', class: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12l3 3 5-6" /><circle cx="12" cy="12" r="9" /></svg>,
  },
  rejected: {
    label: '已拒絕', class: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><path strokeLinecap="round" strokeLinejoin="round" d="M9 9l6 6m0-6l-6 6" /><circle cx="12" cy="12" r="9" /></svg>,
  },
  completed: {
    label: '已完成', class: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l3 3 8-9M5 20l3 3 12-13" /></svg>,
  },
}

const DEFAULT_ITEM: ProductItem = { item_code: '', item_name: '', quantity: '' }

const inputCls = 'w-full bg-[#08101c] border border-[#1e2a3f] rounded-[10px] px-4 py-3.5 text-[14px] leading-relaxed text-[#e7edf5] placeholder-[#445064] focus:outline-none focus:border-amber-500/70 transition-colors'
const labelCls = 'block text-[11px] font-bold uppercase tracking-wider text-[#5f7290] mb-2.5'

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

  // 除了備註以外全部必填；訂單編號必填但允許先送出、之後再補（唯一可後補的欄位）
  const validateForm = (): string | null => {
    if (!formSalesperson.trim()) return '請填寫承辦業務'
    if (!formCustomer.trim()) return '請填寫客戶名稱'
    const nonEmptyItems = formItems.filter(it => it.item_code.trim() || it.item_name.trim() || it.quantity.trim())
    if (nonEmptyItems.length === 0) return '請至少填寫一筆品項'
    const incomplete = nonEmptyItems.find(it => !it.item_code.trim() || !it.item_name.trim() || !it.quantity.trim())
    if (incomplete) return '品項的編碼、品名/規格、數量皆為必填，請補齊'
    if (!formPlannedOrderDate) return '請填寫預計發單日'
    if (!formExpectedDate) return '請填寫希望交期（寄出日期）'
    return null
  }

  const handleSubmit = async () => {
    if (!currentUser) return
    const validationError = validateForm()
    if (validationError) { alert(validationError); return }
    const cleanItems = formItems.filter(it => it.item_code.trim() || it.item_name.trim() || it.quantity.trim())
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

  // 補訂單編號：唯一允許「送出後才補」的欄位——即使生管已回覆也可以補
  // （訂單編號常常是送出詢問之後才拿到，跟登記內容本身無關，不受回覆鎖定限制）
  const [fillingOrderNoId, setFillingOrderNoId] = useState<number | null>(null)
  const handleFillOrderNo = async (record: Inquiry) => {
    const input = window.prompt(`補上「${record.customer_name}」這張單的訂單編號：`, record.order_no ?? '')
    if (input === null) return
    const orderNo = input.trim()
    if (!orderNo) { alert('訂單編號不可為空'); return }
    setFillingOrderNoId(record.id)
    try {
      const res = await fetch('/api/production/schedule-confirm', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: record.id, fields: { order_no: orderNo, updated_at: new Date().toISOString() } }),
      })
      const json = await res.json()
      if (!json?.success) throw new Error(json?.error ?? '未知錯誤')
      fetchRecords()
    } catch (e) {
      alert('補訂單編號失敗: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setFillingOrderNoId(null)
    }
  }

  const isAuthor = (record: Inquiry) => !!currentUser?.email && currentUser.email === record.author_email
  // 生管已回覆（同意/拒絕/完成）後，內容代表的是「回覆當下」的登記狀態，
  // 業務不應再靜默修改，避免回覆跟實際登記內容對不上
  const isEditable = (record: Inquiry) => isAuthor(record) && !record.planner_reply

  return (
    <div className="min-h-screen bg-[#050b14] text-[#cbd5e1] bg-[radial-gradient(1200px_500px_at_15%_-10%,rgba(245,165,36,0.06),transparent_60%)]">
      <div className="max-w-[1180px] mx-auto px-8 py-11">

        {/* Nav */}
        <NavButton href="/" direction="back" title="回系統首頁" />

        {/* Header */}
        <div className="mt-5 flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-[28px] font-extrabold text-[#f3f6fb] tracking-tight">產期詢問 / 預留</h1>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/35 text-amber-400 text-xs font-bold">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                業務登記
              </span>
            </div>
            <p className="text-sm text-[#6c7d99] mt-2">登記交期詢問與產能預留，生產管理將於「生管入口」回覆同意 / 拒絕</p>
          </div>
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            className="mt-1 flex items-center gap-2 px-5 py-3 rounded-[11px] bg-gradient-to-b from-amber-400 to-amber-500 text-[#241a04] font-bold text-sm shadow-lg shadow-amber-900/30 hover:from-amber-300 hover:to-amber-400 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            新增詢問 / 預留單
          </button>
        </div>

        {errorMessage && (
          <div className="mt-6 px-4 py-3 rounded-xl border border-red-600 bg-red-950/40 text-red-300">
            <div className="font-bold text-sm mb-1">載入失敗</div>
            <div className="text-xs leading-relaxed">{errorMessage}</div>
          </div>
        )}

        {/* 新增/編輯表單 Modal */}
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-start justify-center p-6 pt-16 bg-black/80 backdrop-blur-sm overflow-y-auto overflow-x-hidden">
            <div className="bg-[#0c1526] border border-[#263349] rounded-[22px] w-full max-w-[760px] shadow-2xl my-4 overflow-hidden">
              <div className="flex items-center justify-between px-8 py-6 border-b border-[#182131]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-[11px] bg-amber-500/15 border border-amber-500/35 text-amber-400 flex items-center justify-center">
                    <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                  </div>
                  <h3 className="text-[17px] font-bold text-[#f3f6fb]">
                    {editingId ? `編輯詢問 / 預留單 #${editingId}` : '新增詢問 / 預留單'}
                  </h3>
                </div>
                <button onClick={resetForm} className="w-8 h-8 rounded-[9px] flex items-center justify-center text-[#5f7290] hover:text-white transition-colors">
                  <svg className="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>

              <div className="px-8 pt-7 pb-3 flex flex-col gap-7">
                {/* 填單日期 & 承辦業務 */}
                <div className="grid grid-cols-2 gap-5">
                  <div>
                    <label className={labelCls}>填單日期</label>
                    <input type="date" value={formDate} readOnly className={`${inputCls} text-[#5f7290] cursor-not-allowed`} />
                  </div>
                  <div>
                    <label className={labelCls}>承辦業務 <span className="text-amber-500">*</span></label>
                    <input
                      value={formSalesperson}
                      onChange={e => setFormSalesperson(e.target.value)}
                      placeholder="請輸入承辦業務"
                      className={inputCls}
                      maxLength={50}
                    />
                  </div>
                </div>

                {/* 客戶名稱 & 訂單編號 */}
                <div className="grid grid-cols-2 gap-5">
                  <div>
                    <label className={labelCls}>客戶名稱 <span className="text-amber-500">*</span></label>
                    <input
                      value={formCustomer}
                      onChange={e => setFormCustomer(e.target.value)}
                      placeholder="請輸入客戶名稱"
                      className={inputCls}
                      maxLength={100}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>訂單編號 <span className="text-amber-500">*</span><span className="text-[#5f7290] normal-case tracking-normal font-medium">（可先送出，之後再補）</span></label>
                    <input
                      value={formOrderNo}
                      onChange={e => setFormOrderNo(e.target.value)}
                      placeholder="尚未拿到可留空，之後補上"
                      className={inputCls}
                      maxLength={50}
                    />
                  </div>
                </div>

                {/* 品項（可多筆） */}
                <div>
                  <div className="flex items-center justify-between mb-3.5">
                    <label className={`${labelCls} mb-0`}>品項 <span className="text-amber-500">*</span></label>
                    <button
                      onClick={addItem}
                      className="flex items-center gap-1.5 text-xs font-bold text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M12 4v16m8-8H4" />
                      </svg>
                      新增品項
                    </button>
                  </div>
                  <div className="flex flex-col gap-3">
                    {formItems.map((item, idx) => (
                      <div key={idx} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_100px_32px] gap-2.5 items-center">
                        <input
                          value={item.item_code}
                          onChange={e => updateItem(idx, 'item_code', e.target.value)}
                          placeholder="編碼"
                          className={`${inputCls} min-w-0 text-sm py-3`}
                        />
                        <input
                          value={item.item_name}
                          onChange={e => updateItem(idx, 'item_name', e.target.value)}
                          placeholder="品名/規格"
                          className={`${inputCls} min-w-0 text-sm py-3`}
                        />
                        <input
                          value={item.quantity}
                          onChange={e => updateItem(idx, 'quantity', e.target.value)}
                          placeholder="數量"
                          className={`${inputCls} min-w-0 text-sm py-3`}
                        />
                        <button
                          onClick={() => removeItem(idx)}
                          disabled={formItems.length === 1}
                          className="flex items-center justify-center w-8 h-8 rounded-lg text-[#445064] hover:text-rose-400 hover:bg-rose-900/20 transition-colors disabled:opacity-30"
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
                <div className="grid grid-cols-2 gap-5">
                  <div>
                    <label className={labelCls}>預計發單日 <span className="text-amber-500">*</span></label>
                    <input
                      type="date"
                      value={formPlannedOrderDate}
                      onChange={e => setFormPlannedOrderDate(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>希望交期（寄出日期） <span className="text-amber-500">*</span></label>
                    <input
                      type="date"
                      value={formExpectedDate}
                      onChange={e => setFormExpectedDate(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                </div>

                {/* 備註 */}
                <div>
                  <label className={labelCls}>備註 <span className="text-[#5f7290] normal-case tracking-normal font-medium">（選填）</span></label>
                  <textarea
                    value={formRemark}
                    onChange={e => setFormRemark(e.target.value)}
                    placeholder="其他備註事項"
                    rows={3}
                    className={`${inputCls} resize-none`}
                    maxLength={1000}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 px-8 pt-6 pb-8 mt-1 border-t border-[#182131]">
                <div className="flex items-center gap-2 text-xs text-[#4c5c78]">
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="9" y="9" width="11" height="11" rx="2" /><path strokeLinecap="round" strokeLinejoin="round" d="M5 15V5a2 2 0 012-2h10" /></svg>
                  送出後可複製通知訊息，貼到 LINE 群組通知
                </div>
                <div className="flex gap-2.5 shrink-0">
                  <button onClick={resetForm} className="px-5 py-2.5 rounded-[10px] border border-[#26344a] text-[#93a4c0] text-[13.5px] font-semibold hover:bg-white/5 transition-colors">取消</button>
                  <button
                    onClick={handleSubmit}
                    disabled={submitting}
                    className="px-6 py-2.5 rounded-[10px] bg-gradient-to-b from-amber-400 to-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-[#241a04] text-[13.5px] font-bold transition-colors"
                  >
                    {submitting ? '處理中...' : '送出詢問'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 記錄列表 */}
        <div className="flex items-center justify-between mt-9 mb-4">
          <span className="text-[13px] font-semibold text-[#5f7290]">共 {records.length} 筆詢問</span>
        </div>

        {loading ? (
          <div className="text-center text-slate-500 py-20 text-sm">載入中...</div>
        ) : records.length === 0 ? (
          <div className="text-center py-20 border-2 border-dashed border-[#1c2739] rounded-2xl">
            <svg className="w-9 h-9 mx-auto mb-3 text-[#334155]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3M3 11h18M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" /></svg>
            <div className="text-slate-500 text-sm">目前沒有詢問/預留單</div>
            <div className="text-slate-600 text-xs mt-1">點擊上方「新增詢問/預留單」開始建立</div>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {records.map(record => {
              const replyInfo = REPLY_CONFIG[record.planner_reply ?? 'pending']
              const items = record.items || []
              return (
                <div
                  key={record.id}
                  className="bg-[#0b1220] border border-[#1c2739] rounded-[18px] px-6 py-5 flex flex-col gap-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="text-[17px] font-bold text-[#f3f6fb]">{record.customer_name || '—'}</span>
                      {record.order_no ? (
                        <span className="font-mono text-xs text-[#7f93b3] bg-[#101a2c] border border-[#1c2739] rounded-[7px] px-2.5 py-1">{record.order_no}</span>
                      ) : isAuthor(record) ? (
                        <button
                          onClick={() => void handleFillOrderNo(record)}
                          disabled={fillingOrderNoId === record.id}
                          className="text-xs font-bold text-amber-400 bg-amber-500/10 border border-amber-500/35 border-dashed rounded-[7px] px-2.5 py-1 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
                          title="訂單編號拿到後可隨時補上（不受回覆狀態限制）"
                        >
                          {fillingOrderNoId === record.id ? '補登中…' : '⚠ 補訂單編號'}
                        </button>
                      ) : (
                        <span className="text-xs text-[#5f7290] border border-[#1c2739] border-dashed rounded-[7px] px-2.5 py-1">訂單編號待補</span>
                      )}
                    </div>
                    <span className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold border shrink-0 ${replyInfo.class}`}>
                      <span className="w-[13px] h-[13px]">{replyInfo.icon}</span>
                      {replyInfo.label}
                    </span>
                  </div>

                  {items.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {items.map((it, i) => (
                        <span key={i} className="inline-flex items-center gap-1.5 bg-[#101a2c] border border-[#1c2739] rounded-[9px] px-3 py-1.5 text-[12.5px] text-[#b7c4da]">
                          <b className="text-[#e7edf5] font-semibold">{it.item_name || it.item_code || '—'}</b>
                          {it.quantity && <span className="text-[#6c7d99]">x{it.quantity}</span>}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-[#93a4c0]">
                    {record.salesperson && <span>承辦業務 <b className="text-[#cdd8ea] font-semibold">{record.salesperson}</b></span>}
                    {record.planned_order_date && <span>預計發單 <b className="text-[#cdd8ea] font-semibold">{record.planned_order_date}</b></span>}
                    {record.expected_date && <span>希望交期 <b className="text-[#cdd8ea] font-semibold">{record.expected_date}</b></span>}
                  </div>

                  {record.remark && (
                    <p className="text-[13px] text-[#6c7d99] leading-relaxed whitespace-pre-wrap">{record.remark}</p>
                  )}

                  <div className="flex items-center justify-between border-t border-[#151f30] pt-3.5">
                    <div className="flex items-center gap-2 text-xs text-[#5f7290]">
                      <span>{record.author_name}</span>
                      {record.department && <span className="bg-[#101a2c] border border-[#1c2739] rounded-md px-2 py-0.5 text-[#7f93b3]">{record.department}</span>}
                      <span className="text-[#4c5c78]">
                        ・{new Date(record.created_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    {isEditable(record) && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEdit(record)}
                          className="px-3 py-1.5 text-xs font-bold rounded-lg bg-[#101a2c] hover:bg-[#182338] text-[#b7c4da] transition-colors"
                        >
                          編輯
                        </button>
                        <button
                          onClick={() => handleDelete(record.id)}
                          disabled={deletingId === record.id}
                          className="w-[30px] h-[30px] rounded-lg flex items-center justify-center text-[#5f7290] hover:text-rose-400 hover:bg-rose-900/10 transition-colors disabled:opacity-40"
                          title="刪除"
                        >
                          <svg className="w-[15px] h-[15px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
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
