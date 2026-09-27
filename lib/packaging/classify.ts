// 包裝專區 P0 — 待排池區塊判定（純函式：原始列 → 卡片 + 區塊）
//
// 本檔不做任何 I/O：資料由 lib/packaging/pool.ts 分頁讀完後整包傳進來，
// 工時由呼叫端注入（pool.ts 用 lib/packaging/stdTime.ts 包成 WorkEstimator），
// 所以可以在 Node 腳本直接餵真實資料或假資料驗證。
//
// 規格：docs/design/2026-09-27-packaging-schedule.md §3（對應鍵、區塊判定、排除、旗標）。
// 決策編號見 包裝排程計畫/需求決策紀錄.md，註解中以 // Dnn 標示依據。
//
// 資料流（一張卡 = 一個 ARGO SO 品項行，D6）：
//   採購行 erp_pj_sync ──解析 SO 行(§3.2)──┐
//                                          ├─ 切片（已入庫片／未到片，§3.4）→ 區塊 1/1b/2/3/5a/5b/5c
//   塔台 POC/MPO 批（轉運站完工＝到台 D18）─┘
//   塔台 MOT/MOS 批 ── schedule ∪ records 推前站(§3.7) → 區塊 4/4x
//   出單表 30 天內已發單、未上塔台、無採購/製令來源的 SO 行 → 區塊 ns（D44）
//     （「素材單/包裝單」不算，D46；「上過塔台」另以製令號解碼的 SO 數字＋項次比對，D47）
//   同一 SO 行、同區塊的切片合併成一張卡；落在不同區塊 → 拆卡（D7）
//   最後套 D43 範圍：只留「與塔台未結案批相連」∪「30 天內已發單、未上塔台」的卡（規格 §十二）

import {
  POOL_BLOCK_META,
  POOL_BLOCK_ORDER,
  type CardStatus,
  type DangerFlag,
  type DangerFlagCode,
  type PackagingCard,
  type PoolBlock,
  type PoolBlockId,
  type PoolExcluded,
  type PreStationInfo,
  type ShipInfo,
  type SourceDoc,
  type SourceKind,
  type StaleUnsynced,
  type StaleUnsyncedRow,
  type WorkEstimate,
} from '@/lib/packaging/types'
import { decodedTowerKeys, isNonScheduleDocType, soLineDigitsKey } from '@/lib/packaging/saraKeys'
import { CHANGPING_PACK_HINT_RE, CHANGPING_UNPACKED_RE } from '@/lib/packaging/stdTime'
import { addWorkdays, isCovered, workdaysBetween } from '@/lib/packaging/workdays'
import { CP_SHIP_NOTE_TAG } from '@/lib/purchasing/types'

// ─────────────────────────────────────────────────────────────────────
// 原始列形狀（pool.ts 只 select 這些欄位）
// ─────────────────────────────────────────────────────────────────────

/** erp_pj_sync 採購行（doc_type='採購單號'；extra 以 alias 展開） */
export interface RawPoLine {
  doc_no: string
  sub_no: string
  item_code: string | null
  description: string | null
  qty: number | null
  status: string | null
  start_date: string | null
  /** 已往前推 2 工作日的追蹤交期（'YYYY/MM/DD'） */
  end_date: string | null
  customer_vendor: string | null
  so_project_id: string | null
  mbp_lot_no: string | null
  /** POC：＝SO 項次（auto-doc-creation 寫入）；extra.SO_LINE_NO 是 PDL_SEQ 流水號，不可用 */
  tpn_part_no: string | null
  received_qty: string | null
  reject_qty: string | null
  close_flag: string | null
}

/** po_line_tracking（採購專區覆蓋層） */
export interface RawTracking {
  doc_no: string
  sub_no: string
  shipped_at: string | null
  ship_method: string | null
  note: string | null
}

/** changping_ship_marks（僅伺服器端推導旗標，欄位不外流） */
export interface RawShipMark {
  po_no: string | null
  item_code: string | null
  qty: number | null
  ship_date: string | null
  transport: string | null
  match_status: string | null
  matched_lines: { doc_no: string; sub_no: string }[] | null
}

/** erp_so_lines（結案 SO 會被同步刪除 → 查不到＝已結案） */
export interface RawSoLine {
  project_id: string
  line_no: string | number | null
  mbp_part: string | null
  description: string | null
  packing: string | null
  remark2: string | null
  duedate: string | null
  order_qty_oru: number | null
  unit_of_measure_oru: string | null
  partner_name: string | null
  /** 前單號（RO 或上一張 SO）；回頭單也會帶，不能單獨當 RO→SO 橋接 */
  tpn_part_no: string | null
  /** SO 開單日 'YYYY/MM/DD'（表頭） */
  begin_date: string | null
}

export interface RawLot {
  lot_id: number
  mo_nbr: string
  doc_nbr: string | null
  so_line_no: string | null
  product_name: string | null
  lot_nbr: string | null
  qty: number | null
}

export interface RawSchedule {
  lot_id: number | null
  mo_nbr: string
  product_name: string | null
  lot_nbr: string | null
  workcenter_name: string | null
  job_name: string | null
  job_sequence: number | null
  qty: number | null
  /** 累計已報（只有少數列非 null） */
  wip_qty: number | null
  /** null＝未開始 */
  system_status: string | null
  /** 台北鐘面文字 'YYYY-MM-DD HH:mm' */
  plan_end_time: string | null
}

export interface RawRecord {
  mo_nbr: string
  product_name: string | null
  lot_nbr: string | null
  workcenter_name: string | null
  job_name: string | null
  job_sequence: number | null
  status: string | null
  /** 'sara'＝人工報工；'auto_sara'＝系統自動結工 */
  source_type: string | null
  wip_qty: number | null
}

/** 出單表 rows[] 精簡後的一列（pool.ts 攤平 daily_order_sheets） */
export interface RawSheetRow {
  sheet_date: string
  order_number: string
  /** match_line_no || line_no_input */
  line_no: string | null
  doc_type: string | null
  po_number: string | null
  po_sub_no: string | null
  pr_number: string | null
  pr_sub_no: string | null
  has_sketch: boolean
  /** 出單表廠別 T（台北自製）／C（常平）／O（委外）；由單據種類推定（lib/argoerp/dailyOrderSheetShared.ts detectFactory） */
  factory: string | null
  mo_number: string | null
  /** 品名前 40 字（只給 D44 異常清單備援顯示） */
  item_name: string | null
}

/** erp_mo_lines（P0 僅顯示同 SO 行其他製令號） */
export interface RawMoLine {
  project_id: string
  source_order: string | null
  mbp_part: string | null
}

export interface PoolRawData {
  /** 台北今天 YYYY-MM-DD */
  today: string
  poLines: RawPoLine[]
  tracking: RawTracking[]
  shipMarks: RawShipMark[]
  soLines: RawSoLine[]
  lots: RawLot[]
  schedule: RawSchedule[]
  records: RawRecord[]
  sheetRows: RawSheetRow[]
  moLines: RawMoLine[]
  /**
   * D43/D44「是否上過塔台」補查：出單表單號（製令／採購／請購）在 sara_wip_records 找到的 mo_nbr。
   * records 4 萬多列不全抓，pool.ts 只以 unresolvedSheetMoRefs() 的單號精確查（見該函式）。
   */
  saraRefMos: string[]
  /**
   * D47 製令號解碼用的塔台報工紀錄（只要 mo_nbr、lot_nbr，已去重）：
   * sara_wip_records 全部 MOT／MOS ＋ 舊式製令號（＝SO／SOB／RO 號本身）以 legacySaraCandidates() 的單號精確查到的列。
   * lots／schedule／records 另外直接解碼，不必重複放進來。
   */
  saraDecodedMos: { mo_nbr: string; lot_nbr: string | null }[]
}

/** 與 lib/packaging/stdTime.ts computeStdTime 的 input 同形 */
export interface WorkInput {
  routeType: '自製' | '常平' | '委外'
  itemCode: string | null
  itemName: string
  packing: string | null
  qty: number
  cpShipNote: string | null
  /** 自製：塔台該批包裝站（非 QC）工序名；途程對不到時的備援 */
  saraJobNames?: string[] | null
}
export type WorkEstimator = (input: WorkInput) => WorkEstimate

export interface ClassifyResult {
  blocks: PoolBlock[]
  excluded: PoolExcluded
  /** 有任何日期超出內建台灣日曆（退回週一~五） */
  calendarFallback: boolean
  /** D44：發單超過 30 天仍未上塔台 */
  staleUnsynced: StaleUnsynced
  /** 驗證用統計（不回傳給前端） */
  stats: Record<string, number>
}

// ─────────────────────────────────────────────────────────────────────
// 常數與規則
// ─────────────────────────────────────────────────────────────────────

/** D41：常平＝ARGO 採購單廠商代碼 C01510（含 POC 與手動請購→採購），其餘廠商＝委外 */
export const CHANGPING_VENDOR = 'C01510'

/** D13：常平運輸天數預設（台灣工作天）；上線後以實績每月校正 */
export const TRANSIT_WORKDAYS: Record<NonNullable<ShipInfo['method']>, number> = {
  順豐: 3, 空運: 5, 海特快: 7, 一般海運: 13,
}

/** D9：一般 5 個台灣工作天內算緊張；D11：打樣類 3 天 */
const URGENT_WORKDAYS = 5
const URGENT_WORKDAYS_SAMPLE = 3

const PKG_STATION = '包裝站'
const TRANSIT_STATION = '轉運站'
/** D14/D17：QC 工序（品檢）不算包裝，也不是包裝完成訊號 */
const QC_JOBS = new Set(['QC檢驗/入庫', 'QC檢驗'])
/** D18：轉運站「委外/N天回」報完工＝貨已回到台灣 */
const TRANSIT_JOB_RE = /^委外\/.*天回/

const SO_NO_RE = /^(SO|SOB|RO)[A-Z0-9-]{4,}$/i

/** D44：出單表已發單、未上塔台的時間窗（日曆天，含今天） */
export const NOT_ON_SARA_WINDOW_DAYS = 30

/** D12：非實體行（費用行）品名開頭 */
const FEE_NAME_RE = /^(運費|設計費|急件費|服務費|版費|開版費|刀模費|排版費|加工費|附加費|折扣|會員優惠)/

// ─────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────

const trimOrNull = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 寬鬆日期正規化：'YYYY/MM/DD'、'YYYY/M/D'、'YYYY-MM-DD…'、'YYYYMMDD' → 'YYYY-MM-DD'；不合法回 null */
export function normDate(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  let y: number, m: number, d: number
  let mm = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3] }
  else if ((mm = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = +mm[1]; m = +mm[2]; d = +mm[3] }
  else return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/** timestamptz（ISO）→ 台北日期 */
export function taipeiDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 行號統一成字串（erp_so_lines.line_no 是 text，但防呆數字） */
const lineStr = (v: unknown): string | null => {
  const s = trimOrNull(v)
  if (!s) return null
  return /^\d+(\.0+)?$/.test(s) ? String(parseInt(s, 10)) : s
}

const soLineKeyOf = (so: string, line: string) => `${so}-${line}`

/** po_line_tracking.note 只取【常平出貨】行並去前綴（比照 /api/purchasing/po-public；採購手打備註不外流） */
export function extractCpShipNote(note: string | null | undefined): string | null {
  return (note ?? '')
    .split('\n')
    .filter((l) => l.trimStart().startsWith(CP_SHIP_NOTE_TAG))
    .map((l) => l.trimStart().slice(CP_SHIP_NOTE_TAG.length).trim())
    .filter(Boolean)
    .join('\n') || null
}

/** 寄送方式關鍵字（簡繁都認；海特快要先於一般海運判斷） */
export function detectShipMethod(...texts: (string | null | undefined)[]): ShipInfo['method'] {
  const t = texts.filter(Boolean).join(' ')
  if (!t) return null
  if (/海特/.test(t)) return '海特快'
  if (/顺丰|順豐|SF\d/i.test(t)) return '順豐'
  if (/空运|空運/.test(t)) return '空運'
  if (/海运|海運/.test(t)) return '一般海運'
  return null
}

const asShipMethod = (v: string | null | undefined): ShipInfo['method'] =>
  v === '順豐' || v === '空運' || v === '海特快' || v === '一般海運' ? v : null

/** D12：非實體行（費用行）自動排除；D10：打樣費行（SSCDFE／品名「打樣費」）視為實體少量品，保留 */
export function isNonPhysicalLine(mbpPart: string | null | undefined, description: string | null | undefined): boolean {
  const part = String(mbpPart ?? '').trim().toUpperCase()
  const name = String(description ?? '').trim()
  if (part.startsWith('SSCDFE') || name.startsWith('打樣費')) return false
  if (/^[SA]/.test(part)) return true // S*＝服務/費用、A*＝附加費/折扣（規格 §2.1 品號前綴實測）
  return FEE_NAME_RE.test(name)
}

/**
 * D10/D11 輔助規則：ERP 品名含「打樣」（含「打樣費」行）＝打樣類。
 * 先剔除否定與引述前次打樣的寫法，那些其實是大貨行：「無打樣」「非打樣不留樣」「請對打樣單」「比照RO…打樣」
 * 「同核可的打樣效果」「打樣圖層有點問題」「打樣偏黃」「打樣單號RO…」。
 * 誤標打樣會讓區塊 3 門檻從 5 天縮成 3 天（反而少警示），所以寧可窄。
 */
const SAMPLE_NOT_RE =
  /(無|不|免|非|沒有?|没有?|不用|不需|不必)打樣|(對|依|照|按|同|參考|参考|核可的?)打樣|比照[^/,，。\s]{0,16}打樣|打樣(效果|圖層|單號|後)|打樣[^/,，。\s]{0,8}(偏|降)/g

export function nameSaysSample(description: string | null | undefined): boolean {
  return String(description ?? '').replace(SAMPLE_NOT_RE, '').includes('打樣')
}

/** 採購行的來源單號：SO_PROJECT_ID 優先，MBP_LOT_NO 看起來像單號時退用（比照 lib/purchasing/data.ts sourceOrderOf） */
export function sourceOrderOf(po: Pick<RawPoLine, 'so_project_id' | 'mbp_lot_no'>): string | null {
  const so = trimOrNull(po.so_project_id)
  if (so && SO_NO_RE.test(so)) return so.toUpperCase()
  const lot = trimOrNull(po.mbp_lot_no)
  if (lot && SO_NO_RE.test(lot)) return lot.toUpperCase()
  return so ? so.toUpperCase() : null
}

/** POC 採購行在塔台的 mo_nbr（新單 `{單號}-{行}`；舊單無後綴＝單號本身） */
export const pocSaraMo = (po: Pick<RawPoLine, 'doc_no' | 'sub_no'>) => `${po.doc_no}-${po.sub_no}`

// ── D43/D44：塔台單號比對 ──
// 塔台 mo_nbr：常平 POC{單}-{行}（舊單無 -n）、委外 MPO{單}-{行}、自製製令號；出單表記的是製令號／採購單號＋行／請購單號＋行。
// 「同一張單的別行」不算本行上過塔台（常平 POC 常見：同張 POC 的 -1～-12 都有批，唯獨 -13 沒建）。所以只有下列三種算命中：
//   ① 原樣相同；
//   ② 出單表有 -n、塔台是舊式無後綴單號（舊 POC 一單多批，mo_nbr＝單號本身）→ 去掉出單表的 -n 後相同；
//   ③ 出單表沒記項次（無 -n）、塔台有 -n → 去掉塔台的 -n 後相同。
// 兩邊都有 -n 但數字不同 → 不命中（別行）。MOS 補印的日期後綴（-8MM-0914 對 -8MM-0924）也因此不算同一張，
// 要當成同一張的話需另寫 MOS 專用規則（待 Snow 確認），不能沿用通用的 -n 剝除。

/** 單號正規化：去空白、轉大寫 */
export const normMo = (v: string | null | undefined) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '')
const MO_SUFFIX_RE = /-\d+$/
const stripMoSuffix = (m: string) => m.replace(MO_SUFFIX_RE, '')

/** 出單表一列記的塔台候選單號（製令號、採購單號-行、請購單號-行），已正規化 */
export function sheetMoRefs(r: Pick<RawSheetRow, 'mo_number' | 'po_number' | 'po_sub_no' | 'pr_number' | 'pr_sub_no'>): string[] {
  const join = (no: string | null, sub: string | null) => (no ? (sub ? `${no}-${sub}` : no) : null)
  return [r.mo_number, join(r.po_number, r.po_sub_no), join(r.pr_number, r.pr_sub_no)]
    .map(normMo)
    .filter(Boolean)
}

/** 塔台 mo_nbr 比對索引：exact＝原樣；stripped＝有 -n 的單號去掉 -n（只供規則 ③ 用） */
interface SaraMoIndex { exact: Set<string>; stripped: Set<string> }
function saraMoIndex(mos: Iterable<string>): SaraMoIndex {
  const exact = new Set<string>()
  const stripped = new Set<string>()
  for (const m of mos) {
    const n = normMo(m)
    if (!n) continue
    exact.add(n)
    if (MO_SUFFIX_RE.test(n)) stripped.add(stripMoSuffix(n))
  }
  return { exact, stripped }
}

/** 單一單號是否上過塔台（規則 ①②③，見上） */
function moOnSara(x: string, idx: SaraMoIndex): boolean {
  if (idx.exact.has(x)) return true
  return MO_SUFFIX_RE.test(x) ? idx.exact.has(stripMoSuffix(x)) : idx.stripped.has(x)
}
const refsOnSara = (refs: string[], idx: SaraMoIndex) => refs.some((x) => moOnSara(x, idx))

/**
 * 塔台未結案批的 SO 行鍵（D43 範圍 A 的「SO 行＝某未結案批的 (doc_nbr, lot_nbr)」）。
 * 只收製令等非採購批：POC/MPO 批的 lot_nbr 是建批當下的 SO 項次，ERP 改項次後會過期、指到隔壁品項或費用行，
 * 由 classifyPool 以 purchaseLotsBySoLine（品號校正後）另外併入，過期又對不到的不收（寧可少列也不要把隔壁已結案的卡留下）。
 * 製令另有 so_line_no 也算。
 */
function openLotSoLineKeys(lots: RawLot[]): Set<string> {
  const out = new Set<string>()
  for (const l of lots) {
    if (/^(POC|MPO)/i.test(l.mo_nbr)) continue
    const so = trimOrNull(l.doc_nbr)?.toUpperCase()
    if (!so) continue
    const line = lineStr(l.lot_nbr)
    if (line) out.add(soLineKeyOf(so, line))
    const alt = /^(MOT|MOS)/i.test(l.mo_nbr) ? lineStr(l.so_line_no) : null
    if (alt) out.add(soLineKeyOf(so, alt))
  }
  return out
}

/**
 * pool.ts 補查 sara_wip_records 用：ERP SO 行仍開放、出單表有單號、但在 塔台批／排程／已抓的報工紀錄 都對不到的列，
 * 回傳要精確查的 mo_nbr：原樣＋（有 -n 時）去 -n 的舊式單號——正好涵蓋規則 ①②，所以這兩條的結果不受
 * 「前面幾波剛好抓進哪些報工紀錄」影響。
 * 規則 ③（出單表沒記項次、塔台只有 {單號}-n）需要前綴查詢，records 4 萬多列、前綴 like 實測要多 8 秒，
 * 所以不補查：只靠已載入的批／排程／報工紀錄（常平 POC 近 180 天的採購行已在第 ③ 波整批抓進來）。
 */
export function unresolvedSheetMoRefs(raw: SheetSaraInput): string[] {
  const bases = new Set<string>()
  for (const { refs } of unresolvedSheetRows(raw)) {
    if (refs.length === 0) continue
    for (const x of refs) {
      bases.add(x)
      if (MO_SUFFIX_RE.test(x)) bases.add(stripMoSuffix(x))
    }
  }
  return [...bases].sort()
}

/**
 * D47 pool.ts 補查舊式製令號用：與 unresolvedSheetMoRefs 同一批「仍對不到塔台」的出單列，回傳其訂單號本身
 * （舊式製令號＝SO／SOB／RO 號，lot＝項次；sara_wip_records 裡這類列約 3.5 萬筆，不全抓，只精確查候選）。
 * 只收 decodeSaraMo 認得的舊式格式（SO／SOB／RO＋純數字）。
 */
export function legacySaraCandidates(raw: SheetSaraInput): string[] {
  const out = new Set<string>()
  for (const { so } of unresolvedSheetRows(raw)) if (/^(SOB|SO|RO)\d+$/.test(so)) out.add(so)
  return [...out].sort()
}

type SheetSaraInput = Pick<PoolRawData, 'sheetRows' | 'soLines' | 'lots' | 'schedule' | 'records' | 'saraDecodedMos'>

/**
 * ERP SO 行仍開放、出單表有這一行、但在 塔台批／排程／已抓的報工紀錄 都對不到的出單列（pool.ts 補查的共同候選）。
 * 已排除：D46 素材單/包裝單、塔台未結案批的 SO 行、出單表單號已命中（規則 ①②③）、D47 製令號解碼已命中。
 */
function unresolvedSheetRows(raw: SheetSaraInput): { so: string; refs: string[] }[] {
  const openLines = new Set(raw.soLines.map((l) => {
    const line = lineStr(l.line_no)
    return line ? soLineKeyOf(l.project_id.toUpperCase(), line) : ''
  }))
  const lotKeys = openLotSoLineKeys(raw.lots)
  const idx = saraMoIndex([...raw.lots, ...raw.schedule, ...raw.records].map((r) => r.mo_nbr))
  const digitKeys = decodedTowerKeys([...raw.lots, ...raw.schedule, ...raw.records, ...raw.saraDecodedMos])
  const out: { so: string; refs: string[] }[] = []
  for (const r of raw.sheetRows) {
    if (isNonScheduleDocType(r.doc_type)) continue // D46
    const line = lineStr(r.line_no)
    if (!line) continue
    const so = r.order_number.toUpperCase()
    const key = soLineKeyOf(so, line)
    if (!openLines.has(key) || lotKeys.has(key)) continue
    const dk = soLineDigitsKey(so, line)
    if (dk && digitKeys.has(dk)) continue // D47
    const refs = sheetMoRefs(r)
    if (refs.length > 0 && refsOnSara(refs, idx)) continue
    out.push({ so, refs })
  }
  return out
}

const isChangpingPo = (po: RawPoLine) => (po.customer_vendor ?? '').trim().toUpperCase() === CHANGPING_VENDOR

/**
 * 工作天計算包一層：日期不合法時回 null 而不是丟錯；超出內建日曆記下 fallback。
 * 只有「今天以後」超出日曆才算 fallback：舊 RO 單的 2024/2025 交期早已逾期，
 * 逾期天數差幾天不影響排程，不該讓整頁天天亮「行事曆退回週一～五」。
 */
function makeCal(today: string) {
  let fallback = false
  const matters = (d: string | null) => !!d && d >= today && !isCovered(d)
  const touch = (d: string | null) => { if (matters(d)) fallback = true }
  return {
    get fallback() { return fallback },
    covered(d: string | null) { return !matters(d) },
    between(to: string | null): number | null {
      if (!to) return null
      try { touch(to); touch(today); return workdaysBetween(today, to) } catch { return null }
    },
    add(from: string | null, n: number): string | null {
      if (!from) return null
      try { touch(from); const r = addWorkdays(from, n); touch(r); return r } catch { return null }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// 塔台途程：schedule ∪ records（§3.7）
// ─────────────────────────────────────────────────────────────────────

type OpStatus = 'finished' | 'running' | 'pause' | 'pending'

export interface RouteOp {
  seq: number
  station: string
  job: string
  status: OpStatus
  /** 已報 X：schedule.wip_qty（累計）優先，否則 records 同工序 wip_qty 加總 */
  reported: number | null
  /** 應做 Y：schedule.qty */
  required: number | null
  /** 計畫完工日（台北日期） */
  planEnd: string | null
  /** 人工報完工（schedule finished 或 records status=finished 且 source_type='sara'） */
  manualFinished: boolean
  inSchedule: boolean
}

export interface LotRoute {
  mo: string
  product: string
  lotNbr: string
  ops: RouteOp[]
}

const STATUS_RANK: Record<OpStatus, number> = { pending: 0, pause: 1, running: 2, finished: 3 }

const asOpStatus = (v: string | null | undefined): OpStatus =>
  v === 'finished' || v === 'running' || v === 'pause' ? v : 'pending'

/** records 沒有 lot_id → 以 (mo_nbr, product_name, lot_nbr) 三段自然鍵對齊 schedule */
export const routeKeyOf = (mo: string, product: string | null, lot: string | null) =>
  `${mo}|${product ?? ''}|${lineStr(lot) ?? ''}`

/**
 * 以 job_sequence＋工作站＋工序為格，先鋪 schedule（含未開工），再以 records 覆蓋：
 * 任一筆 finished 即 finished；running 優先於 pause（規格 §3.7）。
 * schedule 會把已完工的工序移除，所以前站完工多半只剩 records 看得到。
 */
export function buildLotRoutes(schedule: RawSchedule[], records: RawRecord[]): Map<string, LotRoute> {
  const routes = new Map<string, LotRoute>()
  const opMaps = new Map<string, Map<string, RouteOp & { recSum: number; recCount: number }>>()
  const ensure = (mo: string, product: string | null, lot: string | null) => {
    const k = routeKeyOf(mo, product, lot)
    let r = routes.get(k)
    if (!r) {
      r = { mo, product: product ?? '', lotNbr: lineStr(lot) ?? '', ops: [] }
      routes.set(k, r)
      opMaps.set(k, new Map())
    }
    return { k, ops: opMaps.get(k)! }
  }
  for (const s of schedule) {
    if (s.job_sequence == null) continue
    const { ops } = ensure(s.mo_nbr, s.product_name, s.lot_nbr)
    const station = s.workcenter_name ?? ''
    const job = s.job_name ?? ''
    const status = asOpStatus(s.system_status)
    ops.set(`${s.job_sequence}|${station}|${job}`, {
      seq: s.job_sequence, station, job, status,
      reported: s.wip_qty ?? null,
      required: s.qty ?? null,
      planEnd: trimOrNull(s.plan_end_time)?.slice(0, 10) ?? null,
      manualFinished: status === 'finished',
      inSchedule: true,
      recSum: 0, recCount: 0,
    })
  }
  for (const r of records) {
    if (r.job_sequence == null) continue
    const { ops } = ensure(r.mo_nbr, r.product_name, r.lot_nbr)
    const station = r.workcenter_name ?? ''
    const job = r.job_name ?? ''
    const key = `${r.job_sequence}|${station}|${job}`
    const st = asOpStatus(r.status)
    let op = ops.get(key)
    if (!op) {
      op = {
        seq: r.job_sequence, station, job, status: 'pending',
        reported: null, required: null, planEnd: null,
        manualFinished: false, inSchedule: false, recSum: 0, recCount: 0,
      }
      ops.set(key, op)
    }
    if (STATUS_RANK[st] > STATUS_RANK[op.status]) op.status = st
    if (st === 'finished' && r.source_type !== 'auto_sara') op.manualFinished = true
    if (r.wip_qty != null) { op.recSum += num(r.wip_qty); op.recCount++ }
  }
  for (const [k, r] of routes) {
    const ops = [...opMaps.get(k)!.values()]
    for (const op of ops) {
      if (op.reported == null && op.recCount > 0) op.reported = op.recSum
    }
    r.ops = ops
      .map((op): RouteOp => ({
        seq: op.seq, station: op.station, job: op.job, status: op.status,
        reported: op.reported, required: op.required, planEnd: op.planEnd,
        manualFinished: op.manualFinished, inSchedule: op.inSchedule,
      }))
      .sort((a, b) => a.seq - b.seq || a.station.localeCompare(b.station))
  }
  return routes
}

const isPkgOp = (op: RouteOp) => op.station === PKG_STATION && !QC_JOBS.has(op.job)
const isQcOp = (op: RouteOp) => op.station === PKG_STATION && QC_JOBS.has(op.job)
const isTransitOp = (op: RouteOp) => op.station === TRANSIT_STATION && TRANSIT_JOB_RE.test(op.job)

/**
 * 一批的「到台證據」工序：轉運站「委外/N天回」人工完工（D18）。
 * 舊途程沒有轉運工序（QC 是第一道）→ 包裝站 QC 工序人工報完工也代表貨已在台灣。
 * auto_sara 系統結工一律不算。
 */
function arrivalOps(r: LotRoute): RouteOp[] {
  const transit = r.ops.filter(isTransitOp)
  if (transit.length > 0) return transit.filter((op) => op.manualFinished)
  return r.ops.filter((op) => isQcOp(op) && op.manualFinished)
}

/** D18：轉運站「委外/N天回」人工報完工＝已到台（舊途程無轉運工序時看 QC 人工完工） */
export const routeTransitDone = (routes: LotRoute[]) => routes.some((r) => arrivalOps(r).length > 0)

/**
 * 轉運站已報到台量：各批到台證據工序（見 arrivalOps）的已報量加總。
 * 任一完工工序沒有報工量 → null（無法判斷部分到台，當作全數到台）。
 */
export function transitArrivedQty(routes: LotRoute[]): number | null {
  let total = 0
  for (const r of routes) {
    const done = arrivalOps(r)
    if (done.length === 0) continue
    let max = 0
    for (const op of done) {
      if (op.reported == null) return null
      max = Math.max(max, op.reported)
    }
    total += max
  }
  return total > 0 ? total : null
}

/**
 * 包裝站（非 QC）工序狀態：全部完工 / 已包量（取各包裝工序已報量的最小值）。
 * 只認人工報完工（manualFinished）：auto_sara 系統自動結工可能是入庫時連帶結掉，
 * 若也算數就等於拿入庫當完成（D17/D26 禁止）。
 */
export function routePackaging(routes: LotRoute[], fullQty: number): { hasPkg: boolean; allFinished: boolean; doneQty: number } {
  const ops = routes.flatMap((r) => r.ops.filter(isPkgOp))
  if (ops.length === 0) return { hasPkg: false, allFinished: false, doneQty: 0 }
  const allFinished = ops.every((op) => op.manualFinished)
  const doneQty = Math.min(...ops.map((op) => op.manualFinished
    ? (op.reported ?? op.required ?? fullQty)
    : (op.reported ?? 0)))
  return { hasPkg: true, allFinished, doneQty: Math.max(0, doneQty) }
}

// ─────────────────────────────────────────────────────────────────────
// 旗標
// ─────────────────────────────────────────────────────────────────────

const FLAG_LEVEL: Record<DangerFlagCode, DangerFlag['level']> = {
  overdue: 'danger', due_soon: 'warn', eta_passed: 'warn',
  ship_mark_ambiguous: 'warn', maybe_unshipped_urgent: 'danger', ship_date_unparsed: 'info', transit_unknown: 'info',
  partial_received: 'info',
  so_line_ambiguous: 'warn', so_line_unresolved: 'warn', so_line_mismatch: 'info',
  qc_report_mismatch: 'info', tower_lot_closed: 'info',
  partial_arrived: 'info', sample_unshipped_danger: 'danger', cp_note_pack_hint: 'info',
  parallel_pre_station: 'info', routing_suspect: 'warn',
  hours_unknown: 'info', calendar_fallback: 'info',
  po_exceeds_so: 'warn', merged_into_mo: 'info', ship_confirm_early: 'info',
  not_on_sara: 'warn',
}

const flag = (code: DangerFlagCode, label: string): DangerFlag => ({ code, label, level: FLAG_LEVEL[code] })

function pushFlag(list: DangerFlag[], f: DangerFlag) {
  if (!list.some((x) => x.code === f.code)) list.push(f)
}

/** 日曆天加減（台北日期字串 YYYY-MM-DD，不經本機時區） */
const addCalendarDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const mdOf = (ymd: string | null) => (ymd ? `${+ymd.slice(5, 7)}/${+ymd.slice(8, 10)}` : '')

/**
 * 往前數 n 個週一~五（不看國定假日）。只用來還原 ARGO 同步 shiftDueDateBackTwoWorkdays 的推算
 * （它也只跳六日），台灣工作天一律用 lib/packaging/workdays.ts。
 */
export function weekdaysBefore(ymd: string, n: number): string {
  let t = Date.parse(`${ymd}T00:00:00Z`)
  for (let left = n; left > 0;) {
    t -= 86_400_000
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) left--
  }
  return new Date(t).toISOString().slice(0, 10)
}

// ─────────────────────────────────────────────────────────────────────
// 切片 → 卡片
// ─────────────────────────────────────────────────────────────────────

interface Slice {
  kind: SourceKind
  block: PoolBlockId
  status: CardStatus
  so: string
  soLineKey: string
  lineNo: string | null
  soLine: RawSoLine | null
  itemCode: string | null
  itemName: string | null
  qty: number
  readyQty: number
  /** ns 卡（D44）可能完全沒有單據（壓克力集單無製令號）→ null */
  source: SourceDoc | null
  /** ns 卡：出單表同時記了多個單號時的其餘來源 */
  extraSources?: SourceDoc[]
  receivedQty: number | null
  ship: ShipInfo | null
  estReady: string | null
  cpNote: string | null
  pre: PreStationInfo | null
  flags: DangerFlag[]
  /** 覆寫預設狀態文字（例：前站已完工但報工量不足） */
  statusLabel?: string
}

const STATUS_LABEL: Record<CardStatus, string> = {
  in_transit: '運送中',
  qc_pending: '品檢中（已到台）',
  ready: '已入庫可包',
  not_shipped_urgent: '未寄出・交期緊張',
  pre_station_running: '前站進行中',
  pre_station_paused: '前站暫停',
  pre_station_finished: '前站已完工',
  no_pre_station: '無前站（待確認）',
  ship_unconfirmed: '出貨待確認',
  not_on_sara: '已發單・塔台未建立',
}

/**
 * 主函式：原始列 → 10 個區塊（依 POOL_BLOCK_ORDER），並套 D43 塔台範圍、產出 D44 異常清單。
 * estimate：工時估算（注入，見 pool.ts）。
 */
export function classifyPool(raw: PoolRawData, estimate: WorkEstimator): ClassifyResult {
  const today = raw.today
  const cal = makeCal(today)
  const stats: Record<string, number> = {}
  const bump = (k: string, n = 1) => { stats[k] = (stats[k] ?? 0) + n }
  const excluded: PoolExcluded = { nonPhysical: 0, closedSo: 0, packagedDone: 0, notInPool: 0, materialPurchase: 0, poExceedsSo: 0, saraClosedOrAbsent: 0 }
  const nonPhysicalKeys = new Set<string>()

  // ── 索引：SO 行 ──
  const soLinesBySo = new Map<string, RawSoLine[]>()
  const soByRo = new Map<string, { so: string; begin: string | null }[]>()
  for (const l of raw.soLines) {
    const so = l.project_id.toUpperCase()
    let arr = soLinesBySo.get(so)
    if (!arr) { arr = []; soLinesBySo.set(so, arr) }
    arr.push(l)
    const ro = trimOrNull(l.tpn_part_no)?.toUpperCase()
    if (ro && ro.startsWith('RO')) {
      let list = soByRo.get(ro)
      if (!list) { list = []; soByRo.set(ro, list) }
      if (!list.some((x) => x.so === so)) list.push({ so, begin: normDate(l.begin_date) })
    }
  }
  const findSoLine = (so: string, line: string | null): RawSoLine | null => {
    if (!line) return null
    return soLinesBySo.get(so)?.find((l) => lineStr(l.line_no) === line) ?? null
  }
  /**
   * 採購行來源單號 → 開放中的訂單號。
   * RO 本身就是 erp_so_lines 的單號（1,121 列 project_id=RO…）→ 先直接用；
   * 查不到才經 erp_so_lines.tpn_part_no＝RO 橋接到轉出的 SO，但 tpn_part_no 其實是「前單號」，
   * 回頭單（例：9 月新 SO 的前單號是 3 月的 RO）也會對到 → 只接受 SO 開單日與採購開單日相差 30 天內的，
   * 否則 4 月的採購行會被掛到 9 月的回頭單上（2026-09-27 實測 29 個 RO 全是這種）。
   */
  const resolveSo = (so: string | null, poStart: string | null): string | null => {
    if (!so) return null
    if (!so.startsWith('RO') || soLinesBySo.has(so)) return so
    const start = normDate(poStart)
    if (!start) return null
    const startMs = Date.parse(start)
    const hit = (soByRo.get(so) ?? [])
      .filter((x) => x.begin && Math.abs(Date.parse(x.begin) - startMs) <= 30 * 86_400_000)
      .sort((a, b) => (a.begin! < b.begin! ? -1 : 1))[0]
    return hit?.so ?? null
  }

  // ── 索引：出單表（D10 打樣單、示意圖、PO 行 → SO 行）──
  const sheetSampleSo = new Set<string>()
  const sketchKeys = new Set<string>()
  const sheetPoToSoLine = new Map<string, { so: string; line: string; date: string }>()
  const sheetPrBySoLine = new Map<string, string>()
  for (const r of raw.sheetRows) {
    const so = r.order_number.toUpperCase()
    const line = lineStr(r.line_no)
    if (r.doc_type === '打樣單') sheetSampleSo.add(so) // D10：主要看出單表「單據種類」（is_sample 存前單號，不能用）
    if (!line) continue
    const k = soLineKeyOf(so, line)
    if (r.has_sketch) sketchKeys.add(k)
    const po = trimOrNull(r.po_number)?.toUpperCase()
    const poSub = lineStr(r.po_sub_no)
    if (po && poSub) {
      const pk = `${po}|${poSub}`
      const prev = sheetPoToSoLine.get(pk)
      if (!prev || prev.date < r.sheet_date) sheetPoToSoLine.set(pk, { so, line, date: r.sheet_date })
    }
    const pr = trimOrNull(r.pr_number)
    const prSub = lineStr(r.pr_sub_no)
    if (pr && /^MPO/i.test(pr) && !sheetPrBySoLine.has(k)) sheetPrBySoLine.set(k, prSub ? `${pr}-${prSub}` : pr)
  }

  // ── 索引：塔台 ──
  const routes = buildLotRoutes(raw.schedule, raw.records)
  const routesByMo = new Map<string, LotRoute[]>()
  for (const r of routes.values()) {
    let arr = routesByMo.get(r.mo)
    if (!arr) { arr = []; routesByMo.set(r.mo, arr) }
    arr.push(r)
  }
  const routeOfLot = (lot: RawLot): LotRoute | null => routes.get(routeKeyOf(lot.mo_nbr, lot.product_name, lot.lot_nbr)) ?? null
  /** sara_lot_progress＝塔台「專案管理表」上仍在製的批；批消失＝塔台已結批（全部工序做完） */
  const activeRouteKeys = new Set(raw.lots.map((l) => routeKeyOf(l.mo_nbr, l.product_name, l.lot_nbr)))
  const activeMos = new Set(raw.lots.map((l) => l.mo_nbr))
  // 新式 mo（{單號}-{行}）一行一批，只看 mo 就好，避免報工紀錄品號寫法不同而誤判結批；舊式 mo 一單多批，要比到品號＋批號
  const isRouteActive = (r: LotRoute) =>
    activeRouteKeys.has(routeKeyOf(r.mo, r.product, r.lotNbr)) || (/-\d+$/.test(r.mo) && activeMos.has(r.mo))
  /**
   * 採購系批（POC/MPO）依 (doc_nbr, lot_nbr)＝(SO, SO 項次) 分組 → SO 行層級的到台訊號。
   * lot_nbr 是建批當下的 SO 項次，ERP 改項次後會過期（指到運費行或隔壁品項）→ 必須品號相符才採用；
   * 不符時改對同 SO 唯一同品號的行，對不到（或同品號多行）就不採用，寧可沒有到台訊號也不要套錯品項。
   */
  const purchaseLotsBySoLine = new Map<string, RawLot[]>()
  for (const lot of raw.lots) {
    if (!/^(POC|MPO)/i.test(lot.mo_nbr)) continue
    const so = trimOrNull(lot.doc_nbr)?.toUpperCase()
    let line = lineStr(lot.lot_nbr)
    if (!so || !line) continue
    const product = lot.product_name ?? ''
    if ((findSoLine(so, line)?.mbp_part ?? null) !== product) {
      let same = (soLinesBySo.get(so) ?? []).filter((l) => (l.mbp_part ?? '') === product && lineStr(l.line_no))
      if (same.length > 1) same = same.filter((l) => num(l.order_qty_oru) === num(lot.qty)) // 同品號多行 → 以批量＝訂單量消歧
      if (same.length !== 1) { bump('lot_line_unmatched'); continue }
      line = lineStr(same[0].line_no)!
      bump('lot_line_remapped')
    }
    const k = soLineKeyOf(so, line)
    let arr = purchaseLotsBySoLine.get(k)
    if (!arr) { arr = []; purchaseLotsBySoLine.set(k, arr) }
    arr.push(lot)
  }

  // ── 索引：採購追蹤、常平出貨標記 ──
  const trackingByLine = new Map<string, RawTracking>()
  for (const t of raw.tracking) trackingByLine.set(`${t.doc_no}|${t.sub_no}`, t)

  // 出貨燈可能誤亮（§3.5）：multi_line 標記以 (po_no, item_code) 分組，數量一對一配對；
  // 配不到標記、也沒有任何 matched 標記的候選行 → ship_mark_ambiguous
  const definitelyMarked = new Set<string>()
  const unparsedShipDate = new Set<string>()
  const parsedShipDate = new Set<string>()
  const markTransport = new Map<string, string>()
  const multiGroups = new Map<string, RawShipMark[]>()
  for (const m of raw.shipMarks) {
    const lines = Array.isArray(m.matched_lines) ? m.matched_lines : []
    for (const ml of lines) {
      const k = `${ml.doc_no}|${ml.sub_no}`
      if (m.ship_date == null) unparsedShipDate.add(k)
      else parsedShipDate.add(k)
      if (m.transport && !markTransport.has(k)) markTransport.set(k, m.transport)
      if (m.match_status === 'matched') definitelyMarked.add(k)
    }
    if (m.match_status === 'multi_line') {
      const gk = `${m.po_no ?? ''}|${m.item_code ?? ''}`
      let arr = multiGroups.get(gk)
      if (!arr) { arr = []; multiGroups.set(gk, arr) }
      arr.push(m)
    }
  }
  const poByLine = new Map<string, RawPoLine>()
  for (const po of raw.poLines) poByLine.set(`${po.doc_no}|${po.sub_no}`, po)
  const ambiguousMark = new Set<string>()
  for (const marks of multiGroups.values()) {
    const cands = new Set<string>()
    for (const m of marks) for (const ml of m.matched_lines ?? []) cands.add(`${ml.doc_no}|${ml.sub_no}`)
    const paired = new Set<string>()
    for (const m of marks) {
      const hit = [...cands].find((k) => !paired.has(k) && num(poByLine.get(k)?.qty) === num(m.qty))
      if (hit) paired.add(hit)
    }
    for (const k of cands) if (!paired.has(k) && !definitelyMarked.has(k)) ambiguousMark.add(k)
  }

  // ── 採購行 → SO 行（§3.2）──
  // 每一步對到的 SO 行都要「品號相同」且（實體採購行時）不是費用行才採用：
  // 出單表 match_line_no／POC TPN 在 ERP 改過項次後會過期，常指到運費行（→ 被 D12 整行排除）或隔壁行
  // （→ 交期、包裝方式、工時全錯）。2026-09-27 實測 3,702 採購行有 23 行出單表項次品號不符；
  // 同品號多行時整串往後位移一格，品號仍相同但數量對不上 → 同單另有「同品號同數量」的行就改依數量對應。
  interface PoCtx {
    po: RawPoLine
    kind: SourceKind
    so: string
    line: string | null
    flags: DangerFlag[]
    /** 出單表指到的項次（品號或數量不符）；後面各步都對不到時才退用，並標 so_line_mismatch */
    sheetFallback: { so: string; line: string; reason: 'item' | 'qty' } | null
  }
  /** 兩個 SO 行的包裝方式／交期／數量有沒有差（雙胞胎行對調時才有實質影響） */
  const linesDiffer = (a: RawSoLine, b: RawSoLine) =>
    (trimOrNull(a.packing) ?? '') !== (trimOrNull(b.packing) ?? '')
    || normDate(a.duedate) !== normDate(b.duedate)
    || num(a.order_qty_oru) !== num(b.order_qty_oru)
  const sameItem = (po: RawPoLine, sl: RawSoLine) => (sl.mbp_part ?? '') === (po.item_code ?? '')
  /** 實體採購行不接受費用行（D12）；採購行本身是費用行時照舊對（之後整行排除） */
  const usableFor = (po: RawPoLine, sl: RawSoLine | null): sl is RawSoLine =>
    !!sl && (isNonPhysicalLine(po.item_code, po.description) || !isNonPhysicalLine(sl.mbp_part, sl.description))
  const mismatchFlag = (sheet: { line: string; reason: 'item' | 'qty' }) => flag('so_line_mismatch', sheet.reason === 'item'
    ? `出單表記的項次 ${sheet.line} 品號與採購品號不同（ERP 可能改過項次），改依品號對應`
    : `出單表記的項次 ${sheet.line} 數量與採購不符、同單另有同品號同數量的項次（ERP 可能改過項次），改依數量對應`)

  const ctxs: PoCtx[] = []
  const pending: PoCtx[] = []
  for (const po of raw.poLines) {
    if ((po.status ?? '').toUpperCase() === 'VOID' || num(po.qty) <= 0) continue // 作廢單、取消行
    const kind: SourceKind = isChangpingPo(po) ? 'changping' : 'outsource' // D41
    const isPoc = /^POC/i.test(po.doc_no)
    // 1. 出單表鍵（出單表是唯一同時帶 MPO 與 PO 的地方）
    const sheetHit = sheetPoToSoLine.get(`${po.doc_no.toUpperCase()}|${lineStr(po.sub_no)}`)
    const sheetSl = sheetHit ? findSoLine(sheetHit.so, sheetHit.line) : null
    let sheetFallback: PoCtx['sheetFallback'] = null
    if (sheetHit && usableFor(po, sheetSl)) {
      const qtyShifted = num(sheetSl.order_qty_oru) !== num(po.qty)
        && (soLinesBySo.get(sheetHit.so) ?? []).some((l) => l !== sheetSl && sameItem(po, l) && usableFor(po, l) && num(l.order_qty_oru) === num(po.qty))
      if (sameItem(po, sheetSl) && !qtyShifted) {
        const flags: DangerFlag[] = []
        // 同單同品號的雙胞胎行：出單表項次與 POC TPN 項次互相對調、且包裝方式／交期不同 → 提醒
        const tl = isPoc ? lineStr(po.tpn_part_no) : null
        const tsl = tl && tl !== sheetHit.line ? findSoLine(sheetHit.so, tl) : null
        if (tsl && sameItem(po, tsl) && usableFor(po, tsl) && linesDiffer(tsl, sheetSl)) {
          pushFlag(flags, flag('so_line_ambiguous', `出單表記項次 ${sheetHit.line}、採購 TPN 記項次 ${tl}（同品號但包裝方式／交期不同），暫依出單表，請確認`))
          bump('resolve_sheet_tpn_conflict')
        }
        ctxs.push({ po, kind, so: sheetHit.so, line: sheetHit.line, flags, sheetFallback: null })
        bump('resolve_sheet')
        continue
      }
      sheetFallback = { so: sheetHit.so, line: sheetHit.line, reason: qtyShifted ? 'qty' : 'item' }
      bump(qtyShifted ? 'sheet_qty_shifted' : 'sheet_item_mismatch')
    } else if (sheetHit && sheetSl) {
      bump('sheet_points_to_fee_line')
    }
    const src = sourceOrderOf(po)
    const resolved = src ? resolveSo(src, po.start_date) : null
    // 出單表的訂單號可信（只有項次會過期）；來源單號對不到開放中的 SO 時退用出單表的
    const so = resolved && soLinesBySo.has(resolved) ? resolved : sheetHit && sheetSl ? sheetHit.so : null
    if (!so) {
      // 無來源 SO＝備料/庫存單，不進池；SO/RO 已結案（同步只抓 OPEN/UNSIGNED，結案單會被對帳刪除）
      if (!src) bump('po_no_so')
      else { excluded.closedSo++; bump(src.startsWith('RO') ? 'closed_ro' : 'closed_so') }
      continue
    }
    const flags: DangerFlag[] = []
    if (sheetFallback) pushFlag(flags, mismatchFlag(sheetFallback))
    // 2. POC：TPN_PART_NO＝SO 項次，且品號相符、不是費用行
    if (isPoc) {
      const tl = lineStr(po.tpn_part_no)
      const sl = findSoLine(so, tl)
      if (usableFor(po, sl) && sameItem(po, sl)) {
        ctxs.push({ po, kind, so, line: tl, flags, sheetFallback: null })
        bump('resolve_poc_tpn')
        continue
      }
    }
    pending.push({ po, kind, so, line: null, flags, sheetFallback })
  }
  // 3. SO＋品號（＋數量一對一）
  const groups = new Map<string, PoCtx[]>()
  for (const c of pending) {
    const gk = `${c.so}|${c.po.item_code ?? ''}`
    let arr = groups.get(gk)
    if (!arr) { arr = []; groups.set(gk, arr) }
    arr.push(c)
  }
  for (const list of groups.values()) {
    const so = list[0].so
    const po0 = list[0].po
    const cands = (soLinesBySo.get(so) ?? []).filter((l) => sameItem(po0, l) && usableFor(po0, l) && lineStr(l.line_no))
    if (cands.length === 1) {
      for (const c of list) { c.line = lineStr(cands[0].line_no); bump('resolve_item_single') }
    } else if (cands.length > 1) {
      const used = new Set<string>()
      const alloc = new Map<string, number>()
      const rest: PoCtx[] = []
      for (const c of list) {
        const hits = cands.filter((l) => !used.has(lineStr(l.line_no)!) && num(l.order_qty_oru) === num(c.po.qty))
        const hit = hits[0]
        if (hit) {
          const ln = lineStr(hit.line_no)!
          used.add(ln); c.line = ln
          alloc.set(ln, (alloc.get(ln) ?? 0) + num(c.po.qty))
          // 同品號同數量的雙胞胎行只能先到先配；包裝方式或交期不同時才有實質影響 → 提醒
          if (hits.some((h) => linesDiffer(h, hit))) {
            pushFlag(c.flags, flag('so_line_ambiguous', `同單同品號同數量有 ${hits.length} 行、包裝方式或交期不同，暫配項次 ${ln}，請確認`))
            bump('resolve_item_qty_twin')
          }
          bump('resolve_item_qty')
        } else rest.push(c)
      }
      const left = cands.filter((l) => !used.has(lineStr(l.line_no)!))
      for (const c of rest) {
        if (left.length === 1) { c.line = lineStr(left[0].line_no); bump('resolve_item_left1'); continue }
        const pool = left.length > 0 ? left : cands
        let best = pool[0]
        let bestFree = -Infinity
        for (const l of pool) {
          const free = num(l.order_qty_oru) - (alloc.get(lineStr(l.line_no)!) ?? 0)
          if (free > bestFree) { best = l; bestFree = free }
        }
        const ln = lineStr(best.line_no)!
        c.line = ln
        alloc.set(ln, (alloc.get(ln) ?? 0) + num(c.po.qty))
        pushFlag(c.flags, flag('so_line_ambiguous', `同單同品號有 ${cands.length} 行，無法確定對應哪一行（暫配項次 ${ln}）`))
        bump('resolve_item_ambiguous')
      }
    } else {
      // 品號對不到（常平 POC 暫代碼如 C1-1）：依序退用 POC 的 TPN 項次、出單表項次（存在且不是費用行），標品號不符
      for (const c of list) {
        const tl = /^POC/i.test(c.po.doc_no) ? lineStr(c.po.tpn_part_no) : null
        const fb = c.sheetFallback
        const withoutMismatch = c.flags.filter((f) => f.code !== 'so_line_mismatch')
        if (tl && usableFor(c.po, findSoLine(so, tl))) {
          c.line = tl
          c.flags = withoutMismatch
          pushFlag(c.flags, flag('so_line_mismatch', `採購品號 ${c.po.item_code ?? '—'} 與 SO 項次 ${tl} 品號不同，依採購項次對應`))
          bump('resolve_poc_tpn_mismatch')
        } else if (fb && usableFor(c.po, findSoLine(fb.so, fb.line))) {
          c.so = fb.so
          c.line = fb.line
          c.flags = withoutMismatch
          pushFlag(c.flags, flag('so_line_mismatch', `採購品號 ${c.po.item_code ?? '—'} 與出單表項次 ${fb.line} 品號不同，依出單表對應`))
          bump('resolve_sheet_mismatch')
        } else {
          // 4. 都失敗但 SO 存在 → 仍出卡，soLine=null
          pushFlag(c.flags, flag('so_line_unresolved', '對不到 SO 項次（品號不符），請人工確認'))
          bump('resolve_unresolved')
        }
      }
    }
  }
  ctxs.push(...pending)

  // ── 採購行切片（§3.4）與區塊（§3.5）──
  const slices: Slice[] = []
  const soLineMeta = (c: PoCtx) => {
    const sl = c.line ? findSoLine(c.so, c.line) : null
    const soLineKey = c.line ? soLineKeyOf(c.so, c.line) : `${c.so}-?${c.po.doc_no}-${c.po.sub_no}`
    return { sl, soLineKey }
  }
  const isSampleLine = (so: string, sl: RawSoLine | null) =>
    sheetSampleSo.has(so) || nameSaysSample(sl?.description)
  // 部分到台（1b）用：同 SO 行各採購行的已入庫合計、各到台池剩餘量
  const rcvBySoLine = new Map<string, number>()
  for (const c of ctxs) {
    if (!c.line) continue
    const k = soLineKeyOf(c.so, c.line)
    rcvBySoLine.set(k, (rcvBySoLine.get(k) ?? 0) + num(c.po.received_qty))
  }
  const arrivedLeft = new Map<string, number>()
  // 同 SO 行未到量上限＝訂單量 − 各採購行已入庫合計（重複／多開的採購行不再出未到卡）
  const soUnarrivedLeft = new Map<string, number>()
  const exceedsBySoLine = new Map<string, string[]>()
  // 舊式 POC 塔台鍵（mo_nbr＝單號，無 -n）只有「單號＋品號＋批號(SO 項次)」，不含 SO：
  // 同一張 POC 兩個不同 SO 都是項次 1 且同品號時會共用同一條途程 → 先收集這些兄弟行，用數量消歧
  const legacyKeyOf = (c: PoCtx) => `${c.po.doc_no.toUpperCase()}|${c.po.item_code ?? ''}|${c.line ?? ''}`
  const legacySiblings = new Map<string, PoCtx[]>()
  for (const c of ctxs) {
    if (!/^POC/i.test(c.po.doc_no)) continue
    const k = legacyKeyOf(c)
    let arr = legacySiblings.get(k)
    if (!arr) { arr = []; legacySiblings.set(k, arr) }
    arr.push(c)
  }
  const routeQtys = (r: LotRoute) => new Set(r.ops.flatMap((op) => [op.required, op.reported]).filter((n): n is number => n != null))
  // 未到量上限依序分配：已點出貨的採購行優先拿額度（較可能是真的在路上的那一張）
  const isShippedCtx = (c: PoCtx) => !!trackingByLine.get(`${c.po.doc_no}|${c.po.sub_no}`)?.shipped_at
  const ordered = [...ctxs].sort((a, b) => Number(isShippedCtx(b)) - Number(isShippedCtx(a)))

  for (const c of ordered) {
    const { po, kind, so } = c
    const { sl, soLineKey } = soLineMeta(c)
    // D12：對到費用行，或對不到 SO 行時採購行本身就是費用行（加工費、刀模費、開版…）→ 排除
    if (sl ? isNonPhysicalLine(sl.mbp_part, sl.description) : isNonPhysicalLine(po.item_code, po.description)) {
      nonPhysicalKeys.add(soLineKey); continue
    }
    // D6：原物料／耗材採購行（品號 M*／W*：空白板材、PET、空白 T 恤、燈座、PE 膜、鋁箔袋、墨水…）
    // 對不到 SO 行＝SO 上沒有這個品項，是自製的投入料，最後由製令卡包裝 → 不另出卡，否則工時重複計算。
    // 客戶直接買的 M/W 品項（SO 上有同品號行）在前面就會依品號對到，照常出卡。
    if (!sl && /^[MW]/i.test(po.item_code ?? '')) { excluded.materialPurchase++; bump('material_purchase'); continue }
    if (sl && num(sl.order_qty_oru) <= 0) { excluded.notInPool++; continue }

    const lineKey = `${po.doc_no}|${po.sub_no}`
    const qty = num(po.qty)
    const rcv = num(po.received_qty)
    const rej = num(po.reject_qty)
    let rem = Math.max(0, qty - rcv - rej)
    // 單身結案（CLOSE_FLAG=Y）或表頭已結案（status=CLOSE）但沒到齊 → 剩餘量不會再入庫，不再追；
    // 已入庫的部分照常進 2/5b（入庫片不受影響，與 D17/D26 不衝突）
    const closedShort = ((po.close_flag ?? '').toUpperCase() === 'Y' || (po.status ?? '').toUpperCase() === 'CLOSE') && rem > 0
    if (closedShort) bump('po_closed_short')
    const isPoc = /^POC/i.test(po.doc_no)

    // 同 SO 行已由其他採購行入庫足量 → 本行未到量超出的部分不出卡（重複開單／多開，請採購確認）
    if (rem > 0 && !closedShort && sl && c.line) {
      const left = soUnarrivedLeft.get(soLineKey) ?? Math.max(0, num(sl.order_qty_oru) - (rcvBySoLine.get(soLineKey) ?? 0))
      const take = Math.min(rem, left)
      soUnarrivedLeft.set(soLineKey, left - take)
      if (take < rem) {
        let arr = exceedsBySoLine.get(soLineKey)
        if (!arr) { arr = []; exceedsBySoLine.set(soLineKey, arr) }
        arr.push(`${po.doc_no}-${po.sub_no} 未到 ${rem - take}`)
        excluded.poExceedsSo++
        bump(take === 0 ? 'po_exceeds_so_all' : 'po_exceeds_so_part')
        rem = take
      }
    }

    // 塔台批：POC 精準對到本採購行；否則退到 SO 行層級（MPO↔PO 無直接關聯，規格 §3.3）
    let lotRoutes: LotRoute[] = []
    let saraMo: string | null = null
    if (isPoc) {
      lotRoutes = routesByMo.get(pocSaraMo(po)) ?? []
      if (lotRoutes.length === 0) {
        const legacy = (routesByMo.get(po.doc_no) ?? []).filter((r) => r.product === (po.item_code ?? '') && (!c.line || r.lotNbr === c.line))
        const sibs = legacySiblings.get(legacyKeyOf(c)) ?? []
        if (legacy.length > 0 && sibs.length > 1) {
          // 兄弟行共用途程：途程的應做量／報工量等於本行採購量、且沒有兄弟行同數量，才採用
          const byQty = legacy.filter((r) => routeQtys(r).has(qty))
          const twin = sibs.some((o) => o !== c && num(o.po.qty) === qty)
          if (byQty.length > 0 && !twin) { lotRoutes = byQty; bump('legacy_mo_qty_disambiguated') }
          else {
            pushFlag(c.flags, flag('so_line_ambiguous', `塔台舊式批 ${po.doc_no}（品號＋項次 ${c.line ?? '—'}）同單有 ${sibs.length} 個採購行共用，無法分辨，不採用塔台狀態`))
            bump('legacy_mo_ambiguous')
          }
        } else lotRoutes = legacy
      }
      if (lotRoutes.length > 0) saraMo = lotRoutes[0].mo
    }
    // SO 行層級的批已在建索引時校正過項次；這裡再比一次品號（防呆）
    const lotProduct = sl?.mbp_part ?? po.item_code ?? ''
    const soLevelLots = c.line ? (purchaseLotsBySoLine.get(soLineKeyOf(so, c.line)) ?? []).filter((l) => (l.product_name ?? '') === lotProduct) : []
    const soLevelRoutes = soLevelLots.map(routeOfLot).filter((r): r is LotRoute => r !== null)
    if (!saraMo && soLevelLots.length > 0) {
      const own = soLevelLots.find((l) => (kind === 'changping' ? /^POC/i : /^MPO/i).test(l.mo_nbr))
      saraMo = (own ?? soLevelLots[0]).mo_nbr
    }
    if (!saraMo && kind === 'outsource' && c.line) saraMo = sheetPrBySoLine.get(soLineKeyOf(so, c.line)) ?? null

    // P0 暫用完成規則（§3.6）：常平批塔台包裝站非 QC 工序全部完工 → 隱藏；只有這一條。
    // D17/D26：絕不用 ARGO 入庫當完成（入庫＝品檢完＝才要開始包）
    const baseFlags: DangerFlag[] = [...c.flags]
    let pkgDone = 0
    if (kind === 'changping' && lotRoutes.length > 0) {
      const pk = routePackaging(lotRoutes, qty)
      if (pk.allFinished) { excluded.packagedDone++; bump('hide_cp_pkg_finished'); continue }
      pkgDone = pk.doneQty
      // 塔台已結批（批已不在 sara_lot_progress）但沒有包裝完工證據：舊途程 QC 是最後一道，
      // 入庫報 QC 完工的當下批就結掉 → 結批≈入庫，不能當完成（D26），只標旗標請主管確認（P1 改勾選完成）
      if (!lotRoutes.some(isRouteActive)) {
        pushFlag(baseFlags, flag('tower_lot_closed', pk.hasPkg
          ? '塔台已結批，但包裝工序沒有全部報完工，請主管確認是否已包完'
          : '塔台已結批、沒有包裝工序報工（舊途程），請主管確認是否已包完'))
        bump('cp_tower_closed_flagged')
      }
    }
    // 委外 MPO 塔台只有 QC 工序 → P0 無包裝完成訊號（等 SO 結案）

    // D18：塔台 QC檢驗/入庫 於入庫時報完工 → 與 ARGO 入庫互相核對（只核對精準對到的 POC 批）
    if (isPoc && lotRoutes.length > 0) {
      const qc = lotRoutes.flatMap((r) => r.ops.filter(isQcOp))
      if (qc.length > 0) {
        const qcDone = qc.every((op) => op.status === 'finished')
        if (rcv > 0 && !qcDone) pushFlag(baseFlags, flag('qc_report_mismatch', 'ARGO 已入庫，但塔台「QC檢驗/入庫」未報完工（可能漏報）'))
        else if (rcv === 0 && qcDone) pushFlag(baseFlags, flag('qc_report_mismatch', '塔台「QC檢驗/入庫」已完工，但 ARGO 尚未入庫'))
      }
    }

    const tracking = trackingByLine.get(lineKey)
    const cpNote = extractCpShipNote(tracking?.note)
    const source: SourceDoc = {
      kind,
      docType: isPoc ? 'POC' : 'PO',
      docNo: po.doc_no,
      lineNo: po.sub_no,
      saraMo,
      qty: 0,
    }
    const common = {
      kind, so, soLineKey, lineNo: c.line, soLine: sl,
      itemCode: sl?.mbp_part ?? po.item_code, itemName: sl?.description ?? po.description,
      receivedQty: rcv, cpNote, pre: null,
    }

    const readyQty = kind === 'changping' ? Math.max(0, rcv - pkgDone) : rcv // 委外無法扣已包量（D16 一律列出）
    const hasRemainder = rem > 0 && !closedShort
    const partial = readyQty > 0 && hasRemainder

    // 已入庫片：D17 入庫＝品檢完成＝可以開始包
    if (readyQty > 0) {
      const flags = [...baseFlags]
      if (partial) pushFlag(flags, flag('partial_received', `已入庫 ${rcv}／採購 ${qty}，其餘 ${rem} 另列`))
      slices.push({
        ...common,
        block: kind === 'changping' ? '2' : '5b',
        status: 'ready',
        qty: readyQty, readyQty,
        source: { ...source, qty: readyQty },
        ship: null, estReady: null, flags,
      })
    }

    if (!hasRemainder) {
      if (readyQty <= 0) { excluded.notInPool++; bump(rcv > 0 ? 'po_received_all_packed' : 'po_nothing_left') }
      continue
    }

    // 未到片
    const precise = lotRoutes.length > 0
    const transitRoutes = precise ? lotRoutes : soLevelRoutes
    const transitDone = routeTransitDone(transitRoutes)
    const shippedAt = taipeiDate(tracking?.shipped_at)
    const withPartial = (n: number) => {
      const f = [...baseFlags]
      if (partial) pushFlag(f, flag('partial_received', `已入庫 ${rcv}／採購 ${qty}，此卡為未入庫的 ${n}`))
      return f
    }

    // D18/D20：轉運站完工＝已到台，不論有無點已出貨，一律進「品檢中」。
    // 部分到台：轉運站有報工量時，只有「已報到台 − 已入庫」算品檢中，其餘照未到判定（1/3/5a/5c）
    let restQty = rem
    let arrivedToQc = 0
    if (transitDone) {
      let q1b = rem
      const arrived = transitArrivedQty(transitRoutes)
      // SO 行層級的批可能同時對到多個採購行 → 已入庫扣整個 SO 行的量，並以同一池依序分配，避免重複計入
      const rcvBase = precise ? rcv : (rcvBySoLine.get(soLineKey) ?? rcv)
      if (arrived != null) {
        const poolKey = precise ? `po|${lineKey}` : `so|${soLineKey}`
        const left = arrivedLeft.get(poolKey) ?? Math.max(0, arrived - rcvBase)
        q1b = Math.min(rem, left)
        arrivedLeft.set(poolKey, left - q1b)
      }
      if (q1b > 0) {
        const f1b = withPartial(q1b)
        if (q1b < rem) {
          pushFlag(f1b, flag('partial_arrived', `塔台轉運站報到台 ${arrived}、已入庫 ${rcvBase}：此卡為已到台未入庫的 ${q1b}，其餘 ${rem - q1b} 另列`))
          bump('transit_partial')
        }
        slices.push({
          ...common, block: '1b', status: 'qc_pending',
          qty: q1b, readyQty: 0, source: { ...source, qty: q1b },
          ship: shippedAt ? shipInfoOf(tracking, lineKey, cpNote) : null,
          estReady: today, // 已在台灣，品檢完（入庫）即可包，D17 不加緩衝天數
          flags: f1b,
        })
      } else bump('transit_all_received')
      arrivedToQc = q1b
      restQty = rem - q1b
      if (restQty <= 0) continue
    }
    const flags = withPartial(restQty)
    if (arrivedToQc > 0) pushFlag(flags, flag('partial_arrived', `已到台的 ${arrivedToQc} 列在「品檢中」，此卡為尚未到台的 ${restQty}`))

    if (shippedAt) {
      // D1/D19：已亮出貨燈 → 常平區塊 1、委外 5a；預估可包日＝寄出日＋運輸工作天（D13）
      const ship = shipInfoOf(tracking, lineKey, cpNote)
      let estReady: string | null = null
      // 同一行有多筆標記時，只要有一筆日期可解析就照常估（shipped_at 本來就記第一次寄出）
      if (unparsedShipDate.has(lineKey) && !parsedShipDate.has(lineKey)) {
        pushFlag(flags, flag('ship_date_unparsed', '常平出貨日無法解析（出貨時間為匯入時間），不估可包日；原文見常平出貨備註'))
      } else if (ship.transitWorkdays != null) {
        estReady = cal.add(shippedAt, ship.transitWorkdays)
      } else {
        pushFlag(flags, flag('transit_unknown', '寄送方式不明，無法估算到貨日'))
      }
      if (kind === 'changping' && ambiguousMark.has(lineKey)) {
        pushFlag(flags, flag('ship_mark_ambiguous', '常平同單同品號多行，出貨燈可能誤亮，請向常平確認'))
        const due = normDate(sl?.duedate)
        const wl = cal.between(due)
        const th = isSampleLine(so, sl) ? URGENT_WORKDAYS_SAMPLE : URGENT_WORKDAYS
        if (rcv === 0 && wl != null && wl <= th) {
          pushFlag(flags, flag('maybe_unshipped_urgent', '若其實未寄出，交期已緊張（區塊 3 條件）'))
        }
      }
      slices.push({
        ...common, block: kind === 'changping' ? '1' : '5a', status: 'in_transit',
        qty: restQty, readyQty: 0, source: { ...source, qty: restQty },
        ship, estReady, flags,
      })
      continue
    }

    if (kind === 'changping') {
      // D9/D11：ERP 品項行交期往前數 5 個台灣工作天（打樣類 3 天）內仍未寄 → 緊張；含已逾期。D22：不預排，僅提醒
      const due = normDate(sl?.duedate)
      const wl = cal.between(due)
      const th = isSampleLine(so, sl) ? URGENT_WORKDAYS_SAMPLE : URGENT_WORKDAYS
      // 部分入庫、其餘未寄也要提醒（已入庫的部分另列在區塊 2，此卡帶 partial_received 旗標）
      if (wl != null && wl <= th) {
        slices.push({
          ...common, block: '3', status: 'not_shipped_urgent',
          qty: restQty, readyQty: 0, source: { ...source, qty: restQty },
          ship: null, estReady: null, flags,
        })
      } else {
        excluded.notInPool++
        bump('cp_not_shipped_not_urgent')
      }
      continue
    }

    // D20：委外採購行，採購交期往前 2 個工作天仍未點已出貨 → 委外出貨待確認。
    // end_date 的坑：同步時 shiftDueDateBackTwoWorkdays 把原交期 D 往前推 2 個週一~五成 S，
    // 但「推完已早於今天」就回原交期 → 過了 S 之後，下一次同步會把 end_date 改回 D
    // （erp_change_log 實測 2,038 筆 end_date 變動有 1,951 筆是這種）。
    // 所以 end_date 在 S 之前＝S、S 之後＝D；直接比 today ≥ end_date 會在 S 當天出現、D-1 消失、D 再出現。
    // 暫解：一律以 end_date 再往前 2 個週一~五比較 → S 之前提早 2 天列入、S 之後剛好等於 S，不會中途消失
    // （太趕而未倒推的單也因此準時在 S 列入）。
    // 根本解：同步端把原始 DUEDATE 存進 extra，這裡改用台灣日曆算「原交期往前 2 個工作天」（含國定假日）。
    const end = normDate(po.end_date)
    if (end && today >= weekdaysBefore(end, 2)) {
      if (today < end) {
        pushFlag(flags, flag('ship_confirm_early', `採購追蹤交期 ${mdOf(end)}；為避免同步改回原交期時中途消失，交期前 2 個工作天即列入`))
      }
      slices.push({
        ...common, block: '5c', status: 'ship_unconfirmed',
        qty: restQty, readyQty: 0, source: { ...source, qty: restQty },
        ship: null, estReady: null, flags,
      })
    } else {
      excluded.notInPool++
      bump('os_not_due_yet')
    }
  }

  function shipInfoOf(t: RawTracking | undefined, lineKey: string, cpNote: string | null): ShipInfo {
    const method = asShipMethod(t?.ship_method) ?? detectShipMethod(markTransport.get(lineKey), cpNote)
    return {
      shippedAt: taipeiDate(t?.shipped_at),
      method,
      transitWorkdays: method ? TRANSIT_WORKDAYS[method] : null,
    }
  }

  // ── 製令 MOT/MOS（§3.7，D2 前站從塔台讀、D23 可包量＝前站已完成量、D35 無前站）──
  /** 經轉運站回台的製令所屬 SO 行（同 SO 行的常平採購片併入製令卡） */
  const moAbsorbsSoLine = new Set<string>()
  const moLinesBySo = new Map<string, RawMoLine[]>()
  for (const m of raw.moLines) {
    const so = trimOrNull(m.source_order)?.toUpperCase()
    if (!so) continue
    let arr = moLinesBySo.get(so)
    if (!arr) { arr = []; moLinesBySo.set(so, arr) }
    arr.push(m)
  }
  for (const lot of raw.lots) {
    if (!/^(MOT|MOS)/i.test(lot.mo_nbr)) continue
    const so = trimOrNull(lot.doc_nbr)?.toUpperCase()
    const route = routeOfLot(lot)
    if (!route || !so) { bump('mo_no_route_or_so'); continue }
    const pkgOps = route.ops.filter(isPkgOp)
    if (pkgOps.length === 0) { bump('mo_no_pkg_op'); continue } // 不經包裝站（非包裝卡）

    // SO 行：(doc_nbr, lot_nbr)；MOT/MOS 另有 so_line_no 可交叉驗證
    const flags: DangerFlag[] = []
    let line = lineStr(lot.lot_nbr)
    let sl = findSoLine(so, line)
    if (!sl) {
      const alt = lineStr(lot.so_line_no)
      const altSl = findSoLine(so, alt)
      if (altSl) { line = alt; sl = altSl }
    }
    // 製令途程經轉運站「委外/N天回」＝這批貨由常平代工回台，常平 POC 採購卡與本製令卡是同一批實物
    // → 製令卡有出（或已包完隱藏）時只留製令卡，同 SO 行的常平採購片在合併前移除，避免工時重複計算；
    //   製令前站還沒開工（貨還在路上）時不併，讓採購卡照常顯示運送狀態
    const pkgSeq = Math.min(...pkgOps.map((op) => op.seq))
    const absorbKey = sl && line && route.ops.some((op) => isTransitOp(op) && op.seq < pkgSeq) ? soLineKeyOf(so, line) : null
    if (pkgOps.every((op) => op.manualFinished)) {
      if (absorbKey) moAbsorbsSoLine.add(absorbKey)
      // P0 以塔台包裝工序完工代替 D25/D26 的 ARGO 繳庫（EIP 未同步繳庫量，P3 補）
      excluded.packagedDone++; bump('hide_mo_pkg_finished'); continue
    }
    if (!soLinesBySo.has(so)) { excluded.closedSo++; continue }
    if (!sl) {
      line = null
      pushFlag(flags, flag('so_line_unresolved', `塔台批號 ${lot.lot_nbr ?? '—'} 對不到 SO 項次`))
    } else if ((sl.mbp_part ?? '') !== (lot.product_name ?? '')) {
      pushFlag(flags, flag('so_line_mismatch', `SO 項次品號 ${sl.mbp_part ?? '—'} 與塔台品號 ${lot.product_name ?? '—'} 不同`))
    }
    const soLineKey = line ? soLineKeyOf(so, line) : `${so}-?${lot.mo_nbr}`
    if (sl && isNonPhysicalLine(sl.mbp_part, sl.description)) { nonPhysicalKeys.add(soLineKey); continue }

    const lotQty = num(lot.qty) || num(sl?.order_qty_oru)
    const before = route.ops.filter((op) => op.seq < pkgSeq && op.station !== PKG_STATION)
    const maxSeq = before.length > 0 ? Math.max(...before.map((op) => op.seq)) : null
    const preOps = maxSeq == null ? [] : before.filter((op) => op.seq === maxSeq)
    const pkg = routePackaging([route], lotQty)
    const packagingJobs = pkgOps.map((op) => ({ jobName: op.job, status: op.status, reportedQty: op.reported }))
    const otherMos = [...new Set((moLinesBySo.get(so) ?? [])
      .filter((m) => (m.mbp_part ?? '') === (lot.product_name ?? '') && m.project_id !== lot.mo_nbr)
      .map((m) => m.project_id))].sort()
    const source: SourceDoc = {
      kind: 'inhouse', docType: /^MOS/i.test(lot.mo_nbr) ? 'MOS' : 'MOT',
      docNo: lot.mo_nbr, lineNo: null, saraMo: lot.mo_nbr, qty: 0,
    }
    const qtyCard = Math.max(0, lotQty - pkg.doneQty)
    const common = {
      kind: 'inhouse' as const, so, soLineKey, lineNo: line, soLine: sl,
      itemCode: sl?.mbp_part ?? lot.product_name, itemName: sl?.description ?? null,
      receivedQty: null, cpNote: null, ship: null,
    }

    if (preOps.length === 0) {
      // D35：途程只有包裝站、沒有前站 → 需確認（可能是塔台工序錯誤），用現行 schedule ∪ records 判定
      pushFlag(flags, flag('routing_suspect', '塔台途程只有包裝站、沒有前站，可能是工序設定錯誤，請確認'))
      slices.push({
        ...common, block: '4x', status: 'no_pre_station',
        qty: qtyCard, readyQty: qtyCard,
        source: { ...source, qty: qtyCard },
        estReady: null, flags,
        pre: {
          moNbr: lot.mo_nbr, lotNbr: lineStr(lot.lot_nbr), station: null, jobName: null, status: null,
          reportedQty: null, requiredQty: lotQty, parallel: false, packagingJobs, otherMos,
        },
      })
      continue
    }

    // 前站狀態：全部完工 → 已完工；有 running → 進行中；有 pause → 暫停；其餘（部分完工/有報量）→ 進行中
    const parallel = new Set(preOps.map((op) => op.station)).size > 1
    if (parallel) pushFlag(flags, flag('parallel_pre_station', '前站有平行工序，狀態取最落後者、可包量取最小值'))
    const allFinished = preOps.every((op) => op.status === 'finished')
    const anyRunning = preOps.some((op) => op.status === 'running')
    const anyPause = preOps.some((op) => op.status === 'pause')
    const anyStarted = preOps.some((op) => op.status !== 'pending' || num(op.reported) > 0)
    if (!anyStarted) { excluded.notInPool++; bump('mo_pre_not_started'); continue } // P0 只列前站已開工/已完工

    const status: CardStatus = allFinished ? 'pre_station_finished'
      : anyRunning ? 'pre_station_running'
      : anyPause ? 'pre_station_paused'
      : 'pre_station_running'
    // 以「最落後」的那道前站代表顯示
    const rep = [...preOps].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || num(a.reported) - num(b.reported))[0]
    const required = rep.required ?? lotQty
    // D23：可包量＝前站已完成量（已完工＝應做量；進行中/暫停＝min(已報, 應做)），再扣包裝已報量
    const avail = Math.min(...preOps.map((op) => {
      const y = op.required ?? lotQty
      return op.status === 'finished' ? y : Math.min(num(op.reported), y)
    }))
    const readyQty = Math.max(0, Math.min(avail, lotQty) - pkg.doneQty)
    const reported = rep.reported
    let statusLabel: string | undefined
    if (allFinished && reported != null && reported < required) statusLabel = `前站已完工（報工 ${reported}/${required}，紀錄可能不全）`
    // 預估可包日：前站未完工時取塔台計畫完工日
    const estReady = allFinished ? null : (preOps.map((op) => op.planEnd).filter((d): d is string => !!d).sort().pop() ?? null)

    if (absorbKey) moAbsorbsSoLine.add(absorbKey)
    slices.push({
      ...common, block: '4', status, statusLabel,
      qty: qtyCard, readyQty: Math.min(readyQty, qtyCard),
      source: { ...source, qty: qtyCard },
      estReady, flags,
      pre: {
        moNbr: lot.mo_nbr, lotNbr: lineStr(lot.lot_nbr),
        station: parallel ? [...new Set(preOps.map((op) => op.station))].join('＋') : rep.station,
        jobName: parallel ? preOps.map((op) => op.job).join('＋') : rep.job,
        status: rep.status, reportedQty: reported, requiredQty: required, parallel,
        packagingJobs, otherMos,
      },
    })
  }

  // ── D43/D44：塔台範圍與「出單表已發單、未上塔台」（規格 §十二）──
  // 塔台 SARA 目前未結案的批＝sara_lot_progress（批做完即從該表消失）。Snow 以結案檢查流程維護塔台結案，
  // 所以「還在塔台」≈「還沒出貨完」（D43）。取代的是「隱藏舊單」勾選與「只能等 SO 結案」的舊單積壓處理；
  // 包裝站報完工即隱藏（P0 暫用完成規則，excluded.packagedDone）目前仍保留在範圍判定之前——
  // D43 原文寫「取代 D25/D26 的 P0 暫用規則」，這條是否一併取消待 Snow 確認（規格 §12.6）。
  const openLotMos = new Set(raw.lots.map((l) => normMo(l.mo_nbr)))
  const openLotLines = openLotSoLineKeys(raw.lots) // 製令等非採購批
  for (const k of purchaseLotsBySoLine.keys()) openLotLines.add(k) // POC/MPO 批：依品號校正後的 SO 行（過期對不到的不收）
  // 「上過塔台」＝批／排程／報工紀錄任一處有這個單號（已結案批的歷史只剩 records 看得到）
  const saraRows = [...raw.lots, ...raw.schedule, ...raw.records]
  const saraIdx = saraMoIndex(saraRows.map((r) => r.mo_nbr).concat(raw.saraRefMos))
  /** 舊式無後綴 POC 的 (單號, 品號, 批號) → 比到「批號＝SO 項次、品號相同」才算這一行上過塔台 */
  const saraLegacyKeys = new Set(saraRows.map((r) => `${normMo(r.mo_nbr)}|${r.product_name ?? ''}|${lineStr(r.lot_nbr) ?? ''}`))
  /**
   * 從 ERP 採購行推「這個 SO 行上過塔台」：出單表常只記 MOT 號或沒記單號，但實際走 POC
   * （委外常平廠、急件/常平、一般大貨）→ 只看出單表會把已結案的批誤判成未上塔台。
   * 新式 POC＝{單號}-{行}，原樣命中才算；舊式 POC＝單號本身、一單多批，要「批號＝SO 項次且品號相同」才算。
   * 舊式批常開在同 SO 的另一張 POC 底下（例：ERP 本行是 POC…2402-1，塔台批是同 SO 的 POC…2202、批號＝本行項次），
   * 所以舊式比對用「同 SO 所有 POC 單號」。塔台報工紀錄沒有 SO 號，靠 SO 內的 POC 單號＋批號＋品號鎖定。
   */
  const poSaraLines = new Set<string>()
  const pocDocsBySo = new Map<string, Set<string>>()
  const pocItemsByLine = new Map<string, Set<string>>()
  for (const c of ctxs) {
    if (!/^POC/i.test(c.po.doc_no)) continue
    let set = pocDocsBySo.get(c.so)
    if (!set) { set = new Set(); pocDocsBySo.set(c.so, set) }
    set.add(normMo(c.po.doc_no))
    if (!c.line) continue
    const k = soLineKeyOf(c.so, c.line)
    if (saraIdx.exact.has(normMo(pocSaraMo(c.po)))) poSaraLines.add(k)
    let items = pocItemsByLine.get(k)
    if (!items) { items = new Set(); pocItemsByLine.set(k, items) }
    if (c.po.item_code) items.add(c.po.item_code)
  }
  const lineOnSaraByPo = (so: string, line: string, sl: RawSoLine): boolean => {
    const k = soLineKeyOf(so, line)
    if (poSaraLines.has(k)) return true
    const items = new Set(pocItemsByLine.get(k))
    if (sl.mbp_part) items.add(sl.mbp_part)
    for (const doc of pocDocsBySo.get(so) ?? []) for (const it of items) if (saraLegacyKeys.has(`${doc}|${it}|${line}`)) return true
    return false
  }
  /**
   * D47：塔台製令號解碼出的「SO 數字＋項次」（批／排程／已載入報工紀錄 ＋ pool.ts 另抓的 MOT／MOS 與舊式報工紀錄）。
   * 只用來判斷「上過塔台」（ns 與異常清單），不擴大 D43 範圍 (A)：未結案批的 SO 行本來就由 doc_nbr／lot_nbr、so_line_no 認得。
   */
  const towerDigitKeys = decodedTowerKeys([...saraRows, ...raw.saraDecodedMos])
  const decodedOnSara = (so: string, line: string) => {
    const dk = soLineDigitsKey(so, line)
    return !!dk && towerDigitKeys.has(dk)
  }
  const nsFrom = addCalendarDays(today, -(NOT_ON_SARA_WINDOW_DAYS - 1)) // 30 個日曆天含今天
  // 出單表以 SO 行彙整：出單日取最新一張，單號取所有出單列的聯集（重發單時任一張對到塔台就算已上塔台）
  const sheetLines = new Map<string, { so: string; line: string; latest: RawSheetRow; refs: Set<string> }>()
  /** D46：出現在「素材單/包裝單」出單列的 SO 行（之後扣掉也有正常出單列的，另計排除計數） */
  const nonScheduleLines = new Map<string, { so: string; line: string }>()
  for (const r of raw.sheetRows) {
    const line = lineStr(r.line_no)
    if (!line) continue
    const so = r.order_number.toUpperCase()
    const k = soLineKeyOf(so, line)
    // D46：素材單/包裝單本來就不上塔台 → 不出 ns 卡、不進異常清單，也不刷新這一行的最新出單日（包裝單晚發不會重啟 30 天窗）；
    // 同一行若另有正常出單列，照正常列判定
    if (isNonScheduleDocType(r.doc_type)) {
      bump('sheet_non_schedule_doc')
      nonScheduleLines.set(k, { so, line })
      continue
    }
    let e = sheetLines.get(k)
    if (!e) { e = { so, line, latest: r, refs: new Set() }; sheetLines.set(k, e) }
    else if (r.sheet_date > e.latest.sheet_date) e.latest = r
    for (const x of sheetMoRefs(r)) e.refs.add(x)
  }
  /** D46 排除計數：ERP 仍未結案、只出現在素材單/包裝單（沒有任何正常出單列）的 SO 行 */
  let nonScheduleDocLines = 0
  for (const [k, x] of nonScheduleLines) {
    if (sheetLines.has(k) || !findSoLine(x.so, x.line)) continue
    nonScheduleDocLines++
  }
  /** 有採購行或製令對到的 SO 行：由原本區塊判定，不另出 ns 卡 */
  const sourcedLines = new Set(ctxs.filter((c) => c.line).map((c) => soLineKeyOf(c.so, c.line!)))
  /** 30 天內已發單、比對不到塔台的 SO 行（D44 列入） */
  const nsLines = new Set<string>()
  const staleCands: { k: string; so: string; line: string; row: RawSheetRow; itemName: string | null }[] = []
  for (const [k, e] of sheetLines) {
    const sl = findSoLine(e.so, e.line)
    if (!sl) continue // ERP SO 行已結案（同步會刪掉結案單）或項次不存在 → 不必追
    const recent = e.latest.sheet_date >= nsFrom
    if (openLotLines.has(k) || refsOnSara([...e.refs], saraIdx) || lineOnSaraByPo(e.so, e.line, sl)) continue // 已上塔台：交給 D43 範圍判定
    if (decodedOnSara(e.so, e.line)) { // D47：只靠製令號解碼命中（壓克力集單以 MOS 上塔台、舊式製令號＝SO 號…）→ 同樣交給 D43
      bump(recent ? 'd47_hit_recent' : 'd47_hit_stale')
      continue
    }
    if (isNonPhysicalLine(sl.mbp_part, sl.description)) { // D12 費用行本來就不會上塔台
      if (recent) nonPhysicalKeys.add(k)
      continue
    }
    if (!recent) {
      staleCands.push({ k, so: e.so, line: e.line, row: e.latest, itemName: trimOrNull(sl.description) ?? e.latest.item_name })
      continue
    }
    nsLines.add(k)
    if (sourcedLines.has(k)) continue // 例：常平 POC 採購卡但塔台沒建批 → 留原區塊，範圍判定時加 not_on_sara 旗標
    const qty = num(sl.order_qty_oru)
    if (qty <= 0) { excluded.notInPool++; continue }
    // 來源是「推定」：出單表廠別由單據種類推得（含「常平」→C、含「委外」→O、其餘→T，壓克力集單＝T），
    // 不是 ARGO 實際開出的採購／製令；C＝常平、O＝委外、T 與其他＝自製，只用來選工時途程與卡片顏色
    const factory = (e.latest.factory ?? '').trim().toUpperCase()
    const kind: SourceKind = factory === 'C' ? 'changping' : factory === 'O' ? 'outsource' : 'inhouse'
    const lr = e.latest
    const docs: SourceDoc[] = []
    const mo = normMo(lr.mo_number)
    if (/^MO[TS]/.test(mo)) docs.push({ kind: 'inhouse', docType: mo.startsWith('MOS') ? 'MOS' : 'MOT', docNo: mo, lineNo: null, saraMo: null, qty })
    const po = normMo(lr.po_number)
    if (po) {
      const poc = po.startsWith('POC')
      docs.push({ kind: poc || kind === 'changping' ? 'changping' : 'outsource', docType: poc ? 'POC' : 'PO', docNo: po, lineNo: lineStr(lr.po_sub_no), saraMo: null, qty })
    }
    const pr = normMo(lr.pr_number)
    if (pr.startsWith('MPO')) docs.push({ kind: 'outsource', docType: 'MPO', docNo: pr, lineNo: lineStr(lr.pr_sub_no), saraMo: null, qty })
    slices.push({
      kind, block: 'ns', status: 'not_on_sara',
      so: e.so, soLineKey: k, lineNo: e.line, soLine: sl,
      itemCode: sl.mbp_part, itemName: sl.description ?? lr.item_name,
      qty, readyQty: 0,
      source: docs[0] ?? null, extraSources: docs.slice(1),
      receivedQty: null, ship: null, estReady: null, cpNote: null, pre: null, flags: [],
    })
    bump('ns_card_created')
  }

  excluded.nonPhysical = nonPhysicalKeys.size

  // ── 常平採購片併入製令（同一批實物只留製令卡；製令已包完被隱藏時，採購片一起隱藏）──
  const mergedIntoMo = new Map<string, string[]>()
  const keptSlices = slices.filter((s) => {
    if (s.kind !== 'changping' || !moAbsorbsSoLine.has(s.soLineKey)) return true
    let arr = mergedIntoMo.get(s.soLineKey)
    if (!arr) { arr = []; mergedIntoMo.set(s.soLineKey, arr) }
    const label = `${s.source?.docNo ?? ''}-${s.source?.lineNo ?? ''}（${s.qty}）`
    if (!arr.includes(label)) arr.push(label)
    bump('cp_slice_merged_into_mo')
    return false
  })

  // ── 合併：同 SO 行＋同區塊＋同來源類型 → 一張卡 ──
  // 製令（4/4x）例外：一個製令批一張卡（補印 MOS 與原 MOT 前站進度各自不同，合併會只剩第一批的前站資訊），
  // 同 SO 行多批靠下面的拆卡標示 split 呈現
  const groupsByCard = new Map<string, Slice[]>()
  for (const s of keptSlices) {
    const lotPart = s.pre ? `|${s.pre.moNbr}|${s.pre.lotNbr ?? ''}` : ''
    const gk = `${s.soLineKey}|${s.block}|${s.kind}${lotPart}`
    let arr = groupsByCard.get(gk)
    if (!arr) { arr = []; groupsByCard.set(gk, arr) }
    arr.push(s)
  }

  const allCards: PackagingCard[] = []
  for (const list of groupsByCard.values()) {
    const s0 = list[0]
    const sl = s0.soLine
    const so = s0.so
    const qtyCard = list.reduce((a, s) => a + s.qty, 0)
    const qtyReady = list.reduce((a, s) => a + s.readyQty, 0)
    const flags: DangerFlag[] = []
    for (const s of list) for (const f of s.flags) pushFlag(flags, f)

    // 多來源合併：預估可包日取最晚（保守）
    const withShip = list.filter((s) => s.ship)
    const estDates = list.map((s) => s.estReady).filter((d): d is string => !!d).sort()
    const estReady = estDates.length > 0 ? estDates[estDates.length - 1] : null
    const shipSrc = withShip.find((s) => s.estReady === estReady) ?? withShip[0]

    const dueDate = normDate(sl?.duedate)
    const workdaysLeft = cal.between(dueDate)
    const sampleBySheet = sheetSampleSo.has(so)
    const sampleByName = nameSaysSample(sl?.description) // D10/D11：含「打樣費」行
    const sample = {
      isSample: sampleBySheet || sampleByName,
      reason: sampleBySheet ? 'sheet_doc_type' as const : sampleByName ? 'line_name' as const : null,
    }

    // 交期旗標
    if (dueDate && dueDate < today) {
      pushFlag(flags, flag('overdue', `已逾期${workdaysLeft != null && workdaysLeft < 0 ? ` ${-workdaysLeft} 個工作天` : ''}（交期 ${mdOf(dueDate)}）`))
    } else if (workdaysLeft != null && workdaysLeft <= (sample.isSample ? URGENT_WORKDAYS_SAMPLE : URGENT_WORKDAYS)) {
      pushFlag(flags, flag('due_soon', `交期剩 ${workdaysLeft} 個工作天（${mdOf(dueDate)}）`))
    }
    // D9：打樣類交期往前 3 個台灣工作天內仍未寄出＝危險（紅），不只是一般的「交期將到」
    if (s0.block === '3' && sample.isSample && dueDate && dueDate >= today && workdaysLeft != null && workdaysLeft <= URGENT_WORKDAYS_SAMPLE) {
      pushFlag(flags, flag('sample_unshipped_danger', `打樣類交期剩 ${workdaysLeft} 個工作天仍未寄出（危險）`))
    }
    // D22：預排卡到期仍未入庫 → 橘燈；製令前站過了計畫完工日仍未完工也亮（前站已完工時 estReady 為 null）
    if ((s0.block === '1' || s0.block === '5a') && estReady && estReady <= today) {
      pushFlag(flags, flag('eta_passed', `預估 ${mdOf(estReady)} 可包，仍未到貨入庫`))
    } else if (s0.block === '4' && estReady && estReady < today) {
      pushFlag(flags, flag('eta_passed', `前站計畫 ${mdOf(estReady)} 完工，仍未完工`))
    }
    const exceeds = exceedsBySoLine.get(s0.soLineKey)
    if (exceeds) {
      pushFlag(flags, flag('po_exceeds_so', `同 SO 行已由其他採購單入庫足量，${exceeds.join('、')} 不另列（可能重複開單），請採購確認`))
    }
    const merged = mergedIntoMo.get(s0.soLineKey)
    if (merged && s0.block === '4') {
      pushFlag(flags, flag('merged_into_mo', `同一批貨另有常平採購 ${merged.join('、')}，包裝由本製令報工收掉，不另列採購卡`))
    }

    const cpNotes = [...new Set(list.map((s) => s.cpNote).filter((n): n is string => !!n))]
    const cpShipNote = cpNotes.length > 0 ? cpNotes.join('\n') : null
    // D28 只認「未包裝」；「回台包装」「台灣包裝」等寫法不改工時，只請主管確認
    if (s0.kind === 'changping' && cpShipNote && !CHANGPING_UNPACKED_RE.test(cpShipNote)) {
      const hint = cpShipNote.match(CHANGPING_PACK_HINT_RE)?.[0]
      if (hint) pushFlag(flags, flag('cp_note_pack_hint', `常平出貨備註寫「${hint}」，是否需廠內完整包裝請主管確認（目前以換箱工時計）`))
    }
    const packing = trimOrNull(sl?.packing)
    const packingClean = packing && packing !== '.' ? packing : null // 1,600 列佔位「.」

    const work = estimate({
      routeType: s0.kind === 'changping' ? '常平' : s0.kind === 'outsource' ? '委外' : '自製',
      itemCode: s0.itemCode ?? null,
      itemName: s0.itemName ?? '',
      packing: packingClean,
      qty: qtyCard,
      cpShipNote,
      saraJobNames: s0.pre ? s0.pre.packagingJobs.map((j) => j.jobName) : null,
    })
    if (work.minutes == null) pushFlag(flags, flag('hours_unknown', '工時未知（途程與品名都對不到包裝工序）'))

    if (!cal.covered(dueDate) || !cal.covered(estReady)) {
      pushFlag(flags, flag('calendar_fallback', '日期超出內建台灣行事曆，以週一～五估算'))
    }

    // 已入庫量：同一採購行在同卡只算一次（多個委外拆批採購行則相加）
    const rcvByLine = new Map<string, number>()
    for (const s of list) if (s.receivedQty != null && s.source) rcvByLine.set(`${s.source.docNo}|${s.source.lineNo}`, s.receivedQty)
    const receivedQty = rcvByLine.size > 0 ? [...rcvByLine.values()].reduce((a, b) => a + b, 0) : null

    let statusLabel = list.find((s) => s.statusLabel)?.statusLabel ?? STATUS_LABEL[s0.status]
    if (s0.status === 'in_transit' && s0.kind === 'outsource') statusLabel = '已出貨未到'
    if (s0.status === 'not_shipped_urgent' && dueDate && dueDate < today) statusLabel = '未寄出・已逾期'

    allCards.push({
      cardId: s0.soLineKey, // 拆卡時下面再補 #區塊
      soLineKey: s0.soLineKey,
      block: s0.block,
      status: s0.status,
      statusLabel,
      so,
      soLine: s0.lineNo,
      customer: sl?.partner_name ?? null,
      itemCode: s0.itemCode ?? null,
      itemName: s0.itemName ?? null,
      packing: packingClean,
      unit: sl?.unit_of_measure_oru ?? null,
      qtyTotal: num(sl?.order_qty_oru) || qtyCard,
      qtyCard,
      qtyReady,
      split: null,
      dueDate,
      workdaysLeft,
      estReadyDate: estReady,
      work,
      sourceKind: s0.kind,
      sources: mergeSources(list.flatMap((s) => [...(s.source ? [s.source] : []), ...(s.extraSources ?? [])])),
      ship: shipSrc?.ship ?? null,
      receivedQty,
      cpShipNote,
      orderRemark: trimOrNull(sl?.remark2),
      preStation: s0.pre,
      sample,
      flags,
      hasSketch: s0.lineNo ? sketchKeys.has(s0.soLineKey) : false,
    })
  }

  // ── D43 範圍：與塔台未結案批相連的卡（任一來源的塔台批仍在 sara_lot_progress，或 SO 行＝某未結案批的 (doc_nbr, lot_nbr)）
  //    ∪ D44 30 天內已發單、未上塔台的 SO 行；其餘不列入。放在拆卡標示之前，拆 i/n 才不會把被排除的卡算進去 ──
  const inTower = (c: PackagingCard) =>
    c.sources.some((s) => !!s.saraMo && openLotMos.has(normMo(s.saraMo))) || openLotLines.has(c.soLineKey)
  /** 同 SO 行只要有一張卡連到塔台未結案批，這一行就算「已上塔台」（不符合 D44 的「比對不到任何塔台批」） */
  const towerLines = new Set(allCards.filter(inTower).map((c) => c.soLineKey))
  /** 卡片自己的塔台批（sources[].saraMo）上過塔台、只是已結案 → 這一行也算上過塔台，照 D43 排除、不標 not_on_sara */
  const saraCardLines = new Set(allCards
    .filter((c) => c.sources.some((s) => !!s.saraMo && moOnSara(normMo(s.saraMo), saraIdx)))
    .map((c) => c.soLineKey))
  const cards: PackagingCard[] = []
  for (const c of allCards) {
    if (c.block === 'ns' || inTower(c)) { cards.push(c); continue }
    if (nsLines.has(c.soLineKey) && !towerLines.has(c.soLineKey) && !saraCardLines.has(c.soLineKey)) {
      pushFlag(c.flags, flag('not_on_sara', '已發單、塔台尚未建立'))
      cards.push(c)
      bump('ns_flagged_card')
      continue
    }
    excluded.saraClosedOrAbsent++
  }
  const joinNo = (no: string | null, sub: string | null) => {
    const n = normMo(no)
    return n ? (sub ? `${n}-${sub}` : n) : null
  }
  const staleRows: StaleUnsyncedRow[] = staleCands
    .filter((x) => !towerLines.has(x.k) && !saraCardLines.has(x.k))
    .map((x) => ({
      so: x.so,
      soLine: x.line,
      sheetDate: x.row.sheet_date,
      docType: x.row.doc_type,
      factory: x.row.factory,
      moNumber: normMo(x.row.mo_number) || null,
      poNumber: joinNo(x.row.po_number, x.row.po_sub_no),
      prNumber: joinNo(x.row.pr_number, x.row.pr_sub_no),
      itemName: x.itemName ? x.itemName.slice(0, 40) : null,
    }))
    .sort((a, b) => b.sheetDate.localeCompare(a.sheetDate) || a.so.localeCompare(b.so) || num(a.soLine) - num(b.soLine))

  // ── 拆卡標示（D7：同 SO 行落在不同區塊）──
  const bySoLine = new Map<string, PackagingCard[]>()
  for (const c of cards) {
    let arr = bySoLine.get(c.soLineKey)
    if (!arr) { arr = []; bySoLine.set(c.soLineKey, arr) }
    arr.push(c)
  }
  const orderIdx = (b: PoolBlockId) => POOL_BLOCK_ORDER.indexOf(b)
  for (const list of bySoLine.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => orderIdx(a.block) - orderIdx(b.block) || a.sourceKind.localeCompare(b.sourceKind))
    const seen = new Set<string>()
    list.forEach((c, i) => {
      c.split = { index: i + 1, total: list.length }
      let id = `${c.soLineKey}#${c.block}`
      if (seen.has(id)) id = `${id}-${c.preStation?.moNbr ?? c.sourceKind}`
      for (let n = 2; seen.has(id); n++) id = `${c.soLineKey}#${c.block}-${n}` // 同製令多批等極端情況，仍保證唯一
      seen.add(id)
      c.cardId = id
    })
  }

  // ── 區塊排序與合計（逾期 → 打樣類 → 剩餘工作天 → 預估可包日 → SO 號）──
  const cmpNullLast = (a: number | string | null, b: number | string | null) => {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    return a < b ? -1 : a > b ? 1 : 0
  }
  const isOverdue = (c: PackagingCard) => !!c.dueDate && c.dueDate < today
  const blocks: PoolBlock[] = POOL_BLOCK_ORDER.map((id) => {
    const list = cards.filter((c) => c.block === id).sort((a, b) =>
      Number(isOverdue(b)) - Number(isOverdue(a))
      || Number(b.sample.isSample) - Number(a.sample.isSample)
      || cmpNullLast(a.workdaysLeft, b.workdaysLeft)
      || cmpNullLast(a.estReadyDate, b.estReadyDate)
      || a.so.localeCompare(b.so)
      || num(a.soLine) - num(b.soLine))
    const meta = POOL_BLOCK_META[id]
    return {
      id,
      title: meta.title,
      hint: meta.hint,
      cards: list,
      cardCount: list.length,
      totalMinutes: Math.round(list.reduce((a, c) => a + (c.work.minutes ?? 0), 0) * 10) / 10,
      unknownMinutesCards: list.filter((c) => c.work.minutes == null).length,
      overdueCount: list.filter(isOverdue).length,
      sampleCount: list.filter((c) => c.sample.isSample).length,
    }
  })

  stats.cards = cards.length
  stats.cardsBeforeScope = allCards.length
  stats.slices = keptSlices.length
  return {
    blocks,
    excluded,
    calendarFallback: cal.fallback,
    staleUnsynced: { windowDays: NOT_ON_SARA_WINDOW_DAYS, count: staleRows.length, rows: staleRows, nonScheduleDocLines },
    stats,
  }
}

/** 同一採購行在同一卡只列一次（數量相加） */
function mergeSources(list: SourceDoc[]): SourceDoc[] {
  const out = new Map<string, SourceDoc>()
  for (const s of list) {
    const k = `${s.docType}|${s.docNo}|${s.lineNo ?? ''}`
    const prev = out.get(k)
    if (prev) prev.qty += s.qty
    else out.set(k, { ...s })
  }
  return [...out.values()]
}
