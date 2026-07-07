'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { supabase } from '../../../../lib/supabaseClient'

interface SheetMeta {
  sheet_date: string
  row_count: number
}

interface SheetRow {
  row_key?: string
  order_number: string
  factory: 'T' | 'C' | 'O'
  customer?: string
  item_code: string
  item_name: string
  note: string
  quantity: string
  delivery_date: string
  mo_number?: string | null
}

interface Sara101MasterRow {
  order_number: string | null
  manufacturing_order_number: string
  product_name: string
  product_description: string | null
  lot_number: string | null
  production_quantity: number | null
  due: string | null
  priority_level: string | null
  earliest_start_time: string | null
  job_sequence: string | null
  workcenter: string | null
  job_name: string | null
  job_quantity: number | null
  out_sourcing: string | null
  est_time: number | null
  time_unit: string | null
  bom_components: string | null
  material_required_quantity: string | null
  rule: string | null
  parameter_1: string | null
  customer_id: string | null
  assigned_machine: string | null
  source_date: string | null
  source_order: string | null
  source_factory: 'T' | 'C' | 'O' | null
}

interface BomPartRow {
  parent_part: string
  child_part: string
  child_qty: number | string | null
  line_no: number | null
}

interface TransformRow {
  order_number: string
  manufacturing_order_number: string
  product_name: string
  product_description: string
  lot_number: string
  production_quantity: number
  due: string
  priority_level: string
  earliest_start_time: string
  job_sequence: string
  workcenter: string
  job_name: string
  job_quantity: number
  out_sourcing: string
  est_time: string
  time_unit: string
  bom_components: string
  material_required_quantity: string
  rule: string
  parameter_1: string
  customer_id: string
  assigned_machine: string
  source_date: string
  source_order: string
  source_factory: 'T' | 'C' | 'O'
}

type PreviewColumn = {
  key: keyof TransformRow
  label: string
  numeric?: boolean
  always?: boolean
}

const PREVIEW_COLUMNS: PreviewColumn[] = [
  { key: 'manufacturing_order_number', label: 'Manufacturing Order Number', always: true },
  { key: 'order_number', label: 'Order Number', always: true },
  { key: 'product_name', label: 'Product Name', always: true },
  { key: 'product_description', label: 'Product Description' },
  { key: 'lot_number', label: 'Lot Number' },
  { key: 'production_quantity', label: 'Production Quantity', numeric: true, always: true },
  { key: 'due', label: 'Due', always: true },
  { key: 'priority_level', label: 'Priority Level' },
  { key: 'earliest_start_time', label: 'Earliest Start Time' },
  { key: 'job_sequence', label: 'Job Sequence' },
  { key: 'workcenter', label: 'Workcenter' },
  { key: 'job_name', label: 'Job Name' },
  { key: 'job_quantity', label: 'Job Quantity', numeric: true },
  { key: 'out_sourcing', label: 'Out Sourcing', always: true },
  { key: 'est_time', label: 'Est. Time' },
  { key: 'time_unit', label: 'Time Unit' },
  { key: 'bom_components', label: 'BOM Components' },
  { key: 'material_required_quantity', label: 'Material Required Quantity' },
  { key: 'rule', label: 'Rule' },
  { key: 'parameter_1', label: 'Parameter 1' },
  { key: 'customer_id', label: 'customer_id' },
  { key: 'assigned_machine', label: 'assigned_machine' },
]

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'number') return !Number.isNaN(v)
  return String(v).trim() !== ''
}

function toNumber(v: string | number | null | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = parseFloat(String(v ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : 0
}

function toDueIso(v: string | null | undefined): string | null {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  const normalized = raw.replace(/\//g, '-')
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return `${normalized}T00:00:00Z`
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function csvCell(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`
}

function downloadCsv(fileName: string, headers: string[], rows: Array<Array<string | number | null | boolean>>) {
  const bom = '\uFEFF'
  const csv = bom + [
    headers.map(csvCell).join(','),
    ...rows.map(r => r.map(csvCell).join(',')),
  ].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

function formatErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const obj = e as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
    const parts = [obj.message, obj.details, obj.hint, obj.code]
      .map(v => String(v ?? '').trim())
      .filter(Boolean)
    if (parts.length > 0) return parts.join(' | ')
    try {
      return JSON.stringify(e)
    } catch {
      return String(e)
    }
  }
  return String(e)
}

export default function Sara101Page() {
  const [sheetList, setSheetList] = useState<SheetMeta[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [sheetRows, setSheetRows] = useState<SheetRow[]>([])
  const [loadingSheets, setLoadingSheets] = useState(false)
  const [loadingRows, setLoadingRows] = useState(false)
  const [loadingMerged, setLoadingMerged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [includeT, setIncludeT] = useState(true)
  const [includeC, setIncludeC] = useState(true)
  const [includeO, setIncludeO] = useState(true)
  const [needMoOnly, setNeedMoOnly] = useState(true)

  const [transformedRows, setTransformedRows] = useState<TransformRow[]>([])
  const [mergedRows, setMergedRows] = useState<TransformRow[]>([])
  const [existingCount, setExistingCount] = useState(0)

  const previewRows = useMemo(
    () => (mergedRows.length > 0 ? mergedRows : transformedRows),
    [mergedRows, transformedRows],
  )

  const previewColumns = useMemo(() => {
    if (previewRows.length === 0) return PREVIEW_COLUMNS.filter(c => c.always)
    return PREVIEW_COLUMNS.filter(col => {
      if (col.always) return true
      return previewRows.some(row => hasValue(row[col.key]))
    })
  }, [previewRows])

  const loadSheetList = useCallback(async () => {
    setLoadingSheets(true)
    setError(null)
    try {
      const res = await fetch('/api/argoerp/daily-order-sheet', { cache: 'no-store' })
      const json = await res.json()
      if (!json.success) throw new Error(String(json.error ?? '讀取出單表日期失敗'))
      const list = (json.sheets ?? []) as SheetMeta[]
      setSheetList(list)
      if (!selectedDate && list.length > 0) setSelectedDate(list[0].sheet_date)
    } catch (e) {
      setError(formatErrorMessage(e))
    } finally {
      setLoadingSheets(false)
    }
  }, [selectedDate])

  const loadSheetRows = useCallback(async () => {
    if (!selectedDate) return
    setLoadingRows(true)
    setError(null)
    setSheetRows([])
    setTransformedRows([])
    setMergedRows([])
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${selectedDate}`, { cache: 'no-store' })
      const json = await res.json()
      if (!json.success) throw new Error(String(json.error ?? '載入出單表失敗'))
      const rows = Array.isArray(json.sheet?.rows) ? (json.sheet.rows as SheetRow[]) : []
      setSheetRows(rows)
    } catch (e) {
      setError(formatErrorMessage(e))
    } finally {
      setLoadingRows(false)
    }
  }, [selectedDate])

  useEffect(() => { void loadSheetList() }, [loadSheetList])

  const filteredRows = useMemo(() => {
    return sheetRows.filter(r => {
      if (r.factory === 'T' && !includeT) return false
      if (r.factory === 'C' && !includeC) return false
      if (r.factory === 'O' && !includeO) return false
      if (needMoOnly && !String(r.mo_number ?? '').trim()) return false
      return true
    })
  }, [sheetRows, includeT, includeC, includeO, needMoOnly])

  const missingMoCount = useMemo(() => {
    return sheetRows.filter(r => !String(r.mo_number ?? '').trim()).length
  }, [sheetRows])

  const handleTransform = useCallback(async () => {
    const itemCodes = [...new Set(filteredRows.map(r => String(r.item_code ?? '').trim()).filter(Boolean))]
    const bomMap = new Map<string, BomPartRow[]>()

    if (itemCodes.length > 0) {
      const { data: bomRows, error: bomError } = await supabase
        .from('mm_bom_structure')
        .select('parent_part,child_part,child_qty,line_no')
        .in('parent_part', itemCodes)
      if (bomError) {
        setError(bomError.message)
      } else {
        for (const row of (bomRows ?? []) as BomPartRow[]) {
          const key = String(row.parent_part ?? '').trim()
          if (!key) continue
          const arr = bomMap.get(key) ?? []
          arr.push(row)
          bomMap.set(key, arr)
        }
        for (const arr of bomMap.values()) {
          arr.sort((a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0))
        }
      }
    }

    const converted: TransformRow[] = filteredRows
      .map((r) => {
        const mo = String(r.mo_number ?? '').trim()
        if (!mo) return null

        const qty = toNumber(r.quantity)
        const dueIso = toDueIso(r.delivery_date)
        const itemCode = String(r.item_code ?? '').trim()
        const bomParts = bomMap.get(itemCode) ?? []
        const bomComponents = bomParts.map(p => `${p.child_part}:${toNumber(p.child_qty)}`).join('; ')
        const materialRequiredQty = bomParts
          .map(p => `${p.child_part}:${(toNumber(p.child_qty) * qty).toFixed(2)}`)
          .join('; ')

        return {
          order_number: r.order_number || '',
          manufacturing_order_number: mo,
          product_name: r.item_name || r.item_code || '未命名產品',
          product_description: r.note || '',
          lot_number: r.order_number || mo,
          production_quantity: qty,
          due: dueIso ? dueIso.slice(0, 10) : '',
          priority_level: 'Normal',
          earliest_start_time: '',
          job_sequence: '',
          workcenter: '',
          job_name: '',
          job_quantity: qty,
          out_sourcing: r.factory === 'O' ? 'Y' : 'N',
          est_time: '',
          time_unit: '',
          bom_components: bomComponents,
          material_required_quantity: materialRequiredQty,
          rule: '',
          parameter_1: '',
          customer_id: String(r.customer ?? '').trim(),
          assigned_machine: '',
          source_date: selectedDate,
          source_order: r.order_number,
          source_factory: r.factory,
        }
      })
      .filter((v): v is TransformRow => !!v)

    setTransformedRows(converted)
    setMergedRows([])
    setExistingCount(0)
  }, [filteredRows, selectedDate])

  const handleMerge = useCallback(async () => {
    if (transformedRows.length === 0) return
    setLoadingMerged(true)
    setError(null)
    try {
      const { data, error: dbError } = await supabase
        .from('sara_101_master')
        .select('order_number, manufacturing_order_number, product_name, product_description, lot_number, production_quantity, due, priority_level, earliest_start_time, job_sequence, workcenter, job_name, job_quantity, out_sourcing, est_time, time_unit, bom_components, material_required_quantity, rule, parameter_1, customer_id, assigned_machine, source_date, source_order, source_factory')
      if (dbError) throw dbError

      const existing = (data ?? []) as Sara101MasterRow[]
      setExistingCount(existing.length)

      const map = new Map<string, TransformRow>()
      for (const r of existing) {
        map.set(r.manufacturing_order_number, {
          order_number: String(r.order_number ?? ''),
          manufacturing_order_number: r.manufacturing_order_number,
          product_name: r.product_name,
          product_description: String(r.product_description ?? ''),
          lot_number: String(r.lot_number ?? ''),
          production_quantity: toNumber(r.production_quantity),
          due: String(r.due ?? '').slice(0, 10),
          priority_level: String(r.priority_level ?? ''),
          earliest_start_time: String(r.earliest_start_time ?? ''),
          job_sequence: String(r.job_sequence ?? ''),
          workcenter: String(r.workcenter ?? ''),
          job_name: String(r.job_name ?? ''),
          job_quantity: toNumber(r.job_quantity),
          out_sourcing: String(r.out_sourcing ?? ''),
          est_time: String(r.est_time ?? ''),
          time_unit: String(r.time_unit ?? ''),
          bom_components: String(r.bom_components ?? ''),
          material_required_quantity: String(r.material_required_quantity ?? ''),
          rule: String(r.rule ?? ''),
          parameter_1: String(r.parameter_1 ?? ''),
          customer_id: String(r.customer_id ?? ''),
          assigned_machine: String(r.assigned_machine ?? ''),
          source_date: String(r.source_date ?? ''),
          source_order: String(r.source_order ?? ''),
          source_factory: (r.source_factory ?? 'T') as 'T' | 'C' | 'O',
        })
      }
      for (const r of transformedRows) {
        map.set(r.manufacturing_order_number, r)
      }

      const merged = [...map.values()].sort((a, b) => a.manufacturing_order_number.localeCompare(b.manufacturing_order_number))
      setMergedRows(merged)
    } catch (e) {
      setError(formatErrorMessage(e))
    } finally {
      setLoadingMerged(false)
    }
  }, [transformedRows])

  const handleExportMergedCsv = useCallback(() => {
    if (mergedRows.length === 0) return
    const rows = mergedRows.map(r => [
      r.order_number,
      r.manufacturing_order_number,
      r.product_name,
      r.product_description,
      r.lot_number,
      r.production_quantity,
      r.due,
      r.priority_level,
      r.earliest_start_time,
      r.job_sequence,
      r.workcenter,
      r.job_name,
      r.job_quantity,
      r.out_sourcing,
      r.est_time,
      r.time_unit,
      r.bom_components,
      r.material_required_quantity,
      r.rule,
      r.parameter_1,
      r.customer_id,
      r.assigned_machine,
    ])
    downloadCsv(
      `SARA_101_merged_${selectedDate || new Date().toISOString().slice(0, 10)}.csv`,
      [
        'Order Number',
        'Manufacturing Order Number',
        'Product Name',
        'Product Description',
        'Lot Number',
        'Production Quantity',
        'Due',
        'Priority Level',
        'Earliest Start Time',
        'Job Sequence',
        'Workcenter',
        'Job Name',
        'Job Quantity',
        'Out Sourcing',
        'Est. Time',
        'Time Unit',
        'BOM Components',
        'Material Required Quantity',
        'Rule',
        'Parameter 1',
        'customer_id',
        'assigned_machine',
      ],
      rows,
    )
  }, [mergedRows, selectedDate])

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="border-b border-slate-800/60 bg-slate-900/60 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-emerald-300">塔台 SARA · SARA_101</h1>
          <p className="text-sm text-slate-400 mt-1">出單表轉換為 SARA 匯入格式，並與既有累計資料合併成單一工作表。</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/sara/sara_101-master"
            className="px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-600 text-sm border border-teal-600"
          >
            SARA_101 總表
          </Link>
          <Link
            href="/admin/sara/sync"
            className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm border border-emerald-600"
          >
            ← 同步區
          </Link>
          <Link
            href="/admin"
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm border border-slate-700"
          >
            管理首頁
          </Link>
        </div>
      </div>

      <div className="p-6 max-w-7xl space-y-6">
        <section className="rounded-xl border border-slate-700 bg-slate-900/40 p-5 space-y-4">
          <h2 className="text-lg font-semibold text-emerald-300">1) 載入指定日期出單表</h2>

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm"
            >
              {sheetList.length === 0 && <option value="">— 無可用日期 —</option>}
              {sheetList.map(s => (
                <option key={s.sheet_date} value={s.sheet_date}>{s.sheet_date} ({s.row_count} 筆)</option>
              ))}
            </select>

            <button
              onClick={() => void loadSheetRows()}
              disabled={!selectedDate || loadingRows}
              className="px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-sm border border-emerald-600"
            >
              {loadingRows ? '載入中...' : '載入出單表'}
            </button>

            <button
              onClick={() => void loadSheetList()}
              disabled={loadingSheets}
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-sm border border-slate-700"
            >
              重新整理日期
            </button>
          </div>

          <div className="flex flex-wrap gap-4 text-sm text-slate-300">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={includeT} onChange={(e) => setIncludeT(e.target.checked)} /> 台北(T)
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={includeC} onChange={(e) => setIncludeC(e.target.checked)} /> 常平(C)
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={includeO} onChange={(e) => setIncludeO(e.target.checked)} /> 委外(O)
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={needMoOnly} onChange={(e) => setNeedMoOnly(e.target.checked)} /> 只轉換已有製令單號
            </label>
          </div>

          <div className="text-sm text-slate-400">
            載入筆數: {sheetRows.length}　可轉換筆數: {filteredRows.length}　缺少製令單號: {missingMoCount}
          </div>
        </section>

        <section className="rounded-xl border border-slate-700 bg-slate-900/40 p-5 space-y-4">
          <h2 className="text-lg font-semibold text-emerald-300">2) 轉換與累計合併</h2>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => void handleTransform()}
              disabled={filteredRows.length === 0}
              className="px-3 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-sm border border-cyan-600"
            >
              轉換為 SARA_101 格式
            </button>
            <button
              onClick={() => void handleMerge()}
              disabled={transformedRows.length === 0 || loadingMerged}
              className="px-3 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-sm border border-amber-600"
            >
              {loadingMerged ? '合併中...' : '與既有 SARA 累計資料合併'}
            </button>
            <button
              onClick={handleExportMergedCsv}
              disabled={mergedRows.length === 0}
              className="px-3 py-2 rounded-lg bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-sm border border-teal-600"
            >
              匯出合併工作表 CSV
            </button>
          </div>

          <div className="text-sm text-slate-400">
            轉換結果: {transformedRows.length} 筆　既有累計: {existingCount} 筆　合併後: {mergedRows.length} 筆
          </div>

          {error && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-950/30 text-rose-300 px-3 py-2 text-sm">
              {error}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-700 bg-slate-900/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700 text-sm text-slate-300">
            3) 預覽（僅顯示有資料欄位，前 200 筆）
            <span className="ml-2 text-xs text-slate-400">
              {mergedRows.length > 0 ? '目前顯示：合併後（與總表一致）' : '目前顯示：今日轉換結果'}
            </span>
          </div>
          <div className="overflow-auto max-h-[480px]">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 sticky top-0">
                <tr className="text-slate-400 border-b border-slate-700">
                  {previewColumns.map(col => (
                    <th
                      key={col.key}
                      className={`px-3 py-2 ${col.numeric ? 'text-right' : 'text-left'}`}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(previewRows.length === 0 ? [] : previewRows.slice(0, 200)).map((r) => (
                  <tr key={`${r.manufacturing_order_number}-${r.source_order}`} className="border-b border-slate-800/60">
                    {previewColumns.map(col => {
                      const raw = r[col.key]
                      const val = raw === null || raw === undefined ? '' : String(raw)
                      const commonClass = `px-3 py-2 ${col.numeric ? 'text-right' : 'text-left'}`
                      if (col.key === 'manufacturing_order_number') {
                        return (
                          <td key={col.key} className={`${commonClass} font-mono text-emerald-300`}>
                            {val}
                          </td>
                        )
                      }
                      return (
                        <td
                          key={col.key}
                          className={commonClass}
                          title={val.length > 80 ? val : undefined}
                        >
                          {val}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {previewRows.length === 0 && (
                  <tr>
                    <td colSpan={previewColumns.length || 1} className="px-3 py-6 text-center text-slate-500">
                      尚未轉換資料
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  )
}
