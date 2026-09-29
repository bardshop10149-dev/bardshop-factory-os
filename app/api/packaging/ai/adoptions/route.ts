import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore } from '@/lib/packaging/guard'
import { listAdoptions } from '@/lib/packaging/ai/db'
import { AI_ADOPTIONS_LIST_LIMIT, type AdoptionsListResponse } from '@/lib/packaging/ai/types'
import { aiServerError } from '../_lib/aiRoute'

export const dynamic = 'force-dynamic'

// 包裝專區 P3：AI 採用紀錄（規格 §6.2；D82／D86）
//
// GET → AdoptionsListResponse：最近 AI_ADOPTIONS_LIST_LIMIT（20）筆（新 → 舊）：誰、何時、範圍、張數、是否已退回。
//   不分人（採用改的是大家共用的正式排程）；canRevert 只有「最近一筆未退回」為 true（較早的要先退回較新的）。
//   正式工作台的「AI 採用紀錄」按鈕（AdoptionsDialog）用。

export async function GET() {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  try {
    const sb = getSupabaseAdminClient()
    const adoptions = await listAdoptions(sb, AI_ADOPTIONS_LIST_LIMIT)
    return noStore<AdoptionsListResponse>({ success: true, adoptions })
  } catch (e) {
    return aiServerError('adoptions GET', e, '讀取採用紀錄')
  }
}
