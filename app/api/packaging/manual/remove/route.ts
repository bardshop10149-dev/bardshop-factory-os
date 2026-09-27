import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { ADJUST_REASON_MAX, type ManualMutationResponse } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { getPool, POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { isLineKey } from '@/lib/packaging/scheduleOps'
import { normalPoolLineKeys } from '@/lib/packaging/manualPool'
import { invalidateManualCache } from '@/lib/packaging/manualCache'
import { loadActiveInclusionByKey, removeInclusion } from '@/lib/packaging/manualDb'
import {
  insertOpLog,
  isMissingSchema,
  linesMigrationMessage,
  loadPlacementsByLines,
  publicDbError,
  verifyAndTouchLock,
} from '@/lib/packaging/scheduleDb'

export const dynamic = 'force-dynamic'

// 包裝專區 P1 分線輪：D66 手動加入「移出待排池」（軟刪除，紀錄保留）。規格 docs/design/2026-09-27-packaging-lines.md §六.3
//
// POST ManualRemoveRequest { lockToken, soLineKey, reason? }（packaging_admin＋編輯鎖）→ ManualMutationResponse
//   該行在正常區塊沒有卡、且還有未完成擺放 → manual_has_placements（409，附 cardCount；請先放回待排池——
//   否則手動供給消失後那些卡會變成「行已不在待排池」而被讀取時略過）。已完成擺放不擋。
// 為什麼用 POST 子路徑而不是 DELETE：與既有寫入 API 一致只收 JSON body（DELETE 帶 body 在部分代理會被丟），且移出是軟刪除。
// 寫 op_log（kind 'manual'）、不進 Undo。只寫 packaging_manual_inclusions／packaging_op_log（＋鎖續命）。

type Fail = Extract<ManualMutationResponse, { success: false }>
const fail = (status: number, body: Omit<Fail, 'success'>) => noStore<Fail>({ success: false, ...body }, status)

export async function POST(request: NextRequest) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return fail(400, { code: 'bad_request', error: '請求格式錯誤' })
  const key = typeof body.soLineKey === 'string' ? body.soLineKey.trim().toUpperCase() : ''
  if (!isLineKey(key)) return fail(400, { code: 'bad_request', error: '品項行格式錯誤' })
  if (body.reason != null && (typeof body.reason !== 'string' || body.reason.length > ADJUST_REASON_MAX)) {
    return fail(400, { code: 'bad_request', error: `原因最多 ${ADJUST_REASON_MAX} 字` })
  }
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const actor = { email: g.member.email, name: g.member.realName }
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: typeof body.lockToken === 'string' ? body.lockToken : null }, nowMs)
    if (!lk.ok) {
      return fail(409, { code: lk.code, lock: lk.lock, error: lk.code === 'lock_lost' ? '編輯權已被其他人接手' : '沒有編輯權或已逾時釋放，請重新取得編輯權' })
    }

    const cur = await loadActiveInclusionByKey(sb, key)
    if (!cur) return fail(404, { code: 'not_found', error: '找不到有效的手動加入紀錄（可能已移出）', lock: lk.lock })

    const [placements, pool] = await Promise.all([
      loadPlacementsByLines(sb, [key]),
      getPool({ maxAgeMs: POOL_WRITE_MAX_AGE_MS }),
    ])
    const open = placements.filter((p) => !p.completed).length
    if (open > 0 && !normalPoolLineKeys(pool).has(key)) {
      return fail(409, { code: 'manual_has_placements', cardCount: open, error: `這個品項還有 ${open} 張未完成的排定卡，請先放回待排池再移出`, lock: lk.lock })
    }

    const removed = await removeInclusion(sb, cur.inclusionId, actor, reason, nowIso)
    if (!removed) return fail(404, { code: 'not_found', error: '找不到有效的手動加入紀錄（可能已移出）', lock: lk.lock })
    invalidateManualCache()
    const opId = await insertOpLog(sb, {
      actorEmail: actor.email, actorName: actor.name, kind: 'manual', label: `移出手動加入 ${key}`,
      ops: [{ action: 'remove', id: cur.inclusionId, soLineKey: key, qty: cur.qty, reason }],
    })
    return noStore<ManualMutationResponse>({ success: true, inclusions: [removed], skipped: [], revision: `m${opId ?? nowMs}`, lock: lk.lock })
  } catch (e) {
    console.error('[packaging/manual/remove]', describeError(e))
    if (isMissingSchema(e)) return fail(409, { code: 'migration_required', error: linesMigrationMessage(e) })
    return fail(500, { code: 'db_error', error: publicDbError(e) })
  }
}
