/**
 * 報價計算機 API 契約（前台／後台／API route 三邊共用，改這裡就是改契約）。
 *
 * 所有 route 回應一律 `{ success: true, ... }` 或 `{ success: false, error: string }`，
 * 沿用 app/api/product-dev/item-request/route.ts 的慣例；錯誤訊息寫繁中給第一線看。
 */
import type {
  AcrylicResult,
  AcrylicSettings,
  Plant,
  PrintMethod,
  ProductConfig,
  ProductStatus,
  Sides,
} from './types'

/* ---------------------------------------------------------------- 共用 */

/**
 * 報價檢視模式。**這不是前端的顯示開關，是伺服器端的資料閘門**：
 * 前端把成本藏起來沒有意義，打開 DevTools 看 API 回應照樣拿得到。
 * 所以 sales／customer 模式下，伺服器根本不會把成本欄位放進回應。
 *
 *   engineer  五段明細、成本單價、毛利、拼板盤數全給 —— 需要 quote_admin 權限
 *   sales     只有報價與合計；包裝由品項預設決定，業務不用挑；可調毛利率（overrides.costRatio 是唯一放行的覆寫）
 *   customer  （規劃中）對外 VIP 版，再加上速率限制與參數格點化，見 docs/design
 */
export type QuoteMode = 'engineer' | 'sales' | 'customer'

export type ApiFail = { success: false; error: string; code?: string }
export type ApiOk<T> = { success: true } & T
export type ApiResponse<T> = ApiOk<T> | ApiFail

export interface FxInfo {
  /** 1 RMB = rate TWD */
  rate: number
  /** YYYY-MM-DD */
  asOf: string
}

/** quote_settings 各 key 的形狀 */
export interface QuoteSettingsMap {
  acrylic_settings: AcrylicSettings
  fx_rmb_twd: { rate: number; as_of: string } | null
  markup_bardshop_pct: number
  quote_validity_days: number
  /** 顯示用費率版本字串，例如 "2026-09" */
  rate_version: string
}

/* ---------------------------------------------------------------- 前台：目錄 */

export interface CatalogCategory {
  code: 'acrylic' | 'sticker' | 'crystal'
  name: string
  enabled: boolean
}

export interface CatalogProduct {
  id: string
  name: string
  category: string
  plant: Plant
  status: ProductStatus
  version: number
  config: ProductConfig
}

export interface CatalogPriceItem {
  name: string
  displayName: string
  group: string
  unit: string
  price: number
  currency: string
  attrs: Record<string, unknown> | null
}

export interface CatalogResponse {
  categories: CatalogCategory[]
  /** 前台只拿 published（admin 也只拿 published，測試走後台） */
  products: CatalogProduct[]
  /** 只含 published 品項會用到的價格項目 */
  priceItems: CatalogPriceItem[]
  rateVersion: string
  fx: FxInfo | null
  validityDays: number
  /** 這個使用者能不能切到工程模式（＝有 quote_admin） */
  canEngineer: boolean
  /** 資料表尚未建立時以 seed 回覆（開發用），前台顯示提示 */
  devSeed: boolean
}

/* ---------------------------------------------------------------- 前台：試算 */

export interface CalcSizeRequest {
  id: string
  w: number
  h: number
  qty: number
  /** 手動覆寫每盤數量（含稽核資訊） */
  nOverride?: { value: number; autoValue: number; key: string } | null
}

export interface CalcRequest {
  /** 省略＝sales。要 engineer 得有 quote_admin，否則伺服器自動降級 */
  mode?: QuoteMode
  productId: string
  sizes: CalcSizeRequest[]
  /** 主板材價格表名稱 */
  boardItem: string
  print: { method: PrintMethod; sides: Sides; versions?: number }
  /** 勾選的配件：item = 價格表名稱，k = 每件用量 */
  accessories: { item: string; k: number; unitPrice?: number }[]
  /** 勾選的包裝項目（只送 item，mode/n/k 從品項設定取；n 可覆寫） */
  packing: { item: string; n?: number }[]
  overrides?: {
    t1?: number
    t2?: number
    t3?: number
    scrapPct?: number
    costRatio?: number
    packCapacityPerHour?: number
  }
}

/** 任何模式都會回的欄位 */
export interface CalcSizePublic {
  id: string
  /** 報價單價 */
  quoteUnit: number
  /** 本單合計 */
  total: number
  /** TWD 換算（整數元）；fx 未設定時 null */
  twdUnit: number | null
  warnings: string[]
}

/**
 * 成本相關欄位一律 optional：sales／customer 模式伺服器不會回。
 * UI 要用 `size.costUnit != null` 判斷，不能假設一定有。
 */
export interface CalcSizeResult extends CalcSizePublic, Partial<Omit<AcrylicResult, 'warnings' | 'quoteUnit' | 'total'>> {}

export interface CalcResponse {
  /** 伺服器實際採用的模式（可能被降級） */
  mode: QuoteMode
  rateVersion: string
  fx: FxInfo | null
  validityDays: number
  productVersion: number
  sizes: CalcSizeResult[]
  warnings: { code: string; sizeId?: string; message: string }[]
  errors: { code: string; field?: string; message: string }[]
  /** 本次用到的價格快照（寫 log 用）。**這是成本資料**，只在 engineer 模式回。 */
  priceSnapshot?: Record<string, number>
}

/* ---------------------------------------------------------------- 前台：產生報價（log） */

export interface LogRequest {
  request: CalcRequest
  response: CalcResponse
  customer?: string
}

export interface LogResponse {
  quoteNo: string
  createdAt: string
}

export interface LogRow {
  quote_no: string
  created_at: string
  customer: string | null
  product_name: string
  summary: string
  quote_unit: number
  request: CalcRequest
}

/* ---------------------------------------------------------------- 後台：品項 */

export interface AdminProductRow {
  id: string
  family: 'acrylic'
  category: string
  name: string
  plant: Plant
  status: ProductStatus
  version: number
  config: ProductConfig
  sort_order: number
  updated_by: string | null
  updated_at: string
  published_at: string | null
}

export interface GoldenRow {
  id: string
  product_id: string
  name: string
  status: 'proposed' | 'approved' | 'rejected'
  template_version: string | null
  source_file: string | null
  source_sheet: string | null
  /** 稽核備註：來源可信度、手改處、核可建議 */
  audit_note: string | null
  input: unknown
  settings_snapshot: unknown
  expected_cost: number
  expected_price: number
  tolerance: number
  last_result: 'pass' | 'fail' | null
  last_diff: unknown
  last_run_at: string | null
  approved_by: string | null
  approved_at: string | null
}

export type AdminProductsAction =
  | { action: 'create'; product: Omit<AdminProductRow, 'id' | 'version' | 'updated_by' | 'updated_at' | 'published_at'> }
  | { action: 'update'; id: string; patch: Partial<Pick<AdminProductRow, 'name' | 'category' | 'plant' | 'config' | 'sort_order'>> }
  | { action: 'setStatus'; id: string; status: ProductStatus }
  | { action: 'setGoldenStatus'; goldenId: string; status: 'approved' | 'rejected' | 'proposed' }

export interface VerifyCaseResult {
  goldenId: string
  name: string
  status: GoldenRow['status']
  pass: boolean
  gotCost: number
  gotPrice: number
  expectedCost: number
  expectedPrice: number
  errCost: number
  errPrice: number
  segments: { key: string; amount: number }[]
  error?: string
}

export interface VerifyResponse {
  productId: string
  /** 只算 approved 的閘門結果 */
  gate: 'pass' | 'fail' | 'no-approved-cases'
  results: VerifyCaseResult[]
}

/* ---------------------------------------------------------------- 後台：價格表 */

export interface AdminPriceRow {
  id: string
  group: string
  name: string
  display_name: string | null
  unit: string
  price: number
  currency: string
  plant: Plant
  attrs: Record<string, unknown> | null
  effective_from: string | null
  source_file: string | null
  argo_part_code: string | null
  erp_suggested_price: number | null
  erp_suggested_currency: string | null
  erp_suggested_at: string | null
  updated_by: string | null
  updated_at: string
  note: string | null
}

export interface ErpSuggestion {
  itemId: string
  argoPartCode: string
  price: number
  currency: string
  docNo: string
  date: string | null
  /** 幣別不同時用匯率換算後的值（RMB） */
  convertedPrice: number | null
}

/* ---------------------------------------------------------------- 後台：Excel 匯入 */

export interface ImportPriceDiff {
  name: string
  group: string
  current: number | null
  incoming: number
  status: 'new' | 'up' | 'down' | 'same' | 'invalid'
  note?: string
}

export interface ImportGoldenProposal {
  name: string
  sheet: string
  template_version: string
  qty: number
  expected_cost: number
  expected_price: number
  input: unknown
  settings_snapshot: unknown
  warnings: string[]
}

/** 「用這份 Excel 建立新品項」的提案：從主产品分頁反推的品項設定＋找到的類似品項＋合理性檢查 */
export interface ImportProductProposal {
  suggestedName: string
  /** 主产品分頁名（設定從哪一頁來） */
  fromSheet: string
  config: ProductConfig
  /** 這個品項會查到的價格名稱；exists=false 的會在套用時一併新增（用 Excel 上的價） */
  referencedPrices: { name: string; group: string; unit: string; price: number; attrs: Record<string, number> | null; exists: boolean }[]
  notes: string[]
  similar: { id: string; name: string; why: string }[]
  checks: { level: 'warn' | 'info'; field: string; message: string }[]
}

export interface ImportPreviewResponse {
  fileName: string
  templateVersion: string
  priceDiff: ImportPriceDiff[]
  goldenProposals: ImportGoldenProposal[]
  notes: string[]
  productProposal?: ImportProductProposal
}

export interface ImportApplyRequest {
  fileName: string
  /** unit／attrs 只在「新增」時用（既有項目只改價）；板材新增要帶 attrs.layout_w_cm／layout_h_cm */
  priceUpdates: { name: string; group: string; price: number; unit?: string; attrs?: Record<string, number> | null }[]
  goldenCases: (ImportGoldenProposal & { productId: string })[]
  /** 一併建立新品項（draft）；goldenCases 裡 productId 可指到這個新 id */
  newProduct?: { id: string; name: string; category: string; config: ProductConfig }
}
