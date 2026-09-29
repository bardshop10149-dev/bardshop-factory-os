import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { getLatestRules, getRulesVersion, insertRules, listRulesHistory } from '@/lib/packaging/ai/db'
import {
  AI_RULES_HISTORY_LIMIT,
  AI_RULES_MAX,
  type AiRulesResponse,
  type AiRulesSaveResponse,
  type AiRulesVersionResponse,
} from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, logAi, parsePositiveId } from '../_lib/aiRoute'

export const dynamic = 'force-dynamic'

// 包裝專區 P3：主管建議規則區（規格 §七；D80／D81／D91）
//
// GET        → AiRulesResponse { current, history（最近 50 版，只有字數不含全文） }
// GET ?id=N  → AiRulesVersionResponse：某一版全文（「以此版為基礎編輯」用）
// POST AiRulesSaveRequest { body, baseId } → AiRulesSaveResponse：新增一版（append-only，最新一列＝目前規則；每次儲存留版本，D91）
//   baseId 是編輯時看到的版本 id；≠ 最新 → 409 rules_conflict（有人剛改過，避免把別人的修改蓋掉）。
//   內容與目前完全相同 → 不新增版本，直接回目前這版。不需正式區編輯鎖（規則只影響之後的 AI 排程）。
// AI 自己不會改規則：它只在 ruleSuggestions 提建議（D80），由主管決定要不要寫進來。

export async function GET(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const rawId = request.nextUrl.searchParams.get('id')
  try {
    const sb = getSupabaseAdminClient()
    if (rawId != null) {
      const id = parsePositiveId(rawId)
      if (id == null) return aiFail('bad_request', '規則版本編號錯誤')
      const version = await getRulesVersion(sb, id)
      if (!version) return aiFail('not_found', `找不到規則版本 #${id}`)
      return noStore<AiRulesVersionResponse>({ success: true, version })
    }
    const [current, history] = await Promise.all([getLatestRules(sb), listRulesHistory(sb, AI_RULES_HISTORY_LIMIT)])
    return noStore<AiRulesResponse>({ success: true, current, history })
  } catch (e) {
    return aiServerError('rules GET', e, '讀取規則')
  }
}

export async function POST(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return aiFail('bad_request', '請求格式錯誤（須為 JSON 物件）')
  if (typeof body.body !== 'string') return aiFail('bad_request', '規則內容須為文字')
  // 換行統一成 \n、去頭尾空白；字數以「字」計（同 DB char_length，emoji 算 1 字）
  const text = body.body.replace(/\r\n?/g, '\n').trim()
  const chars = [...text].length
  if (chars < 1 || chars > AI_RULES_MAX) return aiFail('bad_request', `規則內容須為 1～${AI_RULES_MAX} 字（目前 ${chars} 字）`)
  const baseId = body.baseId ?? null
  if (baseId !== null && !(typeof baseId === 'number' && Number.isSafeInteger(baseId) && baseId > 0)) {
    return aiFail('bad_request', 'baseId 格式錯誤')
  }

  const me = actorOf(g.member)
  const nowIso = new Date().toISOString()
  try {
    const sb = getSupabaseAdminClient()
    const latest = await getLatestRules(sb)
    if ((latest?.id ?? null) !== baseId) {
      return aiFail('rules_conflict', `規則剛被${latest?.byName ? ` ${latest.byName} ` : '其他人'}改過（目前是第 ${latest?.id ?? '-'} 版），請重新載入、確認後再儲存`)
    }
    if (latest && latest.body === text) return noStore<AiRulesSaveResponse>({ success: true, current: latest })
    const current = await insertRules(sb, { body: text, actorEmail: me.email, actorName: me.name, nowIso })
    await logAi(sb, me, 'ai_rules', `更新 AI 規則（第 ${current.id} 版）`, [{ rulesId: current.id, baseId, length: chars }])
    return noStore<AiRulesSaveResponse>({ success: true, current })
  } catch (e) {
    return aiServerError('rules POST', e, '儲存規則')
  }
}
