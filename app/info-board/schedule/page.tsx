'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { NavButton } from '../../../components/NavButton'
import { supabase } from '../../../lib/supabaseClient'

interface Inquiry {
  id: number
  form_date: string | null
  customer_name: string
  order_no: string | null
  product_name: string
  quantity: number | null
  expected_date: string | null
  handler_name: string | null
  planned_order_date: string | null
  remark: string | null
  status: 'pending' | 'confirmed' | 'reserved' | 'completed'
  author_name: string
  author_email: string | null
  department: string | null
  created_at: string
  updated_at: string
}

const STATUS_MAP: Record<string, { label: string; class: string }> = {
  pending: { label: '待處理', class: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  confirmed: { label: '已確認', class: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  reserved: { label: '已預留', class: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  completed: { label: '已完成', class: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' },
}

export default function ScheduleInquiryPage() {
  const [records, setRecords] = useState<Inquiry[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [currentUser, setCurrentUser] = useState<{ real_name: string; department: string; email: string } | null>(null)
  const [notifyPreview, setNotifyPreview] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [orderNoModal, setOrderNoModal] = useState<{ id: number; current: string } | null>(null)
  const [orderNoInput, setOrderNoInput] = useState('')
  const [notifyPhotoUploading, setNotifyPhotoUploading] = useState(false)
  const [notifyPhotoUploaded, setNotifyPhotoUploaded] = useState(false)
  const notifyPhotoInputRef = useRef<HTMLInputElement>(null)

  // 表單欄位
  const [formDate, setFormDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [formCustomer, setFormCustomer] = useState('')
  const [formOrderNo, setFormOrderNo] = useState('')
  const [formProduct, setFormProduct] = useState('')
  const [formQuantity, setFormQuantity] = useState('')
  const [formExpectedDate, setFormExpectedDate] = useState('')
  const [formHandler, setFormHandler] = useState('')
  const [formPlannedOrderDate, setFormPlannedOrderDate] = useState('')
  const [formRemark, setFormRemark] = useState('')

  useEffect(() => {
    const fetchUser = async () => {
      const { data: authData } = await supabase.auth.getUser()
      const email = authData.user?.email || ''
      if (!email) return
      const { data } = await supabase
        .from('members')
        .select('real_name, department, email')
        .eq('email', email)
        .maybeSingle()
      if (data) {
        setCurrentUser({ real_name: data.real_name || '-', department: data.department || '-', email: data.email || email })
      }
    }
    fetchUser()
  }, [])

  const fetchRecords = useCallback(async () => {
    setLoading(true)
    setErrorMessage('')
    const { data, error } = await supabase
      .from('schedule_inquiries')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      const msg = error.message || '載入失敗'
      if (/schedule_inquiries/.test(msg) || /schema cache/i.test(msg)) {
        setErrorMessage('資料庫尚未建立 schedule_inquiries 表，請執行 migration：sql/20260331_add_schedule_inquiry.sql')
      } else {
        setErrorMessage(`載入失敗：${msg}`)
      }
      setRecords([])
      setLoading(false)
      return
    }
    setRecords((data as Inquiry[]) || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchRecords() }, [fetchRecords])

  const resetForm = () => {
    setFormDate(new Date().toISOString().slice(0, 10))
    setFormCustomer('')
    setFormOrderNo('')
    setFormProduct('')
    setFormQuantity('')
    setFormExpectedDate('')
    setFormHandler('')
    setFormPlannedOrderDate('')
    setFormRemark('')
    setShowForm(false)
  }

  const handleSubmit = async () => {
    if (!formCustomer.trim() || !formProduct.trim() || !currentUser) return
    setSubmitting(true)

    const { error } = await supabase.from('schedule_inquiries').insert({
      form_date: formDate,
      customer_name: formCustomer.trim(),
      order_no: formOrderNo.trim() || null,
      product_name: formProduct.trim(),
      quantity: formQuantity ? parseInt(formQuantity, 10) : null,
      expected_date: formExpectedDate || null,
      handler_name: formHandler.trim() || null,
      planned_order_date: formPlannedOrderDate || null,
      remark: formRemark.trim() || null,
      author_name: currentUser.real_name,
      author_email: currentUser.email,
      department: currentUser.department,
    })

    if (error) {
      alert('新增失敗: ' + error.message)
      setSubmitting(false)
      return
    }

    // 組合通知訊息
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
    const lines = [
      '📋 【產期詢問/預留單】',
      '',
      `📅 填單日期：${formDate}`,
      `👤 承辦人：${formHandler.trim() || '-'}`,
      `🏢 客戶名稱：${formCustomer.trim()}`,
      `🔢 訂單編號：${formOrderNo.trim() || '-'}`,
      `📦 品名/規格：${formProduct.trim()}`,
      `📊 數量：${formQuantity || '-'}`,
      `📅 預計發單日：${formPlannedOrderDate || '-'}`,
      `📅 希望交期(寄出日期)：${formExpectedDate || '-'}`,
      `💬 備註：${formRemark.trim() || '-'}`,
      '',
      `🏢 部門：${currentUser.department}`,
      `👤 填單人：${currentUser.real_name}`,
      `📌 狀態：🟡 待處理`,
      `🕐 建立時間：${now}`,
    ]
    const message = lines.join('\n')

    setSubmitting(false)
    resetForm()
    setNotifyPreview(message)
    fetchRecords()
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

  const handleNotifyPhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      alert('請上傳圖片格式檔案（JPG、PNG、GIF、WEBP）')
      e.target.value = ''
      return
    }
    setNotifyPhotoUploading(true)
    setNotifyPhotoUploaded(false)
    try {
      const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
      const filePath = `schedule-inquiries/${fileName}`
      const { error: uploadError } = await supabase.storage
        .from('anomaly-attachments')
        .upload(filePath, file)
      if (uploadError) {
        alert(`上傳失敗：${uploadError.message}`)
      } else {
        setNotifyPhotoUploaded(true)
        setTimeout(() => setNotifyPhotoUploaded(false), 3000)
      }
    } catch {
      alert('上傳發生錯誤')
    } finally {
      setNotifyPhotoUploading(false)
      e.target.value = ''
    }
  }

  const handleReserve = async (id: number) => {
    if (!confirm('確定要預留此單據？')) return
    const { error } = await supabase
      .from('schedule_inquiries')
      .update({ status: 'reserved', updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { alert('更新失敗: ' + error.message); return }
    fetchRecords()
  }

  const handleSubmitOrderNo = async () => {
    if (!orderNoModal || !orderNoInput.trim()) return
    const { error } = await supabase
      .from('schedule_inquiries')
      .update({ order_no: orderNoInput.trim(), status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', orderNoModal.id)
    if (error) { alert('更新失敗: ' + error.message); return }
    setOrderNoModal(null)
    setOrderNoInput('')
    fetchRecords()
  }

  const handleDelete = async (id: number) => {
    if (!confirm('確定要刪除此單據？')) return
    await supabase.from('schedule_inquiries').delete().eq('id', id)
    fetchRecords()
  }

  const isAuthor = (record: Inquiry) => currentUser?.email === record.author_email

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
              <p className="text-xs md:text-sm text-cyan-300 uppercase tracking-widest">產期詢問登記及預留產程</p>
            </div>
          </div>
          <NavButton href="/" direction="home" title="回到首頁" className="px-4 py-2" />
        </div>
      </div>

      <div className="relative z-10 max-w-5xl mx-auto px-4 py-6">
        {errorMessage && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-red-600 bg-red-950/40 text-red-300">
            <div className="font-bold text-sm mb-1">資料表不存在或載入失敗</div>
            <div className="text-xs leading-relaxed">{errorMessage}</div>
          </div>
        )}

        {/* 新增按鈕 */}
        <div className="mb-6">
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold text-sm rounded-xl transition-colors shadow-lg shadow-amber-900/30"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            新增詢問/預留單
          </button>
        </div>

        {/* 新增表單 Modal */}
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-32 bg-black/70 backdrop-blur-sm overflow-y-auto">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl my-4">
              <div className="bg-slate-800 p-4 flex justify-between items-center border-b border-slate-700 rounded-t-2xl sticky top-0 z-10">
                <h3 className="text-white font-bold flex items-center gap-2">
                  <span className="w-2 h-6 bg-amber-500 rounded-full"></span>
                  新增詢問/預留單
                </h3>
                <button onClick={resetForm} className="text-slate-400 hover:text-white transition-colors">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="p-6 space-y-4">
                {/* 填單日期 & 承辦人 */}
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
                    <label className="block text-xs text-slate-400 mb-1">承辦人</label>
                    <input
                      value={formHandler}
                      onChange={e => setFormHandler(e.target.value)}
                      placeholder="請輸入承辦人"
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

                {/* 品名/規格 & 數量 */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">品名/規格 *</label>
                    <input
                      value={formProduct}
                      onChange={e => setFormProduct(e.target.value)}
                      placeholder="請輸入品名或規格"
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors"
                      maxLength={200}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">數量</label>
                    <input
                      type="number"
                      value={formQuantity}
                      onChange={e => setFormQuantity(e.target.value)}
                      placeholder="數量"
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors"
                      min={1}
                    />
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
                    disabled={submitting || !formCustomer.trim() || !formProduct.trim()}
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
              const statusInfo = STATUS_MAP[record.status]
              return (
                <div
                  key={record.id}
                  className="bg-slate-900/60 border border-slate-700 rounded-xl p-4 transition-all hover:border-slate-600"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {/* 標籤列 */}
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${statusInfo.class}`}>{statusInfo.label}</span>
                        <span className="text-xs text-slate-400">{record.author_name}</span>
                        {record.department && (
                          <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{record.department}</span>
                        )}
                        <span className="text-[10px] text-slate-600 font-mono ml-auto shrink-0">
                          {new Date(record.created_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      {/* 主要資訊 */}
                      <h3 className="text-white font-bold text-sm mb-1">{record.customer_name} — {record.product_name}</h3>
                      {record.form_date && <div className="text-[10px] text-slate-500 mb-1">填單日期：{record.form_date}</div>}
                      <div className="flex items-center gap-4 text-xs text-slate-400 mb-1">
                        {record.order_no && <span>訂單：{record.order_no}</span>}
                        {record.quantity && <span>數量：{record.quantity}</span>}
                        {record.expected_date && <span>希望交期(寄出日期)：{record.expected_date}</span>}
                        {record.handler_name && <span>承辦人：{record.handler_name}</span>}
                        {record.planned_order_date && <span>預計發單：{record.planned_order_date}</span>}
                      </div>
                      {record.remark && (
                        <p className="text-slate-500 text-xs mt-1 whitespace-pre-wrap">{record.remark}</p>
                      )}
                    </div>
                    {/* 操作 */}
                    <div className="flex items-center gap-1 shrink-0">
                      {/* 已確認 → 確定預留 */}
                      {isAuthor(record) && record.status === 'confirmed' && (
                        <button
                          onClick={() => handleReserve(record.id)}
                          className="px-2.5 py-1 text-xs font-bold rounded bg-purple-600 hover:bg-purple-500 text-white transition-colors"
                        >
                          確定預留
                        </button>
                      )}
                      {/* 已預留 → 填寫訂單編號 */}
                      {isAuthor(record) && record.status === 'reserved' && (
                        <button
                          onClick={() => { setOrderNoModal({ id: record.id, current: record.order_no || '' }); setOrderNoInput(record.order_no || '') }}
                          className="px-2.5 py-1 text-xs font-bold rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
                        >
                          填寫訂單編號
                        </button>
                      )}
                      {/* 待處理可刪除 */}
                      {isAuthor(record) && record.status === 'pending' && (
                        <button
                          onClick={() => handleDelete(record.id)}
                          className="p-1.5 text-slate-600 hover:text-red-400 transition-colors"
                          title="刪除"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 填寫訂單編號 Modal */}
      {orderNoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-sm w-full space-y-4">
            <h2 className="text-lg font-bold text-white text-center">填寫訂單編號</h2>
            <p className="text-xs text-slate-400 text-center">填寫後單據將標記為「已完成」</p>
            <input
              value={orderNoInput}
              onChange={e => setOrderNoInput(e.target.value)}
              placeholder="請輸入訂單編號"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none transition-colors"
              maxLength={50}
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setOrderNoModal(null); setOrderNoInput('') }}
                className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSubmitOrderNo}
                disabled={!orderNoInput.trim()}
                className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg transition-colors"
              >
                確定送出
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 通知訊息預覽 Modal */}
      {notifyPreview && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-lg w-full space-y-4">
            <h2 className="text-lg font-bold text-white text-center">📨 通知訊息預覽</h2>
            <p className="text-xs text-slate-400 text-center">新增成功！可複製以下訊息貼到 LINE 群組通知相關人員</p>
            <pre className="bg-slate-950 border border-slate-700 rounded-lg p-4 text-sm text-slate-200 whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto select-all">{notifyPreview}</pre>
            <input
              ref={notifyPhotoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => void handleNotifyPhotoSelect(e)}
            />
            <div className="flex gap-2 justify-center flex-wrap">
              <button
                onClick={() => { setNotifyPreview(null); setNotifyPhotoUploaded(false) }}
                className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm"
              >
                關閉
              </button>
              <button
                onClick={() => notifyPhotoInputRef.current?.click()}
                disabled={notifyPhotoUploading}
                className={`px-4 py-2 rounded font-bold text-sm transition-colors ${
                  notifyPhotoUploaded
                    ? 'bg-emerald-600 text-white'
                    : 'bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50 disabled:cursor-not-allowed'
                }`}
              >
                {notifyPhotoUploading ? '上傳中...' : notifyPhotoUploaded ? '✅ 照片已上傳！' : '📷 上傳照片'}
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
