'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../../../../../lib/supabaseClient'

interface AnomalyReport {
  id: number
  report_type: 'qa' | 'upv' | 'other' | string
  reason: string | null
  status: 'pending' | 'confirmed' | string
  source_order_id: number | null
  order_number: string
  item_code: string | null
  item_name: string | null
  quantity: number
  op_name: string | null
  station: string | null
  created_at: string
  processed_at: string | null
  qa_department: string | null
  qa_reporter: string | null
  qa_handlers: string[] | null
  qa_category: string | null
  qa_responsible: string[] | null
  qa_disposition: Record<string, string> | null
  handler_department: string | null
  handler_record: string | null
  attachments: string[] | null
  loss_qty: number | null
  cause_analysis: string | null
  immediate_action: string | null
  corrective_action: string | null
}

interface PersonnelOption {
  option_value: string
  department_value: string
}

interface OptionState {
  personnel: PersonnelOption[]
  categories: string[]
  departments: string[]
  dispositions: string[]
}

interface CreateFormState {
  createdDate: string
  orderNumber: string
  itemCode: string
  itemName: string
  status: 'pending' | 'confirmed'
  reason: string
  department: string
  reporter: string
  category: string
  handlerDepartment: string
  handlers: string[]
  handling: string
  responsibleDepartment: string
  responsible: string[]
  disposition: Record<string, string>
  attachFiles: File[]
  previewUrls: string[]
  existingAttachments: string[]
  lossQty: string
  causeAnalysis: string
  immediateAction: string
  correctiveAction: string
}

type OptionType = 'personnel' | 'category' | 'department' | 'disposition'

interface OptionItem {
  id: number
  option_type: OptionType
  option_value: string
  department_value?: string
}

const DEFAULT_OPTIONS: OptionState = {
  personnel: [
    { option_value: '王小明', department_value: '' },
    { option_value: '李小華', department_value: '' },
    { option_value: '陳建宏', department_value: '' },
  ],
  categories: ['品質異常', '製程異常', '資料異常'],
  departments: ['品保部', '生產部', '工程部'],
  dispositions: ['重工', '報廢', '讓步接收', '退貨', '隔離', '待判定'],
}

const getTodayDateInput = () => new Date().toISOString().slice(0, 10)

// 以本地時區組 yyyy-MM-dd（避免 toISOString 的 UTC 換日位移）
const toLocalDateInput = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Safely parse disposition regardless of whether DB returned object or JSON string
const parseDisp = (val: unknown): Record<string, string> => {
  if (!val) return {}
  if (typeof val === 'string') {
    try { return JSON.parse(val) as Record<string, string> } catch { return {} }
  }
  if (typeof val === 'object') return val as Record<string, string>
  return {}
}

const DEFAULT_CREATE_FORM: CreateFormState = {
  createdDate: getTodayDateInput(),
  orderNumber: '',
  itemCode: '',
  itemName: '',
  status: 'pending',
  reason: '',
  department: '',
  reporter: '',
  category: '',
  handlerDepartment: '',
  handlers: [],
  handling: '',
  responsibleDepartment: '',
  responsible: [],
  disposition: {},
  attachFiles: [],
  previewUrls: [],
  existingAttachments: [],
  lossQty: '',
  causeAnalysis: '',
  immediateAction: '',
  correctiveAction: '',
}

export default function QaRecordsPage() {
  const [reports, setReports] = useState<AnomalyReport[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createForm, setCreateForm] = useState<CreateFormState>(DEFAULT_CREATE_FORM)
  const [savingCreate, setSavingCreate] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<CreateFormState>(DEFAULT_CREATE_FORM)
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [options, setOptions] = useState<OptionState>(DEFAULT_OPTIONS)
  const [selectedDepartment, setSelectedDepartment] = useState('')
  const [selectedReporter, setSelectedReporter] = useState('')
  const [selectedHandler, setSelectedHandler] = useState('')
  const [selectedResponsible, setSelectedResponsible] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [statusFilter, setStatusFilter] = useState({ pending: true, confirmed: true })
  const [orderKeyword, setOrderKeyword] = useState('')
  const [startDateFilter, setStartDateFilter] = useState('')
  const [endDateFilter, setEndDateFilter] = useState('')

  const applyDatePreset = (preset: 'thisMonth' | 'lastMonth' | 'threeMonths' | 'sixMonths' | 'oneYear') => {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    let start: Date
    let end = now
    if (preset === 'thisMonth') start = new Date(y, m, 1)
    else if (preset === 'lastMonth') { start = new Date(y, m - 1, 1); end = new Date(y, m, 0) }
    else if (preset === 'threeMonths') start = new Date(y, m - 3, now.getDate())
    else if (preset === 'sixMonths') start = new Date(y, m - 6, now.getDate())
    else start = new Date(y - 1, m, now.getDate())
    setStartDateFilter(toLocalDateInput(start))
    setEndDateFilter(toLocalDateInput(end))
  }
  const [mobileSessionId, setMobileSessionId] = useState('')
  const [showQrModal, setShowQrModal] = useState(false)
  const [mobileUrls, setMobileUrls] = useState<string[]>([])
  const [mobileTarget, setMobileTarget] = useState<'create' | 'edit'>('create')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [notifyPreview, setNotifyPreview] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const startMobileSession = useCallback((target: 'create' | 'edit') => {
    const sid = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    setMobileSessionId(sid)
    setMobileTarget(target)
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
    if (mobileTarget === 'create') {
      setCreateForm((prev) => ({ ...prev, previewUrls: [...prev.previewUrls, ...mobileUrls] }))
    } else {
      setEditForm((prev) => ({ ...prev, existingAttachments: [...prev.existingAttachments, ...mobileUrls] }))
    }
    setShowQrModal(false)
    if (pollRef.current) clearInterval(pollRef.current)
  }

  const buildLineMessage = (form: CreateFormState, type: 'insert' | 'update') => {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
    const statusText = form.status === 'pending' ? '🔴 待處理' : '🟢 已完成'
    const isUpdate = type === 'update'
    const title = isUpdate ? '✅ 【異常單處理完成】' : '🚨 【異常單通知】'
    const lines = [
      title,
      '',
      `📋 工單編號：${form.orderNumber.trim() || '-'}`,
      `🔢 品項編碼：${form.itemCode.trim() || '-'}`,
      `📦 品名/名稱：${form.itemName.trim() || '-'}`,
      `⚠️ 異常原因：${form.reason.trim() || '-'}`,
      `🏷️ 分類：${form.category || '-'}`,
      `🏢 回報部門：${form.department || '-'}`,
      `👤 回報人員：${form.reporter || '-'}`,
      `🏭 處理部門：${form.handlerDepartment || '-'}`,
      `🔧 處理人員：${form.handlers.join('、') || '-'}`,
      `📌 狀態：${statusText}`,
      `🕐 通知時間：${now}`,
    ]
    if (isUpdate && form.handling.trim()) {
      lines.splice(lines.length - 2, 0, `📝 處理紀錄：${form.handling.trim()}`)
    }
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

  const fetchOptions = useCallback(async () => {
    const { data, error } = await supabase
      .from('qa_anomaly_option_items')
      .select('id, option_type, option_value, department_value')
      .order('option_type', { ascending: true })
      .order('option_value', { ascending: true })

    if (error) {
      console.error(error)
      return
    }

    const rows = (data as OptionItem[]) || []
    const personnelRows: PersonnelOption[] = rows
      .filter((row) => row.option_type === 'personnel')
      .map((row) => ({ option_value: row.option_value, department_value: row.department_value || '' }))
    const categoriesRows = rows.filter((row) => row.option_type === 'category').map((row) => row.option_value)
    const departmentsRows = rows.filter((row) => row.option_type === 'department').map((row) => row.option_value)
    const dispositionsRows = rows.filter((row) => row.option_type === 'disposition').map((row) => row.option_value)

    setOptions({
      personnel: personnelRows.length ? personnelRows : DEFAULT_OPTIONS.personnel,
      categories: categoriesRows.length ? categoriesRows : DEFAULT_OPTIONS.categories,
      departments: departmentsRows.length ? departmentsRows : DEFAULT_OPTIONS.departments,
      dispositions: dispositionsRows.length ? dispositionsRows : DEFAULT_OPTIONS.dispositions,
    })
  }, [])

  useEffect(() => {
    void fetchOptions()
  }, [fetchOptions])

  const fetchReports = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('schedule_anomaly_reports')
      .select('*')
      .eq('report_type', 'qa')
      .order('status', { ascending: true })
      .order('created_at', { ascending: false })

    if (error) {
      console.error(error)
      alert(`載入失敗：${error.message}`)
    } else {
      setReports((data as AnomalyReport[]) || [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void fetchReports()
  }, [fetchReports])

  const pendingReports = reports.filter((report) => report.status === 'pending')
  const completedReports = reports.filter((report) => report.status !== 'pending')

  const normalizeTextArray = (value: string[] | null | undefined) => Array.isArray(value) ? value : []

  const openEditModal = (report: AnomalyReport) => {
    setEditingId(report.id)
    setEditForm({
      createdDate: report.created_at ? new Date(report.created_at).toISOString().slice(0, 10) : getTodayDateInput(),
      orderNumber: report.order_number || '',
      itemCode: report.item_code || '',
      itemName: report.item_name || '',
      status: report.status === 'confirmed' ? 'confirmed' : 'pending',
      reason: report.reason || '',
      department: report.qa_department || '',
      reporter: report.qa_reporter || '',
      category: report.qa_category || '',
      handlerDepartment: report.handler_department || '',
      handlers: normalizeTextArray(report.qa_handlers),
      handling: report.handler_record || '',
      responsibleDepartment: '',
      responsible: normalizeTextArray(report.qa_responsible),
      disposition: parseDisp(report.qa_disposition),
      attachFiles: [],
      previewUrls: [],
      existingAttachments: Array.isArray(report.attachments) ? report.attachments : [],
      lossQty: report.loss_qty != null ? String(report.loss_qty) : '',
      causeAnalysis: report.cause_analysis || '',
      immediateAction: report.immediate_action || '',
      correctiveAction: report.corrective_action || '',
    })
  }

  const closeEditModal = () => {
    setEditingId(null)
    setEditForm(DEFAULT_CREATE_FORM)
  }

  const openCreateModal = () => {
    setCreateForm({ ...DEFAULT_CREATE_FORM, createdDate: getTodayDateInput() })
    setCreating(true)
  }

  const closeCreateModal = () => {
    setCreating(false)
    setCreateForm(DEFAULT_CREATE_FORM)
  }

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

  const handleCreate = async () => {
    if (!createForm.orderNumber.trim()) {
      alert('請填寫相關單號')
      return
    }

    if (!createForm.reason.trim()) {
      alert('請填寫異常原因（手填）')
      return
    }

    setSavingCreate(true)
    try {
      // Collect mobile-uploaded URLs (non-blob URLs from previewUrls)
      const uploadedUrls: string[] = createForm.previewUrls.filter((u) => !u.startsWith('blob:'))
      for (const file of createForm.attachFiles) {
        const ext = file.name.split('.').pop() || 'jpg'
        const filePath = `records/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('anomaly-attachments')
          .upload(filePath, file)
        if (uploadError) {
          console.error('Upload error:', uploadError)
          continue
        }
        const { data: urlData } = supabase.storage
          .from('anomaly-attachments')
          .getPublicUrl(filePath)
        if (urlData?.publicUrl) uploadedUrls.push(urlData.publicUrl)
      }

      // 註：schedule_anomaly_reports 實際無 source_order_id/task_id/quantity/op_name/station/section_id 欄，
      // 帶上會使 insert 400；QA 異常單一律以 order_number 關聯訂單。
      const payload = {
        report_type: 'qa',
        reason: createForm.reason.trim(),
        status: createForm.status,
        order_number: createForm.orderNumber.trim(),
        item_code: createForm.itemCode.trim() || null,
        item_name: createForm.itemName.trim() || null,
        loss_qty: createForm.lossQty === '' ? null : Number(createForm.lossQty),
        created_at: createForm.createdDate ? `${createForm.createdDate}T00:00:00.000Z` : new Date().toISOString(),
        qa_department: createForm.department || null,
        qa_reporter: createForm.reporter || null,
        qa_handlers: createForm.handlers,
        qa_category: createForm.category || null,
        qa_responsible: createForm.responsible,
        qa_disposition: Object.keys(createForm.disposition).length > 0 ? createForm.disposition : null,
        handler_department: createForm.handlerDepartment || null,
        handler_record: createForm.handling.trim() || null,
        attachments: uploadedUrls,
      }

      const { error } = await supabase.from('schedule_anomaly_reports').insert(payload)
      if (error) throw error

      const msg = buildLineMessage(createForm, 'insert')
      setNotifyPreview(msg)
      setCopied(false)
      closeCreateModal()
      await fetchReports()
    } catch (err: unknown) {
      alert(`新增失敗：${getReadableErrorMessage(err)}`)
    } finally {
      setSavingCreate(false)
    }
  }

  const handleSaveEdit = async () => {
    if (!editingId) return

    if (!editForm.orderNumber.trim()) {
      alert('請填寫相關單號')
      return
    }

    if (!editForm.reason.trim()) {
      alert('請填寫異常原因（手填）')
      return
    }

    setSavingEdit(true)
    try {
      const uploadedUrls: string[] = [...editForm.existingAttachments]
      for (const file of editForm.attachFiles) {
        const ext = file.name.split('.').pop() || 'jpg'
        const filePath = `records/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('anomaly-attachments')
          .upload(filePath, file)
        if (uploadError) {
          console.error('Upload error:', uploadError)
          continue
        }
        const { data: urlData } = supabase.storage
          .from('anomaly-attachments')
          .getPublicUrl(filePath)
        if (urlData?.publicUrl) uploadedUrls.push(urlData.publicUrl)
      }

      const { error } = await supabase
        .from('schedule_anomaly_reports')
        .update({
          created_at: editForm.createdDate ? `${editForm.createdDate}T00:00:00.000Z` : undefined,
          order_number: editForm.orderNumber.trim(),
          item_code: editForm.itemCode.trim() || null,
          item_name: editForm.itemName.trim() || null,
          status: editForm.status,
          reason: editForm.reason.trim(),
          qa_department: editForm.department || null,
          qa_reporter: editForm.reporter || null,
          qa_handlers: editForm.handlers,
          qa_category: editForm.category || null,
          qa_responsible: editForm.responsible,
          qa_disposition: Object.keys(editForm.disposition).length > 0 ? editForm.disposition : null,
          handler_department: editForm.handlerDepartment || null,
          handler_record: editForm.handling.trim() || null,
          attachments: uploadedUrls,
          loss_qty: editForm.lossQty === '' ? null : Number(editForm.lossQty),
          cause_analysis: editForm.causeAnalysis.trim() || null,
          immediate_action: editForm.immediateAction.trim() || null,
          corrective_action: editForm.correctiveAction.trim() || null,
        })
        .eq('id', editingId)

      if (error) throw error

      const msg = buildLineMessage(editForm, editForm.status === 'confirmed' ? 'update' : 'insert')
      setNotifyPreview(msg)
      setCopied(false)
      closeEditModal()
      await fetchReports()
    } catch (err: unknown) {
      const message = getReadableErrorMessage(err)
      alert(`更新失敗：${message}`)
    } finally {
      setSavingEdit(false)
    }
  }

  const handleDelete = async (report: AnomalyReport) => {
    if (!confirm(`確定刪除異常單 #${report.id}（單號：${report.order_number}）嗎？`)) return

    setDeletingId(report.id)
    try {
      const { error } = await supabase
        .from('schedule_anomaly_reports')
        .delete()
        .eq('id', report.id)

      if (error) throw error

      alert('🗑️ 已刪除異常單')
      await fetchReports()
    } catch (err: unknown) {
      alert(`刪除失敗：${getReadableErrorMessage(err)}`)
    } finally {
      setDeletingId(null)
    }
  }

  const reportRows = useMemo(() => [...pendingReports, ...completedReports], [pendingReports, completedReports])

  const reporterFilterOptions = useMemo(
    () => [...new Set(reports.map((report) => report.qa_reporter?.trim()).filter((value): value is string => !!value))],
    [reports],
  )

  const departmentFilterOptions = useMemo(
    () => [...new Set(reports.map((report) => report.qa_department?.trim()).filter((value): value is string => !!value))],
    [reports],
  )

  const handlerFilterOptions = useMemo(() => {
    const handlerSet = new Set<string>()
    reports.forEach((report) => {
      normalizeTextArray(report.qa_handlers).forEach((name) => name?.trim() && handlerSet.add(name.trim()))
    })
    return [...handlerSet]
  }, [reports])

  const responsibleFilterOptions = useMemo(() => {
    const responsibleSet = new Set<string>()
    reports.forEach((report) => {
      normalizeTextArray(report.qa_responsible).forEach((name) => name?.trim() && responsibleSet.add(name.trim()))
    })
    return [...responsibleSet]
  }, [reports])

  const categoryFilterOptions = useMemo(
    () => [...new Set(reports.map((report) => report.qa_category?.trim()).filter((value): value is string => !!value))],
    [reports],
  )

  const baseRowsWithoutStatusFilter = useMemo(() => {
    const keyword = orderKeyword.trim().toLowerCase()

    return reportRows.filter((report) => {
      const categoryMatch = !selectedCategory || (report.qa_category || '').trim() === selectedCategory
      const departmentMatch = !selectedDepartment || (report.qa_department || '').trim() === selectedDepartment
      const reporterMatch = !selectedReporter || (report.qa_reporter || '').trim() === selectedReporter
      const handlerMatch = !selectedHandler || normalizeTextArray(report.qa_handlers).map((name) => name.trim()).includes(selectedHandler)
      const responsibleMatch = !selectedResponsible || normalizeTextArray(report.qa_responsible).map((name) => name.trim()).includes(selectedResponsible)
      const orderMatch = !keyword || (report.order_number || '').toLowerCase().includes(keyword)
      const day = (report.created_at || '').slice(0, 10)
      const dateMatch = (!startDateFilter || day >= startDateFilter) && (!endDateFilter || day <= endDateFilter)

      return categoryMatch && departmentMatch && reporterMatch && handlerMatch && responsibleMatch && orderMatch && dateMatch
    })
  }, [
    orderKeyword,
    reportRows,
    selectedCategory,
    selectedDepartment,
    selectedHandler,
    selectedReporter,
    selectedResponsible,
    startDateFilter,
    endDateFilter,
  ])

  const statusCounts = useMemo(() => {
    return baseRowsWithoutStatusFilter.reduce(
      (acc, row) => {
        if (row.status === 'pending') acc.pending += 1
        if (row.status === 'confirmed') acc.confirmed += 1
        return acc
      },
      { pending: 0, confirmed: 0 },
    )
  }, [baseRowsWithoutStatusFilter])

  const filteredReportRows = useMemo(() => {
    return baseRowsWithoutStatusFilter.filter((report) => {
      const statusValue = (report.status || '').trim()
      const statusMatch =
        (statusFilter.pending && statusValue === 'pending') ||
        (statusFilter.confirmed && statusValue === 'confirmed')
      return statusMatch
    })
  }, [baseRowsWithoutStatusFilter, statusFilter.confirmed, statusFilter.pending])

  return (
    <div className="relative p-4 md:p-6 lg:p-8 max-w-[1900px] mx-auto min-h-screen space-y-6 md:space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white tracking-tight">異常紀錄表</h1>
          <p className="text-cyan-400 mt-1 font-mono text-sm uppercase">QA ANOMALY RECORDS</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={openCreateModal}
            className="px-3 py-2 rounded border border-emerald-600 text-emerald-300 hover:bg-emerald-900/30 text-sm"
          >
            新增異常單
          </button>
          <Link href="/qa/report" className="px-3 py-2 rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-900/30 text-sm">
            前往異常回報單
          </Link>
          <Link href="/qa/options" className="px-3 py-2 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-900/30 text-sm">
            編輯下拉選項
          </Link>
          <Link href="/qa" className="px-3 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm">
            返回品保專區
          </Link>
        </div>
      </div>

      <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-slate-400">篩選部門</label>
            <select
              value={selectedDepartment}
              onChange={(e) => setSelectedDepartment(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            >
              <option value="">全部部門</option>
              {departmentFilterOptions.map((department) => (
                <option key={department} value={department}>{department}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-400">篩選回報人</label>
            <select
              value={selectedReporter}
              onChange={(e) => setSelectedReporter(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            >
              <option value="">全部回報人</option>
              {reporterFilterOptions.map((person) => (
                <option key={person} value={person}>{person}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-400">篩選處理人</label>
            <select
              value={selectedHandler}
              onChange={(e) => setSelectedHandler(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            >
              <option value="">全部處理人</option>
              {handlerFilterOptions.map((person) => (
                <option key={person} value={person}>{person}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-400">篩選缺失人員</label>
            <select
              value={selectedResponsible}
              onChange={(e) => setSelectedResponsible(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            >
              <option value="">全部缺失人員</option>
              {responsibleFilterOptions.map((person) => (
                <option key={person} value={person}>{person}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-400">篩選分類</label>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            >
              <option value="">全部分類</option>
              {categoryFilterOptions.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-400">單號搜尋</label>
            <input
              value={orderKeyword}
              onChange={(e) => setOrderKeyword(e.target.value)}
              placeholder="輸入單號關鍵字"
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white placeholder:text-slate-500"
            />
          </div>

          <div className="lg:col-span-2">
            <label className="text-xs text-slate-400">日期區間</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="date"
                value={startDateFilter}
                onChange={(e) => setStartDateFilter(e.target.value)}
                className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
              />
              <span className="text-slate-500">~</span>
              <input
                type="date"
                value={endDateFilter}
                onChange={(e) => setEndDateFilter(e.target.value)}
                className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
              />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {([
                ['本月', 'thisMonth'],
                ['上個月', 'lastMonth'],
                ['近三個月', 'threeMonths'],
                ['近半年', 'sixMonths'],
                ['近一年', 'oneYear'],
              ] as const).map(([label, preset]) => (
                <button
                  key={preset}
                  onClick={() => applyDatePreset(preset)}
                  className="text-xs px-2 py-0.5 rounded-full border border-slate-700 text-slate-400 hover:border-cyan-500 hover:text-cyan-300 transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2">
            <label className="text-xs text-slate-400">篩選狀態</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <button
                onClick={() => setStatusFilter((prev) => ({ ...prev, pending: !prev.pending }))}
                className={`px-3 py-2 rounded border text-sm font-bold transition-colors ${statusFilter.pending ? 'bg-amber-900/30 border-amber-600 text-amber-300' : 'bg-slate-950 border-slate-700 text-slate-500'}`}
              >
                待處理（{statusCounts.pending}）
              </button>
              <button
                onClick={() => setStatusFilter((prev) => ({ ...prev, confirmed: !prev.confirmed }))}
                className={`px-3 py-2 rounded border text-sm font-bold transition-colors ${statusFilter.confirmed ? 'bg-emerald-900/30 border-emerald-600 text-emerald-300' : 'bg-slate-950 border-slate-700 text-slate-500'}`}
              >
                已確認（{statusCounts.confirmed}）
              </button>
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-slate-500">共 {filteredReportRows.length} 筆符合篩選</span>
          <button
            onClick={() => {
              setSelectedDepartment('')
              setSelectedReporter('')
              setSelectedHandler('')
              setSelectedResponsible('')
              setSelectedCategory('')
              setStatusFilter({ pending: true, confirmed: true })
              setOrderKeyword('')
              setStartDateFilter('')
              setEndDateFilter('')
            }}
            className="px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs"
          >
            清除篩選
          </button>
        </div>
      </div>

      <div className="bg-slate-900/50 border border-slate-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-slate-300 min-w-[1100px]">
          <thead className="bg-slate-950 text-slate-200 uppercase text-xs font-mono">
            <tr>
              <th className="px-2 py-3">日期 / 相關單號</th>
              <th className="px-2 py-3">品項</th>
              <th className="px-2 py-3">狀態</th>
              <th className="px-2 py-3">異常回報</th>
              <th className="px-2 py-3">異常處理</th>
              <th className="px-2 py-3">異常分類 / 原因</th>
              <th className="px-2 py-3">處理紀錄</th>
              <th className="px-2 py-3">缺失人員 / 處置</th>
              <th className="px-2 py-3">附件</th>
              <th className="px-2 py-3 text-center">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading ? (
              <tr><td colSpan={10} className="p-8 text-center text-slate-500">載入中...</td></tr>
            ) : filteredReportRows.length === 0 ? (
              <tr><td colSpan={10} className="p-8 text-center text-slate-500">無符合條件的異常紀錄</td></tr>
            ) : (
              filteredReportRows.map((report) => {
                const department = report.qa_department || ''
                const reporter = report.qa_reporter || ''
                const handlerDept = report.handler_department || ''
                const handlers = normalizeTextArray(report.qa_handlers)
                const category = report.qa_category || ''
                const responsible = normalizeTextArray(report.qa_responsible)
                const statusLabel = report.status === 'pending' ? '待處理' : report.status === 'confirmed' ? '已確認' : report.status

                return (
                  <tr key={report.id} className="hover:bg-slate-800/30 align-top">
                    <td className="px-2 py-3">
                      <div className="text-xs space-y-0.5">
                        <div className="font-mono text-slate-300 whitespace-nowrap">{new Date(report.created_at).toLocaleDateString()}</div>
                        <div className="font-mono text-cyan-300 whitespace-nowrap">{report.order_number}</div>
                      </div>
                    </td>

                    <td className="px-2 py-3">
                      <div className="text-xs space-y-0.5">
                        <div className="text-slate-400">{report.item_code || '-'}</div>
                        <div className="text-slate-100">{report.item_name || '-'}</div>
                      </div>
                    </td>

                    <td className="px-2 py-3">
                      <span className={`px-2 py-1 rounded border text-xs whitespace-nowrap ${report.status === 'pending' ? 'bg-amber-900/30 border-amber-700 text-amber-300' : 'bg-emerald-900/30 border-emerald-700 text-emerald-300'}`}>
                        {statusLabel || '-'}
                      </span>
                    </td>

                    <td className="px-2 py-3 min-w-[130px]">
                      <div className="text-xs space-y-0.5">
                        <div className="text-slate-400">{department || '-'}</div>
                        <div className="text-slate-100">{reporter || '-'}</div>
                      </div>
                    </td>

                    <td className="px-2 py-3 min-w-[130px]">
                      <div className="text-xs space-y-0.5">
                        <div className="text-slate-400">{handlerDept || '-'}</div>
                        <div className="text-slate-100">{handlers.length ? handlers.join('、') : '-'}</div>
                      </div>
                    </td>

                    <td className="px-2 py-3 min-w-[140px]">
                      <div className="text-xs space-y-0.5">
                        <div className="text-slate-400 whitespace-nowrap">{category || '-'}</div>
                        <div className="text-slate-100 line-clamp-2">{report.reason || '-'}</div>
                      </div>
                    </td>

                    <td className="px-2 py-3 min-w-[140px] text-slate-200 text-xs"><div className="line-clamp-2">{report.handler_record || '-'}</div></td>

                    <td className="px-2 py-3 min-w-[150px]">
                      {(() => {
                        const dispMap = parseDisp(report.qa_disposition)
                        return responsible.length > 0 ? (
                          <div className="space-y-1">
                            {responsible.map((person) => (
                              <div key={person} className="text-xs flex items-center gap-1 flex-wrap">
                                <span className="text-slate-300 whitespace-nowrap">{person}</span>
                                {dispMap[person] && (
                                  <span className="px-1.5 py-0.5 rounded bg-violet-900/30 border border-violet-700/50 text-violet-200 whitespace-nowrap">{dispMap[person]}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">-</span>
                        )
                      })()}
                    </td>

                    <td className="px-2 py-3">
                      {Array.isArray(report.attachments) && report.attachments.length > 0 ? (
                        <div className="flex gap-1 flex-wrap">
                          {report.attachments.map((url, i) => (
                            <button key={i} type="button" onClick={() => setLightboxUrl(url)}>
                              <img src={url} alt={`附件${i + 1}`} className="w-10 h-10 object-cover rounded border border-slate-600 hover:border-cyan-400 transition-colors cursor-pointer" />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">-</span>
                      )}
                    </td>

                    <td className="px-2 py-3 text-center min-w-[110px]">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => openEditModal(report)}
                          className="px-3 py-1.5 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-900/30 text-xs"
                        >
                          編輯
                        </button>
                        <button
                          onClick={() => void handleDelete(report)}
                          disabled={deletingId === report.id}
                          className="px-3 py-1.5 rounded border border-rose-700 text-rose-300 hover:bg-rose-900/30 text-xs disabled:opacity-60"
                        >
                          {deletingId === report.id ? '刪除中...' : '刪除'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      {creating && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-[900px] bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-white">新增異常單</h2>
              <button onClick={closeCreateModal} className="px-2 py-1 text-slate-300 hover:text-white">✕</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-400">日期</label>
                <input
                  type="date"
                  value={createForm.createdDate}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, createdDate: e.target.value }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">相關單號</label>
                <input
                  value={createForm.orderNumber}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, orderNumber: e.target.value }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">品項編碼（選填）</label>
                <input
                  value={createForm.itemCode}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, itemCode: e.target.value }))}
                  placeholder="例：A-001"
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">品名/名稱（選填）</label>
                <input
                  value={createForm.itemName}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, itemName: e.target.value }))}
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
                  value={createForm.lossQty}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, lossQty: e.target.value }))}
                  placeholder="缺失導致損失數量"
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white placeholder:text-slate-500"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">狀態</label>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setCreateForm((prev) => ({ ...prev, status: 'pending' }))}
                    className={`px-3 py-2 rounded border text-sm font-bold transition-colors ${createForm.status === 'pending' ? 'bg-amber-900/30 border-amber-600 text-amber-300' : 'bg-slate-950 border-slate-700 text-slate-500'}`}
                  >
                    待處理
                  </button>
                  <button
                    onClick={() => setCreateForm((prev) => ({ ...prev, status: 'confirmed' }))}
                    className={`px-3 py-2 rounded border text-sm font-bold transition-colors ${createForm.status === 'confirmed' ? 'bg-emerald-900/30 border-emerald-600 text-emerald-300' : 'bg-slate-950 border-slate-700 text-slate-500'}`}
                  >
                    已確認
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400">異常回報-部門</label>
                <select
                  value={createForm.department}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, department: e.target.value, reporter: '' }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                >
                  <option value="">請選擇</option>
                  {options.departments.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400">異常回報-人員</label>
                {createForm.department ? (
                  <select
                    value={createForm.reporter}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, reporter: e.target.value }))}
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                  >
                    <option value="">請選擇</option>
                    {options.personnel.filter((p) => p.department_value === createForm.department).map((p) => (
                      <option key={p.option_value} value={p.option_value}>{p.option_value}</option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-500 text-sm">請先選部門</div>
                )}
              </div>

              <div>
                <label className="text-xs text-slate-400">異常處理-部門</label>
                <select
                  value={createForm.handlerDepartment}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, handlerDepartment: e.target.value, handlers: [] }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                >
                  <option value="">請選擇</option>
                  {options.departments.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400">異常處理-人員</label>
                {createForm.handlerDepartment ? (
                  <select
                    value={createForm.handlers[0] || ''}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, handlers: e.target.value ? [e.target.value] : [] }))}
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                  >
                    <option value="">請選擇</option>
                    {options.personnel.filter((p) => p.department_value === createForm.handlerDepartment).map((p) => (
                      <option key={p.option_value} value={p.option_value}>{p.option_value}</option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-500 text-sm">請先選部門</div>
                )}
              </div>

              <div>
                <label className="text-xs text-slate-400">異常分類</label>
                <select
                  value={createForm.category}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, category: e.target.value }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                >
                  <option value="">請選擇</option>
                  {options.categories.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-400">異常原因（手填）</label>
              <textarea
                rows={3}
                value={createForm.reason}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, reason: e.target.value }))}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400">異常處理（手填）</label>
              <textarea
                rows={3}
                value={createForm.handling}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, handling: e.target.value }))}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div>
                <label className="text-xs text-slate-400">缺失-部門</label>
                <select
                  value={createForm.responsibleDepartment}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, responsibleDepartment: e.target.value }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                >
                  <option value="">請選擇</option>
                  {options.departments.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400">缺失-人員</label>
                {createForm.responsibleDepartment ? (
                  <div className="mt-1 space-y-2">
                    <div className="space-y-1.5">
                      {createForm.responsible.map((name) => (
                        <div key={name} className="flex items-center gap-2 px-2 py-1.5 rounded bg-amber-900/20 border border-amber-700/50">
                          <span className="text-amber-200 text-xs font-medium flex-shrink-0">{name}</span>
                          <select
                            value={createForm.disposition[name] || ''}
                            onChange={(e) => setCreateForm((prev) => ({ ...prev, disposition: { ...prev.disposition, [name]: e.target.value } }))}
                            className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-xs text-white min-w-0"
                          >
                            <option value="">處置...</option>
                            {options.dispositions.map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => setCreateForm((prev) => {
                              const newDisp = { ...prev.disposition }
                              delete newDisp[name]
                              return { ...prev, responsible: prev.responsible.filter((item) => item !== name), disposition: newDisp }
                            })}
                            className="text-amber-500 hover:text-white text-sm flex-shrink-0"
                          >×</button>
                        </div>
                      ))}
                    </div>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const value = e.target.value
                        if (!value) return
                        setCreateForm((prev) => prev.responsible.includes(value) ? prev : { ...prev, responsible: [...prev.responsible, value] })
                        e.currentTarget.value = ''
                      }}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                    >
                      <option value="">+ 新增缺失人員</option>
                      {options.personnel.filter((p) => p.department_value === createForm.responsibleDepartment).map((p) => (
                        <option key={p.option_value} value={p.option_value}>{p.option_value}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-500 text-sm">請先選部門</div>
                )}
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-400">附件圖片（選填）</label>
              <div className="mt-1 flex gap-2">
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => {
                    const files = Array.from(e.target.files || [])
                    if (!files.length) return
                    setCreateForm((prev) => ({ ...prev, attachFiles: [...prev.attachFiles, ...files] }))
                    const urls = files.map((f) => URL.createObjectURL(f))
                    setCreateForm((prev) => ({ ...prev, previewUrls: [...prev.previewUrls, ...urls] }))
                    e.target.value = ''
                  }}
                  className="flex-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white text-sm file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:bg-cyan-900 file:text-cyan-200 file:text-xs"
                />
                <button
                  type="button"
                  onClick={() => startMobileSession('create')}
                  className="px-3 py-2 rounded border border-violet-600 text-violet-300 hover:bg-violet-900/30 text-sm whitespace-nowrap"
                >
                  📱 手機拍照
                </button>
              </div>
              {createForm.previewUrls.length > 0 && (
                <div className="mt-2 flex gap-2 flex-wrap">
                  {createForm.previewUrls.map((url, idx) => (
                    <div key={idx} className="relative group">
                      <img src={url} alt={`preview-${idx}`} className="w-16 h-16 object-cover rounded border border-slate-600" />
                      <button
                        type="button"
                        className="absolute -top-1 -right-1 w-5 h-5 bg-rose-600 text-white rounded-full text-xs hidden group-hover:flex items-center justify-center"
                        onClick={() => setCreateForm((prev) => ({
                          ...prev,
                          attachFiles: prev.attachFiles.filter((_, i) => i !== idx),
                          previewUrls: prev.previewUrls.filter((_, i) => i !== idx),
                        }))}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={closeCreateModal} className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">取消</button>
              <button
                onClick={() => void handleCreate()}
                disabled={savingCreate}
                className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold disabled:bg-slate-700 disabled:text-slate-400"
              >
                {savingCreate ? '新增中...' : '新增異常單'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingId && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-[900px] bg-slate-900 border border-slate-700 rounded-2xl p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-white">編輯異常單</h2>
              <button onClick={closeEditModal} className="px-2 py-1 text-slate-300 hover:text-white">✕</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400">日期</label>
                <input
                  type="date"
                  value={editForm.createdDate}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, createdDate: e.target.value }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">相關單號</label>
                <input
                  value={editForm.orderNumber}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, orderNumber: e.target.value }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">品項編碼（選填）</label>
                <input
                  value={editForm.itemCode}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, itemCode: e.target.value }))}
                  placeholder="例：A-001"
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">品名/名稱（選填）</label>
                <input
                  value={editForm.itemName}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, itemName: e.target.value }))}
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
                  value={editForm.lossQty}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, lossQty: e.target.value }))}
                  placeholder="缺失導致損失數量"
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white placeholder:text-slate-500"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">狀態</label>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setEditForm((prev) => ({ ...prev, status: 'pending' }))}
                    className={`px-3 py-1.5 rounded border text-sm font-bold transition-colors ${editForm.status === 'pending' ? 'bg-amber-900/30 border-amber-600 text-amber-300' : 'bg-slate-950 border-slate-700 text-slate-500'}`}
                  >
                    待處理
                  </button>
                  <button
                    onClick={() => setEditForm((prev) => ({ ...prev, status: 'confirmed' }))}
                    className={`px-3 py-1.5 rounded border text-sm font-bold transition-colors ${editForm.status === 'confirmed' ? 'bg-emerald-900/30 border-emerald-600 text-emerald-300' : 'bg-slate-950 border-slate-700 text-slate-500'}`}
                  >
                    已確認
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400">異常分類</label>
                <select
                  value={editForm.category}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, category: e.target.value }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                >
                  <option value="">請選擇</option>
                  {options.categories.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400">異常回報-部門</label>
                <select
                  value={editForm.department}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, department: e.target.value, reporter: '' }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                >
                  <option value="">請選擇</option>
                  {options.departments.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400">異常回報-人員</label>
                {editForm.department ? (
                  <select
                    value={editForm.reporter}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, reporter: e.target.value }))}
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                  >
                    <option value="">請選擇</option>
                    {options.personnel.filter((p) => p.department_value === editForm.department).map((p) => (
                      <option key={p.option_value} value={p.option_value}>{p.option_value}</option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-500 text-sm">請先選部門</div>
                )}
              </div>

              <div>
                <label className="text-xs text-slate-400">異常處理-部門</label>
                <select
                  value={editForm.handlerDepartment}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, handlerDepartment: e.target.value, handlers: [] }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                >
                  <option value="">請選擇</option>
                  {options.departments.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400">異常處理-人員</label>
                {editForm.handlerDepartment ? (
                  <select
                    value={editForm.handlers[0] || ''}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, handlers: e.target.value ? [e.target.value] : [] }))}
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                  >
                    <option value="">請選擇</option>
                    {options.personnel.filter((p) => p.department_value === editForm.handlerDepartment).map((p) => (
                      <option key={p.option_value} value={p.option_value}>{p.option_value}</option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-500 text-sm">請先選部門</div>
                )}
              </div>

            </div>

            <div>
              <label className="text-xs text-slate-400">異常原因（手填）</label>
              <textarea
                rows={2}
                value={editForm.reason}
                onChange={(e) => setEditForm((prev) => ({ ...prev, reason: e.target.value }))}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-white"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400">異常處理（手填）</label>
              <textarea
                rows={2}
                value={editForm.handling}
                onChange={(e) => setEditForm((prev) => ({ ...prev, handling: e.target.value }))}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-white"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400">異常原因分析（缺失單列印用）</label>
              <textarea
                rows={2}
                value={editForm.causeAnalysis}
                onChange={(e) => setEditForm((prev) => ({ ...prev, causeAnalysis: e.target.value }))}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-white"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400">即時處理方式（缺失單列印用）</label>
              <textarea
                rows={2}
                value={editForm.immediateAction}
                onChange={(e) => setEditForm((prev) => ({ ...prev, immediateAction: e.target.value }))}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-white"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400">預防及修正方式（缺失單列印用）</label>
              <textarea
                rows={2}
                value={editForm.correctiveAction}
                onChange={(e) => setEditForm((prev) => ({ ...prev, correctiveAction: e.target.value }))}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-white"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
              <div>
                <label className="text-xs text-slate-400">缺失-部門</label>
                <select
                  value={editForm.responsibleDepartment}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, responsibleDepartment: e.target.value }))}
                  className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                >
                  <option value="">請選擇</option>
                  {options.departments.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400">缺失-人員</label>
                {editForm.responsibleDepartment ? (
                  <div className="mt-1 space-y-2">
                    <div className="space-y-1.5">
                      {editForm.responsible.map((name) => (
                        <div key={name} className="flex items-center gap-2 px-2 py-1.5 rounded bg-amber-900/20 border border-amber-700/50">
                          <span className="text-amber-200 text-xs font-medium flex-shrink-0">{name}</span>
                          <select
                            value={editForm.disposition[name] || ''}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, disposition: { ...prev.disposition, [name]: e.target.value } }))}
                            className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-xs text-white min-w-0"
                          >
                            <option value="">處置...</option>
                            {options.dispositions.map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => setEditForm((prev) => {
                              const newDisp = { ...prev.disposition }
                              delete newDisp[name]
                              return { ...prev, responsible: prev.responsible.filter((item) => item !== name), disposition: newDisp }
                            })}
                            className="text-amber-500 hover:text-white text-sm flex-shrink-0"
                          >×</button>
                        </div>
                      ))}
                    </div>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const value = e.target.value
                        if (!value) return
                        setEditForm((prev) => prev.responsible.includes(value) ? prev : { ...prev, responsible: [...prev.responsible, value] })
                        e.currentTarget.value = ''
                      }}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
                    >
                      <option value="">+ 新增缺失人員</option>
                      {options.personnel.filter((p) => p.department_value === editForm.responsibleDepartment).map((p) => (
                        <option key={p.option_value} value={p.option_value}>{p.option_value}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-500 text-sm">請先選部門</div>
                )}
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-400">附件圖片</label>
              {editForm.existingAttachments.length > 0 && (
                <div className="mt-1 flex gap-2 flex-wrap">
                  {editForm.existingAttachments.map((url, idx) => (
                    <div key={`existing-${idx}`} className="relative group">
                      <img src={url} alt={`existing-${idx}`} className="w-16 h-16 object-cover rounded border border-slate-600" />
                      <button
                        type="button"
                        className="absolute -top-1 -right-1 w-5 h-5 bg-rose-600 text-white rounded-full text-xs hidden group-hover:flex items-center justify-center"
                        onClick={() => setEditForm((prev) => ({
                          ...prev,
                          existingAttachments: prev.existingAttachments.filter((_, i) => i !== idx),
                        }))}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-1 flex gap-2">
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => {
                    const files = Array.from(e.target.files || [])
                    if (!files.length) return
                    setEditForm((prev) => ({ ...prev, attachFiles: [...prev.attachFiles, ...files] }))
                    const urls = files.map((f) => URL.createObjectURL(f))
                    setEditForm((prev) => ({ ...prev, previewUrls: [...prev.previewUrls, ...urls] }))
                    e.target.value = ''
                  }}
                  className="flex-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white text-sm file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:bg-cyan-900 file:text-cyan-200 file:text-xs"
                />
                <button
                  type="button"
                  onClick={() => startMobileSession('edit')}
                  className="px-3 py-2 rounded border border-violet-600 text-violet-300 hover:bg-violet-900/30 text-sm whitespace-nowrap"
                >
                  📱 手機拍照
                </button>
              </div>
              {editForm.previewUrls.length > 0 && (
                <div className="mt-2 flex gap-2 flex-wrap">
                  {editForm.previewUrls.map((url, idx) => (
                    <div key={`new-${idx}`} className="relative group">
                      <img src={url} alt={`preview-${idx}`} className="w-16 h-16 object-cover rounded border border-cyan-700" />
                      <button
                        type="button"
                        className="absolute -top-1 -right-1 w-5 h-5 bg-rose-600 text-white rounded-full text-xs hidden group-hover:flex items-center justify-center"
                        onClick={() => setEditForm((prev) => ({
                          ...prev,
                          attachFiles: prev.attachFiles.filter((_, i) => i !== idx),
                          previewUrls: prev.previewUrls.filter((_, i) => i !== idx),
                        }))}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={closeEditModal} className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">取消</button>
              <button
                onClick={() => void handleSaveEdit()}
                disabled={savingEdit}
                className="px-4 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-bold disabled:bg-slate-700 disabled:text-slate-400"
              >
                {savingEdit ? '儲存中...' : '儲存變更'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showQrModal && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-sm w-full space-y-4">
            <h2 className="text-lg font-bold text-white text-center">📱 手機掃碼上傳圖片</h2>
            <p className="text-xs text-slate-400 text-center">用手機掃描下方 QR Code 拍照上傳，照片會自動同步到表單</p>
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

      {lightboxUrl && (
        <div className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4" onClick={() => setLightboxUrl(null)}>
          <div className="relative max-w-4xl max-h-[90vh]">
            <img src={lightboxUrl} alt="附件大圖" className="max-w-full max-h-[90vh] object-contain rounded-lg" />
            <button
              className="absolute top-2 right-2 w-8 h-8 bg-slate-900/80 text-white rounded-full flex items-center justify-center hover:bg-slate-700"
              onClick={() => setLightboxUrl(null)}
            >✕</button>
          </div>
        </div>
      )}
    </div>
  )
}
