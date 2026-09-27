// 包裝專區 P0（唯讀待排池）共用型別 —— 資料層（lib/packaging/*、/api/packaging/*）與畫面共用。
// 規格與判定邏輯見 docs/design/2026-09-27-packaging-schedule.md。
// 注意：本檔是跨區可見的形狀，絕不可加入廠商代碼/名稱、付款欄位、changping_ship_marks 原始欄位。

/** 待排池區塊（順序＝畫面順序） */
export type PoolBlockId = '1' | '1b' | '2' | '3' | '4' | '4x' | '5a' | '5b' | '5c' | 'ns' | 'mn'

export const POOL_BLOCK_META: Record<PoolBlockId, { title: string; group: 'changping' | 'inhouse' | 'outsource' | 'shared'; hint: string }> = {
  '1':  { title: '常平 — 已寄出運送中', group: 'changping', hint: '已亮出貨燈、未到台、未入庫；顯示預估可包日' },
  '1b': { title: '品檢中（已到台待入庫）', group: 'shared', hint: '塔台轉運站已完工、ARGO 未入庫（常平＋委外）' },
  '2':  { title: '常平 — 已入庫可包', group: 'changping', hint: '入庫＝品檢完成，可開始包' },
  '3':  { title: '常平 — 未寄出且交期緊張', group: 'changping', hint: '交期 5 個工作天內（打樣類 3 天），不預排、僅提醒' },
  '4':  { title: '製令 — 前站已開工／已完工', group: 'inhouse', hint: '可包量＝前站已完成量' },
  '4x': { title: '需確認 — 只有包裝站、沒有前站', group: 'inhouse', hint: '可能是塔台工序設定錯誤，請確認' },
  '5a': { title: '委外 — 已出貨未到', group: 'outsource', hint: '採購已點出貨、未入庫' },
  '5b': { title: '委外 — 已入庫可包', group: 'outsource', hint: '一律列出，預設計入包裝工時' },
  '5c': { title: '委外 — 出貨待確認', group: 'outsource', hint: '採購交期前 2 個工作天仍未點出貨' },
  // D44：出單表 30 天內已發單、比對不到任何塔台批、又沒有採購／製令來源的 SO 行（例：壓克力集單）
  'ns': { title: '已發單・未上塔台', group: 'shared', hint: '出單表 30 天內已發單、塔台尚未建立，請確認是否已轉塔台' },
  // D66：主管在工作台「＋加入訂單」手動加入的 SO 品項行（只出現在工作台待排池，P0 唯讀待排池頁不列）
  'mn': { title: '手動加入', group: 'shared', hint: '主管手動加入的品項（不在自動判定的待排池內），可正常排程' },
}

export const POOL_BLOCK_ORDER = ['3', 'ns', '1', '1b', '2', '4', '4x', '5c', '5a', '5b'] as const satisfies readonly PoolBlockId[]
/**
 * 只出現在 P1 工作台待排池、不由 classifyPool 產生的區塊（D66 手動加入 'mn'）。
 * 刻意不放進 POOL_BLOCK_ORDER：P0 唯讀待排池頁（app/packaging/pool，本輪不改）以 ORDER 畫摘要晶片與空區塊殼，
 * 放進去會在 P0 頁多出一個永遠是 0 的「手動加入」晶片。工作台的區塊順序由 lib/packaging/manualPool.ts 決定（'mn' 在最前）。
 */
export const BOARD_ONLY_BLOCKS = ['mn'] as const satisfies readonly PoolBlockId[]
/** 編譯期防呆：新增 PoolBlockId 卻沒放進 POOL_BLOCK_ORDER（或 BOARD_ONLY_BLOCKS）時，這裡會編譯失敗（blocks 由 ORDER 產生，漏放的區塊整塊卡片會悄悄消失） */
const UNORDERED_BLOCKS: Record<Exclude<PoolBlockId, (typeof POOL_BLOCK_ORDER)[number] | (typeof BOARD_ONLY_BLOCKS)[number]>, never> = {}
void UNORDERED_BLOCKS

export type SourceKind = 'changping' | 'outsource' | 'inhouse'

/** 卡片來源單據（一張卡可有多個，例：委外拆批的多個採購行） */
export interface SourceDoc {
  kind: SourceKind
  /** 單型標籤：POC / PO（常平手動或委外採購）/ MPO / MOT / MOS */
  docType: 'POC' | 'PO' | 'MPO' | 'MOT' | 'MOS'
  docNo: string
  /** 採購行號；製令為 null */
  lineNo: string | null
  /** 塔台 mo_nbr（POC…-n / MPO…-n / MOT…）；對不到為 null */
  saraMo: string | null
  /** 本來源貢獻到這張卡的數量 */
  qty: number
}

export type CardStatus =
  | 'in_transit'              // 1 / 5a
  | 'qc_pending'              // 1b
  | 'ready'                   // 2 / 5b
  | 'not_shipped_urgent'      // 3
  | 'pre_station_running'     // 4
  | 'pre_station_paused'      // 4
  | 'pre_station_finished'    // 4
  | 'no_pre_station'          // 4x
  | 'ship_unconfirmed'        // 5c
  | 'not_on_sara'             // ns（D44：已發單、塔台尚未建立）

export type DangerFlagCode =
  | 'overdue' | 'due_soon' | 'eta_passed'
  | 'ship_mark_ambiguous' | 'maybe_unshipped_urgent' | 'ship_date_unparsed' | 'transit_unknown'
  | 'partial_received'
  | 'so_line_ambiguous' | 'so_line_unresolved' | 'so_line_mismatch'
  | 'qc_report_mismatch' | 'tower_lot_closed'
  | 'partial_arrived' | 'sample_unshipped_danger' | 'cp_note_pack_hint'
  | 'parallel_pre_station' | 'routing_suspect'
  | 'hours_unknown' | 'calendar_fallback'
  | 'po_exceeds_so' | 'merged_into_mo' | 'ship_confirm_early'
  | 'not_on_sara'
  /** D73：這個 SO 品項行在 ARGO 已部分銷貨（出貨）；卡片數量已扣成「未出貨量」 */
  | 'partial_sold'

export interface DangerFlag {
  code: DangerFlagCode
  /** 繁中說明（直接顯示） */
  label: string
  /** 'danger' 紅、'warn' 橘、'info' 灰 */
  level: 'danger' | 'warn' | 'info'
}

export type AddonKey = 'sticker' | 'label' | 'laser_label' | 'paper_card' | 'blind_mix'

export interface WorkEstimate {
  /** 估計工時（分鐘，1 人）；null＝工時未知 */
  minutes: number | null
  /** 每件分鐘（含附加）；null＝未知 */
  perUnit: number | null
  /** 計算用數量 */
  qtyBasis: number
  source: 'changping_rebox' | 'changping_unpacked' | 'route' | 'sara_job' | 'category_keyword' | 'unknown'
  /** 一行來源說明，例「常平換箱 0.2 分/件」「途程：常規包裝/鑰匙圈 0.4 + 紙卡 0.2」 */
  explain: string
  /** 基本工序（op_name 與每件分鐘） */
  baseOps: { opName: string; perUnit: number }[]
  addons: { key: AddonKey; label: string; perUnit: number }[]
  /** 包裝方式中偵測到、但沒有定義附加工時的元素（牛皮盒、鋁箔袋…） */
  gaps: string[]
  /** 是否套用「每卡最少 10 分鐘」 */
  minApplied: boolean
}

/** 製令前站資訊（區塊 4 / 4x） */
export interface PreStationInfo {
  moNbr: string
  lotNbr: string | null
  /** 前站工作站名稱；4x 為 null */
  station: string | null
  jobName: string | null
  status: 'finished' | 'running' | 'pause' | 'pending' | null
  /** 已報 X */
  reportedQty: number | null
  /** 應做 Y */
  requiredQty: number | null
  parallel: boolean
  /** 包裝站（非 QC）工序現況 */
  packagingJobs: { jobName: string; status: 'finished' | 'running' | 'pause' | 'pending'; reportedQty: number | null }[]
  /** 同 SO 行的其他製令號（erp_mo_lines，僅顯示） */
  otherMos: string[]
}

export interface ShipInfo {
  /** 寄出／出貨日（台北 YYYY-MM-DD） */
  shippedAt: string | null
  method: '順豐' | '空運' | '海特快' | '一般海運' | null
  transitWorkdays: number | null
}

export interface PackagingCard {
  /** `${so}-${line}`；同一 SO 行拆成多卡時加 `#${block}` */
  cardId: string
  /** `${so}-${line}`（D6 卡片單位；拆卡共用） */
  soLineKey: string
  block: PoolBlockId
  status: CardStatus
  statusLabel: string
  so: string
  soLine: string | null
  customer: string | null
  itemCode: string | null
  itemName: string | null
  packing: string | null
  unit: string | null
  /** SO 行總量（order_qty_oru） */
  qtyTotal: number
  /** 本卡數量（可包量或預計量） */
  qtyCard: number
  /** 可包量：已入庫/前站已完成的部分；運送中/未寄出為 0 */
  qtyReady: number
  split: { index: number; total: number } | null
  /** ERP 品項行交期 YYYY-MM-DD */
  dueDate: string | null
  /** 剩餘台灣工作天（負＝已逾期幾個工作天） */
  workdaysLeft: number | null
  /** 預估可包日（區塊 1 / 1b / 5a / 4 前站進行中）；未知 null */
  estReadyDate: string | null
  work: WorkEstimate
  sourceKind: SourceKind
  sources: SourceDoc[]
  ship: ShipInfo | null
  /** 已入庫量（採購來源才有） */
  receivedQty: number | null
  /** 常平出貨備註：只取 po_line_tracking.note 的【常平出貨】行（去前綴） */
  cpShipNote: string | null
  /** 訂單備註（erp_so_lines.remark2） */
  orderRemark: string | null
  preStation: PreStationInfo | null
  sample: { isSample: boolean; reason: 'sheet_doc_type' | 'line_name' | null }
  flags: DangerFlag[]
  /** 出單表是否有這一行的示意圖（詳情彈窗再呼叫 sketches API 取網址） */
  hasSketch: boolean
}

export interface PoolBlock {
  id: PoolBlockId
  title: string
  hint: string
  cards: PackagingCard[]
  cardCount: number
  /** 已知工時合計（分鐘） */
  totalMinutes: number
  /** 工時未知的卡數 */
  unknownMinutesCards: number
  overdueCount: number
  sampleCount: number
}

export interface PoolFreshness {
  /** 各來源最後同步時間（ISO）；取不到為 null */
  erpSo: string | null
  erpPo: string | null
  saraSchedule: string | null
  saraRecords: string | null
  /** 常平黃底同步（po_line_tracking updated_by='常平出貨同步' 的最新 updated_at） */
  changping: string | null
  orderSheet: string | null
  /**
   * D73：ARGO 銷貨鏡像（erp_so_sales）最後一次「成功」同步的時間（erp_so_sales_sync.last_ok_at）。
   * null＝銷貨同步尚未啟用（新表未建）或還沒成功跑過——這時待排池不排除已銷貨品項（notes 另有說明）。
   */
  soSales: string | null
}

/** 未進池的計數（畫面頁尾顯示） */
export interface PoolExcluded {
  /** D12 非實體行（費用行） */
  nonPhysical: number
  /** SO/RO 已在 ARGO 結案 */
  closedSo: number
  /** P0 暫用完成規則：塔台包裝工序已報完工 */
  packagedDone: number
  /** 未達進池條件（常平未寄不緊張、委外未到交期、製令前站未開工…） */
  notInPool: number
  /** 原物料／耗材採購行（品號 M*／W*、SO 上沒有此品項）：自製投入料，由製令卡包裝，不另出卡 */
  materialPurchase: number
  /** 同 SO 行已由其他採購單入庫足量，本採購行未到量不出卡（可能重複開單） */
  poExceedsSo: number
  /**
   * D43 範圍規則：卡片對不到塔台目前未結案的批（塔台已結案，或根本不在塔台），
   * 也不是出單表 30 天內已發單、尚未上塔台的 SO 行（D44）→ 不列入。以「卡」計（範圍判定在出卡之後）。
   */
  saraClosedOrAbsent: number
  /**
   * D73：ARGO 已全數銷貨（出貨）的 SO 品項行（以 SO 品項行計）：銷貨量依項次順序分配到同品號各行後，
   * 未出貨量 ≤ 0 → 該行不出卡。銷貨同步尚未啟用時為 0。
   */
  soldOut: number
}

/** D44：出單日超過 30 天、ERP SO 行仍未結案、卻比對不到任何塔台批的一列（異常清單，給生管／Snow 追查） */
export interface StaleUnsyncedRow {
  so: string
  soLine: string
  /** 出單表日期（同一 SO 行出現在多張出單表時取最新一張） */
  sheetDate: string
  /** 出單表「單據種類」 */
  docType: string | null
  /** 出單表廠別 T／C／O */
  factory: string | null
  moNumber: string | null
  /** 採購單號-行 */
  poNumber: string | null
  /** 請購單號-行（委外 MPO） */
  prNumber: string | null
  /** 品名前 40 字（ERP 品項行優先，退用出單表） */
  itemName: string | null
}

export interface StaleUnsynced {
  /** 超過幾個日曆天算「過久」（＝待排池 ns 區塊的時間窗） */
  windowDays: number
  count: number
  /** 依出單日由新到舊 */
  rows: StaleUnsyncedRow[]
  /**
   * D46 另計的排除數：ERP 仍未結案、只出現在出單表「素材單/包裝單」的 SO 行（本來就不上塔台，不列入待排池、也不算未上塔台）。
   * 放在這裡而不放 PoolExcluded：/packaging/pool 頁尾以 Record<keyof PoolExcluded> 逐項顯示，加欄位要同時改畫面。
   */
  nonScheduleDocLines: number
}

export type PoolResponse =
  | {
      success: true
      generatedAt: string
      /** 台北今天 YYYY-MM-DD */
      today: string
      blocks: PoolBlock[]
      freshness: PoolFreshness
      excluded: PoolExcluded
      calendar: { source: 'static' | 'fallback'; coveredYears: number[] }
      /** 頁尾註腳（P0 暫用規則與已知限制） */
      notes: string[]
      /** 是否來自伺服器快取 */
      cached: boolean
      /** D44：發單超過 30 天仍未上塔台（不列入待排池，另列清單） */
      staleUnsynced: StaleUnsynced
    }
  | { success: false; error: string }

export interface SketchImage {
  /** 可直接顯示的網址（由 API 決定；P0 為 public URL，之後改短期簽名網址） */
  url: string
  kind: 'image' | 'pdf'
  fileName: string
  /** 簽名網址到期時間（ISO）；public 為 null */
  expiresAt: string | null
  /** 來自哪一天的出單表 */
  sheetDate: string
}

export interface SketchLine {
  lineNo: string | null
  itemCode: string | null
  itemName: string | null
  images: SketchImage[]
}

export type SketchResponse =
  | { success: true; so: string; lines: SketchLine[] }
  | { success: false; error: string }
