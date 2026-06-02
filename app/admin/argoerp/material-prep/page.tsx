'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import SoOrderModal from '../../../../components/SoOrderModal'

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
  machine?: string
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

interface PrepLog {
  id: number
  mo_number: string
  factory: string | null
  product_code: string | null
  planned_qty: string | null
  status: '已備料' | '無需備料'
  lines_count: number
  interface_id: string | null
  argo_slip_no: string | null
  logged_at: string
}

// ============================================================
// 出單表（批備料概覽用）
// ============================================================
interface SheetRowBrief {
  row_key: string
  order_number: string
  item_code: string
  item_name: string
  customer: string
  quantity: string
  delivery_date: string
  mo_status: '已匯入製令' | '暫緩區' | null
  mo_number?: string
  material_prep_status?: '已備料' | '無需備料' | '已批備料' | null
  // ARGO 批備料建立的單據號碼
  argo_slip_no?: string | null
  factory?: string
  note?: string
  plate_count?: string
}

interface SheetMeta {
  sheet_date: string
  row_count: number
  pending_count?: number
  updated_at: string
}

// ============================================================
// 工具
// ============================================================
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatQty(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '')
}

const PREP_INTERFACE_KEY = 'argoerp_material_prep_interface_id'
const PREP_QTY_OVERRIDES_KEY = 'argoerp_material_prep_qty_overrides'
const PREP_MATERIAL_OVERRIDES_KEY = 'argoerp_material_prep_material_overrides'
const PREP_CUSTOM_CODE_INPUTS_KEY = 'argoerp_material_prep_custom_code_inputs'
const PREP_PLATE_PREFIXES_KEY = 'argoerp_material_prep_plate_prefixes'
const PREP_NO_BUFFER_KEYS_KEY = 'argoerp_material_prep_no_buffer_keys'
const PREP_NO_NEED_KEYS_KEY   = 'argoerp_material_prep_no_need_keys'
const PREP_EXTRA_NOBOM_KEY    = 'argoerp_material_prep_extra_nobom'
const SUPABASE_OVERRIDES_KEY  = 'material_prep_overrides'   // app_settings key
const DEFAULT_PLATE_PREFIXES = ['MACRT']

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
  const [soModalId, setSoModalId] = useState<string | null>(null)

  // ---- BOM / 庫存 / 替代料 ----
  const [bomRows, setBomRows] = useState<BomRow[]>([])
  const [inventoryMap, setInventoryMap] = useState<Record<string, number>>({})
  const [unitMap, setUnitMap] = useState<Record<string, string>>({})
  const [substituteMap, setSubstituteMap] = useState<Record<string, SubstituteRuleRow[]>>({})
  const [bomLoading, setBomLoading] = useState(false)
  const [bomError, setBomError] = useState('')
  const [materialOverrides, setMaterialOverrides] = useState<Record<string, string>>({})  // loaded from Supabase on mount

  // ---- 來源訂單→客戶 map（從 erp_pj_sync 查詢）----
  const [sourceOrderCustomerMap, setSourceOrderCustomerMap] = useState<Record<string, string>>({})

  // ---- 需求量覆寫 / 自訂料號 ----
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, string>>({})  // loaded from Supabase on mount
  const [customCodeInputs, setCustomCodeInputs] = useState<Record<string, string>>({})  // loaded from Supabase on mount
  const [customCodeStocks, setCustomCodeStocks] = useState<Record<string, number | null>>({})

  // ---- 盤數優先前綴設定（從 Supabase app_settings 載入） ----
  const [platePrefixes, setPlatePrefixes] = useState<string[]>(DEFAULT_PLATE_PREFIXES)
  const [platePrefixesLoaded, setPlatePrefixesLoaded] = useState(false)
  const [showPlatePrefixModal, setShowPlatePrefixModal] = useState(false)
  const [platePrefixInput, setPlatePrefixInput] = useState('')

  // ---- 取消放數的列（料號→row_key）----
  const [noBufferKeys, setNoBufferKeys] = useState<Set<string>>(new Set())  // loaded from Supabase on mount

  // ---- 逐列「無需備料」排除（row_key 集合）----
  const [noNeedRowKeys, setNoNeedRowKeys] = useState<Set<string>>(new Set())  // loaded from Supabase on mount

  // ---- 換料 panel 開關（每行獨立）----
  const [swapOpenKeys, setSwapOpenKeys] = useState<Set<string>>(new Set())
  const toggleSwapOpen = useCallback((rowKey: string) => {
    setSwapOpenKeys(prev => {
      const next = new Set(prev)
      if (next.has(rowKey)) next.delete(rowKey)
      else next.add(rowKey)
      return next
    })
  }, [])

  // ---- 無BOM 追加用料列（parentKey → slotId[]）----
  const [extraNoBomSlots, setExtraNoBomSlots] = useState<Record<string, string[]>>({})  // loaded from Supabase on mount
  const addExtraNoBomRow = useCallback((parentKey: string) => {
    setExtraNoBomSlots(prev => ({
      ...prev,
      [parentKey]: [...(prev[parentKey] ?? []), String(Date.now())],
    }))
  }, [])
  const removeExtraNoBomRow = useCallback((parentKey: string, slotId: string) => {
    setExtraNoBomSlots(prev => {
      const next = (prev[parentKey] ?? []).filter(id => id !== slotId)
      if (next.length === 0) { const { [parentKey]: _, ...rest } = prev; return rest }
      return { ...prev, [parentKey]: next }
    })
    const rowKey = `${parentKey}::EX_${slotId}`
    setMaterialOverrides(prev => { const { [rowKey]: _, ...rest } = prev; return rest })
    setCustomCodeInputs(prev => { const { [rowKey]: _, ...rest } = prev; return rest })
  }, [])

  // ---- 選取 / 操作 ----
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(new Set())
  const [actionMessage, setActionMessage] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [statusFilter, setStatusFilter] = useState<MaterialPrepRow['status'] | null>(null)
  const [moSearchQuery, setMoSearchQuery] = useState('')
  const [remarkOverrides, setRemarkOverrides] = useState<Record<string, string>>({})

  // ---- 檢視模式 ----
  const [viewMode, setViewMode] = useState<'pending' | 'no_need' | 'history'>('pending')

  // ---- 出單表概覽收合（預設收起）----
  const [sheetOverviewOpen, setSheetOverviewOpen] = useState(false)

  // ---- 上傳紀錄 ----
  const [prepLogs, setPrepLogs] = useState<PrepLog[]>([])
  const [prepLogLoading, setPrepLogLoading] = useState(false)
  const [prepLogError, setPrepLogError] = useState('')
  const [selectedLogIds, setSelectedLogIds] = useState<Set<number>>(new Set())
  const [historyMessage, setHistoryMessage] = useState('')
  const [historyBusy, setHistoryBusy] = useState(false)

  // ---- 批備料介面 ----
  const materialPrepInterfaceId = 'IFAF078'
  const [materialPrepImporting, setMaterialPrepImporting] = useState(false)
  const [materialPrepMessage, setMaterialPrepMessage] = useState('')
  const [materialPrepMsgExpanded, setMaterialPrepMsgExpanded] = useState(false)
  // 防止雙擊重複送出：useRef 在 React 畫面更新前就能同步擋住第二次點擊
  const importInFlightRef = useRef(false)

  // ---- 出單表選擇 ----
  const [selectedDate, setSelectedDate] = useState('')
  const [availableSheets, setAvailableSheets] = useState<SheetMeta[]>([])
  const [sheetRows, setSheetRows] = useState<SheetRowBrief[]>([])
  const [sheetLoading, setSheetLoading] = useState(false)
  const [moSummaryMap, setMoSummaryMap] = useState<Record<string, string>>({})
  // mo_number -> ARGO 回傳的批備料單號
  const [moSlipNoMap, setMoSlipNoMap] = useState<Record<string, string>>({})
  // ref：記住當前出單表的製令清單（供 loadMoRecords 使用，避免 closure stale）
  const currentSheetMoNumbersRef = useRef<string[]>([])

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
  // 介面編號已固定為 IFAF078，不再使用 localStorage

  // ---- 從 Supabase app_settings 載入全部覆寫設定（多電腦共用）----
  const overridesLoaded = useRef(false)
  const overridesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', SUPABASE_OVERRIDES_KEY)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.value && typeof data.value === 'object') {
          const v = data.value as Record<string, unknown>
          if (v.qty_overrides)       setQtyOverrides(v.qty_overrides as Record<string, string>)
          if (v.material_overrides)  setMaterialOverrides(v.material_overrides as Record<string, string>)
          if (v.no_buffer_keys)      setNoBufferKeys(new Set(v.no_buffer_keys as string[]))
          if (v.no_need_keys)        setNoNeedRowKeys(new Set(v.no_need_keys as string[]))
          if (v.custom_code_inputs)  setCustomCodeInputs(v.custom_code_inputs as Record<string, string>)
          if (v.extra_nobom_slots)   setExtraNoBomSlots(v.extra_nobom_slots as Record<string, string[]>)
        } else {
          // Supabase 無資料，嘗試從 localStorage 復原（遅袋過渡）
          setQtyOverrides(loadFromLocalStorage<Record<string, string>>(PREP_QTY_OVERRIDES_KEY, {}))
          setMaterialOverrides(loadFromLocalStorage<Record<string, string>>(PREP_MATERIAL_OVERRIDES_KEY, {}))
          setNoBufferKeys(new Set(loadFromLocalStorage<string[]>(PREP_NO_BUFFER_KEYS_KEY, [])))
          setNoNeedRowKeys(new Set(loadFromLocalStorage<string[]>(PREP_NO_NEED_KEYS_KEY, [])))
          setCustomCodeInputs(loadFromLocalStorage<Record<string, string>>(PREP_CUSTOM_CODE_INPUTS_KEY, {}))
          setExtraNoBomSlots(loadFromLocalStorage<Record<string, string[]>>(PREP_EXTRA_NOBOM_KEY, {}))
        }
        overridesLoaded.current = true
      })
  }, [])

  // ---- 覆寫設定變更時，debounce 500ms 寫回 Supabase ----
  useEffect(() => {
    if (!overridesLoaded.current) return
    if (overridesSaveTimer.current) clearTimeout(overridesSaveTimer.current)
    overridesSaveTimer.current = setTimeout(() => {
      void supabase.from('app_settings').upsert({
        key: SUPABASE_OVERRIDES_KEY,
        value: {
          qty_overrides:      qtyOverrides,
          material_overrides: materialOverrides,
          no_buffer_keys:     [...noBufferKeys],
          no_need_keys:       [...noNeedRowKeys],
          custom_code_inputs: customCodeInputs,
          extra_nobom_slots:  extraNoBomSlots,
        },
        updated_at: new Date().toISOString(),
      })
    }, 500)
    return () => { if (overridesSaveTimer.current) clearTimeout(overridesSaveTimer.current) }
  }, [qtyOverrides, materialOverrides, noBufferKeys, noNeedRowKeys, customCodeInputs, extraNoBomSlots])

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

  // ---- 載入出單表的製令（由 loadSheet 帶入 moNumbers） ----
  const loadMoRecords = useCallback(async (moNumbers?: string[], sheetRowsFallback?: SheetRowBrief[]) => {
    const nums = moNumbers ?? currentSheetMoNumbersRef.current
    setMoLoading(true)
    setMoError('')
    try {
      if (nums.length === 0) {
        setMoRecords([])
        setSelectedRowKeys(new Set())
        return
      }
      // 包含 prep_status = '未備料' 以及尚未設定（null）的製令
      const { data, error } = await supabase
        .from('argoerp_mo_summary')
        .select('mo_number, factory, product_code, lot_number, planned_qty, source_order, mo_note, create_date, saved_at, prep_status, plate_count, machine')
        .in('mo_number', nums)
        .or('prep_status.eq.未備料,prep_status.is.null')
      if (error) throw error
      const records: MoRecord[] = (data ?? []) as MoRecord[]

      // 以出單表分配機台覆蓋（出單表為主，summary 為輔）
      const assignMap: Record<string, string> = {}
      try {
        const assignRes = await fetch(`/api/argoerp/mo-machine-assign?mo_numbers=${encodeURIComponent(nums.join(','))}`)
        const assignJson = await assignRes.json().catch(() => ({}))
        if (assignJson?.success && Array.isArray(assignJson.assignments)) {
          for (const a of assignJson.assignments as { mo_number: string; machine: string }[]) {
            if (a.mo_number && a.machine) assignMap[a.mo_number] = a.machine
          }
          for (const rec of records) {
            if (assignMap[rec.mo_number]) rec.machine = assignMap[rec.mo_number]
          }
        }
      } catch { /* 忽略機台分配載入錯誤 */ }

      // 以出單表的 plate_count 補齊（summary 可能沒存盤數）
      if (sheetRowsFallback && sheetRowsFallback.length > 0) {
        const sheetPlateMap: Record<string, string> = {}
        sheetRowsFallback.forEach(sr => {
          if (sr.mo_number && sr.plate_count) sheetPlateMap[sr.mo_number] = sr.plate_count
        })
        for (const rec of records) {
          if ((!rec.plate_count || rec.plate_count.trim() === '') && sheetPlateMap[rec.mo_number]) {
            rec.plate_count = sheetPlateMap[rec.mo_number]
          }
        }
      }

      // 對 argoerp_mo_summary 完全查無的製令，用出單表資料補建 fallback（確保待備料項目能顯示）
      if (sheetRowsFallback && sheetRowsFallback.length > 0) {
        const foundSet = new Set(records.map(r => r.mo_number))
        for (const mo of nums) {
          if (!foundSet.has(mo)) {
            const sr = sheetRowsFallback.find(r => r.mo_number === mo)
            if (sr) {
              records.push({
                mo_number: mo,
                factory: sr.factory ?? '',
                product_code: sr.item_code ?? '',
                lot_number: sr.customer ?? '',
                planned_qty: sr.quantity ?? '',
                source_order: sr.order_number ?? '',
                mo_note: sr.note ?? '',
                prep_status: '未備料',
                plate_count: sr.plate_count ?? '',
                machine: assignMap[mo] ?? '',
              })
            }
          }
        }
      }

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

  // ---- 載入出單表日期清單 ----
  const loadSheetList = useCallback(async () => {
    try {
      const res = await fetch('/api/argoerp/daily-order-sheet')
      const json = await res.json()
      if (json.success) setAvailableSheets(json.sheets ?? [])
    } catch {}
  }, [])

  // ---- 載入指定日期的出單表 ＋ 對應製令狀態 ----
  const loadSheet = useCallback(async (date: string) => {
    if (!date) return
    setSheetLoading(true)
    setMoError('')
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`)
      const json = await res.json()
      let moNumbers: string[] = []
      let loadedRows: SheetRowBrief[] = []
      if (json.success && json.sheet?.rows) {
        loadedRows = json.sheet.rows as SheetRowBrief[]
        setSheetRows(loadedRows)
        moNumbers = [...new Set(
          loadedRows
            .filter(r => r.mo_status === '已匯入製令' && r.mo_number)
            .map(r => r.mo_number!)
        )]
        // 先從出單表自身的 argo_slip_no 填入（已存在的值）
        const slipFromSheet: Record<string, string> = {}
        loadedRows.forEach(r => {
          if (r.mo_number && r.argo_slip_no) slipFromSheet[r.mo_number] = r.argo_slip_no
        })
        if (Object.keys(slipFromSheet).length > 0) {
          setMoSlipNoMap(slipFromSheet)
        }
      } else {
        setSheetRows([])
      }
      currentSheetMoNumbersRef.current = moNumbers
      if (moNumbers.length > 0) {
        // 建立 moSummaryMap（含已備料 / 未備料 / 無需備料，用於概覽顯示）
        const { data: summaryData } = await supabase
          .from('argoerp_mo_summary')
          .select('mo_number, prep_status')
          .in('mo_number', moNumbers)
        const summaryMap: Record<string, string> = {}
        ;(summaryData ?? []).forEach((r: { mo_number: string; prep_status: string | null }) => {
          summaryMap[r.mo_number] = r.prep_status ?? '未備料'
        })
        // 出單表本身的批備料狀態（已備料/無需備料/已批備料）也納入 summaryMap
        loadedRows.forEach(r => {
          if (r.mo_number && r.material_prep_status) {
            const s = r.material_prep_status === '已批備料' ? '已備料' : r.material_prep_status
            // 出單表已標記的優先（覆蓋 summary 的舊值）
            if (s === '已備料' || s === '無需備料') summaryMap[r.mo_number] = s
          }
        })

        // ── 從同步區 erp_material_prep_lines 自動比對批備料單號（同製令號） ──
        const { data: prepLinesData } = await supabase
          .from('erp_material_prep_lines')
          .select('mo_number, slip_no')
          .in('mo_number', moNumbers)
          .not('slip_no', 'is', null)
        const moToSlipFromPrepLines: Record<string, string> = {}
        ;(prepLinesData ?? []).forEach((r: { mo_number: string | null; slip_no: string | null }) => {
          if (r.mo_number && r.slip_no && !moToSlipFromPrepLines[r.mo_number]) {
            moToSlipFromPrepLines[r.mo_number] = r.slip_no
          }
        })
        // 有對應到批備料單 → 概覽顯示為已備料
        for (const mo of Object.keys(moToSlipFromPrepLines)) {
          if (!summaryMap[mo] || summaryMap[mo] === '未備料') {
            summaryMap[mo] = '已備料'
          }
        }
        setMoSummaryMap(summaryMap)

        // 建立 moSlipNoMap — 優先順序：出單表自帶 > log > erp_material_prep_lines
        const { data: logData } = await supabase
          .from('argoerp_material_prep_log')
          .select('mo_number, argo_slip_no')
          .in('mo_number', moNumbers)
          .not('argo_slip_no', 'is', null)
          .order('logged_at', { ascending: false })
        setMoSlipNoMap(prev => {
          const next = { ...prev }
          ;(logData ?? []).forEach((r: { mo_number: string; argo_slip_no: string | null }) => {
            if (r.argo_slip_no && !next[r.mo_number]) {
              next[r.mo_number] = r.argo_slip_no
            }
          })
          // 最後補入 erp_material_prep_lines（優先順序最低）
          for (const [mo, slip] of Object.entries(moToSlipFromPrepLines)) {
            if (!next[mo]) next[mo] = slip
          }
          return next
        })

        // 若出單表尚未儲存此單號 → 自動 PATCH 回出單表（fire-and-forget）
        const autoFillUpdates = loadedRows
          .filter(r => r.mo_number && moToSlipFromPrepLines[r.mo_number] && !r.argo_slip_no)
          .map(r => ({
            row_key: r.row_key,
            argo_slip_no: moToSlipFromPrepLines[r.mo_number!],
            material_prep_status: '已備料' as const,
          }))
        if (autoFillUpdates.length > 0) {
          fetch('/api/argoerp/daily-order-sheet', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sheet_date: date, updates: autoFillUpdates }),
          }).then(() => {
            // PATCH 完成後重新整理日期下拉的待備料計數
            void loadSheetList()
          }).catch(() => {})
        }

        // BOM 批備料表只顯示「在 erp_material_prep_lines 中沒有對應批備料單號」且「出單表尚未標為已備料/無需備料」的製令
        const sheetDoneMos = new Set(
          loadedRows
            .filter(r => r.mo_number && (r.material_prep_status === '已備料' || r.material_prep_status === '無需備料' || r.material_prep_status === '已批備料'))
            .map(r => r.mo_number!)
        )
        // 同時排除 summaryMap 已標記為已備料/無需備料 的製令
        const summaryDoneMos = new Set(
          Object.entries(summaryMap)
            .filter(([, s]) => s === '已備料' || s === '無需備料')
            .map(([mo]) => mo)
        )
        const moNumbersForBom = moNumbers.filter(mo => !moToSlipFromPrepLines[mo] && !sheetDoneMos.has(mo) && !summaryDoneMos.has(mo))
        // 以實際待備料數更新下拉選單標籤（避免 API 計數與顯示不一致）
        setAvailableSheets(prev => prev.map(s =>
          s.sheet_date === date ? { ...s, pending_count: moNumbersForBom.length } : s
        ))
        await loadMoRecords(moNumbersForBom, loadedRows)
      } else {
        setMoSummaryMap({})
        setMoSlipNoMap({})
        setMoRecords([])
        setAvailableSheets(prev => prev.map(s =>
          s.sheet_date === date ? { ...s, pending_count: 0 } : s
        ))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setMoError(msg)
    } finally {
      setSheetLoading(false)
    }
  }, [loadMoRecords, loadSheetList])

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

  useEffect(() => { void loadSheetList() }, [loadSheetList])
  useEffect(() => { void loadSheet(selectedDate) }, [selectedDate, loadSheet])

  useEffect(() => {
    if (viewMode === 'history') void loadPrepLogs()
  }, [viewMode, loadPrepLogs])

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
      // ── ERP BOM：mm_bom_structure（母件→子件），取各 parent_part 的最低版本 ──
      const { data: erpBomData, error: erpBomErr } = await supabase
        .from('mm_bom_structure')
        .select('parent_part, child_part, lot_child_qty, lot_base, bom_ver')
        .in('parent_part', productCodes)
      if (erpBomErr) throw erpBomErr

      type ErpBomRow = { parent_part: string; child_part: string; lot_child_qty: number | null; lot_base: number | null; bom_ver: number }
      const allErpBom = (erpBomData ?? []) as ErpBomRow[]

      // 每個 parent_part 只取最低 bom_ver
      const minVerMap: Record<string, number> = {}
      allErpBom.forEach(r => {
        if (minVerMap[r.parent_part] === undefined || r.bom_ver < minVerMap[r.parent_part]) {
          minVerMap[r.parent_part] = r.bom_ver
        }
      })
      const filteredErpBom = allErpBom.filter(r => r.bom_ver === minVerMap[r.parent_part])

      // 取子件的中文名稱與單位（mm_bom_part_units）
      const materialCodes = Array.from(new Set(filteredErpBom.map(r => r.child_part).filter(Boolean)))
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

      // 組合 BomRow（保持原有介面欄位，供 materialPrepRows 計算邏輯不變）
      const rows: BomRow[] = filteredErpBom.map(r => ({
        product_code: r.parent_part,
        product_name: null,
        production_quantity: r.lot_base ?? 1,
        production_unit: null,
        note: null,
        material_code: r.child_part,
        material_name: partInfoMap[r.child_part]?.part_name ?? null,
        quantity: r.lot_child_qty ?? 0,
        unit: partInfoMap[r.child_part]?.unit_of_measure ?? null,
      }))

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
        const moBase = {
          mo_number: mo.mo_number,
          customer: sourceOrderCustomerMap[mo.source_order ?? ''] || '-',
          source_order: mo.source_order || '-',
          product_code: productCode || '-',
          planned_qty: Number(mo.planned_qty ?? 0),
          plate_count: mo.plate_count || '-',
          factory: mo.factory || '-',
          machine: mo.machine || '',
          std_qty: 0,
          unit: '-',
          is_buffered: false,
          uses_plate_count: false,
        }

        // 建立單一 NO_BOM 列（含自訂料號支援）的 helper
        const makeNoBomRow = (key: string, label: string): MaterialPrepRow => {
          const customCode = materialOverrides[key]
          const customStock = customCode ? (inventoryMap[customCode] ?? 0) : 0
          const displayQty = qtyOverrides[key] !== undefined && qtyOverrides[key] !== '' ? Number(qtyOverrides[key]) : 0
          if (customCode) {
            return {
              ...moBase,
              row_key: key,
              source_material_code: '-',
              source_material_name: label,
              required_qty: displayQty,
              stock_qty: customStock,
              substitute_options: [{ code: customCode, name: customCode, stock_qty: customStock, label: `${customCode}｜自訂｜庫存 ${formatQty(customStock)}` }],
              selected_material_code: customCode,
              selected_material_name: customCode,
              selected_material_stock_qty: customStock,
              status: displayQty > 0 && customStock >= displayQty ? '可直接備料' : '缺料',
              note: displayQty === 0 ? `${label}，請填寫需求量` : customStock >= displayQty ? `${label}，庫存足夠` : `${label}，庫存不足`,
            }
          }
          return {
            ...moBase,
            row_key: key,
            source_material_code: '-',
            source_material_name: key === rowKey ? '查無 BOM' : label,
            required_qty: 0,
            stock_qty: 0,
            substitute_options: [],
            selected_material_code: '',
            selected_material_name: '',
            selected_material_stock_qty: 0,
            status: '無BOM',
            note: key === rowKey ? '此生產貨號尚未在系統 BOM 表建立對應' : '請輸入料號',
          }
        }

        const baseRow = makeNoBomRow(rowKey, '自訂原料')
        const extraRows = (extraNoBomSlots[rowKey] ?? []).map(slotId =>
          makeNoBomRow(`${rowKey}::EX_${slotId}`, '追加用料')
        )
        return [baseRow, ...extraRows]
      }

      return matchedBom.map((bom): MaterialPrepRow => {
        const rowKey = `${mo.mo_number}::${productCode}::${bom.material_code}`
        // 盤數優先前綴（可在設定中調整），其他原料優先使用數量
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
          planned_qty: Number(mo.planned_qty ?? 0),
          plate_count: mo.plate_count || '-',
          factory: mo.factory || '-',
          machine: mo.machine || '',
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
          is_buffered: shouldBuffer,
          uses_plate_count: usesPlateCount,
          status,
          note,
        }
      })
    })
  }, [moRecords, bomRows, inventoryMap, substituteMap, materialOverrides, qtyOverrides, sourceOrderCustomerMap, noBufferKeys, platePrefixes, extraNoBomSlots])

  const materialPrepSummary = useMemo(() => {
    return materialPrepRows.reduce<Record<MaterialPrepRow['status'], number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1
      return acc
    }, { 可直接備料: 0, 建議替代: 0, 缺料: 0, 無BOM: 0 })
  }, [materialPrepRows])

  // 篩選後的表格資料
  const filteredPrepRows = useMemo(() => {
    let rows = materialPrepRows
    if (statusFilter) rows = rows.filter(row => row.status === statusFilter)
    if (moSearchQuery.trim()) {
      const q = moSearchQuery.trim().toLowerCase()
      rows = rows.filter(row => row.mo_number?.toLowerCase().includes(q))
    }
    return rows
  }, [materialPrepRows, statusFilter, moSearchQuery])

  // 將「選取的料號行」轉為可送 ARGO 的批備料行
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

  // ---- 操作：標記為「無需備料」（逐列，僅全數覆蓋時才更新 DB）----
  const handleMarkNoNeed = useCallback(async () => {
    if (selectedRowKeys.size === 0) return
    const selectedRows = materialPrepRows.filter(r => selectedRowKeys.has(r.row_key))

    // 加入本地 noNeedRowKeys
    const newNoNeedKeys = new Set([...noNeedRowKeys, ...selectedRows.map(r => r.row_key)])
    setNoNeedRowKeys(newNoNeedKeys)

    // 取消勾選這些列
    setSelectedRowKeys(prev => {
      const next = new Set(prev)
      selectedRows.forEach(r => next.delete(r.row_key))
      return next
    })

    // 找出「所有行都在 noNeedRowKeys 裡」的製令 → 整張標記 DB
    const affectedMoNumbers = [...new Set(selectedRows.map(r => r.mo_number))]
    const moToMarkDone = affectedMoNumbers.filter(mo => {
      const allRowsForMo = materialPrepRows.filter(r => r.mo_number === mo)
      return allRowsForMo.every(r => newNoNeedKeys.has(r.row_key))
    })

    if (moToMarkDone.length === 0) {
      // 部分排除：僅本地追蹤，不動 DB
      setActionMessage(`✅ 已將 ${selectedRows.length} 列標記為無需備料（部分排除，製令整體仍待備料）`)
      setTimeout(() => setActionMessage(''), 6000)
      return
    }

    setActionBusy(true)
    setActionMessage('')
    try {
      const res = await fetch('/api/argoerp/mo-summary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mo_numbers: moToMarkDone, prep_status: '無需備料' }),
      })
      const json = await res.json()
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`)
      setActionMessage(`✅ 已將 ${selectedRows.length} 列排除，${moToMarkDone.length} 筆製令全數無需備料，已更新狀態`)

      // 寫入批備料紀錄（fire-and-forget）
      fetch('/api/argoerp/material-prep-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: moToMarkDone.map(mo => ({
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

      // 更新出單表的批備料狀態
      const sheetUpdates = sheetRows
        .filter(r => moToMarkDone.includes(r.mo_number ?? ''))
        .map(r => ({ row_key: r.row_key, material_prep_status: '無需備料' as const }))
      if (sheetUpdates.length > 0) {
        fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet_date: selectedDate, updates: sheetUpdates }),
        }).catch(() => {})
      }

      await loadSheet(selectedDate)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setActionMessage(`❌ 標記失敗：${msg}`)
    } finally {
      setActionBusy(false)
      setTimeout(() => setActionMessage(''), 6000)
    }
  }, [selectedRowKeys, materialPrepRows, noNeedRowKeys, moRecords, sheetRows, selectedDate, loadSheet])

  // ---- 操作：取消「無需備料」標記（改回待備料）----
  const handleRevertNoNeed = useCallback(async (moNumber: string) => {
    if (!moNumber) return
    if (!window.confirm(`確定取消「無需備料」標記？\n製令 ${moNumber} 將改回「待備料」狀態。`)) return
    if (!window.confirm(`再次確認：將 ${moNumber} 改回「待備料」？`)) return
    setActionBusy(true)
    setActionMessage('')
    try {
      const res = await fetch('/api/argoerp/mo-summary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mo_numbers: [moNumber], prep_status: '未備料' }),
      })
      const json = await res.json()
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`)

      // 同步出單表的 material_prep_status 設為 null
      const sheetUpdates = sheetRows
        .filter(r => r.mo_number === moNumber)
        .map(r => ({ row_key: r.row_key, material_prep_status: null }))
      if (sheetUpdates.length > 0) {
        await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet_date: selectedDate, updates: sheetUpdates }),
        }).catch(() => {})
      }

      setActionMessage(`✅ ${moNumber} 已改回「待備料」`)
      await loadSheet(selectedDate)
      void loadSheetList()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setActionMessage(`❌ 取消失敗：${msg}`)
    } finally {
      setActionBusy(false)
      setTimeout(() => setActionMessage(''), 6000)
    }
  }, [sheetRows, selectedDate, loadSheet, loadSheetList])

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
      setMaterialPrepMsgExpanded(false)
      importInFlightRef.current = false
      return
    }
    if (selectedImportRows.length === 0) {
      setMaterialPrepMessage('❌ 選取的製令中沒有可匯入的批備料資料（請檢查缺料或無 BOM 狀態）')
      setMaterialPrepMsgExpanded(false)
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
          REMARK: remarkOverrides[row.row_key] !== undefined ? remarkOverrides[row.row_key] : (row.machine || ''),
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

      // 從 ARGO RESULT 陣列擷取各製令的批備料單號（SLIP_NO）
      // 成功時 CHECK_FLAG = 'Y'，SLIP_NO = ARGO 系統產生的批備料單號
      const argoResultRows: Record<string, unknown>[] = Array.isArray(result?.apiResult?.RESULT)
        ? (result.apiResult.RESULT as Record<string, unknown>[])
        : []
      // 以 MO 號為 key，彙整 ARGO 回傳的 SLIP_NO（可能跟送出的不同）
      const moToArgoSlipNo: Record<string, string> = {}
      for (const row of argoResultRows) {
        const slipNo = String(row.SLIP_NO ?? '').trim()
        const lineNo = String(row.LINE_NO ?? '')
        if (!slipNo) continue
        // 找出哪個 MO 對應這個 SLIP_NO
        // 我們送出時 SLIP_NO = moNumber，但 ARGO 可能回傳不同值
        const matchedMo = importMos.find(mo => mo === slipNo) ?? slipNo
        if (!moToArgoSlipNo[matchedMo]) {
          moToArgoSlipNo[matchedMo] = slipNo
        } else if (!moToArgoSlipNo[matchedMo].includes(slipNo)) {
          moToArgoSlipNo[matchedMo] += `, ${slipNo}`
        }
        void lineNo // 保留供未來 debug 用
      }

      setMaterialPrepMessage(`✅ 已送出 ${selectedImportRows.length} 筆到 ARGO，並將 ${importMos.length} 筆製令標記為「已備料」${argoRaw}`)
      setMaterialPrepMsgExpanded(false)

      // 清除已完成製令的 noNeedRowKeys（避免殘留影響下次）
      setNoNeedRowKeys(prev => {
        const next = new Set(prev)
        materialPrepRows.filter(r => importMos.includes(r.mo_number)).forEach(r => next.delete(r.row_key))
        return next
      })

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
            argo_slip_no: moToArgoSlipNo[mo] ?? null,
          })),
        }),
      }).catch(err => console.warn('[批備料紀錄] 寫入失敗', err))

      // 即時更新概覽的批備料單號 map（不等待 loadSheet 重整）
      setMoSlipNoMap(prev => {
        const next = { ...prev }
        for (const mo of importMos) {
          if (moToArgoSlipNo[mo]) next[mo] = moToArgoSlipNo[mo]
        }
        return next
      })

      // 更新出單表的批備料狀態 + ARGO 批備料單號
      const sheetUpdates = sheetRows
        .filter(r => importMos.includes(r.mo_number ?? ''))
        .map(r => ({
          row_key: r.row_key,
          material_prep_status: '已備料' as const,
          argo_slip_no: moToArgoSlipNo[r.mo_number ?? ''] ?? null,
        }))
      if (sheetUpdates.length > 0) {
        fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet_date: selectedDate, updates: sheetUpdates }),
        }).catch(() => {})
      }

      await loadSheet(selectedDate)
    } catch (error) {
      const message = error instanceof Error ? error.message : '生產批備料匯入失敗'
      setMaterialPrepMessage(`❌ ${message}`)
      setMaterialPrepMsgExpanded(false)
    } finally {
      setMaterialPrepImporting(false)
      importInFlightRef.current = false
    }
  }, [selectedRowKeys, selectedImportRows, materialPrepRows, materialPrepInterfaceId, moRecords, sheetRows, selectedDate, loadSheet, noNeedRowKeys])

  // ---- 盤數優先前綴：從 Supabase 載入 ----
  // platePrefixesUserChanged：載入完成後 ref 設為 true，
  // 確保只有使用者真正修改時才寫回，防止載入失敗時以預設值覆蓋 Supabase。
  const platePrefixesUserChanged = useRef(false)
  useEffect(() => {
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'material_prep_plate_prefixes')
      .maybeSingle()
      .then(({ data }) => {
        if (data?.value && Array.isArray(data.value)) {
          setPlatePrefixes(data.value as string[])
        }
        setPlatePrefixesLoaded(true)
      })
  }, [])

  // ---- 盤數優先前綴：寫回 Supabase（僅使用者修改後才觸發）----
  useEffect(() => {
    if (!platePrefixesLoaded) return
    // 第一次因 platePrefixesLoaded 變為 true 觸發時，標記已載入並跳過（避免以預設值覆蓋）
    if (!platePrefixesUserChanged.current) {
      platePrefixesUserChanged.current = true
      return
    }
    void supabase
      .from('app_settings')
      .upsert({ key: 'material_prep_plate_prefixes', value: platePrefixes, updated_at: new Date().toISOString() })
  }, [platePrefixes, platePrefixesLoaded])

  // ============================================================
  // Render
  // ============================================================
  const noNeedRows = sheetRows.filter(r => r.material_prep_status === '無需備料')
  const noNeedCount = noNeedRows.length
  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1800px] mx-auto">

        {/* 盤數優先設定 Modal */}
        {showPlatePrefixModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
              <h2 className="text-lg font-semibold text-white mb-1">⚙️ 盤數優先料號前綴設定</h2>
              <p className="text-xs text-slate-400 mb-4">
                料號開頭符合下列前綴的原料，BOM 需求量計算將優先套用<span className="text-amber-300">盤數</span>而非數量。<br/>
                前綴不分大小寫。例：<code className="text-sky-300">MACRT</code>
              </p>
              <div className="flex flex-wrap gap-2 mb-4 min-h-[32px]">
                {platePrefixes.map(p => (
                  <span key={p} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-900/40 border border-amber-700/50 text-amber-200 text-xs font-mono">
                    {p}
                    <button
                      onClick={() => setPlatePrefixes(prev => prev.filter(x => x !== p))}
                      className="text-amber-400 hover:text-white transition-colors ml-0.5"
                    >✕</button>
                  </span>
                ))}
                {platePrefixes.length === 0 && <span className="text-xs text-slate-600 italic">尚無設定（全部套用數量）</span>}
              </div>
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={platePrefixInput}
                  onChange={e => setPlatePrefixInput(e.target.value.toUpperCase())}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const v = platePrefixInput.trim().toUpperCase()
                      if (v && !platePrefixes.includes(v)) setPlatePrefixes(prev => [...prev, v])
                      setPlatePrefixInput('')
                    }
                  }}
                  placeholder="輸入前綴，Enter 新增"
                  className="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-amber-500 font-mono uppercase"
                />
                <button
                  onClick={() => {
                    const v = platePrefixInput.trim().toUpperCase()
                    if (v && !platePrefixes.includes(v)) setPlatePrefixes(prev => [...prev, v])
                    setPlatePrefixInput('')
                  }}
                  className="px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-sm transition-colors"
                >新增</button>
              </div>
              <div className="flex justify-between items-center">
                <button
                  onClick={() => setPlatePrefixes(DEFAULT_PLATE_PREFIXES)}
                  className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2 transition-colors"
                >還原預設（MACRT）</button>
                <button
                  onClick={() => setShowPlatePrefixModal(false)}
                  className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm transition-colors"
                >關閉</button>
              </div>
            </div>
          </div>
        )}

        <div className="mb-4 border-b border-slate-800 pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">生產批備料</h1>
            <p className="text-slate-400 mt-1 text-sm">
              以出單表日期為主，載入指定出單表後比對 BOM / 替代料 / 物料庫存，可送 ARGO 批備料或標記為無需備料。
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
              onClick={() => setShowPlatePrefixModal(true)}
              className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors text-sm flex items-center gap-1.5"
              title="設定哪些料號前綴要優先套用盤數計算需求量"
            >
              🧮 盤數優先設定
              {platePrefixes.length > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-800/60 text-amber-300 border border-amber-700/50 font-mono">
                  {platePrefixes.join('、')}
                </span>
              )}
            </button>
            <button
              onClick={() => viewMode === 'history' ? void loadPrepLogs() : void loadSheet(selectedDate)}
              disabled={viewMode === 'history' ? prepLogLoading : (sheetLoading || moLoading)}
              className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 disabled:opacity-50 transition-colors text-sm"
            >
              {(viewMode === 'history' ? prepLogLoading : (sheetLoading || moLoading)) ? '讀取中...' : '🔄 重新整理'}
            </button>
          </div>
        </div>

        {/* ── 出單表日期選擇 ── */}
        <div className="mb-5 bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-slate-300">出單表日期</span>
            {availableSheets.length > 0 ? (
              <select
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
              >
                {availableSheets.map(s => {
                  const pending = s.pending_count ?? 0
                  const done = pending === 0
                  return (
                    <option
                      key={s.sheet_date}
                      value={s.sheet_date}
                      style={done ? { color: '#34d399' } : undefined}
                    >
                      {s.sheet_date}（{done ? '批備料完成' : `待備料 ${pending} 筆`}）
                    </option>
                  )
                })}
              </select>
            ) : (
              <span className="text-xs text-slate-500">尚無已儲存的出單表</span>
            )}
            {sheetLoading && <span className="text-xs text-slate-400">出單表讀取中...</span>}
            {!sheetLoading && sheetRows.length === 0 && selectedDate && (
              <span className="text-xs text-amber-400">此日期尚無出單表資料</span>
            )}
          </div>
        </div>

        {/* ── 出單表概覽（批備料狀態比對）── */}
        {sheetRows.filter(r => r.mo_status === '已匯入製令').length > 0 && (() => {
          const moRows = sheetRows.filter(r => r.mo_status === '已匯入製令')
          const prepDoneCount = moRows.filter(r => {
            const s = moSummaryMap[r.mo_number ?? '']
            return s === '已備料' || s === '無需備料'
          }).length
          return (
            <div className="mb-5 bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setSheetOverviewOpen(v => !v)}
                className="w-full px-4 py-3 border-b border-slate-700/50 flex flex-wrap items-center justify-between gap-2 hover:bg-slate-800/40 transition-colors text-left"
              >
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <span className={`inline-block transition-transform ${sheetOverviewOpen ? 'rotate-90' : ''}`}>▶</span>
                  出單表概覽
                  <span className="ml-2 text-slate-400 font-normal">{selectedDate}</span>
                </h2>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <span>已匯入製令 <span className="text-cyan-300 font-semibold">{moRows.length}</span> 張</span>
                  <span>已備料 / 無需備料 <span className="text-emerald-300 font-semibold">{prepDoneCount}</span> 張</span>
                  <span>待備料 <span className="text-amber-300 font-semibold">{moRows.length - prepDoneCount}</span> 張</span>
                </div>
              </button>
              {sheetOverviewOpen && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-800/60 border-b border-slate-700/50">
                      <th className="px-3 py-2 text-left text-slate-400 whitespace-nowrap">工單號 / 製令號</th>
                      <th className="px-3 py-2 text-left text-slate-400 whitespace-nowrap">品項代碼 / 品名</th>
                      <th className="px-3 py-2 text-left text-slate-400 whitespace-nowrap">客戶</th>
                      <th className="px-3 py-2 text-left text-slate-400 whitespace-nowrap">ARGO 批備料單號</th>
                      <th className="px-3 py-2 text-center text-slate-400 whitespace-nowrap">批備料狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {moRows.map((row, i) => {
                      // 優先取 moSummaryMap（從 argoerp_mo_summary 查到的），再 fallback 到 sheetRow 本身儲存的 material_prep_status
                      const prepStatus = row.mo_number
                        ? (moSummaryMap[row.mo_number] ?? row.material_prep_status ?? '未備料')
                        : row.material_prep_status ?? null
                      return (
                        <tr key={row.row_key} className={`border-b border-slate-800/40 ${i % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/20'} hover:bg-slate-800/30`}>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <div className="text-slate-300 font-mono text-xs">{row.order_number}</div>
                            <div className="text-cyan-300 font-mono text-[11px] mt-0.5 opacity-80">{row.mo_number || '—'}</div>
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <div className="text-slate-300">{row.item_code}</div>
                            <div className="text-slate-500 truncate max-w-[200px]" title={row.item_name}>{row.item_name}</div>
                          </td>
                          <td className="px-3 py-1.5 text-slate-400 truncate max-w-[140px]">{row.customer || '-'}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {row.mo_number && moSlipNoMap[row.mo_number]
                              ? <span className="font-mono text-emerald-300 text-xs">{moSlipNoMap[row.mo_number]}</span>
                              : <span className="text-slate-600 text-xs">—</span>
                            }
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            {prepStatus === '已備料' && (
                              <span className="px-2 py-0.5 rounded-full bg-emerald-950/60 text-emerald-300 border border-emerald-800/50 text-xs">已備料</span>
                            )}
                            {prepStatus === '無需備料' && (
                              <button
                                type="button"
                                onClick={() => row.mo_number && void handleRevertNoNeed(row.mo_number)}
                                disabled={actionBusy || !row.mo_number}
                                title="點擊取消「無需備料」標記，改回待備料"
                                className="px-2 py-0.5 rounded-full bg-amber-950/60 text-amber-300 border border-amber-800/50 text-xs hover:bg-amber-900/80 hover:border-amber-600 disabled:opacity-50 cursor-pointer transition-colors"
                              >
                                無需備料
                              </button>
                            )}
                            {prepStatus === '未備料' && (
                              <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 text-xs">待備料</span>
                            )}
                            {!prepStatus && (
                              <span className="text-slate-600 text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          )
        })()}

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
            📋 批備料操作（未備料）
            {moRecords.length > 0 && <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-slate-700 text-slate-300">{moRecords.length}</span>}
          </button>
          <button
            onClick={() => setViewMode('no_need')}
            className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              viewMode === 'no_need'
                ? 'border-amber-400 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            🚫 無需備料紀錄
            {noNeedCount > 0 && <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-slate-700 text-slate-300">{noNeedCount}</span>}
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
          {materialPrepMessage && (() => {
            const isErr = materialPrepMessage.startsWith('❌')
            const lines = materialPrepMessage.split('\n')
            const hasMore = lines.length > 1
            return (
              <div className={`text-sm ${isErr ? 'text-red-300' : 'text-emerald-300'}`}>
                <span className="whitespace-pre-line">
                  {materialPrepMsgExpanded ? materialPrepMessage : lines[0]}
                </span>
                {hasMore && (
                  <button
                    onClick={() => setMaterialPrepMsgExpanded(v => !v)}
                    className={`ml-2 text-xs underline opacity-70 hover:opacity-100 transition-opacity ${isErr ? 'text-red-400' : 'text-emerald-400'}`}
                  >
                    {materialPrepMsgExpanded ? '收合' : '展開'}
                  </button>
                )}
              </div>
            )
          })()}
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
            <div className="px-4 py-10 text-center text-slate-500 text-sm">
              {sheetRows.length === 0 ? '尚未載入出單表，請先選擇日期' : '此出單表中所有製令均已完成備料'}
            </div>
          ) : bomLoading ? (
            <div className="px-4 py-10 text-center text-slate-400 text-sm">BOM / 替代料 / 庫存資料讀取中...</div>
          ) : bomError ? (
            <div className="px-4 py-10 text-center text-red-300 text-sm">{bomError}</div>
          ) : (
            <div className="overflow-x-auto">              <div className="px-4 py-2 bg-slate-800/50 border-b border-slate-700/50 flex items-center gap-2 text-xs text-slate-400 flex-wrap">
                <div className="relative flex items-center">
                  <svg className="absolute left-2 text-slate-500 pointer-events-none" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <input
                    type="text"
                    value={moSearchQuery}
                    onChange={e => setMoSearchQuery(e.target.value)}
                    placeholder="搜尋製令單號…"
                    className="pl-6 pr-6 py-1 rounded bg-slate-700 text-slate-200 placeholder-slate-500 border border-slate-600 focus:outline-none focus:border-cyan-500 text-xs w-44"
                  />
                  {moSearchQuery && (
                    <button onClick={() => setMoSearchQuery('')} className="absolute right-1.5 text-slate-500 hover:text-white transition-colors">✕</button>
                  )}
                </div>
                {moSearchQuery.trim() && (
                  <span className="text-slate-400">找到 {filteredPrepRows.length} 筆</span>
                )}
                {statusFilter && (
                  <>
                    <span className="text-slate-600">|</span>
                    <span>篩選中：</span>
                    <span className="px-2 py-0.5 rounded-full bg-slate-700 text-slate-200">{statusFilter === '無BOM' ? '查無 BOM' : statusFilter}</span>
                    {!moSearchQuery.trim() && <span>共 {filteredPrepRows.length} 筆</span>}
                    <button onClick={() => setStatusFilter(null)} className="text-slate-500 hover:text-white transition-colors">✕ 取消篩選</button>
                  </>
                )}
              </div>              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col className="w-10" />
                  <col className="w-36" />
                  <col className="w-44" />
                  <col className="w-32" />
                  <col className="w-20" />
                  <col className="w-44" />
                  <col className="w-28" />
                  <col className="w-64" />
                  <col className="w-24" />
                  <col className="w-20" />
                  <col className="w-[150px]" />
                </colgroup>
                <thead>
                  <tr className="bg-slate-800/80 border-b border-slate-700">
                    <th className="px-2 py-3 text-center sticky left-0 bg-slate-800/80 z-10">
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
                    <th className="px-3 py-3 text-left text-slate-300 text-xs sticky left-10 bg-slate-800/80 z-10">製令單號</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs">客戶 / 來源訂單</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs">生產貨號 / 預定產出量</th>
                    <th className="px-3 py-3 text-right text-slate-300 text-xs">映射盤數</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs">原料料號 / 原料名稱</th>
                    <th className="px-3 py-3 text-right text-slate-300 text-xs">需求量</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs">使用料號</th>
                    <th className="px-3 py-3 text-center text-slate-300 text-xs">單位 / 庫存</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs">狀態</th>
                    <th className="px-3 py-3 text-left text-slate-300 text-xs">說明</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPrepRows.map((row, index) => {
                    const checked = selectedRowKeys.has(row.row_key)
                    const isNoNeed = noNeedRowKeys.has(row.row_key)
                    return (
                      <tr key={`${row.row_key}-${index}`} className={`border-b border-slate-800/50 ${
                        isNoNeed ? 'bg-amber-950/30 opacity-60' :
                        checked ? 'bg-cyan-950/30' :
                        index % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/20'
                      } hover:bg-slate-800/40`}>
                        <td className="px-2 py-2 text-center sticky left-0 bg-inherit z-10">
                          <input
                            type="checkbox"
                            checked={checked && !isNoNeed}
                            disabled={isNoNeed}
                            onChange={() => !isNoNeed && toggleRow(row.row_key)}
                            className="rounded border-slate-600 bg-slate-700 text-cyan-500 focus:ring-cyan-500/30 disabled:opacity-40"
                          />
                        </td>
                        <td className="px-3 py-2 text-xs sticky left-10 bg-inherit z-10">
                          <div className="text-cyan-300 font-mono font-semibold break-all">{row.mo_number}</div>
                          <div className="text-slate-500 text-[10px] mt-0.5">{row.factory}</div>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {row.source_order && row.source_order !== '-' && (
                            <button
                              onClick={() => setSoModalId(row.source_order)}
                              className="text-amber-300/80 font-mono text-[10px] hover:text-amber-200 hover:underline underline-offset-2 text-left break-all"
                            >
                              {row.source_order}
                            </button>
                          )}
                          <div className="text-slate-400 break-words" title={row.customer}>
                            {row.customer !== '-' ? row.customer : <span className="text-slate-600 italic">查無客戶</span>}
                          </div>
                          <input
                            type="text"
                            value={remarkOverrides[row.row_key] !== undefined ? remarkOverrides[row.row_key] : (row.machine || '')}
                            onChange={e => setRemarkOverrides(prev => ({ ...prev, [row.row_key]: e.target.value }))}
                            placeholder="機台 / 備料備註"
                            title="將作為 ARGO REMARK 匙入（逐列獨立）"
                            className="mt-1 w-full px-1.5 py-0.5 text-[10px] rounded bg-slate-800 border border-slate-700/60 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan-500/50"
                          />
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <div className="text-slate-300 break-all">{row.product_code}</div>
                          <div className="text-slate-400 font-mono">{formatQty(row.planned_qty)}</div>
                        </td>
                        <td className="px-3 py-2 text-right text-xs">
                          <span className="text-slate-300 font-mono">{row.plate_count}</span>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <div className="text-slate-300 break-all">{row.source_material_code}</div>
                          <div className="text-slate-400 break-words" title={row.source_material_name}>{row.source_material_name}</div>
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
                          {!row.uses_plate_count && qtyOverrides[row.row_key] === undefined && (
                            row.is_buffered ? (
                              <button
                                onClick={() => setNoBufferKeys(prev => new Set([...prev, row.row_key]))}
                                className="mt-0.5 text-[10px] text-amber-400/60 hover:text-amber-300 underline decoration-dotted transition-colors block w-full text-right"
                                title="移除 +3% 放數，恢復原始計算量"
                              >
                                取消放數
                              </button>
                            ) : (
                              <button
                                onClick={() => setNoBufferKeys(prev => { const next = new Set(prev); next.delete(row.row_key); return next })}
                                className="mt-0.5 text-[10px] text-slate-500 hover:text-slate-300 underline decoration-dotted transition-colors block w-full text-right"
                                title="重新套用 +3% 放數"
                              >
                                恢復放數
                              </button>
                            )
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <div className="flex items-center gap-1 mb-1">
                            {row.status !== '無BOM' && (
                              <select
                                value={row.selected_material_code}
                                onChange={e => handleSelectMaterialOverride(row.row_key, e.target.value)}
                                className="w-full max-w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30 truncate"
                              >
                                {row.substitute_options.map(option => (
                                  <option key={option.code} value={option.code}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            )}
                            <button
                              onClick={() => toggleSwapOpen(row.row_key)}
                              title="特規換料：輸入任意料號覆蓋"
                              className={`px-2 py-1 text-xs rounded border shrink-0 transition-colors ${
                                swapOpenKeys.has(row.row_key)
                                  ? 'bg-amber-600 border-amber-500 text-white'
                                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-amber-700 hover:border-amber-500 hover:text-white'
                              }`}
                            >
                              換
                            </button>
                            {/* NO_BOM：＋ 新增追加用料列 */}
                            {(() => {
                              const isExtraRow = row.row_key.includes('::NO_BOM::EX_')
                              const parentKey = isExtraRow
                                ? row.row_key.replace(/::EX_[^:]+$/, '')
                                : row.row_key
                              const isNoBomFamily = row.row_key.includes('::NO_BOM')
                              if (!isNoBomFamily) return null
                              if (isExtraRow) {
                                // 追加列：顯示 ✕ 刪除本列
                                const slotId = row.row_key.split('::EX_').pop()!
                                return (
                                  <button
                                    onClick={() => removeExtraNoBomRow(parentKey, slotId)}
                                    title="移除此追加用料列"
                                    className="px-1.5 py-1 text-xs rounded border bg-red-900/40 border-red-700/50 text-red-300 hover:bg-red-800 shrink-0"
                                  >✕</button>
                                )
                              }
                              // 主列：顯示 ＋ 新增追加列
                              return (
                                <button
                                  onClick={() => addExtraNoBomRow(parentKey)}
                                  title="新增追加用料列（同製令多種原料）"
                                  className="px-1.5 py-1 text-xs rounded border bg-indigo-900/40 border-indigo-700/50 text-indigo-300 hover:bg-indigo-800 shrink-0"
                                >＋</button>
                              )
                            })()}
                          </div>
                          {(swapOpenKeys.has(row.row_key) || row.status === '缺料' || row.status === '無BOM') && (
                            <div className="flex items-center gap-1">
                              <span className="text-slate-500 text-[10px] shrink-0">{swapOpenKeys.has(row.row_key) && row.status !== '缺料' && row.status !== '無BOM' ? '特規:' : '自訂:'}</span>
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
                        <td className="px-3 py-2 text-center text-xs">
                          {(() => {
                            const argoUnit = row.selected_material_code ? unitMap[row.selected_material_code] : undefined
                            const bomUnit = row.unit
                            const stockQtyEl = row.selected_material_code
                              ? <span className="text-slate-300 text-xs font-mono">{formatQty(row.selected_material_stock_qty)}</span>
                              : <span className="text-slate-600 text-xs">—</span>
                            const unitEl = argoUnit
                              ? <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/40 font-mono text-[10px]">{argoUnit}</span>
                              : bomUnit
                                ? <span className="px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/40 font-mono text-[10px]" title="未從 ARGO 取得，使用 BOM 單位">{bomUnit}⚠</span>
                                : <span className="text-red-400 text-[10px]">—</span>
                            return <div className="flex flex-col items-center gap-0.5">{stockQtyEl}{unitEl}</div>
                          })()}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {isNoNeed ? (
                            <div className="flex flex-col gap-1">
                              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-950/60 text-amber-300 border border-amber-700/50 w-fit">無需備料</span>
                              <button
                                onClick={() => setNoNeedRowKeys(prev => { const n = new Set(prev); n.delete(row.row_key); return n })
                                }
                                className="text-[10px] text-slate-400 hover:text-white underline underline-offset-1"
                              >✕ 取消排除</button>
                            </div>
                          ) : (
                          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                            row.status === '可直接備料' ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-800/40' :
                            row.status === '建議替代' ? 'bg-amber-950/50 text-amber-300 border border-amber-800/40' :
                            row.status === '缺料' ? 'bg-red-950/50 text-red-300 border border-red-800/40' :
                            'bg-slate-950 text-slate-300 border border-slate-700'
                          }`}>
                            {row.status === '可直接備料' ? '備料OK' :
                             row.status === '建議替代' ? '替代' :
                             row.status}
                          </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-400 text-xs break-words" title={row.note}>{row.note}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </>)}

        {viewMode === 'no_need' && (
          <div className="rounded-xl border border-amber-700/40 bg-amber-950/10">
            <div className="px-4 py-3 border-b border-amber-800/40 bg-amber-950/20 flex items-center gap-3">
              <span className="font-semibold text-amber-200">🚫 無需備料紀錄</span>
              <span className="text-slate-400 text-sm">{noNeedRows.length} 筆</span>
              {!selectedDate && <span className="text-xs text-slate-500">請先選擇出單日期以查看紀錄</span>}
            </div>
            {noNeedRows.length === 0 ? (
              <div className="py-10 text-center text-slate-600 text-sm">{selectedDate ? '該日期尚無無需備料紀錄' : '請先載入出單表'}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-900 text-slate-400 text-xs uppercase">
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">工單號</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">製令號</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">料號 / 品名</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">客戶</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">數量</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">交期</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {noNeedRows.map((row, idx) => (
                      <tr key={row.row_key} className={`border-b border-slate-800/40 ${idx % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/20'} hover:bg-amber-950/20`}>
                        <td className="px-3 py-2 font-mono text-slate-300 text-xs">{row.order_number}</td>
                        <td className="px-3 py-2 font-mono text-cyan-300 text-xs">{row.mo_number || '—'}</td>
                        <td className="px-3 py-2">
                          <div className="text-slate-300 text-xs">{row.item_code}</div>
                          <div className="text-slate-500 text-[11px] truncate max-w-[200px]" title={row.item_name}>{row.item_name}</div>
                        </td>
                        <td className="px-3 py-2 text-slate-400 text-xs truncate max-w-[120px]">{row.customer || '—'}</td>
                        <td className="px-3 py-2 font-mono text-slate-200 text-xs">{row.quantity}</td>
                        <td className="px-3 py-2 font-mono text-amber-300 text-xs">{row.delivery_date || '—'}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => row.mo_number && void handleRevertNoNeed(row.mo_number)}
                            disabled={actionBusy || !row.mo_number}
                            className="px-2 py-1 rounded text-xs bg-slate-700 hover:bg-teal-700 text-slate-300 hover:text-white transition-colors disabled:opacity-50"
                          >
                            恢復待備料
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
                        <th className="px-3 py-3 text-left text-slate-300 text-xs whitespace-nowrap">ARGO 批備料單號</th>
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
                              {log.argo_slip_no
                                ? <span className="font-mono text-cyan-300">{log.argo_slip_no}</span>
                                : <span className="text-slate-600">—</span>
                              }
                            </td>
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
      <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />
    </div>
  )
}
