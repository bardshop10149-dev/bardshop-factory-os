'use client'

import Link from 'next/link'
import { useCallback, useMemo, useState } from 'react'
import { NavButton } from '../../../components/NavButton'
import * as XLSX from 'xlsx'
import { supabase } from '../../../lib/supabaseClient'
import { toIsoDateInput } from '@/lib/core/date'

interface AnomalyReportRow {
  created_at: string
  status: string | null
  reason: string | null
  qa_category: string | null
  qa_department: string | null
  qa_reporter: string | null
  qa_handlers: string[] | null
  qa_responsible: string[] | null
  handler_department: string | null
}

interface PersonnelOption {
  option_value: string
  department_value: string
}

interface RatioItem {
  name: string
  count: number
  percentage: number
}

function normalizeArray(value: string[] | null | undefined) {
  return Array.isArray(value) ? value : []
}

export default function QaAnalyticsPage() {
  const [startDate, setStartDate] = useState(() => {
    const start = new Date()
    start.setDate(start.getDate() - 30)
    return toIsoDateInput(start)
  })
  const [endDate, setEndDate] = useState(() => toIsoDateInput(new Date()))
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<AnomalyReportRow[]>([])
  const [personnelMap, setPersonnelMap] = useState<Map<string, string>>(new Map())

  const statusSummary = useMemo(() => {
    const total = rows.length
    const confirmed = rows.filter((row) => row.status === 'confirmed').length
    const pending = rows.filter((row) => row.status === 'pending').length
    return { total, confirmed, pending }
  }, [rows])

  // 1. 異常分類佔比 (qa_category)
  const categoryRatios = useMemo<RatioItem[]>(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const key = (row.qa_category || '未分類').trim() || '未分類'
      map.set(key, (map.get(key) || 0) + 1)
    }
    const total = rows.length || 1
    return [...map.entries()]
      .map(([name, count]) => ({ name, count, percentage: (count / total) * 100 }))
      .sort((a, b) => b.count - a.count)
  }, [rows])

  // 4. 缺失部門佔比 (qa_responsible → personnelMap → department)
  const responsibleDeptRatios = useMemo<RatioItem[]>(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const people = normalizeArray(row.qa_responsible)
      const depts = new Set<string>()
      for (const name of people) {
        const dept = personnelMap.get(name.trim()) || '未指定'
        depts.add(dept)
      }
      if (depts.size === 0 && people.length === 0) continue
      for (const dept of depts) {
        map.set(dept, (map.get(dept) || 0) + 1)
      }
    }
    const totalEntries = [...map.values()].reduce((sum, c) => sum + c, 0) || 1
    return [...map.entries()]
      .map(([name, count]) => ({ name, count, percentage: (count / totalEntries) * 100 }))
      .sort((a, b) => b.count - a.count)
  }, [rows, personnelMap])

  // 5. 缺失人員佔比 (qa_responsible)
  const responsibleRatios = useMemo<RatioItem[]>(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      for (const name of normalizeArray(row.qa_responsible)) {
        const key = name.trim()
        if (!key) continue
        map.set(key, (map.get(key) || 0) + 1)
      }
    }
    const totalEntries = [...map.values()].reduce((sum, c) => sum + c, 0) || 1
    return [...map.entries()]
      .map(([name, count]) => ({ name, count, percentage: (count / totalEntries) * 100 }))
      .sort((a, b) => b.count - a.count)
  }, [rows])

  const handleDownload = useCallback(() => {
    if (rows.length === 0) {
      alert('尚無分析資料，請先執行分析')
      return
    }

    const sections: { title: string; countLabel: string; items: RatioItem[] }[] = [
      { title: '異常分類佔比', countLabel: '筆數', items: categoryRatios },
      { title: '缺失部門佔比', countLabel: '筆數', items: responsibleDeptRatios },
      { title: '缺失人員佔比', countLabel: '次數', items: responsibleRatios },
    ]

    // Build all rows for a single sheet
    const allRows: Record<string, string | number>[] = []

    // 總覽區塊
    allRows.push({ 區塊: '【總覽】', 名稱: '總件數', 數值: statusSummary.total, '佔比(%)': '' as unknown as number })
    allRows.push({ 區塊: '', 名稱: '已處理件數', 數值: statusSummary.confirmed, '佔比(%)': '' as unknown as number })
    allRows.push({ 區塊: '', 名稱: '待處理件數', 數值: statusSummary.pending, '佔比(%)': '' as unknown as number })
    allRows.push({ 區塊: '', 名稱: '', 數值: '', '佔比(%)': '' }) // blank separator

    for (const section of sections) {
      allRows.push({ 區塊: `【${section.title}】`, 名稱: '名稱', 數值: section.countLabel, '佔比(%)': '佔比(%)' })
      for (const item of section.items) {
        allRows.push({ 區塊: '', 名稱: item.name, 數值: item.count, '佔比(%)': Number(item.percentage.toFixed(1)) })
      }
      allRows.push({ 區塊: '', 名稱: '', 數值: '', '佔比(%)': '' }) // blank separator
    }

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(allRows)
    // Auto-size column widths
    ws['!cols'] = [{ wch: 16 }, { wch: 20 }, { wch: 10 }, { wch: 10 }]
    XLSX.utils.book_append_sheet(wb, ws, '異常統計分析')

    XLSX.writeFile(wb, `異常統計分析_${startDate}_${endDate}.xlsx`)
  }, [rows, startDate, endDate, statusSummary, categoryRatios, responsibleDeptRatios, responsibleRatios])

  const runAnalysis = async () => {
    if (!startDate || !endDate) {
      alert('請選擇日期區間')
      return
    }

    setLoading(true)
    try {
      const [reportResult, personnelResult] = await Promise.all([
        supabase
          .from('schedule_anomaly_reports')
          .select('created_at, status, reason, qa_category, qa_department, qa_reporter, qa_handlers, qa_responsible, handler_department')
          .eq('report_type', 'qa')
          .gte('created_at', `${startDate}T00:00:00.000Z`)
          .lte('created_at', `${endDate}T23:59:59.999Z`),
        supabase
          .from('qa_anomaly_option_items')
          .select('option_value, department_value')
          .eq('option_type', 'personnel'),
      ])

      if (reportResult.error) throw reportResult.error
      setRows((reportResult.data as AnomalyReportRow[]) || [])

      if (personnelResult.data) {
        const map = new Map<string, string>()
        for (const p of personnelResult.data as PersonnelOption[]) {
          if (p.option_value && p.department_value) {
            map.set(p.option_value, p.department_value)
          }
        }
        setPersonnelMap(map)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '未知錯誤'
      alert(`分析失敗：${message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-[1600px] mx-auto min-h-screen space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">異常統計分析</h1>
          <p className="text-indigo-400 mt-1 font-mono text-sm uppercase">ANOMALY ANALYTICS // REASON & PERSONNEL RATIO</p>
        </div>
        <NavButton href="/qa" direction="back" title="返回品保專區" />
      </div>

      <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-slate-400">起始日期</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1 block bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white" />
          </div>
          <div>
            <label className="text-xs text-slate-400">結束日期</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1 block bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white" />
          </div>
          <button
            onClick={() => void runAnalysis()}
            disabled={loading}
            className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-bold disabled:bg-slate-700 disabled:text-slate-400"
          >
            {loading ? '分析中...' : '開始分析'}
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
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-4">
          <p className="text-xs text-slate-400">總件數</p>
          <p className="mt-2 text-3xl font-black text-white font-mono">{statusSummary.total}</p>
        </div>
        <div className="bg-slate-900/50 border border-emerald-700/60 rounded-xl p-4">
          <p className="text-xs text-emerald-300">已處理件數</p>
          <p className="mt-2 text-3xl font-black text-emerald-300 font-mono">{statusSummary.confirmed}</p>
        </div>
        <div className="bg-slate-900/50 border border-amber-700/60 rounded-xl p-4">
          <p className="text-xs text-amber-300">待處理件數</p>
          <p className="mt-2 text-3xl font-black text-amber-300 font-mono">{statusSummary.pending}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-4 space-y-3">
          <h2 className="text-lg text-white font-bold">異常分類佔比</h2>
          {categoryRatios.length === 0 ? (
            <p className="text-sm text-slate-500">尚無資料</p>
          ) : (
            categoryRatios.map((item) => (
              <div key={item.name} className="space-y-1">
                <div className="flex justify-between text-xs text-slate-300">
                  <span>{item.name}</span>
                  <span>{item.count} 筆 / {item.percentage.toFixed(1)}%</span>
                </div>
                <div className="h-2 bg-slate-800 rounded">
                  <div className="h-2 bg-cyan-500 rounded" style={{ width: `${Math.max(3, item.percentage)}%` }} />
                </div>
              </div>
            ))
          )}
        </div>

        <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-4 space-y-3">
          <h2 className="text-lg text-white font-bold">缺失部門佔比</h2>
          {responsibleDeptRatios.length === 0 ? (
            <p className="text-sm text-slate-500">尚無資料</p>
          ) : (
            responsibleDeptRatios.map((item) => (
              <div key={item.name} className="space-y-1">
                <div className="flex justify-between text-xs text-slate-300">
                  <span>{item.name}</span>
                  <span>{item.count} 筆 / {item.percentage.toFixed(1)}%</span>
                </div>
                <div className="h-2 bg-slate-800 rounded">
                  <div className="h-2 bg-amber-500 rounded" style={{ width: `${Math.max(3, item.percentage)}%` }} />
                </div>
              </div>
            ))
          )}
        </div>

        <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-4 space-y-3">
          <h2 className="text-lg text-white font-bold">缺失人員佔比</h2>
          {responsibleRatios.length === 0 ? (
            <p className="text-sm text-slate-500">尚無資料</p>
          ) : (
            responsibleRatios.map((item) => (
              <div key={item.name} className="space-y-1">
                <div className="flex justify-between text-xs text-slate-300">
                  <span>{item.name}</span>
                  <span>{item.count} 次 / {item.percentage.toFixed(1)}%</span>
                </div>
                <div className="h-2 bg-slate-800 rounded">
                  <div className="h-2 bg-rose-500 rounded" style={{ width: `${Math.max(3, item.percentage)}%` }} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
