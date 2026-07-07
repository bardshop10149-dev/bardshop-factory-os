'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'

import { supabase } from '../../../../lib/supabaseClient'

interface Sara101MasterRow {
  id?: number
  order_number: string | null
  manufacturing_order_number: string
  product_name: string
  product_description: string | null
  lot_number: string | null
  production_quantity: number
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
  source_factory: string | null
  source_order: string | null
  updated_at?: string | null
}

type PreviewColumn = {
  key: keyof Sara101MasterRow
  label: string
  numeric?: boolean
  always?: boolean
}

const PREVIEW_COLUMNS: PreviewColumn[] = [
  { key: 'manufacturing_order_number', label: 'manufacturing_order_number', always: true },
  { key: 'order_number', label: 'order_number', always: true },
  { key: 'customer_id', label: 'customer_id', always: true },
  { key: 'product_name', label: 'product_name', always: true },
  { key: 'product_description', label: 'product_description' },
  { key: 'lot_number', label: 'lot_number' },
  { key: 'production_quantity', label: 'production_quantity', numeric: true, always: true },
  { key: 'due', label: 'due', always: true },
  { key: 'priority_level', label: 'priority_level' },
  { key: 'earliest_start_time', label: 'earliest_start_time' },
  { key: 'job_sequence', label: 'job_sequence' },
  { key: 'workcenter', label: 'workcenter' },
  { key: 'job_name', label: 'job_name' },
  { key: 'job_quantity', label: 'job_quantity', numeric: true },
  { key: 'out_sourcing', label: 'out_sourcing', always: true },
  { key: 'est_time', label: 'est_time', numeric: true },
  { key: 'time_unit', label: 'time_unit' },
  { key: 'bom_components', label: 'bom_components' },
  { key: 'material_required_quantity', label: 'material_required_quantity' },
  { key: 'rule', label: 'rule' },
  { key: 'parameter_1', label: 'parameter_1' },
  { key: 'assigned_machine', label: 'assigned_machine' },
  { key: 'source_date', label: 'source_date' },
  { key: 'source_factory', label: 'source_factory' },
  { key: 'source_order', label: 'source_order' },
]

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'number') return !Number.isNaN(v)
  return String(v).trim() !== ''
}

function getColumnWidth(key: keyof Sara101MasterRow): string {
  const map: Partial<Record<keyof Sara101MasterRow, string>> = {
    manufacturing_order_number: '12%',
    order_number: '11%',
    customer_id: '9%',
    product_name: '16%',
    product_description: '16%',
    lot_number: '10%',
    production_quantity: '8%',
    due: '8%',
    out_sourcing: '6%',
    bom_components: '20%',
    material_required_quantity: '20%',
    job_name: '12%',
    workcenter: '10%',
    assigned_machine: '10%',
    source_order: '11%',
  }
  return map[key] ?? '9%'
}

function isLongTextColumn(key: keyof Sara101MasterRow): boolean {
  return key === 'product_name'
    || key === 'product_description'
    || key === 'bom_components'
    || key === 'material_required_quantity'
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

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      row.push(current)
      current = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(current)
      current = ''
      if (row.some(c => c !== '')) rows.push(row)
      row = []
      continue
    }
    current += ch
  }

  row.push(current)
  if (row.some(c => c !== '')) rows.push(row)
  return rows
}

function toNullableText(v: string | null | undefined): string | null {
  const raw = String(v ?? '').trim()
  return raw ? raw : null
}

function toNullableNumber(v: string | null | undefined): number | null {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function toDateOnly(v: string | null | undefined): string | null {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  const normalized = raw.replace(/\//g, '-')
  const m = normalized.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

function toTimestamp(v: string | null | undefined): string | null {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
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

export default function Sara101MasterPage() {
  const [rows, setRows] = useState<Sara101MasterRow[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const loadRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const pageSize = 1000
      let from = 0
      const allRows: Sara101MasterRow[] = []

      while (true) {
        const { data, error: dbError } = await supabase
          .from('sara_101_master')
          .select('*')
          .order('manufacturing_order_number', { ascending: true })
          .range(from, from + pageSize - 1)
        if (dbError) throw dbError

        const chunk = (data ?? []) as Sara101MasterRow[]
        allRows.push(...chunk)

        if (chunk.length < pageSize) break
        from += pageSize
      }

      setRows(allRows)
    } catch (e) {
      setError(formatErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => {
      return (
        r.manufacturing_order_number.toLowerCase().includes(q) ||
        String(r.order_number ?? '').toLowerCase().includes(q) ||
        String(r.customer_id ?? '').toLowerCase().includes(q) ||
        String(r.product_name ?? '').toLowerCase().includes(q)
      )
    })
  }, [rows, query])

  const totalQty = useMemo(() => {
    return filtered.reduce((sum, r) => sum + Number(r.production_quantity ?? 0), 0)
  }, [filtered])

  const previewColumns = useMemo(() => {
    if (filtered.length === 0) return PREVIEW_COLUMNS.filter(c => c.always)
    return PREVIEW_COLUMNS.filter(col => {
      if (col.always) return true
      return filtered.some(row => hasValue(row[col.key]))
    })
  }, [filtered])

  const exportCsv = useCallback(() => {
    if (filtered.length === 0) return
    const lines = filtered.map(r => [
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
      r.source_date,
      r.source_factory,
      r.source_order,
    ])
    downloadCsv(
      `SARA_101_master_${new Date().toISOString().slice(0, 10)}.csv`,
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
        'source_date',
        'source_factory',
        'source_order',
      ],
      lines,
    )
  }, [filtered])

  const handleImportOverwrite = useCallback(async (file: File) => {
    setImporting(true)
    setError(null)
    setMessage(null)
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '')
      const matrix = parseCsv(text)
      if (matrix.length < 2) throw new Error('CSV 內容不足（至少要有標題與一筆資料）')

      const header = matrix[0].map(h => h.trim())
      const indexOf = (name: string) => header.findIndex(h => h.toLowerCase() === name.toLowerCase())
      const required = [
        'Order Number', 'Manufacturing Order Number', 'Product Name', 'Product Description',
        'Lot Number', 'Production Quantity', 'Due', 'Priority Level', 'Earliest Start Time',
        'Job Sequence', 'Workcenter', 'Job Name', 'Job Quantity', 'Out Sourcing',
        'Est. Time', 'Time Unit', 'BOM Components', 'Material Required Quantity',
        'Rule', 'Parameter 1', 'customer_id', 'assigned_machine',
      ]
      const missing = required.filter(k => indexOf(k) === -1)
      if (missing.length > 0) throw new Error(`CSV 缺少欄位：${missing.join(', ')}`)

      const c = {
        order_number: indexOf('Order Number'),
        manufacturing_order_number: indexOf('Manufacturing Order Number'),
        product_name: indexOf('Product Name'),
        product_description: indexOf('Product Description'),
        lot_number: indexOf('Lot Number'),
        production_quantity: indexOf('Production Quantity'),
        due: indexOf('Due'),
        priority_level: indexOf('Priority Level'),
        earliest_start_time: indexOf('Earliest Start Time'),
        job_sequence: indexOf('Job Sequence'),
        workcenter: indexOf('Workcenter'),
        job_name: indexOf('Job Name'),
        job_quantity: indexOf('Job Quantity'),
        out_sourcing: indexOf('Out Sourcing'),
        est_time: indexOf('Est. Time'),
        time_unit: indexOf('Time Unit'),
        bom_components: indexOf('BOM Components'),
        material_required_quantity: indexOf('Material Required Quantity'),
        rule: indexOf('Rule'),
        parameter_1: indexOf('Parameter 1'),
        customer_id: indexOf('customer_id'),
        assigned_machine: indexOf('assigned_machine'),
        source_date: indexOf('source_date'),
        source_factory: indexOf('source_factory'),
        source_order: indexOf('source_order'),
      }

      const payload: Omit<Sara101MasterRow, 'id'>[] = matrix.slice(1)
        .filter(r => r.some(cell => String(cell ?? '').trim() !== ''))
        .map(r => ({
          order_number: toNullableText(r[c.order_number]),
          manufacturing_order_number: String(r[c.manufacturing_order_number] ?? '').trim(),
          product_name: String(r[c.product_name] ?? '').trim(),
          product_description: toNullableText(r[c.product_description]),
          lot_number: toNullableText(r[c.lot_number]),
          production_quantity: Number(toNullableNumber(r[c.production_quantity]) ?? 0),
          due: toDateOnly(r[c.due]),
          priority_level: toNullableText(r[c.priority_level]),
          earliest_start_time: toTimestamp(r[c.earliest_start_time]),
          job_sequence: toNullableText(r[c.job_sequence]),
          workcenter: toNullableText(r[c.workcenter]),
          job_name: toNullableText(r[c.job_name]),
          job_quantity: toNullableNumber(r[c.job_quantity]),
          out_sourcing: toNullableText(r[c.out_sourcing]),
          est_time: toNullableNumber(r[c.est_time]),
          time_unit: toNullableText(r[c.time_unit]),
          bom_components: toNullableText(r[c.bom_components]),
          material_required_quantity: toNullableText(r[c.material_required_quantity]),
          rule: toNullableText(r[c.rule]),
          parameter_1: toNullableText(r[c.parameter_1]),
          customer_id: toNullableText(r[c.customer_id]),
          assigned_machine: toNullableText(r[c.assigned_machine]),
          source_date: c.source_date >= 0 ? toDateOnly(r[c.source_date]) : null,
          source_factory: c.source_factory >= 0 ? toNullableText(r[c.source_factory]) : null,
          source_order: c.source_order >= 0 ? toNullableText(r[c.source_order]) : null,
          updated_at: new Date().toISOString(),
        }))
        .filter(r => r.manufacturing_order_number && r.product_name)

      if (payload.length === 0) throw new Error('CSV 沒有可匯入的有效資料')

      // 同一份 CSV 內若有重複製令號，保留最後一筆，避免 unique constraint 23505
      const dedupMap = new Map<string, Omit<Sara101MasterRow, 'id'>>()
      for (const row of payload) {
        dedupMap.set(row.manufacturing_order_number, row)
      }
      const dedupedPayload = [...dedupMap.values()]
      const duplicateCount = payload.length - dedupedPayload.length

      const { error: clearError } = await supabase
        .from('sara_101_master')
        .delete()
        .neq('id', 0)
      if (clearError) throw clearError

      const CHUNK = 500
      for (let i = 0; i < dedupedPayload.length; i += CHUNK) {
        const { error: insertError } = await supabase
          .from('sara_101_master')
          .insert(dedupedPayload.slice(i, i + CHUNK))
        if (insertError) throw insertError
      }

      setMessage(
        duplicateCount > 0
          ? `✅ 匯入完成，已覆蓋總表，共 ${dedupedPayload.length} 筆（CSV 內重複製令號 ${duplicateCount} 筆，已自動保留最後一筆）`
          : `✅ 匯入完成，已覆蓋總表，共 ${dedupedPayload.length} 筆`,
      )
      await loadRows()
    } catch (e) {
      setError(formatErrorMessage(e))
    } finally {
      setImporting(false)
    }
  }, [loadRows])

  const openImportDialog = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const onPickFile = useCallback(async (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0]
    ev.target.value = ''
    if (!file) return
    const ok = confirm('匯入會先清空目前 SARA_101 總表，再以 CSV 內容重建。確定覆蓋？')
    if (!ok) return
    await handleImportOverwrite(file)
  }, [handleImportOverwrite])

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="border-b border-slate-800/60 bg-slate-900/60 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-teal-300">塔台 SARA · SARA_101 總表</h1>
          <p className="text-sm text-slate-400 mt-1">檢視目前 SARA 累計工單資料（來源：sara_101_master）。</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/sara/sara_101"
            className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm border border-emerald-600"
          >
            ← SARA_101
          </Link>
          <Link
            href="/admin"
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm border border-slate-700"
          >
            管理首頁
          </Link>
        </div>
      </div>

      <div className="p-6 w-full space-y-4">
        <section className="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void onPickFile(e)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋 MO / 單號 / 料號 / 品名"
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm w-72"
            />
            <button
              onClick={() => void loadRows()}
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm border border-slate-700"
            >
              重新整理
            </button>
            <button
              onClick={openImportDialog}
              disabled={importing}
              className="px-3 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-sm border border-amber-600"
            >
              {importing ? '匯入中...' : '匯入 CSV 覆蓋'}
            </button>
            <button
              onClick={exportCsv}
              disabled={filtered.length === 0}
              className="px-3 py-2 rounded-lg bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-sm border border-teal-600"
            >
              匯出 CSV
            </button>
            <div className="text-sm text-slate-400 ml-auto">
              筆數: {filtered.length} / {rows.length}
            </div>
          </div>
          {message && <div className="mt-3 text-sm text-emerald-300">{message}</div>}
          {error && <div className="mt-3 text-sm text-rose-300">{error}</div>}
        </section>

        <section className="rounded-xl border border-slate-700 bg-slate-900/40 overflow-hidden">
          <div className="overflow-y-auto overflow-x-hidden max-h-[560px]">
            <table className="w-full text-xs table-fixed">
              <thead className="bg-slate-900 sticky top-0">
                <tr className="text-slate-400 border-b border-slate-700">
                  {previewColumns.map(col => (
                    <th
                      key={col.key}
                      style={{ width: getColumnWidth(col.key) }}
                      className={`px-3 py-2 ${isLongTextColumn(col.key) ? 'whitespace-normal break-words' : 'whitespace-nowrap'} ${col.numeric ? 'text-right' : 'text-left'}`}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!loading && filtered.map(r => (
                  <tr key={r.manufacturing_order_number} className="border-b border-slate-800/60">
                    {previewColumns.map(col => {
                      const raw = r[col.key]
                      const val = raw === null || raw === undefined ? '' : String(raw)
                      const commonClass = `px-3 py-2 align-top ${isLongTextColumn(col.key) ? 'whitespace-normal break-words' : 'whitespace-nowrap overflow-hidden text-ellipsis'} ${col.numeric ? 'text-right' : 'text-left'}`
                      if (col.key === 'manufacturing_order_number') {
                        return (
                          <td key={col.key} style={{ width: getColumnWidth(col.key) }} className={`${commonClass} font-mono text-teal-300`} title={val}>
                            {val}
                          </td>
                        )
                      }
                      if (col.key === 'customer_id') {
                        return (
                          <td key={col.key} style={{ width: getColumnWidth(col.key) }} className={`${commonClass} font-mono`} title={val}>
                            {val}
                          </td>
                        )
                      }
                      return (
                        <td key={col.key} style={{ width: getColumnWidth(col.key) }} className={commonClass} title={val}>
                          {val}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={previewColumns.length || 1} className="px-3 py-6 text-center text-slate-500">查無資料</td>
                  </tr>
                )}
                {loading && (
                  <tr>
                    <td colSpan={previewColumns.length || 1} className="px-3 py-6 text-center text-slate-500">載入中...</td>
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
