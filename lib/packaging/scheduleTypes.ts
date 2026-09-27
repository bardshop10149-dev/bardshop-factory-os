// 包裝專區 P1（拖曳排程工作台）共用型別契約 —— 資料層（lib/packaging/*、/api/packaging/*）與畫面共用。
// 規格：docs/design/2026-09-27-packaging-schedule-p1.md（本檔各段落對應該文件章節）。
// 資料表：sql/20260927_packaging_schedule.sql（套用前 packaging_* 表不存在）。
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

/** D51：工作台預設顯示今天起幾個台灣工作日（週六加班日另外插入，不佔名額） */
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

/**
 * D22：可以拖進日期欄（排定／預排）的待排池區塊。
 * - '3'（常平未寄出且交期緊張）：D22 明文「不預排、僅提醒」。
 * - '5c'（委外出貨待確認）：廠商是否已出貨不明，比照 3 不可排（規格 §2.3，待 Snow 確認）。
 * - 'ns'（已發單・未上塔台）：D44「可正常排程」，但可包日未知 → 一律虛線 pre_unknown。
 */
export const PLACEABLE_BLOCKS = ['2', '5b', '4', '4x', '1b', '1', '5a', 'ns'] as const satisfies readonly PoolBlockId[]
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
}

export type PlacementSource = 'manual' | 'ai'

/** packaging_daily_capacity：一天一列（D49） */
export interface DailyCapacityRow {
  date: YMD
  headcount: number | null
  /** 正常工時合計（小時，至 19:00，已扣請假／支援品檢）；週六恆為 0 */
  regular_hours: number
  /** 可加班工時上限（小時；平日 19:00 後、週六） */
  overtime_hours_max: number
  /** 只有週六能為 true：開加班＝該週六出現在工作台 */
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
  headcount: number | null
  regularHours: number
  overtimeHoursMax: number
  isSaturdayOpen: boolean
  note: string | null
  updatedBy: string
  updatedByName: string | null
  updatedAt: string
}

/**
 * explicit＝當天有填；inherited＝平日沿用最近一次（較早日期）填的平日值；
 * saturday_default＝週六沒開加班（0）；unset＝平日但之前從沒填過任何平日值
 */
export type CapacitySource = 'explicit' | 'inherited' | 'saturday_default' | 'unset'

export interface EffectiveCapacity {
  date: YMD
  kind: 'weekday' | 'saturday'
  headcount: number | null
  /** 正常工時（分鐘）；unset 為 null */
  regularMinutes: number | null
  /** 加班上限（分鐘） */
  overtimeMinutes: number
  source: CapacitySource
  /** source = inherited 時，沿用哪一天的值 */
  inheritedFrom: YMD | null
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
  | 'off_board_day'      // 排定日已不是工作日（週六取消加班、行事曆更新），暫顯示在下一個工作日
  | 'not_placeable_now'  // 該行目前只剩不可排區塊（3/5c）的量，本卡數量全被扣
  | 'line_eta_passed'    // 轉貼待排池卡的 eta_passed（預估可包日已過仍未入庫／前站未完工）

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
}

export interface BoardDay {
  date: YMD
  /** 0＝週日 … 6＝週六 */
  weekday: number
  kind: 'workday' | 'saturday_ot'
  isToday: boolean
  /** 例：'9/29（二）' */
  label: string
  capacity: EffectiveCapacity
  /** 依 §3.6 排序：延誤 → 打樣 → 交期 → 建立時間 */
  cards: BoardCard[]
  /** 已排工時（分鐘，含已完成、不含工時未知的卡） */
  usedMinutes: number
  /** 其中未完成的部分 */
  openMinutes: number
  unknownMinutesCards: number
  load: DayLoad
  /** 今天欄：由過去日期順延進來的卡數（D50） */
  rolledInCount: number
}

/** 待排池卡在工作台上的附加資訊（卡片本身已把 qtyCard 換成剩餘量） */
export interface PoolCardMeta {
  /** P0 原始 qtyCard */
  originalQty: number
  /** 已排出去（含已完成未反映）的量 */
  placedQty: number
  remainingQty: number
  placeable: boolean
}

export interface BoardSkipped {
  /** 擺放的 SO 行已不在待排池（塔台結案 D43、包裝報完工 D45、SO 結案…）：不刪資料，讀取時略過 */
  lineGoneOpen: number
  lineGoneCompleted: number
  /** 有效數量被扣到 0 且排定日已過的卡（不顯示） */
  consumedPast: number
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
  /** 從待排池排出：qty ≤ 該卡剩餘可排量；toDate null＝放進待排區 */
  | { op: 'place'; id: string; soLineKey: string; qty: number; toDate: YMD | null; originCardId: string | null }
  /** 移到別天或待排區（null）；AI 卡被移動後 source 變 manual */
  | { op: 'move'; id: string; version: number; toDate: YMD | null }
  /** 拆卡（D7）：原卡留 keepQty，其餘各成新卡；keepQty + Σparts.qty 必須等於原 qty */
  | { op: 'split'; id: string; version: number; keepQty: number; parts: { id: string; qty: number; toDate?: YMD | null }[] }
  /** 合併同 SO 行的子卡到 target（target 保留自己的日期），sources 刪除 */
  | { op: 'merge'; targetId: string; targetVersion: number; sources: { id: string; version: number }[] }
  /** 放回待排池（刪除擺放） */
  | { op: 'unplace'; id: string; version: number }
  /** 改數量（只用於 Undo 還原合併；畫面不直接提供） */
  | { op: 'setQty'; id: string; version: number; qty: number }
  /** 以原 id 重建一列（只用於 Undo 還原「放回待排池／合併」） */
  | { op: 'restore'; row: PlacementSnapshotRow }
  /**
   * D24 勾完成。伺服器同時：plan_date 若已過或為 null（待排區）→ 改為 rollTarget；
   * 有效數量被扣過（trimmed）→ qty 改為 effectiveQty；記 completed_pool_qty（§3.4）。
   */
  | { op: 'complete'; id: string; version: number }
  /** 取消完成；Undo 產生的反向操作會帶 prevPlanDate／prevQty 把勾完成時改掉的值還原 */
  | { op: 'uncomplete'; id: string; version: number; prevPlanDate?: YMD | null; prevQty?: number }

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
  | { date: YMD; headcount: number | null; regularHours: number; overtimeHoursMax: number; isSaturdayOpen: boolean; note?: string | null }
  /** 刪掉當天的列，回到沿用／預設 */
  | { date: YMD; clear: true }

export interface CapacityPutRequest {
  lockToken: string
  rows: CapacityInput[]
}

export type CapacityResponse =
  | {
      success: true
      /** 查詢區間內實際填過的列 */
      rows: DailyCapacity[]
      /** 查詢區間內每個工作日＋區間內所有週六（不論是否開加班，產能對話框要能開關）的有效產能 */
      effective: EffectiveCapacity[]
      lock?: LockState
    }
  | {
      success: false
      error: string
      code?: 'forbidden' | 'lock_required' | 'lock_lost' | 'bad_request' | 'date_not_workday' | 'saturday_has_cards' | 'db_error'
      /** saturday_has_cards：該週六還有幾張未完成的卡 */
      cardCount?: number
      date?: YMD
    }

// ─────────────────────────────────────────────────────────────────────
// 版本快照（D33，§3.9、§四.5）
// ─────────────────────────────────────────────────────────────────────

export type VersionSource = 'manual' | 'auto_before_ai' | 'auto_after_ai' | 'auto_before_restore'

export interface ScheduleSnapshot {
  schemaVersion: 1
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
