// 包裝專區 P3「AI 模擬排程」共用型別契約 —— lib/packaging/ai/*、/api/packaging/ai/**、components/packaging/ai/* 共用。
// 規格：docs/design/2026-09-28-packaging-ai.md（本檔各段落標規格章節）；需求：需求決策紀錄 D76～D97。
// 資料表：sql/20260928b_packaging_ai.sql（Snow 備份後手動套用；套用前新表不存在 → API 回 migration_required）。
//
// 慣例（同 lib/packaging/scheduleTypes.ts）：
// - 日期一律 'YYYY-MM-DD'（YMD）；時間戳一律 ISO 字串（UTC）。
// - DB 列（snake_case，*Row）只在伺服器端出現；API 與畫面一律用 camelCase 型別。db.ts 負責 Row ↔ camelCase。
// - 本檔只放型別與常數，不放邏輯；相對路徑 import、不用 enum（node --experimental-strip-types 可直接跑單元測試）。
// - 本檔會被前端 import：不得 import SDK、supabase、server-only 模組（下面只有 import type，編譯後整段消失）。
//
// ─────────────────────────────────────────────────────────────────────
// SDK 能力確認（2026-09-28，npm install @anthropic-ai/sdk → 安裝版本 0.128.0，package.json "^0.128.0"）
// 依據：node_modules/@anthropic-ai/sdk/src/resources/messages/messages.ts、resources/beta/messages/messages.ts、
//       resources/beta/beta.ts、core/error.ts、index.ts（型別定義原文，非憑記憶）。給 lib/packaging/ai/claude.ts 作者：
//
// 1. client.beta.messages.stream(body: BetaMessageStreamParams, options?: RequestOptions): BetaMessageStream
//    - BetaMessageStreamParams ＝ MessageCreateParamsBase（beta 版），以下參數型別都接受：
//      · output_config?: BetaOutputConfig ＝ { effort?: 'low'|'medium'|'high'|'xhigh'|'max'|null;
//                                             format?: { type: 'json_schema'; schema: { [key: string]: unknown } } | null;
//                                             task_budget?: … }                                            ✅ json_schema、effort
//      · thinking?: BetaThinkingConfigParam，含 BetaThinkingConfigAdaptive { type: 'adaptive'; display?; block_binding? } ✅ adaptive
//      · fallbacks?: BetaFallbacksParam | null，BetaFallbacksParam ＝ Array<BetaFallbackParam> | 'default'          ✅ 'default' 與陣列都收
//        （BetaFallbackParam ＝ { model: Model; max_tokens?; output_config?; thinking?; speed? }）
//      · betas?: Array<AnthropicBeta>；AnthropicBeta 聯集明列 'server-side-fallback-2026-07-01' 與 '-2026-06-01'（另有 string & {}）✅
//      · system?: string | Array<BetaTextBlockParam>（可帶 cache_control: { type: 'ephemeral' }）
//      · model: Model 聯集明列 'claude-opus-5'（另有 string & {}）
//    - 回傳 BetaMessageStream，await stream.finalMessage() → BetaMessage
//      （stop_reason: BetaStopReason ＝ 'end_turn'|'max_tokens'|'stop_sequence'|'tool_use'|'pause_turn'|'compaction'|'refusal'|
//       'model_context_window_exceeded'；usage 有 input_tokens／output_tokens／cache_read_input_tokens／cache_creation_input_tokens）
//    → 結論：規格 §4.2 首選寫法 betas: ['server-side-fallback-2026-07-01'] + fallbacks: 'default' 型別可直接用，不必降級。
// 2. client.messages.stream（非 beta）：output_config（effort、format json_schema）、thinking adaptive 都有；但沒有 fallbacks／betas
//    → 要拒答備援就一定走 client.beta.messages.stream。
// 3. new Anthropic({ timeout, maxRetries })：timeout 單位是「毫秒」（TypeScript SDK）；金鑰預設讀環境變數 ANTHROPIC_API_KEY。
// 4. 錯誤類別（index.ts 具名匯出，也可用 Anthropic.XxxError）：APIError（status）、AuthenticationError(401)、PermissionDeniedError(403)、
//    RateLimitError(429)、BadRequestError(400)、NotFoundError(404)、InternalServerError(5xx)、APIConnectionError、
//    APIConnectionTimeoutError（extends APIConnectionError → 分類時必須先判 Timeout 再判 Connection）、APIUserAbortError。
// 5. server-only 套件：專案「沒有」安裝（node_modules/server-only 不存在；Next 內部雖有 next/dist/compiled/server-only，
//    但不保證 Turbopack 會把裸 'server-only' 對應過去，node:test 也解析不到）。依任務指示不另外安裝 →
//    claude.ts 改用「typeof window !== 'undefined' 就丟錯」的執行期檢查，並在檔頭註解說明（金鑰只在伺服器端，D85）。
// ─────────────────────────────────────────────────────────────────────

import type {
  BoardResponse,
  DailyCapacity,
  LineCapacity,
  LineSupply,
  LockState,
  PackagingLine,
  Placement,
  PlacementOp,
  PlacementSnapshotRow,
  PlacementSource,
  ApplyErrorCode,
  YMD,
} from '../scheduleTypes'
import type { PoolResponse } from '../types'
import type { BoardBody, BoardManualInput } from '../scheduleBoard'

// ─────────────────────────────────────────────────────────────────────
// 常數（規格 §一、§三、§四、§六、§七、§九）
// ─────────────────────────────────────────────────────────────────────

/** D83：模擬範圍可選 2／4／6 個工作日（週末加班日插入但不佔名額） */
export const AI_HORIZONS = [2, 4, 6] as const
export type AiHorizon = (typeof AI_HORIZONS)[number]
/** D83：預設 4 天 */
export const AI_DEFAULT_HORIZON: AiHorizon = 4

/** D78①：copy＝複製現有排程、clear＝清空全部重排（清空＝全部可動，沒有東西可鎖） */
export const SIM_MODES = ['copy', 'clear'] as const
export type SimMode = (typeof SIM_MODES)[number]

/** 規格 §九 第 8 點：模擬起始日「今天」（今天不是工作台日期則下一個）或「下一個工作日」 */
export type SimStartOption = 'today' | 'next'

/** §三：模擬區「退回上一步」最多保留幾步 */
export const SIM_UNDO_LIMIT = 30
/** 模擬區每次手動操作最多幾個 op（同正式區 MAX_OPS_PER_REQUEST） */
export const SIM_MAX_OPS_PER_REQUEST = 50
/**
 * 模擬區 placements 大小上限（位元組，以 simState.jsonbTextBytes 估算；DB check：octet_length(placements::text) < 2,000,000）。
 * 為什麼用「位元組」而不是 JSON 字元數：DB 的 check 量的是 jsonb 轉文字後的 UTF-8 位元組——中文（aiReason、標籤）一字 3 bytes，
 *   jsonb 文字輸出又在每個 ':' 與 ',' 後面多一個空白；用字元數會低估約兩成（審查實測比例 1.2），接近上限時整份寫不進去（23514）。
 */
export const SIM_PLACEMENTS_MAX_BYTES = 1_800_000
/** undo 堆疊大小上限（位元組，同上估算；DB check：octet_length(undo::text) < 8,000,000，留約 6% 餘裕）；超過時 pushUndo 從最舊的丟 */
export const SIM_UNDO_MAX_BYTES = 7_500_000
/** 模擬區每人最多幾張模擬列（防灌表；正常數百張） */
export const SIM_MAX_PLACEMENTS = 2000
/** 操作標籤（undo 標籤、op_log label）字數上限 */
export const SIM_LABEL_MAX = 120

/** 規格 §九 第 1 點：歷史保留最近 10 次 AI 結果可切換 */
export const AI_RUN_HISTORY_LIMIT = 10
/** §4.1：running 超過 6 分鐘未結束（實例被回收）→ 視為失敗、可重跑（畫面據此解除 AI／採用／重設的封鎖） */
export const AI_RUN_STALE_MS = 6 * 60_000
/** §4.1：同一人 60 秒節流（連按兩次＝雙倍費用） */
export const AI_RUN_THROTTLE_MS = 60_000
/** §4.1：runner 內部總預算（route maxDuration = 300 秒，留 30 秒給寫回） */
export const AI_RUN_BUDGET_MS = 270_000
/** §4.1：前端輪詢間隔 */
export const AI_POLL_MS = 3_000
/** §4.3：候選超過這個數量時依（逾期 → due 升冪）取前 N 張，其餘記 notSent（不得默默截斷） */
export const AI_MAX_CANDIDATES = 400
/** §4.3：name／pack 去前綴後截取字數 */
export const AI_PAYLOAD_TEXT_MAX = 30
/** §4.2：每筆 assignment reason ≤ 20 字（prompt 要求；驗算時超過的截斷，不作廢） */
export const AI_REASON_MAX = 20
/** 摘要（代號換回後）存 DB 的字數上限（DB check ≤ 8000） */
export const AI_SUMMARY_MAX = 8000
/** run.error_message 字數上限（DB check ≤ 500） */
export const AI_ERROR_MESSAGE_MAX = 500

/** §七：規則文字字數（DB check 1～8000） */
export const AI_RULES_MAX = 8000
/** §七：規則歷史列最近 50 版 */
export const AI_RULES_HISTORY_LIMIT = 50
/** §七 / D92：門檻表 key 字數、門檻範圍（同 DB check）、備註字數、總列數上限（防灌表） */
export const AI_THRESHOLD_KEY_MAX = 30
export const AI_THRESHOLD_MIN = 1
export const AI_THRESHOLD_MAX = 1_000_000
export const AI_THRESHOLD_NOTE_MAX = 200
export const AI_THRESHOLDS_MAX_ROWS = 200

/** §6.1：採用時伺服器自組 op 的上限（不經 parseOps 的 50 筆限制） */
export const AI_ADOPT_MAX_OPS = 2000
/** §6.2：採用紀錄列表最近 20 筆 */
export const AI_ADOPTIONS_LIST_LIMIT = 20
/**
 * 退回採用的「處理中」佔位有效時間（packaging_ai_adoptions.revert_claimed_at）。退回 route maxDuration 120 秒 → 3 分鐘後
 * 視為上一個請求已中斷（實例被回收），可以重新退回；在這之內第二個退回請求一律回 revert_in_progress（避免同一筆退回寫兩次）。
 */
export const AI_REVERT_CLAIM_TTL_MS = 3 * 60_000

/** 空鎖定（D88）；建立／清空模擬區時用。唯讀：使用時請複製 */
export const EMPTY_SIM_LOCKS: Readonly<SimLocks> = Object.freeze({ placementIds: [], soNumbers: [], lineIds: [] })

// ─────────────────────────────────────────────────────────────────────
// 模擬區狀態（規格 §三）
// ─────────────────────────────────────────────────────────────────────

/** 模擬列從哪來：copy＝建立時由正式區複製、ai＝AI 排入（驗算後）、manual＝主管在模擬區手動放／挪過 */
export type SimSource = 'copy' | 'ai' | 'manual'

/**
 * 模擬區裡的一張（子）卡＝PlacementSnapshotRow（快照 v3 格式）＋模擬專用欄（§一.1）。
 * 只存「模擬範圍內（window_dates × line_ids）、未完成」的列 → planDate／lineId 必有；
 * 範圍外、已完成、待排區一律讀正式區、在模擬區唯讀（§三「組合檢視」）。
 * id：模擬列自己的 uuid（copy 來的也換新 id，原正式 id 放 livePlacementId）——模擬 id 絕不與正式 id 相同，
 *   否則組合狀態（composeSimState）裡同一個 id 會同時代表正式卡與模擬卡。
 */
export interface SimPlacement extends PlacementSnapshotRow {
  planDate: YMD
  lineId: number
  /** D69：覆寫工時（以本列 qty 為準）；null＝標準估計 */
  estMinutesOverride: number | null
  /** D74：線內順序；null＝該線最上面、依固定排序 */
  sortIndex: number | null
  /** AI 給的理由（≤ AI_REASON_MAX 字；可空字串）；非 AI 列 null */
  aiReason: string | null
  simSource: SimSource
  /** copy 來的原正式擺放 id（採用時優先與它配對 → move 保留 id）；AI／手動新放的列 null */
  livePlacementId: string | null
}

/**
 * D88 鎖定。鎖定的列原位不動、照樣佔產能、AI 看得到但不能改；鎖定訂單的剩餘量 AI 也不能新排；
 * 鎖定的線 AI 不能放新卡、也不能移出；主管在模擬區手動操作也不能動鎖定的列（回 locked）。
 */
export interface SimLocks {
  /** 模擬列 id（SimPlacement.id） */
  placementIds: string[]
  /** 整張訂單：so_line_key 的 SO 部分（最後一個 '-' 之前），一律大寫 */
  soNumbers: string[]
  /** 整條線：packaging_lines.id */
  lineIds: number[]
}

/** simState.lockReasonsOf 的輸出：這張卡為什麼被鎖（可多個） */
export type SimLockReason = 'card' | 'order' | 'line'

/** undo 一步是什麼動作造成的（畫面標籤用） */
export type SimUndoKind = 'ops' | 'ai_run' | 'reset' | 'load_run' | 'locks'

/**
 * 模擬區可被 undo 還原的狀態（整份快照＝最簡單可靠，§三「退回上一步」）。
 * 重設會換 window／horizon／mode，所以快照必須包含它們，否則退回後 placements 與範圍對不上。
 */
export interface SimSessionState {
  horizon: AiHorizon
  mode: SimMode
  windowDates: YMD[]
  lineIds: number[]
  placements: SimPlacement[]
  locks: SimLocks
}

/** undo 堆疊的一格：「做這個動作之前」的整份狀態＋標籤 */
export interface SimUndoEntry {
  label: string
  kind: SimUndoKind
  at: string
  state: SimSessionState
}

/** packaging_sim_sessions 一列（DB，snake_case；jsonb 內容仍是 camelCase） */
export interface SimSessionRow {
  id: number
  owner_email: string
  owner_name: string | null
  horizon: number
  mode: string
  window_dates: YMD[]
  line_ids: number[]
  placements: unknown
  locks: unknown
  undo: unknown
  version: number
  running_run_id: number | null
  created_at: string
  updated_at: string
}

/** 模擬區（伺服器端完整版，含 undo 堆疊；db.ts 讀出後已驗證 jsonb 形狀） */
export interface SimSession extends SimSessionState {
  id: number
  ownerEmail: string
  ownerName: string | null
  undo: SimUndoEntry[]
  version: number
  runningRunId: number | null
  createdAt: string
  updatedAt: string
}

/** db.insertSimSession 的輸入（第一次建立） */
export interface NewSimSession extends SimSessionState {
  ownerEmail: string
  ownerName: string | null
  undo: SimUndoEntry[]
}

/** db.updateSimSessionCas 的 patch（只寫有帶的欄位；version 一律 +1、updated_at＝nowIso） */
export interface SimSessionPatch extends Partial<SimSessionState> {
  ownerName?: string | null
  undo?: SimUndoEntry[]
  runningRunId?: number | null
}

/** 模擬範圍：日期 × 線（採用範圍＝windowDates × 未鎖定的線） */
export interface SimScope {
  windowDates: readonly YMD[]
  lineIds: readonly number[]
}

/** 純函式需要「誰、何時」時由呼叫端傳入（純函式不讀時鐘） */
export interface SimStamp {
  email: string
  name: string | null
  at: string
}

/** getManualMergedPool 之後的待排池（D66 手動區塊已併入） */
export type SimPool = Extract<PoolResponse, { success: true }>

/**
 * 模擬區／驗算／採用共用的「正式區世界」原料（db.ts loadSimWorld 讀好；純函式只吃它，不碰 DB）。
 * live：正式擺放＝全部未完成＋池內各行的已完成＋today 起的已完成（同 GET /api/packaging/board 的讀法；守恆檢查要看整行）。
 */
export interface SimWorld {
  today: YMD
  /** 呼叫端的「現在」（applyOps 的 nowIso、sortIndex 產生用） */
  nowIso: string
  actor: { email: string; name: string | null }
  pool: SimPool
  manual: BoardManualInput | null
  live: readonly Placement[]
  capacityRows: readonly DailyCapacity[]
  lines: readonly PackagingLine[]
  lineRows: readonly LineCapacity[]
}

/**
 * composeSimState 的輸出（§三「組合檢視」）：
 * placements ＝ live 中「不在模擬範圍內、或已完成、或待排區」的列 ∪ session.placements（轉成 Placement）。
 * 丟進既有 assembleBoard 得到與 BoardResponse 同形的工作台；丟進 applyOps 當驗證狀態。
 */
export interface ComposedSimState {
  placements: Placement[]
  /** 模擬列 id（可動；其餘都是正式區唯讀列） */
  simIds: Set<string>
  /** 被模擬列取代、所以不在 placements 內的正式列 id（範圍內未完成的 live 列） */
  hiddenLiveIds: Set<string>
}

// ─────────────────────────────────────────────────────────────────────
// 送 AI 的資料（規格 §4.3，D84 白名單）
// ─────────────────────────────────────────────────────────────────────

/** 單號前綴：SO、SOB（散單），其他一律 OTHER（不送單號本體） */
export type AiSoPrefix = 'SO' | 'SOB' | 'OTHER'
/** 來源：自製／常平／委外（PackagingCard.sourceKind） */
export type AiSource = 'inhouse' | 'changping' | 'outsource'

/** copy 模式下，這張卡目前在窗內的位置（AI 沒必要不要搬動，搬要寫理由） */
export interface AiNowSlot {
  day: number
  /** 線代碼（A／B／C…） */
  line: string
  qty: number
  /** 同日同線的順序（1 起） */
  order: number
  /** 這一段是否被鎖（鎖定的段 AI 不能動） */
  locked: boolean
}

/**
 * 一張候選卡（候選單位＝SO 行，§4.3）。**只准這些欄位**；payload.ts 必須「建新物件逐欄複製」，不得 spread 原物件。
 * 絕不送：單號本體、客戶名稱、訂單備註、常平出貨備註、單價金額、送貨地址、廠商、sources／docNo、人名。
 */
export interface AiCard {
  /** 卡代號 K001…（keyMap 換回 soLineKey） */
  k: string
  /** 客戶代號 C01…（keyMap 換回客戶名）；客戶未知 null */
  c: string | null
  pre: AiSoPrefix
  src: AiSource
  /** 品類（matchCategory 品名品類 → 途程基本工序名去「常規包裝/」前綴 → '未分類'） */
  cat: string
  /** 品名去前綴後前 30 字；8 位以上數字、email、電話樣式遮成 '#' */
  name: string
  /** 包裝方式前 30 字（同樣遮罩）；沒有則空字串 */
  pack: string
  /** 可動總量＝待排池剩餘＋範圍內「未鎖定」模擬列的量 */
  qty: number
  /** 其中已就緒（可包）的量 */
  ready: number
  /** 未就緒部分預估可包日：窗內 day 序號；窗外 'after'；未知 'unknown'；全就緒省略 */
  readyDay?: number | 'after' | 'unknown'
  /** 剩餘台灣工作天（負＝逾期）；交期未知 null */
  due: number | null
  /** 可動總量的標準工時分鐘（含覆寫比例；每段最少 10 分鐘另由 AI／驗算處理） */
  min: number
  /** 每件分鐘 */
  perUnit: number
  /** 打樣 */
  sample: boolean
  /** 是否達大量門檻（§4.4，程式先算好） */
  bulk: boolean
  /** copy 模式目前在窗內的位置；沒有省略 */
  now?: AiNowSlot[]
  /** 被鎖住不能動的量（鎖定列）；0 省略 */
  lockedQty?: number
}

/** 窗內一天 */
export interface AiWindowDay {
  /** 1 起的序號（AI 只能用這個，不用日期字串） */
  day: number
  date: YMD
  /** 0＝週日 … 6＝週六 */
  weekday: number
  /** 已開加班的週六／週日（只有加班額度） */
  weekend: boolean
}

/** 一條線一天的產能（分鐘） */
export interface AiLineDay {
  day: number
  /** 正常工時（週末 0；未設定 0 並 stopped） */
  regularMin: number
  /** 加班上限 */
  overtimeMin: number
  /** 已被固定佔用：已完成＋鎖定＋範圍外無關者（延誤卡順延到今天等）在當天該線的工時 */
  fixedMin: number
  /** 停線（該線當天明確填 0／0 或未設定） */
  stopped: boolean
}

export interface AiLine {
  /** 線代碼 A／B／C… */
  code: string
  name: string
  /** 整條線被鎖：AI 不能放新卡、也不能移出 */
  locked: boolean
  days: AiLineDay[]
}

/** 工時未知的卡（不送為候選，§九 第 7 點）：只給張數與品類，不給明細 */
export interface AiUnknownMinutes {
  count: number
  categories: { cat: string; count: number }[]
}

/** 送出的 payload 本體（存進 packaging_ai_runs.payload；已去識別化） */
export interface AiPayload {
  today: YMD
  mode: SimMode
  horizon: AiHorizon
  window: AiWindowDay[]
  lines: AiLine[]
  cards: AiCard[]
  /** 門檻表（key、threshold；不含備註與人名） */
  thresholds: { key: string; threshold: number }[]
  /** 主管規則文字全文（D91 最新版） */
  rules: string
  unknownMinutes: AiUnknownMinutes
}

/** 代號對照（只在記憶體，絕不存 DB、不 log） */
export interface AiKeyMap {
  /** K001 → soLineKey */
  cardToLine: Map<string, string>
  /** soLineKey → K001 */
  lineToCard: Map<string, string>
  /** C01 → 客戶名稱 */
  customerByCode: Map<string, string>
}

/** buildAiPayload 的附帶資訊（進 ValidationReport 與摘要） */
export interface AiPayloadMeta {
  /** 符合候選條件的 SO 行數 */
  candidateCount: number
  /** 實際送出的卡數（≤ AI_MAX_CANDIDATES） */
  sentCount: number
  /** 超過上限沒送的張數與 SO 行鍵（§4.3：不得默默截斷） */
  notSent: number
  notSentKeys: string[]
  unknownMinutes: AiUnknownMinutes
  /** 沒有門檻的品類（§4.4：不判大量，摘要提醒主管補） */
  noThresholdCategories: string[]
}

/** payload.ts buildAiPayload 的輸入 */
export interface AiPayloadInput {
  today: YMD
  session: Pick<SimSession, 'mode' | 'horizon' | 'windowDates' | 'lineIds' | 'locks' | 'placements'>
  /** assembleSimBoard(world, session) 的結果（各線 used／remaining、剩餘待排池） */
  board: BoardBody
  /** getManualMergedPool 後的原始待排池（候選的供給分段、品名、交期…） */
  pool: SimPool
  lines: readonly PackagingLine[]
  /** 規則文字（最新版全文） */
  rules: string
  thresholds: readonly BulkThreshold[]
}

export interface AiPayloadBuild {
  payload: AiPayload
  keyMap: AiKeyMap
  meta: AiPayloadMeta
}

/** buildBulkFlag 的輸出（§4.4） */
export interface BulkDecision {
  bulk: boolean
  /** 採用的門檻 key（品類完全相同 → 品名包含最長 key）；沒有 null */
  thresholdKey: string | null
  threshold: number | null
}

// ─────────────────────────────────────────────────────────────────────
// AI 輸出（規格 §4.6；schema.ts AI_OUTPUT_SCHEMA 與此一一對應）
// ─────────────────────────────────────────────────────────────────────

export interface AiAssignment {
  k: string
  day: number
  line: string
  qty: number
  /** 同日同線的順序（1 起，小的在上） */
  order: number
  /** ≤ 20 字；理所當然的可空字串 */
  reason: string
}

export interface AiOutput {
  /** 給主管看的 3～8 句（卡片／客戶是代號，存 DB 前由程式換回） */
  summary: string
  assignments: AiAssignment[]
  unplaced: { k: string; reason: string }[]
  /** D94：加班建議（只顯示，不自動改產能表） */
  overtime: { day: number; line: string; hours: number; reason: string }[]
  /** 與卡無關時 k = '' */
  warnings: { k: string; message: string }[]
  /** D80：覺得規則該改時提出，不自己改 */
  ruleSuggestions: string[]
}

export type ParseAiOutputResult = { ok: true; output: AiOutput } | { ok: false; message: string }

/** 回應 usage（存 packaging_ai_runs.usage） */
export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/** callClaude 的回傳 */
export interface ClaudeCallResult {
  output: AiOutput
  usage: AiUsage
  /** 實際回應的 model（拒答備援時可能不是 claude-opus-5） */
  model: string
  /** 結構化輸出原文（text block；不得 console.log） */
  rawText: string
}

// ─────────────────────────────────────────────────────────────────────
// 驗算與修正（規格 §五，validate.ts）
// ─────────────────────────────────────────────────────────────────────

/** 驗算時「丟棄／修正」的原因 */
export type ValidationIssueCode =
  | 'unknown_card'       // k 對不回（不是本次送出的卡）
  | 'day_out_of_window'  // day 不在窗內
  | 'line_invalid'       // line 不是啟用中的模擬線
  | 'line_locked'        // 線被鎖
  | 'order_locked'       // 所屬訂單被鎖
  | 'qty_invalid'        // qty ≤ 0 或不是數字
  | 'not_placeable'      // 該 SO 行已無可排區塊（isPlaceableBlock）
  | 'duplicate'          // 同一天同一線同一 k 給了多筆（只取第一筆）
  | 'qty_clamped'        // 守恆不足 → 夾到剩餘可動量（adjusted）
  | 'moved_to_ready_day' // D22 預排太早 → 移到預估可包日（adjusted）
  | 'before_est_ready'   // D22 太早且預估可包日不在窗內 → 丟棄
  | 'apply_failed'       // applyOps 其他錯誤（附 applyCode）

export interface ValidationAdjust {
  code: Extract<ValidationIssueCode, 'qty_clamped' | 'moved_to_ready_day'>
  k: string
  soLineKey: string
  /** AI 原本給的 */
  from: { day: number; date: YMD; line: string; qty: number }
  /** 修正後實際寫入的 */
  to: { day: number; date: YMD; line: string; qty: number }
  message: string
}

export interface ValidationDrop {
  code: Exclude<ValidationIssueCode, 'qty_clamped' | 'moved_to_ready_day'>
  k: string
  /** k 對不回時 null */
  soLineKey: string | null
  day: number
  line: string
  qty: number
  /** apply_failed 時 applyOps 的錯誤碼 */
  applyCode?: ApplyErrorCode
  message: string
}

/** §五 步驟 4：超過 regular + overtime（紅）而被削減的量（回待排池） */
export interface CapacityTrim {
  day: number
  date: YMD
  line: string
  soLineKey: string
  qty: number
  minutes: number
}

/** §五 步驟 4：介於 regular 與 regular + overtime（橘）→ 允許，但列出供摘要（D94） */
export interface OvertimeUse {
  day: number
  date: YMD
  line: string
  minutes: number
}

/**
 * 驗算報告（存 packaging_ai_runs.validation；UI「系統修正」段）。
 * AI 的 unplaced／warnings／overtime 已由程式把 K／C 代號換回（aiUnplaced 等），畫面直接顯示。
 */
export interface ValidationReport {
  /** 結果是否已寫回模擬區（AI 執行期間模擬區被改過 → false，結果只存在 run 裡，可從歷史載入） */
  applied: boolean
  /** AI assignments 原樣接受的筆數 */
  accepted: number
  adjusted: ValidationAdjust[]
  dropped: ValidationDrop[]
  capacityTrimmed: CapacityTrim[]
  overtimeUsed: OvertimeUse[]
  unknownMinutes: AiUnknownMinutes
  noThresholdCategories: string[]
  /** 超過 AI_MAX_CANDIDATES 沒送的張數 */
  notSent: number
  /** copy 模式沿用原模擬列的筆數（同 SO 行、同日、同線） */
  keptCopy: number
  /** 鎖定而原樣保留的模擬列數 */
  lockedKept: number
  /** 結果模擬列總數 */
  resultCount: number
  aiUnplaced: { soLineKey: string | null; reason: string }[]
  aiWarnings: { soLineKey: string | null; message: string }[]
  aiOvertime: { day: number; date: YMD | null; line: string; hours: number; reason: string }[]
  ruleSuggestions: string[]
}

/** validate.ts validateAiResult 的輸入（全部由呼叫端準備；純函式不讀時鐘、不碰 DB） */
export interface ValidateAiInput {
  world: SimWorld
  session: Pick<SimSession, 'mode' | 'horizon' | 'windowDates' | 'lineIds' | 'locks' | 'placements' | 'ownerEmail' | 'ownerName' | 'updatedAt'>
  keyMap: AiKeyMap
  meta: AiPayloadMeta
  output: AiOutput
  /** 產生新模擬列 id（伺服器傳 crypto.randomUUID；測試傳固定序列） */
  newId: () => string
}

export interface ValidateAiResult {
  /** 新的 session.placements（鎖定列原樣＋AI 驗算後的列） */
  placements: SimPlacement[]
  /** applied 先填 true；runner 寫回失敗（version 不符）時改 false 再存 */
  report: ValidationReport
}

// ─────────────────────────────────────────────────────────────────────
// 模擬區手動操作（規格 §三，simState.applySimOps）
// ─────────────────────────────────────────────────────────────────────

export interface ApplySimOpsInput {
  world: SimWorld
  session: Pick<SimSession, 'windowDates' | 'lineIds' | 'locks' | 'placements' | 'ownerEmail' | 'ownerName' | 'updatedAt'>
  ops: readonly PlacementOp[]
}

/** 模擬區操作專屬的錯誤碼（其餘沿用 applyOps 的 ApplyErrorCode） */
export type SimOpsErrorCode = 'locked' | 'out_of_window' | 'not_sim_row' | 'op_not_allowed'

export type ApplySimOpsResult =
  | {
      ok: true
      /** 寫回 session.placements 的新整份模擬列 */
      placements: SimPlacement[]
      /** 本次新建／改到的模擬列 id（前端可據以高亮） */
      changedIds: string[]
    }
  | { ok: false; code: SimOpsErrorCode | ApplyErrorCode; opIndex: number; message: string }

// ─────────────────────────────────────────────────────────────────────
// 採用與退回（規格 §六，adopt.ts）
// ─────────────────────────────────────────────────────────────────────

/**
 * 採用／退回的「目標」一列（planAdoption 讓正式區範圍內變成這樣）。
 * 採用：由 session.placements（未鎖定線）轉來；退回：由 auto_before_ai 快照中落在同一範圍的列轉來。
 */
export interface AdoptionTargetRow {
  soLineKey: string
  qty: number
  planDate: YMD
  lineId: number
  sortIndex: number | null
  estMinutesOverride: number | null
  /** 新建列用的 source：simSource 'ai'→'ai'、'manual'→'manual'、'copy'→沿用原正式列 source（查不到 'manual'）；退回＝快照值 */
  source: PlacementSource
  /** 優先配對的正式列 id：採用＝livePlacementId、退回＝快照列 id（快照保留原 id；採用時配到的列用 move 保留 id） */
  pairId: string | null
  originCardId: string | null
}

/** planAdoption 需要的待排池資訊（事先檢查 restore 不檢查的「不可排區塊」與 D22；純函式不碰 DB） */
export interface AdoptionEnv {
  today: YMD
  openWeekends: ReadonlySet<YMD>
  supplyOf(soLineKey: string): LineSupply | null
  newId: () => string
  /**
   * 線是否啟用中（沒給＝不檢查）。新建列用 restore，而既有 applyOps 的 restore 允許停用線（為了 Undo 還原到原線）→
   * 模擬區建立後才停用的線，AI 的新卡會被寫進停用線、繞過「停用線不能有未完成已排卡」的規則；planAdoption 據此事先略過。
   */
  isLineActive?: (lineId: number) => boolean
}

export interface AdoptionCounts {
  /** 配到既有列、換日／換線（move） */
  moved: number
  /** 新建（restore） */
  added: number
  /** 移回待排池（unplace） */
  returned: number
  /** 數量調整（setQty 等） */
  qtyChanged: number
  /** 只改線內順序（reorder） */
  reordered: number
  /** 同步覆寫工時（setMinutes） */
  minutesChanged: number
  /** 完全相同、不用動 */
  unchanged: number
  skipped: number
}

/** 採用／退回時略過的一項（D86 系統事實：已完成、已銷貨、已不在待排池、版本已變…） */
export interface AdoptionSkip {
  soLineKey: string
  placementId: string | null
  code: ApplyErrorCode | 'no_supply'
  message: string
}

export interface AdoptionPlan {
  ops: PlacementOp[]
  skipped: AdoptionSkip[]
  counts: AdoptionCounts
}

/**
 * 採用範圍外（鎖定的線；退回時＝該次採用範圍以外的線）與正式排程不一致、會讓採用／退回結果和畫面不同的一項。
 * 採用只覆蓋未鎖定的線：鎖定線上的模擬內容若和正式區不同（先在模擬區換線再鎖、清空後鎖線…），
 *   同一品項一半照模擬版、一半照正式區，會造成卡片消失或重複排（審查驗證 r1）→ 有這種項目就不寫入（409 locked_line_diverged）。
 */
export interface LockedLineConflict {
  soLineKey: string
  /** 正式區列 id（模擬區多出來的列 null） */
  placementId: string | null
  lineId: number | null
  planDate: YMD | null
  /** 繁中說明（例：「C 線 10/1：模擬區 100 件、正式排程沒有」） */
  message: string
}

/** applyOpsLenient 的一筆失敗 */
export interface LenientSkip {
  opIndex: number
  op: PlacementOp
  code: ApplyErrorCode
  message: string
}

// ─────────────────────────────────────────────────────────────────────
// AI 執行 LOG（規格 §一.2、§四）
// ─────────────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'done' | 'failed'
export type RunPhase = 'preparing' | 'thinking' | 'validating' | 'done' | 'failed'

/**
 * AI 執行失敗的錯誤碼（存 packaging_ai_runs.error_code；訊息一律繁中、給主管看得懂，D95）。
 * claude.ts 的 AiError.code 只會是前 9 個；後面是 runner／route 用的。
 */
export type AiErrorCode =
  | 'ai_not_configured'  // 未設定 ANTHROPIC_API_KEY（D95）
  | 'ai_auth'            // 金鑰無效／沒有權限（401／403）
  | 'ai_rate_limited'    // 429：AI 用量達上限或太頻繁
  | 'ai_timeout'         // 逾時（SDK timeout 或內部 270 秒預算用完）
  | 'ai_network'         // 連線失敗
  | 'ai_api'             // 其他 API 錯誤（含 529 overloaded、額度不足），訊息帶 status
  | 'ai_refused'         // stop_reason = 'refusal'
  | 'ai_truncated'       // stop_reason = 'max_tokens'
  | 'ai_bad_output'      // 沒有 text block／JSON 壞掉／結構不符
  | 'ai_stale'           // 執行超過 6 分鐘未結束（實例被回收），下一次按 AI 時標記
  | 'ai_pii_blocked'     // 送出前檢查（payload.scanPayloadLeaks）發現疑似個資 → 不送出、payload 不存（fail-closed，D84）
  | 'pool_unavailable'   // 待排池組裝失敗
  | 'session_gone'       // 模擬區不存在（被刪除）
  | 'internal'           // 準備資料／驗算／寫回時的程式或資料庫錯誤（只記類別，不記內容）

/** packaging_ai_runs 一列（DB） */
export interface AiRunRow {
  id: number
  session_id: number
  owner_email: string
  owner_name: string | null
  status: string
  phase: string
  error_code: string | null
  error_message: string | null
  horizon: number
  mode: string
  window_dates: YMD[]
  locks: unknown
  base_version: number
  rules_id: number | null
  thresholds: unknown
  payload: unknown
  base_placements: unknown
  result_placements: unknown
  ai_output: unknown
  validation: unknown
  summary: string | null
  model: string | null
  usage: unknown
  duration_ms: number | null
  started_at: string
  finished_at: string | null
}

/** 列表用（不含 payload／擺放／AI 原文，GET runs 回這個） */
export interface AiRunMeta {
  id: number
  sessionId: number
  ownerEmail: string
  ownerName: string | null
  status: RunStatus
  phase: RunPhase
  errorCode: AiErrorCode | null
  errorMessage: string | null
  horizon: AiHorizon
  mode: SimMode
  windowDates: YMD[]
  rulesId: number | null
  /** 摘要（代號已換回） */
  summary: string | null
  model: string | null
  usage: AiUsage | null
  durationMs: number | null
  startedAt: string
  finishedAt: string | null
  /** 結果是否已寫回模擬區（validation.applied；未完成或失敗 null） */
  applied: boolean | null
  /** 結果模擬列數（validation.resultCount；沒有 null） */
  resultCount: number | null
}

/** 伺服器端完整版（db.getRun） */
export interface AiRun extends AiRunMeta {
  locks: SimLocks
  baseVersion: number
  thresholds: BulkThreshold[]
  payload: AiPayload | null
  basePlacements: SimPlacement[]
  resultPlacements: SimPlacement[] | null
  aiOutput: AiOutput | null
  validation: ValidationReport | null
}

/** 輪詢／詳情用（不含 payload、擺放本體、AI 原文；db.getAiRunSummary） */
export type AiRunSummary = Omit<AiRun, 'payload' | 'basePlacements' | 'resultPlacements' | 'aiOutput'>

/** 新建 run（POST session/run） */
export interface NewAiRun {
  sessionId: number
  ownerEmail: string
  ownerName: string | null
  horizon: AiHorizon
  mode: SimMode
  windowDates: YMD[]
  locks: SimLocks
  baseVersion: number
  basePlacements: SimPlacement[]
}

/** runner 分階段更新 run 列（只寫有帶的欄位） */
export interface AiRunPatch {
  status?: RunStatus
  phase?: RunPhase
  errorCode?: AiErrorCode | null
  errorMessage?: string | null
  rulesId?: number | null
  thresholds?: BulkThreshold[]
  payload?: AiPayload | null
  resultPlacements?: SimPlacement[] | null
  aiOutput?: AiOutput | null
  validation?: ValidationReport | null
  summary?: string | null
  model?: string | null
  usage?: AiUsage | null
  durationMs?: number | null
  /** status 變成 done／failed 時必帶（DB check：running ⇔ finished_at null） */
  finishedAt?: string | null
}

// ─────────────────────────────────────────────────────────────────────
// 採用紀錄（規格 §一.3、§六）
// ─────────────────────────────────────────────────────────────────────

/** packaging_ai_adoptions 一列（DB） */
export interface AdoptionRow {
  id: number
  session_id: number
  run_id: number | null
  version_id: number
  window_dates: YMD[]
  line_ids: number[]
  inverse: unknown
  touched: unknown
  counts: unknown
  skipped: unknown
  actor_email: string
  actor_name: string | null
  created_at: string
  reverted_at: string | null
  reverted_by: string | null
  reverted_by_name: string | null
  revert_report: unknown
  /** 退回處理中的佔位（CAS；AI_REVERT_CLAIM_TTL_MS 後失效）。舊版 migration 沒有這兩欄 → undefined */
  revert_claimed_at?: string | null
  revert_claimed_by?: string | null
}

/** 採用後每張被寫的卡（之後 version 變了＝採用後又被改過） */
export interface TouchedPlacement {
  id: string
  version: number
}

/** 列表用（不含 inverse／touched） */
export interface AdoptionMeta {
  id: number
  sessionId: number
  runId: number | null
  versionId: number
  windowDates: YMD[]
  lineIds: number[]
  counts: AdoptionCounts
  skippedCount: number
  actorEmail: string
  actorName: string | null
  createdAt: string
  revertedAt: string | null
  revertedByName: string | null
  /** 是否為「最近一筆未退回」（只有它能退回；route 算好） */
  canRevert: boolean
}

/** 伺服器端完整版 */
export interface AiAdoption extends Omit<AdoptionMeta, 'canRevert' | 'skippedCount'> {
  inverse: PlacementOp[]
  touched: TouchedPlacement[]
  skipped: AdoptionSkip[]
  revertedBy: string | null
  revertReport: RevertReport | null
}

export interface NewAdoption {
  sessionId: number
  runId: number | null
  versionId: number
  windowDates: YMD[]
  lineIds: number[]
  inverse: PlacementOp[]
  touched: TouchedPlacement[]
  counts: AdoptionCounts
  skipped: AdoptionSkip[]
  actorEmail: string
  actorName: string | null
}

/** 退回預覽／結果中列出的一張卡 */
export interface RevertCard {
  placementId: string
  soLineKey: string
  planDate: YMD | null
  lineId: number | null
  qty: number
}

/** 退回結果（存 packaging_ai_adoptions.revert_report） */
export interface RevertReport {
  counts: AdoptionCounts
  skipped: AdoptionSkip[]
  /** 退回前自動存的版本（source = auto_before_restore） */
  backupVersionId: number
  /** 採用後又被改過、這次一併倒回的張數 */
  changedAfterCount: number
  /** 採用後才新增在範圍內、這次移回待排池的張數 */
  addedAfterCount: number
}

// ─────────────────────────────────────────────────────────────────────
// 規則區與門檻表（規格 §七，D91／D92）
// ─────────────────────────────────────────────────────────────────────

/** packaging_ai_rules 一列（DB） */
export interface AiRulesRow {
  id: number
  body: string
  created_by: string
  created_by_name: string | null
  created_at: string
}

export interface AiRulesVersion {
  id: number
  body: string
  by: string
  byName: string | null
  at: string
}

/** 歷史列表（不含全文） */
export interface AiRulesMeta {
  id: number
  byName: string | null
  at: string
  length: number
}

/** packaging_bulk_thresholds 一列（DB） */
export interface BulkThresholdRow {
  key: string
  threshold: number
  note: string | null
  updated_by: string
  updated_by_name: string | null
  updated_at: string
}

export interface BulkThreshold {
  key: string
  threshold: number
  note: string | null
  updatedByName: string | null
  updatedAt: string
}

/** PUT thresholds 的一列輸入（整表替換） */
export interface BulkThresholdInput {
  key: string
  threshold: number
  note?: string | null
}

/** op_log 的 AI kind（sql/20260928b 第 6 段放寬；scheduleDb.OpLogKind 不動，db.ts insertAiOpLog 包一層） */
export type AiOpLogKind = 'ai_sim' | 'ai_run' | 'ai_adopt' | 'ai_revert' | 'ai_rules' | 'ai_threshold'

// ─────────────────────────────────────────────────────────────────────
// API 錯誤碼與共用回應（規格 §二～§七）
// ─────────────────────────────────────────────────────────────────────

/**
 * /api/packaging/ai/** 的錯誤碼。ApplyErrorCode 併入（模擬區操作與採用走 applyOps，錯誤碼沿用）。
 * 前端：version_conflict → 重新載入模擬區；lock_required／lock_lost → 引導取得／接手編輯鎖（採用／退回）。
 */
export type AiApiErrorCode =
  | ApplyErrorCode
  | SimOpsErrorCode
  | 'not_owner'            // 只有本人能改自己的模擬區（別人的可唯讀檢視）
  | 'no_session'           // 還沒建立模擬區
  | 'session_exists'       // POST session 沒帶 version，但已有模擬區（重設要帶 version）
  | 'session_stale'        // 起始日已過（window_dates[0] < today）：AI 排程與採用前要先重設
  | 'window_mismatch'      // load-run：該次執行的範圍與目前模擬區不同
  | 'run_in_progress'      // 已有執行中的 AI
  | 'run_not_ready'        // load-run：該次執行未完成或失敗
  | 'throttled'            // 60 秒節流
  | 'ai_not_configured'    // 未設定 ANTHROPIC_API_KEY（D95），不建 run
  | 'rules_conflict'       // baseId 不是最新（有人剛改過規則）
  | 'not_latest_adoption'  // 只允許退回最近一筆未退回的採用
  | 'already_reverted'
  | 'version_expired'      // 採用前版本已超過 90 天被清除，無法範圍內退回
  | 'nothing_to_adopt'     // 範圍內沒有差異
  | 'locked_line_diverged' // 鎖定的線（退回：採用範圍外的線）上的內容與正式排程不一致，採用／退回會造成卡片消失或重複 → 不寫入
  | 'revert_in_progress'   // 這筆採用正在被另一個請求退回（佔位中）
  | 'migration_required'   // sql/20260928b_packaging_ai.sql 尚未套用

export interface AiFail {
  success: false
  error: string
  code: AiApiErrorCode
  /** 第幾個 op 失敗（模擬區操作） */
  opIndex?: number
  /** 採用／退回：正式區編輯鎖狀態 */
  lock?: LockState
  /** 採用／退回：多列寫入中途失敗、前面已寫入（無交易）；前端提示「從版本 #versionId 還原」 */
  partial?: boolean
  versionId?: number | null
  /** 採用／退回被 locked_line_diverged 擋下時：不一致的項目 */
  conflicts?: LockedLineConflict[]
}

// ── GET /api/packaging/ai/session?owner=<email> 與所有模擬區寫入的回應 ──

/** 模擬區（API 版：不含 undo 快照本體，只給標籤） */
export interface SimSessionInfo {
  id: number
  ownerEmail: string
  ownerName: string | null
  horizon: AiHorizon
  mode: SimMode
  windowDates: YMD[]
  lineIds: number[]
  locks: SimLocks
  version: number
  runningRunId: number | null
  /** 舊 → 新（最後一格＝按「退回上一步」會回到的狀態） */
  undo: { label: string; kind: SimUndoKind; at: string }[]
  placementCount: number
  createdAt: string
  updatedAt: string
  /** 起始日已過（window_dates[0] < today）：AI 排程與採用要先重設 */
  stale: boolean
}

/** 組合工作台上一張「模擬列」的附加資訊（不在 simCards 裡的卡＝正式區唯讀列） */
export interface SimCardMeta {
  simSource: SimSource
  aiReason: string | null
  livePlacementId: string | null
  /** 空陣列＝沒鎖 */
  lockedBy: SimLockReason[]
}

export interface AiRunStatusInfo {
  id: number
  status: RunStatus
  phase: RunPhase
  startedAt: string
  /** 伺服器算的經過毫秒（前端進度條用） */
  elapsedMs: number
  /**
   * 仍是 running 但已超過 AI_RUN_STALE_MS（伺服器算）：背景執行多半已中斷（實例被回收、函式逾時被砍、寫失敗狀態時 DB 也失敗）。
   * 畫面不再把它當「執行中」：解除 AI 排程／採用／重設的封鎖、停止輪詢，提示「可能已中斷，可重新執行」
   * （POST session/run 會把它標成 ai_stale 再接手執行位）。
   */
  stale: boolean
}

/** 其他被授權人的模擬區（唯讀檢視切換用） */
export interface SimOwnerSummary {
  email: string
  name: string | null
  horizon: AiHorizon
  mode: SimMode
  windowDates: YMD[]
  updatedAt: string
}

export interface SimView {
  serverTime: string
  today: YMD
  me: { email: string; name: string | null }
  /** 正在看誰的模擬區（預設自己） */
  owner: { email: string; name: string | null }
  isOwner: boolean
  /** 還沒建立模擬區時 null（畫面顯示「建立模擬區」） */
  session: SimSessionInfo | null
  /**
   * 組合狀態的工作台（assembleSimBoard；BoardResponse 同形，前端重用 DayLanesView／MultiDayView／PoolSidebar）。
   * session 為 null 時 null。window ＝ session.windowDates。
   */
  board: BoardBody | null
  /** placementId → 模擬列資訊 */
  simCards: Record<string, SimCardMeta>
  /** 執行中的 AI（沒有 null） */
  runningRun: AiRunStatusInfo | null
  /** 最近一次 AI 執行（含失敗；沒有 null） */
  latestRun: AiRunMeta | null
  /** 有模擬區的被授權人（含自己），供切換唯讀檢視 */
  owners: SimOwnerSummary[]
}

export type SimViewResponse = ({ success: true } & SimView) | AiFail

/** POST /api/packaging/ai/session：建立或重設（重設會先把舊狀態推進 undo） */
export interface SimCreateRequest {
  horizon: AiHorizon
  mode: SimMode
  start: SimStartOption
  /** 已有模擬區時必帶（重設＝CAS）；第一次建立省略或 null */
  version?: number | null
}

/** POST /api/packaging/ai/session/ops：模擬區手動操作（D77） */
export interface SimOpsRequest {
  version: number
  /** 1..SIM_MAX_OPS_PER_REQUEST；只允許 place／move／split／merge／unplace／reorder／setMinutes */
  ops: PlacementOp[]
  label?: string
}

/** POST /api/packaging/ai/session/locks：整份替換鎖定（D88）；推 undo（kind 'locks'） */
export interface SimLocksRequest {
  version: number
  locks: SimLocks
}

/** POST /api/packaging/ai/session/undo */
export interface SimUndoRequest {
  version: number
}

/** POST /api/packaging/ai/session/run（route：maxDuration 300、runtime nodejs、dynamic force-dynamic） */
export interface SimRunRequest {
  version: number
}

export type SimRunResponse = { success: true; runId: number } | AiFail

/** POST /api/packaging/ai/session/load-run：把某次結果（result）或 AI 前狀態（base）載入模擬區（先推 undo） */
export interface SimLoadRunRequest {
  version: number
  runId: number
  which: 'result' | 'base'
}

// ── 採用（§6.1） ──

/** GET /api/packaging/ai/session/adopt：採用預覽（不寫入、不需鎖；AdoptDialog 顯示張數） */
export type AdoptPreviewResponse =
  | {
      success: true
      scope: { windowDates: YMD[]; lineIds: number[]; lockedLineIds: number[] }
      counts: AdoptionCounts
      skipped: AdoptionSkip[]
      /** 採用前會自動存的版本標籤（例：「採用 AI 模擬前（#12）」） */
      versionLabel: string
      /** 鎖定線上與正式排程不一致、會讓採用結果和模擬區不同的項目；非空時 POST 會回 locked_line_diverged（畫面停用採用鈕） */
      lockedConflicts: LockedLineConflict[]
    }
  | AiFail

/** POST /api/packaging/ai/session/adopt（route maxDuration 120） */
export interface AdoptRequest {
  lockToken: string
  version: number
}

export type AdoptResponse =
  | {
      success: true
      adoptionId: number
      counts: AdoptionCounts
      skipped: AdoptionSkip[]
      /** 採用前自動存的版本（auto_before_ai） */
      versionId: number
      lock: LockState
    }
  | AiFail

// ── AI 執行 LOG（§4.1、預設第 1 點） ──

/** GET /api/packaging/ai/runs?owner=<email>：最近 AI_RUN_HISTORY_LIMIT 次 */
export type AiRunsListResponse = { success: true; runs: AiRunMeta[] } | AiFail

/** GET /api/packaging/ai/runs/[id]：輪詢與詳情（不含 payload、擺放本體） */
export interface AiRunDetail extends AiRunMeta {
  /** 伺服器算的經過毫秒（running 時＝now − startedAt；結束＝durationMs） */
  elapsedMs: number
  /** running 且超過 AI_RUN_STALE_MS（見 AiRunStatusInfo.stale） */
  stale: boolean
  locks: SimLocks
  thresholds: BulkThreshold[]
  validation: ValidationReport | null
  /** 能否載入目前模擬區（done 且 horizon／windowDates 與目前模擬區相同） */
  canLoad: boolean
}

export type AiRunDetailResponse = { success: true; run: AiRunDetail } | AiFail

// ── 採用紀錄與退回（§6.2） ──

/** GET /api/packaging/ai/adoptions：最近 AI_ADOPTIONS_LIST_LIMIT 筆 */
export type AdoptionsListResponse = { success: true; adoptions: AdoptionMeta[] } | AiFail

/** GET /api/packaging/ai/adoptions/[id]/revert：退回預覽（不寫入、不需鎖） */
export type RevertPreviewResponse =
  | {
      success: true
      adoption: AdoptionMeta
      counts: AdoptionCounts
      /** 採用後又被改過的卡（live {id,version} 與 touched 不同）→「這些採用後的調整也會被倒回」 */
      changedAfter: RevertCard[]
      /** 採用後才新增在範圍內的卡 → 會移回待排池 */
      addedAfter: RevertCard[]
      /** 因已完成／已銷貨／已不在池內而無法還原的 */
      unrestorable: AdoptionSkip[]
      /**
       * 採用範圍外的線上、採用後又有變動、且同一品項在範圍內也要還原的項目（跨範圍搬過卡）：只倒回範圍內會造成卡片消失或重複
       * → 非空時 canRevert false、POST 回 locked_line_diverged
       */
      outsideConflicts: LockedLineConflict[]
      canRevert: boolean
      /** 不能退回的原因（canRevert false 時） */
      reason: string | null
    }
  | AiFail

/** POST /api/packaging/ai/adoptions/[id]/revert */
export interface RevertRequest {
  lockToken: string
}

export type RevertResponse = { success: true; report: RevertReport; lock: LockState } | AiFail

// ── 規則區（§七） ──

/** GET /api/packaging/ai/rules（無 id）→ 目前規則＋最近 50 版；GET ?id= → 某版全文 */
export type AiRulesResponse =
  | { success: true; current: AiRulesVersion | null; history: AiRulesMeta[] }
  | AiFail
export type AiRulesVersionResponse = { success: true; version: AiRulesVersion } | AiFail

/** POST /api/packaging/ai/rules：新增一版；baseId ≠ 最新 → 409 rules_conflict（不需編輯鎖） */
export interface AiRulesSaveRequest {
  body: string
  /** 編輯時看到的版本 id；目前沒有任何規則時 null */
  baseId: number | null
}

export type AiRulesSaveResponse = { success: true; current: AiRulesVersion } | AiFail

// ── 門檻表（§七） ──

/** GET /api/packaging/ai/thresholds、PUT 的回應 */
export type ThresholdsResponse = { success: true; rows: BulkThreshold[] } | AiFail

/** PUT /api/packaging/ai/thresholds：整表替換（新增／修改／刪除一次送；不需編輯鎖） */
export interface ThresholdsPutRequest {
  rows: BulkThresholdInput[]
}

/** 型別再匯出：畫面元件只 import 本檔即可 */
export type { BoardBody, BoardManualInput, BoardResponse }
