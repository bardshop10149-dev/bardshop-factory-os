'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ============================================================
// 型別
// ============================================================
interface SoLine {
  line_no: number | null
  description: string | null
  mbp_part: string | null
  duedate: string | null
  order_qty_oru: number | null
  unit_of_measure_oru: string | null
  remark: string | null
}

interface SoInfo {
  project_id: string
  partner_name: string | null
  begin_date: string | null
  sales_name: string | null
  lines: SoLine[]
}

interface MoRecord {
  mo_number: string
  factory: string
  product_code?: string
  lot_number?: string
  planned_qty?: string
  source_order?: string
  mo_note?: string
  create_date?: string
  prep_status?: '未備料' | '已備料' | '無需備料' | null
  plate_count?: string
  machine?: string
}

interface BomRow {
  product_code: string
  product_name: string | null
  production_quantity: number | null
  material_code: string
  material_name: string | null
  quantity: number
  unit: string | null
}

interface SubstituteRuleRow {
  source_item_code: string
  substitute_item_code: string
  priority: number
}

interface MaterialPrepRow {
  row_key: string
  mo_number: string
  source_order: string
  product_code: string
  source_material_code: string
  source_material_name: string
  required_qty: number
  is_buffered: boolean
  uses_plate_count: boolean
  unit: string
  stock_qty: number
  substitute_options: Array<{
    code: string
    name: string
    stock_qty: number
    label: string
  }>
  selected_material_code: string
  selected_material_name: string
  selected_material_stock_qty: number
  planned_qty: number
  plate_count: string
  factory: string
  machine: string
  std_qty: number
  status: '可直接備料' | '建議替代' | '缺料' | '無BOM'
  note: string
}

// ============================================================
// 工具函式
// ============================================================
function formatQty(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '')
}

const DEFAULT_PLATE_PREFIXES = ['MACRT']
const MATERIAL_PREP_INTERFACE_ID = 'IFAF078'

// ============================================================
// 主元件
// ============================================================
export default function NgMaterialPrepPage() {
  // ---- SO 搜尋 ----
  const [soQuery, setSoQuery] = useState('')
  const [soSearching, setSoSearching] = useState(false)
  const [soInfo, setSoInfo] = useState<SoInfo | null>(null)
  const [soError, setSoError] = useState('')

  // ---- 相關製令清單 ----
  const [moList, setMoList] = useState<MoRecord[]>([])
  const [moLoading, setMoLoading] = useState(false)

  // ---- 選取的單一製令 ----
  const [selectedMo, setSelectedMo] = useState<MoRecord | null>(null)

  // ---- BOM / 庫存 / 替代料 ----
  const [bomRows, setBomRows] = useState<BomRow[]>([])
  const [inventoryMap, setInventoryMap] = useState<Record<string, number>>({})
  const [unitMap, setUnitMap] = useState<Record<string, string>>({})
  const [substituteMap, setSubstituteMap] = useState<Record<string, SubstituteRuleRow[]>>({})
  const [bomLoading, setBomLoading] = useState(false)
  const [bomError, setBomError] = useState('')

  // ---- 覆寫設定（此頁面使用 local state，不同步至 Supabase）----
  const [materialOverrides, setMaterialOverrides] = useState<Record<string, string>>({})
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, string>>({})
  const [noBufferKeys, setNoBufferKeys] = useState<Set<string>>(new Set())
  const [noNeedRowKeys, setNoNeedRowKeys] = useState<Set<string>>(new Set())
  const [extraNoBomSlots, setExtraNoBomSlots] = useState<Record<string, string[]>>({})
  const [remarkOverrides, setRemarkOverrides] = useState<Record<string, string>>({})
  const [swapOpenKeys, setSwapOpenKeys] = useState<Set<string>>(new Set())
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(new Set())
  const [platePrefixes] = useState<string[]>(DEFAULT_PLATE_PREFIXES)

  // ---- NG 單號預覽 ----
  const [ngSlipNo, setNgSlipNo] = useState<string>('')
  const [ngSlipLoading, setNgSlipLoading] = useState(false)

  // ---- 匯入 ----
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const importInFlightRef = useRef(false)

  // ============================================================
  // SO 搜尋
  // ============================================================
  const handleSearchSo = useCallback(async (query?: string) => {
    const q = (query ?? soQuery).trim().toUpperCase()
    if (!q) return
    setSoSearching(true)
    setSoError('')
    setSoInfo(null)
    setMoList([])
    setSelectedMo(null)
    setBomRows([])
    setNgSlipNo('')
    setImportMsg('')

    try {
      const { data, error } = await supabase
        .from('erp_so_lines')
        .select('project_id, begin_date, sales_name, partner_name, line_no, description, mbp_part, duedate, order_qty_oru, unit_of_measure_oru, remark')
        .eq('project_id', q)
        .order('line_no', { ascending: true })

      if (error) throw error
      if (!data || data.length === 0) {
        setSoError(`查無銷售訂單：${q}`)
        return
      }

      const first = data[0]
      setSoInfo({
        project_id: first.project_id,
        partner_name: first.partner_name,
        begin_date: first.begin_date,
        sales_name: first.sales_name,
        lines: data.map(r => ({
          line_no: r.line_no,
          description: r.description,
          mbp_part: r.mbp_part,
          duedate: r.duedate,
          order_qty_oru: r.order_qty_oru,
          unit_of_measure_oru: r.unit_of_measure_oru,
          remark: r.remark,
        })),
      })

      // 載入相關製令
      // 雙來源：erp_mo_lines（ARGO 同步，有 source_order）+ argoerp_mo_summary（系統匯入，有完整欄位）
      setMoLoading(true)

      // 1. 先從 erp_mo_lines 查出所有屬於此 SO 的 MO 號碼（source_order = SO project_id）
      const { data: moLinesData } = await supabase
        .from('erp_mo_lines')
        .select('project_id, mbp_part, order_qty, source_order')
        .eq('source_order', q)

      const moNumbersFromLines = Array.from(new Set(
        (moLinesData ?? []).map((r: { project_id: string }) => r.project_id).filter(Boolean)
      ))

      // 2. 再從 argoerp_mo_summary 查（source_order = q 或 mo_number IN ...）
      let summaryQuery = supabase
        .from('argoerp_mo_summary')
        .select('mo_number, factory, product_code, lot_number, planned_qty, source_order, mo_note, create_date, saved_at, prep_status, plate_count, machine')

      if (moNumbersFromLines.length > 0) {
        summaryQuery = summaryQuery.or(`source_order.eq.${q},mo_number.in.(${moNumbersFromLines.join(',')})`)
      } else {
        summaryQuery = summaryQuery.eq('source_order', q)
      }
      const { data: summaryData, error: moErr } = await summaryQuery.order('mo_number', { ascending: true })
      if (moErr) throw moErr

      const summaryMoNumbers = new Set((summaryData ?? []).map((r: { mo_number: string }) => r.mo_number))

      // 3. 對 argoerp_mo_summary 完全查無的 MO，從 erp_mo_lines 補建 fallback 記錄
      const fallbackMoMap = new Map<string, { mbp_part: string | null; order_qty: number }>()
      for (const r of (moLinesData ?? []) as Array<{ project_id: string; mbp_part: string | null; order_qty: number }>) {
        if (!summaryMoNumbers.has(r.project_id) && !fallbackMoMap.has(r.project_id)) {
          fallbackMoMap.set(r.project_id, { mbp_part: r.mbp_part, order_qty: r.order_qty })
        }
      }
      const fallbackRecords: MoRecord[] = Array.from(fallbackMoMap.entries()).map(([moNum, info]) => ({
        mo_number: moNum,
        factory: moNum.startsWith('MOT') ? 'T' : moNum.startsWith('MOC') ? 'C' : 'O',
        product_code: info.mbp_part ?? '',
        planned_qty: String(info.order_qty ?? ''),
        source_order: q,
        prep_status: null,
      }))

      const merged = [...((summaryData ?? []) as MoRecord[]), ...fallbackRecords]
      merged.sort((a, b) => a.mo_number.localeCompare(b.mo_number))

      // 4. 以 argoerp_material_prep_log 的最新記錄覆寫備料狀態（最準確）
      if (merged.length > 0) {
        const allMoNums = merged.map(m => m.mo_number)
        const { data: prepLogData } = await supabase
          .from('argoerp_material_prep_log')
          .select('mo_number, status, logged_at')
          .in('mo_number', allMoNums)
          .order('logged_at', { ascending: false })

        const latestStatusMap = new Map<string, string>()
        for (const r of (prepLogData ?? []) as Array<{ mo_number: string; status: string; logged_at: string }>) {
          if (!latestStatusMap.has(r.mo_number)) latestStatusMap.set(r.mo_number, r.status)
        }
        for (const mo of merged) {
          const s = latestStatusMap.get(mo.mo_number)
          if (s) mo.prep_status = s as MoRecord['prep_status']
        }
      }

      // 5. 以出單表分配機台覆寫（mo-machine-assign API）
      if (merged.length > 0) {
        try {
          const nums = merged.map(m => m.mo_number)
          const assignRes = await fetch(`/api/argoerp/mo-machine-assign?mo_numbers=${encodeURIComponent(nums.join(','))}`)
          const assignJson = await assignRes.json().catch(() => ({}))
          if (assignJson?.success && Array.isArray(assignJson.assignments)) {
            const assignMap: Record<string, string> = {}
            for (const a of assignJson.assignments as { mo_number: string; machine: string }[]) {
              if (a.mo_number && a.machine) assignMap[a.mo_number] = a.machine
            }
            for (const rec of merged) {
              if (assignMap[rec.mo_number]) rec.machine = assignMap[rec.mo_number]
            }
          }
        } catch { /* 忽略機台分配載入錯誤 */ }
      }

      setMoList(merged)
    } catch (e) {
      setSoError(e instanceof Error ? e.message : '搜尋失敗')
    } finally {
      setSoSearching(false)
      setMoLoading(false)
    }
  }, [soQuery])

  // ============================================================
  // 選取製令 → 載入 BOM / 庫存
  // ============================================================
  const handleSelectMo = useCallback(async (mo: MoRecord) => {
    setSelectedMo(mo)
    setSelectedRowKeys(new Set())
    setMaterialOverrides({})
    setQtyOverrides({})
    setNoBufferKeys(new Set())
    setNoNeedRowKeys(new Set())
    setExtraNoBomSlots({})
    setRemarkOverrides({})
    setSwapOpenKeys(new Set())
    setBomRows([])
    setBomError('')
    setImportMsg('')
    setNgSlipNo('')

    const productCode = (mo.product_code ?? '').trim()

    // ── 計算下一個 NG 單號 ──
    setNgSlipLoading(true)
    try {
      const { data: ngLogs } = await supabase
        .from('argoerp_material_prep_log')
        .select('argo_slip_no')
        .eq('mo_number', mo.mo_number)
        .like('argo_slip_no', `${mo.mo_number}NG%`)

      const ngNums = (ngLogs ?? [])
        .map((r: { argo_slip_no: string | null }) => r.argo_slip_no)
        .filter((s): s is string => typeof s === 'string' && s.startsWith(`${mo.mo_number}NG`))
        .map(s => parseInt(s.slice(mo.mo_number.length + 2), 10))
        .filter(n => !isNaN(n) && n > 0)
      const maxNg = ngNums.length > 0 ? Math.max(...ngNums) : 0
      setNgSlipNo(`${mo.mo_number}NG${maxNg + 1}`)
    } catch {
      setNgSlipNo(`${mo.mo_number}NG1`)
    } finally {
      setNgSlipLoading(false)
    }

    if (!productCode) return

    // ── 載入 BOM ──
    setBomLoading(true)
    try {
      const { data: erpBomData, error: erpBomErr } = await supabase
        .from('mm_bom_structure')
        .select('parent_part, child_part, lot_child_qty, lot_base, bom_ver')
        .eq('parent_part', productCode)
      if (erpBomErr) throw erpBomErr

      type ErpBomRow = { parent_part: string; child_part: string; lot_child_qty: number | null; lot_base: number | null; bom_ver: number }
      const allErpBom = (erpBomData ?? []) as ErpBomRow[]
      let minVer = Infinity
      allErpBom.forEach(r => { if (r.bom_ver < minVer) minVer = r.bom_ver })
      const filteredBom = allErpBom.filter(r => r.bom_ver === minVer)

      const materialCodes = Array.from(new Set(filteredBom.map(r => r.child_part).filter(Boolean)))

      const partInfoMap: Record<string, { part_name: string | null; unit_of_measure: string | null }> = {}
      if (materialCodes.length > 0) {
        const { data: partData } = await supabase
          .from('mm_bom_part_units')
          .select('part_code, part_name, unit_of_measure')
          .in('part_code', materialCodes)
        ;((partData ?? []) as Array<{ part_code: string; part_name: string | null; unit_of_measure: string | null }>).forEach(p => {
          partInfoMap[p.part_code] = { part_name: p.part_name, unit_of_measure: p.unit_of_measure }
        })
      }

      const rows: BomRow[] = filteredBom.map(r => ({
        product_code: r.parent_part,
        product_name: null,
        production_quantity: r.lot_base ?? 1,
        material_code: r.child_part,
        material_name: partInfoMap[r.child_part]?.part_name ?? null,
        quantity: r.lot_child_qty ?? 0,
        unit: partInfoMap[r.child_part]?.unit_of_measure ?? null,
      }))

      // ── 替代料 ──
      const { data: substituteData, error: substituteError } = await supabase
        .from('material_substitute_rules')
        .select('source_item_code, substitute_item_code, priority')
        .in('source_item_code', materialCodes)
      if (substituteError) throw substituteError

      const groupedSubstitutes: Record<string, SubstituteRuleRow[]> = {}
      ;((substituteData as SubstituteRuleRow[] | null) || []).forEach(rule => {
        if (!groupedSubstitutes[rule.source_item_code]) groupedSubstitutes[rule.source_item_code] = []
        groupedSubstitutes[rule.source_item_code].push(rule)
      })
      Object.values(groupedSubstitutes).forEach(list => list.sort((a, b) => a.priority - b.priority))

      // ── 庫存 ──
      const allCodes = Array.from(new Set([
        ...materialCodes,
        ...(((substituteData as SubstituteRuleRow[] | null) || []).map(r => r.substitute_item_code).filter(Boolean)),
      ]))

      let nextInventoryMap: Record<string, number> = {}
      let nextUnitMap: Record<string, string> = {}
      if (allCodes.length > 0) {
        const [inventoryRes, unitRes] = await Promise.all([
          supabase.from('erp_pj_sync').select('doc_no, qty').eq('doc_type', '倉庫庫存').in('doc_no', allCodes),
          supabase.from('mm_bom_part_units').select('part_code, unit_of_measure').in('part_code', allCodes),
        ])
        if (inventoryRes.error) throw inventoryRes.error
        nextInventoryMap = ((inventoryRes.data as Array<{ doc_no: string; qty: number }> | null) || []).reduce<Record<string, number>>((acc, item) => {
          acc[item.doc_no] = Number(item.qty) || 0; return acc
        }, {})
        nextUnitMap = ((unitRes.data as Array<{ part_code: string; unit_of_measure: string | null }> | null) || []).reduce<Record<string, string>>((acc, item) => {
          if (item.unit_of_measure) acc[item.part_code] = item.unit_of_measure; return acc
        }, {})
      }

      setBomRows(rows)
      setSubstituteMap(groupedSubstitutes)
      setInventoryMap(nextInventoryMap)
      setUnitMap(nextUnitMap)
    } catch (e) {
      setBomError(e instanceof Error ? e.message : 'BOM / 庫存讀取失敗')
    } finally {
      setBomLoading(false)
    }
  }, [])

  // ── 自訂料號更新時補查單位 ──
  useEffect(() => {
    const overrideCodes = [...new Set(Object.values(materialOverrides).filter(Boolean))]
    if (overrideCodes.length === 0) return
    supabase
      .from('mm_bom_part_units')
      .select('part_code, unit_of_measure')
      .in('part_code', overrideCodes)
      .then(({ data }) => {
        if (!data || data.length === 0) return
        const additions: Record<string, string> = {}
        for (const item of data as Array<{ part_code: string; unit_of_measure: string | null }>) {
          if (item.unit_of_measure) additions[item.part_code] = item.unit_of_measure
        }
        if (Object.keys(additions).length > 0) {
          setUnitMap(prev => ({ ...prev, ...additions }))
        }
      })
  }, [materialOverrides])

  // ============================================================
  // 計算批備料行
  // ============================================================
  const materialPrepRows = useMemo<MaterialPrepRow[]>(() => {
    if (!selectedMo || bomRows.length === 0) {
      if (!selectedMo) return []
      // 無 BOM 情況
      const mo = selectedMo
      const productCode = (mo.product_code ?? '').trim()
      const rowKey = `${mo.mo_number}::${productCode}::NO_BOM`
      const makeNoBomRow = (key: string, label: string): MaterialPrepRow => {
        const customCode = materialOverrides[key]
        const customStock = customCode ? (inventoryMap[customCode] ?? 0) : 0
        const displayQty = qtyOverrides[key] !== undefined && qtyOverrides[key] !== '' ? Number(qtyOverrides[key]) : 0
        if (customCode) {
          return {
            row_key: key, mo_number: mo.mo_number, source_order: mo.source_order || '-',
            product_code: productCode || '-', planned_qty: Number(mo.planned_qty ?? 0),
            plate_count: mo.plate_count || '-', factory: mo.factory || '-', machine: mo.machine || '',
            std_qty: 0, unit: '-', is_buffered: false, uses_plate_count: false,
            source_material_code: '-', source_material_name: label, required_qty: displayQty,
            stock_qty: customStock,
            substitute_options: [{ code: customCode, name: customCode, stock_qty: customStock, label: `${customCode}｜自訂｜庫存 ${formatQty(customStock)}` }],
            selected_material_code: customCode, selected_material_name: customCode,
            selected_material_stock_qty: customStock,
            status: displayQty > 0 && customStock >= displayQty ? '可直接備料' : '缺料',
            note: displayQty === 0 ? `${label}，請填寫需求量` : customStock >= displayQty ? `${label}，庫存足夠` : `${label}，庫存不足`,
          }
        }
        return {
          row_key: key, mo_number: mo.mo_number, source_order: mo.source_order || '-',
          product_code: productCode || '-', planned_qty: Number(mo.planned_qty ?? 0),
          plate_count: mo.plate_count || '-', factory: mo.factory || '-', machine: mo.machine || '',
          std_qty: 0, unit: '-', is_buffered: false, uses_plate_count: false,
          source_material_code: '-', source_material_name: key === rowKey ? '查無 BOM' : label,
          required_qty: 0, stock_qty: 0, substitute_options: [],
          selected_material_code: '', selected_material_name: '', selected_material_stock_qty: 0,
          status: '無BOM',
          note: key === rowKey ? '此生產貨號尚未在系統 BOM 表建立對應' : '請輸入料號',
        }
      }
      return [makeNoBomRow(rowKey, '自訂原料'), ...(extraNoBomSlots[rowKey] ?? []).map(slotId => makeNoBomRow(`${rowKey}::EX_${slotId}`, '追加用料'))]
    }

    const mo = selectedMo
    const productCode = (mo.product_code ?? '').trim()
    const matchedBom = bomRows.filter(row => row.product_code === productCode)

    if (matchedBom.length === 0) {
      const rowKey = `${mo.mo_number}::${productCode}::NO_BOM`
      const makeNoBomRow = (key: string, label: string): MaterialPrepRow => {
        const customCode = materialOverrides[key]
        const customStock = customCode ? (inventoryMap[customCode] ?? 0) : 0
        const displayQty = qtyOverrides[key] !== undefined && qtyOverrides[key] !== '' ? Number(qtyOverrides[key]) : 0
        if (customCode) {
          return {
            row_key: key, mo_number: mo.mo_number, source_order: mo.source_order || '-',
            product_code: productCode || '-', planned_qty: Number(mo.planned_qty ?? 0),
            plate_count: mo.plate_count || '-', factory: mo.factory || '-', machine: mo.machine || '',
            std_qty: 0, unit: '-', is_buffered: false, uses_plate_count: false,
            source_material_code: '-', source_material_name: label, required_qty: displayQty,
            stock_qty: customStock,
            substitute_options: [{ code: customCode, name: customCode, stock_qty: customStock, label: `${customCode}｜自訂｜庫存 ${formatQty(customStock)}` }],
            selected_material_code: customCode, selected_material_name: customCode,
            selected_material_stock_qty: customStock,
            status: displayQty > 0 && customStock >= displayQty ? '可直接備料' : '缺料',
            note: displayQty === 0 ? `${label}，請填寫需求量` : customStock >= displayQty ? `${label}，庫存足夠` : `${label}，庫存不足`,
          }
        }
        return {
          row_key: key, mo_number: mo.mo_number, source_order: mo.source_order || '-',
          product_code: productCode || '-', planned_qty: Number(mo.planned_qty ?? 0),
          plate_count: mo.plate_count || '-', factory: mo.factory || '-', machine: mo.machine || '',
          std_qty: 0, unit: '-', is_buffered: false, uses_plate_count: false,
          source_material_code: '-', source_material_name: key === rowKey ? '查無 BOM' : label,
          required_qty: 0, stock_qty: 0, substitute_options: [],
          selected_material_code: '', selected_material_name: '', selected_material_stock_qty: 0,
          status: '無BOM',
          note: key === rowKey ? '此生產貨號尚未在系統 BOM 表建立對應' : '請輸入料號',
        }
      }
      return [makeNoBomRow(rowKey, '自訂原料'), ...(extraNoBomSlots[rowKey] ?? []).map(slotId => makeNoBomRow(`${rowKey}::EX_${slotId}`, '追加用料'))]
    }

    return matchedBom.map((bom): MaterialPrepRow => {
      const rowKey = `${mo.mo_number}::${productCode}::${bom.material_code}`
      const matUpper = (bom.material_code ?? '').toUpperCase()
      const isMacrt = platePrefixes.some(p => matUpper.startsWith(p.toUpperCase()))
      const plateCountNum = (() => {
        const raw = (mo.plate_count ?? '').trim()
        if (!raw || raw === '-') return NaN
        const n = Number(raw)
        return isFinite(n) && n > 0 ? n : NaN
      })()
      const usesPlateCount = isMacrt && !isNaN(plateCountNum)
      const planQty = usesPlateCount ? plateCountNum : Number(mo.planned_qty ?? 0)
      const productionQty = bom.production_quantity ?? 0
      const bomBaseQty = bom.quantity ?? 0
      const baseComputedQty = productionQty > 0 ? (planQty * bomBaseQty) / productionQty : planQty * bomBaseQty
      const shouldBuffer = !usesPlateCount && !noBufferKeys.has(rowKey)
      const computedQty = shouldBuffer ? Math.round(baseComputedQty * 1.03) : baseComputedQty
      const requiredQty = qtyOverrides[rowKey] !== undefined && qtyOverrides[rowKey] !== '' ? Number(qtyOverrides[rowKey]) : computedQty
      const stockQty = inventoryMap[bom.material_code] ?? 0
      const substitutes = substituteMap[bom.material_code] || []
      const substituteOptions: MaterialPrepRow['substitute_options'] = [
        { code: bom.material_code, name: bom.material_name || '-', stock_qty: stockQty, label: `${bom.material_code}｜原料｜庫存 ${formatQty(stockQty)}` },
        ...substitutes.map(rule => {
          const substituteStockQty = inventoryMap[rule.substitute_item_code] ?? 0
          return { code: rule.substitute_item_code, name: rule.substitute_item_code, stock_qty: substituteStockQty, label: `${rule.substitute_item_code}｜替代料 P${rule.priority}｜庫存 ${formatQty(substituteStockQty)}` }
        }),
      ]
      const customOverrideCode = materialOverrides[rowKey]
      if (customOverrideCode && !substituteOptions.find(o => o.code === customOverrideCode)) {
        const customStock = inventoryMap[customOverrideCode] ?? 0
        substituteOptions.push({ code: customOverrideCode, name: customOverrideCode, stock_qty: customStock, label: `${customOverrideCode}｜自訂｜庫存 ${formatQty(customStock)}` })
      }
      const matchedSubstitute = substitutes.find(rule => (inventoryMap[rule.substitute_item_code] ?? 0) >= requiredQty)
      const defaultSelectedCode = stockQty >= requiredQty ? bom.material_code : (matchedSubstitute?.substitute_item_code || bom.material_code)
      const selectedCode = materialOverrides[rowKey] || defaultSelectedCode
      const selectedOption = substituteOptions.find(o => o.code === selectedCode) || substituteOptions[0]
      const selectedStockQty = selectedOption?.stock_qty ?? 0

      let status: MaterialPrepRow['status']
      let note: string
      if (selectedCode === bom.material_code && stockQty >= requiredQty) {
        status = '可直接備料'; note = '庫存足夠，可直接匯入生產批備料'
      } else if (selectedCode !== bom.material_code && selectedStockQty >= requiredQty) {
        status = '建議替代'; note = `原料庫存不足，改用 ${selectedCode} 可支應需求量`
      } else {
        status = '缺料'
        note = selectedCode === bom.material_code
          ? '原料與替代料庫存都不足，匯入批備料前需先補料或調整 BOM'
          : `已改選 ${selectedCode}，但庫存仍不足`
      }

      return {
        row_key: rowKey, mo_number: mo.mo_number, source_order: mo.source_order || '-',
        product_code: productCode, planned_qty: Number(mo.planned_qty ?? 0),
        plate_count: mo.plate_count || '-', factory: mo.factory || '-', machine: mo.machine || '',
        std_qty: productionQty > 0 ? bomBaseQty / productionQty : bomBaseQty,
        source_material_code: bom.material_code, source_material_name: bom.material_name || '-',
        required_qty: requiredQty, is_buffered: shouldBuffer, uses_plate_count: usesPlateCount,
        unit: bom.unit || '-', stock_qty: stockQty, substitute_options: substituteOptions,
        selected_material_code: selectedCode, selected_material_name: selectedOption?.name ?? '-',
        selected_material_stock_qty: selectedStockQty, status, note,
      }
    })
  }, [selectedMo, bomRows, inventoryMap, substituteMap, materialOverrides, qtyOverrides, noBufferKeys, platePrefixes, extraNoBomSlots])

  // ============================================================
  // 可匯入行（已選取 + 庫存足夠 + 非無BOM + 非無需備料）
  // ============================================================
  const selectedImportRows = useMemo(() => {
    return materialPrepRows
      .filter(row => selectedRowKeys.has(row.row_key))
      .filter(row => !noNeedRowKeys.has(row.row_key))
      .filter(row => row.status !== '無BOM')
      .filter(row => row.selected_material_code && row.selected_material_stock_qty >= row.required_qty)
      .map(row => ({
        mo_number: row.mo_number,
        product_code: row.product_code,
        planned_qty: row.planned_qty,
        source_order: row.source_order,
        material_code: row.selected_material_code,
        required_qty: formatQty(row.required_qty),
        unit: unitMap[row.selected_material_code] || row.unit,
        row_key: row.row_key,
        machine: row.machine,
        note: row.source_material_code === row.selected_material_code
          ? '依原 BOM 備料'
          : `替代料：${row.source_material_code} -> ${row.selected_material_code}`,
      }))
  }, [materialPrepRows, selectedRowKeys, noNeedRowKeys, unitMap])

  // ============================================================
  // 匯入批備料
  // ============================================================
  const handleImport = useCallback(async () => {
    if (!selectedMo || selectedImportRows.length === 0 || !ngSlipNo) return
    if (importInFlightRef.current) return
    importInFlightRef.current = true

    if (!window.confirm(`將送出 ${selectedImportRows.length} 筆批備料資料到 ARGO（瑕疵補印）\n\n批備料單號：${ngSlipNo}\n\n確定？`)) {
      importInFlightRef.current = false
      return
    }

    setImporting(true)
    setImportMsg('')

    const today = new Date()
    const slipDate = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`

    const argoData: Record<string, string | number>[] = selectedImportRows.map((row, lineIndex) => ({
      SLIP_NO: ngSlipNo,
      SLIP_DATE: slipDate,
      PJT_PROJECT_ID: row.mo_number,
      SEG_SEGMENT_NO_DEPARTMENT: 'M1100',
      MO_MBP_PART: row.product_code,
      MO_MBP_VER: 1,
      MO_QTY: Number(row.planned_qty),
      LINE_NO: lineIndex + 1,
      MBP_PART: row.material_code,
      MBP_VER: 1,
      NOTICE_QTY: Number(row.required_qty),
      UNIT_OF_MEASURE: row.unit || 'PCS',
      QTY_PACK: '',
      UNIT_OF_MEASURE_PACK: '',
      STD_QTY: 1,
      REMARK: remarkOverrides[row.row_key] !== undefined ? remarkOverrides[row.row_key] : (row.machine || ''),
    }))

    try {
      const response = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId: MATERIAL_PREP_INTERFACE_ID, data: argoData }),
      })
      const result = await response.json()
      const isSuccess = response.ok && result?.success === true
      if (!isSuccess) {
        const errMsg = result?.error || result?.message || result?.apiResult?.ERROR || result?.rawText || '批備料匯入失敗'
        throw new Error(errMsg)
      }

      // 從 ARGO 回傳擷取真實批備料單號（可能與送出的不同）
      const argoResultRows: Record<string, unknown>[] = Array.isArray(result?.apiResult?.RESULT)
        ? (result.apiResult.RESULT as Record<string, unknown>[])
        : []
      const argoSlipNos = [...new Set(
        argoResultRows.map(r => String(r.SLIP_NO ?? '')).filter(s => s && s !== 'undefined')
      )].join(', ')
      const finalSlipNo = argoSlipNos || ngSlipNo

      // 寫入批備料紀錄
      await fetch('/api/argoerp/material-prep-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: [{
            mo_number:    selectedMo.mo_number,
            factory:      selectedMo.factory,
            product_code: selectedMo.product_code ?? '',
            planned_qty:  selectedMo.planned_qty ?? '',
            status:       '已備料',
            lines_count:  selectedImportRows.length,
            interface_id: MATERIAL_PREP_INTERFACE_ID,
            argo_slip_no: finalSlipNo,
          }],
        }),
      }).catch(err => console.warn('[NG批備料紀錄] 寫入失敗', err))

      setImportMsg(`✅ 已成功送出 ${selectedImportRows.length} 筆到 ARGO｜批備料單號：${finalSlipNo}`)

      // 更新 NG 單號（下次再執行時順延）
      const prevNum = parseInt(ngSlipNo.slice(selectedMo.mo_number.length + 2), 10) || 1
      setNgSlipNo(`${selectedMo.mo_number}NG${prevNum + 1}`)
    } catch (e) {
      setImportMsg(`❌ ${e instanceof Error ? e.message : '批備料匯入失敗'}`)
    } finally {
      setImporting(false)
      importInFlightRef.current = false
    }
  }, [selectedMo, selectedImportRows, ngSlipNo, remarkOverrides])

  // ============================================================
  // Render helpers
  // ============================================================
  const toggleRowKey = useCallback((rowKey: string) => {
    setSelectedRowKeys(prev => {
      const next = new Set(prev)
      next.has(rowKey) ? next.delete(rowKey) : next.add(rowKey)
      return next
    })
  }, [])

  const toggleSwapOpen = useCallback((rowKey: string) => {
    setSwapOpenKeys(prev => {
      const next = new Set(prev)
      next.has(rowKey) ? next.delete(rowKey) : next.add(rowKey)
      return next
    })
  }, [])

  const statusBadge = (status: MaterialPrepRow['status']) => {
    const map: Record<MaterialPrepRow['status'], string> = {
      '可直接備料': 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50',
      '建議替代':   'bg-amber-900/50 text-amber-300 border border-amber-700/50',
      '缺料':       'bg-red-900/50 text-red-300 border border-red-700/50',
      '無BOM':      'bg-slate-700/50 text-slate-400 border border-slate-600/50',
    }
    return map[status] ?? ''
  }

  const moPrepBadge = (prep: MoRecord['prep_status']) => {
    if (prep === '已備料') return 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50'
    if (prep === '無需備料') return 'bg-slate-700/50 text-slate-400 border border-slate-600/50'
    return 'bg-amber-900/50 text-amber-300 border border-amber-700/50'
  }

  const allRowKeys = materialPrepRows.map(r => r.row_key)
  const allSelected = allRowKeys.length > 0 && allRowKeys.every(k => selectedRowKeys.has(k))

  // ============================================================
  // Render
  // ============================================================
  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto">

        {/* ── 頁首 ── */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white mb-1">瑕疵補印 → 批備料</h1>
          <p className="text-sm text-slate-400">
            搜尋銷售訂單 → 選擇相關製令 → 建立瑕疵補印批備料單（單號尾碼 NG1 / NG2 ...）
          </p>
        </div>

        {/* ── SO 搜尋 ── */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-cyan-700 text-white text-xs flex items-center justify-center">1</span>
            搜尋銷售訂單
          </h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={soQuery}
              onChange={e => setSoQuery(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter') void handleSearchSo() }}
              placeholder="輸入銷售訂單號碼（如 SO250001）"
              className="flex-1 px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-cyan-500 font-mono uppercase"
            />
            <button
              onClick={() => void handleSearchSo()}
              disabled={soSearching || !soQuery.trim()}
              className="px-5 py-2.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {soSearching ? '搜尋中…' : '搜尋'}
            </button>
          </div>
          {soError && <p className="mt-2 text-sm text-red-400">{soError}</p>}
        </div>

        {/* ── SO 資訊 ── */}
        {soInfo && (
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5 mb-5">
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-700 text-white text-xs flex items-center justify-center">2</span>
                銷售訂單資訊
              </h2>
              <span className="text-xs text-slate-500 font-mono">{soInfo.project_id}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-sm">
              <div>
                <span className="text-slate-500 text-xs">客戶</span>
                <p className="text-white font-medium">{soInfo.partner_name || '-'}</p>
              </div>
              <div>
                <span className="text-slate-500 text-xs">業務</span>
                <p className="text-white">{soInfo.sales_name || '-'}</p>
              </div>
              <div>
                <span className="text-slate-500 text-xs">訂單日期</span>
                <p className="text-white font-mono">{soInfo.begin_date || '-'}</p>
              </div>
              <div>
                <span className="text-slate-500 text-xs">明細行數</span>
                <p className="text-white">{soInfo.lines.length} 行</p>
              </div>
            </div>
            {/* SO 明細表 */}
            <div className="overflow-x-auto rounded-lg border border-slate-700/50">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-800/60 text-slate-400">
                    <th className="px-3 py-2 text-left w-10">行</th>
                    <th className="px-3 py-2 text-left">品名</th>
                    <th className="px-3 py-2 text-left">料號</th>
                    <th className="px-3 py-2 text-right">數量</th>
                    <th className="px-3 py-2 text-left">交期</th>
                    <th className="px-3 py-2 text-left">備註</th>
                  </tr>
                </thead>
                <tbody>
                  {soInfo.lines.map((line, i) => (
                    <tr key={i} className="border-t border-slate-700/30 hover:bg-slate-800/30">
                      <td className="px-3 py-1.5 text-slate-500">{line.line_no ?? i + 1}</td>
                      <td className="px-3 py-1.5 text-slate-200">{line.description || '-'}</td>
                      <td className="px-3 py-1.5 text-cyan-400 font-mono">{line.mbp_part || '-'}</td>
                      <td className="px-3 py-1.5 text-right text-white font-mono">{line.order_qty_oru != null ? `${line.order_qty_oru} ${line.unit_of_measure_oru || ''}` : '-'}</td>
                      <td className="px-3 py-1.5 text-slate-400 font-mono">{line.duedate || '-'}</td>
                      <td className="px-3 py-1.5 text-slate-400">{line.remark || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── 相關製令清單 ── */}
        {soInfo && (
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5 mb-5">
            <h2 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-cyan-700 text-white text-xs flex items-center justify-center">3</span>
              相關製令（{soInfo.project_id}）
              {moLoading && <span className="text-xs text-slate-500 ml-2">載入中…</span>}
            </h2>
            {moList.length === 0 && !moLoading ? (
              <p className="text-sm text-slate-500 italic">此訂單尚無相關製令記錄</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-700/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-800/60 text-slate-400">
                      <th className="px-3 py-2 text-left">製令號</th>
                      <th className="px-3 py-2 text-left">廠別</th>
                      <th className="px-3 py-2 text-left">品號</th>
                      <th className="px-3 py-2 text-right">數量</th>
                      <th className="px-3 py-2 text-left">備料狀態</th>
                      <th className="px-3 py-2 text-left">建立日期</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {moList.map(mo => (
                      <tr
                        key={mo.mo_number}
                        className={`border-t border-slate-700/30 transition-colors ${selectedMo?.mo_number === mo.mo_number ? 'bg-cyan-900/20 border-l-2 border-l-cyan-500' : 'hover:bg-slate-800/30'}`}
                      >
                        <td className="px-3 py-2 text-cyan-400 font-mono font-medium">{mo.mo_number}</td>
                        <td className="px-3 py-2 text-slate-300">{mo.factory || '-'}</td>
                        <td className="px-3 py-2 text-slate-300 font-mono">{mo.product_code || '-'}</td>
                        <td className="px-3 py-2 text-right text-white font-mono">{mo.planned_qty || '-'}</td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs ${moPrepBadge(mo.prep_status)}`}>
                            {mo.prep_status ?? '未備料'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-500 font-mono">{mo.create_date ? mo.create_date.slice(0, 10) : '-'}</td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => void handleSelectMo(mo)}
                            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${selectedMo?.mo_number === mo.mo_number ? 'bg-cyan-700 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
                          >
                            {selectedMo?.mo_number === mo.mo_number ? '✓ 已選取' : '選取'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── 批備料區域 ── */}
        {selectedMo && (
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5 mb-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-cyan-700 text-white text-xs flex items-center justify-center">4</span>
                瑕疵補印批備料
                <span className="ml-2 px-2.5 py-0.5 rounded-full text-xs font-mono bg-cyan-900/40 border border-cyan-700/50 text-cyan-300">
                  {selectedMo.mo_number}
                </span>
              </h2>
              {/* NG 單號 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">批備料單號：</span>
                {ngSlipLoading ? (
                  <span className="text-xs text-slate-500">計算中…</span>
                ) : (
                  <span className="px-3 py-1 rounded-lg bg-rose-900/40 border border-rose-700/50 text-rose-300 text-xs font-mono font-bold">
                    {ngSlipNo || '-'}
                  </span>
                )}
              </div>
            </div>

            {/* MO 資訊列 */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-xs bg-slate-800/40 rounded-lg p-3">
              <div><span className="text-slate-500">廠別</span><p className="text-white font-mono mt-0.5">{selectedMo.factory || '-'}</p></div>
              <div><span className="text-slate-500">品號</span><p className="text-cyan-300 font-mono mt-0.5">{selectedMo.product_code || '-'}</p></div>
              <div><span className="text-slate-500">數量</span><p className="text-white font-mono mt-0.5">{selectedMo.planned_qty || '-'}</p></div>
              <div><span className="text-slate-500">盤數</span><p className="text-white font-mono mt-0.5">{selectedMo.plate_count || '-'}</p></div>
              <div>
                <span className="text-slate-500">機台</span>
                <input
                  type="text"
                  value={selectedMo.machine || ''}
                  onChange={e => setSelectedMo(prev => prev ? { ...prev, machine: e.target.value } : prev)}
                  placeholder="輸入機台"
                  title="將作為每行 ARGO REMARK 預設值"
                  className="block w-full mt-0.5 px-2 py-0.5 rounded bg-slate-800 border border-slate-600 text-white font-mono text-xs focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            {bomLoading ? (
              <div className="py-10 text-center text-slate-500 text-sm">載入 BOM / 庫存中…</div>
            ) : bomError ? (
              <div className="py-6 text-center text-red-400 text-sm">{bomError}</div>
            ) : materialPrepRows.length === 0 ? (
              <div className="py-6 text-center text-slate-500 text-sm">無批備料資料</div>
            ) : (
              <>
                {/* 全選列 */}
                <div className="flex items-center justify-between mb-2 px-1">
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-400 select-none">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => {
                        if (allSelected) setSelectedRowKeys(new Set())
                        else setSelectedRowKeys(new Set(allRowKeys))
                      }}
                      className="w-4 h-4 rounded border-slate-600 accent-cyan-500"
                    />
                    全選（{allRowKeys.length} 行）
                  </label>
                  <span className="text-xs text-slate-500">
                    已選 {selectedRowKeys.size} 行｜可送出 {selectedImportRows.length} 行
                  </span>
                </div>

                {/* 批備料表格 */}
                <div className="overflow-x-auto rounded-lg border border-slate-700/50 mb-4">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-800/60 text-slate-400">
                        <th className="px-2 py-2 w-8"></th>
                        <th className="px-3 py-2 text-left">料號</th>
                        <th className="px-3 py-2 text-left">名稱</th>
                        <th className="px-3 py-2 text-right">需求量</th>
                        <th className="px-3 py-2 text-right">庫存</th>
                        <th className="px-3 py-2 text-left">單位</th>
                        <th className="px-3 py-2 text-left">狀態</th>
                        <th className="px-3 py-2 text-left">換料/備註</th>
                      </tr>
                    </thead>
                    <tbody>
                      {materialPrepRows.map(row => {
                        const isNoNeed = noNeedRowKeys.has(row.row_key)
                        const isSwapOpen = swapOpenKeys.has(row.row_key)
                        return (
                          <>
                            <tr
                              key={row.row_key}
                              className={`border-t border-slate-700/30 ${isNoNeed ? 'opacity-40' : ''} ${selectedRowKeys.has(row.row_key) ? 'bg-slate-800/40' : 'hover:bg-slate-800/20'}`}
                            >
                              <td className="px-2 py-2 text-center">
                                {row.status !== '無BOM' && (
                                  <input
                                    type="checkbox"
                                    checked={selectedRowKeys.has(row.row_key)}
                                    onChange={() => toggleRowKey(row.row_key)}
                                    className="w-4 h-4 rounded border-slate-600 accent-cyan-500"
                                    disabled={isNoNeed}
                                  />
                                )}
                              </td>
                              <td className="px-3 py-2 font-mono text-cyan-400">{row.selected_material_code || row.source_material_code}</td>
                              <td className="px-3 py-2 text-slate-300">{row.selected_material_name || row.source_material_name}</td>
                              <td className="px-3 py-2 text-right font-mono">
                                <input
                                  type="number"
                                  value={qtyOverrides[row.row_key] ?? formatQty(row.required_qty)}
                                  onChange={e => setQtyOverrides(prev => ({ ...prev, [row.row_key]: e.target.value }))}
                                  className="w-20 text-right px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-white text-xs font-mono focus:outline-none focus:border-cyan-500"
                                  min={0}
                                />
                              </td>
                              <td className={`px-3 py-2 text-right font-mono ${row.selected_material_stock_qty >= row.required_qty ? 'text-emerald-400' : 'text-red-400'}`}>
                                {formatQty(row.selected_material_stock_qty)}
                              </td>
                              <td className="px-3 py-2 text-slate-400">{unitMap[row.selected_material_code] || row.unit}</td>
                              <td className="px-3 py-2">
                                <span className={`px-2 py-0.5 rounded-full text-xs ${statusBadge(row.status)}`}>{row.status}</span>
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1.5">
                                  {row.substitute_options.length > 1 && (
                                    <button
                                      onClick={() => toggleSwapOpen(row.row_key)}
                                      className="px-2 py-0.5 rounded text-xs bg-amber-900/40 hover:bg-amber-800/50 text-amber-300 border border-amber-700/40 transition-colors"
                                    >換料</button>
                                  )}
                                  {row.status === '無BOM' && (
                                    <input
                                      type="text"
                                      placeholder="輸入料號"
                                      value={materialOverrides[row.row_key] ?? ''}
                                      onChange={e => setMaterialOverrides(prev => ({ ...prev, [row.row_key]: e.target.value.toUpperCase() }))}
                                      className="w-24 px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-cyan-300 text-xs font-mono uppercase focus:outline-none focus:border-cyan-500"
                                    />
                                  )}
                                  <input
                                    type="text"
                                    placeholder="備註"
                                    value={remarkOverrides[row.row_key] ?? row.machine}
                                    onChange={e => setRemarkOverrides(prev => ({ ...prev, [row.row_key]: e.target.value }))}
                                    className="w-20 px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs focus:outline-none focus:border-slate-500"
                                  />
                                  <button
                                    onClick={() => setNoNeedRowKeys(prev => {
                                      const next = new Set(prev)
                                      next.has(row.row_key) ? next.delete(row.row_key) : next.add(row.row_key)
                                      return next
                                    })}
                                    className={`px-1.5 py-0.5 rounded text-xs transition-colors ${isNoNeed ? 'bg-slate-700 text-slate-400' : 'bg-slate-800 hover:bg-slate-700 text-slate-500 hover:text-slate-300'}`}
                                    title="標記無需備料"
                                  >
                                    {isNoNeed ? '取消' : '無需'}
                                  </button>
                                </div>
                              </td>
                            </tr>
                            {/* 換料展開面板 */}
                            {isSwapOpen && (
                              <tr key={`${row.row_key}::swap`} className="bg-amber-900/10 border-t border-amber-700/20">
                                <td colSpan={8} className="px-4 py-2">
                                  <div className="flex flex-wrap gap-2 items-center">
                                    <span className="text-xs text-amber-400 mr-1">選擇替代料：</span>
                                    {row.substitute_options.map(opt => (
                                      <button
                                        key={opt.code}
                                        onClick={() => {
                                          setMaterialOverrides(prev => ({ ...prev, [row.row_key]: opt.code }))
                                          toggleSwapOpen(row.row_key)
                                        }}
                                        className={`px-3 py-1 rounded-lg text-xs transition-colors ${row.selected_material_code === opt.code ? 'bg-amber-700 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'}`}
                                      >
                                        {opt.label}
                                      </button>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* ── 匯入按鈕 ── */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => void handleImport()}
                      disabled={importing || selectedImportRows.length === 0 || !ngSlipNo || ngSlipLoading}
                      className="px-5 py-2.5 rounded-lg bg-rose-700 hover:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
                    >
                      {importing ? '匯入中…' : `送出 ${selectedImportRows.length} 筆瑕疵補印批備料`}
                    </button>
                    {selectedImportRows.length === 0 && selectedRowKeys.size > 0 && (
                      <span className="text-xs text-amber-400">已選取的行中庫存不足或缺 BOM，無法送出</span>
                    )}
                  </div>
                  {ngSlipNo && !ngSlipLoading && (
                    <span className="text-xs text-slate-400">
                      批備料單號將使用：<span className="text-rose-300 font-mono font-bold ml-1">{ngSlipNo}</span>
                    </span>
                  )}
                </div>

                {/* 匯入結果 */}
                {importMsg && (
                  <div className={`mt-3 px-4 py-3 rounded-lg text-sm ${importMsg.startsWith('✅') ? 'bg-emerald-900/30 border border-emerald-700/50 text-emerald-300' : 'bg-red-900/30 border border-red-700/50 text-red-300'}`}>
                    {importMsg}
                  </div>
                )}
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
