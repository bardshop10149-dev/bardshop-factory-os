import { after, type NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { todayTaipei } from '@/lib/packaging/workdays'
import {
  claimRunSlot,
  getAiRunSummary,
  insertAiRun,
  isSimSessionStale,
  latestAiRunStartedAt,
  markStaleAiRunFailed,
  updateAiRun,
} from '@/lib/packaging/ai/db'
import { isAiConfigured } from '@/lib/packaging/ai/claude'
import { executeRun, safeErrorTag } from '@/lib/packaging/ai/runner'
import { AI_RUN_STALE_MS, AI_RUN_THROTTLE_MS, type SimRunResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, loadOwnSession, logAi, parseVersion } from '../../_lib/aiRoute'

// AI 思考 1～3 分鐘：本 route 的函式上限拉到 300 秒（after() 裡的背景工作也算在這次呼叫的時間內），
// runner 內部預算 270 秒（AI_RUN_BUDGET_MS），留 30 秒寫回。runtime 明寫 nodejs：SDK 與 crypto.randomUUID 都在 Node 端。
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// 包裝專區 P3：AI 排程（規格 §4.1；D85／D91／D95）
//
// POST SimRunRequest { version } → SimRunResponse { runId }（立即回應；AI 在背景跑，前端每 3 秒 GET /api/packaging/ai/runs/[id]）
//   1. 自己的模擬區、version 相符、起始日未過（session_stale → 先重設）
//   2. 同時只允許一個執行中：running_run_id 指到仍在跑的 run → run_in_progress；超過 6 分鐘沒結束（實例被回收）→ 標 ai_stale、可重跑
//   3. 同一人 60 秒節流（連按兩次＝雙倍費用）
//   4. 未設定 ANTHROPIC_API_KEY → 400 ai_not_configured（D95），不建 run
//   5. 建 run 列（base_placements＝目前模擬列、base_version＝目前 version）→ 佔用執行位（CAS，不改 version）→ op_log ai_run
//   6. after(() => executeRun(runId))：回應送出後繼續跑（Next 16 next/server）
// 為什麼不需要正式區編輯鎖：AI 只寫模擬區與 run 列，正式排程完全不動（採用時才要鎖）。

export async function POST(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return aiFail('bad_request', '請求格式錯誤（須為 JSON 物件）')
  const version = parseVersion(body.version)
  if (version == null) return aiFail('bad_request', 'version 格式錯誤')

  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const own = await loadOwnSession(sb, me, version)
    if (!own.ok) return own.res
    const session = own.session
    if (isSimSessionStale(session, today)) {
      return aiFail('session_stale', '模擬區的起始日已經過了，請先重設模擬區（重新複製今天起的排程）再請 AI 排')
    }

    // 2. 同時只允許一個執行中
    let staleRunId: number | null = null
    if (session.runningRunId != null) {
      const cur = await getAiRunSummary(sb, session.runningRunId)
      const age = cur ? nowMs - Date.parse(cur.startedAt) : Infinity
      if (cur && cur.status === 'running' && age <= AI_RUN_STALE_MS) {
        return aiFail('run_in_progress', 'AI 正在排這個模擬區，請等它完成（約 1～3 分鐘）')
      }
      if (cur && cur.status === 'running') await markStaleAiRunFailed(sb, cur.id, nowIso)
      // 逾時標失敗後、或指到已結束／不存在的 run（上次釋放失敗）→ 這個位子可以接手
      staleRunId = session.runningRunId
    }

    // 3. 60 秒節流（以 run 列的開始時間為準，跨實例也有效）
    const last = await latestAiRunStartedAt(sb, me.email)
    if (last) {
      const wait = AI_RUN_THROTTLE_MS - (nowMs - Date.parse(last))
      if (wait > 0) return aiFail('throttled', `剛剛才請 AI 排過，請 ${Math.ceil(wait / 1000)} 秒後再試（避免重複計費）`)
    }

    // 4. 金鑰（D95）：沒設定就不建 run
    if (!isAiConfigured()) return aiFail('ai_not_configured', '尚未設定 AI 金鑰，請通知管理員設定 ANTHROPIC_API_KEY')

    // 5. 建 run 列 → 佔位（先建列才有 runId；佔位失敗就把剛建的列標失敗，LOG 仍留著）
    const run = await insertAiRun(sb, {
      sessionId: session.id,
      ownerEmail: me.email,
      ownerName: me.name,
      horizon: session.horizon,
      mode: session.mode,
      windowDates: session.windowDates,
      locks: session.locks,
      baseVersion: session.version,
      basePlacements: session.placements,
      // D101：AI 用建 run 當下的模擬產線時數排（只有非空才寫入 run 列；載入歷史時一併載回）
      simCapacity: session.simCapacity,
    }, nowIso)
    const claimed = await claimRunSlot(sb, session.id, session.version, run.id, staleRunId)
    if (!claimed) {
      await updateAiRun(sb, run.id, {
        status: 'failed', phase: 'failed', errorCode: 'internal',
        errorMessage: '模擬區剛被更新或已有另一個 AI 在執行，這次沒有開始；請重新載入後再試',
        durationMs: 0, finishedAt: new Date().toISOString(),
      }).catch((e: unknown) => console.error(`[packaging/ai/session/run] #${run.id} 標記失敗時出錯 ${safeErrorTag(e)}`))
      return aiFail('run_in_progress', '模擬區剛被更新或已有另一個 AI 在執行，請重新載入後再試')
    }

    await logAi(sb, me, 'ai_run', `AI 排程 #${run.id}`, [{
      action: 'run', runId: run.id, sessionId: session.id, horizon: session.horizon, mode: session.mode,
      windowDates: session.windowDates, placementCount: session.placements.length,
      locks: { placementIds: session.locks.placementIds.length, soNumbers: session.locks.soNumbers.length, lineIds: session.locks.lineIds },
    }])

    // 6. 背景執行（executeRun 保證不丟例外；這裡的 catch 只是保險）
    after(() => executeRun(run.id).catch((e: unknown) => console.error(`[packaging/ai/run] #${run.id} ${safeErrorTag(e)}`)))
    return noStore<SimRunResponse>({ success: true, runId: run.id })
  } catch (e) {
    return aiServerError('session/run', e, '開始 AI 排程')
  }
}
