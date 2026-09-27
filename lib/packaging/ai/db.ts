// 包裝專區 P3 AI 模擬排程 — 新表的讀寫（I/O 層，規格 §一、§三、§四、§六、§七）
//
// ⚠ 硬限制（規格 §〇）：本檔只讀寫 sql/20260928b_packaging_ai.sql 的 5 張新表（＋透過既有 insertOpLog 寫 packaging_op_log）。
//   ** 模擬卡絕不寫進 packaging_placements **；正式區的採用／退回寫入一律走既有 applyOps → writeApplied（scheduleDb.ts）。
//   所有規則判斷在純函式（simState／payload／validate／adopt），這裡只負責「照結果寫進去」＋jsonb 形狀防呆。
//
// 慣例比照 lib/packaging/scheduleDb.ts：
//   - client 由呼叫端 getSupabaseAdminClient() 取得後傳入（service role；新表 RLS 只給 service_role）。
//   - 讀寫失敗丟 ScheduleDbError（完整錯誤只進伺服器 log，回給前端用 publicAiDbError → 只有固定中文＋錯誤碼）。
//   - 模擬區一律 version CAS：update … where id = ? and version = 舊值（單一 UPDATE 敘述即原子），筆數 0＝被別人改過。
//   - 沒有交易（PostgREST 一個請求一個敘述）：多步驟寫入的順序由呼叫端依規格安排（例：先建 run 列、再佔用執行位）。
// 新表不存在（migration 未套用）→ isAiMissingSchema(e) 為 true，route 回 409 migration_required ＋ aiMigrationMessage()。
//
// ⚠ 不得 console.log payload、客戶對照、AI 輸出（Vercel log 會留存，規格 §4.1）。本檔的錯誤 log 只有 describeError（PostgREST 錯誤），
//   而寫入 jsonb 的 check 失敗訊息可能帶列內容 → 一律包成 ScheduleDbError 丟給呼叫端，由呼叫端決定只 log 錯誤碼。

import { describeError } from '@/lib/supabaseAdmin'
import {
  ScheduleDbError,
  chunks,
  insertOpLog,
  isMissingSchema,
  loadCapacityRows,
  loadCompletedSince,
  loadLineCapacityRows,
  loadLines,
  loadOpenPlacements,
  loadPlacementsByLines,
  publicDbError,
  type OpLogKind,
  type SupabaseAdmin,
} from '@/lib/packaging/scheduleDb'
import { getPool, POOL_READ_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { getManualMergedPool } from '@/lib/packaging/manualCache'
import { addDays, isValidYmd } from '@/lib/packaging/scheduleCalendar'
import type { Placement, PlacementOp, PlacementSource, YMD } from '@/lib/packaging/scheduleTypes'
import {
  AI_ADOPTIONS_LIST_LIMIT,
  AI_DEFAULT_HORIZON,
  AI_ERROR_MESSAGE_MAX,
  AI_HORIZONS,
  AI_REVERT_CLAIM_TTL_MS,
  AI_RULES_HISTORY_LIMIT,
  AI_RUN_HISTORY_LIMIT,
  AI_RUN_STALE_MS,
  AI_SUMMARY_MAX,
  type AdoptionCounts,
  type AdoptionMeta,
  type AdoptionRow,
  type AdoptionSkip,
  type AiAdoption,
  type AiErrorCode,
  type AiHorizon,
  type AiOpLogKind,
  type AiOutput,
  type AiPayload,
  type AiRulesMeta,
  type AiRulesRow,
  type AiRulesVersion,
  type AiRun,
  type AiRunMeta,
  type AiRunPatch,
  type AiRunRow,
  type AiRunStatusInfo,
  type AiRunSummary,
  type AiUsage,
  type BulkThreshold,
  type BulkThresholdInput,
  type BulkThresholdRow,
  type NewAdoption,
  type NewAiRun,
  type NewSimSession,
  type RevertReport,
  type RunPhase,
  type RunStatus,
  type SimLocks,
  type SimMode,
  type SimOwnerSummary,
  type SimPlacement,
  type SimSession,
  type SimSessionInfo,
  type SimSessionPatch,
  type SimSessionRow,
  type SimSessionState,
  type SimSource,
  type SimUndoEntry,
  type SimUndoKind,
  type SimWorld,
  type TouchedPlacement,
  type ValidationReport,
} from '@/lib/packaging/ai/types'

export const AI_TBL = {
  sessions: 'packaging_sim_sessions',
  runs: 'packaging_ai_runs',
  adoptions: 'packaging_ai_adoptions',
  rules: 'packaging_ai_rules',
  thresholds: 'packaging_bulk_thresholds',
} as const

/** AI 模擬排程 migration 檔名（錯誤訊息提示用） */
export const AI_MIGRATION_FILE = 'sql/20260928b_packaging_ai.sql'

/** 產能沿用要看「較早的平日列」，讀近 400 天（同 GET /api/packaging/board） */
const CAPACITY_LOOKBACK_DAYS = 400
/** 同一時間有模擬區的人不會太多；列表防呆上限 */
const OWNERS_LIMIT = 100

// ─────────────────────────────────────────────────────────────────────
// 錯誤
// ─────────────────────────────────────────────────────────────────────

/** 新表或欄位不存在（sql/20260928b_packaging_ai.sql 尚未套用；PGRST205／42P01／PGRST204／42703） */
export function isAiMissingSchema(e: unknown): boolean {
  return isMissingSchema(e)
}

/** migration 未套用時回給前端的訊息（保留「找不到資料表」字樣，前端 boardApi.isMissingTableMessage 認得） */
export function aiMigrationMessage(e?: unknown): string {
  const code = e instanceof ScheduleDbError ? e.pgCode : null
  return `找不到資料表（AI 模擬排程${code ? `，${code}` : ''}），請先套用 ${AI_MIGRATION_FILE}`
}

/**
 * 回給前端的錯誤訊息：新表未套用 → aiMigrationMessage；其他一律沿用 scheduleDb.publicDbError（固定中文＋錯誤碼，
 * 不帶 PostgREST 的 message／details——details 可能是 'Failing row contains (...)'，會帶出 payload／email）。
 */
export function publicAiDbError(e: unknown, what = '資料庫存取'): string {
  return isAiMissingSchema(e) ? aiMigrationMessage(e) : publicDbError(e, what)
}

/** 待排池組裝失敗（loadSimWorld 丟出；route 回 500 pool_unavailable，runner 記 error_code 'pool_unavailable'） */
export class PoolUnavailableError extends Error {
  constructor() {
    super('待排池暫時無法組裝，請稍後再試')
    this.name = 'PoolUnavailableError'
  }
}

// ─────────────────────────────────────────────────────────────────────
// jsonb 形狀防呆（DB 內容理論上都由本系統寫入，但壞一筆不能讓整個模擬區打不開）
// ─────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const intOrNull = (v: unknown): number | null => {
  const n = finite(v)
  return n != null && Number.isInteger(n) ? n : null
}
/** DB date／jsonb 字串 → 'YYYY-MM-DD'（timestamptz 字串取前 10 碼）；不合法 null */
const ymdOf = (v: unknown): YMD | null => {
  const s = str(v)?.slice(0, 10) ?? null
  return s && isValidYmd(s) ? s : null
}

function ymdArray(v: unknown): YMD[] {
  if (!Array.isArray(v)) return []
  const out: YMD[] = []
  for (const x of v) {
    const d = ymdOf(x)
    if (d) out.push(d)
  }
  return out
}

function intArray(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const x of v) {
    const n = intOrNull(x)
    if (n != null) out.push(n)
  }
  return out
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

const asHorizon = (v: unknown): AiHorizon => {
  const n = intOrNull(v)
  return (AI_HORIZONS as readonly number[]).includes(n ?? -1) ? (n as AiHorizon) : AI_DEFAULT_HORIZON
}
const asMode = (v: unknown): SimMode => (v === 'clear' ? 'clear' : 'copy')
const asSimSource = (v: unknown): SimSource => (v === 'ai' || v === 'manual' ? v : 'copy')
const asSource = (v: unknown): PlacementSource => (v === 'ai' ? 'ai' : 'manual')
const RUN_STATUSES: readonly RunStatus[] = ['running', 'done', 'failed']
const RUN_PHASES: readonly RunPhase[] = ['preparing', 'thinking', 'validating', 'done', 'failed']
const UNDO_KINDS: readonly SimUndoKind[] = ['ops', 'ai_run', 'reset', 'load_run', 'locks']
const asStatus = (v: unknown): RunStatus => (RUN_STATUSES.includes(v as RunStatus) ? (v as RunStatus) : 'failed')
const asPhase = (v: unknown): RunPhase => (RUN_PHASES.includes(v as RunPhase) ? (v as RunPhase) : 'failed')

/** jsonb → SimLocks（缺欄補空陣列；SO 單號一律大寫） */
export function parseSimLocks(v: unknown): SimLocks {
  if (!isObj(v)) return { placementIds: [], soNumbers: [], lineIds: [] }
  return {
    placementIds: strArray(v.placementIds),
    soNumbers: strArray(v.soNumbers).map((s) => s.trim().toUpperCase()).filter(Boolean),
    lineIds: intArray(v.lineIds),
  }
}

/** jsonb → SimPlacement[]（形狀不對的列略過：id、soLineKey、qty > 0、planDate、lineId 必有） */
export function parseSimPlacements(v: unknown): SimPlacement[] {
  if (!Array.isArray(v)) return []
  const out: SimPlacement[] = []
  for (const x of v) {
    if (!isObj(x)) continue
    const id = str(x.id)
    const soLineKey = str(x.soLineKey)
    const qty = finite(x.qty)
    const planDate = ymdOf(x.planDate)
    const lineId = intOrNull(x.lineId)
    if (!id || !soLineKey || qty == null || qty <= 0 || !planDate || lineId == null) continue
    out.push({
      id,
      soLineKey,
      qty,
      planDate,
      originalDate: ymdOf(x.originalDate),
      source: asSource(x.source),
      originCardId: str(x.originCardId),
      lineId,
      estMinutesOverride: finite(x.estMinutesOverride),
      sortIndex: finite(x.sortIndex),
      aiReason: str(x.aiReason),
      simSource: asSimSource(x.simSource),
      livePlacementId: str(x.livePlacementId),
    })
  }
  return out
}

function parseSessionState(v: unknown): SimSessionState | null {
  if (!isObj(v)) return null
  return {
    horizon: asHorizon(v.horizon),
    mode: asMode(v.mode),
    windowDates: ymdArray(v.windowDates),
    lineIds: intArray(v.lineIds),
    placements: parseSimPlacements(v.placements),
    locks: parseSimLocks(v.locks),
  }
}

/** jsonb → SimUndoEntry[]（舊 → 新；壞掉的格略過） */
export function parseSimUndo(v: unknown): SimUndoEntry[] {
  if (!Array.isArray(v)) return []
  const out: SimUndoEntry[] = []
  for (const x of v) {
    if (!isObj(x)) continue
    const state = parseSessionState(x.state)
    if (!state) continue
    out.push({
      label: str(x.label) ?? '',
      kind: UNDO_KINDS.includes(x.kind as SimUndoKind) ? (x.kind as SimUndoKind) : 'ops',
      at: str(x.at) ?? '',
      state,
    })
  }
  return out
}

function parseUsage(v: unknown): AiUsage | null {
  if (!isObj(v)) return null
  return {
    inputTokens: finite(v.inputTokens) ?? 0,
    outputTokens: finite(v.outputTokens) ?? 0,
    cacheReadInputTokens: finite(v.cacheReadInputTokens) ?? 0,
    cacheCreationInputTokens: finite(v.cacheCreationInputTokens) ?? 0,
  }
}

function parseThresholdSnapshot(v: unknown): BulkThreshold[] {
  if (!Array.isArray(v)) return []
  const out: BulkThreshold[] = []
  for (const x of v) {
    if (!isObj(x)) continue
    const key = str(x.key)
    const threshold = finite(x.threshold)
    if (!key || threshold == null) continue
    out.push({ key, threshold, note: str(x.note), updatedByName: str(x.updatedByName), updatedAt: str(x.updatedAt) ?? '' })
  }
  return out
}

const EMPTY_COUNTS: AdoptionCounts = { moved: 0, added: 0, returned: 0, qtyChanged: 0, reordered: 0, minutesChanged: 0, unchanged: 0, skipped: 0 }

function parseCounts(v: unknown): AdoptionCounts {
  if (!isObj(v)) return { ...EMPTY_COUNTS }
  const n = (k: keyof AdoptionCounts) => finite(v[k]) ?? 0
  return {
    moved: n('moved'), added: n('added'), returned: n('returned'), qtyChanged: n('qtyChanged'),
    reordered: n('reordered'), minutesChanged: n('minutesChanged'), unchanged: n('unchanged'), skipped: n('skipped'),
  }
}

function parseSkips(v: unknown): AdoptionSkip[] {
  if (!Array.isArray(v)) return []
  return v.filter(isObj).map((x) => ({
    soLineKey: str(x.soLineKey) ?? '',
    placementId: str(x.placementId),
    code: (str(x.code) ?? 'bad_request') as AdoptionSkip['code'],
    message: str(x.message) ?? '',
  }))
}

function parseTouched(v: unknown): TouchedPlacement[] {
  if (!Array.isArray(v)) return []
  const out: TouchedPlacement[] = []
  for (const x of v) {
    if (!isObj(x)) continue
    const id = str(x.id)
    const version = intOrNull(x.version)
    if (id && version != null) out.push({ id, version })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────
// 模擬區（packaging_sim_sessions）
// ─────────────────────────────────────────────────────────────────────

export function rowToSimSession(r: SimSessionRow): SimSession {
  return {
    id: Number(r.id),
    ownerEmail: r.owner_email,
    ownerName: r.owner_name ?? null,
    horizon: asHorizon(r.horizon),
    mode: asMode(r.mode),
    windowDates: ymdArray(r.window_dates),
    lineIds: intArray(r.line_ids),
    placements: parseSimPlacements(r.placements),
    locks: parseSimLocks(r.locks),
    undo: parseSimUndo(r.undo),
    version: Number(r.version),
    runningRunId: r.running_run_id == null ? null : Number(r.running_run_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 起始日已過（window_dates[0] < today）：AI 排程與採用前要先重設 */
export function isSimSessionStale(s: Pick<SimSession, 'windowDates'>, today: YMD): boolean {
  return s.windowDates.length === 0 || s.windowDates[0] < today
}

/** SimSession → API 版（不含 undo 快照本體，只給標籤） */
export function toSimSessionInfo(s: SimSession, today: YMD): SimSessionInfo {
  return {
    id: s.id,
    ownerEmail: s.ownerEmail,
    ownerName: s.ownerName,
    horizon: s.horizon,
    mode: s.mode,
    windowDates: s.windowDates,
    lineIds: s.lineIds,
    locks: s.locks,
    version: s.version,
    runningRunId: s.runningRunId,
    undo: s.undo.map((u) => ({ label: u.label, kind: u.kind, at: u.at })),
    placementCount: s.placements.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    stale: isSimSessionStale(s, today),
  }
}

export async function getSimSession(sb: SupabaseAdmin, ownerEmail: string): Promise<SimSession | null> {
  const { data, error } = await sb.from(AI_TBL.sessions).select('*').eq('owner_email', ownerEmail).maybeSingle()
  if (error) throw new ScheduleDbError('讀取模擬區', error)
  return data ? rowToSimSession(data as SimSessionRow) : null
}

export async function getSimSessionById(sb: SupabaseAdmin, id: number): Promise<SimSession | null> {
  const { data, error } = await sb.from(AI_TBL.sessions).select('*').eq('id', id).maybeSingle()
  if (error) throw new ScheduleDbError('讀取模擬區', error)
  return data ? rowToSimSession(data as SimSessionRow) : null
}

/** 有模擬區的人（含自己），最近更新在前——唯讀檢視切換用（只取摘要欄，不讀 placements／undo） */
export async function listSimOwners(sb: SupabaseAdmin): Promise<SimOwnerSummary[]> {
  const { data, error } = await sb.from(AI_TBL.sessions)
    .select('owner_email, owner_name, horizon, mode, window_dates, updated_at')
    .order('updated_at', { ascending: false }).limit(OWNERS_LIMIT)
  if (error) throw new ScheduleDbError('讀取模擬區列表', error)
  return ((data ?? []) as Pick<SimSessionRow, 'owner_email' | 'owner_name' | 'horizon' | 'mode' | 'window_dates' | 'updated_at'>[])
    .map((r) => ({
      email: r.owner_email,
      name: r.owner_name ?? null,
      horizon: asHorizon(r.horizon),
      mode: asMode(r.mode),
      windowDates: ymdArray(r.window_dates),
      updatedAt: r.updated_at,
    }))
}

const sessionStateRow = (s: Partial<SimSessionState>) => {
  const row: Record<string, unknown> = {}
  if (s.horizon !== undefined) row.horizon = s.horizon
  if (s.mode !== undefined) row.mode = s.mode
  if (s.windowDates !== undefined) row.window_dates = s.windowDates
  if (s.lineIds !== undefined) row.line_ids = s.lineIds
  if (s.placements !== undefined) row.placements = s.placements
  if (s.locks !== undefined) row.locks = s.locks
  return row
}

/**
 * 第一次建立模擬區（version = 1）。owner_email 唯一：同一人另一個分頁剛好也建了 → 回 null（route 回 version_conflict、前端重新載入）。
 */
export async function insertSimSession(sb: SupabaseAdmin, v: NewSimSession, nowIso: string): Promise<SimSession | null> {
  const { data, error } = await sb.from(AI_TBL.sessions).insert({
    owner_email: v.ownerEmail,
    owner_name: v.ownerName,
    ...sessionStateRow(v),
    undo: v.undo,
    version: 1,
    running_run_id: null,
    created_at: nowIso,
    updated_at: nowIso,
  }).select('*').single()
  if (error) {
    if ((error as { code?: unknown }).code === '23505') return null
    throw new ScheduleDbError('建立模擬區', error)
  }
  return rowToSimSession(data as SimSessionRow)
}

/**
 * 模擬區的所有寫入都走這裡：version CAS（where id and version = expectVersion），成功 version + 1、updated_at = nowIso。
 * 回 null＝version 不符（被另一個分頁或 AI 寫回改過）→ route 回 409 version_conflict，前端重新載入。
 * 大小：placements／undo 的上限由呼叫端先處理（SIM_MAX_PLACEMENTS、pushUndo 依 SIM_UNDO_MAX_CHARS 丟最舊），DB check 是最後防線。
 */
export async function updateSimSessionCas(
  sb: SupabaseAdmin,
  id: number,
  expectVersion: number,
  patch: SimSessionPatch,
  nowIso: string,
): Promise<SimSession | null> {
  const row: Record<string, unknown> = { ...sessionStateRow(patch), version: expectVersion + 1, updated_at: nowIso }
  if (patch.ownerName !== undefined) row.owner_name = patch.ownerName
  if (patch.undo !== undefined) row.undo = patch.undo
  if (patch.runningRunId !== undefined) row.running_run_id = patch.runningRunId
  const { data, error } = await sb.from(AI_TBL.sessions).update(row)
    .eq('id', id).eq('version', expectVersion).select('*')
  if (error) throw new ScheduleDbError('更新模擬區', error)
  const r = ((data ?? []) as SimSessionRow[])[0]
  return r ? rowToSimSession(r) : null
}

/**
 * 佔用 AI 執行位（§4.1 步驟 3）：running_run_id = runId，條件＝version 仍是 expectVersion 且目前沒有執行中的 run
 * （或目前那個是已判定逾時的 staleRunId）。**不改 version**：佔位不改模擬內容；主管之後的手動操作會讓 version 變，
 * runner 寫回時以 run.base_version 做 CAS 就知道「執行期間被改過」。回 false＝被搶先或版本已變。
 */
export async function claimRunSlot(
  sb: SupabaseAdmin,
  sessionId: number,
  expectVersion: number,
  runId: number,
  staleRunId: number | null,
): Promise<boolean> {
  let q = sb.from(AI_TBL.sessions).update({ running_run_id: runId }).eq('id', sessionId).eq('version', expectVersion)
  q = staleRunId == null ? q.is('running_run_id', null) : q.or(`running_run_id.is.null,running_run_id.eq.${Math.trunc(staleRunId)}`)
  const { data, error } = await q.select('id')
  if (error) throw new ScheduleDbError('佔用 AI 執行位', error)
  return (data ?? []).length === 1
}

/** 釋放 AI 執行位（只在目前佔位的就是這個 run 時才清；不改 version）。runner 結束（成功或失敗）一定呼叫 */
export async function clearRunningRun(sb: SupabaseAdmin, sessionId: number, runId: number): Promise<void> {
  const { error } = await sb.from(AI_TBL.sessions).update({ running_run_id: null })
    .eq('id', sessionId).eq('running_run_id', runId)
  if (error) throw new ScheduleDbError('釋放 AI 執行位', error)
}

// ─────────────────────────────────────────────────────────────────────
// 正式區世界（模擬區 GET／操作、runner、採用共用；讀法同 GET /api/packaging/board）
// ─────────────────────────────────────────────────────────────────────

/**
 * 讀取組合模擬狀態需要的一切正式區資料（只讀）：待排池（快取，併入 D66 手動區塊）、全部未完成擺放、
 * today 起的已完成、池內各行的已完成（守恆「未反映完成量 U」要看）、400 天產能列（daily＋各線）、全部線。
 * poolMaxAgeMs：讀取用 POOL_READ_MAX_AGE_MS（預設）；寫入驗證（ops／採用）可用 POOL_WRITE_MAX_AGE_MS。
 * 待排池組裝失敗丟 PoolUnavailableError；其他 DB 錯誤丟 ScheduleDbError。
 */
export async function loadSimWorld(
  sb: SupabaseAdmin,
  opts: { today: YMD; nowIso: string; actor: { email: string; name: string | null }; poolMaxAgeMs?: number },
): Promise<SimWorld> {
  const basePool = await getPool({ maxAgeMs: opts.poolMaxAgeMs ?? POOL_READ_MAX_AGE_MS }).catch((e: unknown) => {
    console.error('[packaging/ai] 待排池組裝失敗:', describeError(e))
    return null
  })
  if (!basePool) throw new PoolUnavailableError()
  const manual = await getManualMergedPool(sb, basePool)
  const pool = manual.pool
  const poolLines = new Set<string>()
  for (const b of pool.blocks) for (const c of b.cards) poolLines.add(c.soLineKey)
  const [open, completedFrom, capacityRows, completedInPool, lines, lineRows] = await Promise.all([
    loadOpenPlacements(sb),
    loadCompletedSince(sb, opts.today),
    loadCapacityRows(sb, addDays(opts.today, -CAPACITY_LOOKBACK_DAYS)),
    loadPlacementsByLines(sb, [...poolLines], { completedOnly: true }),
    loadLines(sb),
    loadLineCapacityRows(sb, addDays(opts.today, -CAPACITY_LOOKBACK_DAYS)),
  ])
  const byId = new Map<string, Placement>()
  for (const p of [...open, ...completedFrom, ...completedInPool]) byId.set(p.id, p)
  return {
    today: opts.today,
    nowIso: opts.nowIso,
    actor: opts.actor,
    pool,
    manual: { meta: manual.meta, backInPoolKeys: manual.backInPoolKeys, skipped: manual.skipped },
    live: [...byId.values()],
    capacityRows,
    lines,
    lineRows,
  }
}

// ─────────────────────────────────────────────────────────────────────
// AI 執行 LOG（packaging_ai_runs）
// ─────────────────────────────────────────────────────────────────────

/** 列表／輪詢用欄位（不含 payload、base／result 擺放、AI 原文；validation 只取兩個值） */
const RUN_META_COLS = [
  'id', 'session_id', 'owner_email', 'owner_name', 'status', 'phase', 'error_code', 'error_message',
  'horizon', 'mode', 'window_dates', 'rules_id', 'summary', 'model', 'usage', 'duration_ms', 'started_at', 'finished_at',
  'v_applied:validation->applied', 'v_result_count:validation->resultCount',
].join(', ')
/** 輪詢／詳情：meta ＋ 鎖定、門檻快照、驗算報告（仍不含 payload 與擺放本體） */
const RUN_SUMMARY_COLS = [
  'id', 'session_id', 'owner_email', 'owner_name', 'status', 'phase', 'error_code', 'error_message',
  'horizon', 'mode', 'window_dates', 'rules_id', 'summary', 'model', 'usage', 'duration_ms', 'started_at', 'finished_at',
  'locks', 'base_version', 'thresholds', 'validation',
].join(', ')

type RunMetaRow = Pick<AiRunRow, 'id' | 'session_id' | 'owner_email' | 'owner_name' | 'status' | 'phase' | 'error_code' | 'error_message'
  | 'horizon' | 'mode' | 'window_dates' | 'rules_id' | 'summary' | 'model' | 'usage' | 'duration_ms' | 'started_at' | 'finished_at'>
  & { v_applied?: unknown; v_result_count?: unknown; validation?: unknown }

function rowToRunMeta(r: RunMetaRow): AiRunMeta {
  const v = isObj(r.validation) ? r.validation : null
  const applied = v ? v.applied : r.v_applied
  const resultCount = v ? v.resultCount : r.v_result_count
  return {
    id: Number(r.id),
    sessionId: Number(r.session_id),
    ownerEmail: r.owner_email,
    ownerName: r.owner_name ?? null,
    status: asStatus(r.status),
    phase: asPhase(r.phase),
    errorCode: (r.error_code as AiErrorCode | null) ?? null,
    errorMessage: r.error_message ?? null,
    horizon: asHorizon(r.horizon),
    mode: asMode(r.mode),
    windowDates: ymdArray(r.window_dates),
    rulesId: r.rules_id == null ? null : Number(r.rules_id),
    summary: r.summary ?? null,
    model: r.model ?? null,
    usage: parseUsage(r.usage),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    applied: typeof applied === 'boolean' ? applied : null,
    resultCount: finite(resultCount),
  }
}

function rowToRunSummary(r: RunMetaRow & Pick<AiRunRow, 'locks' | 'base_version' | 'thresholds' | 'validation'>): AiRunSummary {
  return {
    ...rowToRunMeta(r),
    locks: parseSimLocks(r.locks),
    baseVersion: Number(r.base_version),
    thresholds: parseThresholdSnapshot(r.thresholds),
    validation: isObj(r.validation) ? (r.validation as unknown as ValidationReport) : null,
  }
}

function rowToRun(r: AiRunRow): AiRun {
  return {
    ...rowToRunSummary(r),
    payload: isObj(r.payload) ? (r.payload as unknown as AiPayload) : null,
    basePlacements: parseSimPlacements(r.base_placements),
    resultPlacements: Array.isArray(r.result_placements) ? parseSimPlacements(r.result_placements) : null,
    aiOutput: isObj(r.ai_output) ? (r.ai_output as unknown as AiOutput) : null,
  }
}

/**
 * 輪詢顯示用：running 時＝now − startedAt；結束＝durationMs（沒有則 finishedAt − startedAt）。
 * stale：仍是 running 但超過 AI_RUN_STALE_MS（背景執行多半已中斷）。GET 不寫入（不在讀取時改 run 列），只把判斷交給畫面：
 *   畫面據此解除封鎖、提示「可能已中斷，可重新執行」；真正標成 ai_stale 由下一次 POST session/run 做（§4.1 步驟 1）。
 */
export function toRunStatusInfo(run: Pick<AiRunMeta, 'id' | 'status' | 'phase' | 'startedAt' | 'finishedAt' | 'durationMs'>, nowMs: number): AiRunStatusInfo {
  const start = Date.parse(run.startedAt)
  const end = run.finishedAt ? Date.parse(run.finishedAt) : nowMs
  const elapsed = run.status !== 'running' && run.durationMs != null ? run.durationMs : end - start
  const elapsedMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  // startedAt 壞掉（NaN）也當逾時：否則永遠「執行中」、畫面永遠鎖住
  const stale = run.status === 'running' && (!Number.isFinite(start) || nowMs - start > AI_RUN_STALE_MS)
  return { id: run.id, status: run.status, phase: run.phase, startedAt: run.startedAt, elapsedMs, stale }
}

/** 建 run 列（status running、phase preparing）；回完整列（取 id 用） */
export async function insertAiRun(sb: SupabaseAdmin, v: NewAiRun, nowIso: string): Promise<AiRun> {
  const { data, error } = await sb.from(AI_TBL.runs).insert({
    session_id: v.sessionId,
    owner_email: v.ownerEmail,
    owner_name: v.ownerName,
    status: 'running',
    phase: 'preparing',
    horizon: v.horizon,
    mode: v.mode,
    window_dates: v.windowDates,
    locks: v.locks,
    base_version: v.baseVersion,
    base_placements: v.basePlacements,
    started_at: nowIso,
  }).select('*').single()
  if (error) throw new ScheduleDbError('建立 AI 執行紀錄', error)
  return rowToRun(data as AiRunRow)
}

/**
 * runner 分階段更新（只寫有帶的欄位）。status 改成 done／failed 時必須同時帶 finishedAt（DB check：running ⇔ finished_at null）。
 * summary／errorMessage 超過 DB 上限時截斷（不因字數讓整筆結果寫不進去）。
 */
export async function updateAiRun(sb: SupabaseAdmin, id: number, patch: AiRunPatch): Promise<void> {
  const row: Record<string, unknown> = {}
  if (patch.status !== undefined) row.status = patch.status
  if (patch.phase !== undefined) row.phase = patch.phase
  if (patch.errorCode !== undefined) row.error_code = patch.errorCode
  if (patch.errorMessage !== undefined) row.error_message = patch.errorMessage == null ? null : patch.errorMessage.slice(0, AI_ERROR_MESSAGE_MAX)
  if (patch.rulesId !== undefined) row.rules_id = patch.rulesId
  if (patch.thresholds !== undefined) row.thresholds = patch.thresholds
  if (patch.payload !== undefined) row.payload = patch.payload
  if (patch.resultPlacements !== undefined) row.result_placements = patch.resultPlacements
  if (patch.aiOutput !== undefined) row.ai_output = patch.aiOutput
  if (patch.validation !== undefined) row.validation = patch.validation
  if (patch.summary !== undefined) row.summary = patch.summary == null ? null : patch.summary.slice(0, AI_SUMMARY_MAX)
  if (patch.model !== undefined) row.model = patch.model == null ? null : patch.model.slice(0, 100)
  if (patch.usage !== undefined) row.usage = patch.usage
  if (patch.durationMs !== undefined) row.duration_ms = patch.durationMs == null ? null : Math.max(0, Math.round(patch.durationMs))
  if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt
  if (Object.keys(row).length === 0) return
  const { error } = await sb.from(AI_TBL.runs).update(row).eq('id', id)
  if (error) throw new ScheduleDbError('更新 AI 執行紀錄', error)
}

/** 完整 run（runner、load-run 用；含 payload 與擺放本體） */
export async function getAiRun(sb: SupabaseAdmin, id: number): Promise<AiRun | null> {
  const { data, error } = await sb.from(AI_TBL.runs).select('*').eq('id', id).maybeSingle()
  if (error) throw new ScheduleDbError('讀取 AI 執行紀錄', error)
  return data ? rowToRun(data as AiRunRow) : null
}

/** 輪詢／詳情（GET runs/[id]）：不讀 payload、擺放本體與 AI 原文 */
export async function getAiRunSummary(sb: SupabaseAdmin, id: number): Promise<AiRunSummary | null> {
  const { data, error } = await sb.from(AI_TBL.runs).select(RUN_SUMMARY_COLS).eq('id', id).maybeSingle()
  if (error) throw new ScheduleDbError('讀取 AI 執行紀錄', error)
  return data ? rowToRunSummary(data as unknown as RunMetaRow & Pick<AiRunRow, 'locks' | 'base_version' | 'thresholds' | 'validation'>) : null
}

/** 某人最近 N 次（新 → 舊；預設 AI_RUN_HISTORY_LIMIT） */
export async function listAiRuns(sb: SupabaseAdmin, ownerEmail: string, limit = AI_RUN_HISTORY_LIMIT): Promise<AiRunMeta[]> {
  const { data, error } = await sb.from(AI_TBL.runs).select(RUN_META_COLS)
    .eq('owner_email', ownerEmail).order('started_at', { ascending: false }).order('id', { ascending: false }).limit(limit)
  if (error) throw new ScheduleDbError('讀取 AI 執行紀錄', error)
  return ((data ?? []) as unknown as RunMetaRow[]).map(rowToRunMeta)
}

/** 某人最近一次按 AI 的時間（60 秒節流用） */
export async function latestAiRunStartedAt(sb: SupabaseAdmin, ownerEmail: string): Promise<string | null> {
  const { data, error } = await sb.from(AI_TBL.runs).select('started_at')
    .eq('owner_email', ownerEmail).order('started_at', { ascending: false }).limit(1)
  if (error) throw new ScheduleDbError('讀取 AI 執行紀錄', error)
  const r = ((data ?? []) as { started_at: string }[])[0]
  return r ? String(r.started_at) : null
}

/**
 * 把逾時（> AI_RUN_STALE_MS 仍 running，多半是 serverless 實例被回收）的 run 標成失敗。只改仍是 running 的列；回 true＝有改到。
 * 由 POST session/run 在發現 running_run_id 指向逾時 run 時呼叫（§4.1 步驟 1）。
 */
export async function markStaleAiRunFailed(sb: SupabaseAdmin, runId: number, nowIso: string): Promise<boolean> {
  const { data, error } = await sb.from(AI_TBL.runs).update({
    status: 'failed',
    phase: 'failed',
    error_code: 'ai_stale' satisfies AiErrorCode,
    error_message: 'AI 執行超過 6 分鐘沒有結束（伺服器可能已中斷），已標記為失敗，可以重新執行',
    finished_at: nowIso,
  }).eq('id', runId).eq('status', 'running').select('id')
  if (error) throw new ScheduleDbError('更新 AI 執行紀錄', error)
  return (data ?? []).length === 1
}

// ─────────────────────────────────────────────────────────────────────
// 採用紀錄（packaging_ai_adoptions）
// ─────────────────────────────────────────────────────────────────────

const ADOPTION_META_COLS = [
  'id', 'session_id', 'run_id', 'version_id', 'window_dates', 'line_ids', 'counts', 'skipped',
  'actor_email', 'actor_name', 'created_at', 'reverted_at', 'reverted_by_name',
].join(', ')

type AdoptionMetaRow = Pick<AdoptionRow, 'id' | 'session_id' | 'run_id' | 'version_id' | 'window_dates' | 'line_ids' | 'counts' | 'skipped'
  | 'actor_email' | 'actor_name' | 'created_at' | 'reverted_at' | 'reverted_by_name'>

function rowToAdoptionMeta(r: AdoptionMetaRow, canRevert: boolean): AdoptionMeta {
  return {
    id: Number(r.id),
    sessionId: Number(r.session_id),
    runId: r.run_id == null ? null : Number(r.run_id),
    versionId: Number(r.version_id),
    windowDates: ymdArray(r.window_dates),
    lineIds: intArray(r.line_ids),
    counts: parseCounts(r.counts),
    skippedCount: Array.isArray(r.skipped) ? r.skipped.length : 0,
    actorEmail: r.actor_email,
    actorName: r.actor_name ?? null,
    createdAt: r.created_at,
    revertedAt: r.reverted_at ?? null,
    revertedByName: r.reverted_by_name ?? null,
    canRevert,
  }
}

function rowToAdoption(r: AdoptionRow): AiAdoption {
  const { canRevert: _c, skippedCount: _s, ...meta } = rowToAdoptionMeta(r, false)
  void _c
  void _s
  return {
    ...meta,
    inverse: Array.isArray(r.inverse) ? (r.inverse as PlacementOp[]) : [],
    touched: parseTouched(r.touched),
    skipped: parseSkips(r.skipped),
    revertedBy: r.reverted_by ?? null,
    revertReport: isObj(r.revert_report) ? (r.revert_report as unknown as RevertReport) : null,
  }
}

export async function insertAdoption(sb: SupabaseAdmin, v: NewAdoption, nowIso: string): Promise<AiAdoption> {
  const { data, error } = await sb.from(AI_TBL.adoptions).insert({
    session_id: v.sessionId,
    run_id: v.runId,
    version_id: v.versionId,
    window_dates: v.windowDates,
    line_ids: v.lineIds,
    inverse: v.inverse,
    touched: v.touched,
    counts: v.counts,
    skipped: v.skipped,
    actor_email: v.actorEmail,
    actor_name: v.actorName,
    created_at: nowIso,
  }).select('*').single()
  if (error) throw new ScheduleDbError('寫入採用紀錄', error)
  return rowToAdoption(data as AdoptionRow)
}

/**
 * 最近 N 筆（新 → 舊）。canRevert＝「最近一筆未退回」（§6.2：只允許退回它，較早的要先退回較新的）——
 * 依新 → 舊排序後第一筆 reverted_at 為 null 的就是它（它一定在前 N 筆內）。
 */
export async function listAdoptions(sb: SupabaseAdmin, limit = AI_ADOPTIONS_LIST_LIMIT): Promise<AdoptionMeta[]> {
  const { data, error } = await sb.from(AI_TBL.adoptions).select(ADOPTION_META_COLS)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit)
  if (error) throw new ScheduleDbError('讀取採用紀錄', error)
  const rows = (data ?? []) as unknown as AdoptionMetaRow[]
  const latestOpen = rows.find((r) => r.reverted_at == null)
  return rows.map((r) => rowToAdoptionMeta(r, latestOpen != null && r.id === latestOpen.id))
}

export async function getAdoption(sb: SupabaseAdmin, id: number): Promise<AiAdoption | null> {
  const { data, error } = await sb.from(AI_TBL.adoptions).select('*').eq('id', id).maybeSingle()
  if (error) throw new ScheduleDbError('讀取採用紀錄', error)
  return data ? rowToAdoption(data as AdoptionRow) : null
}

/** 最近一筆未退回的採用 id（沒有 null）；退回前確認「就是它」 */
export async function getLatestOpenAdoptionId(sb: SupabaseAdmin): Promise<number | null> {
  const { data, error } = await sb.from(AI_TBL.adoptions).select('id')
    .is('reverted_at', null).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1)
  if (error) throw new ScheduleDbError('讀取採用紀錄', error)
  const r = ((data ?? []) as { id: number | string }[])[0]
  return r ? Number(r.id) : null
}

/**
 * 退回前佔位（避免同一筆採用被兩個請求同時退回、restore 插入兩份）：
 * 先讀目前的 reverted_at／revert_claimed_at，再以「讀到的值」做 CAS 更新（where reverted_at is null and revert_claimed_at = 讀到的值）。
 *   'claimed'＝佔到了（回傳 claimedAt，釋放時要帶）；'reverted'＝已經退回過；'busy'＝另一個請求正在退回（佔位還沒逾時）；
 *   'not_found'＝沒有這筆。佔位超過 AI_REVERT_CLAIM_TTL_MS 視為上一個請求已中斷（實例被回收），可以接手。
 * 為什麼不直接先 markAdoptionReverted：寫入失敗要還原標記、實例在中途被砍則會留下「標成已退回、其實沒退」而且再也退不了；
 *   佔位有時效，最壞情況只是等 3 分鐘。
 */
export async function claimAdoptionRevert(
  sb: SupabaseAdmin,
  id: number,
  v: { actorEmail: string; nowMs: number },
): Promise<{ status: 'claimed'; claimedAt: string } | { status: 'reverted' | 'busy' | 'not_found' }> {
  const { data, error } = await sb.from(AI_TBL.adoptions).select('id, reverted_at, revert_claimed_at').eq('id', id).maybeSingle()
  if (error) throw new ScheduleDbError('讀取採用紀錄', error)
  if (!data) return { status: 'not_found' }
  const cur = data as Pick<AdoptionRow, 'id' | 'reverted_at' | 'revert_claimed_at'>
  if (cur.reverted_at != null) return { status: 'reverted' }
  const held = cur.revert_claimed_at ?? null
  if (held != null && v.nowMs - Date.parse(held) <= AI_REVERT_CLAIM_TTL_MS) return { status: 'busy' }
  const claimedAt = new Date(v.nowMs).toISOString()
  let q = sb.from(AI_TBL.adoptions).update({ revert_claimed_at: claimedAt, revert_claimed_by: v.actorEmail })
    .eq('id', id).is('reverted_at', null)
  q = held == null ? q.is('revert_claimed_at', null) : q.eq('revert_claimed_at', held)
  const { data: upd, error: e2 } = await q.select('id')
  if (e2) throw new ScheduleDbError('更新採用紀錄', e2)
  return (upd ?? []).length === 1 ? { status: 'claimed', claimedAt } : { status: 'busy' }
}

/** 退回沒完成（任何失敗）時釋放佔位；只清「自己佔的那一次」（revert_claimed_at = claimedAt）。失敗只 log（佔位 3 分鐘後自動失效） */
export async function releaseAdoptionRevert(sb: SupabaseAdmin, id: number, claimedAt: string): Promise<void> {
  try {
    const { error } = await sb.from(AI_TBL.adoptions).update({ revert_claimed_at: null, revert_claimed_by: null })
      .eq('id', id).eq('revert_claimed_at', claimedAt)
    if (error) console.error('[packaging/ai] 釋放退回佔位失敗:', (error as { code?: string }).code ?? 'unknown')
  } catch (e) {
    console.error('[packaging/ai] 釋放退回佔位失敗:', e instanceof Error ? e.name : typeof e)
  }
}

/** 標記已退回（CAS：只在 reverted_at 仍為 null 時成功；回 false＝別人剛退回過） */
export async function markAdoptionReverted(
  sb: SupabaseAdmin,
  id: number,
  v: { actorEmail: string; actorName: string | null; at: string; report: RevertReport },
): Promise<boolean> {
  const { data, error } = await sb.from(AI_TBL.adoptions).update({
    reverted_at: v.at,
    reverted_by: v.actorEmail,
    reverted_by_name: v.actorName,
    revert_report: v.report,
  }).eq('id', id).is('reverted_at', null).select('id')
  if (error) throw new ScheduleDbError('更新採用紀錄', error)
  return (data ?? []).length === 1
}

// ─────────────────────────────────────────────────────────────────────
// 規則區（packaging_ai_rules；append-only，最新一列＝目前規則）
// ─────────────────────────────────────────────────────────────────────

const rowToRules = (r: AiRulesRow): AiRulesVersion => ({
  id: Number(r.id), body: r.body, by: r.created_by, byName: r.created_by_name ?? null, at: r.created_at,
})

export async function getLatestRules(sb: SupabaseAdmin): Promise<AiRulesVersion | null> {
  const { data, error } = await sb.from(AI_TBL.rules).select('*').order('id', { ascending: false }).limit(1)
  if (error) throw new ScheduleDbError('讀取規則', error)
  const r = ((data ?? []) as AiRulesRow[])[0]
  return r ? rowToRules(r) : null
}

export async function getRulesVersion(sb: SupabaseAdmin, id: number): Promise<AiRulesVersion | null> {
  const { data, error } = await sb.from(AI_TBL.rules).select('*').eq('id', id).maybeSingle()
  if (error) throw new ScheduleDbError('讀取規則', error)
  return data ? rowToRules(data as AiRulesRow) : null
}

/** 最近 N 版（新 → 舊；不回全文，只回字數） */
export async function listRulesHistory(sb: SupabaseAdmin, limit = AI_RULES_HISTORY_LIMIT): Promise<AiRulesMeta[]> {
  const { data, error } = await sb.from(AI_TBL.rules).select('id, body, created_by_name, created_at')
    .order('id', { ascending: false }).limit(limit)
  if (error) throw new ScheduleDbError('讀取規則', error)
  return ((data ?? []) as Pick<AiRulesRow, 'id' | 'body' | 'created_by_name' | 'created_at'>[]).map((r) => ({
    id: Number(r.id), byName: r.created_by_name ?? null, at: r.created_at, length: [...(r.body ?? '')].length,
  }))
}

/** 新增一版（baseId 衝突檢查由 route 先做：getLatestRules().id !== baseId → rules_conflict） */
export async function insertRules(
  sb: SupabaseAdmin,
  v: { body: string; actorEmail: string; actorName: string | null; nowIso: string },
): Promise<AiRulesVersion> {
  const { data, error } = await sb.from(AI_TBL.rules).insert({
    body: v.body, created_by: v.actorEmail, created_by_name: v.actorName, created_at: v.nowIso,
  }).select('*').single()
  if (error) throw new ScheduleDbError('儲存規則', error)
  return rowToRules(data as AiRulesRow)
}

// ─────────────────────────────────────────────────────────────────────
// 大量門檻表（packaging_bulk_thresholds；D92）
// ─────────────────────────────────────────────────────────────────────

const rowToThreshold = (r: BulkThresholdRow): BulkThreshold => ({
  key: r.key, threshold: Number(r.threshold), note: r.note ?? null, updatedByName: r.updated_by_name ?? null, updatedAt: r.updated_at,
})

/** 全表（≤ AI_THRESHOLDS_MAX_ROWS 列），依 key 排序 */
export async function listThresholds(sb: SupabaseAdmin): Promise<BulkThreshold[]> {
  const { data, error } = await sb.from(AI_TBL.thresholds).select('*').order('key', { ascending: true })
  if (error) throw new ScheduleDbError('讀取門檻表', error)
  return ((data ?? []) as BulkThresholdRow[]).map(rowToThreshold)
}

/**
 * 整表替換（PUT thresholds；輸入已由 route 驗證：key trim 後 1～30 字且不重複、門檻整數 1～1,000,000、備註 ≤ 200 字）。
 * 沒有交易 → 先 upsert 新表內容、再刪掉不在新表裡的 key：中途失敗最多留下「多出來的舊 key」（超集合），不會整表變空。
 * 值沒變的列不重寫（updated_by／updated_at 保留原本是誰改的）。回傳替換後的全表。
 */
export async function replaceThresholds(
  sb: SupabaseAdmin,
  rows: readonly BulkThresholdInput[],
  actor: { email: string; name: string | null },
  nowIso: string,
): Promise<BulkThreshold[]> {
  const before = await listThresholds(sb)
  const prev = new Map(before.map((t) => [t.key, t]))
  const nextKeys = new Set(rows.map((r) => r.key))
  const changed = rows.filter((r) => {
    const p = prev.get(r.key)
    return !p || p.threshold !== r.threshold || (p.note ?? null) !== (r.note ?? null)
  })
  if (changed.length > 0) {
    const { error } = await sb.from(AI_TBL.thresholds).upsert(changed.map((r) => ({
      key: r.key, threshold: r.threshold, note: r.note ?? null, updated_by: actor.email, updated_by_name: actor.name, updated_at: nowIso,
    })), { onConflict: 'key' })
    if (error) throw new ScheduleDbError('儲存門檻表', error)
  }
  const removed = before.map((t) => t.key).filter((k) => !nextKeys.has(k))
  for (const part of chunks(removed, 100)) {
    const { error } = await sb.from(AI_TBL.thresholds).delete().in('key', part)
    if (error) throw new ScheduleDbError('刪除門檻', error)
  }
  return listThresholds(sb)
}

// ─────────────────────────────────────────────────────────────────────
// 操作紀錄（packaging_op_log；沿用既有 insertOpLog）
// ─────────────────────────────────────────────────────────────────────

/**
 * AI 相關的 op_log。scheduleDb.OpLogKind 是正式區共用的既有聯集（禁改檔的既有行為，不去擴充它）；
 * DB 端 kind check 已由 sql/20260928b 第 6 段放寬，這裡轉型後沿用既有 insertOpLog（失敗只 console.error、不擋回應）。
 * ⚠ ops 只放「做了什麼」的結構（runId、範圍、PlacementOp、門檻前後值…），絕不放 payload、客戶對照、AI 輸出。
 */
export async function insertAiOpLog(
  sb: SupabaseAdmin,
  e: { actorEmail: string; actorName: string | null; kind: AiOpLogKind; label?: string | null; ops: unknown },
): Promise<number | null> {
  return insertOpLog(sb, { ...e, kind: e.kind as unknown as OpLogKind })
}
