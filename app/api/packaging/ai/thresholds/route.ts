import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { listThresholds, replaceThresholds } from '@/lib/packaging/ai/db'
import {
  AI_THRESHOLD_KEY_MAX,
  AI_THRESHOLD_MAX,
  AI_THRESHOLD_MIN,
  AI_THRESHOLD_NOTE_MAX,
  AI_THRESHOLDS_MAX_ROWS,
  type BulkThresholdInput,
  type ThresholdsResponse,
} from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, logAi } from '../_lib/aiRoute'

export const dynamic = 'force-dynamic'

// 包裝專區 P3：大量門檻表（規格 §七、§4.4；D92）
//
// GET → ThresholdsResponse：全表（key＝品類名或品名關鍵字、門檻、備註、誰何時改）
// PUT ThresholdsPutRequest { rows: [{ key, threshold, note? }] } → ThresholdsResponse：整表替換（新增／修改／刪除一次送）
//   驗證：key 去頭尾空白後 1～30 字、不重複；門檻整數 1～1,000,000；備註 ≤ 200 字；最多 200 列。
//   op_log ai_threshold 記前後值（D92 變更留 LOG）。不需正式區編輯鎖（只影響之後 AI 的「大量」判定）。
// 大量判定由程式依本表先算好（payload 的 bulk），AI 不自己判（§4.4）。

export async function GET() {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  try {
    const sb = getSupabaseAdminClient()
    return noStore<ThresholdsResponse>({ success: true, rows: await listThresholds(sb) })
  } catch (e) {
    return aiServerError('thresholds GET', e, '讀取門檻表')
  }
}

/** 整表輸入驗證；錯誤回繁中訊息（第幾列哪一欄） */
function parseRows(raw: unknown): { ok: true; rows: BulkThresholdInput[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'rows 須為陣列' }
  if (raw.length > AI_THRESHOLDS_MAX_ROWS) return { ok: false, message: `門檻表最多 ${AI_THRESHOLDS_MAX_ROWS} 列` }
  const rows: BulkThresholdInput[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown> | null
    const at = `第 ${i + 1} 列`
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, message: `${at}格式錯誤` }
    const key = typeof r.key === 'string' ? r.key.trim() : ''
    const keyLen = [...key].length
    if (keyLen < 1 || keyLen > AI_THRESHOLD_KEY_MAX) return { ok: false, message: `${at}：品類／關鍵字須為 1～${AI_THRESHOLD_KEY_MAX} 字` }
    if (seen.has(key)) return { ok: false, message: `${at}：「${key}」重複了` }
    seen.add(key)
    const t = r.threshold
    if (typeof t !== 'number' || !Number.isInteger(t) || t < AI_THRESHOLD_MIN || t > AI_THRESHOLD_MAX) {
      return { ok: false, message: `${at}：門檻須為 ${AI_THRESHOLD_MIN}～${AI_THRESHOLD_MAX.toLocaleString('en-US')} 的整數` }
    }
    let note: string | null = null
    if (r.note != null) {
      if (typeof r.note !== 'string') return { ok: false, message: `${at}：備註須為文字` }
      const n = r.note.trim()
      if ([...n].length > AI_THRESHOLD_NOTE_MAX) return { ok: false, message: `${at}：備註最多 ${AI_THRESHOLD_NOTE_MAX} 字` }
      note = n === '' ? null : n
    }
    rows.push({ key, threshold: t, note })
  }
  return { ok: true, rows }
}

export async function PUT(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return aiFail('bad_request', '請求格式錯誤（須為 JSON 物件）')
  const parsed = parseRows(body.rows)
  if (!parsed.ok) return aiFail('bad_request', parsed.message)

  const me = actorOf(g.member)
  const nowIso = new Date().toISOString()
  try {
    const sb = getSupabaseAdminClient()
    const before = await listThresholds(sb)
    const rows = await replaceThresholds(sb, parsed.rows, me, nowIso)
    const brief = (list: readonly { key: string; threshold: number; note?: string | null }[]) =>
      list.map((r) => ({ key: r.key, threshold: r.threshold, note: r.note ?? null }))
    await logAi(sb, me, 'ai_threshold', `更新大量門檻表（${rows.length} 列）`, [{ before: brief(before), after: brief(rows) }])
    return noStore<ThresholdsResponse>({ success: true, rows })
  } catch (e) {
    return aiServerError('thresholds PUT', e, '儲存門檻表')
  }
}
