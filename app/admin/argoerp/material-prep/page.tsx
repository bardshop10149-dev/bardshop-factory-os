'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ============================================================
// 型別
// ============================================================
interface MoRecord {
  mo_number: string
  factory: string
  product_code?: string
  lot_number?: string         // 此處實際存放客戶名稱（顯示用）
  planned_qty?: string
  source_order?: string
  mo_note?: string
  create_date?: string
  saved_at?: string
  prep_status?: '未備料' | '已備料' | '無需備料'
  plate_count?: string
}

interface BomRow {
  product_code: string
  product_name: string | null
  production_quantity: number | null
  production_unit: string | null
  note: string | null
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
  customer: string
  source_order: string
  product_code: string
  source_material_code: string
  source_material_name: string
  required_qty: number
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
  std_qty: number
  status: '可直接備料' | '建議替代' | '缺料' | '無BOM'
  note: string
}

interface PrepLog {
  id: number
  mo_number: string
  factory: string | null
  product_code: string | null
  planned_qty: string | null
  status: '已備料' | '無需備料'
  lines_count: number
  interface_id: string | null
  logged_at: string
}

// ============================================================
// 工具
// ============================================================
function formatQty(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '')
}

const PREP_INTERFACE_KEY = 'argoerp_material_prep_interface_id'
const PREP_QTY_OVERRIDES_KEY = 'argoerp_material_prep_qty_overrides'
const PREP_MATERIAL_OVERRIDES_KEY = 'argoerp_material_prep_material_overrides'
const PREP_CUSTOM_CODE_INPUTS_KEY = 'argoerp_material_prep_custom_code_inputs'

function loadFromLocalStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

// ============================================================
// 元件
// ============================================================
export default function MaterialPrepPage() {
  // ---- 製令清單 ----
  const [moRecords, setMoRecords] = useState<MoRecord[]>([])
  const [moLoading, setMoLoading] = useState(false)
  const [moError, setMoError] = useState('')

  // ---- BOM / 庫存 / 替代料 ----
  const [bomRows, setBomRows] = useState<BomRow[]>([])
  const [inventoryMap, setInventoryMap] = useState<Record<string, number>>({})
  const [unitMap, setUnitMap] = useState<Record<string, string>>({})
  const [substituteMap, setSubstituteMap] = useState<Record<string, SubstituteRuleRow[]>>({})
  const [bomLoading, setBomLoading] = useState(false)
  const [bomError, setBomError] = useState('')
  const [materialOverrides, setMaterialOverrides] = useState<Record<string, string>>(
    () => loadFromLocalStorage<Record<string, string>>(PREP_MATERIAL_OVERRIDES_KEY, {})
  )

  // ---- 來源訂單→客戶 map（從 erp_pj_sync 查詢）----
  const [sourceOrderCustomerMap, setSourceOrderCustomerMap] = useState<Record<string, string>>({})

  // ---- 需求量覆寫 / 自訂料號 ----
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, string>>(
    () => loadFromLocalStorage<Record<string, string>>(PREP_QTY_OVERRIDES_KEY, {})
  )
  const [customCodeInputs, setCustomCodeInputs] = useState<Record<string, string>>(
    () => loadFromLocalStorage<Record<string, string>>(PREP_CUSTOM_CODE_INPUTS_KEY, {})
  )
  const [customCodeStocks, setCustomCodeStocks] = useState<Record<string, number | null>>({})

  // ---- 選取 / 操作 ----
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(new Set())
  const [actionMessage, setActionMessage] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [statusFilter, setStatusFilter] = useState<MaterialPrepRow['status'] | null>(null)

  // ---- 檢視模式 ----
  const [viewMode, setViewMode] = useState<'pending' | 'history'>('pending')

  // ---- 上傳紀錄 ----
  const [prepLogs, setPrepLogs] = useState<PrepLog[]>([])
  const [prepLogLoading, setPrepLogLoading] = useState(false)
  const [prepLogError, setPrepLogError] = useState('')
  const [selectedLogIds, setSelectedLogIds] = useState<Set<number>>(new Set())
  const [historyMessage, setHistoryMessage] = useState('')
  const [historyBusy, setHistoryBusy] = useState(false)

  // ---- 批備料介面 ----
  const [materialPrepInterfaceId, setMaterialPrepInterfaceId] = useState('')
  const [materialPrepImporting, setMaterialPrepImporting] = useState(false)
  const [materialPrepMessage, setMaterialPrepMessage] = useState('')
  // 防止雙擊重複送出：useRef 在 React 畫面更新前就能同步擋住第二次點擊
  const importInFlightRef = useRef(false)

  // ---- 同步料件單位 ----
  const [syncingUnits, setSyncingUnits] = useState(false)
  const [syncUnitsMsg, setSyncUnitsMsg] = useState<string | null>(null)

  const handleSyncBomUnits = async () => {
    setSyncingUnits(true)
    setSyncUnitsMsg(null)
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_bom_units' }),
      })
      const json = await res.json() as { status: string; totalFromArgo?: number; upsertedCount?: number; error?: string }
      if (json.status === 'ok') {
        setSyncUnitsMsg(`✅ 同步完成：ARGO 共 ${json.totalFromArgo ?? 0} 筆料號，寫入 ${json.upsertedCount ?? 0} 筆`)
        void loadBomContext()
      } else {
        setSyncUnitsMsg(`❌ ${json.error ?? '同步失敗'}`)
      }
    } catch (e) {
      setSyncUnitsMsg(`❌ ${e instanceof Error ? e.message : '連線錯誤'}`)
    } finally {
      setSyncingUnits(false)
    }
  }

  // ---- 載入暫存 interface id ----
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const saved = localStorage.getItem(PREP_INTERFACE_KEY)
      if (saved) setMaterialPrepInterfaceId(saved)
    } catch {}
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (materialPrepInterfaceId.trim()) localStorage.setItem(PREP_INTERFACE_KEY, materialPrepInterfaceId.trim())
      else localStorage.removeItem(PREP_INTERFACE_KEY)
    } catch {}
  }, [materialPrepInterfaceId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try { localStorage.setItem(PREP_QTY_OVERRIDES_KEY, JSON.stringify(qtyOverrides)) } catch {}
  }, [qtyOverrides])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try { localStorage.setItem(PREP_MATERIAL_OVERRIDES_KEY, JSON.stringify(materialOverrides)) } catch {}
  }, [materialOverrides])

  // 手動選取/輸入的料號不在 loadBomContext 的 allInventoryCodes 內，需額外補查單位
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
          setUnitMap(prev => {
            const changed = Object.entries(additions).some(([k, v]) => prev[k] !== v)
            return changed ? { ...prev, ...additions } : prev
          })
        }
      })
  }, [materialOverrides])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try { localStorage.setItem(PREP_CUSTOM_CODE_INPUTS_KEY, JSON.stringify(customCodeInputs)) } catch {}
  }, [customCodeInputs])

  // ---- 載入未備料製令 ----
  const loadMoRecords = useCallback(async () => {
    setMoLoading(true)
    setMoError('')
    try {
      const res = await fetch('/api/argoerp/mo-summary?prep_status=未備料', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `HTTP ${res.status}`)
      }
      const records: MoRecord[] = json.records ?? []
      setMoRecords(records)
      // 重置選取（保留仍存在的製令的行）
      setSelectedRowKeys(prev => {
        const stillMoNumbers = new Set(records.map(r => r.mo_number))
        return new Set([...prev].filter(key => stillMoNumbers.has(key.split('::')[0])))
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setMoError(msg)
    } finally {
      setMoLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadMoRecords()
  }, [loadMoRecords])

  // ---- 載入上傳紀錄 ----
  const loadPrepLogs = useCallback(async () => {
    setPrepLogLoading(true)
    setPrepLogError('')
    try {
      const res = await fetch('/api/argoerp/material-prep-log', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`)
      setPrepLogs(json.rows ?? [])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setPrepLogError(msg)
    } finally {
      setPrepLogLoading(false)
    }
  }, [])

  useEffect(() => {
    if (viewMode === 'history') void loadPrepLogs()
    if (viewMode === 'pending') void loadMoRecords()
  }, [viewMode, loadPrepLogs, loadMoRecords])

  // ---- 載入 BOM / 庫存 / 替代料 ----
  const loadBomContext = useCallback(async () => {
    const productCodes = Array.from(new Set(moRecords.map(r => (r.product_code ?? '').trim()).filter(Boolean)))
    if (productCodes.length === 0) {
      setBomRows([])
      setInventoryMap({})
      setUnitMap({})
      setSubstituteMap({})
      setBomError('')
      return
    }

    setBomLoading(true)
    setBomError('')

    try {
      const { data: bomData, error: bomDataError } = await supabase
        .from('bom')
        .select('product_code, product_name, production_quantity, production_unit, note, material_code, material_name, quantity, unit')
        .in('product_code', productCodes)

      if (bomDataError) throw bomDataError

      const rows = (bomData as BomRow[] | null) || []
      const materialCodes = Array.from(new Set(rows.map(row => row.material_code).filter(Boolean)))

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

      const allInventoryCodes = Array.from(new Set([
        ...materialCodes,
        ...(((substituteData as SubstituteRuleRow[] | null) || []).map(row => row.substitute_item_code).filter(Boolean)),
      ]))

      let nextInventoryMap: Record<string, number> = {}
      let nextUnitMap: Record<string, string> = {}
      if (allInventoryCodes.length > 0) {
        const [inventoryRes, unitRes] = await Promise.all([
          supabase
            .from('erp_pj_sync')
            .select('doc_no, qty')
            .eq('doc_type', '倉庫庫存')
            .in('doc_no', allInventoryCodes),
          supabase
            .from('mm_bom_part_units')
            .select('part_code, unit_of_measure')
            .in('part_code', allInventoryCodes),
        ])

        if (inventoryRes.error) throw inventoryRes.error

        nextInventoryMap = ((inventoryRes.data as Array<{ doc_no: string; qty: number }> | null) || []).reduce<Record<string, number>>((acc, item) => {
          acc[item.doc_no] = Number(item.qty) || 0
          return acc
        }, {})

        nextUnitMap = ((unitRes.data as Array<{ part_code: string; unit_of_measure: string | null }> | null) || []).reduce<Record<string, string>>((acc, item) => {
          if (item.unit_of_measure) acc[item.part_code] = item.unit_of_measure
          return acc
        }, {})
      }

      setBomRows(rows)
      setSubstituteMap(groupedSubstitutes)
      setInventoryMap(nextInventoryMap)
      setUnitMap(nextUnitMap)

      // ---- 查詢來源訂單的客戶名稱（從 erp_so_lines 取 partner_name）----
      const sourceOrders = Array.from(new Set(moRecords.map(r => (r.source_order ?? '').trim()).filter(Boolean)))
      if (sourceOrders.length > 0) {
        const { data: soData } = await supabase
          .from('erp_so_lines')
          .select('project_id, partner_name')
          .in('project_id', sourceOrders)
        const soMap: Record<string, string> = {}
        ;((soData as Array<{ project_id: string; partner_name: string | null }> | null) || []).forEach(row => {
          if (row.partner_name && !soMap[row.project_id]) soMap[row.project_id] = row.partner_name
        })
        setSourceOrderCustomerMap(soMap)
      } else {
        setSourceOrderCustomerMap({})
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '讀取 BOM / 庫存資料失敗'
      setBomError(message)
    } finally {
      setBomLoading(false)
    }
  }, [moRecords])

  useEffect(() => {
    void loadBomContext()
  }, [loadBomContext])

  // ---- 計算批備料行 ----
  const materialPrepRows = useMemo<MaterialPrepRow[]>(() => {
    if (moRecords.length === 0) return []
    return moRecords.flatMap((mo): MaterialPrepRow[] => {
      const productCode = (mo.product_code ?? '').trim()
      const matchedBom = bomRows.filter(row => row.product_code === productCode)
    if (matchedBom.length === 0) {
        const rowKey = `${mo.mo_number}::${productCode}::NO_BOM`
        const customCode = materialOverrides[rowKey]
        const customStock = customCode ? (inventoryMap[customCode] ?? 0) : 0
        const displayQty = qtyOverrides[rowKey] !== undefined && qtyOverrides[rowKey] !== '' ? Number(qtyOverrides[rowKey]) : 0
        if (customCode) {
          return [{
            row_key: rowKey,
            mo_number: mo.mo_number,
            customer: sourceOrderCustomerMap[mo.source_order ?? ''] || '-',
            source_order: mo.source_order || '-',
            product_code: productCode || '-',
            planned_qty: Number(mo.planned_qty ?? 0),
            plate_count: mo.plate_count || '-',
            factory: mo.factory || '-',
            std_qty: 0,
            source_material_code: '-',
            source_material_name: '自訂原料',
            required_qty: displayQty,
            unit: '-',
            stock_qty: customStock,
            substitute_options: [{ code: customCode, name: customCode, stock_qty: customStock, label: `${customCode}｜自訂｜庫存 ${formatQty(customStock)}` }],
            selected_material_code: customCode,
            selected_material_name: customCode,
            selected_material_stock_qty: customStock,
            status: displayQty > 0 && customStock >= displayQty ? '可直接備料' : '缺料',
            note: displayQty === 0 ? '自訂原料，請填寫需求量' : customStock >= displayQty ? '自訂原料，庫存足夠' : '自訂原料，庫存不足',
          }]
        }
        return [{
          row_key: rowKey,
          mo_number: mo.mo_number,
          customer: sourceOrderCustomerMap[mo.source_order ?? ''] || '-',
          source_order: mo.source_order || '-',
          product_code: productCode || '-',
          planned_qty: Number(mo.planned_qty ?? 0),
          plate_count: mo.plate_count || '-',
          factory: mo.factory || '-',
          std_qty: 0,
          source_material_code: '-',
          source_material_name: '查無 BOM',
          required_qty: 0,
          unit: '-',
          stock_qty: 0,
          substitute_options: [],
          selected_material_code: '',
          selected_material_name: '',
          selected_material_stock_qty: 0,
          status: '無BOM',
          note: '此生產貨號尚未在系統 BOM 表建立對應',
        }]
      }

      return matchedBom.map((bom): MaterialPrepRow => {
        const rowKey = `${mo.mo_number}::${productCode}::${bom.material_code}`
        const plateCountRaw = mo.plate_count ? mo.plate_count.trim() : ''
        const plateCountNum = plateCountRaw && plateCountRaw !== '-' ? Number(plateCountRaw) : NaN
        const planQty = !isNaN(plateCountNum) && plateCountNum > 0 ? plateCountNum : Number(mo.planned_qty ?? 0)
        const productionQty = bom.production_quantity ?? 0
        const bomBaseQty = bom.quantity ?? 0
        const computedQty = productionQty > 0 ? (planQty * bomBaseQty) / productionQty : planQty * bomBaseQty
        const requiredQty = qtyOverrides[rowKey] !== undefined && qtyOverrides[rowKey] !== '' ? Number(qtyOverrides[rowKey]) : computedQty
        const stockQty = inventoryMap[bom.material_code] ?? 0
        const substitutes = substituteMap[bom.material_code] || []
        const substituteOptions: MaterialPrepRow['substitute_options'] = [
          {
            code: bom.material_code,
            name: bom.material_name || '-',
            stock_qty: stockQty,
            label: `${bom.material_code}｜原料｜庫存 ${formatQty(stockQty)}`,
          },
          ...substitutes.map(rule => {
            const substituteBomRow = bomRows.find(item => item.material_code === rule.substitute_item_code)
            const substituteName = substituteBomRow?.material_name || rule.substitute_item_code
            const substituteStockQty = inventoryMap[rule.substitute_item_code] ?? 0
            return {
              code: rule.substitute_item_code,
              name: substituteName,
              stock_qty: substituteStockQty,
              label: `${rule.substitute_item_code}｜替代料 P${rule.priority}｜庫存 ${formatQty(substituteStockQty)}`,
            }
          }),
        ]
        // 若有自訂料號覆寫但不在選項中，加入下拉
        const customOverrideCode = materialOverrides[rowKey]
        if (customOverrideCode && !substituteOptions.find(o => o.code === customOverrideCode)) {
          const customStock = inventoryMap[customOverrideCode] ?? 0
          substituteOptions.push({ code: customOverrideCode, name: customOverrideCode, stock_qty: customStock, label: `${customOverrideCode}｜自訂｜庫存 ${formatQty(customStock)}` })
        }
        const matchedSubstitute = substitutes.find(rule => (inventoryMap[rule.substitute_item_code] ?? 0) >= requiredQty)
        const defaultSelectedCode = stockQty >= requiredQty ? bom.material_code : (matchedSubstitute?.substitute_item_code || bom.material_code)
        const selectedCode = materialOverrides[rowKey] || defaultSelectedCode
        const selectedOption = substituteOptions.find(option => option.code === selectedCode) || substituteOptions[0]
        const selectedStockQty = selectedOption?.stock_qty ?? 0
        const selectedName = selectedOption?.name ?? '-'

        let status: MaterialPrepRow['status']
        let note: string
        if (selectedCode === bom.material_code && stockQty >= requiredQty) {
          status = '可直接備料'
          note = '庫存足夠，可直接匯入生產批備料'
        } else if (selectedCode !== bom.material_code && selectedStockQty >= requiredQty) {
          status = '建議替代'
          note = `原料庫存不足，改用 ${selectedCode} 可支應需求量`
        } else {
          status = '缺料'
          note = selectedCode === bom.material_code
            ? '原料與替代料庫存都不足，匯入批備料前需先補料或調整 BOM'
            : `已改選 ${selectedCode}，但庫存仍不足`
        }

        return {
          row_key: rowKey,
          mo_number: mo.mo_number,
          customer: sourceOrderCustomerMap[mo.source_order ?? ''] || '-',
          source_order: mo.source_order || '-',
          product_code: productCode,
          planned_qty: planQty,
          plate_count: mo.plate_count || '-',
          factory: mo.factory || '-',
          std_qty: productionQty > 0 ? bomBaseQty / productionQty : bomBaseQty,
          source_material_code: bom.material_code,
          source_material_name: bom.material_name || '-',
          required_qty: requiredQty,
          unit: bom.unit || '-',
          stock_qty: stockQty,
          substitute_options: substituteOptions,
          selected_material_code: selectedCode,
          selected_material_name: selectedName,
          selected_material_stock_qty: selectedStockQty,
          status,
          note,
        }
      })
    })
  }, [moRecords, bomRows, inventoryMap, substituteMap, materialOverrides, qtyOverrides, sourceOrderCustomerMap])

  const materialPrepSummary = useMemo(() => {
    return materialPrepRows.reduce<Record<MaterialPrepRow['status'], number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1
      return acc
    }, { 可直接備料: 0, 建議替代: 0, 缺料: 0, 無BOM: 0 })
  }, [materialPrepRows])

  // 篩選後的表格資料
  const filteredPrepRows = useMemo(() => {
    if (!statusFilter) return materialPrepRows
    return materialPrepRows.filter(row => row.status === statusFilter)
  }, [materialPrepRows, statusFilter])

  // 將「選取的料號行」轉為可送 ARGO 的批備料行
  const selectedImportRows = useMemo(() => {
    return materialPrepRows
      .filter(row => selectedRowKeys.has(row.row_key))
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
        note: row.source_material_code === row.selected_material_code
          ? '依原 BOM 備料'
          : `替代料：${row.source_material_code} -> ${row.selected_material_code}`,
      }))
  }, [materialPrepRows, selectedRowKeys, unitMap])

  // ---- 操作：勾選 ----
  const handleSelectMaterialOverride = useCallback((rowKey: string, materialCode: string) => {
    setMaterialOverrides(prev => ({ ...prev, [rowKey]: materialCode }))
  }, [])

  const toggleRow = useCallback((rowKey: string) => {
    setSelectedRowKeys(prev => {
      const next = new Set(prev)
      if (next.has(rowKey)) next.delete(rowKey)
      else next.add(rowKey)
      return next
    })
  }, [])

  const handleQtyChange = useCallback((rowKey: string, val: string) => {
    setQtyOverrides(prev => ({ ...prev, [rowKey]: val }))
  }, [])

  const handleLookupCustomCode = useCallback(async (rowKey: string) => {
    const code = (customCodeInputs[rowKey] ?? '').trim()
    if (!code) return
    try {
      const { data } = await supabase
        .from('erp_pj_sync')
        .select('doc_no, qty')
        .eq('doc_type', '倉庫庫存')
        .eq('doc_no', code)
        .limit(1)
      if (data && data.length > 0) {
        const qty = Number((data[0] as { doc_no: string; qty: number }).qty) || 0
        setInventoryMap(prev => ({ ...prev, [code]: qty }))
        setCustomCodeStocks(prev => ({ ...prev, [rowKey]: qty }))
        setMaterialOverrides(prev => ({ ...prev, [rowKey]: code }))
      } else {
        setCustomCodeStocks(prev => ({ ...prev, [rowKey]: null }))
      }
    } catch {
      setCustomCodeStocks(prev => ({ ...prev, [rowKey]: null }))
    }
  }, [customCodeInputs])

  // ---- 操作：標記為「無需備料」----
  const handleMarkNoNeed = useCallback(async () => {
    if (selectedRowKeys.size === 0) return
    const moNumbers = [...new Set(materialPrepRows.filter(r => selectedRowKeys.has(r.row_key)).map(r => r.mo_number))]
    if (!window.confirm(`確定將 ${moNumbers.length} 筆製令標記為「無需備料」？\n（總表狀態會改為已備料但實際不執行批備料）`)) return

    setActionBusy(true)
    setActionMessage('')
    try {
      const res = await fetch('/api/argoerp/mo-summary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mo_numbers: moNumbers, prep_status: '無需備料' }),
      })
      const json = await res.json()
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`)
      setActionMessage(`✅ 已將 ${json.updated ?? moNumbers.length} 筆標記為「無需備料」`)

      // 寫入批備料紀錄（fire-and-forget）
      fetch('/api/argoerp/material-prep-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: moNumbers.map(mo => ({
            mo_number:    mo,
            factory:      moRecords.find(r => r.mo_number === mo)?.factory      ?? '',
            product_code: moRecords.find(r => r.mo_number === mo)?.product_code ?? '',
            planned_qty:  moRecords.find(r => r.mo_number === mo)?.planned_qty  ?? '',
            status:       '無需備料',
            lines_count:  0,
            interface_id: '',
          })),
        }),
      }).catch(err => console.warn('[批備料紀錄] 寫入失敗', err))

      await loadMoRecords()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setActionMessage(`❌ 標記失敗：${msg}`)
    } finally {
      setActionBusy(false)
      setTimeout(() => setActionMessage(''), 6000)
    }
  }, [selectedRowKeys, materialPrepRows, loadMoRecords])

  // ---- 操作：從紀錄重設為未備料（可再次上傳）----
  const handleResetToPending = useCallback(async () => {
    if (selectedLogIds.size === 0) return
    const moNumbers = [...new Set(
      [...selectedLogIds]
        .map(id => prepLogs.find(l => l.id === id)?.mo_number)
        .filter((v): v is string => Boolean(v))
    )]
    if (!window.confirm(`確定將 ${moNumbers.length} 筆製令重設為「未備料」，讓其重新出現在備料清單可再次上傳？`)) return
    setHistoryBusy(true)
    setHistoryMessage('')
    try {
      const res = await fetch('/api/argoerp/mo-summary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mo_numbers: moNumbers, prep_status: '未備料' }),
      })
      const json = await res.json()
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`)
      setHistoryMessage(`✅ 已重設 ${json.updated ?? moNumbers.length} 筆為「未備料」，切換至備料清單即可重新上傳`)
      setSelectedLogIds(new Set())
      void loadPrepLogs()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setHistoryMessage(`❌ 失敗：${msg}`)
    } finally {
      setHistoryBusy(false)
      setTimeout(() => setHistoryMessage(''), 8000)
    }
  }, [selectedLogIds, prepLogs, loadPrepLogs])

  // ---- 操作：送 ARGO 批備料 + 標記為「已備料」----
  const handleImportAndMarkDone = useCallback(async () => {
    if (selectedRowKeys.size === 0) return
    // ── 防止雙擊：同步 ref 在 React re-render 之前就能攔截第二次點擊 ──
    if (importInFlightRef.current) return
    importInFlightRef.current = true

    if (!materialPrepInterfaceId.trim()) {
      setMaterialPrepMessage('❌ 請先輸入批備料匯入的 ARGO 介面編號')
      importInFlightRef.current = false
      return
    }
    if (selectedImportRows.length === 0) {
      setMaterialPrepMessage('❌ 選取的製令中沒有可匯入的批備料資料（請檢查缺料或無 BOM 狀態）')
      importInFlightRef.current = false
      return
    }

    const importMos = Array.from(new Set(selectedImportRows.map(r => r.mo_number)))

    // ── 預飛檢查：確認選取的製令在 mo-summary 中確實仍是未備料狀態 ──
    try {
      const { data: summaryRows, error: checkErr } = await supabase
        .from('argoerp_mo_summary')
        .select('mo_number, prep_status')
        .in('mo_number', importMos)
      if (checkErr) throw checkErr

      const alreadyDone = (summaryRows ?? [])
        .filter(r => r.prep_status === '已備料' || r.prep_status === '無需備料')
        .map(r => r.mo_number as string)

      if (alreadyDone.length > 0) {
        const doAnyway = window.confirm(
          `⚠️ 以下 ${alreadyDone.length} 筆製令已標記為「已備料 / 無需備料」，\n若繼續送出將造成 ARGO 重複備料（數量加倍）：\n\n${alreadyDone.join('\n')}\n\n確定要繼續送出嗎？（建議點「取消」）`
        )
        if (!doAnyway) {
          importInFlightRef.current = false
          return
        }
      }
    } catch {
      // 查詢失敗不阻斷主流程，但記錄警告
      console.warn('[批備料] 預飛狀態檢查失敗，繼續執行')
    }

    if (!window.confirm(`將送出 ${selectedImportRows.length} 筆批備料資料到 ARGO（涵蓋 ${importMos.length} 筆製令），完成後將這些製令標記為「已備料」。確定？`)) {
      importInFlightRef.current = false
      return
    }

    setMaterialPrepImporting(true)
    setMaterialPrepMessage('')

    // 組 ARGO IV_NOTICE_PREPARE_INTERFACE 格式
    const today = new Date()
    const slipDate = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`
    const moGroups = new Map<string, typeof selectedImportRows>()
    for (const row of selectedImportRows) {
      if (!moGroups.has(row.mo_number)) moGroups.set(row.mo_number, [])
      moGroups.get(row.mo_number)!.push(row)
    }
    const argoData: Record<string, string | number>[] = []
    for (const [moNumber, rows] of moGroups) {
      rows.forEach((row, lineIndex) => {
        argoData.push({
          SLIP_NO: moNumber,
          SLIP_DATE: slipDate,
          PJT_PROJECT_ID: moNumber,
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
        })
      })
    }

    try {
      const response = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'import',
          interfaceId: materialPrepInterfaceId.trim(),
          data: argoData,
        }),
      })

      const result = await response.json()
      const errorMessage =
        result?.error ||
        result?.message ||
        result?.apiResult?.ERROR ||
        result?.apiResult?.error ||
        result?.rawText
      const isSuccess = response.ok && result?.success === true
      if (!isSuccess) throw new Error(errorMessage || '生產批備料匯入失敗')

      // 更新狀態為「已備料」
      const patchRes = await fetch('/api/argoerp/mo-summary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mo_numbers: importMos, prep_status: '已備料' }),
      })
      const patchJson = await patchRes.json()
      if (!patchRes.ok || !patchJson?.success) {
        throw new Error(`ARGO 已匯入成功但更新狀態失敗：${patchJson?.error || `HTTP ${patchRes.status}`}\n請手動將以下製令標為已備料：${importMos.join(', ')}`)
      }

      const argoRaw = result?.rawText ? `\nARGO 回應：${result.rawText}` : ''
      setMaterialPrepMessage(`✅ 已送出 ${selectedImportRows.length} 筆到 ARGO，並將 ${importMos.length} 筆製令標記為「已備料」${argoRaw}`)

      // 寫入批備料紀錄（fire-and-forget）
      fetch('/api/argoerp/material-prep-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: importMos.map(mo => ({
            mo_number:    mo,
            factory:      moRecords.find(r => r.mo_number === mo)?.factory      ?? '',
            product_code: moRecords.find(r => r.mo_number === mo)?.product_code ?? '',
            planned_qty:  moRecords.find(r => r.mo_number === mo)?.planned_qty  ?? '',
            status:       '已備料',
            lines_count:  selectedImportRows.filter(r => r.mo_number === mo).length,
            interface_id: materialPrepInterfaceId.trim(),
          })),
        }),
      }).catch(err => console.warn('[批備料紀錄] 寫入失敗', err))

      await loadMoRecords()
    } catch (error) {
      const message = error instanceof Error ? error.message : '生產批備料匯入失敗'
      setMaterialPrepMessage(`❌ ${message}`)
    } finally {
      setMaterialPrepImporting(false)
      importInFlightRef.current = false
    }
  }, [selectedRowKeys, selectedImportRows, materialPrepRows, materialPrepInterfaceId, loadMoRecords])

  // ============================================================
  // Render
  // ============================================================
  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1800px] mx-auto">
        <div className="mb-4 border-b border-slate-800 pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">生產批備料</h1>
            <p className="text-slate-400 mt-1 text-sm">
              自動列出製令總表中「未備料」的製令，比對系統 BOM / 替代料 / 物料庫存後可送 ARGO 批備料或標記為無需備料。
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={() => void handleSyncBomUnits()}
                disabled={syncingUnits}
                className="px-4 py-2 rounded-lg bg-amber-800 border border-amber-600 text-amber-100 hover:bg-amber-700 disabled:opacity-50 transition-colors text-sm"
              >
                {syncingUnits ? '⏳ 同步中...' : '⚙️ 同步料件單位'}
              </button>
              {syncUnitsMsg && <p className="text-xs text-slate-400 max-w-xs text-right">{syncUnitsMsg}</p>}
            </div>
            <button
              onClick={() => viewMode === 'pending' ? void loadMoRecords() : void loadPrepLogs()}
              disabled={viewMode === 'pending' ? moLoading : prepLogLoading}
              className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 disabled:opacity-50 transition-colors text-sm"
            >
              {(viewMode === 'pending' ? moLoading : prepLogLoading) ? '讀取中...' : '🔄 重新整理'}
            </button>
          </div>
        </div>

        {/* Tab 切換 */}
        <div className="mb-6 flex gap-1 border-b border-slate-800">
          <button
            onClick={() => setViewMode('pending')}
            className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              viewMode === 'pending'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            📋 未備料清單
            {moRecords.length > 0 && <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-slate-700 text-slate-300">{moRecords.length}</span>}
          </button>
          <button
            onClick={() => setViewMode('history')}
            className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              viewMode === 'history'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            📜 上傳紀錄
            {prepLogs.length > 0 && <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-slate-700 text-slate-300">{prepLogs.length}</span>}
          </button>
        </div>

        {viewMode === 'pending' && (<>
        {/* 流程狀態 */}
        <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-4">
          <h2 className="text-lg font-semibold text-white mb-3">流程狀態</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <span className="text-slate-400">未備料製令</span>
              <span className="text-cyan-300 font-semibold">{moRecords.length} 筆</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <span className="text-slate-400">BOM 比對</span>
              <span className="text-cyan-300 font-semibold">{bomLoading ? '讀取中' : `${materialPrepRows.length} 筆`}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <span className="text-slate-400">已選取</span>
              <span className="text-orange-300 font-semibold">{selectedRowKeys.size} 筆</span>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            {([
              { status: '可直接備料' as const, bg: 'bg-emerald-950/30', border: 'border-emerald-800/30', text: 'text-emerald-300', activeBg: 'bg-emerald-800/60', activeBorder: 'border-emerald-500/60' },
              { status: '建議替代' as const, bg: 'bg-amber-950/30', border: 'border-amber-800/30', text: 'text-amber-300', activeBg: 'bg-amber-800/60', activeBorder: 'border-amber-500/60' },
              { status: '缺料' as const, bg: 'bg-red-950/30', border: 'border-red-800/30', text: 'text-red-300', activeBg: 'bg-red-800/60', activeBorder: 'border-red-500/60' },
              { status: '無BOM' as const, bg: 'bg-slate-950/60', border: 'border-slate-800', text: 'text-slate-300', activeBg: 'bg-slate-700/60', activeBorder: 'border-slate-500/60' },
            ]).map(({ status, bg, border, text, activeBg, activeBorder }) => {
              const active = statusFilter === status
              return (
                <button
                  key={status}
                  onClick={() => setStatusFilter(active ? null : status)}
                  className={`rounded-lg px-3 py-2 text-left transition-all border ${active ? `${activeBg} ${activeBorder}` : `${bg} ${border}`} ${text} hover:brightness-125`}
                >
                  <span className="font-medium">{status === '無BOM' ? '查無 BOM' : status}</span>
                  <span className="ml-2 font-mono">{materialPrepSummary[status]}</span>
                  {active && <span className="ml-2 text-[10px] opacity-70">✕ 清除</span>}
                </button>
              )
            })}
          </div>
        </div>

        {/* 操作區 */}
        <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">批備料 ARGO 介面編號</label>
              <input
                value={materialPrepInterfaceId}
                onChange={e => setMaterialPrepInterfaceId(e.target.value)}
                placeholder="例如 IFAF0XX"
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">說明</label>
              <div className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-400 leading-relaxed min-h-[42px] flex items-center">
                勾選製令後可批量「送 ARGO 批備料」或「標記為無需備料」。庫存只從 Supabase material_inventory_list 讀取，請另行於物料總表頁同步 ARGO 庫存。
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-300">
              選取 {selectedRowKeys.size} 筆｜可送批備料 {selectedImportRows.length} 筆料號
            </span>
            <button
              onClick={() => void handleImportAndMarkDone()}
              disabled={materialPrepImporting || actionBusy || selectedRowKeys.size === 0}
              className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
            >
              {materialPrepImporting ? '匯入中...' : '送 ARGO 批備料 + 標為已備料'}
            </button>
            <button
              onClick={() => void handleMarkNoNeed()}
              disabled={actionBusy || materialPrepImporting || selectedRowKeys.size === 0}
              className="px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
            >
              {actionBusy ? '處理中...' : '標記為「無需備料」'}
            </button>
          </div>
          {materialPrepMessage && (
            <p className={`text-sm whitespace-pre-line ${materialPrepMessage.startsWith('❌') ? 'text-red-300' : 'text-emerald-300'}`}>
              {materialPrepMessage}
            </p>
          )}
          {actionMessage && (
            <p className={`text-sm ${actionMessage.startsWith('❌') ? 'text-red-300' : 'text-emerald-300'}`}>
              {actionMessage}
            </p>
          )}
        </div>

        {/* 製令清單 + BOM 表 */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          {moLoading ? (
            <div className="px-4 py-10 text-center text-slate-400 text-sm">未備料製令讀取中...</div>
          ) : moError ? (
            <div className="px-4 py-10 text-center text-red-300 text-sm">{moError}</div>
          ) : moRecords.length === 0 ? (
            <div className="px-4 py-10 text-center text-slate-500 text-sm">目前沒有未備料的製令</div>
          ) : bomLoading ? (
            <div className="px-4 py-10 text-center text-slate-400 text-sm">BOM / 替代料 / 庫存資料讀取中...</div>
          ) : bomError ? (
            <div className="px-4 py-10 text-center text-red-300 text-sm">{bomError}</div>
          ) : (
            <div className="overflow-x-auto">              {statusFilter && (
                <div className="px-4 py-2 bg-slate-800/50 border-b border-slate-700/50 flex items-center gap-2 text-xs text-slate-400">
                  <span>篩選中：</span>
                  <span className="px-2 py-0.5 rounded-full bg-slate-700 text-slate-200">{statusFilter === '無BOM' ? '查無 BOM' : statusFilter}</span>
                  <span>共 {filteredPrepRows.length} 筆</span>
                  <button onClick={() => setStatusFilter(null)} className="ml-auto text-slate-500 hover:text-white transition-colors">✕ 取消篩選</button>
                </div>
              )}              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/80 border-b border-slate-700">
                    <th className="px-2 py-3 text-center sticky left-0 bg-slate-800/80 z-10 w-10">
                      <input
                        type="checkbox"
                        checked={filteredPrepRows.length > 0 && filteredPrepRows.every(r => selectedRowKeys.has(r.row_key))}
                        onChange={() => {
                          const allSelected = filteredPrepRows.every(r => selectedRowKeys.has(r.row_key))
                          setSelectedRowKeys(prev => {
                            const next = new Set(prev)
                            if (allSelected) filteredPrepRows.forEach(r => next.delete(r.row_key))
                            else filteredPrepRows.forEach(r => next.add(r.row_key))
                            return next
                          })
                        }}
                        className="rounded border-slate-600 bg-slate-700 text-cyan-500 focus:ring-cyan-500/30"
                      />
                    </th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">製令單號 / 客戶</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">生產貨號 / 預定產出量</th>
                    <th className="px-3 py-3 text-right text-slate-300 text-xs whitespace-nowrap">映射盤數</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">原料料號 / 原料名稱</th>
                    <th className="px-3 py-3 text-right text-slate-300 text-xs whitespace-nowrap">需求量</th>
                    <th className="px-3 py-3 text-right text-slate-300 text-xs whitespace-nowrap">現有庫存</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">使用料號</th>
                    <th className="px-3 py-3 text-center text-slate-300 text-xs whitespace-nowrap">ARGO 單位</th>
                    <th className="px-3 py-3 text-right text-slate-300 text-xs whitespace-nowrap">選用庫存</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">狀態</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">說明</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPrepRows.map((row, index) => {
                    const checked = selectedRowKeys.has(row.row_key)
                    return (
                      <tr key={`${row.row_key}-${index}`} className={`border-b border-slate-800/50 ${checked ? 'bg-cyan-950/30' : index % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/20'} hover:bg-slate-800/40`}>
                        <td className="px-2 py-2 text-center sticky left-0 bg-inherit z-10">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRow(row.row_key)}
                            className="rounded border-slate-600 bg-slate-700 text-cyan-500 focus:ring-cyan-500/30"
                          />
                        </td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap">
                          <div className="text-cyan-300 font-mono">{row.mo_number}</div>
                          <div className="text-slate-400 truncate max-w-[180px]" title={row.customer}>
                            {row.customer !== '-' ? row.customer : <span className="text-slate-600 italic">查無客戶</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap">
                          <div className="text-slate-300">{row.product_code}</div>
                          <div className="text-slate-400 font-mono">{formatQty(row.planned_qty)}</div>
                        </td>
                        <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                          <span className="text-slate-300 font-mono">{row.plate_count}</span>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <div className="text-slate-300 whitespace-nowrap">{row.source_material_code}</div>
                          <div className="text-slate-400 truncate max-w-[200px]" title={row.source_material_name}>{row.source_material_name}</div>
                        </td>
                        <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={qtyOverrides[row.row_key] !== undefined ? qtyOverrides[row.row_key] : formatQty(row.required_qty)}
                              onChange={e => handleQtyChange(row.row_key, e.target.value)}
                              className="w-20 text-right bg-slate-950/60 border border-slate-700/60 rounded px-1 py-0.5 text-slate-300 focus:outline-none focus:border-cyan-500/50 text-xs"
                            />
                            <span className="text-slate-500 text-xs">{row.unit}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right text-slate-300 text-xs whitespace-nowrap">{formatQty(row.stock_qty)}</td>
                        <td className="px-3 py-2 text-xs min-w-[260px]">
                          {row.status !== '無BOM' && (
                            <select
                              value={row.selected_material_code}
                              onChange={e => handleSelectMaterialOverride(row.row_key, e.target.value)}
                              className="w-full px-2.5 py-1.5 rounded-md bg-slate-950 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30"
                            >
                              {row.substitute_options.map(option => (
                                <option key={option.code} value={option.code}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          )}
                          {(row.status === '缺料' || row.status === '無BOM') && (
                            <div className={`flex items-center gap-1 ${row.status !== '無BOM' ? 'mt-1' : ''}`}>
                              <span className="text-slate-500 text-[10px] shrink-0">自訂:</span>
                              <input
                                value={customCodeInputs[row.row_key] ?? ''}
                                onChange={e => setCustomCodeInputs(prev => ({ ...prev, [row.row_key]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') void handleLookupCustomCode(row.row_key) }}
                                placeholder="輸入料號"
                                className="flex-1 min-w-0 px-2 py-0.5 text-xs rounded bg-slate-800 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500/50"
                              />
                              <button
                                onClick={() => void handleLookupCustomCode(row.row_key)}
                                className="px-2 py-0.5 text-xs rounded bg-slate-700 hover:bg-slate-600 text-slate-300 shrink-0"
                              >
                                查
                              </button>
                              {customCodeStocks[row.row_key] !== undefined && (
                                <span className={`text-[10px] whitespace-nowrap shrink-0 ${
                                  customCodeStocks[row.row_key] === null ? 'text-red-400' : 'text-emerald-300'
                                }`}>
                                  {customCodeStocks[row.row_key] === null ? '找不到' : `庫存:${customCodeStocks[row.row_key]}`}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center text-xs whitespace-nowrap">
                          {(() => {
                            const argoUnit = row.selected_material_code ? unitMap[row.selected_material_code] : undefined
                            const bomUnit = row.unit
                            if (argoUnit) return <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/40 font-mono text-xs">{argoUnit}</span>
                            if (bomUnit) return <span className="px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/40 font-mono text-xs" title="未從 ARGO 取得，使用 BOM 單位">{bomUnit}⚠</span>
                            return <span className="text-red-400 text-xs">—</span>
                          })()}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-300 text-xs whitespace-nowrap">
                          {row.selected_material_code ? formatQty(row.selected_material_stock_qty) : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded-full ${
                            row.status === '可直接備料' ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-800/40' :
                            row.status === '建議替代' ? 'bg-amber-950/50 text-amber-300 border border-amber-800/40' :
                            row.status === '缺料' ? 'bg-red-950/50 text-red-300 border border-red-800/40' :
                            'bg-slate-950 text-slate-300 border border-slate-700'
                          }`}>
                            {row.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-400 text-xs max-w-[320px]" title={row.note}>{row.note}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </>)}

        {viewMode === 'history' && (
          <div className="space-y-4">
            {/* 操作列 */}
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-slate-400">
                  共 <span className="text-cyan-300 font-semibold">{prepLogs.length}</span> 筆紀錄，已選 <span className="text-orange-300 font-semibold">{selectedLogIds.size}</span> 筆
                </span>
                <button
                  onClick={() => void handleResetToPending()}
                  disabled={historyBusy || selectedLogIds.size === 0}
                  className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
                >
                  {historyBusy ? '處理中...' : '↩ 重設為未備料（切換至清單可再次上傳）'}
                </button>
              </div>
              {historyMessage && (
                <p className={`mt-3 text-sm whitespace-pre-line ${historyMessage.startsWith('❌') ? 'text-red-300' : 'text-emerald-300'}`}>
                  {historyMessage}
                </p>
              )}
            </div>

            {/* 紀錄表格 */}
            <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
              {prepLogLoading ? (
                <div className="px-4 py-10 text-center text-slate-400 text-sm">讀取中...</div>
              ) : prepLogError ? (
                <div className="px-4 py-10 text-center text-red-300 text-sm">{prepLogError}</div>
              ) : prepLogs.length === 0 ? (
                <div className="px-4 py-10 text-center text-slate-500 text-sm">尚無備料上傳紀錄</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-800/80 border-b border-slate-700">
                        <th className="px-2 py-3 text-center w-10">
                          <input
                            type="checkbox"
                            checked={prepLogs.length > 0 && prepLogs.every(l => selectedLogIds.has(l.id))}
                            onChange={() => {
                              const allSelected = prepLogs.every(l => selectedLogIds.has(l.id))
                              setSelectedLogIds(allSelected ? new Set() : new Set(prepLogs.map(l => l.id)))
                            }}
                            className="rounded border-slate-600 bg-slate-700 text-cyan-500 focus:ring-cyan-500/30"
                          />
                        </th>
                        <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">上傳時間</th>
                        <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">製令單號</th>
                        <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">生產貨號</th>
                        <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">廠別</th>
                        <th className="px-3 py-3 text-right text-slate-300 text-xs whitespace-nowrap">預定量</th>
                        <th className="px-3 py-3 text-right text-slate-300 text-xs whitespace-nowrap">備料筆數</th>
                        <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">介面</th>
                        <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">狀態</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prepLogs.map((log, index) => {
                        const checked = selectedLogIds.has(log.id)
                        return (
                          <tr key={log.id} className={`border-b border-slate-800/50 ${checked ? 'bg-cyan-950/30' : index % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/20'} hover:bg-slate-800/40`}>
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setSelectedLogIds(prev => {
                                  const next = new Set(prev)
                                  if (next.has(log.id)) next.delete(log.id)
                                  else next.add(log.id)
                                  return next
                                })}
                                className="rounded border-slate-600 bg-slate-700 text-cyan-500 focus:ring-cyan-500/30"
                              />
                            </td>
                            <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">
                              {new Date(log.logged_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td className="px-3 py-2 text-xs text-cyan-300 font-mono whitespace-nowrap">{log.mo_number}</td>
                            <td className="px-3 py-2 text-xs text-slate-300 whitespace-nowrap">{log.product_code || '-'}</td>
                            <td className="px-3 py-2 text-xs text-slate-300 whitespace-nowrap">{log.factory || '-'}</td>
                            <td className="px-3 py-2 text-xs text-slate-300 text-right whitespace-nowrap font-mono">{log.planned_qty || '-'}</td>
                            <td className="px-3 py-2 text-xs text-slate-300 text-right whitespace-nowrap font-mono">{log.lines_count}</td>
                            <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{log.interface_id || '-'}</td>
                            <td className="px-3 py-2 text-xs whitespace-nowrap">
                              <span className={`px-2 py-0.5 rounded-full border text-xs ${
                                log.status === '已備料'
                                  ? 'bg-emerald-950/50 text-emerald-300 border-emerald-800/40'
                                  : 'bg-amber-950/50 text-amber-300 border-amber-800/40'
                              }`}>
                                {log.status}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
