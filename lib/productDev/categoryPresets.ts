// 品項大類的 ERP 預設設定 —— 前端表單與後端 API 共用的單一來源。
//
// 為什麼要抽出來共用：會影響帳務的欄位（會計科目、庫存類型、成本類別、費用類）
// 已改為「申請人不能改」，值一律由後端決定。後端要能自己算出這些值，就不能讓
// 這張表只活在前端；兩邊各留一份遲早會走鐘——改了前端忘了後端，畫面顯示的和
// 實際寫進資料庫的就對不上，而且從畫面看不出來。
//
// defaults 只是「該類目前 ARGO 上最常見」的組合，作為沒有引用來源時的保底；
// 真正可靠的是引用既有品項（例外不少，例如 S 類就有四種存貨科目）。

/** 大類 = 料號第一碼 = ARGO PRODUCT_CATEGORY */
export interface CategoryPreset {
  code: string
  label: string
  hint: string
  defaults: Record<string, string>
}

export const CATEGORY_PRESETS: CategoryPreset[] = [
  {
    code: 'M', label: 'M — 材料', hint: '採購原料，進 FS100 倉',
    defaults: { source_type: 'B', inventory_type: 'M', cost_category: 'M', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FS100', lot_no_flag: 'N', expense_flag: 'N', level_code_inv: '1148', account_no_inv: '1315' },
  },
  {
    code: 'W', label: 'W — 耗材／輔料', hint: '消耗性物料，成本類別 M_MRO',
    defaults: { source_type: 'B', inventory_type: 'M', cost_category: 'M_MRO', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FS100', lot_no_flag: 'N', expense_flag: 'N', level_code_inv: '1148', account_no_inv: '1316' },
  },
  {
    code: 'P', label: 'P — 自製成品', hint: '本廠生產，批號控管',
    defaults: { source_type: 'B', inventory_type: 'FINSHED_GOODS', cost_category: 'FINSHED_GOODS', leadtime_flag: 'MANUFACTURE', bom_warehouse_id: 'FS100', lot_no_flag: 'Y', expense_flag: 'N', level_code_inv: '1143', account_no_inv: '1311' },
  },
  {
    code: 'C', label: 'C — 採購成品', hint: '外購成品／半成品，批號控管',
    defaults: { source_type: 'B', inventory_type: 'P', cost_category: 'P', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FS100', lot_no_flag: 'Y', expense_flag: 'N', level_code_inv: '1141', account_no_inv: '1301' },
  },
  {
    code: 'S', label: 'S — 費用（加工／服務）', hint: '費用類，進 FEXP 費用倉',
    defaults: { source_type: 'B', inventory_type: 'P', cost_category: 'P', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FEXP', lot_no_flag: 'N', expense_flag: 'Y', level_code_inv: '515', account_no_inv: '5736' },
  },
  {
    code: 'A', label: 'A — 費用（其他）', hint: '費用類，進 FEXP 費用倉',
    defaults: { source_type: 'P', inventory_type: 'P', cost_category: 'P', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FEXP', lot_no_flag: 'N', expense_flag: 'Y', level_code_inv: '62', account_no_inv: '6288' },
  },
  {
    code: 'O', label: 'O — 委外', hint: '委外生產品項',
    defaults: { source_type: 'P', inventory_type: 'FINSHED_GOODS', cost_category: 'FINSHED_GOODS', leadtime_flag: 'MANUFACTURE', bom_warehouse_id: '', lot_no_flag: 'N', expense_flag: 'N', level_code_inv: '1143', account_no_inv: '1311' },
  },
]

export const CATEGORY_CODES = CATEGORY_PRESETS.map((c) => c.code)

export function presetOf(code: string): Record<string, string> {
  return CATEGORY_PRESETS.find((c) => c.code === String(code).toUpperCase())?.defaults ?? {}
}

/**
 * 申請人不能改的欄位（Snow 2026-09-16 定）——這幾個填錯會讓帳跑錯地方，
 * 而商開沒有判斷依據。值一律由後端決定：有引用品項就抄引用來源，沒有就用大類預設。
 *
 * 刻意不鎖的：預設倉、批號控管、安全庫存、生效日、來源型態、前置時間類別——
 * 這些跟實際作業有關（同一類品項也可能進不同倉），申請人比會計更清楚。
 */
export const LOCKED_ERP_FIELDS = [
  'inventory_type',
  'cost_category',
  'expense_flag',
  'level_code_inv',
  'account_no_inv',
] as const

export type LockedErpField = (typeof LOCKED_ERP_FIELDS)[number]

/** ARGO MM_BOM_PART 欄位 → 本系統欄位，供「引用既有品項」抄設定用 */
export const LOCKED_FIELD_FROM_ARGO: Record<LockedErpField, string> = {
  inventory_type: 'INVENTORY_TYPE',
  cost_category: 'COST_CATEGORY',
  expense_flag: 'EXPENSE_FLAG',
  level_code_inv: 'LEVEL_CODE_INV',
  account_no_inv: 'ACCOUNT_NO_INV',
}
