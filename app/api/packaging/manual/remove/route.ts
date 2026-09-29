import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { ADJUST_REASON_MAX, type ManualMutationResponse } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { getPool, POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { isLineKey } from '@/lib/packaging/scheduleOps'
import { normalPoolLineKeys } from '@/lib/packaging/manualPool'
import { invalidateManualCache } from '@/lib/packaging/manualCache'
import { loadActiveInclusionByKey, removeInclusion, unremoveInclusion } from '@/lib/packaging/manualDb'
import {
  insertOpLog,
  isMissingSchema,
  linesMigrationMessage,
  loadPlacementsByLines,
  publicDbError,
} from '@/lib/packaging/scheduleDb'

export const dynamic = 'force-dynamic'

// 包裝專區 P1 分線輪：D66 手動加入「移出待排池」（軟刪除，紀錄保留）。規格 docs/design/2026-09-27-packaging-lines.md §六.3
//
// POST ManualRemoveRequest { soLineKey, reason? }（packaging_admin）→ ManualMutationResponse
//   該行在正常區塊沒有卡、且還有未完成擺放 → manual_has_placements（409，附 cardCount；請先放回待排池——
//   否則手動供給消失後那些卡會變成「行已不在待排池」而被讀取時略過）。已完成擺放不擋。
// 為什麼用 POST 子路徑而不是 DELETE：與既有寫入 API 一致只收 JSON body（DELETE 帶 body 在部分代理會被丟），且移出是軟刪除。
// 寫 op_log（kind 'manual'）、不進 Undo。只寫 packaging_manual_inclusions／packaging_op_log。
// D102：不再要求編輯鎖（理由見 ../route.ts 檔頭）；lockToken 送了也忽略、回應不帶 lock。
//   「有未完成排定卡就不能移出」這道檢查照舊——它才是讓工作台排程不壞掉的關鍵，與誰持有編輯鎖無關。
//   沒有鎖就沒有序列化：這道檢查改成「先讀（快速擋下）→ 寫 → 再讀（抓到剛好同時排進來的卡就撤回）」，
//   與工作台那邊的寫後回讀（manualReconcile.ts）成對，才把併發窗口關掉（見 manualPool.ts「D102 寫後回讀」說明）。

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
    const cur = await loadActiveInclusionByKey(sb, key)
    if (!cur) return fail(404, { code: 'not_found', error: '找不到有效的手動加入紀錄（可能已移出）' })

    const [placements, pool] = await Promise.all([
      loadPlacementsByLines(sb, [key]),
      getPool({ maxAgeMs: POOL_WRITE_MAX_AGE_MS }),
    ])
    const open = placements.filter((p) => !p.completed).length
    if (open > 0 && !normalPoolLineKeys(pool).has(key)) {
      return fail(409, { code: 'manual_has_placements', cardCount: open, error: `這個品項還有 ${open} 張未完成的排定卡，請先到排程工作台把它們拖回待排池再移出` })
    }

    const removed = await removeInclusion(sb, cur.inclusionId, actor, reason, nowIso)
    if (!removed) return fail(404, { code: 'not_found', error: '找不到有效的手動加入紀錄（可能已移出）' })
    invalidateManualCache()

    // D102 寫後回讀（write-then-read-back）：拿掉編輯鎖後，工作台（持鎖者）可能正好在「上面讀擺放」與「寫 removed_at」之間
    //   排了這張卡（它讀供給時紀錄還在 → 驗證通過）。寫完再讀一次擺放：看到未完成排定卡 → 撤回這次移出、回 409。
    //   工作台那邊也會「寫完擺放再讀紀錄」（manualReconcile.ts），兩邊至少有一邊看得到另一邊 → 排定卡不會沒了供給。
    const openAfter = (await loadPlacementsByLines(sb, [key])).filter((p) => !p.completed).length
    if (openAfter > 0 && !normalPoolLineKeys(pool).has(key)) {
      const back = await unremoveInclusion(sb, cur.inclusionId, { removedAt: removed.removedAt }, actor, new Date().toISOString())
      invalidateManualCache()
      // 'duplicate'＝同一行剛被別人重新加入：新紀錄已提供供給，這次移出照樣成立（往下記 op_log）
      if (back !== 'duplicate') {
        if (back == null) console.error(`[packaging/manual/remove] ${key} 撤回移出時紀錄已被改動（CAS 未命中）`)
        return fail(409, { code: 'manual_has_placements', cardCount: openAfter, error: `排程工作台剛好在排這個品項（現在有 ${openAfter} 張未完成的排定卡），這次沒有移出；請先到排程工作台把它們拖回待排池再移出` })
      }
    }

    const opId = await insertOpLog(sb, {
      actorEmail: actor.email, actorName: actor.name, kind: 'manual', label: `移出手動加入 ${key}`,
      ops: [{ action: 'remove', id: cur.inclusionId, soLineKey: key, qty: cur.qty, reason }],
    })
    return noStore<ManualMutationResponse>({ success: true, inclusions: [removed], skipped: [], revision: `m${opId ?? nowMs}` })
  } catch (e) {
    console.error('[packaging/manual/remove]', describeError(e))
    if (isMissingSchema(e)) return fail(409, { code: 'migration_required', error: linesMigrationMessage(e) })
    return fail(500, { code: 'db_error', error: publicDbError(e) })
  }
}
