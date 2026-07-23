'use client'

import Link from 'next/link'
import { useCallback, useMemo, useState } from 'react'
import { NavButton } from '../../../components/NavButton'
import * as XLSX from 'xlsx'
import { supabase } from '../../../lib/supabaseClient'
import SoOrderModal from '../../../components/SoOrderModal'
import { printDeficiencySheets } from '../../../lib/qa/deficiencyPrint'

interface AnomalyRow {
  id: number
  order_number: string
  item_code: string | null
  item_name: string | null
  reason: string | null
  qa_reporter: string | null
  qa_handlers: string[] | null
  qa_responsible: string[] | null
  qa_category: string | null
  qa_disposition: Record<string, string> | null
  created_at: string
  status: string | null
  loss_qty: number | null
  cause_analysis: string | null
  immediate_action: string | null
  corrective_action: string | null
}

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10)
}

function normalizeArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value : []
}

function parseDisp(val: unknown): Record<string, string> {
  if (!val) return {}
  if (typeof val === 'string') {
    try { return JSON.parse(val) as Record<string, string> } catch { return {} }
  }
  if (typeof val === 'object') return val as Record<string, string>
  return {}
}

export default function PersonnelStatsPage() {
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return toDateInputValue(d)
  })
  const [endDate, setEndDate] = useState(() => toDateInputValue(new Date()))
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<AnomalyRow[]>([])
  const [dispositionOptions, setDispositionOptions] = useState<string[]>([
    '重工', '報廢', '讓步接收', '退貨', '隔離', '待判定',
  ])
  const [savingId, setSavingId] = useState<string | null>(null)
  const [personFilter, setPersonFilter] = useState('')
  const [deptFilter, setDeptFilter] = useState('')
  const [personnelOptions, setPersonnelOptions] = useState<{ option_value: string; department_value: string }[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkDisposition, setBulkDisposition] = useState('')
  const [bulkApplying, setBulkApplying] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [soModalId, setSoModalId] = useState<string | null>(null)

  // 排序狀態：'total' | category name
  const [sortBy, setSortBy] = useState<string>('total')

  const runQuery = useCallback(async () => {
    if (!startDate || !endDate) { alert('請選擇日期區間'); return }
    setLoading(true)
    try {
      const [reportRes, optRes] = await Promise.all([
        supabase
          .from('schedule_anomaly_reports')
          .select('id, order_number, item_code, item_name, reason, qa_reporter, qa_handlers, qa_responsible, qa_category, qa_disposition, created_at, status, loss_qty, cause_analysis, immediate_action, corrective_action')
          .eq('report_type', 'qa')
          .gte('created_at', `${startDate}T00:00:00.000Z`)
          .lte('created_at', `${endDate}T23:59:59.999Z`),
        supabase
          .from('qa_anomaly_option_items')
          .select('option_type, option_value, department_value')
          .in('option_type', ['disposition', 'personnel'])
          .order('option_value', { ascending: true }),
      ])
      if (reportRes.error) throw reportRes.error
      setRows((reportRes.data as AnomalyRow[]) || [])
      setSortBy('total')
      setSelectedIds(new Set())
      const optRows = (optRes.data || []) as { option_type: string; option_value: string; department_value: string | null }[]
      const opts = optRows.filter((r) => r.option_type === 'disposition').map((r) => r.option_value)
      if (opts.length > 0) setDispositionOptions(opts)
      setPersonnelOptions(
        optRows
          .filter((r) => r.option_type === 'personnel')
          .map((r) => ({ option_value: r.option_value, department_value: r.department_value || '' })),
      )
    } catch (err: unknown) {
      alert(`查詢失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate])

  const handleDispositionChange = async (rowId: number, person: string, newDisposition: string) => {
    const savingKey = `${rowId}-${person}`
    setSavingId(savingKey)
    try {
      const currentRow = rows.find((r) => r.id === rowId)
      const currentDisp = parseDisp(currentRow?.qa_disposition)
      const updatedDisp = { ...currentDisp }
      if (newDisposition) {
        updatedDisp[person] = newDisposition
      } else {
        delete updatedDisp[person]
      }
      const payload = Object.keys(updatedDisp).length > 0 ? updatedDisp : null
      const { error } = await supabase
        .from('schedule_anomaly_reports')
        .update({ qa_disposition: payload })
        .eq('id', rowId)
      if (error) throw error
      setRows((prev) =>
        prev.map((r) => r.id === rowId ? { ...r, qa_disposition: payload } : r)
      )
    } catch (err: unknown) {
      alert(`儲存失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
    } finally {
      setSavingId(null)
    }
  }

  // 人員 → 部門 對照（qa_anomaly_option_items personnel 選項）
  const personnelDeptMap = useMemo(
    () => new Map(personnelOptions.map((p) => [p.option_value, p.department_value])),
    [personnelOptions],
  )

  const departmentOptions = useMemo(
    () => [...new Set(personnelOptions.map((p) => p.department_value).filter(Boolean))].sort(),
    [personnelOptions],
  )

  // 所有分類（去重排序）
  const allCategories = useMemo(() => {
    const set = new Set<string>()
    for (const row of rows) {
      const cat = (row.qa_category || '未分類').trim() || '未分類'
      set.add(cat)
    }
    return [...set].sort()
  }, [rows])

  // 人員 × 分類 交叉統計
  // personMap: Map<person, Map<category, count>>
  const personMap = useMemo(() => {
    const map = new Map<string, Map<string, number>>()
    for (const row of rows) {
      const cat = (row.qa_category || '未分類').trim() || '未分類'
      for (const raw of normalizeArray(row.qa_responsible)) {
        const person = raw.trim()
        if (!person) continue
        if (!map.has(person)) map.set(person, new Map())
        const inner = map.get(person)!
        inner.set(cat, (inner.get(cat) || 0) + 1)
      }
    }
    return map
  }, [rows])

  // 人員列表（依選中欄位排序）
  const sortedPersons = useMemo(() => {
    const persons = [...personMap.keys()]
    return persons.sort((a, b) => {
      const aMap = personMap.get(a)!
      const bMap = personMap.get(b)!
      const aVal = sortBy === 'total'
        ? [...aMap.values()].reduce((s, c) => s + c, 0)
        : (aMap.get(sortBy) || 0)
      const bVal = sortBy === 'total'
        ? [...bMap.values()].reduce((s, c) => s + c, 0)
        : (bMap.get(sortBy) || 0)
      return bVal - aVal
    })
  }, [personMap, sortBy])

  // 摘要數字
  const totalCount = useMemo(() => [...personMap.values()].flatMap((m) => [...m.values()]).reduce((s, c) => s + c, 0), [personMap])
  const uniquePersons = personMap.size
  const uniqueCategories = allCategories.length

  // 所有缺失人員列表（依統計排序）
  const allPersons = useMemo(() => sortedPersons, [sortedPersons])

  // 個別紀錄明細（依部門→人員篩選）
  const detailRows = useMemo(() => {
    return rows.filter((row) => {
      const persons = normalizeArray(row.qa_responsible).map((p) => p.trim())
      if (persons.length === 0) return false
      if (personFilter && !persons.includes(personFilter)) return false
      if (!personFilter && deptFilter && !persons.some((p) => personnelDeptMap.get(p) === deptFilter)) return false
      return true
    }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [rows, personFilter, deptFilter, personnelDeptMap])

  const handleDownload = useCallback(() => {
    if (rows.length === 0) { alert('尚無資料，請先查詢'); return }

    const header = ['缺失人員', '合計', ...allCategories]
    const sheetRows = sortedPersons.map((person) => {
      const inner = personMap.get(person)!
      const total = [...inner.values()].reduce((s, c) => s + c, 0)
      const row: Record<string, string | number> = { 缺失人員: person, 合計: total }
      for (const cat of allCategories) { row[cat] = inner.get(cat) || 0 }
      return row
    })

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(sheetRows, { header })
    ws['!cols'] = [{ wch: 16 }, { wch: 8 }, ...allCategories.map(() => ({ wch: 14 }))]
    XLSX.utils.book_append_sheet(wb, ws, '異常人員統計')
    XLSX.writeFile(wb, `異常人員統計_${startDate}_${endDate}.xlsx`)
  }, [rows, sortedPersons, personMap, allCategories, startDate, endDate])

  const allDetailSelected = detailRows.length > 0 && detailRows.every((row) => selectedIds.has(row.id))

  const toggleSelectAll = () => {
    setSelectedIds(allDetailSelected ? new Set() : new Set(detailRows.map((row) => row.id)))
  }

  const toggleRow = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkDisposition = async () => {
    if (!bulkDisposition) return
    const targets = detailRows.filter((row) => selectedIds.has(row.id))
    if (targets.length === 0) return
    if (!confirm(`確定將已勾選 ${targets.length} 筆紀錄的「所有缺失人員」處置設為「${bulkDisposition}」？`)) return

    setBulkApplying(true)
    try {
      const updates = targets.map((row) => {
        const persons = normalizeArray(row.qa_responsible).map((p) => p.trim()).filter(Boolean)
        const updated = { ...parseDisp(row.qa_disposition) }
        persons.forEach((person) => { updated[person] = bulkDisposition })
        return { id: row.id, disp: updated }
      })
      const results = await Promise.all(
        updates.map((u) =>
          supabase.from('schedule_anomaly_reports').update({ qa_disposition: u.disp }).eq('id', u.id),
        ),
      )
      const failed = results.filter((r) => r.error)
      if (failed.length > 0) throw failed[0].error
      const dispById = new Map(updates.map((u) => [u.id, u.disp]))
      setRows((prev) => prev.map((r) => (dispById.has(r.id) ? { ...r, qa_disposition: dispById.get(r.id)! } : r)))
      alert(`已更新 ${updates.length} 筆紀錄的缺失處置`)
    } catch (err: unknown) {
      alert(`批量更新失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
    } finally {
      setBulkApplying(false)
    }
  }

  const handlePrint = async (records: AnomalyRow[]) => {
    if (records.length === 0) return
    setPrinting(true)
    try {
      await printDeficiencySheets(records, personnelDeptMap)
    } catch (err: unknown) {
      alert(`列印失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
    } finally {
      setPrinting(false)
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-[1600px] mx-auto min-h-screen space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">異常人員缺失單處理作業</h1>
          <p className="text-rose-400 mt-1 font-mono text-sm uppercase">PERSONNEL DEFICIENCY // 缺失處置 × 缺失單列印</p>
        </div>
        <NavButton href="/qa" direction="back" title="返回品保專區" />
      </div>

      <div className="flex items-center gap-4 flex-wrap">
          <div>
            <label className="text-xs text-slate-400">起始日期</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 block bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white" />
          </div>
          <div>
            <label className="text-xs text-slate-400">結束日期</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              className="mt-1 block bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white" />
          </div>
          <button
            onClick={() => void runQuery()}
            disabled={loading}
            className="px-4 py-2 rounded bg-rose-700 hover:bg-rose-600 text-white font-bold disabled:bg-slate-700 disabled:text-slate-400"
          >
            {loading ? '查詢中...' : '開始查詢'}
          </button>
          <button
            onClick={handleDownload}
            disabled={rows.length === 0}
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold disabled:bg-slate-700 disabled:text-slate-400"
          >
            下載 XLSX
          </button>
          <span className="text-xs text-slate-500">共 {rows.length} 筆資料</span>
      </div>

      {/* 摘要卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-4">
          <p className="text-xs text-slate-400">缺失總次數</p>
          <p className="mt-2 text-3xl font-black text-white font-mono">{totalCount}</p>
        </div>
        <div className="bg-slate-900/50 border border-rose-700/60 rounded-xl p-4">
          <p className="text-xs text-rose-300">缺失人員（不重複）</p>
          <p className="mt-2 text-3xl font-black text-rose-300 font-mono">{uniquePersons}</p>
        </div>
        <div className="bg-slate-900/50 border border-amber-700/60 rounded-xl p-4">
          <p className="text-xs text-amber-300">異常分類（不重複）</p>
          <p className="mt-2 text-3xl font-black text-amber-300 font-mono">{uniqueCategories}</p>
        </div>
      </div>

      {/* 個別紀錄明細（可設定缺失處置） */}
      {rows.length > 0 && (
        <div className="bg-slate-900/50 border border-violet-700/40 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-700 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-white">個別紀錄明細</h2>
              <p className="text-xs text-violet-400 mt-0.5">可在此直接設定各筆紀錄的缺失處置</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-xs text-slate-400">部門</label>
              <select
                value={deptFilter}
                onChange={(e) => { setDeptFilter(e.target.value); setPersonFilter('') }}
                className="bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-white text-sm"
              >
                <option value="">全部部門</option>
                {departmentOptions.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <label className="text-xs text-slate-400">人員</label>
              <select
                value={personFilter}
                onChange={(e) => setPersonFilter(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-white text-sm"
              >
                <option value="">全部人員</option>
                {allPersons
                  .filter((p) => !deptFilter || personnelDeptMap.get(p) === deptFilter)
                  .map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
              </select>
              {(personFilter || deptFilter) && (
                <button
                  onClick={() => { setPersonFilter(''); setDeptFilter('') }}
                  className="px-2 py-1.5 rounded border border-slate-700 text-slate-400 hover:text-white text-xs"
                >
                  清除
                </button>
              )}
              <span className="text-xs text-slate-500">{detailRows.length} 筆</span>
            </div>
          </div>

          {selectedIds.size > 0 && (
            <div className="px-5 py-3 border-b border-slate-700 bg-slate-950/60 flex flex-wrap items-center gap-3">
              <span className="text-xs text-violet-300 font-bold">已選 {selectedIds.size} 筆</span>
              <button
                onClick={() => void handlePrint(detailRows.filter((row) => selectedIds.has(row.id)))}
                disabled={printing}
                className="px-3 py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-bold disabled:bg-slate-700 disabled:text-slate-400"
              >
                {printing ? '產生中...' : '批量列印'}
              </button>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400">批量修改缺失處置</label>
                <select
                  value={bulkDisposition}
                  onChange={(e) => setBulkDisposition(e.target.value)}
                  className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-white text-xs"
                >
                  <option value="">選擇處置...</option>
                  {dispositionOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                <button
                  onClick={() => void handleBulkDisposition()}
                  disabled={!bulkDisposition || bulkApplying}
                  className="px-3 py-1.5 rounded bg-violet-700 hover:bg-violet-600 text-white text-xs font-bold disabled:bg-slate-700 disabled:text-slate-400"
                >
                  {bulkApplying ? '套用中...' : '套用'}
                </button>
              </div>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="ml-auto px-2 py-1.5 rounded border border-slate-700 text-slate-400 hover:text-white text-xs"
              >
                取消選取
              </button>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-slate-300 min-w-[950px]">
              <thead className="bg-slate-950 text-slate-400 uppercase text-xs font-mono">
                <tr>
                  <th className="px-3 py-3 text-center sticky left-0 bg-slate-950 z-10">
                    <input
                      type="checkbox"
                      checked={allDetailSelected}
                      onChange={toggleSelectAll}
                      className="accent-violet-500 cursor-pointer"
                      title="全選 / 取消全選"
                    />
                  </th>
                  <th className="px-4 py-3 text-left">日期</th>
                  <th className="px-4 py-3 text-left">相關單號</th>
                  <th className="px-4 py-3 text-left">品項</th>
                  <th className="px-4 py-3 text-left">異常分類</th>
                  <th className="px-4 py-3 text-left">異常原因</th>
                  <th className="px-4 py-3 text-left">缺失人員</th>
                  <th className="px-4 py-3 text-left">缺失處置</th>
                  <th className="px-3 py-3 text-center sticky right-0 bg-slate-950 z-10">列印</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {detailRows.map((row) => {
                  const persons = normalizeArray(row.qa_responsible)
                  const dispMap = parseDisp(row.qa_disposition)
                  return (
                    <tr key={row.id} className="hover:bg-slate-800/30 align-middle">
                      <td className="px-3 py-3 text-center sticky left-0 bg-slate-900 z-10">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.id)}
                          onChange={() => toggleRow(row.id)}
                          className="accent-violet-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs whitespace-nowrap text-slate-400">
                        {new Date(row.created_at).toLocaleDateString('zh-TW')}
                      </td>
                      <td className="px-4 py-3 font-mono whitespace-nowrap text-xs">
                        {row.order_number ? (
                          <button
                            onClick={() => setSoModalId(row.order_number)}
                            className="text-cyan-300 hover:text-cyan-100 hover:underline"
                            title="查看訂單詳情"
                          >
                            {row.order_number}
                          </button>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs space-y-0.5">
                          <div className="text-slate-400">{row.item_code || '-'}</div>
                          <div className="text-slate-200">{row.item_name || '-'}</div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-amber-300">{row.qa_category || '-'}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-slate-300">{row.reason || '-'}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {persons.map((p) => (
                            <span key={p} className="px-2 py-0.5 rounded bg-rose-900/30 border border-rose-700/50 text-rose-200 text-xs">
                              {p}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-1.5">
                          {persons.map((person) => {
                            const savingKey = `${row.id}-${person}`
                            const isPersonSaving = savingId === savingKey
                            return (
                              <div key={person} className="flex items-center gap-2">
                                <span className="text-xs text-slate-400 whitespace-nowrap">{person}：</span>
                                <select
                                  value={dispMap[person] || ''}
                                  disabled={isPersonSaving}
                                  onChange={(e) => void handleDispositionChange(row.id, person, e.target.value)}
                                  className={`bg-slate-950 border rounded px-2 py-0.5 text-xs min-w-[100px] transition-colors ${
                                    dispMap[person] ? 'border-violet-600 text-violet-200' : 'border-slate-700 text-slate-400'
                                  } ${isPersonSaving ? 'opacity-50' : ''}`}
                                >
                                  <option value="">未設定</option>
                                  {dispositionOptions.map((opt) => (
                                    <option key={opt} value={opt}>{opt}</option>
                                  ))}
                                </select>
                                {isPersonSaving && <span className="text-xs text-slate-500">儲存中...</span>}
                              </div>
                            )
                          })}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center sticky right-0 bg-slate-900 z-10">
                        <button
                          onClick={() => void handlePrint([row])}
                          disabled={printing}
                          className="px-2.5 py-1 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-900/30 text-xs whitespace-nowrap disabled:opacity-50"
                          title="下載此筆缺失單（一人一張）"
                        >
                          列印
                        </button>
                      </td>
                    </tr>
                  )
                })}
                {detailRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                      {personFilter ? `「${personFilter}」在此區間無缺失紀錄` : '此區間內無缺失人員資料'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 交叉統計表 */}
      {rows.length === 0 ? (
        <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-12 text-center text-slate-500">
          請選擇日期區間後點選「開始查詢」
        </div>
      ) : sortedPersons.length === 0 ? (
        <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-12 text-center text-slate-500">
          此區間內無缺失人員資料
        </div>
      ) : (
        <div className="bg-slate-900/50 border border-slate-700 rounded-xl overflow-x-auto">
          <div className="px-5 py-4 border-b border-slate-700">
            <h2 className="text-lg font-bold text-white">人員 × 分類 交叉統計</h2>
            <p className="text-xs text-slate-500 mt-0.5">點擊人員姓名可在上方明細中篩選</p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400 text-xs">
                <th className="px-4 py-3 text-left sticky left-0 bg-slate-900 z-10 min-w-[120px]">缺失人員</th>
                <th
                  className={`px-4 py-3 text-center cursor-pointer hover:text-white whitespace-nowrap ${sortBy === 'total' ? 'text-white' : ''}`}
                  onClick={() => setSortBy('total')}
                >
                  合計 {sortBy === 'total' && '▼'}
                </th>
                {allCategories.map((cat) => (
                  <th
                    key={cat}
                    className={`px-4 py-3 text-center cursor-pointer hover:text-white whitespace-nowrap ${sortBy === cat ? 'text-amber-300' : ''}`}
                    onClick={() => setSortBy(cat)}
                  >
                    {cat} {sortBy === cat && '▼'}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {sortedPersons.map((person) => {
                const inner = personMap.get(person)!
                const total = [...inner.values()].reduce((s, c) => s + c, 0)
                const maxTotal = Math.max(...sortedPersons.map((p) => {
                  const m = personMap.get(p)!
                  return [...m.values()].reduce((s, c) => s + c, 0)
                }))
                return (
                  <tr key={person} className="hover:bg-slate-800/40">
                    <td className="px-4 py-3 font-medium sticky left-0 bg-slate-900/80 z-10">
                      <button
                        className={`hover:text-rose-300 transition-colors text-left ${personFilter === person ? 'text-rose-300' : 'text-white'}`}
                        onClick={() => setPersonFilter(personFilter === person ? '' : person)}
                        title="點擊以在明細中篩選此人員"
                      >
                        {person}
                        {personFilter === person && <span className="ml-1 text-xs">▲</span>}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-16 bg-slate-800 rounded h-1.5 hidden md:block">
                          <div
                            className="h-1.5 bg-rose-500 rounded"
                            style={{ width: `${maxTotal > 0 ? (total / maxTotal) * 100 : 0}%` }}
                          />
                        </div>
                        <span className="font-bold text-rose-300 font-mono">{total}</span>
                      </div>
                    </td>
                    {allCategories.map((cat) => {
                      const count = inner.get(cat) || 0
                      return (
                        <td key={cat} className="px-4 py-3 text-center">
                          {count > 0 ? (
                            <span className="px-2 py-0.5 rounded bg-amber-900/30 border border-amber-700/50 text-amber-200 text-xs font-mono">
                              {count}
                            </span>
                          ) : (
                            <span className="text-slate-700">-</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
            {/* 分類合計行 */}
            <tfoot>
              <tr className="border-t border-slate-600 text-xs text-slate-400 bg-slate-900/60">
                <td className="px-4 py-3 sticky left-0 bg-slate-900/60 z-10 font-bold text-slate-300">各分類合計</td>
                <td className="px-4 py-3 text-center font-bold text-rose-300 font-mono">{totalCount}</td>
                {allCategories.map((cat) => {
                  const sum = sortedPersons.reduce((s, p) => s + (personMap.get(p)?.get(cat) || 0), 0)
                  return (
                    <td key={cat} className="px-4 py-3 text-center font-mono text-slate-300">
                      {sum > 0 ? sum : '-'}
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* 各人員橫條圖 */}
      {sortedPersons.length > 0 && (
        <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-bold text-white">缺失人員分類分布</h2>
          <div className="space-y-3">
            {sortedPersons.map((person) => {
              const inner = personMap.get(person)!
              const total = [...inner.values()].reduce((s, c) => s + c, 0)
              const maxTotal = Math.max(...sortedPersons.map((p) => {
                const m = personMap.get(p)!
                return [...m.values()].reduce((s, c) => s + c, 0)
              }))
              const barColors = ['bg-rose-500', 'bg-amber-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-emerald-500', 'bg-fuchsia-500', 'bg-orange-500', 'bg-teal-500']
              return (
                <div key={person} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white font-medium">{person}</span>
                    <span className="text-rose-300 font-mono text-xs">{total} 次</span>
                  </div>
                  {/* stacked bar */}
                  <div className="flex h-4 rounded overflow-hidden bg-slate-800" style={{ width: `${maxTotal > 0 ? (total / maxTotal) * 100 : 0}%`, minWidth: total > 0 ? '4px' : '0' }}>
                    {allCategories.map((cat, i) => {
                      const count = inner.get(cat) || 0
                      if (!count) return null
                      return (
                        <div
                          key={cat}
                          className={`${barColors[i % barColors.length]} h-full`}
                          style={{ width: `${(count / total) * 100}%` }}
                          title={`${cat}: ${count}`}
                        />
                      )
                    })}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {allCategories.map((cat, i) => {
                      const count = inner.get(cat) || 0
                      if (!count) return null
                      return (
                        <span key={cat} className="text-xs text-slate-400">
                          <span className={`inline-block w-2 h-2 rounded-full mr-1 ${barColors[i % barColors.length]}`} />
                          {cat}: {count}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {soModalId && <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />}
    </div>
  )
}
