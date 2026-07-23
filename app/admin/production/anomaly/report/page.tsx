'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../../../../../lib/supabaseClient'

interface OptionItem {
  option_value: string
  department_value: string
}

const DEFAULT_PERSONNEL_OPTIONS = ['王小明', '李小華', '陳建宏', '課長A', '主管B', '品保C', '作業員A', '作業員B', '技術員C']
const DEFAULT_CATEGORY_OPTIONS = ['品質異常', '製程異常', '資料異常']
const DEFAULT_DEPARTMENT_OPTIONS = ['品保部', '生產部', '工程部']

const getTodayDateInput = () => new Date().toISOString().slice(0, 10)

const getReadableErrorMessage = (err: unknown) => {
  if (err instanceof Error && err.message) return err.message

  if (typeof err === 'object' && err !== null) {
    const maybeError = err as {
      message?: unknown
      details?: unknown
      hint?: unknown
      code?: unknown
    }

    const parts = [
      typeof maybeError.message === 'string' ? maybeError.message : '',
      typeof maybeError.details === 'string' ? maybeError.details : '',
      typeof maybeError.hint === 'string' ? maybeError.hint : '',
      typeof maybeError.code === 'string' ? `code: ${maybeError.code}` : '',
    ].filter(Boolean)

    if (parts.length > 0) return parts.join(' | ')
  }

  return '未知錯誤'
}

const isQaReportTypeConstraintError = (err: unknown) => {
  if (typeof err !== 'object' || err === null) return false
  const maybeError = err as { message?: unknown; code?: unknown }
  const message = typeof maybeError.message === 'string' ? maybeError.message : ''
  const code = typeof maybeError.code === 'string' ? maybeError.code : ''
  return code === '23514' && message.includes('schedule_anomaly_reports_report_type_check')
}

export default function QaReportFormPage() {
  const [createdDate, setCreatedDate] = useState(getTodayDateInput())
  const [orderNumber, setOrderNumber] = useState('')
  const [itemCode, setItemCode] = useState('')
  const [itemName, setItemName] = useState('')
  const [lossQty, setLossQty] = useState('')
  const [status] = useState<'pending'>('pending')
  const [reason, setReason] = useState('')
  const [reporterDepartment, setReporterDepartment] = useState('')
  const [reporter, setReporter] = useState('')
  const [handlerDepartment, setHandlerDepartment] = useState('')
  const [handlerPersonnel, setHandlerPersonnel] = useState('')
  const [personnelOptions, setPersonnelOptions] = useState<OptionItem[]>([])
  const [categoryOptions, setCategoryOptions] = useState<string[]>(DEFAULT_CATEGORY_OPTIONS)
  const [departmentOptions, setDepartmentOptions] = useState<string[]>(DEFAULT_DEPARTMENT_OPTIONS)
  const [category, setCategory] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [attachFiles, setAttachFiles] = useState<File[]>([])
  const [previewUrls, setPreviewUrls] = useState<string[]>([])
  const [mobileSessionId, setMobileSessionId] = useState('')
  const [showQrModal, setShowQrModal] = useState(false)
  const [mobileUrls, setMobileUrls] = useState<string[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [notifyPreview, setNotifyPreview] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // QA 部門欄位：以 reporterDepartment 為主
  // handlers 欄位補上，預設為單一人員
  const handlers = handlerPersonnel ? [handlerPersonnel] : [];

  const startMobileSession = useCallback(() => {
    const sid = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    setMobileSessionId(sid)
    setShowQrModal(true)
    setMobileUrls([])
  }, [])

  useEffect(() => {
    if (!mobileSessionId || !showQrModal) {
      if (pollRef.current) clearInterval(pollRef.current)
      return
    }
    const poll = async () => {
      const { data } = await supabase.storage
        .from('anomaly-attachments')
        .list(`mobile/${mobileSessionId}`)
      if (data && data.length > 0) {
        const urls = data
          .filter((f) => f.name !== '.emptyFolderPlaceholder')
          .map((f) => {
            const { data: urlData } = supabase.storage
              .from('anomaly-attachments')
              .getPublicUrl(`mobile/${mobileSessionId}/${f.name}`)
            return urlData.publicUrl
          })
        setMobileUrls(urls)
      }
    }
    void poll()
    pollRef.current = setInterval(() => void poll(), 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [mobileSessionId, showQrModal])

  const confirmMobilePhotos = () => {
    setPreviewUrls((prev) => [...prev, ...mobileUrls])
    setShowQrModal(false)
    if (pollRef.current) clearInterval(pollRef.current)
  }

  useEffect(() => {
    const fetchOptions = async () => {
      const { data, error } = await supabase
        .from('qa_anomaly_option_items')
        .select('option_type, option_value, department_value')
        .order('option_value', { ascending: true })

      if (error) {
        console.error(error)
        return
      }

      const rows = (data as Array<{ option_type: string; option_value: string; department_value?: string }>) || []
      const personnel = rows
        .filter((item) => item.option_type === 'personnel')
        .map((item) => ({
          option_value: item.option_value,
          department_value: item.department_value || '',
        }))
        .filter((item) => typeof item.option_value === 'string' && item.option_value.trim().length > 0)

      const categories = rows
        .filter((item) => item.option_type === 'category')
        .map((item) => item.option_value)
        .filter((value) => typeof value === 'string' && value.trim().length > 0)

      const departments = rows
        .filter((item) => item.option_type === 'department')
        .map((item) => item.option_value)
        .filter((value) => typeof value === 'string' && value.trim().length > 0)

      setPersonnelOptions(personnel.length ? personnel : DEFAULT_PERSONNEL_OPTIONS.map(v => ({ option_value: v, department_value: '' })))
      setCategoryOptions(categories.length ? categories : DEFAULT_CATEGORY_OPTIONS)
      setDepartmentOptions(departments.length ? departments : DEFAULT_DEPARTMENT_OPTIONS)
    }

    void fetchOptions()
  }, [])

  const buildLineMessage = () => {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
    const lines = [
      '\ud83d\udea8 \u3010\u7570\u5e38\u55ae\u901a\u77e5\u3011',
      '',
      `\ud83d\udccb \u5de5\u55ae\u7de8\u865f\uff1a${orderNumber.trim() || '-'}`,
      `\ud83d\udd22 \u54c1\u9805\u7de8\u78bc\uff1a${itemCode.trim() || '-'}`,
      `\ud83d\udce6 \u54c1\u540d/\u540d\u7a31\uff1a${itemName.trim() || '-'}`,
      `\u26a0\ufe0f \u7570\u5e38\u539f\u56e0\uff1a${reason.trim() || '-'}`,
      `\ud83c\udff7\ufe0f \u5206\u985e\uff1a${category || '-'}`,
      `\ud83c\udfe2 \u56de\u5831\u90e8\u9580\uff1a${reporterDepartment.trim() || '-'}`,
      `\ud83d\udc64 \u56de\u5831\u4eba\u54e1\uff1a${reporter.trim() || '-'}`,
      `\ud83c\udfed \u8655\u7406\u90e8\u9580\uff1a${handlerDepartment.trim() || '-'}`,
      `\ud83d\udd27 \u8655\u7406\u4eba\u54e1\uff1a${handlers.join('\u3001') || '-'}`,
      `\ud83d\udccc \u72c0\u614b\uff1a\ud83d\udd34 \u5f85\u8655\u7406`,
      `\ud83d\udd50 \u901a\u77e5\u6642\u9593\uff1a${now}`,
    ]
    return lines.join('\n')
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

  const handleSubmit = async () => {
    if (!orderNumber.trim()) {
      alert('請填寫相關單號')
      return
    }

    if (!reporterDepartment.trim()) {
      alert('請選擇部門（必填）')
      return
    }

    if (!reason.trim()) {
      alert('請填寫異常原因')
      return
    }

    setSubmitting(true)
    try {
      // 上傳圖片到 Supabase Storage
      // Include mobile-uploaded URLs (non-blob URLs already in previewUrls)
      const uploadedUrls: string[] = previewUrls.filter((u) => !u.startsWith('blob:'))
      for (const file of attachFiles) {
        const ext = file.name.split('.').pop()
        const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
        const filePath = `reports/${fileName}`
        const { error: uploadError } = await supabase.storage
          .from('anomaly-attachments')
          .upload(filePath, file)
        if (uploadError) {
          alert(`圖片上傳失敗：${uploadError.message}`)
          setSubmitting(false)
          return
        }
        const { data: urlData } = supabase.storage
          .from('anomaly-attachments')
          .getPublicUrl(filePath)
        uploadedUrls.push(urlData.publicUrl)
      }

      const payload = {
        report_type: 'qa',
        reason: reason.trim(),
        status,
        order_number: orderNumber.trim(),
        created_at: createdDate ? `${createdDate}T00:00:00.000Z` : new Date().toISOString(),
        qa_department: reporterDepartment.trim() || null,
        qa_reporter: reporter.trim() || null,
        qa_handlers: handlers,
        qa_category: category || null,
        qa_responsible: [],
        handler_department: handlerDepartment.trim() || null,
        item_code: itemCode.trim() || null,
        item_name: itemName.trim() || null,
        loss_qty: lossQty === '' ? null : Number(lossQty),
        attachments: uploadedUrls,
      }

      const { error } = await supabase.from('schedule_anomaly_reports').insert(payload)
      if (error) throw error

      const msg = buildLineMessage()
      setOrderNumber('')
      setItemCode('')
      setItemName('')
      setLossQty('')
      setReason('')
      setReporterDepartment('')
      setReporter('')
      setHandlerDepartment('')
      setHandlerPersonnel('')
      setCategory('')
      setAttachFiles([])
      setPreviewUrls([])
      setMobileSessionId('')
      setMobileUrls([])
      setCreatedDate(getTodayDateInput())
      setNotifyPreview(msg)
      setCopied(false)
    } catch (err: unknown) {
      if (isQaReportTypeConstraintError(err)) {
        alert('送出失敗：資料庫尚未允許 report_type=qa。請先執行 sql/20260224_allow_qa_report_type.sql migration。')
        return
      }
      const message = getReadableErrorMessage(err)
      alert(`送出失敗：${message}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-[1000px] mx-auto min-h-screen space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">異常回報單</h1>
          <p className="text-teal-400 mt-1 font-mono text-sm uppercase">QA REPORT FORM</p>
        </div>
        <Link href="/" className="px-3 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm">
          返回首頁
        </Link>
      </div>

      <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-slate-400">日期</label>
            <input
              type="date"
              value={createdDate}
              onChange={(e) => setCreatedDate(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            />
          </div>

          <div>
            <label className="text-xs text-slate-400">相關單號</label>
            <input
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            />
          </div>

          <div>
            <label className="text-xs text-slate-400">品項編碼（選填）</label>
            <input
              value={itemCode}
              onChange={(e) => setItemCode(e.target.value)}
              placeholder="例：A-001"
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            />
          </div>

          <div>
            <label className="text-xs text-slate-400">品名/名稱（選填）</label>
            <input
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="例：產品名稱"
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            />
          </div>

          <div>
            <label className="text-xs text-slate-400">異常數量（選填）</label>
            <input
              type="number"
              min="0"
              step="any"
              value={lossQty}
              onChange={(e) => setLossQty(e.target.value)}
              placeholder="缺失導致損失數量"
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white placeholder:text-slate-500"
            />
          </div>

          <div className="md:col-span-2 flex gap-4">
            <div style={{ width: '50%' }}>
              <label className="text-xs text-slate-400">異常分類</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
              >
                <option value="">請選擇</option>
                {categoryOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
            <div style={{ width: '50%' }} className="flex flex-col justify-end">
              <label className="text-xs text-slate-400">狀態</label>
              <div className="mt-1 w-full">
                <span className="bg-yellow-400 text-black px-3 py-2 rounded text-xs font-bold w-full block text-center" style={{height:'40px',display:'flex',alignItems:'center',justifyContent:'center'}}>待處理</span>
              </div>
            </div>
          </div>

          <div className="col-span-1">
            <label className="text-xs text-slate-400">異常回報-部門</label>
            <select
              value={reporterDepartment}
              onChange={(e) => {
                setReporterDepartment(e.target.value);
                setReporter('');
              }}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            >
              <option value="">請選擇</option>
              {departmentOptions.map((dept) => (
                <option key={dept} value={dept}>{dept}</option>
              ))}
            </select>
          </div>
          <div className="col-span-1">
            <label className="text-xs text-slate-400">異常回報-人員</label>
            {reporterDepartment ? (
              <select
                value={reporter}
                onChange={(e) => setReporter(e.target.value)}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
              >
                <option value="">請選擇</option>
                {personnelOptions.filter(p => p.department_value === reporterDepartment).map((option, idx) => (
                  <option key={idx} value={option.option_value}>{option.option_value}</option>
                ))}
              </select>
            ) : (
              <div className="mt-1 text-slate-500 text-xs">請先選部門</div>
            )}
          </div>
          <div className="col-span-1">
            <label className="text-xs text-slate-400">異常處理-部門</label>
            <select
              value={handlerDepartment}
              onChange={e => {
                setHandlerDepartment(e.target.value);
                setHandlerPersonnel('');
              }}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            >
              <option value="">請選擇</option>
              {departmentOptions.map((dept) => (
                <option key={dept} value={dept}>{dept}</option>
              ))}
            </select>
          </div>
          <div className="col-span-1">
            <label className="text-xs text-slate-400">異常處理-人員</label>
            {handlerDepartment ? (
              <select
                value={handlerPersonnel}
                onChange={e => setHandlerPersonnel(e.target.value)}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
              >
                <option value="">請選擇</option>
                {personnelOptions.filter(p => p.department_value === handlerDepartment).map((option, i) => (
                  <option key={i} value={option.option_value}>{option.option_value}</option>
                ))}
              </select>
            ) : (
              <div className="mt-1 text-slate-500 text-xs">請先選部門</div>
            )}
          </div>
          {/* 已移除多餘的先選部門再選人員空格 */}
        </div>

        <div>
          {/* 已移除多餘的異常處理部門與人員欄位 */}

          {/* 異常分類欄位已移至狀態欄位，避免重複 */}
        </div>

        <div>
          <label className="text-xs text-slate-400">異常原因（手填）</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            placeholder="請填寫異常描述..."
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
          />
        </div>

        <div>
          <label className="text-xs text-slate-400">上傳圖片（選填，可多張）</label>
          <div className="mt-1 flex gap-2">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || [])
                setAttachFiles((prev) => [...prev, ...files])
                const urls = files.map((f) => URL.createObjectURL(f))
                setPreviewUrls((prev) => [...prev, ...urls])
              }}
              className="flex-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white text-sm file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:bg-cyan-700 file:text-white file:text-xs file:cursor-pointer"
            />
            <button
              type="button"
              onClick={startMobileSession}
              className="px-4 py-2 rounded border border-violet-600 text-violet-300 hover:bg-violet-900/30 text-sm whitespace-nowrap"
            >
              📱 手機拍照
            </button>
          </div>
          {previewUrls.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {previewUrls.map((url, idx) => (
                <div key={idx} className="relative group">
                  <img src={url} alt={`preview-${idx}`} className="w-20 h-20 object-cover rounded border border-slate-700" />
                  <button
                    type="button"
                    onClick={() => {
                      setAttachFiles((prev) => prev.filter((_, i) => i !== idx))
                      setPreviewUrls((prev) => prev.filter((_, i) => i !== idx))
                    }}
                    className="absolute -top-1 -right-1 w-5 h-5 bg-red-600 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
          缺失人員請於「異常紀錄表」編輯時填寫。
        </div>

        <datalist id="qa-personnel-options">
          {personnelOptions.map((option, idx) => (
            <option
              key={typeof option === 'string' ? option : (option.option_value + (option.department_value || '') + idx)}
              value={typeof option === 'string' ? option : option.option_value}
            />
          ))}
        </datalist>


        <div className="flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-bold disabled:bg-slate-700 disabled:text-slate-400"
          >
            {submitting ? '送出中...' : '送出回報單'}
          </button>
        </div>
      </div>

      {showQrModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-sm w-full space-y-4">
            <h2 className="text-lg font-bold text-white text-center">📱 手機掃碼上傳圖片</h2>
            <p className="text-xs text-slate-400 text-center">用手機掃描下方 QR Code 拍照上傳，照片會自動同步到此表單</p>
            <p className="text-sm text-amber-400 font-bold text-center bg-amber-900/30 border border-amber-700 rounded-lg px-3 py-2">⚠️ 照片全部上傳完成前請勿關閉此視窗</p>
            <div className="flex justify-center bg-white rounded-xl p-4">
              <QRCodeSVG
                value={`${window.location.origin}/upload-photo?sid=${mobileSessionId}`}
                size={200}
                level="M"
              />
            </div>
            {mobileUrls.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-emerald-400 text-center">已收到 {mobileUrls.length} 張圖片</p>
                <div className="flex gap-2 flex-wrap justify-center">
                  {mobileUrls.map((url, i) => (
                    <img key={i} src={url} alt={`mobile-${i}`} className="w-14 h-14 object-cover rounded border border-slate-600" />
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => { setShowQrModal(false); if (pollRef.current) clearInterval(pollRef.current) }}
                className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm"
              >
                取消
              </button>
              {mobileUrls.length > 0 && (
                <button
                  onClick={confirmMobilePhotos}
                  className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm"
                >
                  確認使用 ({mobileUrls.length} 張)
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {notifyPreview && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-lg w-full space-y-4">
            <h2 className="text-lg font-bold text-white text-center">📨 通知訊息預覽</h2>
            <p className="text-xs text-slate-400 text-center">此訊息與 LINE Bot 推播內容相同，可複製後手動貼到 LINE 群組</p>
            <pre className="bg-slate-950 border border-slate-700 rounded-lg p-4 text-sm text-slate-200 whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto select-all">{notifyPreview}</pre>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => { if (confirm('確定關閉？關閉後訊息將無法再次查看。')) setNotifyPreview(null) }}
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
