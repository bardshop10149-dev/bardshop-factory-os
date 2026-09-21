/**
 * 透過 ARGO IFAF007「料件主檔介面轉檔」建立新品項。
 *
 * 這是本專案唯一會寫入 ARGO 的地方。寫進 ERP 的料件只能作廢不能刪，所以判定是否
 * 成功的邏輯比送出本身重要得多——下面 createPart() 的四步順序不要改。
 *
 * ── 實戰規則（2026-07 S 料號改 O 前綴專案 + 2026-09-21 M 類實測換來的）──
 *
 * 1. 會計科目不可以手動送。手動塞 ACCOUNT_NO_INV / LEVEL_CODE_INV（即使抄自
 *    正式區現有有效料號）會被判「存貨/費用科目設定必需為存貨類科目」。只送
 *    ACCOUNT_FLAG=Y，讓 ARGO 依料件類別自動帶——2026-09-21 實測 MACRTSPG5-R6343-C，
 *    帶出來的五組科目與引用來源逐欄一致。
 *
 * 2. 有一批欄位送了會被 `invalid column:` 直接拒收：OLD_VER, OLD_PART, MRP_FLAG,
 *    MPS_FLAG, LOT_NO_FLAG, LOT_SIZE_FLAG, NO_PICKING_FLAG, CFV_FLAG, ALLOW_FLAG,
 *    STD_MFG_MINUTES。注意 LOT_NO_FLAG 是拒收欄，批號控管要送 LOT_NO_CONTROL。
 *
 * 3. 料號開頭字母必須等於 PRODUCT_CATEGORY，且要符合 BOMF008 對該類別的定義。
 *    當初 PRODUCT_CATEGORY='S'（BOMF008 定義為費用類=Y）配 EXPENSE_FLAG=N，
 *    ARGO 報的卻是科目錯誤——類別衝突會偽裝成科目問題。
 *
 * 4. PRODUCT_CATEGORY_2 必須是 BOMF008 已建的有效小類，否則回「無此料件小類」。
 *
 * 5. 只新增不更新。重送已存在料號回 ORA-00001 (MBP_PK)，所以送出前一定要查主檔。
 *
 * 6. **判成功不能只看 STATUS。** RESULT 只回檢核失敗列，而且會累積前幾次的殘留；
 *    2026-09-21 測試區實測到 STATUS=1 + RESULT=[] 但主檔 0 筆的「假成功」。
 *    正確判法＝「這個 PART 沒出現在錯誤列」**且**「回查主檔查得到」。
 *
 * 7. 正式區與測試區行為不同：測試區檢核過了也停在介面表（而 P_IMPORT_IFAF007 在
 *    測試區未授權，等於死路），正式區收件即入主檔。測試區只能當語法沙盒，
 *    真實行為以正式區為準。
 */

import { presetOf } from './categoryPresets'

const API_BASE = process.env.ARGOERP_API_BASE
const USERNAME = process.env.ARGOERP_USERNAME
const PASSWORD = process.env.ARGOERP_PASSWORD
const SEGMENT = process.env.ARGOERP_SEGMENT

/** 送了會被 ARGO 以 `invalid column:` 拒收的欄位，一律不得出現在 payload */
export const REJECTED_COLUMNS = [
  'OLD_VER', 'OLD_PART', 'MRP_FLAG', 'MPS_FLAG', 'LOT_NO_FLAG', 'LOT_SIZE_FLAG',
  'NO_PICKING_FLAG', 'CFV_FLAG', 'ALLOW_FLAG', 'STD_MFG_MINUTES',
] as const

/** 已在正式區實際建檔成功過的大類；其餘仍可送，但畫面要標「尚未實測」 */
export const VERIFIED_CATEGORIES = ['M', 'O'] as const

/** 申請單裡與 IFAF007 有關的欄位 */
export interface PartRequestInput {
  approved_part: string
  part_name: string
  part_desc?: string | null
  unit_of_measure: string
  product_category: string
  product_category_2: string
  source_type?: string | null
  inventory_type?: string | null
  cost_category?: string | null
  leadtime_flag?: string | null
  bom_warehouse_id?: string | null
  lot_no_flag?: string | null
  expense_flag?: string | null
  safety_qty?: number | null
  validdate?: string | null
  /** 核准主管工號 → ACCOUNT_USER（必填）。沒有工號時退回 10011（歷史沿用值） */
  approved_by_emp_no?: string | null
}

export type Ifaf007Payload = Record<string, string | number>

const s = (v: unknown): string | null => {
  const t = String(v ?? '').trim()
  return t ? t : null
}

const todayTW = () => {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * 組出要送給 IFAF007 的完整欄位。
 *
 * 申請單只收 11 個 ERP 設定欄位，IFAF007 要 40 幾個——缺的那些（各種旗標、成本欄）
 * 不該讓申請人填，由這裡依大類補齊。大類預設值取自 categoryPresets，與申請頁同源。
 */
export function buildPayload(r: PartRequestInput): Ifaf007Payload {
  const category = String(r.product_category).toUpperCase()
  const preset = presetOf(category)
  const part = String(r.approved_part).trim().toUpperCase()

  const row: Ifaf007Payload = {
    PART: part,
    VER: 1,
    PART_NAME: r.part_name,
    PART_DESC: s(r.part_desc) ?? '自訂',
    UNIT_OF_MEASURE: r.unit_of_measure,
    PART_COLOR: 'NONE',
    PART_SIZE: 'NONE',
    PRODUCT_CATEGORY: category,
    PRODUCT_CATEGORY_2: String(r.product_category_2).toUpperCase(),
    EXPENSE_FLAG: s(r.expense_flag) ?? preset.expense_flag ?? 'N',
    INVENTORY_TYPE: s(r.inventory_type) ?? preset.inventory_type ?? 'M',
    COST_CATEGORY: s(r.cost_category) ?? preset.cost_category ?? 'M',
    LEADTIME_FLAG: s(r.leadtime_flag) ?? preset.leadtime_flag ?? 'PURCHASE',
    SOURCE_TYPE: s(r.source_type) ?? preset.source_type ?? 'B',
    PRODUCED: 'Y',
    PHANTOM: 'N',
    BOM_TYPE: 'M',
    INVALID_FLAG: 'N',
    ECNNBR: 'ORIGINAL',
    QTY_PRECISION: 0,
    MO_RETURN_COST: 'N',
    EQUIVALENT_RATIO: 1,
    EQUIVALENT_RATIO_M: 1,
    // 科目交給 ARGO 依類別自動帶，這是唯一正確的做法（見檔頭規則 1）
    ACCOUNT_FLAG: 'Y',
    ACCOUNT_USER: Number(s(r.approved_by_emp_no) ?? '10011'),
    VALIDDATE: s(r.validdate) ?? todayTW(),
    // 申請單欄位叫 lot_no_flag，寫入要用 LOT_NO_CONTROL（LOT_NO_FLAG 是拒收欄）
    LOT_NO_CONTROL: s(r.lot_no_flag) ?? preset.lot_no_flag ?? 'N',
    BOH_FLAG: 'N',
    COMBINED_FLAG: 'N',
    CAS_FLAG: 'N',
    REEL_ID_FLAG: 'N',
    IS_TAX_FLAG: 'N',
    MG_QC: 'N',
    MO_QC: 'N',
    SB_QC: 'N',
    SG_QC: 'N',
    SO_QC: 'N',
    QC_TYPE: 'N',
    DIRECT_LABOR_COST: 0,
    MATERIAL_COST: 0,
    OVERHEAD_COST: 0,
    EXTERNAL_COST: 0,
  }

  // O 類（客供料代工）走製令，需要指定前置時間子類別
  if (String(row.LEADTIME_FLAG) === 'MANUFACTURE') row.LEADTIME_FLAG_SUBTYPE = 'MO'

  const warehouse = s(r.bom_warehouse_id) ?? preset.bom_warehouse_id
  if (warehouse) row.BOM_WAREHOUSE_ID = warehouse
  if (r.safety_qty != null) row.SAFETY_QTY = Number(r.safety_qty)

  // 保險：就算上游改壞了也不要把拒收欄送出去
  for (const bad of REJECTED_COLUMNS) delete (row as Record<string, unknown>)[bad]
  return row
}

async function getApiKeys(): Promise<{ APIKEY1: string; APIKEY2: string; APIKEY3: string }> {
  if (!API_BASE || !USERNAME || !PASSWORD || !SEGMENT) {
    throw new Error('ARGO 連線設定不完整（缺 ARGOERP_* 環境變數）')
  }
  const res = await fetch(`${API_BASE}/S_APIKEY`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`ARGO 取金鑰失敗（HTTP ${res.status}）`)
  const keys = (await res.json())?.RESULT
  if (!keys?.APIKEY1) throw new Error('ARGO 取金鑰失敗（回應無金鑰）')
  return keys
}

async function argoPost(path: string, sparam: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sparam: JSON.stringify(sparam) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ARGO ${path} 失敗（HTTP ${res.status}）`)
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`ARGO ${path} 回應不是合法 JSON：${text.slice(0, 200)}`)
  }
}

/** 查料件主檔（正式表），回傳該料號的列；查不到回 null */
export async function findPart(part: string): Promise<Record<string, unknown> | null> {
  const keys = await getApiKeys()
  const body = await argoPost('S_QUERY', {
    APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
    SEGMENT, TABLE: 'MM_BOM_PART', PART: `= '${part.replace(/'/g, "''")}'`,
  })
  if (typeof body.ERROR === 'string' && body.ERROR.trim()) throw new Error(String(body.ERROR))
  const rows = Array.isArray(body.RESULT) ? (body.RESULT as Record<string, unknown>[]) : []
  return rows[0] ?? null
}

export interface CreateResult {
  ok: boolean
  part: string
  /** ARGO 對這一筆回的檢核錯誤（沒有才可能成功） */
  errorCode: string | null
  batchNo: string | null
  /** 回查主檔拿到的那一列；ok 為 true 時必有 */
  created: Record<string, unknown> | null
  /** 給人看的結論 */
  message: string
  rawStatus: string | null
}

/**
 * 建立品項。四步順序即安全機制，不要改：
 *   ① 查主檔（只新增不更新，且順便擋掉審查期間被占用）
 *   ② 送 S_IMPORT
 *   ③ 檢查「這個 PART 有沒有出現在錯誤列」——否定證據
 *   ④ 回查主檔——肯定證據。兩者都過才算成功
 */
export async function createPart(payload: Ifaf007Payload): Promise<CreateResult> {
  const part = String(payload.PART)

  const before = await findPart(part)
  if (before) {
    return {
      ok: false, part, errorCode: null, batchNo: null, created: before,
      rawStatus: null,
      message: `ARGO 已經有 ${part}（${String(before.PART_NAME ?? '')}），未重複建立`,
    }
  }

  const keys = await getApiKeys()
  const body = await argoPost('S_IMPORT', {
    APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
    SEGMENT, IMP: 'Y', INTERFACE: 'IFAF007', DATA: [payload],
  })
  const rawStatus = body.STATUS == null ? null : String(body.STATUS)

  // RESULT 會累積歷史殘留，只認 PART 相符的那幾列
  const result = Array.isArray(body.RESULT) ? (body.RESULT as Record<string, unknown>[]) : []
  const mine = result.filter((x) => String(x.PART ?? '').trim() === part)
  const errorCode = mine.map((m) => String(m.ERROR_CODE ?? '').trim()).filter(Boolean).join(' / ') || null
  const batchNo = (mine.find((m) => m.BATCH_NO)?.BATCH_NO as string | undefined) ?? null

  if (typeof body.ERROR === 'string' && body.ERROR.trim()) {
    return { ok: false, part, errorCode, batchNo, created: null, rawStatus, message: `ARGO 回報錯誤：${body.ERROR}` }
  }
  if (errorCode) {
    return { ok: false, part, errorCode, batchNo, created: null, rawStatus, message: `ARGO 檢核未通過：${errorCode}` }
  }

  // 沒有錯誤只是「沒被擋下」，還要確認真的進了正式表才算數
  const after = await findPart(part)
  if (!after) {
    return {
      ok: false, part, errorCode: null, batchNo, created: null, rawStatus,
      message: '送出後回查料件主檔查不到這個編碼——資料可能停在介面表未過帳，請人工確認後再處理',
    }
  }
  return { ok: true, part, errorCode: null, batchNo, created: after, rawStatus, message: `已在 ARGO 建立 ${part}` }
}
