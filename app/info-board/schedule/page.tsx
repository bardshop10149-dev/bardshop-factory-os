'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { NavButton } from '../../../components/NavButton'
import { supabase } from '../../../lib/supabaseClient'

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

/**
 * 由「已儲存的詢問單」產生 LINE 通知訊息。
 * 原本只有剛送出時才用表單當下的值組一次訊息，離開頁面後就再也拿不到——
 * 改成純函式吃 record，讓列表上每一筆隨時都能重新產生並複製（2026-09-03 業務端需求）。
 */
function buildNotifyMessage(r: Inquiry): string {
  const items = r.items ?? []
  const itemLines = items.length > 0
    ? items.map(it => `　・${it.item_name || it.item_code || '—'}　x${it.quantity || '-'}`).join('\n')
    : '　・—'
  const statusText = r.planner_reply === 'approved' ? '🟢 已同意'
    : r.planner_reply === 'rejected' ? '🔴 已拒絕'
    : r.planner_reply === 'completed' ? '🟣 已完成'
    : '🟡 待回覆'
  return [
    '📋 【產期詢問/預留單】',
    '',
    `📅 填單日期：${r.inquiry_date || '-'}`,
    `👤 承辦業務：${r.salesperson || '-'}`,
    `🏢 客戶名稱：${r.customer_name || '-'}`,
    `🔢 訂單編號：${r.order_no || '-'}`,
    `📦 品項：\n${itemLines}`,
    `📅 預計發單日：${r.planned_order_date || '-'}`,
    `📅 希望交期(寄出日期)：${r.expected_date || '-'}`,
    `💬 備註：${r.remark || '-'}`,
    '',
    `🏢 部門：${r.department || '-'}`,
    `👤 填單人：${r.author_name}`,
    `📌 狀態：${statusText}`,
    `🕐 建立時間：${new Date(r.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`,
  ].join('\n')
}

const inputCls = 'w-full bg-[#08101c] border border-[#1e2a3f] rounded-[10px] px-4 py-3.5 text-[14px] leading-relaxed text-[#e7edf5] placeholder-[#445064] focus:outline-none focus:border-amber-500/70 transition-colors'
const labelCls = 'block text-[11px] font-bold uppercase tracking-wider text-[#5f7290] mb-2.5'

export default function ScheduleInquiryPage() {
  const [records, setRecords] = useState<Inquiry[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [currentUser, setCurrentUser] = useState<{ real_name: string; department: string; email: string } | null>(null)
  const [notifyPreview, setNotifyPreview] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // 列表展開／逐筆複製：離開頁面後仍要看得到完整內容、也能重新複製通知訊息
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [copiedId, setCopiedId] = useState<number | null>(null)

  const toggleExpand = (id: number) => setExpandedIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const copyRecordMessage = async (record: Inquiry) => {
    const text = buildNotifyMessage(record)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 非安全來源或瀏覽器不支援時的退路
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopiedId(record.id)
    setTimeout(() => setCopiedId(prev => (prev === record.id ? null : prev)), 2000)
  }

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
    setShowForm(false)
  }

  const addItem    = () => setFormItems(items => [...items, { ...DEFAULT_ITEM }])
  const removeItem = (idx: number) => setFormItems(items => items.filter((_, i) => i !== idx))
  const updateItem = (idx: number, field: keyof ProductItem, value: string) =>
    setFormItems(items => { const next = [...items]; next[idx] = { ...next[idx], [field]: value }; return next })

  // ── 品項編碼自動完成：輸入 2 字以上即模糊搜尋 bom 產品主檔（編碼與中文品名皆納入比對），
  //    點選建議後自動帶入品名 ──
  const [itemSuggest, setItemSuggest] = useState<{ idx: number; list: { code: string; name: string }[] } | null>(null)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestSeqRef = useRef(0)

  const searchItemSuggestions = useCallback((idx: number, raw: string) => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    const q = raw.trim()
    if (q.length < 2) { setItemSuggest(null); return }
    const seq = ++suggestSeqRef.current
    suggestTimerRef.current = setTimeout(async () => {
      // 跳脫 PostgREST or 條件中的特殊字元（逗號/括號），避免使用者輸入破壞查詢
      const safe = q.replace(/[,()]/g, ' ')
      // 資料來源用 ERP 同步的銷售訂單明細（erp_so_lines：品號＋中文品名），
      // 以 ERP 為準——不用系統內人工維護的 bom 表（該表已淘汰）
      const { data, error } = await supabase
        .from('erp_so_lines')
        .select('mbp_part, description, synced_at')
        .or(`mbp_part.ilike.%${safe}%,description.ilike.%${safe}%`)
        .order('synced_at', { ascending: false })
        .limit(200)
      if (error || seq !== suggestSeqRef.current) return
      const uniq = new Map<string, string>()
      for (const r of (data ?? []) as { mbp_part: string | null; description: string | null }[]) {
        const code = (r.mbp_part ?? '').trim()
        if (!code || uniq.has(code)) continue
        uniq.set(code, (r.description ?? '').trim())
        if (uniq.size >= 15) break
      }
      setItemSuggest({ idx, list: [...uniq.entries()].map(([code, name]) => ({ code, name })) })
    }, 300)
  }, [])

  const pickItemSuggestion = useCallback((idx: number, code: string, name: string) => {
    setFormItems(items => {
      const next = [...items]
      next[idx] = { ...next[idx], item_code: code, item_name: name }
      return next
    })
    setItemSuggest(null)
  }, [])

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
      // 送出後不可更改（僅訂單編號可於清單上補填），故只有新增、沒有編輯
      const res = await fetch('/api/production/schedule-confirm', {
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

      // 用與列表相同的產生器組訊息，確保「送出後預覽」與「事後從列表複製」格式一致
      setNotifyPreview(buildNotifyMessage({
        id: -1,
        inquiry_date: formDate,
        customer_name: formCustomer.trim(),
        order_no: formOrderNo.trim(),
        salesperson: formSalesperson.trim(),
        items: cleanItems,
        planned_order_date: formPlannedOrderDate,
        expected_date: formExpectedDate,
        remark: formRemark.trim(),
        planner_reply: null,
        author_name: currentUser.real_name,
        author_email: currentUser.email,
        department: currentUser.department,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }))

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

  // 補訂單編號：唯一允許「送出後才補」的欄位——即使生管已回覆也可以補
  // （訂單編號常常是送出詢問之後才拿到，跟登記內容本身無關，不受回覆鎖定限制）。
  // 直接在清單列上輸入，不用彈跳對話框。
  const [orderNoDrafts, setOrderNoDrafts] = useState<Record<number, string>>({})
  const [savingOrderNoId, setSavingOrderNoId] = useState<number | null>(null)
  const saveOrderNo = async (record: Inquiry) => {
    const orderNo = (orderNoDrafts[record.id] ?? '').trim()
    if (!orderNo) { alert('請先輸入訂單編號'); return }
    setSavingOrderNoId(record.id)
    try {
      const res = await fetch('/api/production/schedule-confirm', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: record.id, fields: { order_no: orderNo, updated_at: new Date().toISOString() } }),
      })
      const json = await res.json()
      if (!json?.success) throw new Error(json?.error ?? '未知錯誤')
      setOrderNoDrafts(prev => { const n = { ...prev }; delete n[record.id]; return n })
      fetchRecords()
    } catch (e) {
      alert('補訂單編號失敗: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSavingOrderNoId(null)
    }
  }

  const isAuthor = (record: Inquiry) => !!currentUser?.email && currentUser.email === record.author_email

  // 全文搜尋：涵蓋客戶/訂單編號/承辦業務/填單人/部門/品項（編碼+品名+數量）/
  // 日期/備註/回覆狀態，全部欄位都比對得到
  const [searchTerm, setSearchTerm] = useState('')
  const filteredRecords = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    if (!q) return records
    return records.filter(r => {
      const replyLabel = REPLY_CONFIG[r.planner_reply ?? 'pending']?.label ?? ''
      const haystack = [
        r.customer_name, r.order_no, r.salesperson, r.author_name, r.department,
        r.inquiry_date, r.planned_order_date, r.expected_date, r.remark, replyLabel,
        ...(r.items ?? []).flatMap(it => [it.item_code, it.item_name, it.quantity]),
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [records, searchTerm])

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
                  <h3 className="text-[17px] font-bold text-[#f3f6fb]">新增詢問 / 預留單</h3>
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
                    <label className={labelCls}>承辦業務 <span className="text-amber-500">*</span><span className="text-[#5f7290] normal-case tracking-normal font-medium">（已依登入帳號帶入，可修改）</span></label>
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
                        <div className="relative min-w-0">
                          <input
                            value={item.item_code}
                            onChange={e => { updateItem(idx, 'item_code', e.target.value); searchItemSuggestions(idx, e.target.value) }}
                            onBlur={() => setTimeout(() => setItemSuggest(prev => (prev?.idx === idx ? null : prev)), 150)}
                            onKeyDown={e => { if (e.key === 'Escape') setItemSuggest(null) }}
                            placeholder="編碼（可輸入中文搜尋）"
                            className={`${inputCls} min-w-0 text-sm py-3`}
                          />
                          {itemSuggest?.idx === idx && itemSuggest.list.length > 0 && (
                            <div className="absolute left-0 right-[-260px] top-full mt-1 z-30 bg-[#0d1626] border border-[#2a3b57] rounded-[10px] shadow-2xl max-h-64 overflow-y-auto">
                              {itemSuggest.list.map(s => (
                                <button
                                  key={s.code}
                                  onMouseDown={e => { e.preventDefault(); pickItemSuggestion(idx, s.code, s.name) }}
                                  className="w-full text-left px-3.5 py-2.5 hover:bg-amber-500/10 border-b border-[#1a2740] last:border-b-0 transition-colors"
                                >
                                  <div className="font-mono text-[13px] text-amber-300">{s.code}</div>
                                  <div className="text-[12px] text-[#8fa1bd] truncate">{s.name}</div>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
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
        <div className="flex items-center justify-between gap-4 mt-9 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-[480px]">
            <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#5f7290] pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="搜尋客戶 / 單號 / 品項 / 備註…"
              className="w-full bg-[#08101c] border border-[#1e2a3f] rounded-[10px] pl-10 pr-9 py-2.5 text-[13.5px] text-[#e7edf5] placeholder-[#445064] focus:outline-none focus:border-amber-500/70 transition-colors"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-[#5f7290] hover:text-white transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
          <span className="text-[13px] font-semibold text-[#5f7290] shrink-0">
            {searchTerm.trim() ? `符合 ${filteredRecords.length} / ${records.length} 筆` : `共 ${records.length} 筆詢問`}
          </span>
        </div>

        {loading ? (
          <div className="text-center text-slate-500 py-20 text-sm">載入中...</div>
        ) : records.length === 0 ? (
          <div className="text-center py-20 border-2 border-dashed border-[#1c2739] rounded-2xl">
            <svg className="w-9 h-9 mx-auto mb-3 text-[#334155]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3M3 11h18M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" /></svg>
            <div className="text-slate-500 text-sm">目前沒有詢問/預留單</div>
            <div className="text-slate-600 text-xs mt-1">點擊上方「新增詢問/預留單」開始建立</div>
          </div>
        ) : filteredRecords.length === 0 ? (
          <div className="text-center py-16 border-2 border-dashed border-[#1c2739] rounded-2xl">
            <div className="text-slate-500 text-sm">沒有符合「{searchTerm.trim()}」的詢問單</div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filteredRecords.map(record => {
              const replyInfo = REPLY_CONFIG[record.planner_reply ?? 'pending']
              const items = record.items || []
              const itemsSummary = items.map(it => `${it.item_name || it.item_code || '—'}x${it.quantity || '-'}`).join('、')
              const expanded = expandedIds.has(record.id)
              return (
                <div key={record.id} className="bg-[#0b1220] border border-[#1c2739] rounded-[12px] overflow-hidden">
                <div
                  className="px-4 py-2.5 flex items-center gap-3 min-w-0"
                  title={record.remark ? `備註：${record.remark}` : undefined}
                >
                  {/* 展開/收合 */}
                  <button
                    onClick={() => toggleExpand(record.id)}
                    aria-expanded={expanded}
                    title={expanded ? '收合詳細資訊' : '展開詳細資訊'}
                    className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-[#5f7290] hover:text-white hover:bg-[#1c2739] transition-colors"
                  >
                    <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>

                  {/* 狀態 */}
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border shrink-0 ${replyInfo.class}`}>
                    <span className="w-[11px] h-[11px]">{replyInfo.icon}</span>
                    {replyInfo.label}
                  </span>

                  {/* 客戶 */}
                  <span className="text-[14px] font-bold text-[#f3f6fb] shrink-0 max-w-[180px] truncate">{record.customer_name || '—'}</span>

                  {/* 訂單編號 / 回填欄位 */}
                  {record.order_no ? (
                    <span className="font-mono text-xs text-[#7f93b3] bg-[#101a2c] border border-[#1c2739] rounded-[6px] px-2 py-0.5 shrink-0">{record.order_no}</span>
                  ) : isAuthor(record) ? (
                    <span className="flex items-center gap-1 shrink-0">
                      <input
                        value={orderNoDrafts[record.id] ?? ''}
                        onChange={e => setOrderNoDrafts(prev => ({ ...prev, [record.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') void saveOrderNo(record) }}
                        placeholder="補訂單編號…"
                        className="w-32 px-2 py-1 rounded-[6px] bg-[#08101c] border border-amber-500/40 border-dashed text-xs font-mono text-[#e7edf5] placeholder-[#5f7290] focus:outline-none focus:border-amber-500/80"
                      />
                      <button
                        onClick={() => void saveOrderNo(record)}
                        disabled={savingOrderNoId === record.id || !(orderNoDrafts[record.id] ?? '').trim()}
                        className="px-2 py-1 rounded-[6px] bg-amber-500/15 border border-amber-500/40 text-amber-400 text-xs font-bold hover:bg-amber-500/25 disabled:opacity-40 transition-colors"
                      >
                        {savingOrderNoId === record.id ? '…' : '存'}
                      </button>
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#5f7290] border border-[#1c2739] border-dashed rounded-[6px] px-2 py-0.5 shrink-0">單號待補</span>
                  )}

                  {/* 品項摘要（吃剩餘空間，截斷） */}
                  <span className="text-[12.5px] text-[#b7c4da] flex-1 min-w-0 truncate" title={itemsSummary}>{itemsSummary || '—'}</span>

                  {/* 日期 */}
                  <span className="text-[11.5px] text-[#93a4c0] shrink-0 whitespace-nowrap hidden md:inline">
                    發單 <b className="text-[#cdd8ea]">{record.planned_order_date || '—'}</b>
                    <span className="mx-1.5 text-[#3c4a62]">|</span>
                    交期 <b className="text-[#cdd8ea]">{record.expected_date || '—'}</b>
                  </span>

                  {/* 填單人・時間 */}
                  <span className="text-[11px] text-[#5f7290] shrink-0 whitespace-nowrap hidden lg:inline">
                    {record.author_name}・{new Date(record.created_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit' })}
                  </span>

                  {/* 複製通知訊息（不必展開也能直接複製） */}
                  <button
                    onClick={() => void copyRecordMessage(record)}
                    title="複製此筆的通知訊息，可直接貼到 LINE 群組"
                    className={`shrink-0 px-2 py-1 rounded-[6px] text-[11px] font-bold border transition-colors ${
                      copiedId === record.id
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                        : 'bg-[#101a2c] border-[#1c2739] text-[#7f93b3] hover:text-white hover:border-[#334a6b]'
                    }`}
                  >
                    {copiedId === record.id ? '✅ 已複製' : '📋 複製'}
                  </button>
                </div>

                {/* 展開後的詳細資訊 */}
                {expanded && (
                  <div className="border-t border-[#1c2739] bg-[#080e18] px-4 py-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 mb-4">
                      {[
                        ['填單日期', record.inquiry_date || '—'],
                        ['承辦業務', record.salesperson || '—'],
                        ['客戶名稱', record.customer_name || '—'],
                        ['訂單編號', record.order_no || '（待補）'],
                        ['預計發單日', record.planned_order_date || '—'],
                        ['希望交期（寄出日期）', record.expected_date || '—'],
                        ['填單人／部門', `${record.author_name}${record.department ? `／${record.department}` : ''}`],
                        ['建立時間', new Date(record.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })],
                      ].map(([label, value]) => (
                        <div key={label} className="min-w-0">
                          <div className="text-[10px] font-mono uppercase tracking-wider text-[#5f7290] mb-0.5">{label}</div>
                          <div className="text-[13px] text-[#e7edf5] break-words">{value}</div>
                        </div>
                      ))}
                    </div>

                    <div className="mb-4">
                      <div className="text-[10px] font-mono uppercase tracking-wider text-[#5f7290] mb-1.5">品項（{items.length}）</div>
                      {items.length === 0 ? (
                        <div className="text-[13px] text-[#5f7290]">—</div>
                      ) : (
                        <div className="rounded-[8px] border border-[#1c2739] overflow-hidden">
                          <table className="w-full text-[12.5px]">
                            <thead className="bg-[#101a2c] text-[#7f93b3]">
                              <tr>
                                <th className="text-left px-3 py-1.5 font-semibold w-40">品項編碼</th>
                                <th className="text-left px-3 py-1.5 font-semibold">品名／規格</th>
                                <th className="text-right px-3 py-1.5 font-semibold w-24">數量</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map((it, i) => (
                                <tr key={i} className="border-t border-[#1c2739]">
                                  <td className="px-3 py-1.5 font-mono text-[#b7c4da] align-top">{it.item_code || '—'}</td>
                                  <td className="px-3 py-1.5 text-[#e7edf5] break-words">{it.item_name || '—'}</td>
                                  <td className="px-3 py-1.5 text-right font-mono text-[#e7edf5]">{it.quantity || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-[10px] font-mono uppercase tracking-wider text-[#5f7290] mb-0.5">備註</div>
                      <div className="text-[13px] text-[#e7edf5] whitespace-pre-wrap break-words">{record.remark || '—'}</div>
                    </div>

                    <div className="flex items-center gap-2 mt-4 pt-3 border-t border-[#1c2739]">
                      <button
                        onClick={() => void copyRecordMessage(record)}
                        className={`px-3 py-1.5 rounded-[8px] text-xs font-bold border transition-colors ${
                          copiedId === record.id
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                            : 'bg-amber-500/15 border-amber-500/40 text-amber-400 hover:bg-amber-500/25'
                        }`}
                      >
                        {copiedId === record.id ? '✅ 已複製！可貼到 LINE 群組' : '📋 複製通知訊息'}
                      </button>
                      <span className="text-[11px] text-[#5f7290]">複製後可直接貼到 LINE 群組通知相關人員</span>
                    </div>
                  </div>
                )}
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
