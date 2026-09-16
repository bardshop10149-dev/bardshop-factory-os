/**
 * 報價計算機 — 共用型別。
 *
 * 引擎輸入（AcrylicInput）一律是「已解析成數字」的規格：板價、PET 價、工序費率、包材單價
 * 都由 data 層從 quote_price_items 查好再塞進來。引擎本身不碰資料庫、不查表，
 * 這樣 golden case 可以帶「當時常數快照」直接餵引擎驗邏輯（設計書 §5.0 鐵則 2）。
 */

export type Plant = 'changping' | 'taiwan'
/**
 * 印刷方式。`jingutian` 是內部代號：供應商「金谷田」2026-09 已轉手為「百川」，
 * 畫面顯示一律「百川」，但代號與價格表的 Excel 名稱（印刷/金谷田/单面）保持不變——
 * 那是 Excel 匯入的比對鍵，也是既有 golden 案例的欄位值，改了舊資料就對不上。
 */
export type PrintMethod = '7151' | 'jingutian' | 'koshi' | 'none'
export type Sides = 1 | 2
export type PackingMode = 'per_unit' | 'per_n_units' | 'per_box' | 'fixed'
export type PetMode = 'koshi_sheet' | 'roundup_plates' | 'none'

/** 一張板材（主板或第二板）。§5.3① */
export interface BoardLine {
  key: string
  item: string
  unitPrice: number
  /** 套版尺寸（cm）；主板必填，來自板材 attrs（300×400 → 29×39） */
  layoutWcm?: number
  layoutHcm?: number
  /** 直接指定每盤數（第二板用；登山沟 C10 = E9/66 的 66） */
  nPerSheet?: number
  /** 盤數是否 ROUNDUP（模板預設 true；登山沟第二板 false） */
  roundup: boolean
  sides: Sides
  /** 這張板的盤數是否進印刷／貼合／切割段 */
  printed: boolean
  laminated: boolean
  cut: boolean
}

export interface PetLine {
  item: string
  unitPrice: number
  mode: PetMode
  sides: Sides
  /** 柯氏：每張 PET 可貼幾盤（C11 公式的 /2） */
  kPet: number
}

export interface PrintSpec {
  method: PrintMethod
  sides: Sides
  /** 7151／金谷田：單面每盤價；柯氏：每版價（單面） */
  unitPrice: number
  /** 柯氏版數 V */
  versions?: number
  /** 柯氏加印：每張 / 免費張數（未給則用 settings.koshi） */
  extraUnitPrice?: number
  extraFreeSheets?: number
}

export interface LaminateLine {
  item: string
  unitPrice: number
  /** 盤數來源：板材 key 清單（模板 = ['main']；登山沟 = ['main','acc']） */
  platesFrom: string[]
}

export interface WashSpec {
  unitPrice: number
  /** 'main' = C9；'laminate' = 貼合盤數 C18；或板材 key 清單 */
  platesFrom: 'main' | 'laminate' | string[]
  /** 冰箱贴 C9×3 這種層數倍率 */
  multiplier?: number
}

export interface PackingLine {
  item: string
  unitPrice: number
  mode: PackingMode
  /** per_unit：每件用量；per_box：每箱倍數 */
  k?: number
  /** per_n_units：每 n 件一個；per_box：每箱 n 件；fixed：次數 */
  n?: number
  group?: 'packing' | 'accessory' | 'outsourced'
}

export interface AcrylicInput {
  qty: number
  partWcm: number
  partHcm: number
  /** 手動覆寫主板每盤數 */
  nOverride?: number | null
  boards: BoardLine[]
  pet: PetLine
  print: PrintSpec
  laminate: LaminateLine[]
  wash: WashSpec
  cut: { t1: number; t2: number; t3: number }
  scrapPct: number
  costRatio: number
  packCapacityPerHour: number
  packing: PackingLine[]
}

/** 全域參數（quote_settings）。golden case 的 settings_snapshot 也是這個形狀。 */
export interface AcrylicSettings {
  nesting: { gapCm: number; marginCm: number }
  cut: {
    hoursPerDay: number
    machines: number
    shiftFactor: number
    efficiency: number
    workDays: number
    /** 外形段銑時間係數（Excel H26 硬編碼 1.1） */
    outlineTimeFactor: number
    machinesMonthly: { name: string; monthly: number }[]
    laborMonthly: number
    knifeOutlineMonthly: number
    knifeGrooveMonthly: number
    knifeCoverMonthly: number
  }
  packLabor: {
    hoursPerDay: number
    workDays: number
    staff: { name: string; monthly?: number; hourly?: number; share: number }[]
  }
  koshi: {
    /** PET 放數 %（C11 的 ×1.1） */
    allowancePct: number
    /** 試機張數（C11 的 +600） */
    trialSheets: number
    /** 加印免費張數（C19 的 600+1000） */
    extraFreeSheets: number
    extraUnitPrice: number
  }
  flags: {
    /** 外形段銑時間用固定係數不隨報廢率（Excel 現況 true） */
    outlineScrapFactorFixed: boolean
    /** 第二板材不進切割段（Excel 現況 true） */
    secondBoardExcludedFromCut: boolean
    /** 一次性外發費放包材段一起乘報廢率（Excel 現況 true） */
    fixedFeeScrapApplied: boolean
  }
}

export interface CalcLine {
  name: string
  formula: string
  amount: number
}

export type SegmentKey = 'material' | 'print' | 'cut' | 'packLabor' | 'packMaterial'

export interface CalcSegment {
  key: SegmentKey
  name: string
  /** 該段總金額（Excel D 欄合計） */
  amount: number
  /** 每件（F 欄） */
  perUnit: number
  /** 每件含報廢（G 欄） */
  perUnitWithScrap: number
  lines: CalcLine[]
}

export interface AcrylicResult {
  nPerSheetAuto: number
  nPerSheetUsed: number
  nest: { cols: number; rows: number; rotated: boolean }
  /** 主板盤數 C9 */
  plates: number
  petPlates: number
  segments: CalcSegment[]
  costUnit: number
  costRatio: number
  quoteUnit: number
  marginPct: number
  total: number
  warnings: string[]
}

/* ---------------------------------------------------------------- 品項設定（quote_products.config） */

export interface ProductBoardOption {
  /** 價格表項目名稱（quote_price_items.name） */
  item: string
  /** 顯示用短標（例如 300×400×2.8；貼合款用「2 貼 2」） */
  label?: string
  /**
   * 選項識別。同一張主板出現在多個組合時（2貼2 與 2貼1 主板都是 1.8）要各自給 key，
   * 前台送的 boardItem 與 defaultItem 都是 `key ?? item`。
   */
  key?: string
  /** 貼合款：這個選項同時決定第二板（extraBoards 裡 fromBoardOption 的那張）用哪張板 */
  pairItem?: string
}

export interface ProductExtraBoard {
  key: string
  /** 價格表品名；fromBoardOption 時留空，由板材選項的 pairItem 決定 */
  item: string
  /** 每盤數；不填＝跟主板一樣（2貼2 的 C10 公式與 C9 相同） */
  nPerSheet?: number
  fromBoardOption?: boolean
  roundup: boolean
  sides: Sides
  printed: boolean
  laminated: boolean
  cut: boolean
}

export interface ProductAccessory {
  item: string
  k: number
  defaultOn: boolean
  /** 單價依數量階梯不同時，前台可讓業務改單價 */
  tierPrices?: boolean
}

export interface ProductPacking {
  item: string
  mode: PackingMode
  k?: number
  n?: number
  defaultOn?: boolean
}

export interface ProductConfig {
  boards: { options: ProductBoardOption[]; defaultItem: string; sides: Sides }
  /** 前台「單雙面」預設值（貼合款預設雙面）；未設＝跟 boards.sides */
  defaultPrintSides?: Sides
  /**
   * PET 單／雙面（Excel L9）。不填＝跟印刷面數走：單板雙面是兩面各貼一張 PET，PET ×2（Snow 2026-09-15 確認）。
   * 貼合款（2貼2、3貼1…）固定 1：夾在中間的是「彩白彩」單張 PET，雙面不增加 PET
   * （2貼2 模板：L9=单面、A17=印刷/7151/双面）。
   */
  petSides?: Sides
  extraBoards: ProductExtraBoard[]
  printMethods: PrintMethod[]
  defaultPrintMethod: PrintMethod
  /** 各印刷方式對應的 PET 項目名稱（none 不需要） */
  petByMethod: Partial<Record<PrintMethod, string>>
  kPet: number
  laminate: { item: string; platesFrom: string[] }[]
  wash: { item: string; platesFrom: 'main' | 'laminate' | string[]; multiplier?: number }
  cut: { t1: number; t2: number; t3: number }
  accessories: ProductAccessory[]
  packing: ProductPacking[]
  scrapPct: number
  costRatio: number
  packCapacityPerHour: number
}

export type ProductStatus = 'draft' | 'testing' | 'published'

export interface QuoteProduct {
  id: string
  family: 'acrylic'
  category: string
  name: string
  plant: Plant
  status: ProductStatus
  version: number
  config: ProductConfig
  sort_order: number
}

export interface PriceItem {
  id: string
  group: string
  /** Excel 原名（簡體，匯入比對用的自然鍵） */
  name: string
  /** 繁中顯示名，前台顯示 display_name ?? name */
  display_name: string | null
  unit: string
  price: number
  currency: string
  plant: Plant
  attrs: Record<string, unknown> | null
  effective_from: string | null
  argo_part_code: string | null
  erp_suggested_price: number | null
  erp_suggested_currency: string | null
  erp_suggested_at: string | null
  note: string | null
}
