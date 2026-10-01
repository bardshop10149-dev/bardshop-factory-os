import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore } from '@/lib/packaging/guard'
import { getAiRunSummary, listSimOwners, toRunStatusInfo } from '@/lib/packaging/ai/db'
import type { AiRunDetail, AiRunDetailResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, parsePositiveId, sameEmail } from '../../_lib/aiRoute'
import { sameWorkdays } from '@/lib/packaging/ai/simCapacity'

export const dynamic = 'force-dynamic'

// 包裝專區 P3：AI 執行詳情與輪詢（規格 §4.1 步驟 5；D91）
//
// GET → AiRunDetailResponse：{ status, phase, elapsedMs（伺服器算）, 摘要, 驗算報告, 用量… }；前端每 3 秒（AI_POLL_MS）輪詢到 done／failed。
//   不讀 payload、擺放本體與 AI 原文（db.getAiRunSummary 只選需要的欄位），輪詢很便宜。
//   canLoad：done 且是自己的 run、且與自己目前模擬區的 horizon／window 相同（可從歷史載入）。只在 run 結束後才查模擬區摘要。
//   D101：window 改比「工作日」（模擬開的週末會讓 window 不同；載入時一律連 window 與那次的模擬產能一起載回，
//   沒存模擬產能的 run＝空覆寫，與 load-run 的 planLoadRunCapacity 同一個判斷 → canLoad 與實際能不能載一致）。
//   執行中但超過 AI_RUN_STALE_MS（route 上限 + 60 秒）：GET 不寫入，照回 running＋elapsedMs＋stale: true（db.toRunStatusInfo），
//   畫面據以停止輪詢、解除封鎖並提示「可能已中斷，可重新執行」（下一次按 AI 時 POST session/run 會把它標成 ai_stale）。

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, ctx: Ctx) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const id = parsePositiveId((await ctx.params).id)
  if (id == null) return aiFail('bad_request', 'AI 執行編號錯誤')
  const me = actorOf(g.member)
  const nowMs = Date.now()
  try {
    const sb = getSupabaseAdminClient()
    const run = await getAiRunSummary(sb, id)
    if (!run) return aiFail('not_found', `找不到 AI 執行 #${id}`)

    let canLoad = false
    if (run.status === 'done' && sameEmail(run.ownerEmail, me.email)) {
      // 只要 horizon／window：用摘要列表（不讀 placements／undo 大欄位）
      const mine = (await listSimOwners(sb)).find((o) => sameEmail(o.email, me.email))
      canLoad = !!mine && mine.horizon === run.horizon && sameWorkdays(mine.windowDates, run.windowDates)
    }
    const { baseVersion: _bv, ...rest } = run
    void _bv
    const st = toRunStatusInfo(run, nowMs)
    const detail: AiRunDetail = { ...rest, elapsedMs: st.elapsedMs, stale: st.stale, canLoad }
    return noStore<AiRunDetailResponse>({ success: true, run: detail })
  } catch (e) {
    return aiServerError('runs/[id] GET', e, '讀取 AI 執行紀錄')
  }
}
