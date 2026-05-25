'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabaseClient'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface SheetMeta {
  sheet_date: string
  row_count: number
  updated_at: string
}

interface SheetRow {
  row_key: string
  order_number: string
  item_code: string
  item_name: string
  customer: string
  quantity: string
  delivery_date: string
  mo_status?: string | null
  mo_number?: string | null
  material_prep_status?: string | null
  argo_slip_no?: string | null
  factory?: string
  machine?: string | null
  assigned_machine?: string | null
  note?: string
}

interface PrepLine {
  slip_no: string
  slip_date: string | null
  mo_number: string | null
  fg_part: string | null
  mo_qty: number
  line_no: number | null
  mbp_part: string | null
  notice_qty: number
  remark: string | null
}

interface MoDetail {
  mo_number: string
  fg_part: string
  item_name: string
  customer: string
  order_number: string
  machine: string
  remark: string
  notice_qty: number
  slip_no: string | null
  slip_date: string | null
  delivery_date: string
  factory: string
  material_prep_status: string
  line_no: number | null
}

interface MaterialGroup {
  group_key: string        // unique key for expand state (= material_code or __missing__<mo>)
  material_code: string    // display label
  material_name: string | null
  unit: string
  total_qty: number
  mos: MoDetail[]
  has_argo_lines: boolean  // has data from erp_material_prep_lines
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtDateLabel(s: string) {
  const parts = s.split('-')
  if (parts.length !== 3) return s
  return `${parts[0]}/${parseInt(parts[1])}/${parseInt(parts[2])}`
}

function exportCsv(groups: MaterialGroup[], date: string, issuedSet: Set<string>, mode: 'pending' | 'issued' | 'all') {
  const header = [
    '料號', '品名', '單位', '總需求量', '已批備料',
    '製令單號', '成品料號', '品名', '客戶', '工單號',
    '行別需求量', '機台', '批備料單號', '批備日期', '交期', '廠別',
  ]
  const rows: string[][] = []
  for (const g of groups) {
    if (!g.has_argo_lines || g.mos.length === 0) {
      if (mode !== 'issued') {
        rows.push([
          g.material_code, g.material_name ?? '', g.unit,
          g.total_qty > 0 ? String(g.total_qty) : '', g.mos.some(m => m.slip_no) ? 'Y' : '',
          '', '', '', '', '', '', '', '', '', '', '',
        ])
      }
    } else {
      for (const mo of g.mos) {
        const key = mo.slip_no && mo.line_no != null ? `${mo.slip_no}:${mo.line_no}` : null
        const issued = key ? issuedSet.has(key) : false
        if (mode === 'pending' && issued) continue
        if (mode === 'issued' && !issued) continue
        rows.push([
          g.material_code, g.material_name ?? '', g.unit,
          String(g.total_qty), mo.slip_no ? 'Y' : '',
          mo.mo_number, mo.fg_part, mo.item_name, mo.customer, mo.order_number,
          String(mo.notice_qty), mo.remark || mo.machine || '', mo.slip_no ?? '', mo.slip_date ?? '',
          mo.delivery_date, mo.factory,
        ])
      }
    }
  }
  const label = mode === 'issued' ? '已發料' : mode === 'pending' ? '未發料' : '全部'
  const csv = [header, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `發料清單_${label}_${date}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export default function MaterialIssuePage() {
  const [sheets, setSheets]               = useState<SheetMeta[]>([])
  const [selectedDate, setSelectedDate]   = useState(todayStr())
  const [sheetRows, setSheetRows]         = useState<SheetRow[]>([])
  const [groups, setGroups]               = useState<MaterialGroup[]>([])
  const [missingMos, setMissingMos]       = useState<MoDetail[]>([])   // MOs with no ARGO lines
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState('')
  const [expanded, setExpanded]           = useState<Set<string>>(new Set())
  const [searchQ, setSearchQ]             = useState('')
  const [showMissing, setShowMissing]     = useState(true)
  const [syncing, setSyncing]             = useState(false)
  const [syncMsg, setSyncMsg]             = useState('')
  const [issuedSet, setIssuedSet]         = useState<Set<string>>(new Set())   // "slip_no:line_no"
  const [tab, setTab]                     = useState<'pending' | 'issued'>('pending')
  const [issuingKey, setIssuingKey]       = useState<string | null>(null)
  const [customerCodeMap, setCustomerCodeMap] = useState<Map<string, string>>(new Map()) // cname → partner_id

  // ── Load customer code map ─────────────────────────────────────────────────────
  useEffect(() => {
    supabase.from('erp_customers').select('partner_id, cname').then(({ data }) => {
      const map = new Map<string, string>()
      for (const c of (data ?? []) as { partner_id: string; cname: string }[]) map.set(c.cname, c.partner_id)
      setCustomerCodeMap(map)
    })
  }, [])

  // ── Load date list ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/argoerp/daily-order-sheet')
      .then(r => r.json())
      .then(j => {
        if (j.success) {
          const list: SheetMeta[] = j.sheets ?? []
          setSheets(list)
          if (list.length > 0 && !list.find(s => s.sheet_date === todayStr())) {
            setSelectedDate(list[0].sheet_date)
          }
        }
      })
      .catch(() => {})
  }, [])

  // ── Sync prep lines from ARGO ERP ──────────────────────────────────────────
  const syncPrepLines = async () => {
    setSyncing(true)
    setSyncMsg('')
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_material_prep' }),
      })
      const json = await res.json() as { success?: boolean; syncedCount?: number; headerCount?: number; detailTotal?: number; error?: string }
      if (json.success) {
        const msg = `已同步 ${json.syncedCount ?? 0} 筆（表頭 ${json.headerCount ?? 0} 張，明細 ${json.detailTotal ?? 0} 筆）`
        setSyncMsg(msg)
        void loadData(selectedDate)
      } else {
        setSyncMsg(`同步失敗：${json.error ?? '未知錯誤'}`)
      }
    } catch (e) {
      setSyncMsg(`同步失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncing(false)
    }
  }

  // ── Load sheet + prep lines ─────────────────────────────────────────────────
  const loadData = useCallback(async (date: string) => {
    setLoading(true)
    setError('')
    setGroups([])
    setMissingMos([])
    try {
      // 1. Load sheet for date
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`)
      const json = await res.json()
      if (!json.success || !json.sheet) {
        setSheetRows([])
        return
      }
      const rows: SheetRow[] = json.sheet.rows ?? []
      setSheetRows(rows)

      // 2. Filter prepped rows with mo_number
      const PREPPED = new Set(['已備料', '已批備料'])
      const preppedRows = rows.filter(r =>
        r.mo_number && r.material_prep_status && PREPPED.has(r.material_prep_status)
      )
      if (preppedRows.length === 0) return

      const moNumbers = [...new Set(preppedRows.map(r => r.mo_number!).filter(Boolean))]
      // Build MO → SheetRow map (first occurrence wins)
      const moMap = new Map<string, SheetRow>()
      for (const r of preppedRows) {
        if (r.mo_number && !moMap.has(r.mo_number)) moMap.set(r.mo_number, r)
      }

      // 3. Query erp_material_prep_lines + machine assignments (parallel)
      const [prepLinesResult, machineAssignResult] = await Promise.all([
        supabase
          .from('erp_material_prep_lines')
          .select('slip_no, slip_date, mo_number, fg_part, mo_qty, line_no, mbp_part, notice_qty, remark')
          .in('mo_number', moNumbers)
          .order('mo_number', { ascending: true })
          .order('line_no', { ascending: true }),
        supabase
          .from('argoerp_mo_machine_assign')
          .select('mo_number, machine')
          .in('mo_number', moNumbers),
      ])
      if (prepLinesResult.error) throw prepLinesResult.error

      const prepLines = (prepLinesResult.data ?? []) as PrepLine[]

      // 3.5. Load issued status
      const slipNos = [...new Set(prepLines.map(l => l.slip_no).filter(Boolean))] as string[]
      const newIssuedSet = new Set<string>()
      if (slipNos.length > 0) {
        const { data: issueData } = await supabase
          .from('erp_material_issue_status')
          .select('slip_no, line_no')
          .in('slip_no', slipNos)
        for (const r of (issueData ?? []) as Array<{ slip_no: string; line_no: number }>) {
          newIssuedSet.add(`${r.slip_no}:${r.line_no}`)
        }
      }
      setIssuedSet(newIssuedSet)

      // Build machine map: mo_number → machine (prefer assign table over sheet row)
      const machineByMo = new Map<string, string>()
      for (const r of (machineAssignResult.data ?? []) as Array<{ mo_number: string; machine: string | null }>) {
        if (r.machine) machineByMo.set(r.mo_number, r.machine)
      }
      // Fallback: fill from sheet rows for MOs not in machine assign table
      for (const [mo, row] of moMap.entries()) {
        if (!machineByMo.has(mo)) {
          const m = row.machine ?? row.assigned_machine
          if (m) machineByMo.set(mo, String(m))
        }
      }

      // 4. Get material names (bom + material_inventory_list fallback) + units (mm_bom_part_units)
      const matCodes = [...new Set(prepLines.map(r => r.mbp_part).filter(Boolean))] as string[]
      const nameMap = new Map<string, string>()
      const unitMap = new Map<string, string>()
      if (matCodes.length > 0) {
        const [bomRes, unitRes, invRes] = await Promise.all([
          supabase
            .from('bom')
            .select('material_code, material_name')
            .in('material_code', matCodes),
          supabase
            .from('mm_bom_part_units')
            .select('part_code, unit_of_measure')
            .in('part_code', matCodes),
          supabase
            .from('material_inventory_list')
            .select('item_code, item_name')
            .in('item_code', matCodes),
        ])
        for (const r of (bomRes.data ?? []) as Array<{ material_code: string; material_name: string | null }>) {
          if (r.material_name && !nameMap.has(r.material_code)) nameMap.set(r.material_code, r.material_name)
        }
        // Fallback: material_inventory_list for codes not in bom
        for (const r of (invRes.data ?? []) as Array<{ item_code: string; item_name: string | null }>) {
          if (r.item_name && !nameMap.has(r.item_code)) nameMap.set(r.item_code, r.item_name)
        }
        for (const r of (unitRes.data ?? []) as Array<{ part_code: string; unit_of_measure: string | null }>) {
          if (r.unit_of_measure) unitMap.set(r.part_code, r.unit_of_measure)
        }
      }

      // 5. Build material groups (grouped by mbp_part)
      const groupMap = new Map<string, MaterialGroup>()
      for (const line of prepLines) {
        if (!line.mbp_part || !line.mo_number) continue
        const sheetRow = moMap.get(line.mo_number)
        const machine = machineByMo.get(line.mo_number) ?? ''

        if (!groupMap.has(line.mbp_part)) {
          groupMap.set(line.mbp_part, {
            group_key:     line.mbp_part,
            material_code: line.mbp_part,
            material_name: nameMap.get(line.mbp_part) ?? null,
            unit:          unitMap.get(line.mbp_part) ?? '',
            total_qty:     0,
            mos:           [],
            has_argo_lines: true,
          })
        }
        const g = groupMap.get(line.mbp_part)!
        g.total_qty += Number(line.notice_qty) || 0
        g.mos.push({
          mo_number:            line.mo_number,
          fg_part:              line.fg_part ?? '',
          item_name:            sheetRow?.item_name ?? '',
          customer:             sheetRow?.customer ?? '',
          order_number:         sheetRow?.order_number ?? '',
          machine,
          remark:               line.remark ?? '',
          notice_qty:           Number(line.notice_qty) || 0,
          slip_no:              line.slip_no ?? null,
          slip_date:            line.slip_date ?? null,
          delivery_date:        sheetRow?.delivery_date ?? '',
          factory:              sheetRow?.factory ?? '',
          material_prep_status: sheetRow?.material_prep_status ?? '',
          line_no:              line.line_no ?? null,
        })
      }

      // Sort each group's MOs: by delivery_date then mo_number
      for (const g of groupMap.values()) {
        g.mos.sort((a, b) => (a.delivery_date || '').localeCompare(b.delivery_date || '') || a.mo_number.localeCompare(b.mo_number))
      }

      // 6. Collect MOs that have no ARGO prep lines (locally marked only)
      const moWithLines = new Set(prepLines.map(l => l.mo_number).filter(Boolean))
      const missingList: MoDetail[] = []
      for (const [mo, row] of moMap.entries()) {
        if (!moWithLines.has(mo)) {
          missingList.push({
            mo_number:            mo,
            fg_part:              row.item_code ?? '',
            item_name:            row.item_name ?? '',
            customer:             row.customer ?? '',
            order_number:         row.order_number ?? '',
            machine:              machineByMo.get(mo) ?? row.machine ?? row.assigned_machine ?? '',
            remark:               '',
            notice_qty:           0,
            slip_no:              row.argo_slip_no ?? null,
            slip_date:            null,
            delivery_date:        row.delivery_date ?? '',
            factory:              row.factory ?? '',
            material_prep_status: row.material_prep_status ?? '',
            line_no:              null,
          })
        }
      }
      missingList.sort((a, b) => a.mo_number.localeCompare(b.mo_number))

      // 7. Sort groups by material_code
      const sorted = Array.from(groupMap.values()).sort((a, b) =>
        a.material_code.localeCompare(b.material_code)
      )
      setGroups(sorted)
      setMissingMos(missingList)
      // Expand all by default
      setExpanded(new Set(sorted.map(g => g.group_key)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadData(selectedDate) }, [selectedDate, loadData])

  // ── Filtered groups ─────────────────────────────────────────────────────────
  const filteredGroups = useMemo(() => {
    if (!searchQ.trim()) return groups
    const q = searchQ.trim().toLowerCase()
    return groups.filter(g =>
      g.material_code.toLowerCase().includes(q) ||
      (g.material_name ?? '').toLowerCase().includes(q) ||
      g.mos.some(m =>
        m.mo_number.toLowerCase().includes(q) ||
        m.order_number.toLowerCase().includes(q) ||
        m.customer.toLowerCase().includes(q) ||
        m.fg_part.toLowerCase().includes(q)
      )
    )
  }, [groups, searchQ])

  const filteredMissing = useMemo(() => {
    if (!searchQ.trim()) return missingMos
    const q = searchQ.trim().toLowerCase()
    return missingMos.filter(m =>
      m.mo_number.toLowerCase().includes(q) ||
      m.order_number.toLowerCase().includes(q) ||
      m.customer.toLowerCase().includes(q)
    )
  }, [missingMos, searchQ])

  // ── Tab-filtered groups (each group's mos filtered by issued state) ─────────
  const tabGroups = useMemo(() => {
    return filteredGroups
      .map(g => ({
        ...g,
        mos: g.mos.filter(m => {
          const key = m.slip_no && m.line_no != null ? `${m.slip_no}:${m.line_no}` : null
          const issued = key ? issuedSet.has(key) : false
          return tab === 'pending' ? !issued : issued
        }),
      }))
      .filter(g => g.mos.length > 0)
  }, [filteredGroups, issuedSet, tab])

  // ── Pending / issued counts (across all filteredGroups, ignoring search) ────
  const { pendingCount, issuedCount } = useMemo(() => {
    let pending = 0, issued = 0
    for (const g of filteredGroups) {
      for (const m of g.mos) {
        const key = m.slip_no && m.line_no != null ? `${m.slip_no}:${m.line_no}` : null
        if (key && issuedSet.has(key)) issued++
        else pending++
      }
    }
    return { pendingCount: pending, issuedCount: issued }
  }, [filteredGroups, issuedSet])

  // ── Stats ───────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const preppedCount = sheetRows.filter(r =>
      r.material_prep_status && ['已備料', '已批備料'].includes(r.material_prep_status) && r.mo_number
    ).length
    const uniqueMats = filteredGroups.filter(g => g.has_argo_lines).length
    const allMos = new Set(filteredGroups.flatMap(g => g.mos.map(m => m.mo_number)))
    return { preppedCount, uniqueMats, totalMos: allMos.size }
  }, [sheetRows, filteredGroups])

  // ── Toggle helpers ──────────────────────────────────────────────────────────
  const toggleGroup = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const expandAll  = () => setExpanded(new Set(tabGroups.map(g => g.group_key)))
  const collapseAll = () => setExpanded(new Set())

  const hasData = groups.length > 0 || missingMos.length > 0

  // ── Toggle issue / un-issue ─────────────────────────────────────────────────
  const toggleIssue = useCallback(async (mo: MoDetail) => {
    if (!mo.slip_no || mo.line_no == null) return
    const key = `${mo.slip_no}:${mo.line_no}`
    setIssuingKey(key)
    const wasIssued = issuedSet.has(key)
    try {
      const res = await fetch('/api/argoerp/material-issue', {
        method: wasIssued ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slip_no: mo.slip_no, line_no: mo.line_no }),
      })
      if (!res.ok) throw new Error('發料操作失敗')
      setIssuedSet(prev => {
        const next = new Set(prev)
        if (wasIssued) next.delete(key)
        else next.add(key)
        return next
      })
    } catch (e) {
      setSyncMsg(`操作失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setIssuingKey(null)
    }
  }, [issuedSet])

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-[1500px] mx-auto px-4 py-6">

        {/* ── Page header ── */}
        <div className="flex items-start justify-between mb-6 no-print">
          <div>
            <h1 className="text-xl font-bold text-white">📦 發料 / 領料清單</h1>
            <p className="text-slate-400 text-sm mt-0.5">
              依每日出單表批備料結果彙整，相同料號合計顯示
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/"
              className="px-4 py-2 rounded-lg bg-slate-700 border border-slate-600 text-slate-200 hover:bg-slate-600 text-sm transition-colors"
            >
              🏠 首頁
            </Link>
            <button
              onClick={syncPrepLines}
              disabled={syncing || loading}
              className="px-4 py-2 rounded-lg bg-indigo-800 border border-indigo-600 text-indigo-200 hover:bg-indigo-700 disabled:opacity-40 text-sm transition-colors"
            >
              {syncing ? '⏳ 同步中…' : '🔁 同步批備料單'}
            </button>
            <button
              onClick={() => filteredGroups.length > 0 && exportCsv(filteredGroups, selectedDate, issuedSet, 'pending')}
              disabled={filteredGroups.length === 0}
              className="px-4 py-2 rounded-lg bg-emerald-800 border border-emerald-600 text-emerald-200 hover:bg-emerald-700 disabled:opacity-40 text-sm transition-colors"
            >
              ⬇️ 未發料 CSV
            </button>
            <button
              onClick={() => filteredGroups.length > 0 && exportCsv(filteredGroups, selectedDate, issuedSet, 'issued')}
              disabled={filteredGroups.length === 0}
              className="px-4 py-2 rounded-lg bg-blue-800 border border-blue-600 text-blue-200 hover:bg-blue-700 disabled:opacity-40 text-sm transition-colors"
            >
              ⬇️ 已發料 CSV
            </button>
            <button
              onClick={() => window.print()}
              className="px-4 py-2 rounded-lg bg-slate-700 border border-slate-600 text-slate-200 hover:bg-slate-600 text-sm transition-colors"
            >
              🖨️ 列印
            </button>
            <button
              onClick={() => void loadData(selectedDate)}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-slate-700 border border-slate-600 text-slate-200 hover:bg-slate-600 disabled:opacity-50 text-sm transition-colors"
            >
              🔄 重新載入
            </button>
          </div>
        </div>

        {/* ── Sync message ── */}
        {syncMsg && (
          <div className={`mb-4 px-4 py-2 rounded-lg text-sm no-print ${syncMsg.startsWith('同步失敗') ? 'bg-red-950/40 border border-red-700/40 text-red-300' : 'bg-indigo-950/40 border border-indigo-700/40 text-indigo-300'}`}>
            {syncMsg}
            <button onClick={() => setSyncMsg('')} className="ml-3 text-slate-400 hover:text-white">✕</button>
          </div>
        )}

        {/* ── Controls ── */}
        <div className="flex flex-wrap items-center gap-3 mb-4 no-print">
          {/* Date selector */}
          <select
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
          >
            {sheets.map(s => (
              <option key={s.sheet_date} value={s.sheet_date}>
                {fmtDateLabel(s.sheet_date)}（{s.row_count} 筆）
              </option>
            ))}
            {sheets.length === 0 && (
              <option value={selectedDate}>{fmtDateLabel(selectedDate)}</option>
            )}
          </select>

          {/* Search */}
          <input
            type="text"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            placeholder="搜尋料號 / 品名 / 製令 / 客戶…"
            className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500 w-64"
          />

          {/* Expand / collapse */}
          <button
            onClick={expandAll}
            className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 text-xs transition-colors"
          >全部展開</button>
          <button
            onClick={collapseAll}
            className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 text-xs transition-colors"
          >全部收合</button>
        </div>

        {/* ── Tabs ── */}
        <div className="flex gap-0 mb-0 no-print border-b border-slate-800">
          <button
            onClick={() => setTab('pending')}
            className={`px-5 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === 'pending'
                ? 'bg-slate-800 text-white border border-b-transparent border-slate-700 -mb-px'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            未發料
            <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${tab === 'pending' ? 'bg-amber-800 text-amber-200' : 'bg-slate-700 text-slate-500'}`}>
              {pendingCount}
            </span>
          </button>
          <button
            onClick={() => setTab('issued')}
            className={`px-5 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === 'issued'
                ? 'bg-slate-800 text-white border border-b-transparent border-slate-700 -mb-px'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            已發料
            <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${tab === 'issued' ? 'bg-emerald-800 text-emerald-200' : 'bg-slate-700 text-slate-500'}`}>
              {issuedCount}
            </span>
          </button>
        </div>

        {/* ── Print header (only visible when printing) ── */}
        <div className="hidden print:block mb-4 border-b border-gray-300 pb-2">
          <h1 className="text-lg font-bold text-black">發料 / 領料清單 — {fmtDateLabel(selectedDate)}</h1>
          <div className="text-sm text-gray-600 mt-1">
            料號種類：{stats.uniqueMats} 種 ／ 製令數：{stats.totalMos} 筆 ／ 批備料 MO：{stats.preppedCount} 筆
          </div>
        </div>

        {/* ── Stats bar ── */}
        {!loading && hasData && (
          <div className="flex gap-4 mb-4 text-xs text-slate-400 no-print">
            <span>本日批備料 MO：<span className="text-cyan-300 font-bold">{stats.preppedCount}</span> 筆</span>
            <span>料號種類：<span className="text-emerald-300 font-bold">{stats.uniqueMats}</span> 種</span>
            <span>有明細製令：<span className="text-yellow-300 font-bold">{stats.totalMos}</span> 筆</span>
            {missingMos.length > 0 && (
              <span>
                無 ARGO 明細：
                <span className="text-orange-300 font-bold">{missingMos.length}</span> 筆
                （本地備料，待 ERP 同步）
              </span>
            )}
          </div>
        )}

        {/* ── Loading / Error / Empty ── */}
        {loading && (
          <div className="py-20 text-center text-slate-400">載入中...</div>
        )}
        {!loading && error && (
          <div className="py-10 text-center text-red-400 text-sm">{error}</div>
        )}
        {!loading && !error && !hasData && (
          <div className="py-20 text-center text-slate-500">
            {sheetRows.length === 0
              ? '此日期無出單表資料'
              : '此日期無批備料紀錄（已備料 / 已批備料）'}
          </div>
        )}
        {!loading && !error && hasData && tabGroups.length === 0 && filteredMissing.length === 0 && (
          <div className="py-10 text-center text-slate-500">無符合搜尋的資料</div>
        )}

        {/* ── Material groups ── */}
        {!loading && !error && tabGroups.length > 0 && (
          <div className="space-y-1.5">
            {tabGroups.map(g => {
              const isExp   = expanded.has(g.group_key)
              const hasSlip = g.mos.some(m => m.slip_no)
              const machines = [...new Set(g.mos.map(m => m.remark || m.machine).filter(Boolean))].join('、')

              return (
                <div key={g.group_key} className="rounded-lg border border-slate-800 overflow-hidden print:border-slate-400 print:mb-2">

                  {/* Group header */}
                  <div
                    className="flex items-center gap-3 px-4 py-2.5 cursor-pointer select-none transition-colors bg-slate-900/80 hover:bg-slate-800/60 print:bg-gray-100 print:cursor-default"
                    onClick={() => toggleGroup(g.group_key)}
                  >
                    <span className="text-slate-500 text-xs w-3 print:hidden">{isExp ? '▾' : '▸'}</span>

                    {/* Material code */}
                    <span className="font-mono text-cyan-300 text-sm font-bold min-w-[120px] print:text-black">
                      {g.material_code}
                    </span>

                    {/* Material name */}
                    <span className="text-slate-200 text-sm flex-1 truncate print:text-black">
                      {g.material_name ?? <span className="text-slate-600 italic">—</span>}
                    </span>

                    {/* Total qty badge */}
                    {g.total_qty > 0 && (
                      <span className="px-2.5 py-0.5 rounded bg-yellow-900/50 border border-yellow-700/40 text-yellow-300 font-mono font-bold text-xs whitespace-nowrap print:border-black print:text-black">
                        {g.total_qty.toLocaleString()} {g.unit}
                      </span>
                    )}

                    {/* Machines */}
                    {machines && (
                      <span className="px-2 py-0.5 rounded bg-slate-700/60 text-slate-300 text-xs truncate max-w-[200px] print:text-black">
                        🔧 {machines}
                      </span>
                    )}

                    {/* Slip status */}
                    {hasSlip ? (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-400 text-[10px] border border-emerald-700/40 whitespace-nowrap print:text-black">
                        已批備料
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 text-[10px] border border-slate-700 whitespace-nowrap print:text-black">
                        待備料
                      </span>
                    )}

                    {/* MO count */}
                    <span className="text-slate-500 text-xs whitespace-nowrap">{g.mos.length} MO</span>
                  </div>

                  {/* MO detail table */}
                  {isExp && (
                    <div className="border-t border-slate-800/80 print:border-slate-300">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-950/60 border-b border-slate-800/60 print:bg-gray-50">
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">製令單號</th>
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">成品料號</th>
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">品名</th>
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">客戶</th>
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">工單號</th>
                            <th className="px-3 py-1.5 text-right text-slate-500 whitespace-nowrap">需求量</th>
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">機台</th>
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">批備料單號</th>
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">批備日期</th>
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">交期</th>
                            <th className="px-3 py-1.5 text-left text-slate-500 whitespace-nowrap">廠</th>
                            <th className="px-3 py-1.5 text-center text-slate-500 whitespace-nowrap no-print">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.mos.map((mo, i) => (
                            <tr
                              key={`${mo.mo_number}-${mo.line_no ?? i}`}
                              className={`border-b border-slate-800/40 ${i % 2 === 0 ? 'bg-slate-900/30' : 'bg-slate-950/30'} hover:bg-slate-800/30 print:border-slate-200`}
                            >
                              <td className="px-3 py-1.5 font-mono text-cyan-400 whitespace-nowrap print:text-black">
                                {mo.mo_number}
                              </td>
                              <td className="px-3 py-1.5 font-mono text-slate-300 whitespace-nowrap print:text-black">
                                {mo.fg_part || '—'}
                              </td>
                              <td className="px-3 py-1.5 text-slate-300 max-w-[180px] truncate print:text-black" title={mo.item_name}>
                                {mo.item_name || '—'}
                              </td>
                              <td className="px-3 py-1.5 text-slate-400 max-w-[120px] truncate print:text-black" title={mo.customer}>
                                {(() => {
                                  const code = customerCodeMap.get(mo.customer)
                                  return code ? `[${code}] ${mo.customer}` : (mo.customer || '—')
                                })()}
                              </td>
                              <td className="px-3 py-1.5 font-mono text-slate-400 whitespace-nowrap print:text-black">
                                {mo.order_number || '—'}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-yellow-300 whitespace-nowrap print:text-black">
                                {mo.notice_qty > 0 ? mo.notice_qty.toLocaleString() : '—'}
                              </td>
                              <td className="px-3 py-1.5 text-slate-200 whitespace-nowrap print:text-black">
                                {mo.remark || mo.machine || <span className="text-slate-600">—</span>}
                              </td>
                              <td className="px-3 py-1.5 font-mono whitespace-nowrap">
                                {mo.slip_no
                                  ? <span className="text-emerald-400 print:text-black">{mo.slip_no}</span>
                                  : <span className="text-slate-600">—</span>}
                              </td>
                              <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap print:text-black">
                                {mo.slip_date ?? '—'}
                              </td>
                              <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap print:text-black">
                                {mo.delivery_date || '—'}
                              </td>
                              <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap print:text-black">
                                {mo.factory || '—'}
                              </td>
                              <td className="px-3 py-1.5 text-center no-print">
                                {mo.slip_no && mo.line_no != null && (() => {
                                  const key = `${mo.slip_no}:${mo.line_no}`
                                  const isBusy = issuingKey === key
                                  return (
                                    <button
                                      onClick={() => void toggleIssue(mo)}
                                      disabled={isBusy}
                                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 ${
                                        tab === 'pending'
                                          ? 'bg-emerald-800 border border-emerald-600 text-emerald-200 hover:bg-emerald-700'
                                          : 'bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600'
                                      }`}
                                    >
                                      {isBusy ? '…' : tab === 'pending' ? '發料' : '未發'}
                                    </button>
                                  )
                                })()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ── MOs without ARGO prep lines ── */}
        {!loading && !error && filteredMissing.length > 0 && (
          <div className="mt-6">
            <div
              className="flex items-center gap-2 mb-2 cursor-pointer select-none no-print"
              onClick={() => setShowMissing(p => !p)}
            >
              <span className="text-slate-500 text-xs">{showMissing ? '▾' : '▸'}</span>
              <span className="text-sm text-orange-300 font-medium">
                無 ARGO 批備料明細（{filteredMissing.length} 筆）
              </span>
              <span className="text-xs text-slate-500">— 僅本地標記「已備料」，尚未同步批備料單到 ARGO，或未執行 ERP 同步</span>
            </div>
            {showMissing && (
              <div className="rounded-lg border border-orange-900/50 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-orange-950/30 border-b border-orange-900/40">
                      <th className="px-3 py-2 text-left text-orange-400 whitespace-nowrap">製令單號</th>
                      <th className="px-3 py-2 text-left text-orange-400 whitespace-nowrap">成品料號</th>
                      <th className="px-3 py-2 text-left text-orange-400 whitespace-nowrap">品名</th>
                      <th className="px-3 py-2 text-left text-orange-400 whitespace-nowrap">客戶</th>
                      <th className="px-3 py-2 text-left text-orange-400 whitespace-nowrap">工單號</th>
                      <th className="px-3 py-2 text-left text-orange-400 whitespace-nowrap">機台</th>
                      <th className="px-3 py-2 text-left text-orange-400 whitespace-nowrap">備料狀態</th>
                      <th className="px-3 py-2 text-left text-orange-400 whitespace-nowrap">批備料單號</th>
                      <th className="px-3 py-2 text-left text-orange-400 whitespace-nowrap">交期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMissing.map((mo, i) => (
                      <tr key={mo.mo_number}
                        className={`border-b border-orange-900/20 ${i % 2 === 0 ? 'bg-slate-900/20' : 'bg-orange-950/10'}`}
                      >
                        <td className="px-3 py-2 font-mono text-cyan-400 whitespace-nowrap">{mo.mo_number}</td>
                        <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">{mo.fg_part || '—'}</td>
                        <td className="px-3 py-2 text-slate-300 max-w-[180px] truncate">{mo.item_name || '—'}</td>
                        <td className="px-3 py-2 text-slate-400 max-w-[120px] truncate">{mo.customer || '—'}</td>
                        <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap">{mo.order_number || '—'}</td>
                        <td className="px-3 py-2 text-slate-200 whitespace-nowrap">{mo.remark || mo.machine || '—'}</td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] border ${
                            mo.material_prep_status === '已批備料'
                              ? 'bg-emerald-900/50 text-emerald-400 border-emerald-700/40'
                              : 'bg-amber-900/50 text-amber-300 border-amber-700/40'
                          }`}>
                            {mo.material_prep_status || '已備料'}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">
                          {mo.slip_no ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{mo.delivery_date || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          body { background: white !important; color: black !important; }
          .no-print { display: none !important; }
          button, select, input[type="text"] { display: none !important; }
          .print\\:hidden { display: none !important; }
        }
        @media screen {
          .print\\:block { display: none; }
        }
      `}</style>
    </div>
  )
}
