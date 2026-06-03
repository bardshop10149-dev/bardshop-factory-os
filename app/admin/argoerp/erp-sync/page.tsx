'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import SoOrderModal from '../../../../components/SoOrderModal'

// ─── 型別 ─────────────────────────────────────────────
type DocTypeKey = 'sales' | 'mo' | 'pr' | 'po' | 'subcontract' | 'inventory' | 'material_prep' | 'customer' | 'bom_structure'

interface PjSyncMapping {
  docNoField: string
  subNoField: string
  itemCodeField: string
  descriptionField: string
  qtyField: string
  unitField: string
  statusField: string
  startDateField: string
  endDateField: string
  customerVendorField: string
  remarkField: string
}

interface SyncConfig {
  table: string
  customColumn: string
  filters: Array<{ key: string; value: string }>
  mapping: PjSyncMapping
}

interface SoLine {
  id: number
  project_id: string
  begin_date: string | null
  tpn_partner_id: string | null
  sales_id: number | null
  sales_name: string | null
  partner_name: string | null
  currency: string | null
  exchange_rate: number | null
  department: string | null
  sales_category: string | null
  hold_status: string | null
  line_no: string
  mbp_part: string | null
  mbp_ver: number | null
  description: string | null
  duedate: string | null
  order_qty_oru: number
  unit_of_measure_oru: string | null
  unit_price_oru: number
  grade: string | null
  remark: string | null
  tpn_part_no: string | null
  create_date: string | null
  update_date: string | null
  synced_at: string
}

interface MoLine {  id: number
  project_id: string
  begin_date: string | null
  end_date: string | null
  hold_status: string | null
  mo_begin_date: string | null
  line_no: string
  mbp_part: string | null
  mbp_lot_no: string | null
  order_qty: number
  source_order: string | null
  synced_at: string
}

interface MaterialPrepLine {
  id: number
  slip_no: string
  slip_date: string | null
  mo_number: string | null
  fg_part: string | null
  mo_qty: number
  line_no: number | null
  mbp_part: string | null
  notice_qty: number
  synced_at: string
}

interface PjRecord {
  id: number
  doc_type: string
  doc_no: string
  sub_no: string
  item_code: string | null
  description: string | null
  qty: number
  unit: string | null
  status: string | null
  start_date: string | null
  end_date: string | null
  customer_vendor: string | null
  remark: string | null
  extra: Record<string, unknown> | null
  synced_at: string
}

interface InventoryRecord {
  id: number
  sequence_no: number
  item_code: string
  item_name: string
  spec: string
  unit_of_measure: string | null
  physical_count: number
  book_count: number
  qisheng_sichuan_total: number
  updated_at: string
}

interface CustomerRecord {
  id: number
  partner_id: string
  cname: string
  full_cname: string | null
  synced_at: string
}

// ─── 常數 ─────────────────────────────────────────────
const STORAGE_PREFIX = 'argoerp_pj_sync_v1_'
const MO_PAGE_SIZE = 20
const SO_PAGE_SIZE = 20

const EMPTY_MAPPING: PjSyncMapping = {
  docNoField: '',
  subNoField: '',
  itemCodeField: '',
  descriptionField: '',
  qtyField: '',
  unitField: '',
  statusField: '',
  startDateField: '',
  endDateField: '',
  customerVendorField: '',
  remarkField: '',
}

const DOC_TYPES: Record<DocTypeKey, {
  label: string
  description: string
  defaultConfig: SyncConfig
  mappingLabels?: { key: keyof PjSyncMapping; label: string; required?: boolean }[]
  locked?: { table?: boolean; filters?: boolean; mappingKeys?: (keyof PjSyncMapping)[] }
}> = {
  sales: {
    label: '銷售訂單',
    description: 'PJ_PROJECT 表頭查詢（PJT_TYPE=SO）。明細欄位請使用專屬「銷售訂單同步」頁面（/admin/argoerp/so-sync）。',
    defaultConfig: {
      table: 'PJ_PROJECT',
      customColumn: 'PROJECT_ID,BEGIN_DATE,SALES_NAME,TPN_PARTNER_ID',
      filters: [{ key: 'PJT_TYPE', value: 'SO' }],
      mapping: {
        docNoField: 'PROJECT_ID',
        subNoField: '',
        itemCodeField: '',
        descriptionField: '',
        qtyField: '',
        unitField: '',
        statusField: '',
        startDateField: 'BEGIN_DATE',
        endDateField: '',
        customerVendorField: 'TPN_PARTNER_ID',
        remarkField: 'SALES_NAME',
      },
    },
  },
  mo: {
    label: '製令單號',
    description: 'PJT_TYPE=MO。PJT_TYPE 在 PJ_PROJECT 表頭，單表查詢即可。',
    defaultConfig: {
      table: 'PJ_PROJECT',
      customColumn: '',
      filters: [{ key: 'PJT_TYPE', value: 'MO' }],
      mapping: {
        ...EMPTY_MAPPING,
        docNoField: 'PROJECT_ID',
        descriptionField: 'PROJECT_NAME',
        statusField: 'HOLD_STATUS',
        startDateField: 'BEGIN_DATE',
        endDateField: 'END_DATE',
        customerVendorField: 'IN_CHARGE',
      },
    },
  },
  pr: {
    label: '請購單號',
    description: 'PJ_APPLYPROJECT 表頭 + PJ_APPLYPROJECTDETAIL 明細，JS 端 JOIN，同步至 erp_pj_sync (doc_type=請購單號)。',
    defaultConfig: {
      table: 'PJ_APPLYPROJECT + PJ_APPLYPROJECTDETAIL',
      customColumn: '',
      filters: [],
      mapping: {
        ...EMPTY_MAPPING,
        docNoField: 'APPLY_ID',
        subNoField: 'LINE_NO',
        itemCodeField: 'MBP_PART',
        descriptionField: 'REMARK',
        qtyField: 'ORDER_QTY_ORU',
        unitField: 'UNIT_OF_MEASURE_ORU',
        statusField: 'HOLD_STATUS',
        startDateField: 'APPLY_DATE',
        endDateField: 'DUEDATE',
        customerVendorField: 'SEG_SEGMENT_NO_DEPARTMENT',
        remarkField: 'CURRENCY',
      },
    },
  },
  po: {
    label: '採購單號',
    description: 'PJT_TYPE=PO。兩段式同步：PJ_PROJECT 表頭 + PJ_PROJECTDETAIL 明細，JS 端 JOIN，不依賴此設定（欄位映射僅供參考）。',
    defaultConfig: {
      table: 'PJ_PROJECT + PJ_PROJECTDETAIL',
      customColumn: '',
      filters: [{ key: 'PJT_TYPE', value: 'PO' }],
      mapping: {
        ...EMPTY_MAPPING,
        docNoField: 'PROJECT_ID',
        subNoField: 'LINE_NO',
        itemCodeField: 'MBP_PART',
        descriptionField: 'REMARK',
        qtyField: 'ORDER_QTY_ORU',
        unitField: 'UNIT_OF_MEASURE_ORU',
        statusField: 'HOLD_STATUS',
        startDateField: 'BEGIN_DATE',
        endDateField: 'DUEDATE',
        customerVendorField: 'TPN_PARTNER_ID',
        remarkField: 'REMARK2',
      },
    },
  },
  subcontract: {
    label: '委外製令',
    description: 'PJT_TYPE=OO。PJT_TYPE 在 PJ_PROJECT 表頭，單表查詢即可。',
    defaultConfig: {
      table: 'PJ_PROJECT',
      customColumn: '',
      filters: [{ key: 'PJT_TYPE', value: 'OO' }],
      mapping: {
        ...EMPTY_MAPPING,
        docNoField: 'PROJECT_ID',
        descriptionField: 'PROJECT_NAME',
        statusField: 'HOLD_STATUS',
        startDateField: 'BEGIN_DATE',
        endDateField: 'END_DATE',
        customerVendorField: 'IN_CHARGE',
      },
    },
  },
  inventory: {
    label: '倉庫庫存',
    description: '倉庫庫存餘額，查詢 ArgoERP MM_BOM_BOH_V 視圖。',
    locked: {
      table: true,
      filters: true,
      mappingKeys: ['docNoField', 'descriptionField', 'qtyField', 'customerVendorField'],
    },
    mappingLabels: [
      { key: 'docNoField',          label: '料號 PART',            required: true },
      { key: 'descriptionField',    label: '品名/規格 PART_DESC' },
      { key: 'qtyField',            label: '庫存數量 BOH' },
      { key: 'customerVendorField', label: '在途數量 PO_ON_ROAD' },
      { key: 'statusField',         label: '自定義欄位1' },
      { key: 'remarkField',         label: '自定義欄位2' },
    ],
    defaultConfig: {
      table: 'MM_BOM_BOH_V',
      customColumn: '',
      filters: [{ key: 'ROWNUM', value: '<= 10000' }],
      mapping: {
        ...EMPTY_MAPPING,
        docNoField: 'PART',
        descriptionField: 'PART_DESC',
        qtyField: 'BOH',
        customerVendorField: 'PO_ON_ROAD',
      },
    },
  },
  bom_structure: {
    label: 'BOM 結構',
    description: 'ARGO MM_BOM_STRUCTURE — 母件→子件展開資料，同步至 mm_bom_structure。',
    defaultConfig: {
      table: 'MM_BOM_STRUCTURE',
      customColumn: 'MBP_PART,MBP_VER,MBP_CHILD_PART,MBP_CHILD_VER,LINE_NO,CHILD_QTY,CHILD_SCRAP,LOT_CHILD_QTY,LOT_BASE',
      filters: [{ key: 'MBP_PART', value: 'IS NOT NULL' }],
      mapping: { ...EMPTY_MAPPING },
    },
    locked: { table: true, filters: true, mappingKeys: ['docNoField','subNoField','itemCodeField','descriptionField','qtyField','unitField','statusField','startDateField','endDateField','customerVendorField','remarkField'] },
  },
  customer: {
    label: '客戶資料',
    description: 'GL_TRADINGPARTNER（CUSTOMER=Y）。同步客戶代號、公司簡稱、公司全名到 erp_customers。',
    defaultConfig: {
      table: 'GL_TRADINGPARTNER',
      customColumn: 'PARTNER_ID,CNAME,FULL_CNAME',
      filters: [{ key: 'CUSTOMER', value: 'Y' }],
      mapping: { ...EMPTY_MAPPING },
    },
    locked: { table: true, filters: true, mappingKeys: ['docNoField','subNoField','itemCodeField','descriptionField','qtyField','unitField','statusField','startDateField','endDateField','customerVendorField','remarkField'] },
  },
  material_prep: {
    label: '批備料單',
    description: '批備料單，查詢 ARGO IV_NOTICE（表頭）+ IV_NOTICEDETAIL（明細），依備料單號 JOIN 組合後同步至 erp_material_prep_lines。',
    locked: { table: true, filters: true },
    defaultConfig: {
      table: 'IV_NOTICE / IV_NOTICEDETAIL',
      customColumn: '',
      filters: [],
      mapping: { ...EMPTY_MAPPING },
    },
  },
}

const MAPPING_LABELS: { key: keyof PjSyncMapping; label: string; required?: boolean }[] = [
  { key: 'docNoField',        label: '訂單編號 PROJECT_ID',         required: true },
  { key: 'subNoField',        label: '序號 LINE_NO' },
  { key: 'itemCodeField',     label: '規格 PART' },
  { key: 'descriptionField',  label: '產品名稱 DESCRIPTION' },
  { key: 'qtyField',          label: '數量 ORDER_QTY' },
  { key: 'unitField',         label: '單位 UNIT_OF_MEASURE' },
  { key: 'statusField',       label: '狀態 HOLD_STATUS' },
  { key: 'startDateField',    label: '開立日期 BEGIN_DATE' },
  { key: 'endDateField',      label: '交貨日 DUEDATE' },
  { key: 'customerVendorField', label: '客戶代號 TPN_PARTNER_ID' },
  { key: 'remarkField',       label: '業務員 SALES_NAME' },
]

// ─── 新增製令 helper（與 order-batch-export 共用邏輯）───
const MO_ERP_FIELD_MAP: Record<string, string> = {
  mo_number:          'PROJECT_ID',
  planned_start_date: 'BEGIN_DATE',
  planned_end_date:   'END_DATE',
  mo_status:          'HOLD_STATUS',
  department:         'SEG_SEGMENT_NO_DEPARTMENT',
  cost_department:    'PJT_SEG_SEGMENT_NO',
  seq_number:         'LINE_NO',
  product_code:       'MBP_PART',
  version:            'MBP_VER',
  lot_number:         'MBP_LOT_NO',
  planned_qty:        'ORDER_QTY',
  bom_level:          'BOM_LEVELS',
  product_cost_ratio: 'EQUIVALENT_RATIO',
  material_cost_ratio:'EQUIVALENT_RATIO_M',
  source_order:       'PJT_PROJECT_ID_MO_SO',
  source_order_line:  'LINE_NO_MO_SO',
  mo_note:            'REMARK_LINE',
  create_date:        'MO_BEGIN_DATE',
  auto_material:      'AUTO_PREPARE',
}

function moToErpPayload(row: Record<string, string>): Record<string, string> {
  const erp: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) {
    const code = MO_ERP_FIELD_MAP[k]
    if (!code) continue
    const val = (v ?? '').trim()
    if (!val) continue
    erp[code] = val
  }
  return erp
}

function parseSoDate(orderNumber: string): string {
  const today = new Date()
  const fallback = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`
  const m = orderNumber.match(/^[A-Za-z]+(\d+)/)
  return m ? m[1] : fallback
}

function moFormatDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`
}

function moNextBizDay(from: Date): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

function buildMoRecord(
  orderNumber: string, lineNo: string, itemCode: string, itemName: string,
  qty: string, deliveryDate: string, factory: 'T' | 'C' | 'O', customer: string, note: string,
): {
  exportRow: Record<string, string>
  summaryRecord: Record<string, string>
  moNumber: string
  interfaceId: string
} {
  const today = new Date()
  const prefix = factory === 'O' ? 'MOO' : `MO${factory}`
  const soDate = parseSoDate(orderNumber)
  const seqStr = String(Number(lineNo)).padStart(2, '0')
  const moNumber = `${prefix}${soDate}${seqStr}`
  const interfaceId = factory === 'T' ? 'IFAF028' : 'IFAF044'

  const exportRow: Record<string, string> = {
    mo_number:          moNumber,
    planned_start_date: moFormatDate(moNextBizDay(today)),
    planned_end_date:   deliveryDate.replace(/-/g, '/'),
    mo_status:          'OPEN',
    department:         'M1100',
    cost_department:    'M1000',
    seq_number:         String(Number(lineNo)),
    product_code:       itemCode,
    version:            '1',
    lot_number:         orderNumber.slice(0, 30),
    planned_qty:        qty,
    bom_level:          '99',
    product_cost_ratio: '1',
    material_cost_ratio:'1',
    source_order:       orderNumber,
    source_order_line:  String(Number(lineNo)),
    mo_note:            [itemName, note].filter(Boolean).join(' '),
    create_date:        moFormatDate(today),
    auto_material:      'N',
  }

  const summaryRecord: Record<string, string> = {
    mo_number:          moNumber,
    planned_start_date: exportRow.planned_start_date,
    planned_end_date:   exportRow.planned_end_date,
    mo_status:          'OPEN',
    department:         'M1100',
    product_code:       itemCode,
    lot_number:         exportRow.lot_number,
    planned_qty:        qty,
    source_order:       orderNumber,
    mo_note:            exportRow.mo_note,
    create_date:        exportRow.create_date,
    factory,
    saved_at:           new Date().toLocaleString('zh-TW'),
    plate_count:        '',
    customer,
  }

  return { exportRow, summaryRecord, moNumber, interfaceId }
}

interface MoModalForm {
  order_number: string
  line_no: string
  item_code: string
  item_name: string
  quantity: string
  delivery_date: string
  factory: 'T' | 'C' | 'O'
  customer: string
  note: string
}

// ─── 工具 ─────────────────────────────────────────────
function loadConfig(key: DocTypeKey): SyncConfig {
  if (typeof window === 'undefined') return DOC_TYPES[key].defaultConfig
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key)
    if (!raw) return DOC_TYPES[key].defaultConfig
    const parsed = JSON.parse(raw) as Partial<SyncConfig>
    return {
      ...DOC_TYPES[key].defaultConfig,
      ...parsed,
      mapping: { ...DOC_TYPES[key].defaultConfig.mapping, ...(parsed.mapping ?? {}) },
      filters: parsed.filters ?? [],
    }
  } catch {
    return DOC_TYPES[key].defaultConfig
  }
}

function saveConfig(key: DocTypeKey, config: SyncConfig) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(config)) } catch {}
}

// ─── 子元件：單一同步卡片 ───────────────────────────────
interface SyncCardProps {
  docKey: DocTypeKey
}

function SyncCard({ docKey }: SyncCardProps) {
  const meta = DOC_TYPES[docKey]
  const isSoTab = docKey === 'sales'
  const isMoTab = docKey === 'mo'
  const isInventoryTab = docKey === 'inventory'
  const isMaterialPrepTab = docKey === 'material_prep'
  const isCustomerTab = docKey === 'customer'
  const isPoTab = docKey === 'po'
  const isPrTab = docKey === 'pr'
  const isSubcontractTab = docKey === 'subcontract'
  const activeMappingLabels = meta.mappingLabels ?? MAPPING_LABELS
  const [config, setConfig] = useState<SyncConfig>(() => loadConfig(docKey))
  const [showConfig, setShowConfig] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')
  const [messageOk, setMessageOk] = useState(true)
  const [diagRunning, setDiagRunning] = useState(false)
  const [diagText, setDiagText] = useState('')
  const [rawSample, setRawSample] = useState<Record<string, unknown> | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [records, setRecords] = useState<PjRecord[]>([])
  const [soRecords, setSoRecords] = useState<SoLine[]>([])
  const [moRecords, setMoRecords] = useState<MoLine[]>([])
  const [materialPrepRecords, setMaterialPrepRecords] = useState<MaterialPrepLine[]>([])
  const [customerRecords, setCustomerRecords] = useState<CustomerRecord[]>([])
  const [materialPrepPage, setMaterialPrepPage] = useState(1)
  const [moStatusFilter, setMoStatusFilter] = useState<'OPEN' | 'HOLD' | 'CLOSE' | null>('OPEN')
  const [poStatusFilter, setPoStatusFilter] = useState<'OPEN' | 'HOLD' | 'CLOSE' | null>('OPEN')

  // 手動新增製令 modal state
  const defaultMoForm: MoModalForm = { order_number: '', line_no: '', item_code: '', item_name: '', quantity: '', delivery_date: '', factory: 'T', customer: '', note: '' }
  const [soMoModal, setSoMoModal] = useState<{ show: boolean; importing: boolean; msg: string; form: MoModalForm; errors: Record<string, string> }>({ show: false, importing: false, msg: '', form: defaultMoForm, errors: {} })
  const [moPage, setMoPage] = useState(1)
  const [soStatusFilter, setSoStatusFilter] = useState<'OPEN' | 'HOLD' | 'CLOSE' | null>('OPEN')
  const [soPage, setSoPage] = useState(1)
  const [loadingRecords, setLoadingRecords] = useState(false)
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [soModalId, setSoModalId] = useState<string | null>(null)
  const configRef = useRef(config)
  configRef.current = config

  // ─── 手動新增製令 handler ─────────────────────────────
  function openMoModalFromSo(r: SoLine) {
    const deliveryDate = r.duedate ? r.duedate.slice(0, 10) : ''
    setSoMoModal({
      show: true, importing: false, msg: '',
      form: {
        order_number: r.project_id ?? '',
        line_no: r.line_no != null ? String(r.line_no) : '',
        item_code: r.mbp_part ?? '',
        item_name: r.description ?? '',
        quantity: r.order_qty_oru != null ? String(r.order_qty_oru) : '',
        delivery_date: deliveryDate,
        factory: 'T',
        customer: r.partner_name ?? '',
        note: '',
      },
      errors: {},
    })
  }

  async function handleSubmitSoMo() {
    const f = soMoModal.form
    const errs: Record<string, string> = {}
    if (!f.order_number.trim()) errs.order_number = '必填'
    if (!f.line_no.trim() || isNaN(Number(f.line_no))) errs.line_no = '必填(數字)'
    if (!f.item_code.trim()) errs.item_code = '必填'
    if (!f.quantity.trim() || isNaN(Number(f.quantity))) errs.quantity = '必填(數字)'
    if (!f.delivery_date.trim()) errs.delivery_date = '必填'
    if (Object.keys(errs).length > 0) { setSoMoModal(p => ({ ...p, errors: errs })); return }

    setSoMoModal(p => ({ ...p, importing: true, msg: '' }))

    try {
      const { exportRow, summaryRecord, moNumber, interfaceId } = buildMoRecord(
        f.order_number.trim(), f.line_no.trim(), f.item_code.trim(), f.item_name.trim(),
        f.quantity.trim(), f.delivery_date.trim(), f.factory, f.customer.trim(), f.note.trim(),
      )
      const payload = moToErpPayload(exportRow)

      // 上傳至 ARGO
      const argoRes = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId, data: [payload] }),
      })
      const argoJson = await argoRes.json().catch(() => ({}))

      // 如果製令單號已存在，改用 upsert 再傳一次
      const isDup = argoJson?.errors?.some?.((e: { message?: string }) =>
        typeof e?.message === 'string' && e.message.includes('製令單號已存在'))
      if (!argoRes.ok && !isDup) {
        const msg = argoJson?.errors?.[0]?.message ?? argoJson?.error ?? `HTTP ${argoRes.status}`
        setSoMoModal(p => ({ ...p, importing: false, msg: `❌ ARGO 錯誤：${msg}` }))
        return
      }

      // 寫入 mo-summary
      const summaryMode = isDup ? '?mode=upsert' : ''
      const sumRes = await fetch(`/api/argoerp/mo-summary${summaryMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [summaryRecord] }),
      })
      const sumJson = await sumRes.json().catch(() => ({}))
      if (!sumRes.ok && !(sumJson?.duplicate)) {
        setSoMoModal(p => ({ ...p, importing: false, msg: `⚠️ ARGO 已上傳，但紀錄寫入失敗：${sumJson?.error ?? '未知'}` }))
        return
      }

      setSoMoModal(p => ({ ...p, importing: false, msg: `✅ ${isDup ? '（已存在，更新）' : ''}製令 ${moNumber} 新增完成！` }))
    } catch (e) {
      const err = e as Error
      setSoMoModal(p => ({ ...p, importing: false, msg: `❌ ${err.message}` }))
    }
  }

  // 讀取 Supabase 資料
  const fetchRecords = useCallback(async (keyword = '', page = 1) => {
    setLoadingRecords(true)
    try {
      if (isCustomerTab) {
        let query = supabase
          .from('erp_customers')
          .select('*', { count: 'exact' })
          .order('partner_id', { ascending: true })
        if (keyword.trim()) {
          const kw = keyword.trim()
          query = query.or(`partner_id.ilike.%${kw}%,cname.ilike.%${kw}%,full_cname.ilike.%${kw}%`)
        }
        const { data, count } = await query
        setCustomerRecords((data ?? []) as CustomerRecord[])
        setTotalCount(count ?? 0)
      } else if (isSoTab) {
        const offset = (page - 1) * SO_PAGE_SIZE
        let query = supabase
          .from('erp_so_lines')
          .select('*', { count: 'exact' })
          .order('project_id', { ascending: true })
          .range(offset, offset + SO_PAGE_SIZE - 1)
        if (soStatusFilter) {
          query = query.eq('hold_status', soStatusFilter)
        }
        if (keyword.trim()) {
          const kw = keyword.trim()
          query = query.or(
            `project_id.ilike.%${kw}%,mbp_part.ilike.%${kw}%,partner_name.ilike.%${kw}%,sales_name.ilike.%${kw}%`
          )
        }
        const { data, count } = await query
        setSoRecords((data ?? []) as SoLine[])
        setTotalCount(count ?? 0)
      } else if (isMoTab) {
        const offset = (page - 1) * MO_PAGE_SIZE
        let query = supabase
          .from('erp_mo_lines')
          .select('*', { count: 'exact' })
          .order('project_id', { ascending: true })
          .range(offset, offset + MO_PAGE_SIZE - 1)
        if (moStatusFilter) {
          query = query.eq('hold_status', moStatusFilter)
        }
        if (keyword.trim()) {
          const kw = keyword.trim()
          query = query.or(
            `project_id.ilike.%${kw}%,mbp_part.ilike.%${kw}%,mbp_lot_no.ilike.%${kw}%,source_order.ilike.%${kw}%`
          )
        }
        const { data, count } = await query
        setMoRecords((data ?? []) as MoLine[])
        setTotalCount(count ?? 0)
      } else if (isMaterialPrepTab) {
        const MP_PAGE_SIZE = 20
        const offset = (page - 1) * MP_PAGE_SIZE
        let query = supabase
          .from('erp_material_prep_lines')
          .select('*', { count: 'exact' })
          .order('slip_no', { ascending: true })
          .range(offset, offset + MP_PAGE_SIZE - 1)
        if (keyword.trim()) {
          const kw = keyword.trim()
          query = query.or(
            `slip_no.ilike.%${kw}%,mo_number.ilike.%${kw}%,fg_part.ilike.%${kw}%,mbp_part.ilike.%${kw}%`
          )
        }
        const { data, count, error: mpError } = await query
        if (mpError) console.error('erp_material_prep_lines fetch error:', mpError)
        setMaterialPrepRecords((data ?? []) as MaterialPrepLine[])
        setTotalCount(count ?? 0)
      } else {
        // 委外製令 / 採購單號 → erp_pj_sync（依 doc_type 篩選）
        // 倉庫庫存 → material_inventory_list
        const isInventory = isInventoryTab
        const supabaseTable = isInventory ? 'material_inventory_list' : 'erp_pj_sync'
        const offset = (page - 1) * SO_PAGE_SIZE
        let query = supabase
          .from(supabaseTable)
          .select('*', { count: 'exact' })
          .range(offset, offset + SO_PAGE_SIZE - 1)
        if (!isInventory) {
          // erp_pj_sync 依 doc_type 篩選
          query = query.eq('doc_type', meta.label).order('doc_no', { ascending: true })
          if ((isPoTab || isPrTab) && poStatusFilter) {
            query = query.eq('status', poStatusFilter)
          }
          if (keyword.trim()) {
            const kw = keyword.trim()
            const baseOr = `doc_no.ilike.%${kw}%,item_code.ilike.%${kw}%,description.ilike.%${kw}%,customer_vendor.ilike.%${kw}%`
            query = query.or(
              isPoTab
                ? `${baseOr},extra->>MBP_LOT_NO.ilike.%${kw}%`
                : baseOr
            )
          }
        } else {
          // material_inventory_list
          query = query.order('item_code', { ascending: true })
          if (keyword.trim()) {
            const kw = keyword.trim()
            query = query.or(
              `item_code.ilike.%${kw}%,item_name.ilike.%${kw}%,spec.ilike.%${kw}%`
            )
          }
        }
        const { data, count } = await query
        setRecords((data ?? []) as PjRecord[])
        setTotalCount(count ?? 0)
      }
    } catch {
      // ignore
    } finally {
      setLoadingRecords(false)
    }
  }, [isSoTab, isMoTab, isMaterialPrepTab, isCustomerTab, isPoTab, isPrTab, meta.label, moStatusFilter, soStatusFilter, poStatusFilter])

  useEffect(() => { void fetchRecords() }, [fetchRecords])

  // MO 狀態篩選切換時回到第一頁
  const handleMoStatusFilter = (s: 'OPEN' | 'HOLD' | 'CLOSE' | null) => {
    setMoPage(1)
    setMoStatusFilter(s)
  }

  // MO 換頁
  const handleMoPageChange = (page: number) => {
    setMoPage(page)
    void fetchRecords(search, page)
  }

  // PO 狀態篩選切換時回到第一頁
  const handlePoStatusFilter = (s: 'OPEN' | 'HOLD' | 'CLOSE' | null) => {
    setPoStatusFilter(s)
  }

  // SO 狀態篩選切換時回到第一頁
  const handleSoStatusFilter = (s: 'OPEN' | 'HOLD' | 'CLOSE' | null) => {
    setSoPage(1)
    setSoStatusFilter(s)
  }

  // SO 換頁
  const handleSoPageChange = (page: number) => {
    setSoPage(page)
    void fetchRecords(search, page)
  }

  // 批備料單 換頁
  const handleMaterialPrepPageChange = (page: number) => {
    setMaterialPrepPage(page)
    void fetchRecords(search, page)
  }

  // MO 匯出 CSV（取全部筆數，不分頁）
  const handleMoExportCsv = async () => {
    let query = supabase
      .from('erp_mo_lines')
      .select('hold_status,project_id,source_order,line_no,mbp_part,order_qty,end_date,mo_begin_date,mbp_lot_no')
      .order('project_id', { ascending: true })
    if (moStatusFilter) query = query.eq('hold_status', moStatusFilter)
    if (search.trim()) {
      const kw = search.trim()
      query = query.or(`project_id.ilike.%${kw}%,mbp_part.ilike.%${kw}%,mbp_lot_no.ilike.%${kw}%,source_order.ilike.%${kw}%`)
    }
    const { data } = await query
    if (!data || data.length === 0) return
    const headers = ['狀態', '製令單號', '來源訂單', '編號', '生產貨號', '預訂產出量', '預定結案日', '開立日期', '批號']
    const rows = data.map((r) => [
      r.hold_status ?? '',
      r.project_id ?? '',
      r.source_order ?? '',
      r.line_no ?? '',
      r.mbp_part ?? '',
      r.order_qty ?? '',
      r.end_date ?? '',
      r.mo_begin_date ?? '',
      r.mbp_lot_no ?? '',
    ])
    const csvContent = [headers, ...rows]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\r\n')
    const bom = '\uFEFF'
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `製令單_${moStatusFilter ?? '全部'}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // MO 列印（當頁）
  const handleMoPrint = () => {    const headers = ['狀態', '製令單號', '來源訂單', '編號', '生產貨號', '預訂產出量', '預定結案日', '開立日期', '批號']
    const rows = moRecords.map((r) => [
      r.hold_status ?? '—',
      r.project_id ?? '—',
      r.source_order ?? '—',
      r.line_no ?? '—',
      r.mbp_part ?? '—',
      r.order_qty > 0 ? r.order_qty.toLocaleString() : '—',
      r.end_date ?? '—',
      r.mo_begin_date ?? '—',
      r.mbp_lot_no ?? '—',
    ])
    const tableRows = rows.map((row) =>
      `<tr>${row.map((v) => `<td>${v}</td>`).join('')}</tr>`
    ).join('')
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>製令單列印</title>
<style>
  body { font-family: sans-serif; font-size: 11px; margin: 16px; }
  h2 { font-size: 14px; margin-bottom: 8px; }
  p { font-size: 10px; color: #666; margin-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; }
  th { background: #f0f0f0; font-weight: 600; text-align: left; padding: 4px 6px; border: 1px solid #ccc; }
  td { padding: 3px 6px; border: 1px solid #ddd; }
  tr:nth-child(even) td { background: #fafafa; }
  @media print {
    @page { margin: 10mm; size: landscape; }
    html { -webkit-filter: grayscale(100%) !important; filter: grayscale(100%) !important; }
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color: #000 !important;
      background: #fff !important;
      border-color: #bbb !important;
      text-shadow: none !important;
      box-shadow: none !important;
    }
  }
</style></head><body>
<h2>製令單列表</h2>
<p>狀態篩選：${moStatusFilter ?? '全部'} ／ 第 ${moPage} 頁 ／ 列印時間：${new Date().toLocaleString('zh-TW')}</p>
<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>${tableRows}</tbody></table>
<script>window.onload=()=>{window.print();window.close();}<\/script>
</body></html>`
    const w = window.open('', '_blank', 'width=1100,height=700')
    w?.document.write(html)
    w?.document.close()
  }

  // SO 匯出 CSV（取全部筆數，不分頁）
  const handleSoExportCsv = async () => {
    let query = supabase
      .from('erp_so_lines')
      .select('hold_status,project_id,line_no,mbp_part,description,order_qty_oru,duedate,partner_name,sales_name,remark')
      .order('project_id', { ascending: true })
    if (soStatusFilter) query = query.eq('hold_status', soStatusFilter)
    if (search.trim()) {
      const kw = search.trim()
      query = query.or(`project_id.ilike.%${kw}%,mbp_part.ilike.%${kw}%,partner_name.ilike.%${kw}%,sales_name.ilike.%${kw}%`)
    }
    const { data } = await query
    if (!data || data.length === 0) return
    const headers = ['狀態', '訂單編號', '序號', '料號', '品名/規格說明', '數量', '交貨日(預)', '客戶名稱', '業務員', '備註']
    const rows = data.map((r) => [
      r.hold_status ?? '',
      r.project_id ?? '',
      r.line_no ?? '',
      r.mbp_part ?? '',
      r.description ?? '',
      r.order_qty_oru ?? '',
      (r.duedate ?? '').slice(0, 10),
      r.partner_name ?? '',
      r.sales_name ?? '',
      r.remark ?? '',
    ])
    const csvContent = [headers, ...rows]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\r\n')
    const bom = '\uFEFF'
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `銷售訂單_${soStatusFilter ?? '全部'}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // SO 列印（當頁）
  const handlePoDocPrint = async (targetDocNo: string) => {
    // 從 DB 重新取得該採購單的所有明細（避免分頁遺漏）
    const { data: allLines } = await supabase
      .from('erp_pj_sync')
      .select('*')
      .eq('doc_no', targetDocNo)
    if (!allLines || allLines.length === 0) return

    // Group records by doc_no (single doc)
    const grouped = new Map<string, typeof records>()
    for (const r of allLines as PjRecord[]) {
      if (!grouped.has(r.doc_no)) grouped.set(r.doc_no, [])
      grouped.get(r.doc_no)!.push(r)
    }

    const poPages = Array.from(grouped.entries()).map(([docNo, lines]) => {
      const hdr = lines[0]
      const extra = hdr.extra as Record<string, unknown> | null | undefined
      const headerRows: [string, string][] = [
        ['採購單號',   docNo],
        ['廠商代號',   hdr.customer_vendor ?? '—'],
        ['開立日',     hdr.start_date ?? '—'],
        ['狀態',       hdr.status ?? '—'],
        ['幣別',       String(extra?.CURRENCY ?? '—')],
        ['匯率',       String(extra?.EXCHANGE_RATE ?? '—')],
        ['稅率',       String(extra?.TAX_RATE ?? '—')],
        ['付款條件',   String(extra?.PAYMENT_TERM ?? '—')],
        ['付款方式',   String(extra?.PAYMENT_MODE ?? '—')],
        ['業務員',     String(extra?.SALES_ID ?? '—')],
        ['PO 類型',    String(extra?.PO_TYPE ?? '—')],
        ['版本',       String(extra?.MODIFY_VER ?? '—')],
      ]
      const headerHtml = `
        <div class="po-header-grid">
          ${headerRows.map(([l, v]) => `<div class="hdr-cell"><span class="hdr-label">${l}</span><span class="hdr-val">${v}</span></div>`).join('')}
        </div>`

      const detailRows = [...lines].sort((a, b) =>
        (a.sub_no ?? '').localeCompare(b.sub_no ?? '', undefined, { numeric: true })
      ).map(r => {
        const rx = r.extra as Record<string, unknown> | null | undefined
        const remark = r.remark ? `<div class="remark">商品備註：${r.remark}</div>` : ''
        const packing = rx?.PACKING ? `<div class="packing">包裝方式：${String(rx.PACKING)}</div>` : ''
        const soLineNo = String(rx?.SO_LINE_NO ?? '')
        const mbpLotNo = String(rx?.MBP_LOT_NO ?? '')
        const soCell = `<div class="soref-lot">${mbpLotNo || '—'}</div><div class="soref-seq">${soLineNo || '—'}</div>`
        return `<tr>
          <td class="tc sn">${r.sub_no ?? '—'}</td>
          <td class="soref-cell">${soCell}</td>
          <td><div class="part">${r.item_code ?? '—'}</div><div class="desc">${r.description ?? ''}</div>${remark}${packing}</td>
          <td class="tr qty">${r.qty > 0 ? r.qty.toLocaleString() : '—'}</td>
          <td class="tc unit">${r.unit ?? '—'}</td>
          <td class="tc duedate">${r.end_date ?? '—'}</td>
        </tr>`
      }).join('')

      return `
        <div class="po-card">
          <div class="po-title-row">
            <div class="po-number">${docNo}</div>
            <div class="po-main-title">採購訂單<br><span class="po-sub-title">Purchase Order</span></div>
            <div class="po-status ${(hdr.status ?? '').toLowerCase()}">${hdr.status !== 'OPEN' ? (hdr.status ?? '') : ''}</div>
          </div>
          <div class="section-title">採購主表</div>
          ${headerHtml}
          <div class="section-title" style="margin-top:10px">採購明細</div>
          <table class="dtl-table">
            <colgroup>
              <col class="col-sn"><col class="col-soref"><col class="col-item">
              <col class="col-qty"><col class="col-unit"><col class="col-due">
            </colgroup>
            <thead><tr>
              <th class="tc">序號</th><th class="tc">銷售單號<br><span style="font-weight:400;font-size:9px;color:#6b7280">銷售序號</span></th><th>貨號 / 品名規格（商品備註）</th>
              <th class="tr">數量</th><th class="tc">單位</th><th class="tc">交貨日</th>
            </tr></thead>
            <tbody>${detailRows}</tbody>
          </table>
          <div class="po-footer">
            <span>共 ${lines.length} 項</span>
            <span>列印時間：${new Date().toLocaleString('zh-TW')}</span>
          </div>
        </div>`
    }).join('')

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>採購訂單列印</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, "Microsoft JhengHei", "PingFang TC", sans-serif; font-size: 18px; margin: 0; background: #ccc; color: #000; }
  .po-card {
    width: 210mm; min-height: 297mm; background: white;
    margin: 0 auto 20px; padding: 14mm 15mm 12mm;
    box-shadow: 0 2px 12px rgba(0,0,0,.25);
    display: flex; flex-direction: column;
    page-break-after: always;
  }
  .po-card:last-child { page-break-after: auto; }
  .po-title-row {
    display: grid; grid-template-columns: 1fr auto 1fr;
    align-items: center; border-bottom: 2.5px solid #000;
    padding-bottom: 8px; margin-bottom: 10px; gap: 12px;
  }
  .po-number {
    font-size: 22px; font-weight: bold; letter-spacing: 1px;
    border: 1px solid #555; background: #f0f0f0;
    padding: 3px 8px; border-radius: 3px; display: inline-block;
  }
  .po-main-title { text-align: center; font-size: 36px; font-weight: 900; letter-spacing: 5px; line-height: 1.2; color: #000; -webkit-text-stroke: 1px #000; }
  .po-sub-title { font-size: 14px; font-weight: 400; color: #666; letter-spacing: 1px; }
  .po-status { text-align: right; font-size: 22px; font-weight: 700; padding: 3px 8px; border-radius: 3px; display: inline-block; justify-self: end; white-space: nowrap; }
  .po-status.open { color: #fff; background: #fff; border: none; }
  .po-status.close { color: #000; background: #fff; border: 1.5px solid #000; }
  .po-status.hold { color: #000; background: #ddd; border: 1.5px solid #000; }
  .section-title { font-size: 14px; font-weight: 700; color: #000; background: #e8e8e8; padding: 4px 8px; border-left: 3px solid #000; margin-bottom: 4px; letter-spacing: 1px; }
  .po-header-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border: 1px solid #aaa; }
  .hdr-cell { display: flex; border-bottom: 1px solid #ccc; border-right: 1px solid #ccc; }
  .hdr-cell:nth-child(4n) { border-right: none; }
  .hdr-cell:nth-last-child(-n+4) { border-bottom: none; }
  .hdr-label { background: #f0f0f0; padding: 4px 8px; font-size: 13px; color: #444; white-space: nowrap; border-right: 1px solid #ccc; min-width: 68px; }
  .hdr-val { padding: 4px 8px; font-weight: 500; font-size: 15px; color: #000; }
  .dtl-table { width: 100%; border-collapse: collapse; font-size: 15px; table-layout: fixed; }
  .col-sn   { width: 40px; }
  .col-soref{ width: 108px; }
  .col-item { }
  .col-qty  { width: 60px; }
  .col-unit { width: 54px; }
  .col-due  { width: 96px; }
  .dtl-table th { background: #e8e8e8; border: 1px solid #aaa; padding: 5px 6px; font-weight: 700; font-size: 13px; color: #000; white-space: nowrap; }
  .dtl-table td { border: 1px solid #ccc; padding: 4px 6px; word-break: break-word; color: #000; }
  .dtl-table td.unit, .dtl-table td.duedate { white-space: nowrap; }
  .dtl-table tr:nth-child(even) td { background: #f7f7f7; }
  .tc { text-align: center; }
  .tr { text-align: right; }
  .part { font-weight: 600; font-family: monospace; color: #000; }
  .desc { font-size: 13px; color: #444; margin-top: 2px; }
  .remark { font-size: 13px; color: #000; background: #efefef; border: 1px solid #bbb; border-radius: 2px; padding: 2px 5px; margin-top: 4px; }
  .packing { font-size: 13px; color: #1a5276; background: #d6eaf8; border: 1px solid #7fb3d3; border-radius: 2px; padding: 2px 5px; margin-top: 3px; }
  .soref-cell { border: 1px solid #ccc; padding: 4px 6px; text-align: center; }
  .soref-lot { font-size: 15px; font-weight: 600; color: #000; white-space: nowrap; }
  .soref-seq { font-size: 13px; color: #444; margin-top: 3px; white-space: nowrap; border-top: 1px dashed #bbb; padding-top: 3px; }
  .po-footer { display: flex; justify-content: space-between; margin-top: 8px; padding-top: 5px; border-top: 1px solid #ccc; font-size: 13px; color: #666; }
  @media print {
    body { background: white; }
    @page { size: A4 portrait; margin: 0; }
    .po-card { box-shadow: none; margin: 0; }
    html { -webkit-filter: grayscale(100%) !important; filter: grayscale(100%) !important; }
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color: #000 !important;
      background: #fff !important;
      border-color: #bbb !important;
      text-shadow: none !important;
      box-shadow: none !important;
    }
  }
</style></head><body>
${poPages}
<script>window.onload=()=>{window.print();};<\/script>
</body></html>`

    const w = window.open('', '_blank', 'width=900,height=800')
    w?.document.write(html)
    w?.document.close()
  }

  const handleSoPrint = () => {
    const headers = ['狀態', '訂單編號', '序號', '料號', '品名/規格說明', '數量', '交貨日(預)', '客戶名稱', '業務員', '備註']
    const rows = soRecords.map((r) => [
      r.hold_status ?? '—',
      r.project_id ?? '—',
      r.line_no ?? '—',
      r.mbp_part ?? '—',
      r.description ?? '—',
      r.order_qty_oru > 0 ? r.order_qty_oru.toLocaleString() : '—',
      r.duedate?.slice(0, 10) ?? '—',
      r.partner_name ?? '—',
      r.sales_name ?? '—',
      r.remark ?? '—',
    ])
    const tableRows = rows.map((row) =>
      `<tr>${row.map((v) => `<td>${v}</td>`).join('')}</tr>`
    ).join('')
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>銷售訂單列印</title>
<style>
  body { font-family: sans-serif; font-size: 11px; margin: 16px; }
  h2 { font-size: 14px; margin-bottom: 8px; }
  p { font-size: 10px; color: #666; margin-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; }
  th { background: #f0f0f0; font-weight: 600; text-align: left; padding: 4px 6px; border: 1px solid #ccc; }
  td { padding: 3px 6px; border: 1px solid #ddd; }
  tr:nth-child(even) td { background: #fafafa; }
  @media print {
    @page { margin: 10mm; size: landscape; }
    html { -webkit-filter: grayscale(100%) !important; filter: grayscale(100%) !important; }
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color: #000 !important;
      background: #fff !important;
      border-color: #bbb !important;
      text-shadow: none !important;
      box-shadow: none !important;
    }
  }
</style></head><body>
<h2>銷售訂單列表</h2>
<p>狀態篩選：${soStatusFilter ?? '全部'} ／ 第 ${soPage} 頁 ／ 列印時間：${new Date().toLocaleString('zh-TW')}</p>
<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>${tableRows}</tbody></table>
<script>window.onload=()=>{window.print();window.close();}<\/script>
</body></html>`
    const w = window.open('', '_blank', 'width=1100,height=700')
    w?.document.write(html)
    w?.document.close()
  }

  // 儲存設定
  useEffect(() => { saveConfig(docKey, config) }, [docKey, config])

  const updateMapping = (key: keyof PjSyncMapping, value: string) => {
    setConfig((prev) => ({ ...prev, mapping: { ...prev.mapping, [key]: value } }))
  }

  const updateFilter = (index: number, field: 'key' | 'value', val: string) => {
    setConfig((prev) => {
      const next = [...prev.filters]
      next[index] = { ...next[index], [field]: val }
      return { ...prev, filters: next }
    })
  }

  const addFilter = () => {
    setConfig((prev) => ({ ...prev, filters: [...prev.filters, { key: '', value: '' }] }))
  }

  const removeFilter = (index: number) => {
    setConfig((prev) => ({ ...prev, filters: prev.filters.filter((_, i) => i !== index) }))
  }

  const handleSync = async () => {
    const cfg = configRef.current
    const isHardcodedTab = isMaterialPrepTab || isSoTab || isMoTab || isInventoryTab || isCustomerTab || isPoTab || isPrTab
    if (!isHardcodedTab && !cfg.table.trim()) {
      setMessage('請先填入 ARGO TABLE 名稱')
      setMessageOk(false)
      setShowConfig(true)
      return
    }
    if (!isHardcodedTab && !cfg.mapping.docNoField.trim()) {
      setMessage('主單號欄位不能為空')
      setMessageOk(false)
      setShowConfig(true)
      return
    }

    setSyncing(true)
    setMessage('')
    setRawSample(null)

    try {
      let res: Response

      if (isSoTab) {
        res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync_so' }),
        })
      } else if (isMoTab) {
        res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync_mo' }),
        })
      } else if (isCustomerTab) {
        res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync_customer' }),
        })
      } else if (isInventoryTab) {
        res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sync_inventory',
            table: 'MM_BOM_BOH_V',
            customColumn: 'PART,PART_DESC,BOH,PO_ON_ROAD',
            filters: { ROWNUM: '<= 10000' },
            mapping: { itemCodeField: 'PART', itemNameField: 'PART_DESC', bookCountField: 'BOH', warehouseTotalField: 'PO_ON_ROAD' },
          }),
        })
      } else if (isMaterialPrepTab) {
        res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync_material_prep' }),
        })
      } else if (isPoTab) {
        res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync_po' }),
        })
      } else {
        const filtersObj: Record<string, string> = {}
        for (const { key, value } of cfg.filters) {
          if (key.trim()) filtersObj[key.trim()] = value
        }
        res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sync_pj',
            table: cfg.table.trim(),
            customColumn: cfg.customColumn.trim() || undefined,
            filters: Object.keys(filtersObj).length > 0 ? filtersObj : undefined,
            docType: meta.label,
            mapping: cfg.mapping,
          }),
        })
      }

      const result = await res.json() as {
        status: string
        error?: string
        syncedCount?: number
        skippedCount?: number
        headerCount?: number
        detailTotal?: number
        detailAuthorized?: boolean
        detailError?: string
        totalRows?: number
        totalHdrRows?: number
        totalDtlRows?: number
        rawSample?: Record<string, unknown>
        rawText?: string
        debugSparam?: Record<string, unknown>
      }

      if (result.rawSample) {
        setRawSample(result.rawSample)
        if (isInventoryTab) setShowRaw(true)
      }

      if (result.status !== 'ok') {
        const sparamInfo = result.debugSparam
          ? `\n\n送出參數：${Object.entries(result.debugSparam).filter(([k]) => !['APIKEY1','APIKEY2','APIKEY3'].includes(k)).map(([k,v]) => `${k}=${String(v)}`).join(', ')}` : ''
        const detail = result.rawText ? `\n\nARGO 原始回應：${result.rawText.slice(0, 300)}` : ''
        setMessage((result.error ?? '同步失敗') + sparamInfo + detail)
        setMessageOk(false)
        if (result.rawSample) setShowRaw(true)
        return
      }

      if (isSoTab) {
        setMessage(`✅ 已同步 ${result.syncedCount ?? 0} 筆銷售訂單明細（ARGO 原始 ${result.totalRows ?? 0} 筆）`)
      } else if (isMoTab) {
        const detailNote = result.detailAuthorized
          ? `明細 ${result.detailTotal ?? 0} 筆`
          : `明細未授權（${result.detailError ?? '未知錯誤'}）`
        setMessage(`✅ 已同步 ${result.syncedCount ?? 0} 筆製令（表頭 ${result.headerCount ?? 0} 筆，${detailNote}）`)
        if (!result.detailAuthorized) setMessageOk(false)
      } else if (isMaterialPrepTab) {
        setMessage(`✅ 已同步 ${result.syncedCount ?? 0} 筆批備料單明細（共 ${result.headerCount ?? 0} 張備料單）`)
      } else if (isPrTab) {
        setMessage(`✅ 已同步 ${result.syncedCount ?? 0} 筆請購明細（表頭 ${result.totalHdrRows ?? 0} 張 / 明細 ${result.totalDtlRows ?? 0} 筆）`)
      } else if (isPoTab) {
        setMessage(`✅ 已同步 ${result.syncedCount ?? 0} 筆採購明細（表頭 ${result.totalHdrRows ?? 0} 張 / 明細 ${result.totalDtlRows ?? 0} 筆）`)
      } else {
        setMessage(`✅ 已同步 ${result.syncedCount ?? 0} 筆 ${meta.label}`)
      }
      setMessageOk(true)
      void fetchRecords(search)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '同步失敗')
      setMessageOk(false)
    } finally {
      setSyncing(false)
    }
  }

  const lastSynced = (isSoTab ? soRecords[0]?.synced_at : isMoTab ? moRecords[0]?.synced_at : isMaterialPrepTab ? materialPrepRecords[0]?.synced_at : records[0]?.synced_at)
    ? new Date((isSoTab ? soRecords[0]?.synced_at : isMoTab ? moRecords[0]?.synced_at : records[0]?.synced_at) as string).toLocaleString('zh-TW')
    : null

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60">
      {/* 頭部 */}
      <div className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-base font-semibold text-white">{meta.label}</h3>
          <p className="mt-1 text-xs text-slate-400">{meta.description}</p>
          {lastSynced && (
            <p className="mt-1 text-xs text-slate-500">
              上次同步：{lastSynced}　共 {(totalCount ?? 0).toLocaleString()} 筆
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isCustomerTab && (
            <button
              type="button"
              onClick={() => setShowConfig((p) => !p)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              {showConfig ? '收合設定' : '展開設定'}
            </button>
          )}
          {!isCustomerTab && (
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') localStorage.removeItem(STORAGE_PREFIX + docKey)
                setConfig(DOC_TYPES[docKey].defaultConfig)
                setShowConfig(true)
                setMessage('')
              }}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            >
              重置預設
            </button>
          )}
          {rawSample && (
            <button
              type="button"
              onClick={() => setShowRaw((p) => !p)}
              className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs font-medium text-amber-300 hover:bg-amber-900/40"
            >
              {showRaw ? '隱藏原始欄位' : '查看原始欄位'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={syncing}
            className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:bg-slate-700 disabled:text-slate-500"
          >
            {syncing ? '同步中...' : `同步 ${meta.label}`}
          </button>
        </div>
      </div>

      {/* 訊息列 */}
      {message && (
        <div className={`border-t border-slate-800 px-4 py-2 text-sm ${messageOk ? 'text-emerald-300' : 'text-red-300'}`}>
          {message}
        </div>
      )}

      {/* 原始欄位預覽 */}
      {showRaw && rawSample && (
        <div className="border-t border-amber-800/40 bg-amber-950/20 px-4 py-3">
          <p className="mb-2 text-xs font-semibold text-amber-400">ARGO 回傳第一筆原始欄位（用來設定下方欄位名稱）</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(rawSample).map(([k, v]) => (
              <span
                key={k}
                className="rounded bg-slate-800 px-2 py-1 font-mono text-xs text-amber-300"
                title={String(v)}
              >
                {k}
                <span className="ml-1 text-slate-500">= {String(v).slice(0, 20)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 客戶資料固定說明 */}
      {isCustomerTab && (
        <div className="border-t border-slate-800 px-4 py-3 flex flex-wrap gap-6 text-xs text-slate-400">
          <span><span className="text-slate-500">TABLE：</span><span className="text-slate-200 font-mono">GL_TRADINGPARTNER</span></span>
          <span><span className="text-slate-500">欄位：</span><span className="text-slate-200 font-mono">PARTNER_ID, CNAME, FULL_CNAME</span></span>
          <span><span className="text-slate-500">過濾：</span><span className="text-slate-200 font-mono">CUSTOMER = Y</span></span>
          <span><span className="text-slate-500">目標表：</span><span className="text-slate-200 font-mono">erp_customers</span></span>
        </div>
      )}

      {/* 設定區 */}
      {!isCustomerTab && showConfig && (
        <div className="border-t border-slate-800 px-4 py-4 space-y-4">
          {/* TABLE / CUSTOMCOLUMN */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-slate-400">TABLE <span className="text-red-400">*</span></label>
              <input
                value={config.table}
                onChange={(e) => !meta.locked?.table && setConfig((p) => ({ ...p, table: e.target.value }))}
                readOnly={!!meta.locked?.table}
                placeholder="PJ_PROJECT 或 PJ_PROJECTDETAIL"
                className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none ${
                  meta.locked?.table
                    ? 'border-slate-700/50 bg-slate-800/50 text-slate-400 cursor-not-allowed'
                    : 'border-slate-700 bg-slate-900 text-slate-200 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30'
                }`}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">CUSTOMCOLUMN（留空 = 查全部欄位）</label>
              <input
                value={config.customColumn}
                onChange={(e) => setConfig((p) => ({ ...p, customColumn: e.target.value }))}
                placeholder="PROJECT_NO,DOC_NO,QTY..."
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              />
            </div>
          </div>

          {/* 過濾條件（動態新增） */}
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs text-slate-400">ARGO 過濾條件（篩選此類型資料用）</span>
              {!meta.locked?.filters && (
              <button
                type="button"
                onClick={addFilter}
                className="rounded bg-slate-800 px-2 py-0.5 text-xs text-cyan-400 hover:bg-slate-700"
              >
                + 新增條件
              </button>
              )}
            </div>
            {config.filters.length === 0 && (
              <p className="text-xs text-slate-600">（無過濾條件，查全部資料）</p>
            )}
            {config.filters.map((f, i) => (
              <div key={i} className="mb-2 flex gap-2">
                <input
                  value={f.key}
                  onChange={(e) => !meta.locked?.filters && updateFilter(i, 'key', e.target.value)}
                  readOnly={!!meta.locked?.filters}
                  placeholder="欄位名稱 例如 DOC_TYPE"
                  className={`flex-1 rounded-lg border px-3 py-1.5 text-xs focus:outline-none ${
                    meta.locked?.filters
                      ? 'border-slate-700/50 bg-slate-800/50 text-slate-400 cursor-not-allowed'
                      : 'border-slate-700 bg-slate-900 text-slate-200 focus:border-cyan-500/50'
                  }`}
                />
                <input
                  value={f.value}
                  onChange={(e) => !meta.locked?.filters && updateFilter(i, 'value', e.target.value)}
                  readOnly={!!meta.locked?.filters}
                  placeholder="值 例如 SO"
                  className={`flex-1 rounded-lg border px-3 py-1.5 text-xs focus:outline-none ${
                    meta.locked?.filters
                      ? 'border-slate-700/50 bg-slate-800/50 text-slate-400 cursor-not-allowed'
                      : 'border-slate-700 bg-slate-900 text-slate-200 focus:border-cyan-500/50'
                  }`}
                />
                {!meta.locked?.filters && (
                <button
                  type="button"
                  onClick={() => removeFilter(i)}
                  className="rounded bg-red-900/30 px-2 text-xs text-red-400 hover:bg-red-900/60"
                >
                  刪
                </button>
                )}
              </div>
            ))}
          </div>

          {/* 欄位映射 */}
          <div>
            <p className="mb-2 text-xs text-slate-400">欄位映射（填 ARGO 實際回傳的欄位名稱）</p>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {activeMappingLabels.map(({ key, label, required }) => {
                const isLocked = meta.locked?.mappingKeys?.includes(key) ?? false
                return (
                  <div key={key}>
                    <label className="mb-1 block text-xs text-slate-500">
                      {label} {required && <span className="text-red-400">*</span>}
                      {isLocked && <span className="ml-1 text-slate-600">🔒</span>}
                    </label>
                    <input
                      value={config.mapping[key]}
                      onChange={(e) => !isLocked && updateMapping(key, e.target.value)}
                      readOnly={isLocked}
                      placeholder={required ? '必填' : '可留空'}
                      className={`w-full rounded-lg border px-3 py-1.5 text-xs focus:outline-none ${
                        isLocked
                          ? 'border-slate-700/50 bg-slate-800/50 text-slate-400 cursor-not-allowed'
                          : 'border-slate-700 bg-slate-900 text-slate-200 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30'
                      }`}
                    />
                  </div>
                )
              })}
            </div>
          </div>

          <p className="text-xs text-slate-600">
            💡 先按「同步」讓 ARGO 回傳資料，再點「查看原始欄位」找到正確的欄位名稱填入上方。
          </p>
        </div>
      )}

      {/* 資料表格 */}
      <div className="border-t border-slate-800">
        <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (isSoTab) { setSoPage(1); void fetchRecords(search, 1) }
                else if (isMaterialPrepTab) { setMaterialPrepPage(1); void fetchRecords(search, 1) }
                else { setMoPage(1); void fetchRecords(search, 1) }
              }
            }}
            placeholder="搜尋單號 / 料號 / 品名..."
            className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 focus:border-cyan-500/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (isSoTab) { setSoPage(1); void fetchRecords(search, 1) }
              else if (isMaterialPrepTab) { setMaterialPrepPage(1); void fetchRecords(search, 1) }
              else { setMoPage(1); void fetchRecords(search, 1) }
            }}
            disabled={loadingRecords}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {loadingRecords ? '載入中...' : '搜尋'}
          </button>
          {isSoTab && (
            <div className="flex gap-1">
              {(['OPEN', 'HOLD', 'CLOSE', null] as const).map((s) => (
                <button
                  key={String(s)}
                  type="button"
                  onClick={() => handleSoStatusFilter(s)}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    soStatusFilter === s
                      ? s === 'OPEN'  ? 'bg-green-700 text-white'
                        : s === 'HOLD'  ? 'bg-yellow-700 text-white'
                        : s === 'CLOSE' ? 'bg-slate-600 text-white'
                        : 'bg-cyan-700 text-white'
                      : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-white'
                  }`}
                >
                  {s ?? '全部'}
                </button>
              ))}
            </div>
          )}
          {isMoTab && (
            <div className="flex gap-1">
              {(['OPEN', 'HOLD', 'CLOSE', null] as const).map((s) => (
                <button
                  key={String(s)}
                  type="button"
                  onClick={() => handleMoStatusFilter(s)}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    moStatusFilter === s
                      ? s === 'OPEN'  ? 'bg-green-700 text-white'
                        : s === 'HOLD'  ? 'bg-yellow-700 text-white'
                        : s === 'CLOSE' ? 'bg-slate-600 text-white'
                        : 'bg-cyan-700 text-white'
                      : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-white'
                  }`}
                >
                  {s ?? '全部'}
                </button>
              ))}
            </div>
          )}
          {isPoTab && (
            <div className="flex gap-1">
              {(['OPEN', 'HOLD', 'CLOSE', null] as const).map((s) => (
                <button
                  key={String(s)}
                  type="button"
                  onClick={() => handlePoStatusFilter(s)}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    poStatusFilter === s
                      ? s === 'OPEN'  ? 'bg-green-700 text-white'
                        : s === 'HOLD'  ? 'bg-yellow-700 text-white'
                        : s === 'CLOSE' ? 'bg-slate-600 text-white'
                        : 'bg-cyan-700 text-white'
                      : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-white'
                  }`}
                >
                  {s ?? '全部'}
                </button>
              ))}
            </div>
          )}
          {isPrTab && (
            <div className="flex gap-1">
              {(['OPEN', 'HOLD', 'CLOSE', null] as const).map((s) => (
                <button
                  key={String(s)}
                  type="button"
                  onClick={() => handlePoStatusFilter(s)}
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    poStatusFilter === s
                      ? s === 'OPEN'  ? 'bg-green-700 text-white'
                        : s === 'HOLD'  ? 'bg-yellow-700 text-white'
                        : s === 'CLOSE' ? 'bg-slate-600 text-white'
                        : 'bg-cyan-700 text-white'
                      : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-white'
                  }`}
                >
                  {s ?? '全部'}
                </button>
              ))}
            </div>
          )}
          {(isSoTab || isMoTab || isMaterialPrepTab) && totalCount !== null && (
            <span className="text-xs text-slate-500 ml-auto">
              共 {totalCount.toLocaleString()} 筆
            </span>
          )}
          {isSoTab && (
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void handleSoExportCsv()}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-emerald-400 hover:bg-slate-800"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1M8 12l4 4m0 0l4-4m-4 4V4" /></svg>
                匯出 CSV
              </button>
              <button
                type="button"
                onClick={handleSoPrint}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-sky-400 hover:bg-slate-800"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z" /></svg>
                列印
              </button>
            </div>
          )}
          {isMoTab && (
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void handleMoExportCsv()}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-emerald-400 hover:bg-slate-800"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1M8 12l4 4m0 0l4-4m-4 4V4" /></svg>
                匯出 CSV
              </button>
              <button
                type="button"
                onClick={handleMoPrint}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-sky-400 hover:bg-slate-800"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z" /></svg>
                列印
              </button>
            </div>
          )}

          {!isSoTab && !isMoTab && totalCount !== null && totalCount > 200 && (
            <span className="text-xs text-slate-500">顯示前 200 筆 / 共 {totalCount.toLocaleString()} 筆</span>
          )}
        </div>

        {(isSoTab ? soRecords.length === 0 : isMoTab ? moRecords.length === 0 : isMaterialPrepTab ? materialPrepRecords.length === 0 : records.length === 0) && !loadingRecords ? (
          <p className="px-4 pb-4 text-xs text-slate-600">尚無資料，請先執行同步。{isSoTab ? '（需先在 Supabase 建立 erp_so_lines 表）' : isMoTab ? '（需先在 Supabase 建立 erp_mo_lines 表）' : isMaterialPrepTab ? '（需先在 Supabase 建立 erp_material_prep_lines 表）' : ''}</p>
        ) : isMaterialPrepTab ? (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/50">
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">備料單號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">備料單日期</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">製令單號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">製品貨號</th>
                  <th className="px-3 py-2 text-right text-slate-400 font-medium">生產數量</th>
                  <th className="px-3 py-2 text-center text-slate-400 font-medium">序號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">料號</th>
                  <th className="px-3 py-2 text-right text-slate-400 font-medium">應發數量</th>
                </tr>
              </thead>
              <tbody>
                {materialPrepRecords.map((r) => (
                  <tr key={r.id} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                    <td className="px-3 py-2 font-mono text-cyan-300">{r.slip_no}</td>
                    <td className="px-3 py-2 text-slate-400">{r.slip_date ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-slate-300">{r.mo_number ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-slate-200">{r.fg_part ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-slate-200">{r.mo_qty > 0 ? r.mo_qty.toLocaleString() : '—'}</td>
                    <td className="px-3 py-2 text-center text-slate-400">{r.line_no ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-slate-200">{r.mbp_part ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-emerald-300">{r.notice_qty > 0 ? r.notice_qty.toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 批備料單 分頁列 */}
          {totalCount !== null && totalCount > 20 && (
            <div className="flex items-center justify-between border-t border-slate-800 px-4 py-2.5">
              <span className="text-xs text-slate-500">
                第 {materialPrepPage} 頁 / 共 {Math.ceil(totalCount / 20)} 頁（{totalCount.toLocaleString()} 筆）
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleMaterialPrepPageChange(materialPrepPage - 1)}
                  disabled={materialPrepPage <= 1}
                  className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  上一頁
                </button>
                <button
                  type="button"
                  onClick={() => handleMaterialPrepPageChange(materialPrepPage + 1)}
                  disabled={materialPrepPage * 20 >= totalCount}
                  className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  下一頁
                </button>
              </div>
            </div>
          )}
          </>
        ) : isSoTab ? (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/50">
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">狀態</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">訂單編號</th>
                  <th className="px-3 py-2 text-center text-slate-400 font-medium">序號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">料號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">品名/規格說明</th>
                  <th className="px-3 py-2 text-right text-slate-400 font-medium">數量</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">交貨日(預)</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">客戶名稱 / 業務員</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">打樣/追加單號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">備註</th>
                  <th className="px-3 py-2 text-center text-slate-400 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {soRecords.map((r) => (
                  <tr key={r.id} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                    <td className="px-3 py-2">
                      {r.hold_status ? (
                        <span className={`rounded px-1.5 py-0.5 text-xs ${
                          r.hold_status === 'OPEN'  ? 'bg-green-900/40 text-green-300' :
                          r.hold_status === 'HOLD'  ? 'bg-yellow-900/40 text-yellow-300' :
                          r.hold_status === 'CLOSE' ? 'bg-slate-800 text-slate-500' :
                          'bg-slate-800 text-slate-300'
                        }`}>{r.hold_status}</span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      <button onClick={() => setSoModalId(r.project_id)} className="text-cyan-300 hover:text-cyan-100 hover:underline underline-offset-2 text-left">{r.project_id}</button>
                    </td>
                    <td className="px-3 py-2 text-center text-slate-400">{r.line_no || '—'}</td>
                    <td className="px-3 py-2 font-mono text-slate-200">{r.mbp_part ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-200 max-w-[200px]"><div className="line-clamp-2" title={r.description ?? ''}>{r.description ?? '—'}</div></td>
                    <td className="px-3 py-2 text-right text-slate-200">{r.order_qty_oru > 0 ? r.order_qty_oru.toLocaleString() : '—'}</td>
                    <td className="px-3 py-2 text-yellow-400/80">{r.duedate?.slice(0, 10) ?? '—'}</td>
                    <td className="px-3 py-2">
                      <div className="text-slate-300 max-w-[160px] truncate" title={r.partner_name ?? ''}>{r.partner_name ?? '—'}</div>
                      <div className="text-slate-500 text-[11px] mt-0.5">{r.sales_name ?? '—'}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-sky-400/90 text-xs">{r.tpn_part_no ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-400 max-w-[160px] truncate" title={r.remark ?? ''}>{r.remark ?? '—'}</td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => openMoModalFromSo(r)}
                        className="rounded bg-green-700/80 px-2 py-1 text-xs text-white hover:bg-green-600 transition-colors"
                      >新增製令</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* SO 分頁列 */}
          {totalCount !== null && totalCount > SO_PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-slate-800 px-4 py-2.5">
              <span className="text-xs text-slate-500">
                第 {soPage} 頁 / 共 {Math.ceil(totalCount / SO_PAGE_SIZE)} 頁（{totalCount.toLocaleString()} 筆）
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleSoPageChange(soPage - 1)}
                  disabled={soPage <= 1}
                  className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  上一頁
                </button>
                {Array.from({ length: Math.min(7, Math.ceil(totalCount / SO_PAGE_SIZE)) }, (_, i) => {
                  const totalPages = Math.ceil(totalCount / SO_PAGE_SIZE)
                  let page: number
                  if (totalPages <= 7) {
                    page = i + 1
                  } else if (soPage <= 4) {
                    page = i + 1
                    if (i === 6) page = totalPages
                    if (i === 5) page = -1
                  } else if (soPage >= totalPages - 3) {
                    page = i === 0 ? 1 : i === 1 ? -1 : totalPages - (6 - i)
                  } else {
                    const map = [1, -1, soPage - 1, soPage, soPage + 1, -2, totalPages]
                    page = map[i]
                  }
                  if (page < 0) return (
                    <span key={`ellipsis-${i}`} className="px-1 text-xs text-slate-600">…</span>
                  )
                  return (
                    <button
                      key={page}
                      type="button"
                      onClick={() => handleSoPageChange(page)}
                      className={`min-w-[28px] rounded border px-1.5 py-1 text-xs transition-colors ${
                        soPage === page
                          ? 'border-cyan-600 bg-cyan-700 text-white'
                          : 'border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      {page}
                    </button>
                  )
                })}
                <button
                  type="button"
                  onClick={() => handleSoPageChange(soPage + 1)}
                  disabled={soPage * SO_PAGE_SIZE >= totalCount}
                  className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  下一頁
                </button>
              </div>
            </div>
          )}
          </>
        ) : isMoTab ? (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/50">
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">狀態</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">製令單號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">來源訂單</th>
                  <th className="px-3 py-2 text-center text-slate-400 font-medium">編號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">生產貨號</th>
                  <th className="px-3 py-2 text-right text-slate-400 font-medium">預訂產出量</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">預定結案日</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">開立日期</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">批號</th>
                </tr>
              </thead>
              <tbody>
                {moRecords.map((r) => (
                  <tr key={r.id} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                    <td className="px-3 py-2">
                      {r.hold_status ? (
                        <span className={`rounded px-1.5 py-0.5 ${
                          r.hold_status === 'OPEN'  ? 'bg-green-900/40 text-green-300' :
                          r.hold_status === 'HOLD'  ? 'bg-yellow-900/40 text-yellow-300' :
                          r.hold_status === 'CLOSE' ? 'bg-slate-800 text-slate-500' :
                          'bg-slate-800 text-slate-300'
                        }`}>{r.hold_status}</span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-cyan-300">{r.project_id}</td>
                    <td className="px-3 py-2 font-mono">
                      {r.source_order
                        ? <button onClick={() => setSoModalId(r.source_order!)} className="text-amber-300/80 hover:text-amber-200 hover:underline underline-offset-2 text-left">{r.source_order}</button>
                        : '—'
                      }
                    </td>
                    <td className="px-3 py-2 text-center text-slate-400">{r.line_no || '—'}</td>
                    <td className="px-3 py-2 font-mono text-slate-200">{r.mbp_part ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-slate-200">{r.order_qty > 0 ? r.order_qty.toLocaleString() : '—'}</td>
                    <td className="px-3 py-2 text-slate-400">{r.end_date ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-400">{r.mo_begin_date ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-400">{r.mbp_lot_no ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* MO 分頁列 */}
          {totalCount !== null && totalCount > MO_PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-slate-800 px-4 py-2.5">
              <span className="text-xs text-slate-500">
                第 {moPage} 頁 / 共 {Math.ceil(totalCount / MO_PAGE_SIZE)} 頁（{totalCount.toLocaleString()} 筆）
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleMoPageChange(moPage - 1)}
                  disabled={moPage <= 1}
                  className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  上一頁
                </button>
                {Array.from({ length: Math.min(7, Math.ceil(totalCount / MO_PAGE_SIZE)) }, (_, i) => {
                  const totalPages = Math.ceil(totalCount / MO_PAGE_SIZE)
                  let page: number
                  if (totalPages <= 7) {
                    page = i + 1
                  } else if (moPage <= 4) {
                    page = i + 1
                    if (i === 6) page = totalPages
                    if (i === 5) page = -1
                  } else if (moPage >= totalPages - 3) {
                    page = i === 0 ? 1 : i === 1 ? -1 : totalPages - (6 - i)
                  } else {
                    const map = [1, -1, moPage - 1, moPage, moPage + 1, -2, totalPages]
                    page = map[i]
                  }
                  if (page < 0) return (
                    <span key={`ellipsis-${i}`} className="px-1 text-xs text-slate-600">…</span>
                  )
                  return (
                    <button
                      key={page}
                      type="button"
                      onClick={() => handleMoPageChange(page)}
                      className={`min-w-[28px] rounded border px-1.5 py-1 text-xs transition-colors ${
                        moPage === page
                          ? 'border-cyan-600 bg-cyan-700 text-white'
                          : 'border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      {page}
                    </button>
                  )
                })}
                <button
                  type="button"
                  onClick={() => handleMoPageChange(moPage + 1)}
                  disabled={moPage * MO_PAGE_SIZE >= totalCount}
                  className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  下一頁
                </button>
              </div>
            </div>
          )}
          </>
        ) : isCustomerTab ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/50">
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">客戶代號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">公司簡稱</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">公司全名</th>
                </tr>
              </thead>
              <tbody>
                {customerRecords.map((r) => (
                  <tr key={r.id} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                    <td className="px-3 py-2 font-mono text-cyan-300 whitespace-nowrap">{r.partner_id}</td>
                    <td className="px-3 py-2 text-slate-200">{r.cname || '—'}</td>
                    <td className="px-3 py-2 text-slate-400 max-w-[300px] truncate">{r.full_cname ?? '—'}</td>
                  </tr>
                ))}
                {!loadingRecords && customerRecords.length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-8 text-center text-slate-600">尚無資料，請先執行同步。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/50">
                  {isInventoryTab ? (<>
                    <th className="px-3 py-2 text-left text-slate-400 font-medium">料號</th>
                    <th className="px-3 py-2 text-left text-slate-400 font-medium">品名/規格</th>
                    <th className="px-3 py-2 text-right text-slate-400 font-medium">庫存數量</th>
                    <th className="px-3 py-2 text-right text-slate-400 font-medium">在途數量</th>
                    <th className="px-3 py-2 text-left text-slate-400 font-medium">單位</th>
                    <th className="px-3 py-2 text-right text-slate-400 font-medium">實際數量</th>
                  </>) : (isPoTab || isPrTab || isSubcontractTab) ? (<>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium whitespace-nowrap">狀態</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium whitespace-nowrap">{isPrTab ? '請購單號' : isPoTab ? '採購單號' : '製令單號'}</th>
                  <th className="px-2 py-2 text-center text-slate-400 font-medium whitespace-nowrap">序號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium whitespace-nowrap">貨號／品名規格</th>
                  <th className="px-2 py-2 text-right text-slate-400 font-medium whitespace-nowrap">數量</th>
                  <th className="px-2 py-2 text-left text-slate-400 font-medium whitespace-nowrap">單位</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium whitespace-nowrap">開立日／交貨日</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium whitespace-nowrap">廠商編號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium whitespace-nowrap">備註2</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium whitespace-nowrap">批號</th>
                  <th className="px-2 py-2 text-center text-slate-400 font-medium whitespace-nowrap">廠商料號</th>
                  {isPoTab && <th className="px-2 py-2 text-center text-slate-400 font-medium whitespace-nowrap">列印</th>}
                  </>) : (<>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">主單號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">子序號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">料號</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">品名</th>
                  <th className="px-3 py-2 text-right text-slate-400 font-medium">數量</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">單位</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">狀態</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">開始日</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">結束日</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">客戶/廠商</th>
                  <th className="px-3 py-2 text-left text-slate-400 font-medium">備註</th>
                  </>)}
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  isInventoryTab ? (() => { const inv = r as unknown as InventoryRecord; return (
                    <tr key={r.id} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                      <td className="px-3 py-2 font-mono text-cyan-300">{inv.item_code || '—'}</td>
                      <td className="px-3 py-2 text-slate-300 max-w-[200px] truncate">{[inv.item_name, inv.spec].filter(Boolean).join(' ') || '—'}</td>
                      <td className="px-3 py-2 text-right text-emerald-300 font-medium">{inv.book_count > 0 ? inv.book_count.toLocaleString() : '0'}</td>
                      <td className="px-3 py-2 text-right text-amber-300">{inv.qisheng_sichuan_total > 0 ? inv.qisheng_sichuan_total.toLocaleString() : '0'}</td>
                      <td className="px-3 py-2 text-slate-400">{inv.unit_of_measure ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-400">{inv.physical_count > 0 ? inv.physical_count.toLocaleString() : '0'}</td>
                    </tr>
                  )})() : (isPoTab || isPrTab || isSubcontractTab) ? (
                    <tr key={r.id} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                      <td className="px-3 py-2">
                        {r.status ? (
                          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                            r.status === 'OPEN' ? 'bg-emerald-900/40 text-emerald-300' :
                            r.status === 'CLOSE' ? 'bg-slate-700 text-slate-400' :
                            'bg-amber-900/40 text-amber-300'
                          }`}>{r.status}</span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-cyan-300 whitespace-nowrap">{r.doc_no}</td>
                      <td className="px-2 py-2 text-center text-slate-400 font-mono">{r.sub_no || '—'}</td>
                      <td className="px-3 py-2 max-w-[200px]">
                        <div className="font-mono text-purple-300 whitespace-nowrap">{r.item_code || '—'}</div>
                        <div className="text-slate-400 text-xs line-clamp-2" title={r.description ?? ''}>{r.description || ''}</div>
                      </td>
                      <td className="px-2 py-2 text-right text-slate-300">{r.qty > 0 ? r.qty.toLocaleString() : '—'}</td>
                      <td className="px-2 py-2 text-slate-400">{r.unit || '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="text-slate-400">{r.start_date ?? '—'}</div>
                        <div className="text-yellow-400/80 text-xs">{r.end_date ?? ''}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-orange-300 whitespace-nowrap">{r.customer_vendor || '—'}</td>
                      <td className="px-3 py-2 text-slate-400 max-w-[140px] truncate" title={r.remark ?? ''}>{r.remark || '—'}</td>
                      <td className="px-3 py-2 font-mono text-teal-300 whitespace-nowrap">{String(r.extra?.MBP_LOT_NO ?? '—')}</td>
                      <td className="px-2 py-2 text-center font-mono text-sky-200">{String(r.extra?.TPN_PART_NO ?? '—')}</td>
                      {isPoTab && (
                        <td className="px-2 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => void handlePoDocPrint(r.doc_no)}
                            className="flex items-center gap-0.5 rounded border border-slate-600 bg-slate-800 px-2 py-0.5 text-xs text-sky-400 hover:bg-slate-700"
                          >
                            <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z" /></svg>
                            列印
                          </button>
                        </td>
                      )}
                    </tr>
                  ) : (
                    <tr key={r.id} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                      <td className="px-3 py-2 font-mono text-cyan-300">{r.doc_no}</td>
                      <td className="px-3 py-2 text-slate-400">{r.sub_no || '—'}</td>
                      <td className="px-3 py-2 font-mono text-slate-300">{r.item_code ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-300 max-w-[160px]"><div className="line-clamp-2">{r.description ?? '—'}</div></td>
                      <td className="px-3 py-2 text-right text-slate-300">{r.qty > 0 ? r.qty.toLocaleString() : '—'}</td>
                      <td className="px-3 py-2 text-slate-400">{r.unit ?? '—'}</td>
                      <td className="px-3 py-2">
                        {r.status ? (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">{r.status}</span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2 text-slate-400">{r.start_date ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-400">{r.end_date ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-300 max-w-[120px] truncate">{r.customer_vendor ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-400 max-w-[120px] truncate">{r.remark ?? '—'}</td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── 手動新增製令 modal ──────────────────────── */}
      {soMoModal.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl bg-slate-800 border border-slate-700 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">
              <h2 className="text-base font-semibold text-white">✏️ 新增製令</h2>
              <button onClick={() => setSoMoModal(p => ({ ...p, show: false }))} className="text-slate-400 hover:text-white text-lg leading-none">✕</button>
            </div>
            <div className="p-5 space-y-3">
              {/* MO number preview */}
              {soMoModal.form.order_number && soMoModal.form.line_no && (
                <p className="text-xs text-cyan-400">
                  製令單號預覽：
                  <span className="font-mono font-bold">
                    {`MO${soMoModal.form.factory === 'O' ? 'O' : soMoModal.form.factory}${parseSoDate(soMoModal.form.order_number)}${String(Number(soMoModal.form.line_no) || 0).padStart(2,'0')}`}
                  </span>
                </p>
              )}
              {/* Factory */}
              <div>
                <label className="mb-1 block text-xs text-slate-400">工廠別</label>
                <div className="flex gap-3">
                  {(['T','C','O'] as const).map(f => (
                    <label key={f} className="flex items-center gap-1 text-sm text-slate-200 cursor-pointer">
                      <input type="radio" name="moFactory" value={f}
                        checked={soMoModal.form.factory === f}
                        onChange={() => setSoMoModal(p => ({ ...p, form: { ...p.form, factory: f } }))}
                      />
                      {f === 'T' ? '台廠(T)' : f === 'C' ? '中廠(C)' : '其他(O)'}
                    </label>
                  ))}
                </div>
              </div>
              {/* Row 1: order_number + line_no */}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-slate-400">來源訂單號 *</label>
                  <input className="w-full rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-500"
                    value={soMoModal.form.order_number}
                    onChange={e => setSoMoModal(p => ({ ...p, form: { ...p.form, order_number: e.target.value }, errors: { ...p.errors, order_number: '' } }))}
                  />
                  {soMoModal.errors.order_number && <p className="text-xs text-red-400 mt-0.5">{soMoModal.errors.order_number}</p>}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">項號 *</label>
                  <input type="number" min={1} className="w-full rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-500"
                    value={soMoModal.form.line_no}
                    onChange={e => setSoMoModal(p => ({ ...p, form: { ...p.form, line_no: e.target.value }, errors: { ...p.errors, line_no: '' } }))}
                  />
                  {soMoModal.errors.line_no && <p className="text-xs text-red-400 mt-0.5">{soMoModal.errors.line_no}</p>}
                </div>
              </div>
              {/* Row 2: item_code + quantity */}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-slate-400">品項料號 *</label>
                  <input className="w-full rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-cyan-500"
                    value={soMoModal.form.item_code}
                    onChange={e => setSoMoModal(p => ({ ...p, form: { ...p.form, item_code: e.target.value }, errors: { ...p.errors, item_code: '' } }))}
                  />
                  {soMoModal.errors.item_code && <p className="text-xs text-red-400 mt-0.5">{soMoModal.errors.item_code}</p>}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">數量 *</label>
                  <input type="number" min={0} step="any" className="w-full rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-500"
                    value={soMoModal.form.quantity}
                    onChange={e => setSoMoModal(p => ({ ...p, form: { ...p.form, quantity: e.target.value }, errors: { ...p.errors, quantity: '' } }))}
                  />
                  {soMoModal.errors.quantity && <p className="text-xs text-red-400 mt-0.5">{soMoModal.errors.quantity}</p>}
                </div>
              </div>
              {/* item_name */}
              <div>
                <label className="mb-1 block text-xs text-slate-400">品名/規格說明</label>
                <input className="w-full rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-500"
                  value={soMoModal.form.item_name}
                  onChange={e => setSoMoModal(p => ({ ...p, form: { ...p.form, item_name: e.target.value } }))}
                />
              </div>
              {/* delivery_date + customer */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">交貨期限 *</label>
                  <input type="date" className="w-full rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-500"
                    value={soMoModal.form.delivery_date}
                    onChange={e => setSoMoModal(p => ({ ...p, form: { ...p.form, delivery_date: e.target.value }, errors: { ...p.errors, delivery_date: '' } }))}
                  />
                  {soMoModal.errors.delivery_date && <p className="text-xs text-red-400 mt-0.5">{soMoModal.errors.delivery_date}</p>}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">客戶名稱</label>
                  <input className="w-full rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-500"
                    value={soMoModal.form.customer}
                    onChange={e => setSoMoModal(p => ({ ...p, form: { ...p.form, customer: e.target.value } }))}
                  />
                </div>
              </div>
              {/* note */}
              <div>
                <label className="mb-1 block text-xs text-slate-400">備註</label>
                <input className="w-full rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-500"
                  value={soMoModal.form.note}
                  onChange={e => setSoMoModal(p => ({ ...p, form: { ...p.form, note: e.target.value } }))}
                />
              </div>
              {/* status message */}
              {soMoModal.msg && (
                <p className={`text-sm rounded px-3 py-2 ${soMoModal.msg.startsWith('✅') ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
                  {soMoModal.msg}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-slate-700 px-5 py-3">
              <button onClick={() => setSoMoModal(p => ({ ...p, show: false }))}
                className="rounded bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600">取消</button>
              <button onClick={handleSubmitSoMo} disabled={soMoModal.importing}
                className="rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-50">
                {soMoModal.importing ? '送出中…' : '送出製令'}
              </button>
            </div>
          </div>
        </div>
      )}
      <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />
    </div>
  )
}

// ─── BOM 結構同步卡片（獨立元件，不走 SyncCard 複雜邏輯）──────
function BomSyncCard({ resetKey }: { resetKey?: number }) {
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgOk, setMsgOk] = useState(true)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)

  useEffect(() => {
    supabase.from('mm_bom_structure')
      .select('synced_at', { count: 'exact', head: false })
      .order('synced_at', { ascending: false }).limit(1)
      .then(({ data, count }) => {
        if (data?.[0]) setSyncedAt((data[0] as { synced_at: string }).synced_at)
        if (count !== null) setTotal(count)
      })
  }, [resetKey])

  const handleSync = async () => {
    setSyncing(true)
    setMsg(null)
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_bom_structure' }),
      })
      const json = await res.json() as { status: string; syncedCount?: number; totalFromArgo?: number; error?: string }
      if (json.status === 'ok') {
        setMsgOk(true)
        setMsg(`✅ 同步完成：${json.syncedCount ?? 0} 筆（ARGO 取得 ${json.totalFromArgo ?? 0} 筆）`)
        setSyncedAt(new Date().toISOString())
        setTotal(json.syncedCount ?? null)
      } else {
        setMsgOk(false)
        setMsg(`❌ 同步失敗：${json.error ?? '未知錯誤'}`)
      }
    } catch (e) {
      setMsgOk(false)
      setMsg(`❌ ${e instanceof Error ? e.message : '連線錯誤'}`)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 max-w-2xl">
      <div className="flex flex-col gap-1 mb-5">
        <h2 className="text-lg font-bold text-white">BOM 結構同步</h2>
        <p className="text-xs text-slate-400">來源：ARGO ERP <span className="font-mono text-slate-300">MM_BOM_STRUCTURE</span>，目標：Supabase <span className="font-mono text-slate-300">mm_bom_structure</span></p>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="rounded-xl bg-slate-800/60 px-4 py-3">
          <p className="text-xs text-slate-500 mb-1">目前 Supabase 筆數</p>
          <p className="text-2xl font-bold font-mono text-cyan-300">{total !== null ? total.toLocaleString() : '—'}</p>
        </div>
        <div className="rounded-xl bg-slate-800/60 px-4 py-3">
          <p className="text-xs text-slate-500 mb-1">最後同步時間</p>
          <p className="text-sm font-mono text-slate-300">{syncedAt ? new Date(syncedAt).toLocaleString('zh-TW', { hour12: false }) : '尚未同步'}</p>
        </div>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={syncing}
          className="px-6 py-2.5 rounded-xl bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
        >
          {syncing ? '⏳ 同步中...' : '⟳ 立即同步 ARGO'}
        </button>
        {msg && <span className={`text-sm ${msgOk ? 'text-emerald-400' : 'text-red-400'}`}>{msg}</span>}
      </div>

      <div className="mt-6 rounded-xl border border-slate-700 bg-slate-800/40 p-4 text-xs text-slate-400 space-y-1">
        <p><span className="text-slate-300 font-medium">同步邏輯：</span>批次 500 筆，依 (parent_part, bom_ver, child_part, child_ver, line_no) UPSERT</p>
        <p><span className="text-slate-300 font-medium">欄位：</span>parent_part、bom_ver、child_part、child_ver、line_no、child_qty、child_scrap、lot_child_qty、lot_base</p>
        <p><span className="text-slate-300 font-medium">瀏覽/查詢：</span>前往 <a href="/admin/argoerp/erp-db/bom" className="text-cyan-400 underline hover:text-cyan-300">ERP DB → BOM 結構</a></p>
      </div>
    </div>
  )
}

// ─── 主頁面 ──────────────────────────────────────────
const TABS: { key: DocTypeKey; label: string }[] = [
  { key: 'sales', label: '銷售訂單' },
  { key: 'mo', label: '製令單號' },
  { key: 'pr', label: '請購單號' },
  { key: 'po', label: '採購單號' },
  { key: 'subcontract', label: '委外製令' },
  { key: 'inventory', label: '倉庫庫存' },
  { key: 'material_prep', label: '批備料單' },
  { key: 'customer', label: '客戶資料' },
  { key: 'bom_structure', label: 'BOM 結構' },
]

export default function ErpSyncPage() {
  const [activeTab, setActiveTab] = useState<DocTypeKey>('sales')

  // ---- 全表同步 ----
  type SyncStep = { key: DocTypeKey; label: string; status: 'pending' | 'running' | 'done' | 'error'; message: string }
  const [syncAllOpen, setSyncAllOpen] = useState(false)
  const [syncAllSteps, setSyncAllSteps] = useState<SyncStep[]>([])
  const [syncAllRunning, setSyncAllRunning] = useState(false)
  const [syncAllLastTime, setSyncAllLastTime] = useState<Date | null>(null)

  const handleSyncAll = async () => {
    const steps: SyncStep[] = TABS.map(t => ({ key: t.key, label: t.label, status: 'pending', message: '' }))
    setSyncAllSteps(steps)
    setSyncAllOpen(true)
    setSyncAllRunning(true)

    const updateStep = (index: number, patch: Partial<SyncStep>) => {
      setSyncAllSteps(prev => prev.map((s, i) => i === index ? { ...s, ...patch } : s))
    }

    for (let i = 0; i < TABS.length; i++) {
      const tab = TABS[i]
      updateStep(i, { status: 'running' })
      try {
        let res: Response
        if (tab.key === 'sales') {
          res = await fetch('/api/argoerp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync_so' }) })
        } else if (tab.key === 'mo') {
          res = await fetch('/api/argoerp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync_mo' }) })
        } else if (tab.key === 'pr') {
          res = await fetch('/api/argoerp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync_pr' }) })
        } else if (tab.key === 'po') {
          res = await fetch('/api/argoerp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync_po' }) })
        } else if (tab.key === 'subcontract') {
          res = await fetch('/api/argoerp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync_pj', table: 'PJ_PROJECT',
              customColumn: 'PROJECT_ID,PROJECT_NAME,HOLD_STATUS,BEGIN_DATE,END_DATE,IN_CHARGE',
              filters: { PJT_TYPE: "= 'OO'" }, docType: '委外製令',
              mapping: { docNoField: 'PROJECT_ID', subNoField: '', itemCodeField: '', descriptionField: 'PROJECT_NAME', qtyField: '', unitField: '', statusField: 'HOLD_STATUS', startDateField: 'BEGIN_DATE', endDateField: 'END_DATE', customerVendorField: 'IN_CHARGE', remarkField: '' } }) })
        } else if (tab.key === 'inventory') {
          res = await fetch('/api/argoerp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'sync_inventory',
              table: 'MM_BOM_BOH_V',
              customColumn: 'PART,PART_DESC,BOH,PO_ON_ROAD',
              filters: { ROWNUM: '<= 10000' },
              mapping: { itemCodeField: 'PART', itemNameField: 'PART_DESC', bookCountField: 'BOH', warehouseTotalField: 'PO_ON_ROAD' },
            }) })
        } else if (tab.key === 'material_prep') {
          res = await fetch('/api/argoerp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync_material_prep' }) })
        } else if (tab.key === 'customer') {
          res = await fetch('/api/argoerp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync_customer' }) })
        } else if (tab.key === 'bom_structure') {
          res = await fetch('/api/argoerp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync_bom_structure' }) })
        } else {
          // fallback for unknown tab keys
          continue
        }
        const result = await res.json() as { status: string; error?: string; syncedCount?: number; totalRows?: number; totalJoinRows?: number; totalHdrRows?: number; totalDtlRows?: number; headerCount?: number; detailTotal?: number; detailAuthorized?: boolean; rawText?: string; debugSparam?: Record<string, unknown> }
        if (result.status !== 'ok') {
          const sparamInfo = result.debugSparam
            ? `\n送出參數：${Object.entries(result.debugSparam).map(([k,v]) => `${k}=${String(v)}`).join(', ')}` : ''
          const detail = result.rawText ? `\nARGO 原始回應：${result.rawText.slice(0, 500)}` : ''
          updateStep(i, { status: 'error', message: (result.error ?? '同步失敗') + sparamInfo + detail })
        } else {
          let msg = ''
          if (tab.key === 'sales') msg = `已同步 ${result.syncedCount ?? 0} 筆（ARGO ${result.totalRows ?? 0} 筆）`
          else if (tab.key === 'pr') msg = `已同步 ${result.syncedCount ?? 0} 筆請購明細（表頭 ${result.totalHdrRows ?? 0} 張 / 明細 ${result.totalDtlRows ?? 0} 筆）`
          else if (tab.key === 'po') msg = `已同步 ${result.syncedCount ?? 0} 筆採購明細（表頭 ${result.totalHdrRows ?? 0} 張 / 明細 ${result.totalDtlRows ?? 0} 筆）`
          else if (tab.key === 'mo') msg = `已同步 ${result.syncedCount ?? 0} 筆（表頭 ${result.headerCount ?? 0}，明細 ${result.detailTotal ?? 0}）`
          else if (tab.key === 'material_prep') msg = `已同步 ${result.syncedCount ?? 0} 筆（表頭 ${result.headerCount ?? 0} 張，明細 ${result.detailTotal ?? 0} 筆）`
          else if (tab.key === 'bom_structure') msg = `已同步 ${result.syncedCount ?? 0} 筆（ARGO ${(result as Record<string, unknown>).totalFromArgo ?? 0} 筆）`
          else msg = `已同步 ${result.syncedCount ?? 0} 筆`
          updateStep(i, { status: 'done', message: msg })
        }
      } catch (e) {
        updateStep(i, { status: 'error', message: e instanceof Error ? e.message : '同步失敗' })
      }
    }
    setSyncAllRunning(false)
    setSyncAllLastTime(new Date())
  }

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-8 text-white md:px-8">
      {/* 頁頭 */}
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">ERP 同步區</h1>
          <p className="mt-1 text-sm text-slate-400">
            從 ARGO ERP PJ 系列端口同步四類單據資料到 Supabase，供後續頁面自動引用。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleSyncAll()}
          disabled={syncAllRunning}
          className="shrink-0 rounded-2xl bg-red-600 hover:bg-red-500 active:bg-red-700 disabled:bg-slate-700 disabled:text-slate-500 px-10 py-5 text-2xl font-black text-white shadow-xl transition-colors"
        >
          {syncAllRunning ? '⏳ 同步中...' : '🔄 啟動全表同步'}
        </button>
        {syncAllLastTime && (
          <p className="mt-2 text-right text-xs text-slate-400">
            上次執行：{syncAllLastTime.toLocaleString('zh-TW', { hour12: false })}
          </p>
        )}
      </div>

      {/* 全表同步 Modal */}
      {syncAllOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <h2 className="mb-4 text-lg font-bold text-white">全表同步進度</h2>
            <div className="space-y-3">
              {syncAllSteps.map((step, i) => (
                <div key={step.key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-200">{step.label}</span>
                    {step.status === 'pending' && <span className="text-xs text-slate-500">等待中</span>}
                    {step.status === 'running' && <span className="text-xs text-cyan-400 animate-pulse">同步中...</span>}
                    {step.status === 'done' && <span className="text-xs text-emerald-400">✓ 完成</span>}
                    {step.status === 'error' && <span className="text-xs text-red-400">✗ 失敗</span>}
                  </div>
                  {/* 進度條 */}
                  <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${
                      step.status === 'pending' ? 'w-0' :
                      step.status === 'running' ? 'w-1/2 bg-cyan-500' :
                      step.status === 'done' ? 'w-full bg-emerald-500' :
                      'w-full bg-red-500'
                    }`} />
                  </div>
                  {step.message && (
                    <p className={`text-xs ${step.status === 'error' ? 'text-red-300' : 'text-slate-400'}`}>{step.message}</p>
                  )}
                  {/* 分隔線（最後一項不加）*/}
                  {i < syncAllSteps.length - 1 && <div className="mt-1 border-b border-slate-800" />}
                </div>
              ))}
            </div>
            {/* 整體進度 */}
            <div className="mt-4">
              <div className="mb-1 flex justify-between text-xs text-slate-400">
                <span>整體進度</span>
                <span>{syncAllSteps.filter(s => s.status === 'done' || s.status === 'error').length} / {syncAllSteps.length}</span>
              </div>
              <div className="h-3 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-600 transition-all duration-500"
                  style={{ width: `${(syncAllSteps.filter(s => s.status === 'done' || s.status === 'error').length / (syncAllSteps.length || 1)) * 100}%` }}
                />
              </div>
            </div>
            {!syncAllRunning && (
              <button
                type="button"
                onClick={() => setSyncAllOpen(false)}
                className="mt-5 w-full rounded-lg bg-slate-700 hover:bg-slate-600 py-2 text-sm font-medium text-white transition-colors"
              >
                關閉
              </button>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-xl border border-slate-800 bg-slate-900/50 p-1 w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-cyan-700 text-white shadow'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'bom_structure'
        ? <BomSyncCard resetKey={syncAllLastTime?.getTime() ?? 0} />
        : <SyncCard key={`${activeTab}-${syncAllLastTime?.getTime() ?? 0}`} docKey={activeTab} />}
    </div>
  )
}

export { ErpSyncPage }
