'use client'

import { NavButton } from '../../../../components/NavButton'
import { useCallback, useEffect, useRef, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type OptionType = 'category' | 'department' | 'person'
type ActiveTab = 'records' | 'options'

interface OptionItem {
  id: number
  option_type: OptionType
  option_value: string
  created_at: string
}

interface AnomalyRecord {
  id: number
  anomaly_date: string | null
  anomaly_category: string | null
  responsible_department: string | null
  responsible_person: string | null
  anomaly_description: string | null
  resolution: string | null
  attachments: string[] | null
  created_at: string
  updated_at: string
}

interface FormState {
  anomaly_date: string
  anomaly_category: string
  responsible_department: string
  responsible_person: string
  anomaly_description: string
  resolution: string
  attachFiles: File[]
  previewUrls: string[]
  existingAttachments: string[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OPTION_CONFIG: Record<OptionType, { label: string; accent: string; badge: string }> = {
  category:   { label: '異常分類',   accent: 'border-orange-500 focus:ring-orange-500', badge: 'bg-orange-900/40 text-orange-300 border-orange-700' },
  department: { label: '權責部門',   accent: 'border-cyan-500   focus:ring-cyan-500',   badge: 'bg-cyan-900/40   text-cyan-300   border-cyan-700'   },
  person:     { label: '異常發生人員', accent: 'border-violet-500 focus:ring-violet-500', badge: 'bg-violet-900/40 text-violet-300 border-violet-700' },
}

const DEFAULT_FORM: FormState = {
  anomaly_date: new Date().toISOString().slice(0, 10),
  anomaly_category: '',
  responsible_department: '',

  responsible_person: '',
  anomaly_description: '',
  resolution: '',
  attachFiles: [],
  previewUrls: [],
  existingAttachments: [],
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OrderAnomalyPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('records')

  // Records state
  const [records, setRecords] = useState<AnomalyRecord[]>([])
  const [loadingRecords, setLoadingRecords] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)

  // Options state
  const [allOptions, setAllOptions] = useState<OptionItem[]>([])
  const [loadingOptions, setLoadingOptions] = useState(true)
  const [newOptionValue, setNewOptionValue] = useState<Record<OptionType, string>>({ category: '', department: '', person: '' })
  const [addingOption, setAddingOption] = useState<OptionType | null>(null)
  const [deletingOptionId, setDeletingOptionId] = useState<number | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const optionsByType = {
    category:   allOptions.filter(o => o.option_type === 'category').map(o => o.option_value),
    department: allOptions.filter(o => o.option_type === 'department').map(o => o.option_value),
    person:     allOptions.filter(o => o.option_type === 'person').map(o => o.option_value),
  }

  // ─── Fetch ──────────────────────────────────────────────────────────────────

  const fetchRecords = useCallback(async () => {
    setLoadingRecords(true)
    try {
      const res = await fetch('/api/production/order-anomaly')
      const json = await res.json()
      if (json?.success) setRecords((json.records as AnomalyRecord[]) || [])
    } catch {
      // 保持原本行為：失敗時不 alert，僅維持既有清單
    }
    setLoadingRecords(false)
  }, [])

  const fetchOptions = useCallback(async () => {
    setLoadingOptions(true)
    try {
      const res = await fetch('/api/production/order-anomaly/options')
      const json = await res.json()
      if (json?.success) setAllOptions((json.options as OptionItem[]) || [])
    } catch {
      // 保持原本行為：失敗時不 alert，僅維持既有清單
    }
    setLoadingOptions(false)
  }, [])

  useEffect(() => {
    void fetchRecords()
    void fetchOptions()
  }, [fetchRecords, fetchOptions])

  // ─── Record CRUD ────────────────────────────────────────────────────────────

  const openCreate = () => {
    setEditingId(null)
    setForm(DEFAULT_FORM)
    setShowForm(true)
  }

  const openEdit = (record: AnomalyRecord) => {
    setEditingId(record.id)
    setForm({
      anomaly_date:           record.anomaly_date           || '',
      anomaly_category:       record.anomaly_category       || '',

      responsible_department: record.responsible_department || '',
      responsible_person:     record.responsible_person     || '',
      anomaly_description:    record.anomaly_description    || '',
      resolution:             record.resolution             || '',
      attachFiles:            [],
      previewUrls:            [],
      existingAttachments:    record.attachments            || [],
    })
    setShowForm(true)
  }

  const closeForm = () => {
    form.previewUrls.forEach(u => URL.revokeObjectURL(u))
    setShowForm(false)
    setForm(DEFAULT_FORM)
    setEditingId(null)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    const urls = files.map(f => URL.createObjectURL(f))
    setForm(prev => ({
      ...prev,
      attachFiles: [...prev.attachFiles, ...files],
      previewUrls: [...prev.previewUrls, ...urls],
    }))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeNewFile = (idx: number) => {
    setForm(prev => {
      URL.revokeObjectURL(prev.previewUrls[idx])
      return {
        ...prev,
        attachFiles: prev.attachFiles.filter((_, i) => i !== idx),
        previewUrls: prev.previewUrls.filter((_, i) => i !== idx),
      }
    })
  }

  const removeExisting = (url: string) => {
    setForm(prev => ({
      ...prev,
      existingAttachments: prev.existingAttachments.filter(u => u !== url),
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const fd = new FormData()
      fd.append('anomaly_date', form.anomaly_date || '')
      fd.append('anomaly_category', form.anomaly_category || '')
      fd.append('responsible_department', form.responsible_department || '')
      fd.append('responsible_person', form.responsible_person || '')
      fd.append('anomaly_description', form.anomaly_description || '')
      fd.append('resolution', form.resolution || '')
      fd.append('existing_attachments', JSON.stringify(form.existingAttachments))
      for (const file of form.attachFiles) fd.append('files', file)
      if (editingId) fd.append('id', String(editingId))

      const res = await fetch('/api/production/order-anomaly', {
        method: editingId ? 'PUT' : 'POST',
        body: fd,
      })
      const json = await res.json()
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`)

      await fetchRecords()
      closeForm()
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : JSON.stringify(err)
      alert(`儲存失敗：${msg}`)
    }
    setSaving(false)
  }

  const handleDelete = async (id: number) => {
    if (!confirm('確定要刪除此筆異常紀錄？此操作無法復原。')) return
    setDeletingId(id)
    const res = await fetch(`/api/production/order-anomaly?id=${id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok || !json?.success) alert(`刪除失敗：${json?.error || `HTTP ${res.status}`}`)
    else await fetchRecords()
    setDeletingId(null)
  }

  // ─── Options CRUD ───────────────────────────────────────────────────────────

  const handleAddOption = async (type: OptionType) => {
    const value = newOptionValue[type].trim()
    if (!value) return
    setAddingOption(type)
    const res = await fetch('/api/production/order-anomaly/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option_type: type, option_value: value }),
    })
    const json = await res.json()
    if (!res.ok || !json?.success) alert(`新增失敗：${json?.error || `HTTP ${res.status}`}`)
    else {
      setNewOptionValue(prev => ({ ...prev, [type]: '' }))
      await fetchOptions()
    }
    setAddingOption(null)
  }

  const handleDeleteOption = async (id: number) => {
    if (!confirm('確定要刪除此選項？')) return
    setDeletingOptionId(id)
    const res = await fetch(`/api/production/order-anomaly/options?id=${id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok || !json?.success) alert(`刪除失敗：${json?.error || `HTTP ${res.status}`}`)
    else await fetchOptions()
    setDeletingOptionId(null)
  }

  // ─── Render helpers ─────────────────────────────────────────────────────────

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
      .replace('T', ' ').slice(0, 16)

  const isImage = (url: string) => /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url)

  // ─── Sub-renders ─────────────────────────────────────────────────────────────

  const renderDropdown = (
    field: keyof Pick<FormState, 'anomaly_category' | 'responsible_department' | 'responsible_person'>,
    type: OptionType,
    label: string,
  ) => (
    <div>
      <label className="block text-sm text-slate-400 mb-1">{label}</label>
      <select
        value={form[field]}
        onChange={e => setForm(prev => ({ ...prev, [field]: e.target.value }))}
        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="">— 請選擇 —</option>
        {optionsByType[type].map(v => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    </div>
  )

  // ─── Records Tab ─────────────────────────────────────────────────────────────

  const renderRecordsTab = () => (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          新增異常紀錄
        </button>
      </div>

      {loadingRecords ? (
        <div className="text-center py-16 text-slate-500 animate-pulse">載入中...</div>
      ) : records.length === 0 ? (
        <div className="text-center py-16 text-slate-600 border-2 border-dashed border-slate-700 rounded-2xl">
          尚無紀錄，請點選「新增異常紀錄」建立第一筆。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-700">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-800/80 text-slate-400 uppercase text-xs tracking-wide">
              <tr>
                <th className="px-4 py-3 whitespace-nowrap">#</th>
                <th className="px-4 py-3 whitespace-nowrap">異常日期</th>
                <th className="px-4 py-3 whitespace-nowrap">異常分類</th>
                <th className="px-4 py-3 whitespace-nowrap">權責部門</th>
                <th className="px-4 py-3 whitespace-nowrap">異常發生人員</th>
                <th className="px-4 py-3 min-w-[200px]">異常狀況概述</th>
                <th className="px-4 py-3 min-w-[160px]">處理結果</th>
                <th className="px-4 py-3 whitespace-nowrap">附件</th>
                <th className="px-4 py-3 whitespace-nowrap">建立時間</th>
                <th className="px-4 py-3 whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {records.map((rec, idx) => (
                <tr key={rec.id} className="bg-slate-900/40 hover:bg-slate-800/40 transition-colors">
                  <td className="px-4 py-3 text-slate-500 font-mono">{idx + 1}</td>
                  <td className="px-4 py-3 text-slate-300 text-xs font-mono whitespace-nowrap">{rec.anomaly_date ?? <span className="text-slate-600">—</span>}</td>
                  <td className="px-4 py-3">
                    {rec.anomaly_category
                      ? <span className="inline-block px-2 py-0.5 rounded-full bg-orange-900/40 text-orange-300 border border-orange-700 text-xs">{rec.anomaly_category}</span>
                      : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {rec.responsible_department
                      ? <span className="inline-block px-2 py-0.5 rounded-full bg-cyan-900/40 text-cyan-300 border border-cyan-700 text-xs">{rec.responsible_department}</span>
                      : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {rec.responsible_person
                      ? <span className="inline-block px-2 py-0.5 rounded-full bg-violet-900/40 text-violet-300 border border-violet-700 text-xs">{rec.responsible_person}</span>
                      : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-300 max-w-[240px] truncate" title={rec.anomaly_description ?? ''}>
                    {rec.anomaly_description || <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-300 max-w-[200px] truncate" title={rec.resolution ?? ''}>
                    {rec.resolution || <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {rec.attachments && rec.attachments.length > 0 ? (
                      <div className="flex gap-1 flex-wrap">
                        {rec.attachments.map((url, i) =>
                          isImage(url) ? (
                            <button key={i} onClick={() => setLightboxUrl(url)} className="block w-10 h-10 rounded overflow-hidden border border-slate-600 hover:border-blue-400 transition-colors flex-shrink-0">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={url} alt={`附件 ${i + 1}`} className="w-full h-full object-cover" />
                            </button>
                          ) : (
                            <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-1 px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-slate-300 text-xs transition-colors">
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                              檔{i + 1}
                            </a>
                          )
                        )}
                      </div>
                    ) : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap font-mono">{formatDate(rec.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => openEdit(rec)}
                        className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs transition-colors"
                      >編輯</button>
                      <button
                        onClick={() => handleDelete(rec.id)}
                        disabled={deletingId === rec.id}
                        className="px-3 py-1.5 bg-red-900/50 hover:bg-red-800/60 text-red-300 rounded-lg text-xs transition-colors disabled:opacity-40"
                      >{deletingId === rec.id ? '…' : '刪除'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  // ─── Options Tab ─────────────────────────────────────────────────────────────

  const renderOptionsTab = () => (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {(Object.keys(OPTION_CONFIG) as OptionType[]).map(type => {
        const cfg = OPTION_CONFIG[type]
        const items = allOptions.filter(o => o.option_type === type)
        return (
          <div key={type} className="rounded-2xl border border-slate-700 bg-slate-900/50 p-5 space-y-4">
            <h3 className={`font-bold text-white text-lg border-b border-slate-700 pb-3`}>
              {cfg.label}
              <span className="ml-2 text-xs font-mono text-slate-500">({items.length})</span>
            </h3>

            {/* Add new */}
            <div className="flex gap-2">
              <input
                type="text"
                value={newOptionValue[type]}
                onChange={e => setNewOptionValue(prev => ({ ...prev, [type]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') void handleAddOption(type) }}
                placeholder={`新增${cfg.label}…`}
                className="flex-1 bg-slate-800 border border-slate-600 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-slate-600"
              />
              <button
                onClick={() => void handleAddOption(type)}
                disabled={addingOption === type || !newOptionValue[type].trim()}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-semibold transition-colors whitespace-nowrap"
              >
                {addingOption === type ? '…' : '新增'}
              </button>
            </div>

            {/* Items list */}
            {loadingOptions ? (
              <p className="text-slate-500 text-sm text-center py-4 animate-pulse">載入中…</p>
            ) : items.length === 0 ? (
              <p className="text-slate-600 text-sm text-center py-4">尚無選項</p>
            ) : (
              <ul className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {items.map(item => (
                  <li key={item.id} className="flex items-center justify-between gap-2 group">
                    <span className={`flex-1 px-3 py-1.5 rounded-lg border text-sm ${cfg.badge}`}>
                      {item.option_value}
                    </span>
                    <button
                      onClick={() => void handleDeleteOption(item.id)}
                      disabled={deletingOptionId === item.id}
                      className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-500 hover:text-red-400 transition-all disabled:opacity-40"
                      title="刪除"
                    >
                      {deletingOptionId === item.id ? (
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582M20 20v-5h-.581M4.582 9a8 8 0 0115.357 5M19.418 15a8 8 0 01-15.357-5" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )

  // ─── Form Modal ──────────────────────────────────────────────────────────────

  const renderFormModal = () => (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm pt-6 px-4 pb-6 overflow-y-auto">
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl">
        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="text-lg font-bold text-white">
            {editingId ? '編輯異常紀錄' : '新增異常紀錄'}
          </h2>
          <button onClick={closeForm} className="text-slate-500 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Modal body */}
        <div className="p-6 space-y-5">
          {/* Row 0: Date */}
          <div>
            <label className="block text-sm text-slate-400 mb-1">異常日期</label>
            <input
              type="date"
              value={form.anomaly_date}
              onChange={e => setForm(prev => ({ ...prev, anomaly_date: e.target.value }))}
              className="w-full sm:w-48 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Row 1: Dropdowns */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {renderDropdown('anomaly_category',       'category',   '異常分類')}
            {renderDropdown('responsible_department', 'department', '權責部門')}
            {renderDropdown('responsible_person',     'person',     '異常發生人員')}
          </div>

          {/* Row 2: Description */}
          <div>
            <label className="block text-sm text-slate-400 mb-1">
              異常狀況概述
            </label>
            <textarea
              rows={4}
              value={form.anomaly_description}
              onChange={e => setForm(prev => ({ ...prev, anomaly_description: e.target.value }))}
              placeholder="請描述異常狀況…"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-slate-600"
            />
          </div>

          {/* Row 3: Resolution */}
          <div>
            <label className="block text-sm text-slate-400 mb-1">
              處理結果
            </label>
            <textarea
              rows={3}
              value={form.resolution}
              onChange={e => setForm(prev => ({ ...prev, resolution: e.target.value }))}
              placeholder="請填寫處理結果…"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-slate-600"
            />
          </div>

          {/* Row 4: File upload */}
          <div>
            <label className="block text-sm text-slate-400 mb-2">附件（圖片或檔案）</label>

            {/* Existing attachments */}
            {form.existingAttachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {form.existingAttachments.map((url, i) => (
                  <div key={i} className="relative group">
                    {isImage(url) ? (
                      <button
                        type="button"
                        onClick={() => setLightboxUrl(url)}
                        className="block w-20 h-20 rounded-lg overflow-hidden border border-slate-600 hover:border-blue-400 transition-colors"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={`附件 ${i + 1}`} className="w-full h-full object-cover" />
                      </button>
                    ) : (
                      <a href={url} target="_blank" rel="noopener noreferrer"
                        className="flex flex-col items-center justify-center w-20 h-20 rounded-lg border border-slate-600 bg-slate-800 hover:border-blue-400 text-slate-400 text-xs gap-1 transition-colors">
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                        檔案
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => removeExisting(url)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-600 hover:bg-red-500 rounded-full text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* New file previews */}
            {form.previewUrls.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {form.previewUrls.map((url, i) => (
                  <div key={i} className="relative group">
                    {isImage(url) ? (
                      <div className="w-20 h-20 rounded-lg overflow-hidden border border-blue-500/60">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={`新附件 ${i + 1}`} className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center w-20 h-20 rounded-lg border border-blue-500/60 bg-slate-800 text-slate-400 text-xs gap-1">
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        {form.attachFiles[i]?.name?.split('.').pop()?.toUpperCase() ?? 'FILE'}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeNewFile(i)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-600 hover:bg-red-500 rounded-full text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Upload button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 border border-dashed border-slate-600 hover:border-blue-500 rounded-xl text-slate-400 hover:text-blue-400 text-sm transition-colors w-full justify-center"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 16V4m0 12l-3-3m3 3l3-3M4 20h16" />
              </svg>
              點擊上傳圖片或檔案（可多選）
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
        </div>

        {/* Modal footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-700">
          <button
            onClick={closeForm}
            disabled={saving}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors"
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
    </div>
  )

  // ─── Main render ─────────────────────────────────────────────────────────────

  return (
    <>
      <div className="p-6 md:p-8 max-w-[1400px] mx-auto min-h-screen space-y-6">
        {/* Page header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tight">開單異常統計</h1>
            <p className="text-blue-400 mt-1 font-mono text-sm uppercase">
              ORDER ANOMALY STATISTICS // 生管管理入口
            </p>
          </div>
          <NavButton href="/admin" direction="home" title="回到首頁" className="px-3 py-2" />
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 p-1 bg-slate-800/60 rounded-xl w-fit border border-slate-700">
          {([['records', '異常紀錄'], ['options', '下拉選項管理']] as [ActiveTab, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
                activeTab === key
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {label}
              {key === 'records' && !loadingRecords && (
                <span className="ml-2 text-xs bg-slate-700/60 text-slate-400 px-1.5 py-0.5 rounded-full">
                  {records.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === 'records' ? renderRecordsTab() : renderOptionsTab()}
      </div>

      {/* Form modal */}
      {showForm && renderFormModal()}

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 cursor-zoom-out"
          onClick={() => setLightboxUrl(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="附件預覽"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 p-2 bg-slate-800/80 hover:bg-slate-700 rounded-full text-white transition-colors"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </>
  )
}
