// 包裝專區：標準包裝工時估算（分鐘，1 人）
//
// 規則：需求決策紀錄 D14 / D16 / D27 / D28；設計文件 docs/design/2026-09-27-packaging-schedule.md §五。
// 附加工時取自《工序總表2》「工序生產時間」右側附加表 E56:K97（加貼紙／加雷標／加紙卡／盲抽）。
//
// ── 資料鏈（線上 Supabase 為準，比三版 Excel 都新）──────────────────────────
//   品號 item_routes.item_code → route_id → route_operations(op_name, sequence)
//     → operation_times(station='包裝站').std_time_min（分/件/1 人）
//   route_operations 沒有站別欄，改以「op_name 是否為包裝站工序」判斷；線上 op_name 跨站不重名（2026-09-27 實測）。
//
// ── 三種來源 ─────────────────────────────────────────────────────────
//   自製 MOT/MOS：途程包裝站非 QC 工序 →（選填）塔台該批包裝站工序名 → 品名關鍵字品類 → 工時未知；再加附加工時
//   常平：預設「檢驗＋換箱」0.2 分/件（D27：每人每小時 300 個）；
//         【常平出貨】備註寫「未包裝」→ 改用廠內同品類完整工時＋附加工時（D28），對不到品類退回一般壓克力片
//   委外：途程包裝站非 QC 工序（委外 C 品號途程＝委外/N天回→QC，多半沒有）→ 品名關鍵字品類 → 工時未知（D16）
// QC檢驗、QC檢驗/入庫 一律不計（D14：品檢不算包裝產能）。
// 每卡最少 10 分鐘：沿用 lib/sara/autoProcessGen.ts 的 calcEst = max(10, std×數量)，視為備料／換線時間。
//
// 本檔只讀資料庫（loadStdTimeTables），computeStdTime 是純函式，可直接單元測試。

import type { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { AddonKey, WorkEstimate } from '@/lib/packaging/types'

type SupabaseAdmin = ReturnType<typeof getSupabaseAdminClient>

// ── 常數 ────────────────────────────────────────────────────────────

const PACKAGING_STATION = '包裝站'
const PAGE_SIZE = 1000

/** 常平貨回台只做檢驗＋換箱：每人每小時 300 個 → 0.2 分/件（D27；「每人」為暫定解讀，見延後細節） */
export const CHANGPING_REBOX_PER_UNIT = 0.2

/** 每卡最少分鐘數（沿用 calcEst） */
export const MIN_CARD_MINUTES = 10

/** 常平未包裝、品名對不到品類時的退回工序（D28） */
const CHANGPING_FALLBACK_OP = '常規包裝/一般壓克力片'
const CHANGPING_FALLBACK_STD = 0.5

/** 線上「標籤貼紙」工序（包裝站 0.02）；查不到時用這個值 */
const LABEL_OP = '標籤貼紙'
const LABEL_STD_DEFAULT = 0.02

/**
 * 常平「未包裝」辨識（D28）：只認「未包裝」（常平同事寫簡體字，所以繁簡都收）。
 * cpShipNote 是同一採購行多批出貨紀錄的合併文字，任一批寫到就整卡改算完整包裝工時，所以規則要窄。
 */
export const CHANGPING_UNPACKED_RE = /未包[裝装]/

/**
 * 語意相近、但 D28 沒定案的寫法（例：「心月款2000组回台包装+OPP袋…」「台灣包裝」「沒/無包裝」）：
 * 不改工時，只由 classify 加 info 旗標請主管確認；Snow 確認等同「未包裝」後再併入上面的規則。
 */
export const CHANGPING_PACK_HINT_RE = /[沒没無无]包[裝装]|回台包[裝装]|[台臺][灣湾]包[裝装]/

/** QC 工序（D14：不算包裝工時） */
const isQcOp = (opName: string) => /^QC檢驗/.test(opName.trim())

/**
 * 附加工時（分/件，1 人），照《工序總表2》右側附加表的公式：
 *   加貼紙 =G+0.15（立牌單件／立牌組合 +0.12）、加雷標 =G+0.2、
 *   加紙卡 =G+0.12（單件鑰匙圈 +0.2）、盲抽(含混裝+貼紙) =G+0.2。
 * 線上 operation_times 的「常規包裝+貼紙/…」等變體值與這些公式一致（例：+貼紙/立牌(單件) 1.12、+紙卡/鑰匙圈 0.6）。
 */
export const ADDON_MINUTES = {
  sticker: 0.15,
  stickerStandee: 0.12,
  laserLabel: 0.2,
  paperCard: 0.12,
  paperCardKeychain: 0.2,
  blindMix: 0.2,
} as const

// ── 品名 → 品類關鍵字表 ─────────────────────────────────────────────
//
// 用途：委外（途程沒有包裝工序時）、常平「未包裝」、自製途程對不到時的備援。
// 規則：由上而下，第一個命中的就用；match 陣列「全部」符合才算命中。
// std 一律以執行期 operation_times 的值為準（註解數字為 2026-09-27 線上值）；線上查不到該 op_name 時跳過此列。
// 比對對象是品名的「商品名稱段」：去掉「客製 |」「打樣 /」前綴、「-||-」後的品名備註、「[」後的規格；
// 先比第一個空白前的短名，對不到再比整段商品名稱（見 productNameCandidates）。
// 排序依據：設計文件 §五的表＋erp_so_lines 品名 × 途程包裝工序的實際對照（有途程的 P 品號 5,819 行）。

export interface CategoryRule {
  /** 顯示用品類名稱 */
  label: string
  /** 全部符合才算命中；第一個 RegExp 命中的文字會顯示在來源說明（例：品名「杯墊」） */
  match: RegExp[]
  /** 對應的線上包裝站工序（operation_times.op_name） */
  opName: string
}

export const CATEGORY_RULES: readonly CategoryRule[] = [
  // 鑰匙圈：先判串數。注意「串串壓克力鑰匙圈」是商品名，不是 2 個/串（途程實際多掛「常規包裝/鑰匙圈」）
  { label: '鑰匙圈(串3)', match: [/鑰匙圈|钥匙圈/, /串\s*3|[3三]\s*個\s*[/／]\s*串/], opName: '常規包裝/鑰匙圈(串3)' }, // 0.86
  { label: '鑰匙圈(串2)', match: [/鑰匙圈|钥匙圈/, /串\s*2|[2二兩]\s*個\s*[/／]\s*串/], opName: '常規包裝/鑰匙圈(串2)' }, // 0.6
  { label: '鑰匙圈', match: [/鑰匙圈|钥匙圈|鎖匙圈/], opName: '常規包裝/鑰匙圈' }, // 0.4
  // 立牌：拼板／場景／萬年曆（多片組裝）→ 組合／旋轉 → 單件
  { label: '拼板立牌', match: [/拼板.*立牌|場景立牌|多插件|萬年曆/], opName: '常規包裝/拼板立牌' }, // 2
  { label: '立牌(組合)', match: [/立牌/, /組合|旋轉/], opName: '常規包裝/立牌(組合)' }, // 1.71
  { label: '立牌(單件)', match: [/立牌/], opName: '常規包裝/立牌(單件)' }, // 1
  { label: '御守', match: [/御守/], opName: '常規包裝/壓克力貼合御守' }, // 1.2
  { label: '色紙', match: [/色紙/], opName: '常規包裝/壓克力色紙' }, // 1.2
  { label: '畫板', match: [/畫板|喜帖/], opName: '常規包裝/壓克力畫板(支架)' }, // 1（壓克力喜帖途程也掛畫板）
  { label: '晶磚(大)', match: [/晶磚/, /大/], opName: '常規包裝/壓克力晶磚(大)' }, // 1.2
  { label: '晶磚(小)', match: [/晶磚/], opName: '常規包裝/壓克力晶磚(小)' }, // 0.86
  { label: '磁鐵', match: [/磁鐵/], opName: '常規包裝/壓克力磁鐵' }, // 0.67
  { label: '氣囊手機支架', match: [/氣囊/], opName: '常規包裝/氣囊手機支架' }, // 0.6
  { label: '金屬手機支架', match: [/金屬.*手機支架|手機支架.*金屬/], opName: '常規包裝/金屬手機支架' }, // 0.75
  { label: '手機支架', match: [/手機支架|手機立架/], opName: '常規包裝/手機支架' }, // 0.86（附加表「手機立架」即此工序）
  // 燈箱要排在「吊飾」前：「LED小燈箱吊飾」途程掛的是夜燈燈箱類
  { label: '夜燈燈箱', match: [/燈箱|夜燈|燈相框/], opName: '常規包裝/夜燈燈箱類' }, // 1.33
  { label: '滑蓋卡套', match: [/滑蓋.{0,2}卡套/], opName: '常規包裝/滑蓋卡套' }, // 0.75（品名多寫「滑蓋式卡套」）
  // 其他卡套（橫式、PVC 造型卡套）無專屬工序，推定比照證件套
  { label: '證件套／卡套', match: [/證件套|卡套/], opName: '常規包裝/證件套' }, // 0.6
  { label: '杯墊', match: [/杯墊/], opName: '常規包裝/杯墊類' }, // 0.6
  { label: '飲料提袋', match: [/提袋|杯套/], opName: '常規包裝/飲料提袋' }, // 0.86
  { label: '帆布袋', match: [/帆布.*袋|束口袋|便當袋|環保袋/], opName: '常規包裝/帆布袋' }, // 0.75
  { label: '拼板貼紙', match: [/拼板.*貼紙/], opName: '常規包裝/拼板貼紙(單張)' }, // 0.3
  // 標籤貼紙商品：途程「標籤紙印刷」在包裝站掛的就是「標籤貼紙」工序
  { label: '標籤貼紙', match: [/標籤貼/], opName: LABEL_OP }, // 0.02
  { label: '貼紙', match: [/貼紙|靜電貼/], opName: '常規包裝/一般貼紙(單入)' }, // 0.2
  { label: '馬克杯', match: [/馬克杯|玻璃杯|陶瓷杯/], opName: '常規包裝/馬克杯' }, // 0.75
  { label: '保溫瓶', match: [/保溫瓶|保溫杯|冰霸杯|不[銹鏽]鋼杯|隨行杯/], opName: '常規包裝/保溫瓶類' }, // 0.75
  { label: '滑鼠墊', match: [/滑鼠墊|鼠墊/], opName: '常規包裝/滑鼠墊' }, // 1
  { label: '造型抱枕', match: [/造型抱枕/], opName: '常規包裝/造型抱枕' }, // 1.2
  // 抱枕尺寸無法從品名可靠判斷 → 一律以「小」計（途程現況也都掛抱枕(小)）
  { label: '抱枕', match: [/抱枕|枕套/], opName: '常規包裝/抱枕(小)' }, // 1.2
  { label: '胸章', match: [/胸章|徽章/], opName: '常規包裝/胸章' }, // 0.38
  { label: '掛軸', match: [/掛軸/], opName: '常規包裝/掛軸' }, // 2.4
  { label: '無框畫', match: [/無框畫/], opName: '常規包裝/無框畫' }, // 1.2
  // 只收「鏡子」類商品；「鏡面」是壓克力表面處理，不能算
  { label: '小圓鏡', match: [/圓鏡|方鏡|流沙鏡|化妝鏡/], opName: '常規包裝/小圓鏡' }, // 1
  { label: '毛巾(中)', match: [/運動毛巾/], opName: '常規包裝/毛巾(中)30*90以內' }, // 0.6（運動毛巾途程掛中）
  { label: '毛巾(大)', match: [/毛毯|浴巾/], opName: '常規包裝/毛巾(大)70*140以內' }, // 0.8
  { label: '毛巾(小)', match: [/方巾|毛巾/], opName: '常規包裝/毛巾(小)30*30以內' }, // 0.4
  { label: '野餐墊', match: [/野餐墊|地墊/], opName: '常規包裝/野餐墊' }, // 0.8
  { label: '卡片', match: [/卡片|悠遊卡|明信片|PVC.{0,2}卡|NFC/i], opName: '常規包裝/卡片' }, // 0.75
  { label: '服飾', match: [/T恤|帽T|衣服|服飾|上衣|外套|短袖|長袖|POLO/i], opName: '常規包裝/服飾類' }, // 0.75
  // 吊飾放最後：避免「串串(吊墜)雙閃圓形胸章」「LED小燈箱吊飾」被當成鑰匙圈
  { label: '吊飾', match: [/吊飾|吊墜/], opName: '常規包裝/鑰匙圈' }, // 0.4
]

// ── 包裝方式（erp_so_lines.packing）解析 ──────────────────────────────

/** 包裝方式中偵測得到、但工序總表沒有附加工時的元素（列入 work.gaps，不計工時） */
const PACKING_GAP_RULES: readonly { label: string; re: RegExp; unless?: RegExp }[] = [
  { label: '牛皮盒', re: /牛皮/ },
  { label: '飛機盒', re: /飛機盒/ },
  { label: '紙盒', re: /紙盒|彩盒|白盒|禮盒|卡盒/, unless: /牛皮/ },
  { label: 'EVA 內襯', re: /EVA/i },
  { label: '鋁箔袋', re: /鋁箔|铝箔|鋁袋/ },
  { label: '氣泡袋', re: /氣泡|气泡/ },
  { label: '夾鏈袋', re: /夾鏈|夾鍊|夾链/ },
  { label: '條碼', re: /條碼|条码/ },
  { label: '證紙', re: /證紙/ },
  { label: '五金組裝', re: /D字|龍蝦|珠鍊|珠鏈|門扣|門釦|掛繩|O字[鍊鏈]|吊環|[星貓桃月][型形心亮頭]?扣/ },
  { label: '放數', re: /放數/ },
  { label: '並串', re: /並串/ },
]

/**
 * 取出「包裝方式」本體：
 *   - 「-||-」之後是訂單附註（例：「OPP-||-盡量中午送到…」），不是包裝方式；
 *   - 有 Tab／換行的多段文字，後段幾乎都是業務附註（「5款要做磁鐵…\t2款做貼紙…」），只取第一段；
 *   - 1,600 列是佔位「.」→ 視為空白。
 * 空白字元一併移除（「客供「貼 紙」代貼」這種寫法）。
 */
export function packingMethodText(packing: string | null | undefined): string {
  if (!packing) return ''
  const head = packing.split('-||-')[0].split(/[\t\r\n]/)[0]
  const s = head.replace(/\s+/g, '')
  return /^[.。．、,，\-_]*$/.test(s) ? '' : s
}

// ── 型別 ────────────────────────────────────────────────────────────

export type StdRouteType = '自製' | '常平' | '委外'

export interface StdOp {
  opName: string
  /** 分/件/1 人 */
  perUnit: number
}

/**
 * 工時查表（loadStdTimeTables 產出）。全部是純物件，可 JSON 序列化、可放伺服器記憶體快取。
 */
export interface StdTimeTables {
  /** 包裝站工序 op_name → 每件分鐘（1 人；含 QC 與「/N人作業」列，查詢時再處理） */
  packagingOps: Record<string, number>
  /** 品號 → 途程名稱 */
  itemRoutes: Record<string, string>
  /**
   * 途程名稱 → 包裝站「非 QC」工序（依 sequence）。
   * 途程存在但沒有包裝作業（例：委外/11天回＝轉運站→QC檢驗/入庫）＝空陣列；
   * 品號掛了不存在的途程（例：「（無需工序）」）＝查不到 key。
   */
  routePackagingOps: Record<string, StdOp[]>
  /** 載入時間（ISO） */
  loadedAt: string
  counts: { packagingOps: number; routeOperations: number; itemRoutes: number }
}

export interface StdTimeInput {
  routeType: StdRouteType
  itemCode: string | null
  /** ERP 品名（erp_so_lines.description），可含「客製 |」前綴、[規格]、-||- 品名備註 */
  itemName: string
  /** 包裝方式（erp_so_lines.packing） */
  packing: string | null
  /** 計算用數量（本卡可包量或預計量） */
  qty: number
  /** 常平出貨備註（【常平出貨】行，去不去前綴都可以） */
  cpShipNote: string | null
  /** 選填：塔台該批包裝站工序名（sara job_name＝op_name）；途程對不到時的備援（設計 §五 自製） */
  saraJobNames?: string[] | null
}

export interface StdTimeResult {
  /** 估計分鐘（1 人，已套最少 10 分鐘）；工時未知時為 0，請看 unknown */
  minutes: number
  /** 一行來源說明（＝work.explain） */
  basis: string
  unknown: boolean
  /** 完整拆解，可直接放進 PackagingCard.work */
  work: WorkEstimate
}

// ── 載入（唯讀）──────────────────────────────────────────────────────

/**
 * 分頁讀完整張表（Supabase 單次上限 1000 列）：第一頁帶 exact count，其餘頁並行抓；
 * 每頁都 order by id，確保 range 分頁穩定。
 */
async function fetchAllRows<T>(
  supabase: SupabaseAdmin,
  table: string,
  select: string,
  filter?: { column: string; value: string },
): Promise<T[]> {
  const build = (withCount: boolean) => {
    let q = supabase.from(table).select(select, withCount ? { count: 'exact' } : undefined)
    if (filter) q = q.eq(filter.column, filter.value)
    return q.order('id', { ascending: true })
  }
  const first = await build(true).range(0, PAGE_SIZE - 1)
  if (first.error) throw new Error(`讀取 ${table} 失敗：${first.error.message}`)
  const rows = [...((first.data ?? []) as unknown as T[])]
  const total = first.count ?? rows.length
  if (total > PAGE_SIZE) {
    const offsets: number[] = []
    for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) offsets.push(offset)
    const pages = await Promise.all(offsets.map(async (offset) => {
      const { data, error } = await build(false).range(offset, offset + PAGE_SIZE - 1)
      if (error) throw new Error(`讀取 ${table} 失敗：${error.message}`)
      return (data ?? []) as unknown as T[]
    }))
    for (const p of pages) rows.push(...p)
  }
  return rows
}

/** 讀工時三表（唯讀），整理成查表結構 */
export async function loadStdTimeTables(supabase: SupabaseAdmin): Promise<StdTimeTables> {
  const [ot, ro, ir] = await Promise.all([
    fetchAllRows<{ op_name: string | null; std_time_min: number | string | null }>(
      supabase, 'operation_times', 'id, op_name, std_time_min', { column: 'station', value: PACKAGING_STATION }),
    fetchAllRows<{ route_id: string | null; sequence: number | null; op_name: string | null }>(
      supabase, 'route_operations', 'id, route_id, sequence, op_name'),
    fetchAllRows<{ item_code: string | null; route_id: string | null }>(
      supabase, 'item_routes', 'id, item_code, route_id'),
  ])

  const packagingOps: Record<string, number> = {}
  for (const r of ot) {
    const name = (r.op_name ?? '').trim()
    const std = Number(r.std_time_min)
    if (name && Number.isFinite(std)) packagingOps[name] = std
  }

  // 每條途程都建 key（沒有包裝作業＝空陣列），才分得出「途程沒有包裝工序」與「途程不存在」
  const routeRows: Record<string, { sequence: number; opName: string }[]> = {}
  for (const r of ro) {
    const routeId = (r.route_id ?? '').trim()
    const opName = (r.op_name ?? '').trim()
    if (!routeId) continue
    const list = routeRows[routeId] ?? (routeRows[routeId] = [])
    if (opName) list.push({ sequence: Number(r.sequence ?? 0), opName })
  }
  const routePackagingOps: Record<string, StdOp[]> = {}
  for (const [routeId, list] of Object.entries(routeRows)) {
    routePackagingOps[routeId] = list
      .sort((a, b) => a.sequence - b.sequence)
      .map((x) => resolvePackagingOp(x.opName, packagingOps))
      .filter((x): x is StdOp => x !== null && !isQcOp(x.opName))
  }

  const itemRoutes: Record<string, string> = {}
  for (const r of ir) {
    const code = (r.item_code ?? '').trim()
    const routeId = (r.route_id ?? '').trim()
    if (code && routeId) itemRoutes[code] = routeId
  }

  return {
    packagingOps,
    itemRoutes,
    routePackagingOps,
    loadedAt: new Date().toISOString(),
    counts: { packagingOps: ot.length, routeOperations: ro.length, itemRoutes: ir.length },
  }
}

// ── 查表小工具 ─────────────────────────────────────────────────────

/**
 * op_name → 包裝站工序（1 人每件分鐘）；不是包裝站工序回 null。
 * 「常規包裝/X /4人作業」這類多人列是「1 人工時 ÷ N」的牆鐘時間，換回 1 人值，避免排程時和人數重複相除。
 */
function resolvePackagingOp(opName: string, packagingOps: Record<string, number>): StdOp | null {
  const name = opName.trim()
  const multi = name.match(/^(.*?)\s*\/\s*(\d+)\s*人作業$/)
  if (multi) {
    const base = multi[1].trim()
    if (packagingOps[base] !== undefined) return { opName: base, perUnit: packagingOps[base] }
    if (packagingOps[name] !== undefined) return { opName: base, perUnit: round2(packagingOps[name] * Number(multi[2])) }
    return null
  }
  return packagingOps[name] !== undefined ? { opName: name, perUnit: packagingOps[name] } : null
}

/** 品號查途程：原碼 → 大寫 → SARA 正規化碼（「.」「+」改「-」，例 PACRTSPI0.8-KZ → PACRTSPI0-8-KZ） */
function lookupRoute(itemCode: string | null, tables: StdTimeTables): string | null {
  const raw = (itemCode ?? '').trim()
  if (!raw) return null
  for (const code of [raw, raw.toUpperCase(), raw.toUpperCase().replace(/[.+]/g, '-')]) {
    const routeId = tables.itemRoutes[code]
    if (routeId) return routeId
  }
  return null
}

/**
 * 品名 → 比對用字串（依序）：
 *   1. 商品短名：去前綴、去 -||- 備註、去 [規格]，再取第一個空白前（「PU皮軟胸章 PU皮 / 58mm…」→「PU皮軟胸章」）
 *   2. 整段商品名稱（沒有 [ 的品名，規格直接接在後面）
 */
export function productNameCandidates(itemName: string): string[] {
  const main = (itemName ?? '').split('-||-')[0]
  const stripped = main.replace(/^\s*(打樣\s*[/／]\s*)?(客製\s*[|｜]\s*)?/, '').trim()
  const beforeSpec = stripped.split('[')[0].trim() || stripped
  const short = beforeSpec.split(/\s/)[0] || beforeSpec
  return short === beforeSpec ? [short] : [short, beforeSpec]
}

/** 品名關鍵字 → 品類（只回傳線上 operation_times 查得到工序的規則） */
export function matchCategory(
  itemName: string,
  tables: Pick<StdTimeTables, 'packagingOps'>,
): { rule: CategoryRule; op: StdOp; keyword: string } | null {
  for (const text of productNameCandidates(itemName)) {
    if (!text) continue
    for (const rule of CATEGORY_RULES) {
      if (!rule.match.every((re) => re.test(text))) continue
      const op = resolvePackagingOp(rule.opName, tables.packagingOps)
      if (!op) continue // 線上沒有這道工序 → 視同對不到，繼續往下找
      const keyword = text.match(rule.match[0])?.[0] ?? rule.label
      return { rule, op, keyword }
    }
  }
  return null
}

/** 常平出貨備註是否標了「未包裝」（D28） */
export function isChangpingUnpacked(cpShipNote: string | null | undefined): boolean {
  return !!cpShipNote && CHANGPING_UNPACKED_RE.test(cpShipNote)
}

/** 基本工序名 → 品類名與已內含的附加（「常規包裝+貼紙/立牌(單件)」→ 立牌(單件)、已含 sticker） */
function describeBaseOp(opName: string): { category: string; included: AddonKey | null } {
  const m = opName.match(/^常規包裝(?:\+(貼紙|雷標|紙卡|盲抽))?\/(.+)$/)
  if (!m) return { category: opName, included: opName === LABEL_OP ? 'label' : null }
  const included: Record<string, AddonKey> = { 貼紙: 'sticker', 雷標: 'laser_label', 紙卡: 'paper_card', 盲抽: 'blind_mix' }
  return { category: m[2], included: m[1] ? included[m[1]] : null }
}

/**
 * 解析包裝方式 → 附加工時與缺口。
 * 每種元素每件最多加一次；多種元素直接相加（工序總表只定義單一附加，組合情形為暫定做法）。
 * 例外：
 *   - 盲抽的 +0.2 在附加表寫明「含混裝+貼紙」→ 有盲抽時貼紙不另計；
 *   - 基本工序已是「常規包裝+貼紙/…」這類附加變體 → 同名附加不重複加；
 *   - 商品本身是貼紙類（一般貼紙／拼板貼紙／標籤貼紙）→ 包裝方式裡的「貼紙」是在講商品，不另計。
 */
export function parsePackingAddons(
  packing: string | null | undefined,
  baseOps: StdOp[],
  tables: Pick<StdTimeTables, 'packagingOps'>,
): { addons: WorkEstimate['addons']; gaps: string[]; notes: string[] } {
  const text = packingMethodText(packing)
  const addons: WorkEstimate['addons'] = []
  const notes: string[] = []
  if (!text) return { addons, gaps: [], notes }

  const primary = baseOps[0] ? describeBaseOp(baseOps[0].opName) : { category: '', included: null }
  const included = new Set<AddonKey>(baseOps.map((o) => describeBaseOp(o.opName).included).filter((k): k is AddonKey => k !== null))
  const isStandee = primary.category === '立牌(單件)' || primary.category === '立牌(組合)'
  const isSingleKeychain = primary.category === '鑰匙圈'
  const isStickerProduct = /貼紙/.test(primary.category) || baseOps.some((o) => o.opName === LABEL_OP)

  const hasBlind = /盲抽|盲包|混[裝装]|扭蛋/.test(text.replace(/不要混[裝装]|不混[裝装]|勿混[裝装]/g, ''))
  const hasSticker = /貼紙/.test(text.replace(/標籤貼紙?/g, ''))
  const hasLabel = /標籤|代印代貼|白標/.test(text)
  const hasLaser = /雷標|鐳標|雷射標|镭标/.test(text)
  const hasCard = /紙卡|背卡|卡頭|空白卡|白卡/.test(text)

  const push = (key: AddonKey, label: string, perUnit: number) => {
    if (included.has(key)) { notes.push(`${label}已含在基本工序`); return }
    addons.push({ key, label, perUnit })
  }

  if (hasSticker && !isStickerProduct) {
    if (hasBlind) notes.push('貼紙已含在盲抽附加工時')
    else push('sticker', '貼紙', isStandee ? ADDON_MINUTES.stickerStandee : ADDON_MINUTES.sticker)
  }
  if (hasLabel) push('label', '標籤', resolvePackagingOp(LABEL_OP, tables.packagingOps)?.perUnit ?? LABEL_STD_DEFAULT)
  if (hasLaser) push('laser_label', '雷標', ADDON_MINUTES.laserLabel)
  if (hasCard) push('paper_card', '紙卡', isSingleKeychain ? ADDON_MINUTES.paperCardKeychain : ADDON_MINUTES.paperCard)
  if (hasBlind) push('blind_mix', '盲抽/混裝', ADDON_MINUTES.blindMix)

  const gaps: string[] = []
  for (const g of PACKING_GAP_RULES) {
    if (g.re.test(text) && !(g.unless && g.unless.test(text))) gaps.push(g.label)
  }
  return { addons, gaps, notes }
}

// ── 計算 ────────────────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100
const fmtStd = (n: number) => String(round2(n))
const fmtNum = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 })

type BaseSource = 'route' | 'sara_job' | 'category_keyword' | 'changping_unpacked'

/** 基本工序來源（自製／委外／常平未包裝共用） */
function resolveBase(input: StdTimeInput, tables: StdTimeTables): { source: BaseSource; ops: StdOp[]; head: string } | { source: 'unknown'; why: string } {
  if (input.routeType === '常平') {
    const hit = matchCategory(input.itemName, tables)
    if (hit) return { source: 'changping_unpacked', ops: [hit.op], head: `常平未包裝→廠內：品名「${hit.keyword}」→ ` }
    const fb = resolvePackagingOp(CHANGPING_FALLBACK_OP, tables.packagingOps) ?? { opName: CHANGPING_FALLBACK_OP, perUnit: CHANGPING_FALLBACK_STD }
    return { source: 'changping_unpacked', ops: [fb], head: '常平未包裝→廠內（品名對不到品類，退回）：' }
  }

  // 1. 途程
  const routeId = lookupRoute(input.itemCode, tables)
  const routeOps = routeId ? tables.routePackagingOps[routeId] : undefined
  if (routeOps && routeOps.length > 0) return { source: 'route', ops: routeOps, head: '途程：' }

  // 2. 塔台該批包裝站工序（呼叫端有給才用）
  const jobOps = (input.saraJobNames ?? [])
    .map((n) => resolvePackagingOp(n, tables.packagingOps))
    .filter((x): x is StdOp => x !== null && !isQcOp(x.opName))
  const uniqJobOps = jobOps.filter((x, i) => jobOps.findIndex((y) => y.opName === x.opName) === i)
  if (uniqJobOps.length > 0) return { source: 'sara_job', ops: uniqJobOps, head: '塔台工序：' }

  // 3. 品名關鍵字
  const hit = matchCategory(input.itemName, tables)
  if (hit) return { source: 'category_keyword', ops: [hit.op], head: `品名「${hit.keyword}」→ ` }

  // 4. 未知：說明卡在哪一步
  const routeWhy = !input.itemCode ? '沒有品號'
    : !routeId ? `品號 ${input.itemCode} 沒有途程`
    : routeOps === undefined ? `途程「${routeId}」不在途程表`
    : `途程「${routeId}」沒有包裝工序`
  return { source: 'unknown', why: `${routeWhy}，品名對不到品類` }
}

/**
 * 估算一張卡的包裝工時（分鐘，1 人）。
 * 回傳 { minutes, basis, unknown } 供排程加總；work 是完整拆解（WorkEstimate），可直接放進卡片。
 */
export function computeStdTime(input: StdTimeInput, tables: StdTimeTables): StdTimeResult {
  const qty = Number.isFinite(input.qty) && input.qty > 0 ? input.qty : 0

  // 常平預設：只做檢驗＋換箱，不加附加工時（貨在常平已包好，D27）
  if (input.routeType === '常平' && !isChangpingUnpacked(input.cpShipNote)) {
    return finish(qty, 'changping_rebox', '常平換箱 ', [{ opName: '常平檢驗＋換箱', perUnit: CHANGPING_REBOX_PER_UNIT }], [], [], [])
  }

  const base = resolveBase(input, tables)
  if (base.source === 'unknown') {
    const { gaps } = parsePackingAddons(input.packing, [], tables)
    const explain = `工時未知：${base.why}`
    return {
      minutes: 0,
      basis: explain,
      unknown: true,
      work: { minutes: null, perUnit: null, qtyBasis: qty, source: 'unknown', explain, baseOps: [], addons: [], gaps, minApplied: false },
    }
  }

  const { addons, gaps, notes } = parsePackingAddons(input.packing, base.ops, tables)
  return finish(qty, base.source, base.head, base.ops, addons, gaps, notes)
}

function finish(
  qty: number,
  source: WorkEstimate['source'],
  head: string,
  baseOps: StdOp[],
  addons: WorkEstimate['addons'],
  gaps: string[],
  notes: string[],
): StdTimeResult {
  const perUnit = round2(baseOps.reduce((s, o) => s + o.perUnit, 0) + addons.reduce((s, a) => s + a.perUnit, 0))
  const raw = round1(perUnit * qty)
  // 沿用 calcEst：有數量、有工時才套最少 10 分鐘
  const minApplied = qty > 0 && perUnit > 0 && raw < MIN_CARD_MINUTES
  const minutes = minApplied ? MIN_CARD_MINUTES : raw

  // 來源說明：「途程：常規包裝/鑰匙圈 0.4 + 紙卡 0.2 = 0.6 分/件 × 300 件 = 180 分」
  const parts = [
    ...baseOps.map((o) => (source === 'changping_rebox' ? fmtStd(o.perUnit) : `${o.opName} ${fmtStd(o.perUnit)}`)),
    ...addons.map((a) => `${a.label} ${fmtStd(a.perUnit)}`),
  ]
  const perUnitText = parts.length > 1 ? `${parts.join(' + ')} = ${fmtStd(perUnit)} 分/件` : `${parts[0]} 分/件`
  let explain = `${head}${perUnitText} × ${fmtNum(qty)} 件 = ${fmtNum(raw)} 分`
  if (minApplied) explain += `（未滿 ${MIN_CARD_MINUTES} 分，以 ${MIN_CARD_MINUTES} 分計）`
  if (notes.length > 0) explain += `；${notes.join('、')}`

  return {
    minutes,
    basis: explain,
    unknown: false,
    work: {
      minutes,
      perUnit,
      qtyBasis: qty,
      source,
      explain,
      baseOps: baseOps.map((o) => ({ opName: o.opName, perUnit: o.perUnit })),
      addons,
      gaps,
      minApplied,
    },
  }
}
