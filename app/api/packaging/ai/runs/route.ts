import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore } from '@/lib/packaging/guard'
import { listAiRuns } from '@/lib/packaging/ai/db'
import { AI_RUN_HISTORY_LIMIT, type AiRunsListResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, parseOwnerParam } from '../_lib/aiRoute'

export const dynamic = 'force-dynamic'

// 包裝專區 P3：AI 執行 LOG 列表（規格 §三「歷史切換」、§九 預設第 1 點；D91）
//
// GET ?owner=<email> → AiRunsListResponse：某人最近 AI_RUN_HISTORY_LIMIT（10）次（新 → 舊；含失敗）。owner 省略＝自己。
//   只回 meta（摘要、狀態、耗時、用量、是否已寫回）；不含 payload、擺放本體與 AI 原文（那些只在伺服器端用）。

export async function GET(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const owner = parseOwnerParam(request.nextUrl.searchParams.get('owner'))
  if (owner === false) return aiFail('bad_request', 'owner 參數格式錯誤')
  try {
    const sb = getSupabaseAdminClient()
    const runs = await listAiRuns(sb, owner ?? actorOf(g.member).email, AI_RUN_HISTORY_LIMIT)
    return noStore<AiRunsListResponse>({ success: true, runs })
  } catch (e) {
    return aiServerError('runs GET', e, '讀取 AI 執行紀錄')
  }
}
