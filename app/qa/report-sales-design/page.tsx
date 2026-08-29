'use client'

// 異常回報單（業務美編・尚未生產）
//
// 給業務／美編在「訂單尚未進入生產」階段回報異常（圖檔、套版、示意圖等）。
// 與 app/admin/production/anomaly/report/page.tsx（生產階段的異常回報單）
// 刻意不共用程式碼：這頁是全新實作，只有視覺格式接近，後續依業務美編需求各自演進。
//
// 資料流與既有流程相容：
// - 選項同樣讀 qa_anomaly_option_items（分類／部門／人員連動）
// - 圖片同樣上傳 anomaly-attachments bucket 的 reports/ 路徑
// - 送出同樣寫入 schedule_anomaly_reports 且 report_type='qa'
//   （下游「異常單處理／異常紀錄表」都以 report_type='qa' 過濾，用別的值會看不到；
//     資料庫也有 report_type 的 CHECK 約束擋未知值）
// - 「尚未生產」目前以異常原因自動前綴【尚未生產】標記，之後要升級成正式欄位再一起改

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../lib/supabaseClient'

interface PersonnelOption {
  option_value: string
  department_value: string
}

const PRE_PRODUCTION_TAG = '【尚未生產】'
const getTodayDateInput = () => new Date().toISOString().slice(0, 10)

// members.department 與 qa_anomaly_option_items 的部門寫法不一致，需對照；
// 表上沒有對應選項的部門（管理部、雷射切割）刻意不列 → 不預填，由使用者自選。
const DEPT_MAP: Record<string, string> = {
  美術編輯部: '美編部',
  印刷部: '生產部-印刷課',
  生產管理部: '生產部-生管課',
}

/**
 * 從該部門的人員選項中找出登入者。選項格式多為「美編-怡妏」，帳號存的是
 * 暱稱（怡妏）或本名（易怡妏），故取 '-' 後的名字部分做比對。
 * 完全相等優先於包含；同名同時存在有前綴與無前綴兩筆時取有前綴的（新命名慣例）；
 * 仍不唯一就回 null——預填帶錯人比不帶更糟。
 */
function matchPersonnel(cands: PersonnelOption[], names: string[]): string | null {
  const namePart = (v: string) => {
    const i = v.lastIndexOf('-')
    return (i >= 0 ? v.slice(i + 1) : v).trim()
  }
  const score = (p: string, n: string) =>
    p === n ? 2 : n.length >= 2 && (p.includes(n) || n.includes(p)) ? 1 : 0
  let hits = cands
    .map((c) => {
      const p = namePart(c.option_value)
      return { v: c.option_value, s: Math.max(0, ...names.map((n) => score(p, n))) }
    })
    .filter((h) => h.s > 0)
  if (hits.length === 0) return null
  const top = Math.max(...hits.map((h) => h.s))
  hits = hits.filter((h) => h.s === top)
  const prefixed = hits.filter((h) => h.v.includes('-'))
  const pool = prefixed.length > 0 ? prefixed : hits
  const uniq = [...new Set(pool.map((h) => h.v))]
  return uniq.length === 1 ? uniq[0] : null
}

export default function SalesDesignAnomalyReportPage() {
  // ── 表單欄位 ──────────────────────────────────────────────
  const [createdDate, setCreatedDate] = useState(getTodayDateInput())
  const [orderNumber, setOrderNumber] = useState('')
  const [itemCode, setItemCode] = useState('')
  const [itemName, setItemName] = useState('')
  const [category, setCategory] = useState('')
  const [reporterDepartment, setReporterDepartment] = useState('')
  const [reporter, setReporter] = useState('')
  const [handlerDepartment, setHandlerDepartment] = useState('')
  const [handlerPersonnel, setHandlerPersonnel] = useState('')
  const [reason, setReason] = useState('')
  const [attachFiles, setAttachFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [doneMsg, setDoneMsg] = useState('')

  // ── 選項（與既有異常單同一來源）───────────────────────────
  const [categoryOptions, setCategoryOptions] = useState<string[]>([])
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([])
  const [personnelOptions, setPersonnelOptions] = useState<PersonnelOption[]>([])

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
      const rows = (data as Array<{ option_type: string; option_value: string; department_value?: string }>) ?? []
      setCategoryOptions(rows.filter((r) => r.option_type === 'category').map((r) => r.option_value).filter(Boolean))
      setDepartmentOptions(rows.filter((r) => r.option_type === 'department').map((r) => r.option_value).filter(Boolean))
      setPersonnelOptions(
        rows
          .filter((r) => r.option_type === 'personnel' && r.option_value?.trim())
          .map((r) => ({ option_value: r.option_value, department_value: r.department_value || '' })),
      )
    }
    void fetchOptions()
  }, [])

  const personnelOf = (dept: string) => personnelOptions.filter((p) => !dept || p.department_value === dept)

  // ── 依登入帳號預填「異常回報-部門／人員」──────────────────
  // 只是預設值：使用者已手動動過就不覆蓋（touchedRef），比對不到就留白。
  const reporterTouchedRef = useRef(false)
  useEffect(() => {
    if (departmentOptions.length === 0 || personnelOptions.length === 0) return
    let cancelled = false
    const prefill = async () => {
      const { data: auth } = await supabase.auth.getUser()
      const email = auth.user?.email
      if (!email || cancelled) return
      const { data } = await supabase
        .from('members')
        .select('department, nickname, real_name')
        .eq('email', email)
        .limit(1)
      const me = (data ?? [])[0] as { department?: string; nickname?: string; real_name?: string } | undefined
      if (!me || cancelled || reporterTouchedRef.current) return
      const raw = (me.department ?? '').trim()
      const dept = departmentOptions.includes(raw) ? raw : DEPT_MAP[raw] ?? ''
      if (!dept) return
      setReporterDepartment((prev) => prev || dept)
      const names = [me.nickname, me.real_name].map((n) => (n ?? '').trim()).filter(Boolean)
      const pick = matchPersonnel(personnelOptions.filter((p) => p.department_value === dept), names)
      if (pick) setReporter((prev) => prev || pick)
    }
    void prefill()
    return () => { cancelled = true }
  }, [departmentOptions, personnelOptions])

  // ── 送出 ─────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!orderNumber.trim()) {
      alert('請填寫相關單號')
      return
    }
    if (!reason.trim()) {
      alert('請填寫異常原因')
      return
    }
    setSubmitting(true)
    setDoneMsg('')
    try {
      const uploadedUrls: string[] = []
      for (const file of attachFiles) {
        const ext = file.name.split('.').pop()
        const filePath = `reports/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
        const { error: uploadError } = await supabase.storage.from('anomaly-attachments').upload(filePath, file)
        if (uploadError) {
          alert(`圖片上傳失敗：${uploadError.message}`)
          return
        }
        uploadedUrls.push(supabase.storage.from('anomaly-attachments').getPublicUrl(filePath).data.publicUrl)
      }

      const { error } = await supabase.from('schedule_anomaly_reports').insert({
        report_type: 'qa',
        reason: `${PRE_PRODUCTION_TAG}${reason.trim()}`,
        status: '待處理',
        order_number: orderNumber.trim(),
        created_at: createdDate ? `${createdDate}T00:00:00.000Z` : new Date().toISOString(),
        qa_department: reporterDepartment.trim() || null,
        qa_reporter: reporter.trim() || null,
        qa_handlers: handlerPersonnel.trim() ? [handlerPersonnel.trim()] : [],
        qa_category: category || null,
        qa_responsible: [],
        handler_department: handlerDepartment.trim() || null,
        item_code: itemCode.trim() || null,
        item_name: itemName.trim() || null,
        loss_qty: null,
        attachments: uploadedUrls,
      })
      if (error) throw error

      setDoneMsg(`已送出：${orderNumber.trim()}（${PRE_PRODUCTION_TAG.replace(/[【】]/g, '')}異常）`)
      setOrderNumber('')
      setItemCode('')
      setItemName('')
      setCategory('')
      setReporterDepartment('')
      setReporter('')
      setHandlerDepartment('')
      setHandlerPersonnel('')
      setReason('')
      setAttachFiles([])
      setCreatedDate(getTodayDateInput())
    } catch (err) {
      alert(`送出失敗：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSubmitting(false)
    }
  }

  // ── 樣式（與既有異常單同一套視覺語言）──────────────────────
  const labelCls = 'block text-sm text-slate-400 mb-1'
  const inputCls =
    'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-600 focus:outline-none focus:border-teal-500'

  return (
    <main className="min-h-screen bg-slate-950 text-white px-4 py-8">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
              異常回報單（業務美編）
              <span className="px-2 py-0.5 rounded border border-amber-600/60 bg-amber-950/40 text-amber-300 text-sm font-medium">
                尚未生產
              </span>
            </h1>
            <p className="text-teal-500 text-xs font-mono mt-1 tracking-widest">QA REPORT FORM · PRE-PRODUCTION</p>
          </div>
          <Link href="/" className="px-3 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm">
            返回首頁
          </Link>
        </div>

        {doneMsg && (
          <div className="mb-4 rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-4 py-3 text-emerald-300 text-sm">
            ✅ {doneMsg}
          </div>
        )}

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col gap-5">
          {/* 日期＋單號 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>日期</label>
              <input type="date" value={createdDate} onChange={(e) => setCreatedDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>相關單號（SO 訂單號或 MOT 製令號）</label>
              <input
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="例：SO260804025"
                className={inputCls}
              />
            </div>
          </div>

          {/* 品項 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>品項編碼（選填）</label>
              <input value={itemCode} onChange={(e) => setItemCode(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>品名/名稱（選填）</label>
              <input value={itemName} onChange={(e) => setItemName(e.target.value)} className={inputCls} />
            </div>
          </div>

          {/* 分類 */}
          <div>
            <label className={labelCls}>異常分類</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
              <option value="">請選擇</option>
              {categoryOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* 回報者 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>異常回報-部門</label>
              <select
                value={reporterDepartment}
                onChange={(e) => { reporterTouchedRef.current = true; setReporterDepartment(e.target.value); setReporter('') }}
                className={inputCls}
              >
                <option value="">請選擇</option>
                {departmentOptions.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>異常回報-人員</label>
              <select
                value={reporter}
                onChange={(e) => { reporterTouchedRef.current = true; setReporter(e.target.value) }}
                className={inputCls}
                disabled={!reporterDepartment}
              >
                <option value="">{reporterDepartment ? '請選擇' : '請先選部門'}</option>
                {personnelOf(reporterDepartment).map((p) => (
                  <option key={p.option_value} value={p.option_value}>{p.option_value}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 處理者 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>異常處理-部門</label>
              <select
                value={handlerDepartment}
                onChange={(e) => { setHandlerDepartment(e.target.value); setHandlerPersonnel('') }}
                className={inputCls}
              >
                <option value="">請選擇</option>
                {departmentOptions.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>異常處理-人員</label>
              <select
                value={handlerPersonnel}
                onChange={(e) => setHandlerPersonnel(e.target.value)}
                className={inputCls}
                disabled={!handlerDepartment}
              >
                <option value="">{handlerDepartment ? '請選擇' : '請先選部門'}</option>
                {personnelOf(handlerDepartment).map((p) => (
                  <option key={p.option_value} value={p.option_value}>{p.option_value}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 原因 */}
          <div>
            <label className={labelCls}>異常原因（送出時自動加上 {PRE_PRODUCTION_TAG} 標記）</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="請填寫異常描述..."
              className={inputCls}
            />
          </div>

          {/* 圖片 */}
          <div>
            <label className={labelCls}>上傳圖片（選填，可多張）</label>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => setAttachFiles(Array.from(e.target.files ?? []))}
              className="block w-full text-sm text-slate-400 file:mr-3 file:px-3 file:py-1.5 file:rounded file:border file:border-slate-700 file:bg-slate-800 file:text-slate-300 file:cursor-pointer"
            />
            {attachFiles.length > 0 && (
              <div className="text-xs text-slate-500 mt-1">已選 {attachFiles.length} 張</div>
            )}
          </div>

          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full py-3 rounded-lg bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white font-bold transition-colors"
          >
            {submitting ? '送出中…' : '送出回報單'}
          </button>
        </div>
      </div>
    </main>
  )
}
