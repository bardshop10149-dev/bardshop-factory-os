// 包裝專區 P3 AI 模擬排程 — 背景執行一次 AI 排程（伺服器端，規格 §4.1 步驟 6；D91 LOG、D95 失敗處理）
//
// 呼叫方式：POST /api/packaging/ai/session/run 建好 run 列、佔好執行位（db.claimRunSlot）後，
//   `after(() => executeRun(runId))`（Next 16 next/server 的 after；route 設 maxDuration = 300、runtime 'nodejs'、dynamic 'force-dynamic'）。
//   after 裡丟出的例外沒有人接 → executeRun **絕不丟例外**（全部 catch，寫進 run 列）。
//
// 為什麼是「建 run 列 → 背景跑 → 前端輪詢」而不是同步等回應：AI 要思考 1～3 分鐘，主管可能關分頁、網路可能斷，
//   同步請求的結果就沒人收了；結果寫進 DB 就不會遺失，關掉再開也看得到（盤點 code-map §6.2 方案 C）。
// 時間預算：route maxDuration 300 秒 → 內部總預算 AI_RUN_BUDGET_MS（270 秒，AbortController 傳給 callClaude），
//   留約 30 秒給驗算與寫回；逾時以 ai_timeout 記入 run，模擬區不變。
//
// 硬規則：不得 console.log payload、客戶對照（keyMap）、AI 輸出；錯誤 log 只記 `[packaging/ai/run] #<runId> <error_code>`＋錯誤類別。
//   不寫 packaging_placements（模擬結果只寫 packaging_sim_sessions／packaging_ai_runs）。

import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { ScheduleDbError, type SupabaseAdmin } from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'
import {
  PoolUnavailableError,
  aiMigrationMessage,
  clearRunningRun,
  getAiRun,
  getLatestRules,
  getSimSessionById,
  isAiMissingSchema,
  listThresholds,
  loadSimWorld,
  updateAiRun,
  updateSimSessionCas,
} from '@/lib/packaging/ai/db'
import { assembleSimBoard, isRowLocked, pushUndo, snapshotForUndo } from '@/lib/packaging/ai/simState'
import { emptySimCapacity, withSimCapacity } from '@/lib/packaging/ai/simCapacity'
import { buildAiPayload, decodeAiText, scanPayloadLeaks } from '@/lib/packaging/ai/payload'
import { validateAiResult } from '@/lib/packaging/ai/validate'
import { AiError, callClaude, isAiConfigured } from '@/lib/packaging/ai/claude'
import {
  AI_RUN_BUDGET_MS,
  SIM_MAX_PLACEMENTS,
  type AiErrorCode,
  type AiPayloadMeta,
  type AiRun,
  type SimSession,
  type SimSessionState,
  type ValidationReport,
} from '@/lib/packaging/ai/types'

/**
 * executeRun 用到的外部依賴（DB、純函式、Claude）。正式呼叫一律用預設值；單元測試傳入替身，
 * 才能在不連 DB、不連網路的情況下驗證「CAS 失敗 → applied false」「任何失敗都寫進 run 列、絕不丟例外、log 不帶內容」等流程。
 */
export const RUNNER_DEPS = {
  getClient: (): SupabaseAdmin => getSupabaseAdminClient(),
  getAiRun,
  getSimSessionById,
  loadSimWorld,
  getLatestRules,
  listThresholds,
  updateAiRun,
  updateSimSessionCas,
  clearRunningRun,
  assembleSimBoard,
  buildAiPayload,
  scanPayloadLeaks,
  decodeAiText,
  validateAiResult,
  callClaude,
  isAiConfigured,
  pushUndo,
  snapshotForUndo,
  isRowLocked,
  newId: (): string => crypto.randomUUID(),
  nowMs: (): number => Date.now(),
  budgetMs: AI_RUN_BUDGET_MS,
}
export type RunnerDeps = typeof RUNNER_DEPS

/**
 * 可安全寫進伺服器 log 的錯誤描述：只有類別名稱、ScheduleDbError 的動作標籤與 Postgres 錯誤碼。
 * 為什麼不 log e.message：jsonb check 失敗的 details 是 'Failing row contains (…)'（會帶出 payload／AI 理由），
 *   JSON.parse 的錯誤訊息也會引用一段輸入原文——Vercel log 會留存，一律不印（規格 §4.1）。
 */
export function safeErrorTag(e: unknown): string {
  if (e instanceof ScheduleDbError) return `ScheduleDbError(${e.message.split('：')[0]}／${e.pgCode ?? '-'})`
  if (e instanceof AiError) return `AiError(${e.code}${e.status ? `／${e.status}` : ''})`
  if (e instanceof Error) return e.name || 'Error'
  return typeof e
}

/** 例外 → run.error_code／error_message（繁中、給主管看得懂，D95） */
function toRunFailure(e: unknown, runId: number): { code: AiErrorCode; message: string } {
  if (e instanceof AiError) return { code: e.code, message: e.message }
  if (e instanceof PoolUnavailableError) {
    return { code: 'pool_unavailable', message: '待排池暫時無法組裝（ERP／塔台資料讀取失敗），這次沒有排程；請稍後再試' }
  }
  if (isAiMissingSchema(e)) return { code: 'internal', message: aiMigrationMessage(e) }
  if (e instanceof ScheduleDbError) {
    return { code: 'internal', message: `讀寫資料庫時發生錯誤${e.pgCode ? `（${e.pgCode}）` : ''}，這次沒有寫入模擬區；請稍後再試（AI 執行 #${runId}）` }
  }
  return { code: 'internal', message: `準備資料或驗算時發生未預期的錯誤，這次沒有寫入模擬區；請通知管理員（AI 執行 #${runId}）` }
}

/** 候選 0 張時不呼叫 AI，直接給一份「什麼都沒做」的驗算報告（欄位照填，畫面不必特判） */
function emptyReport(meta: AiPayloadMeta, base: SimSessionState, isLocked: RunnerDeps['isRowLocked']): ValidationReport {
  return {
    applied: true,
    accepted: 0,
    adjusted: [],
    dropped: [],
    capacityTrimmed: [],
    overtimeUsed: [],
    unknownMinutes: meta.unknownMinutes,
    noThresholdCategories: meta.noThresholdCategories,
    notSent: meta.notSent,
    keptCopy: 0,
    lockedKept: base.placements.filter((p) => isLocked(p, base.locks)).length,
    resultCount: base.placements.length,
    aiUnplaced: [],
    aiWarnings: [],
    aiOvertime: [],
    ruleSuggestions: [],
  }
}

/**
 * 只取 undo 需要的六個欄位。刻意不直接把 SimSession 丟給 snapshotForUndo：SimSession 身上還有 undo 堆疊本身，
 * 萬一被一起拷進快照，每推一格就把整個堆疊再包一層，大小會指數成長（DB 8MB 上限很快爆掉）。
 */
export function stateOf(s: SimSessionState): SimSessionState {
  return {
    horizon: s.horizon, mode: s.mode, windowDates: s.windowDates, lineIds: s.lineIds, placements: s.placements, locks: s.locks,
    // D101：模擬產能一起進 undo 快照（沒有這欄的狀態不帶這個鍵）
    ...(s.simCapacity !== undefined ? { simCapacity: s.simCapacity } : {}),
  }
}

/**
 * 建 run 當下的模擬區狀態（AI 要排的「基底」）：擺放與鎖定取 run 列（建 run 時存下的），範圍與模式也取 run 列；
 * 線別 run 列沒存 → 用目前 session 的（線只有「重設」會換；重設後版本一定變，結果本來就寫不回、只留在 run 裡）。
 * D101 模擬產能：取 run 列（建 run 當下的覆寫，與 base_placements 同一時點）。run.simCapacity 為 null＝建 run 時沒有覆寫
 *   （只有非空才寫入），或舊程式建的 run（舊 runner 本來就只用正式產能）→ 一律當空覆寫。
 *   為什麼不退回用目前 session 的：AI 執行中不能改模擬產能，但「退回上一步」可以把舊的覆寫換回來；用 run 列才與建 run 時一致。
 */
function baseStateOf(run: AiRun, session: SimSession): SimSessionState {
  return {
    horizon: run.horizon,
    mode: run.mode,
    windowDates: run.windowDates,
    lineIds: session.lineIds,
    placements: run.basePlacements,
    locks: run.locks,
    simCapacity: run.simCapacity ?? emptySimCapacity(),
  }
}

/**
 * 流程（規格 §4.1 步驟 6）：
 * 1. 讀 run（不存在或不是 running → 結束）、讀 session（不存在 → failed 'session_gone'）。
 * 2. preparing：loadSimWorld（讀法同正式工作台：待排池經 getManualMergedPool、線、產能、擺放）＋最新規則＋門檻表
 *    → assembleSimBoard → buildAiPayload → 送出前檢查 scanPayloadLeaks（fail-closed：仍有疑似個資 → failed 'ai_pii_blocked'，
 *    payload 不存、不送；訊息只列欄位不列內容）→ run 更新 phase 'thinking'＋payload（去識別化，D84）＋rulesId＋門檻快照。
 *    候選 0 張 → 不呼叫 AI，直接 done（summary「沒有可排的卡」、result = base）。
 * 3. thinking：callClaude(payload, { signal })（總預算 AbortController）。
 * 4. validating：validateAiResult（程式驗算與修正，AI 只給建議，D85）。
 * 5. 寫回模擬區：version CAS 用 run.baseVersion——AI 跑的期間主管在模擬區動過（version 已變）→ 不寫回、report.applied = false，
 *    結果只存在 run 裡（UI 提示可從歷史載入）。寫回時先把 AI 前狀態推進 undo（「退回上一步」可回到 AI 前），並一併清掉 running_run_id。
 * 6. run 更新 done：resultPlacements、aiOutput（原文，代號未換回）、validation、summary（代號換回，decodeAiText）、model、usage、耗時。
 * 7. finally：clearRunningRun（CAS 寫回成功時已清；只清「目前佔位的就是這個 run」，重複清無害）。
 * 任何例外 → run failed（error_code／繁中訊息）、模擬區不變、清 running_run_id；更新 run 列本身也失敗時只 log 錯誤類別。
 */
export async function executeRun(runId: number, deps: Partial<RunnerDeps> = {}): Promise<void> {
  const d: RunnerDeps = { ...RUNNER_DEPS, ...deps }
  const startedMs = d.nowMs()
  const ac = new AbortController()
  const budget = setTimeout(() => ac.abort(), d.budgetMs)
  let sb: SupabaseAdmin | null = null
  let sessionId: number | null = null
  /** 已寫回模擬區（之後的步驟失敗時，錯誤訊息要講清楚「模擬區已更新」） */
  let wroteSession = false
  try {
    sb = d.getClient()
    const run = await d.getAiRun(sb, runId)
    if (!run || run.status !== 'running') return
    sessionId = run.sessionId
    const session = await d.getSimSessionById(sb, run.sessionId)
    if (!session) {
      throw new AiError('session_gone', '模擬區已不存在（可能已被刪除），這次 AI 排程沒有寫入')
    }

    // ── preparing ──
    const nowMs = d.nowMs()
    const today = todayTaipei(new Date(nowMs))
    const nowIso = new Date(nowMs).toISOString()
    const [liveWorld, rules, thresholds] = await Promise.all([
      d.loadSimWorld(sb, { today, nowIso, actor: { email: run.ownerEmail, name: run.ownerName } }),
      d.getLatestRules(sb),
      d.listThresholds(sb),
    ])
    const base = baseStateOf(run, session)
    const baseSession = { ...base, ownerEmail: session.ownerEmail, ownerName: session.ownerName, updatedAt: session.updatedAt }
    // D101：AI 在「建 run 當下的模擬產能」下排——疊一次，之後組工作台（各線 used／remaining）、payload（各線各日分鐘）、
    //   驗算（產能削減、模擬開的週末＝可排日）全部從這個 world 讀，validate／payload 不必知道哪些是模擬值
    const world = withSimCapacity(liveWorld, baseSession)
    const board = d.assembleSimBoard(world, baseSession)
    const built = d.buildAiPayload({
      today,
      session: base,
      board,
      pool: world.pool,
      lines: world.lines,
      rules: rules?.body ?? '',
      thresholds,
    })
    // 送出前最後一道（fail-closed，D84）：遮罩漏掉新的寫法時寧可不送；先檢查再存 payload（有疑似個資的 payload 也不留在 DB）
    const leaks = d.scanPayloadLeaks(built.payload, built.keyMap)
    if (leaks.length > 0) {
      const where = leaks.slice(0, 6).join('、') + (leaks.length > 6 ? ` 等 ${leaks.length} 處` : '')
      throw new AiError('ai_pii_blocked', `送出前檢查發現疑似個資（${where}：電話、email、單號或客戶名稱樣式），已停止、沒有送給 AI；請修正品名／包裝方式或規則文字後再試，或通知管理員`)
    }
    await d.updateAiRun(sb, runId, { phase: 'thinking', payload: built.payload, rulesId: rules?.id ?? null, thresholds })

    if (built.payload.cards.length === 0) {
      const unknown = built.meta.unknownMinutes.count
      await d.updateAiRun(sb, runId, {
        status: 'done',
        phase: 'done',
        resultPlacements: base.placements,
        aiOutput: null,
        validation: emptyReport(built.meta, base, d.isRowLocked),
        summary: `沒有可排的卡：待排池裡沒有符合條件（可排區塊、未被鎖定、工時已知）的卡，所以沒有呼叫 AI，模擬區維持原樣。${unknown > 0 ? `另有 ${unknown} 張工時未知，請手動排。` : ''}`,
        durationMs: d.nowMs() - startedMs,
        finishedAt: new Date(d.nowMs()).toISOString(),
      })
      return
    }

    // ── thinking ──
    // route 建 run 前已擋過；這裡再防一次（金鑰在執行中被移除）
    if (!d.isAiConfigured()) throw new AiError('ai_not_configured', '尚未設定 AI 金鑰（ANTHROPIC_API_KEY），請通知管理員設定後再試')
    const ai = await d.callClaude(built.payload, { signal: ac.signal })

    // ── validating ──
    await d.updateAiRun(sb, runId, { phase: 'validating' })
    const v = d.validateAiResult({
      world,
      session: baseSession,
      keyMap: built.keyMap,
      meta: built.meta,
      output: ai.output,
      newId: d.newId,
    })
    if (v.placements.length > SIM_MAX_PLACEMENTS) {
      throw new AiError('internal', `AI 結果共 ${v.placements.length} 張，超過模擬區上限 ${SIM_MAX_PLACEMENTS} 張，沒有寫入；請縮小模擬範圍後再試`)
    }

    // ── 寫回模擬區（version CAS；undo 先推 AI 前狀態）──
    // CAS 成功＝目前模擬區的 version 仍是 baseVersion＝建 run 以來沒被動過 → 此時 session（開頭讀的）就是 AI 前狀態，undo 也是最新的
    const writeIso = new Date(d.nowMs()).toISOString()
    const updated = await d.updateSimSessionCas(sb, session.id, run.baseVersion, {
      placements: v.placements,
      undo: d.pushUndo(session.undo, d.snapshotForUndo(stateOf(session), `AI 排程 #${runId}`, 'ai_run', writeIso)),
      runningRunId: null,
    }, writeIso)
    wroteSession = updated != null
    const report: ValidationReport = { ...v.report, applied: wroteSession }

    await d.updateAiRun(sb, runId, {
      status: 'done',
      phase: 'done',
      errorCode: null,
      errorMessage: null,
      resultPlacements: v.placements,
      aiOutput: ai.output,
      validation: report,
      summary: d.decodeAiText(ai.output.summary, built.keyMap),
      model: ai.model,
      usage: ai.usage,
      durationMs: d.nowMs() - startedMs,
      finishedAt: new Date(d.nowMs()).toISOString(),
    })
  } catch (e) {
    const f = toRunFailure(e, runId)
    console.error(`[packaging/ai/run] #${runId} ${f.code} ${safeErrorTag(e)}`)
    if (sb) {
      const message = wroteSession
        ? `AI 結果已寫入模擬區，但執行紀錄儲存失敗（${f.message}）；可在模擬區按「退回上一步」回到 AI 前`
        : f.message
      try {
        await d.updateAiRun(sb, runId, {
          status: 'failed',
          phase: 'failed',
          errorCode: f.code,
          errorMessage: message,
          durationMs: d.nowMs() - startedMs,
          finishedAt: new Date(d.nowMs()).toISOString(),
        })
      } catch (e2) {
        // 連失敗狀態都寫不進去：run 會停在 running，6 分鐘後下一次按 AI 時由 route 標成 ai_stale
        console.error(`[packaging/ai/run] #${runId} 無法寫入失敗狀態 ${safeErrorTag(e2)}`)
      }
    }
  } finally {
    clearTimeout(budget)
    if (sb && sessionId != null) {
      try {
        await d.clearRunningRun(sb, sessionId, runId)
      } catch (e3) {
        console.error(`[packaging/ai/run] #${runId} 無法釋放執行位 ${safeErrorTag(e3)}`)
      }
    }
  }
}
