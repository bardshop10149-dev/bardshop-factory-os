// 包裝專區 P1（拖曳排程工作台）共用型別契約 —— 資料層（lib/packaging/*、/api/packaging/*）與畫面共用。
// 規格：docs/design/2026-09-27-packaging-schedule-p1.md（本檔各段落對應該文件章節）。
//       分線輪（D66～D72）：docs/design/2026-09-27-packaging-lines.md（本檔標「分線」的段落）。
// 資料表：sql/20260927_packaging_schedule.sql（套用前 packaging_* 表不存在）；
//         分線輪新表／新欄位：sql/20260927b_packaging_p1_extend.sql（套用前不存在）。
//
// 分線輪相容策略：既有型別新增的欄位一律「選填」（?:），讓現有程式在實作輪完成前仍能編譯；
// 實作輪（資料層）完成後，伺服器回應一律帶齊這些欄位，前端可視為必有（規格 lines.md §九）。
//
// 慣例：
// - 日期一律 'YYYY-MM-DD'（台北日曆日，型別別名 YMD）；時間戳一律 ISO 字串（UTC）。
// - DB 列（snake_case，*Row）只在伺服器端出現；API 與畫面一律用 camelCase 型別。
// - 本檔只放型別與常數，不放邏輯；純函式放在 lib/packaging/schedule*.ts（規格 §三）。
// - 用相對路徑 import，讓 node --experimental-strip-types 跑單元測試時不必解析 '@/'。
// - 注意：本檔是跨區可見的形狀，絕不可加入廠商代碼／名稱、付款欄位、changping_ship_marks 原始欄位（同 types.ts）。

import type {
  PackagingCard,
  PoolBlock,
  PoolBlockId,
  PoolExcluded,
  PoolFreshness,
} from './types'

/** 台北日曆日 'YYYY-MM-DD' */
export type YMD = string

// ─────────────────────────────────────────────────────────────────────
// 常數（規格 §三）
// ─────────────────────────────────────────────────────────────────────

/** D51：工作台預設顯示今天起幾個台灣工作日（週末加班日另外插入，不佔名額） */
export const BOARD_DEFAULT_WORKDAYS = 10
/** GET /api/packaging/board 的 days 參數上限（往右捲動載入更多時用） */
export const BOARD_MAX_WORKDAYS = 30
/** D52：所有人每 60 秒刷新一次 */
export const BOARD_POLL_MS = 60_000
/** D53：編輯鎖 5 分鐘無動作自動釋放 */
export const LOCK_IDLE_MS = 5 * 60_000
/** 編輯者頁面送心跳的間隔 */
export const LOCK_HEARTBEAT_MS = 30_000
/** D33：Undo 保留當次最近 50 步 */
export const UNDO_LIMIT = 50
/** D33：版本快照保留 90 天 */
export const VERSION_RETENTION_DAYS = 90
/** 每張（子）卡最少 10 分鐘（沿用 P0 calcEst = max(10, std × qty)） */
export const MIN_CARD_MINUTES = 10
/** 單次 POST /api/packaging/placements 最多幾個操作 */
export const MAX_OPS_PER_REQUEST = 50
/** D48：平日 19:00 之後算加班（顯示用；產能表由主管直接填「至 19:00 的正常工時」） */
export const REGULAR_END_HOUR = 19

// ── 分線輪常數（lines.md §三、§五）──

/** D70：時間軸模型＝一天 00:00～24:00；正常段 10:00～19:00、加班段 19:00～24:00 */
export const WORK_START_HOUR = 10
/** D70：加班段終點（排滿該線加班上限＝24:00） */
export const OVERTIME_END_HOUR = 24
/** D70：日檢視預設只顯示 10:00～24:00（顯示區間可調，換算邏輯不變） */
export const RULER_DISPLAY_START_HOUR = 10
export const RULER_DISPLAY_END_HOUR = 24
/** D69：拉卡片下緣改工時時的吸附間隔（分鐘） */
export const MINUTES_SNAP = 5
/** D69：主管覆寫工時的範圍（分鐘；一位小數） */
export const MINUTES_OVERRIDE_MIN = 1
export const MINUTES_OVERRIDE_MAX = 6000
/** D69：工時修改原因、D66 手動加入原因的字數上限 */
export const ADJUST_REASON_MAX = 200
/** D71：預設線別（migration 種子；id 1／2／3） */
export const DEFAULT_LINE_CODES = ['A', 'B', 'C'] as const
/** D71：線別總數（含停用）與同時啟用的上限（畫面寬度與防灌表） */
export const MAX_LINES = 12
export const MAX_ACTIVE_LINES = 6
/** 線名長度上限（同 migration check） */
export const LINE_NAME_MAX = 20
/**
 * D66「手動加入」區塊的 PoolBlockId 值（types.ts 的 PoolBlockId／POOL_BLOCK_META、poolStyles.ts 的 BLOCK_TONE 已含 'mn'）。
 * 'mn' 刻意不在 POOL_BLOCK_ORDER（P0 唯讀待排池頁不列，見 types.ts BOARD_ONLY_BLOCKS）；工作台待排池把它放最前面。
 */
export const MANUAL_BLOCK_ID = 'mn' as const satisfies PoolBlockId
/** D66：一次手動加入最多幾行 */
export const MAX_MANUAL_ITEMS_PER_REQUEST = 50
/** D66：同時有效（未移出）的手動加入行數上限（防灌表） */
export const MAX_ACTIVE_MANUAL = 300
/** D68：日檢視時間尺每小時的像素（10:00～24:00 共 14 小時 ≈ 1008px，欄內縱向捲動） */
export const DAY_RULER_PX_PER_HOUR = 72
/** D68：時間尺上卡片的最小高度（px）；工時太短或未知時用它，後面的卡順延往下疊 */
export const LANE_CARD_MIN_PX = 28
/** D68：卡片高度低於此值（px）改精簡顯示（只剩單號＋品名） */
export const LANE_CARD_COMPACT_PX = 56
/** D69：卡片詳情「修改歷程」一次最多取幾筆 */
export const ADJUSTMENTS_LIST_LIMIT = 100

// ── D73／D74（sql/20260928_packaging_sales_and_order.sql）──

/**
 * D74 線內順序 sort_index 的範圍：numeric(12,4) → 整數部分最多 8 位、小數最多 4 位。
 * 新排入的卡＝「2026-01-01 起的分鐘數」（2026-09 約 39 萬），上限約可用到 2216 年。
 */
export const SORT_INDEX_ABS_MAX = 99_999_999
export const SORT_INDEX_DECIMALS = 4
/** D73 銷貨增量同步預設看近幾天（依 ARGO IO_DATE）；API 參數 days 可調 1～31 */
export const SALES_SYNC_DEFAULT_DAYS = 3
export const SALES_SYNC_MAX_DAYS = 31

/**
 * D22：可以拖進日期欄（排定／預排）的待排池區塊。
 * - '3'（常平未寄出且交期緊張）：D22 明文「不預排、僅提醒」。
 * - '5c'（委外出貨待確認）：廠商是否已出貨不明，比照 3 不可排（規格 §2.3，待 Snow 確認）。
 * - 'ns'（已發單・未上塔台）：D44「可正常排程」，但可包日未知 → 一律虛線 pre_unknown。
 * - 'mn'（D66 手動加入）：可正常排程、一律視為可包（實線）。放最後：blockRank 只影響同一行多片段的分配順序，
 *   而手動卡只在該行不在正常區塊時才出現（lines.md §六.6），所以同一行不會同時有 'mn' 與其他片段。
 */
export const PLACEABLE_BLOCKS = ['2', '5b', '4', '4x', '1b', '1', '5a', 'ns', 'mn'] as const satisfies readonly PoolBlockId[]
export type PlaceableBlockId = (typeof PLACEABLE_BLOCKS)[number]

// ─────────────────────────────────────────────────────────────────────
// 資料表列（伺服器端；對應 sql/20260927_packaging_schedule.sql）
// ─────────────────────────────────────────────────────────────────────

/** packaging_placements：一列＝一張排定（子）卡 */
export interface PlacementRow {
  /** uuid；由前端 crypto.randomUUID() 產生（Undo/Redo 需要以原 id 重建） */
  id: string
  /** `${so}-${line}`（＝PackagingCard.soLineKey，D6 卡片單位） */
  so_line_key: string
  /** 本子卡數量（> 0） */
  qty: number
  /** 排定日；null＝待排區（D21 主管刻意擱置） */
  plan_date: YMD | null
  /** 第一次從待排池排上日期時的日期；之後移動不變（D50 延誤與 P2 學習用） */
  original_date: YMD | null
  /** manual＝主管手動（含主管挪過 AI 排的卡）；ai＝P2 AI 排入且未被手動挪過（D50） */
  source: PlacementSource
  /** 從哪張待排池卡拖出來的（PackagingCard.cardId，僅供顯示；卡片身分以 so_line_key 為準） */
  origin_card_id: string | null
  /** D24 手動完成勾選 */
  completed_at: string | null
  completed_by: string | null
  completed_by_name: string | null
  /** 勾完成當下該 SO 行的可排供給量（規格 §3.4 未反映完成量的基準） */
  completed_pool_qty: number | null
  /** 樂觀檢查用；每次更新 +1 */
  version: number
  created_by: string
  created_by_name: string | null
  created_at: string
  updated_by: string
  updated_by_name: string | null
  updated_at: string
  /**
   * 分線（D72）：所屬產線 packaging_lines.id。plan_date 非 null 時必填（DB check）；待排區由 API 寫 null。
   * DB 預設 1（A 線）：讓尚未更新的舊程式（穩定站）插入時仍符合約束（lines.md §一.4）。
   */
  line_id?: number | null
  /** D69：主管覆寫的工時（分鐘，以本列 qty 為準）；null＝用標準估計 */
  est_minutes_override?: number | null
  minutes_override_by?: string | null
  minutes_override_by_name?: string | null
  minutes_override_at?: string | null
  /**
   * D74：同一天同一條線內的上下順序（小的在上；null＝排在該線最上面、依固定排序）。
   * 只影響顯示順序，不影響數量守恆。sql/20260928 套用前這欄不存在（讀不到＝null、寫入時自動略過）。
   */
  sort_index?: number | null
}

export type PlacementSource = 'manual' | 'ai'

// ── 分線輪新表（sql/20260927b_packaging_p1_extend.sql）──

/** packaging_lines：一列＝一條產線（D67／D71；種子 A/B/C＝id 1/2/3） */
export interface PackagingLineRow {
  id: number
  /** 'A'、'B'、'C'、'D'…：唯一、建立後不可改（畫面顯示與匯出用） */
  code: string
  /** 顯示名稱（可改名），例「A 線」「臨時線」 */
  name: string
  sort_order: number
  /** 停用後不出現在工作台與產能表、不計入總時數（歷史資料保留） */
  active: boolean
  created_by: string
  created_by_name: string | null
  created_at: string
  updated_by: string
  updated_by_name: string | null
  updated_at: string
}

/** packaging_line_capacity：一天 × 一條線的產能（D67／D71；PK(date, line_id)；週末只能填加班） */
export interface LineCapacityRow {
  date: YMD
  line_id: number
  /** 正常總時數（小時，10:00～19:00）；週末恆為 0 */
  regular_hours: number
  /** 加班總時數上限（小時，19:00～24:00；週末＝整天） */
  overtime_hours_max: number
  note: string | null
  updated_by: string
  updated_by_name: string | null
  updated_at: string
}

/** packaging_time_adjustments：D69 每次主管改工時記一列（AI 校正工時的學習素材；只增不改） */
export interface TimeAdjustmentRow {
  id: number
  created_at: string
  /** 被改的擺放（不設 FK：擺放之後可能被合併／刪除，學習紀錄要留著） */
  placement_id: string
  so_line_key: string
  item_code: string | null
  item_name: string | null
  /** 修改當下的有效數量 */
  qty: number
  packing: string | null
  /** 途程類型（自製／常平／委外） */
  route_type: string | null
  /** WorkEstimate.source（route、changping_rebox…） */
  work_source: string | null
  /** WorkEstimate.explain（一行來源說明） */
  work_explain: string | null
  /** 標準估計每件分鐘 */
  per_unit_std: number | null
  /** 標準估計工時（分鐘，依 qty）；工時未知 null */
  std_minutes: number | null
  /** 修改前的有效工時（覆寫值或標準值） */
  before_minutes: number | null
  /** 修改後的有效工時；清除覆寫時＝std_minutes */
  after_minutes: number | null
  /** 修改後換算每件分鐘＝after_minutes ÷ qty */
  per_unit_after: number | null
  /** 本次是否為「清除覆寫、回到標準值」 */
  cleared: boolean
  reason: string | null
  via: MinutesEditVia
  plan_date: YMD | null
  line_id: number | null
  actor_email: string
  actor_name: string | null
}

/** packaging_manual_inclusions：D66 手動加入待排池的一個 SO 品項行（移出＝軟刪除） */
export interface ManualInclusionRow {
  id: number
  so_line_key: string
  so: string
  line_no: string
  /** 加入數量（預設 ERP 訂單量，可改） */
  qty: number
  /** 工時途程類型（估工時用；查詢時依原因推測，主管可改） */
  route_type: ManualRouteType
  reason: string | null
  added_by: string
  added_by_name: string | null
  added_at: string
  removed_at: string | null
  removed_by: string | null
  removed_by_name: string | null
  removed_reason: string | null
  /** 改數量（PATCH）或移出時更新 */
  updated_by: string | null
  updated_by_name: string | null
  updated_at: string
}

/** packaging_daily_capacity：一天一列（D49；D63 週日比照週六；D65 改填總時數） */
export interface DailyCapacityRow {
  date: YMD
  /** D65 起畫面不再填／顯示人數（組長直接填總時數），欄位保留、新寫入一律 null */
  headcount: number | null
  /** 正常總時數（小時，至 19:00，組長直接填當天總時數）；週末恆為 0 */
  regular_hours: number
  /** 加班總時數上限（小時；平日 19:00 後、週六／週日） */
  overtime_hours_max: number
  /** 欄名沿用舊稱，語意＝「週末開加班」（D63）：只有週六／週日能為 true，開了該日才出現在工作台 */
  is_saturday_open: boolean
  note: string | null
  updated_by: string
  updated_by_name: string | null
  updated_at: string
}

/** packaging_edit_lock：單列（id = 1），D53 */
export interface EditLockRow {
  id: 1
  holder_email: string | null
  holder_name: string | null
  /** 每次 acquire／takeover 換新；所有寫入以它做 compare-and-set */
  token: string | null
  acquired_at: string | null
  heartbeat_at: string | null
  /** 最後一次「有動作」的時間（寫入或使用者有操作的心跳）；逾 LOCK_IDLE_MS 視為已釋放 */
  last_action_at: string | null
  prev_holder_email: string | null
  prev_holder_name: string | null
  taken_over_at: string | null
  updated_at: string
}

/** packaging_schedule_versions（D33 快照） */
export interface ScheduleVersionRow {
  id: number
  label: string
  source: VersionSource
  snapshot: ScheduleSnapshot
  placement_count: number
  created_by: string
  created_by_name: string | null
  created_at: string
}

// ─────────────────────────────────────────────────────────────────────
// 擺放（API／畫面用）
// ─────────────────────────────────────────────────────────────────────

export interface PlacementCompletion {
  at: string
  by: string
  byName: string | null
  /** 勾完成當下的可排供給量（§3.4） */
  poolQtyAt: number | null
}

/** PlacementRow 的 camelCase 版（API 回傳） */
export interface Placement {
  id: string
  soLineKey: string
  qty: number
  planDate: YMD | null
  originalDate: YMD | null
  source: PlacementSource
  originCardId: string | null
  completed: PlacementCompletion | null
  version: number
  createdAt: string
  createdBy: string
  createdByName: string | null
  updatedAt: string
  updatedBy: string
  updatedByName: string | null
  /** 分線（D72）：plan_date 非 null 時必有；待排區為 null。實作輪後伺服器一律帶齊 */
  lineId?: number | null
  /** D69：主管覆寫的工時（以本列 qty 為準）；null／省略＝用標準估計 */
  minutesOverride?: MinutesOverride | null
  /** D74：線內順序（規則見 lib/packaging/laneOrder.ts）；待排區一律 null */
  sortIndex?: number | null
}

/** D69 覆寫工時（分鐘）與誰何時改的 */
export interface MinutesOverride {
  minutes: number
  by: string
  byName: string | null
  at: string
}

/** D69 改工時的方式：drag＝日檢視拉卡片下緣；dialog＝卡片詳情輸入；undo＝Undo／Redo 產生的反向操作 */
export type MinutesEditVia = 'drag' | 'dialog' | 'undo'

/** D66 手動加入的工時途程類型（同 stdTime.ts StdRouteType；估工時用） */
export type ManualRouteType = '自製' | '常平' | '委外'

/** D66：卡片上「手動・誰・何時」要顯示的資訊（待排池卡 PoolCardMeta.manual、排定卡 BoardCard.manual） */
export interface ManualInclusionMeta {
  inclusionId: number
  qty: number
  routeType: ManualRouteType
  reason: string | null
  addedBy: string
  addedByName: string | null
  addedAt: string
}

/** ManualInclusionRow 的 camelCase 版（API 回傳） */
export interface ManualInclusion extends ManualInclusionMeta {
  soLineKey: string
  so: string
  lineNo: string
  removedAt: string | null
  removedByName: string | null
  removedReason: string | null
  updatedAt: string
}

/** 快照裡的一列（只存「計畫」，不存完成紀錄與稽核欄位） */
export interface PlacementSnapshotRow {
  id: string
  soLineKey: string
  qty: number
  planDate: YMD | null
  originalDate: YMD | null
  source: PlacementSource
  originCardId: string | null
  /** 分線（快照 schemaVersion 2 起）；v1 快照沒有 → 還原時落到預設線（lines.md §八） */
  lineId?: number | null
  /** D69 覆寫工時（schemaVersion 2 起） */
  estMinutesOverride?: number | null
  /** D74 線內順序（schemaVersion 3 起；v1／v2 快照沒有 → 還原後排在該線最上面、依固定排序） */
  sortIndex?: number | null
}

// ─────────────────────────────────────────────────────────────────────
// 供給與分配（規格 §2、§3.3；純函式 lib/packaging/scheduleAllocate.ts）
// ─────────────────────────────────────────────────────────────────────

/** 一張待排池卡拆成的供給片段：可包片（ready）與未就緒片（pending，帶預估可包日） */
export interface SupplySegment {
  cardId: string
  block: PoolBlockId
  qty: number
  ready: boolean
  /** 未就緒片的預估可包日；null＝未知（ns、無運輸方式…） */
  estReadyDate: YMD | null
}

export interface LineSupply {
  soLineKey: string
  /** 依分配順序排好：可包片在前（區塊順序），未就緒片依 estReadyDate 升冪、null 最後 */
  segments: SupplySegment[]
  /** Σ 可排片數量（S） */
  total: number
  readyTotal: number
  /** 不可排區塊（3、5c）的數量，僅顯示 */
  nonPlaceableQty: number
  /** 可排卡的每件分鐘（以 qtyCard 加權平均；全部未知為 null） */
  perUnit: number | null
}

export type Readiness = 'ready' | 'pre' | 'pre_unknown'

/** 一張擺放在分配後的結果（§3.3 allocateLine 輸出） */
export interface PlacementAllocation {
  placementId: string
  /** 修剪後的有效數量（待排池數量減少時從最早的卡開始扣，§3.3 步驟 3） */
  effectiveQty: number
  trimmedQty: number
  readyQty: number
  pendingQty: number
  readiness: Readiness
  /** 所用未就緒片中最晚的預估可包日；pre_unknown 時為 null */
  preReadyDate: YMD | null
  /** 主要供給卡（顯示用底卡）：分到最多數量的片段所屬卡 */
  baseCardId: string | null
}

export interface LineAllocation {
  soLineKey: string
  supply: LineSupply
  /** 已勾完成、但待排池尚未反映（未扣掉）的數量 U（§3.4） */
  unreflectedCompletedQty: number
  /** E = S − U */
  effectiveSupply: number
  placements: PlacementAllocation[]
  /** 各待排池卡剩餘可排數量（cardId → qty）；0 的卡不顯示在待排池 */
  remainingByCard: Record<string, number>
  remainingTotal: number
}

// ─────────────────────────────────────────────────────────────────────
// 產能（D49，§3.2；純函式 lib/packaging/scheduleCapacity.ts）
// ─────────────────────────────────────────────────────────────────────

export interface DailyCapacity {
  date: YMD
  /** D65：畫面不用（DB 欄保留） */
  headcount: number | null
  regularHours: number
  overtimeHoursMax: number
  /** 語意＝週末（六／日）開加班（D63；名稱沿用 DB 欄 is_saturday_open） */
  isSaturdayOpen: boolean
  note: string | null
  updatedBy: string
  updatedByName: string | null
  updatedAt: string
}

/**
 * explicit＝當天有填；inherited＝平日沿用最近一次（較早日期）填的平日值；
 * weekend_default＝週六／週日沒開加班（0，D49／D63）；unset＝平日但之前從沒填過任何平日值
 */
export type CapacitySource = 'explicit' | 'inherited' | 'weekend_default' | 'unset'

export interface EffectiveCapacity {
  date: YMD
  /** weekend＝週六或週日（D63：只有加班總時數） */
  kind: 'weekday' | 'weekend'
  /** D65：畫面不用（DB 欄保留，舊資料可能有值） */
  headcount: number | null
  /** 正常工時（分鐘）；unset 為 null */
  regularMinutes: number | null
  /** 加班上限（分鐘） */
  overtimeMinutes: number
  source: CapacitySource
  /** source = inherited 時，沿用哪一天的值 */
  inheritedFrom: YMD | null
  /**
   * 分線（D71：總時數＝各線加總）：這一天各「啟用中」線的有效產能，依 sort_order。
   * 有這個欄位時，上面的 regularMinutes／overtimeMinutes 就是它們的加總（見 lines.md §三.2）。
   */
  lines?: EffectiveLineCapacity[]
  /** 分線：啟用中但這天仍 unset（從沒填過）的線數；> 0 時畫面提示「B 線尚未設定」 */
  unsetLineCount?: number
}

/** 分線：一天 × 一條線的有效產能（D49 各線各自沿用最近一次較早平日值） */
export interface EffectiveLineCapacity {
  date: YMD
  lineId: number
  kind: 'weekday' | 'weekend'
  /** 正常工時（分鐘）；unset 為 null（週末恆 0） */
  regularMinutes: number | null
  overtimeMinutes: number
  source: CapacitySource
  inheritedFrom: YMD | null
}

/** 分線：產線（API／畫面用） */
export interface PackagingLine {
  id: number
  code: string
  name: string
  sortOrder: number
  active: boolean
  createdAt: string
  updatedAt: string
  updatedByName: string | null
}

/** 分線：LineCapacityRow 的 camelCase 版 */
export interface LineCapacity {
  date: YMD
  lineId: number
  regularHours: number
  overtimeHoursMax: number
  note: string | null
  updatedBy: string
  updatedByName: string | null
  updatedAt: string
}

/** D51 欄頭顏色：unset 灰、ok 一般、over_regular 橘、over_overtime 紅 */
export type DayLoad = 'unset' | 'ok' | 'over_regular' | 'over_overtime'

// ─────────────────────────────────────────────────────────────────────
// 工作台（GET /api/packaging/board，§四.1）
// ─────────────────────────────────────────────────────────────────────

export type PlacementFlagCode =
  | 'delayed'            // D50：排定日已過仍未完成，自動順延到今天
  | 'pre_due'            // D22：預排卡到了排定日仍未就緒（橘，提醒挪移）
  | 'before_est_ready'   // D22：預排卡排在預估可包日之前（資料變動造成；只警示不自動移）
  | 'trimmed'            // D7：待排池數量減少，本卡有效數量被扣
  | 'pool_consumed'      // 有效數量被扣到 0（多半是塔台已報包裝完工）
  | 'off_board_day'      // 排定日已不是工作日（週末取消加班、行事曆更新），暫顯示在下一個工作日
  | 'not_placeable_now'  // 該行目前只剩不可排區塊（3/5c）的量，本卡數量全被扣
  | 'line_eta_passed'    // 轉貼待排池卡的 eta_passed（預估可包日已過仍未入庫／前站未完工）
  | 'line_inactive'      // 分線：所屬線已停用或不存在，暫顯示在預設線（讀取時推導，lines.md §三.3）
  | 'manual_in_pool'     // D66：手動加入的品項已回到正常區塊（手動卡不重複列出）

export interface PlacementFlag {
  code: PlacementFlagCode
  label: string
  level: 'danger' | 'warn' | 'info'
}

/** 日期欄或待排區裡的一張（子）卡 */
export interface BoardCard {
  placementId: string
  version: number
  soLineKey: string
  /** DB 存的數量（拆卡對話框以此為準） */
  qty: number
  /** 分配後的有效數量（畫面顯示） */
  effectiveQty: number
  planDate: YMD | null
  /** 實際顯示在哪一欄；null＝待排區。延誤卡＝rollTarget（§3.5） */
  displayDate: YMD | null
  originalDate: YMD | null
  /** D50 延誤台灣工作日數（累計）；未延誤 0 */
  delayWorkdays: number
  readiness: Readiness
  readyQty: number
  preReadyDate: YMD | null
  /** 本子卡工時（分鐘）；工時未知 null */
  minutes: number | null
  /**
   * D7 同一 SO 行的子卡序（§3.6 步驟 8）：顯示中的擺放依日期編號 1..k，待排池剩餘卡接在後面；
   * total＝k＋剩餘卡數；total < 2 時為 null
   */
  split: { index: number; total: number } | null
  completed: PlacementCompletion | null
  source: PlacementSource
  flags: PlacementFlag[]
  /**
   * 顯示用的待排池卡（沿用 P0 PackagingCard 元件，卡片樣式不改）：
   * 以 baseCardId 那張卡為底，qtyCard＝effectiveQty、qtyReady＝readyQty、work.minutes＝minutes、split＝上面的 split。
   */
  card: PackagingCard
  /** 分線：DB 的所屬線（待排區 null） */
  lineId?: number | null
  /**
   * 分線：實際顯示在哪一條線（lanes 的 lineId）。通常＝lineId；所屬線已停用／不存在時＝預設線並加 line_inactive 旗標。
   * 待排區 null。
   */
  laneId?: number | null
  /** D69：標準估計工時（分鐘，依有效數量）；工時未知 null。上面的 minutes＝覆寫值 ?? 這個值 */
  minutesStd?: number | null
  /** D69：主管覆寫（已依有效數量等比換算，lines.md §三.6）；沒覆寫為 null */
  minutesOverride?: MinutesOverride | null
  /** D66：手動加入區塊來的卡（卡片標「手動・誰・何時」） */
  manual?: ManualInclusionMeta | null
  /**
   * D74：線內順序（DB sort_index；待排區 null）。day.cards 已依 laneOrder.compareLaneOrder 排好（null 在上、依固定排序；
   * 其後依 sortIndex 由小到大）；前端重排時用它算中間值。
   */
  sortIndex?: number | null
}

/** 分線：日期欄裡的一條線（D67／D68；日檢視＝時間尺上的一欄，週／兩週＝日期欄內的小欄） */
export interface BoardLane {
  lineId: number
  code: string
  name: string
  sortOrder: number
  capacity: EffectiveLineCapacity
  /**
   * 這條線的卡數。卡片本身不重複放在 lane 裡（避免回應大小翻倍）：
   * 前端以 day.cards.filter(c => c.laneId === lane.lineId) 取得，順序沿用 day.cards 的排序（D74 線內順序）；日檢視依此順序沿時間往下疊。
   */
  cardCount: number
  /** 已排工時（分鐘，含已完成、不含工時未知） */
  usedMinutes: number
  openMinutes: number
  unknownMinutesCards: number
  load: DayLoad
  /**
   * D72 自動選線用的剩餘工時（分鐘）＝（平日：正常工時；週末：加班上限）− 已排；可為負。
   * 該線 unset 時 null（自動選線排在最後）。算法見 lines.md §三.4 pickAutoLane。
   */
  remainingMinutes: number | null
}

export interface BoardDay {
  date: YMD
  /** 0＝週日 … 6＝週六 */
  weekday: number
  /** weekend_ot＝已開加班的週六／週日（D48／D63） */
  kind: 'workday' | 'weekend_ot'
  isToday: boolean
  /** 例：'9/29（二）' */
  label: string
  capacity: EffectiveCapacity
  /**
   * D74 排序（lib/packaging/laneOrder.ts compareLaneOrder）：sortIndex 為 null 的卡與延誤卡在前、依固定排序
   * （延誤 → 預排到期 → 打樣 → 交期 → 建立時間）；其後依 sortIndex 由小到大。前端依 laneId 篩出即為各線順序。
   */
  cards: BoardCard[]
  /** 已排工時（分鐘，含已完成、不含工時未知的卡） */
  usedMinutes: number
  /** 其中未完成的部分 */
  openMinutes: number
  unknownMinutesCards: number
  load: DayLoad
  /** 今天欄：由過去日期順延進來的卡數（D50） */
  rolledInCount: number
  /**
   * 分線（D67／D72）：這一天各啟用中線的負荷，依 sort_order。
   * 上面的 cards／usedMinutes／capacity 仍是「全部線合計」（D71 總時數＝各線加總）；
   * 每張卡恰好屬於一條 lane（BoardCard.laneId），lane 的卡＝day.cards 依 laneId 篩出。
   */
  lanes?: BoardLane[]
}

/** 待排池卡在工作台上的附加資訊（卡片本身已把 qtyCard 換成剩餘量） */
export interface PoolCardMeta {
  /** P0 原始 qtyCard */
  originalQty: number
  /** 已排出去（含已完成未反映）的量 */
  placedQty: number
  remainingQty: number
  placeable: boolean
  /** D66：手動加入區塊的卡（'mn'） */
  manual?: ManualInclusionMeta | null
}

export interface BoardSkipped {
  /** 擺放的 SO 行已不在待排池（塔台結案 D43、包裝報完工 D45、SO 結案…）：不刪資料，讀取時略過 */
  lineGoneOpen: number
  lineGoneCompleted: number
  /** 有效數量被扣到 0 且排定日已過的卡（不顯示） */
  consumedPast: number
  /** D66：手動加入但 SO 行已不在 erp_so_lines（ERP 結案）→ 不出卡（手動加入紀錄保留，讀取時略過） */
  manualSoGone?: number
  /** D66：手動加入的品項已回到正常區塊（不重複出手動卡） */
  manualBackInPool?: number
  /** D73：手動加入的品項在 ARGO 已全數銷貨 → 不出卡（紀錄保留） */
  manualSoldOut?: number
}

export interface BoardViewer {
  email: string
  name: string | null
  /** D30：packaging_admin 或 admin */
  canEdit: boolean
}

export type BoardResponse =
  | {
      success: true
      unchanged?: false
      /** 伺服器時間（ISO）；前端倒數鎖逾時、顯示「N 分鐘前」一律以它校正 */
      serverTime: string
      today: YMD
      /** D50 順延目標：今天若不是工作台日期（週末／假日）則為下一個工作台日期 */
      rollTarget: YMD
      /** 內容指紋；帶 ?rev= 回傳相同時只回 unchanged */
      revision: string
      window: { from: YMD; to: YMD; workdays: number }
      days: BoardDay[]
      /** D21 待排區（plan_date = null） */
      holding: BoardCard[]
      /** 排在視窗之後的卡（捲動載入前先告知） */
      later: { count: number; minutes: number; firstDate: YMD | null }
      pool: {
        /** 已扣掉排出去的量；剩餘 0 的卡不列出 */
        blocks: PoolBlock[]
        cardMeta: Record<string, PoolCardMeta>
        generatedAt: string
        cached: boolean
      }
      skipped: BoardSkipped
      lock: LockState
      me: BoardViewer
      freshness: PoolFreshness
      excluded: PoolExcluded
      notes: string[]
      /** D44 異常清單只給筆數（清單在 /packaging/pool） */
      staleUnsyncedCount: number
      /** 分線（D71）：全部產線（含停用，active 區分）；lanes 只含啟用中的線 */
      lines?: PackagingLine[]
      /** 分線：預設線（啟用中 sort_order 最小；停用線的卡、v1 快照還原落在這裡） */
      defaultLineId?: number | null
    }
  | {
      success: true
      unchanged: true
      serverTime: string
      revision: string
      lock: LockState
    }
  | { success: false; error: string }

// ─────────────────────────────────────────────────────────────────────
// 擺放操作（POST /api/packaging/placements、/api/packaging/cards/complete，§3.8、§四.2~3）
// ─────────────────────────────────────────────────────────────────────

export type PlacementOp =
  /**
   * 從待排池排出：qty ≤ 該卡剩餘可排量；toDate null＝放進待排區。
   * 分線（D72）：toDate 非 null 時 lineId 必填（前端依 pickAutoLane 或放下的線決定；缺 → line_required）；toDate null 時忽略。
   */
  | { op: 'place'; id: string; soLineKey: string; qty: number; toDate: YMD | null; originCardId: string | null; lineId?: number | null }
  /**
   * 移到別天或待排區（null）；AI 卡被移動後 source 變 manual。
   * 分線：lineId 省略＝沿用原線（原線無效或原本在待排區 → line_required）；同一天換線＝同 toDate＋新 lineId。
   * D74：sortIndex 省略＝換到別的「天×線」時放在該線最後（appendSortIndex）、顯示位置沒變時保留原順序、移到待排區清成 null；
   *   有帶（含 null）＝直接用它（Undo「移回原線」時還原原本的上下位置）。
   */
  | { op: 'move'; id: string; version: number; toDate: YMD | null; lineId?: number | null; sortIndex?: number | null }
  /**
   * 拆卡（D7）：原卡留 keepQty，其餘各成新卡；keepQty + Σparts.qty 必須等於原 qty。
   * 分線：part.lineId 省略＝同原卡的線。D69：原卡有覆寫工時時依數量比例分給各張（lines.md §三.6）。
   */
  | { op: 'split'; id: string; version: number; keepQty: number; parts: { id: string; qty: number; toDate?: YMD | null; lineId?: number | null }[] }
  /** 合併同 SO 行的子卡到 target（target 保留自己的日期與線），sources 刪除；D69 覆寫工時合併規則見 lines.md §三.6 */
  | { op: 'merge'; targetId: string; targetVersion: number; sources: { id: string; version: number }[] }
  /** 放回待排池（刪除擺放） */
  | { op: 'unplace'; id: string; version: number }
  /**
   * 改數量（只用於 Undo 還原合併；畫面不直接提供）。
   * minutesOverride：有帶（含 null）就同時把覆寫工時設成該值（Undo 合併時還原 target 原本的覆寫）；省略＝不動。
   */
  | { op: 'setQty'; id: string; version: number; qty: number; minutesOverride?: number | null }
  /** 以原 id 重建一列（只用於 Undo 還原「放回待排池／合併」；row.lineId／estMinutesOverride 一併還原） */
  | { op: 'restore'; row: PlacementSnapshotRow }
  /**
   * D24 勾完成。伺服器同時：plan_date 若已過或為 null（待排區）→ 改為 rollTarget；
   * 有效數量被扣過（trimmed）→ qty 改為 effectiveQty；記 completed_pool_qty（§3.4）。
   * 分線：待排區的卡勾完成時沒有線 → 用 lineId（省略＝預設線）。
   */
  | { op: 'complete'; id: string; version: number; lineId?: number | null }
  /** 取消完成；Undo 產生的反向操作會帶 prevPlanDate／prevQty／prevLineId 把勾完成時改掉的值還原 */
  | { op: 'uncomplete'; id: string; version: number; prevPlanDate?: YMD | null; prevQty?: number; prevLineId?: number | null }
  /**
   * D69 主管改工時（分鐘，以本列 qty 為準；null＝清除覆寫、回到標準估計）。
   * 已完成的卡也可以改（記錄實際花的時間，學習價值最高）。成功後伺服器寫一筆 packaging_time_adjustments。
   * 反向操作＝setMinutes 回原值（via 'undo'）。
   */
  | {
      op: 'setMinutes'; id: string; version: number; minutes: number | null; reason?: string | null; via?: MinutesEditVia
      /**
       * 只在 via 'undo' 時採用：還原覆寫時沿用原本「誰何時改的」（伺服器產生反向操作時帶上，前端原樣送回）。
       * 省略／null＝以本次操作者為修改者。學習紀錄（packaging_time_adjustments）仍記實際按 Undo 的人（via 'undo'）。
       */
      restoreMeta?: { by: string; byName: string | null; at: string } | null
    }
  /**
   * D74 線內上下排序：只改這張卡的 sort_index（不改日期、線、數量 → 必定「同日同線內」、數量守恆不受影響）。
   * sortIndex：numeric(12,4) 範圍內；null＝回到「固定排序」群組。待排區的卡沒有線內順序 → bad_request。
   * 已完成的卡也可以調（它仍佔時間尺位置，別的卡要能排到它前後）。反向操作＝reorder 回原值。
   * 前端一次拖曳可能送多個 reorder（該線有 null 的卡時整條線重新編號），同一批送出＝一步 Undo。
   */
  | { op: 'reorder'; id: string; version: number; sortIndex: number | null }

export type PlacementOpKind = PlacementOp['op']

export interface PlacementsRequest {
  lockToken: string
  ops: PlacementOp[]
  /** 畫面上的操作名稱（寫進 packaging_op_log 與 Undo 標籤），例：「拖曳 SO260924020-1 → 9/30」 */
  label?: string
}

/** /api/packaging/cards/complete：只收 complete / uncomplete（待排池卡直接完成＝place＋complete 同批送） */
export interface CompleteRequest {
  lockToken: string
  ops: Extract<PlacementOp, { op: 'complete' | 'uncomplete' | 'place' }>[]
  label?: string
}

export type ApplyErrorCode =
  | 'forbidden'
  | 'lock_required'        // 沒帶 token 或鎖已逾時
  | 'lock_lost'            // 鎖被別人接手
  | 'too_many_ops'
  | 'bad_request'
  | 'not_found'
  | 'version_conflict'
  | 'id_exists'
  | 'qty_invalid'
  | 'qty_exceeds_remaining'
  | 'split_sum_mismatch'
  | 'merge_mismatch'       // 不同 SO 行、或含已完成卡
  | 'completed_locked'     // 已完成的卡不能移動／拆／併，要先取消完成
  | 'date_invalid'
  | 'date_past'
  | 'date_not_board_day'
  | 'before_est_ready'     // D22
  | 'not_placeable'        // 區塊 3 / 5c
  | 'line_not_in_pool'
  | 'line_required'        // 分線：排進日期但沒指定線（且原本沒有有效的線可沿用）
  | 'line_invalid'         // 分線：線不存在或已停用
  | 'minutes_invalid'      // D69：覆寫工時超出範圍（MINUTES_OVERRIDE_MIN～MAX、一位小數）
  | 'pool_unavailable'     // 待排池組裝失敗，無法驗證
  | 'db_error'

export type ApplyResponse =
  | {
      success: true
      /** 寫入後的列（新增與更新） */
      rows: Placement[]
      deletedIds: string[]
      /** 反向操作（依序送出即可還原）；前端推進 Undo 堆疊 */
      inverse: PlacementOp[]
      revision: string
      lock: LockState
      /** D69：工時已改成功，但學習紀錄（packaging_time_adjustments）寫入失敗 → 前端提示「修改紀錄未存到」 */
      adjustmentLogFailed?: boolean
    }
  | {
      success: false
      error: string
      code: ApplyErrorCode
      /** 第幾個操作失敗（0 起） */
      opIndex?: number
      /** version_conflict / not_found 時附目前的列，前端據以更新 */
      current?: Placement | null
      lock?: LockState
      /**
       * 多列寫入中途失敗、前面幾步已寫入（無交易，§3.8「先減後增」保證只會把數量退回待排池）。
       * 前端收到 partial＝true 一律重新載入工作台並清空 Undo／Redo。
       */
      partial?: boolean
    }

/** 前端 Undo／Redo 堆疊的一格（純函式 lib/packaging/scheduleUndo.ts） */
export interface UndoEntry {
  label: string
  /** 送出即可還原的操作（伺服器回傳的 inverse） */
  ops: PlacementOp[]
  at: string
}

export interface UndoState {
  undo: UndoEntry[]
  redo: UndoEntry[]
}

// ─────────────────────────────────────────────────────────────────────
// 產能 API（GET/PUT /api/packaging/capacity，§四.4）
// ─────────────────────────────────────────────────────────────────────

export type CapacityInput =
  /**
   * regularHours／overtimeHoursMax＝正常／加班「總時數」（D65 組長直接填）；isSaturdayOpen＝週末開加班（D63）。
   * headcount：D65 起畫面不送；舊客戶端送了照樣驗證、存入。
   * 分線（D71）：lines 為各線時數（權威值）；有 lines 時伺服器忽略 regularHours／overtimeHoursMax，改寫成各線加總
   *   （packaging_daily_capacity 的總時數只剩相容用途，lines.md §一.3）。分線輪伺服器上線後，沒帶 lines 的請求回 bad_request。
   */
  | { date: YMD; headcount?: number | null; regularHours: number; overtimeHoursMax: number; isSaturdayOpen: boolean; note?: string | null; lines?: LineCapacityInput[] }
  /** 刪掉當天的列（含該日所有線的列），回到沿用／預設 */
  | { date: YMD; clear: true }

/** 分線：一天 × 一條線的產能輸入（小時，最多 2 位小數；週末 regularHours 必須 0） */
export type LineCapacityInput =
  | { lineId: number; regularHours: number; overtimeHoursMax: number; note?: string | null }
  /** 只刪這條線這天的列（回到該線沿用最近較早平日值） */
  | { lineId: number; clear: true }

export interface CapacityPutRequest {
  lockToken: string
  rows: CapacityInput[]
}

export type CapacityResponse =
  | {
      success: true
      /** 查詢區間內實際填過的列 */
      rows: DailyCapacity[]
      /** 查詢區間內每個工作日＋區間內所有週六、週日（不論是否開加班，產能對話框要能開關；國定假日的週末也列出但不能開）的有效產能 */
      effective: EffectiveCapacity[]
      lock?: LockState
      /** 分線：全部產線（含停用）；產能表的欄＝啟用中的線 */
      lines?: PackagingLine[]
      /** 分線：查詢區間內實際填過的各線列 */
      lineRows?: LineCapacity[]
    }
  | {
      success: false
      error: string
      /**
       * migration_required：新表／新 constraint 不存在（20260927b_packaging_p1_extend.sql 尚未套用）。
       * line_invalid：lines 內有不存在或已停用的線。
       */
      code?: 'forbidden' | 'lock_required' | 'lock_lost' | 'bad_request' | 'date_not_workday' | 'weekend_has_cards' | 'migration_required' | 'line_invalid' | 'db_error'
      /** weekend_has_cards：該週末日還有幾張未完成的卡 */
      cardCount?: number
      date?: YMD
    }

// ─────────────────────────────────────────────────────────────────────
// 版本快照（D33，§3.9、§四.5）
// ─────────────────────────────────────────────────────────────────────

export type VersionSource = 'manual' | 'auto_before_ai' | 'auto_after_ai' | 'auto_before_restore'

export interface ScheduleSnapshot {
  /**
   * 1＝P1 原版；2＝分線輪起（列多了 lineId、estMinutesOverride）；3＝D74 起（列多了 sortIndex）。parseSnapshot 三版都收；
   * v1 快照還原時，排進日期的列落到預設線（lines.md §八）；v1／v2 還原後 sortIndex＝null（該線最上面、固定排序）。
   */
  schemaVersion: 1 | 2 | 3
  takenAt: string
  today: YMD
  /** 只存未完成的擺放（完成是事實不是計畫，還原不動它） */
  placements: PlacementSnapshotRow[]
}

export interface VersionMeta {
  id: number
  label: string
  source: VersionSource
  placementCount: number
  createdAt: string
  createdBy: string
  createdByName: string | null
  /** createdAt + 90 天 */
  expiresAt: string
}

export type VersionsListResponse =
  | { success: true; versions: VersionMeta[] }
  | { success: false; error: string }

export interface VersionCreateRequest {
  lockToken: string
  label: string
}

export type VersionCreateResponse =
  | { success: true; version: VersionMeta }
  | { success: false; error: string; code?: 'forbidden' | 'lock_required' | 'lock_lost' | 'bad_request' | 'db_error' }

/** 還原前預覽（GET /api/packaging/versions/[id]/restore）與還原結果共用 */
export interface RestorePlan {
  /** 會被刪除的現有未完成擺放 */
  removeCount: number
  /** 會寫入的快照擺放 */
  insertCount: number
  /** 快照中排定日已過、還原後會順延到今天並標延誤的張數 */
  pastDateCount: number
  /** 快照中 SO 行已不在待排池的張數（照樣寫入，讀取時略過） */
  lineGoneCount: number
  /** 分線：排進日期、但快照沒有線（v1）或線已停用／不存在，還原時改放預設線的張數 */
  lineRemappedCount?: number
}

/** GET /api/packaging/versions/[id]/restore：還原預覽（不寫入、不需鎖） */
export type RestorePreviewResponse =
  | { success: true; version: VersionMeta; plan: RestorePlan }
  | { success: false; error: string; code?: 'forbidden' | 'not_found' | 'bad_request' | 'db_error' }

export interface RestoreRequest {
  lockToken: string
}

export type RestoreResponse =
  | {
      success: true
      plan: RestorePlan
      /** 還原前自動存的備份版本（source = auto_before_restore） */
      backup: VersionMeta
      revision: string
    }
  | { success: false; error: string; code?: 'forbidden' | 'lock_required' | 'lock_lost' | 'not_found' | 'bad_request' | 'db_error' }

// ─────────────────────────────────────────────────────────────────────
// 編輯鎖（D53，§3.7、§四.6；純函式 lib/packaging/scheduleLock.ts）
// ─────────────────────────────────────────────────────────────────────

export interface LockState {
  /** 有有效持有者（未逾 5 分鐘無動作） */
  held: boolean
  holderEmail: string | null
  holderName: string | null
  acquiredAt: string | null
  lastActionAt: string | null
  /** lastActionAt + LOCK_IDLE_MS；held = false 時為 null */
  expiresAt: string | null
  /** 呼叫者（同 email 且同 token）就是持有者 */
  isMine: boolean
  /** 呼叫者曾持有、剛被接手時帶（前端顯示「已被 XXX 接手」） */
  takenOverBy: { email: string; name: string | null; at: string } | null
}

export type LockAction = 'acquire' | 'heartbeat' | 'release' | 'takeover'

export interface LockRequest {
  action: LockAction
  /** heartbeat／release 必帶；acquire 帶舊 token 可續用（同一分頁重整） */
  token?: string | null
  /** heartbeat：這 30 秒內使用者是否有操作（滑鼠、鍵盤、拖曳）；true 才延長 5 分鐘 */
  active?: boolean
}

export type LockResponse =
  | {
      success: true
      lock: LockState
      /** acquire／takeover 成功時才回（只給持有者本人） */
      token?: string
    }
  | {
      success: false
      error: string
      code: 'forbidden' | 'held_by_other' | 'lock_lost' | 'bad_request' | 'db_error'
      lock?: LockState
    }

/** 純函式 planLockAction 的輸出：伺服器照它做一次 compare-and-set 更新（以 token 比對） */
export type LockPlan =
  | {
      kind: 'update'
      /** 更新條件：目前 token 必須等於它（null＝目前沒有 token） */
      expectToken: string | null
      patch: Partial<Omit<EditLockRow, 'id'>>
      /** acquire／takeover 產生的新 token */
      newToken: string | null
    }
  | { kind: 'reject'; code: 'held_by_other' | 'lock_lost' }
  | { kind: 'noop' }

// ─────────────────────────────────────────────────────────────────────
// 分線：線別 API（GET/POST/PATCH /api/packaging/lines，lines.md §四.4；D67／D71）
// ─────────────────────────────────────────────────────────────────────

export type LineErrorCode =
  | 'forbidden'
  | 'lock_required'
  | 'lock_lost'
  | 'bad_request'
  | 'not_found'
  | 'code_exists'        // 代碼重複
  | 'too_many_lines'     // 含停用超過 MAX_LINES
  | 'too_many_active'    // 啟用中超過 MAX_ACTIVE_LINES
  | 'line_has_cards'     // 停用前該線還有未完成、排進日期的卡（附 cardCount），請先移走
  | 'last_active_line'   // 不能停用最後一條啟用中的線
  | 'migration_required' // packaging_lines 不存在（20260927b_packaging_p1_extend.sql 尚未套用）
  | 'db_error'

export type LinesResponse =
  | { success: true; lines: PackagingLine[]; defaultLineId: number | null }
  | { success: false; error: string; code?: LineErrorCode }

/** POST：新增一條線（D71「主管可手動增加一條」）；code 省略＝自動取下一個未用的英文字母（D、E…） */
export interface LineCreateRequest {
  lockToken: string
  name: string
  code?: string
}

/** PATCH：改名／停用／啟用／排序（線不能刪，只能停用；歷史資料保留） */
export interface LinePatchRequest {
  lockToken: string
  id: number
  name?: string
  active?: boolean
  sortOrder?: number
}

export type LineMutationResponse =
  | { success: true; line: PackagingLine; lines: PackagingLine[]; lock: LockState }
  | { success: false; error: string; code: LineErrorCode; cardCount?: number; lock?: LockState }

// ─────────────────────────────────────────────────────────────────────
// D66 手動加入（GET/POST/PATCH /api/packaging/manual、POST /api/packaging/manual/remove，lines.md §六）
// ─────────────────────────────────────────────────────────────────────

/**
 * 查詢某 SO 各品項行「為什麼不在待排池」（重用 classify／pool 的判定與 EIP 鏡像資料，不查 ARGO）。
 * 一行可有多個原因，依畫面顯示順序排列。
 */
export type ManualAbsenceCode =
  | 'in_pool'            // 已在待排池（附所在區塊）
  | 'manual_active'      // 已手動加入
  | 'non_physical'       // D12 費用行（運費、設計費…）：不可勾選
  | 'zero_qty'           // 訂單量 0：不可勾選
  | 'non_schedule_doc'   // D46 只出現在「素材單/包裝單」
  | 'tower_closed'       // D43 塔台批已結案（含 D47 製令號解碼命中）
  | 'packaged_done'      // D45 塔台包裝站已報完工
  | 'sheet_stale'        // D44 發單超過 30 天仍未上塔台
  | 'sold_out'           // D73 ARGO 已全數銷貨（出貨）：不可勾選（加入後也會被排除）
  | 'waiting_source'     // 有採購／製令來源但尚未達進池條件（常平未寄且不緊張、委外未到交期、前站未開工…）
  | 'unknown'            // 以上皆非（可能尚未發單、資料未同步）

export interface ManualAbsenceReason {
  code: ManualAbsenceCode
  /** 繁中說明（直接顯示），例「塔台批已結案（MOT26082502107）」 */
  label: string
}

export interface ManualLookupLine {
  soLineKey: string
  lineNo: string
  itemCode: string | null
  itemName: string | null
  packing: string | null
  unit: string | null
  /** ERP 訂單量（order_qty_oru） */
  orderQty: number
  dueDate: YMD | null
  /** in_pool＝已在待排池；manual＝已手動加入；absent＝不在池內（可加入與否看 selectable） */
  state: 'in_pool' | 'manual' | 'absent'
  inPoolBlocks: { block: PoolBlockId; title: string; qty: number }[]
  manual: ManualInclusionMeta | null
  /** 手動加入且已全數完成（待排池已不出 'mn' 卡；要結束紀錄請用 POST /api/packaging/manual/remove）；舊回應可能沒有 */
  manualDone?: boolean
  reasons: ManualAbsenceReason[]
  /** 可以勾選加入（state＝absent 且沒有 non_physical／zero_qty） */
  selectable: boolean
  /** 不可勾選時的說明 */
  blockedReason: string | null
  /** 建議途程類型（有常平採購＝常平、其他廠商採購＝委外、否則自製；廠商代碼不外露） */
  suggestedRouteType: ManualRouteType
  /** 建議數量＝ERP 訂單量（D66「預設 ERP 訂單量可改」） */
  suggestedQty: number
}

export type ManualLookupResponse =
  | {
      success: true
      so: string
      /** erp_so_lines 查得到這張單（查不到＝ERP 已結案或單號錯誤，不能加入） */
      found: boolean
      customer: string | null
      lines: ManualLookupLine[]
    }
  | { success: false; error: string; code?: ManualErrorCode }

export type ManualErrorCode =
  | 'forbidden'
  | 'lock_required'
  | 'lock_lost'
  | 'bad_request'
  | 'not_found'              // 找不到有效的手動加入紀錄
  | 'so_line_not_found'      // erp_so_lines 查無此行（ERP 已結案）
  | 'already_in_pool'        // 已在待排池正常區塊，不需手動加入
  | 'already_manual'         // 已手動加入（未移出）
  | 'not_selectable'         // 費用行、訂單量 0
  | 'qty_invalid'
  | 'qty_below_placed'       // 改數量低於已排出（未完成）的量
  | 'manual_has_placements'  // 移出前還有未完成的排定卡（附 cardCount），請先放回待排池
  | 'too_many'               // 超過 MAX_MANUAL_ITEMS_PER_REQUEST 或 MAX_ACTIVE_MANUAL
  | 'migration_required'
  | 'db_error'

export interface ManualAddItem {
  soLineKey: string
  /** 預設 ERP 訂單量，可改（> 0、最多 3 位小數） */
  qty: number
  routeType?: ManualRouteType
  /** 原因（選填，ADJUST_REASON_MAX 字內） */
  reason?: string | null
}

/** POST /api/packaging/manual（packaging_admin＋鎖）：一次加入 1～MAX_MANUAL_ITEMS_PER_REQUEST 行 */
export interface ManualAddRequest {
  lockToken: string
  items: ManualAddItem[]
}

/** PATCH /api/packaging/manual：改數量／途程類型／原因 */
export interface ManualUpdateRequest {
  lockToken: string
  soLineKey: string
  qty?: number
  routeType?: ManualRouteType
  reason?: string | null
}

/** POST /api/packaging/manual/remove：移出待排池（軟刪除，紀錄保留） */
export interface ManualRemoveRequest {
  lockToken: string
  soLineKey: string
  reason?: string | null
}

export type ManualMutationResponse =
  | {
      success: true
      /** 本次新增／更新／移出後的列 */
      inclusions: ManualInclusion[]
      /** 批次加入時被略過的行（其他行照常加入） */
      skipped: { soLineKey: string; code: ManualErrorCode; message: string }[]
      revision: string
      lock: LockState
    }
  | { success: false; error: string; code: ManualErrorCode; cardCount?: number; lock?: LockState }

// ─────────────────────────────────────────────────────────────────────
// D69 工時修改紀錄（GET /api/packaging/adjustments，lines.md §四.6）
// ─────────────────────────────────────────────────────────────────────

/** TimeAdjustmentRow 的 camelCase 版（不回 actor_email，只回名字） */
export interface TimeAdjustment {
  id: number
  createdAt: string
  placementId: string
  soLineKey: string
  itemCode: string | null
  itemName: string | null
  qty: number
  packing: string | null
  routeType: string | null
  workSource: string | null
  workExplain: string | null
  perUnitStd: number | null
  stdMinutes: number | null
  beforeMinutes: number | null
  afterMinutes: number | null
  perUnitAfter: number | null
  cleared: boolean
  reason: string | null
  via: MinutesEditVia
  planDate: YMD | null
  lineId: number | null
  actorName: string | null
}

export type AdjustmentsResponse =
  | {
      success: true
      /** 這張（子）卡的修改歷程（新到舊，最多 ADJUSTMENTS_LIST_LIMIT 筆） */
      placement: TimeAdjustment[]
      /** 同品號的歷史（不含 via＝undo）：筆數、改後每件分鐘平均、最近 10 筆 */
      sameItem: { itemCode: string | null; count: number; avgPerUnitAfter: number | null; recent: TimeAdjustment[] }
    }
  | { success: false; error: string; code?: 'forbidden' | 'bad_request' | 'migration_required' | 'db_error' }

// ─────────────────────────────────────────────────────────────────────
// D73 銷貨同步（GET /api/packaging/sales-sync；lib/packaging/salesSync.ts）
// ─────────────────────────────────────────────────────────────────────

/**
 * full＝erp_so_lines 中全部（未結案）SO 分批重算覆蓋，並清掉已不在 erp_so_lines 的 SO 的鏡像列；
 * incremental＝近 N 天（IO_DATE）有銷貨的 SO ∪ 鏡像中近 N 天有銷貨的 SO（抓近期作廢）重算覆蓋。
 */
export type SalesSyncMode = 'full' | 'incremental'

export interface SalesSyncStats {
  mode: SalesSyncMode
  /** incremental 的回看天數；full 為 null */
  days: number | null
  /** full 分片（shards > 1 時只處理 index % shards == shard 的 SO） */
  shard: number
  shards: number
  /** 本次要重算的 SO 數、批數（每批 ≤ 60 張，ARGO 動態 WHERE 有 4000 字上限） */
  soCount: number
  batches: number
  batchesDone: number
  /** ARGO 回來的銷貨明細列數 */
  argoRows: number
  /** 寫入 erp_so_sales：upsert 列數、刪除的（SO, 品號）列數（作廢／改品號）、整張 SO 清空數（ARGO 已無任何銷貨） */
  upserted: number
  deleted: number
  clearedSos: number
  /** full：已不在 erp_so_lines（結案）而清掉鏡像的 SO 數 */
  closedSosPurged: number
  /** 時間預算用完（maxDuration 300 秒）而沒做完的批數；> 0 時 last_full_at 不更新 */
  skippedBatches: number
  elapsedMs: number
}

export type SalesSyncResponse =
  | ({ success: true; partial: boolean; errors: string[] } & SalesSyncStats)
  | { success: false; error: string; code?: 'unauthorized' | 'forbidden' | 'bad_request' | 'argo_unconfigured' | 'busy' | 'migration_required' | 'db_error' | 'argo_error' }

// ─────────────────────────────────────────────────────────────────────
// D68／D70 日檢視時間尺（純函式 lib/packaging/laneTimeline.ts，lines.md §三.7）
// ─────────────────────────────────────────────────────────────────────

/**
 * 一條線的「工時 → 鐘面」換算。鐘面一律用「從 00:00 起的分鐘」（D70：一天＝00:00～24:00 模型，畫面只顯示一段）。
 * scaled：平日 [0, R] → 10:00～19:00、(R, R+O] → 19:00～24:00；週末或 R＝0 只有加班 → [0, O] → 10:00～19:00（allOvertime）。
 * nominal：該線 unset 或 R＝O＝0 → 1 工時分鐘＝1 鐘面分鐘，從 10:00 起（畫面標「未設定」或「未排班」）。
 */
export interface LaneScale {
  kind: 'scaled' | 'nominal'
  /** nominal 的原因 */
  reason: 'unset' | 'zero' | null
  segments: { kind: 'regular' | 'overtime'; workFrom: number; workTo: number; clockFrom: number; clockTo: number }[]
  /** 超過最後一段後，每 1 工時分鐘佔幾鐘面分鐘（沿用最後一段的比例） */
  overflowRate: number
  /** 正常＋加班上限（工時分鐘）；超過這個累計量的部分為 over（紅） */
  capMinutes: number
  /** 只有加班額度（週末、或平日正常 0） */
  allOvertime: boolean
}

/** layoutLane 的輸出：一張卡在時間尺上的位置（px 從顯示起點算） */
export interface LaneCardLayout {
  placementId: string
  topPx: number
  heightPx: number
  /** 高度 < LANE_CARD_COMPACT_PX：只顯示單號＋品名（D68） */
  compact: boolean
  /** 累計工時區間（分鐘）；工時未知的卡 workEnd＝workStart */
  workStart: number
  workEnd: number
  /** 鐘面（00:00 起的分鐘） */
  clockStart: number
  clockEnd: number
  /** 卡片結束點落在哪一段：regular 一般、overtime 橘、over 紅（超過該線加班上限）、unknown 工時未知 */
  zone: 'regular' | 'overtime' | 'over' | 'unknown'
  /** 因前一張卡的最小高度被往下推（位置不再精確對應時間，畫面以淡色時間提示） */
  shifted: boolean
}
