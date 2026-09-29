import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { LockAction, LockResponse } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { evaluateLock, planLockAction } from '@/lib/packaging/scheduleLock'
import { isUuid } from '@/lib/packaging/scheduleOps'
import { casLock, ensureLockRow, insertOpLog, publicDbError } from '@/lib/packaging/scheduleDb'

export const dynamic = 'force-dynamic'

// 包裝專區 P1：編輯鎖（D53）。規格 §3.7、§四.6
//
// POST LockRequest { action: acquire | heartbeat | release | takeover, token?, active? } → LockResponse
//   - 全部需要 packaging_admin（admin 自動通過，D30）；Content-Type 必須 application/json
//     （release 由頁面 pagehide 以 sendBeacon 送 Blob type=application/json，同源帶 cookie）
//   - 流程：讀鎖列 → planLockAction（純函式）→ 以 token 為條件的 compare-and-set UPDATE；0 列＝期間有人搶先 → 重讀重算一次
//   - 只有 acquire／takeover 成功才回 token（只給本人；其他人從 GET board 只看得到持有者名字與時間）
//   - 5 分鐘無動作即視為釋放（讀取時判斷），不需要清鎖排程；心跳 30 秒一次，active=true 才延長
// 只寫 packaging_edit_lock／packaging_op_log。

const ACTIONS: ReadonlySet<string> = new Set<LockAction>(['acquire', 'heartbeat', 'release', 'takeover'])
type Fail = Extract<LockResponse, { success: false }>

export async function POST(request: NextRequest) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  const action = body?.action
  if (!body || typeof action !== 'string' || !ACTIONS.has(action)) {
    return noStore<Fail>({ success: false, error: 'action 必須是 acquire／heartbeat／release／takeover', code: 'bad_request' }, 400)
  }
  const act = action as LockAction
  const token = isUuid(body.token) ? body.token : null
  const caller = { email: g.member.email, name: g.member.realName, token, active: body.active === true }

  try {
    const sb = getSupabaseAdminClient()
    let row = await ensureLockRow(sb)
    for (let attempt = 0; attempt < 2; attempt++) {
      const nowMs = Date.now()
      const plan = planLockAction(act, row, caller, nowMs, () => crypto.randomUUID())
      if (plan.kind === 'reject') {
        const lock = evaluateLock(row, nowMs, caller)
        const error = plan.code === 'held_by_other'
          ? `${lock.holderName ?? lock.holderEmail ?? '其他人'} 正在編輯中`
          : '編輯權已被接手或已逾時釋放'
        return noStore<Fail>({ success: false, error, code: plan.code, lock }, 409)
      }
      if (plan.kind === 'noop') {
        return noStore<LockResponse>({ success: true, lock: evaluateLock(row, nowMs, caller) })
      }
      const updated = await casLock(sb, plan)
      if (!updated) {
        // compare-and-set 失敗：期間有人搶先（接手或另一個分頁取得）→ 重讀重算一次
        row = await ensureLockRow(sb)
        continue
      }
      const myToken = plan.newToken ?? (updated.token && updated.token === token ? token : null)
      const lock = evaluateLock(updated, nowMs, { email: caller.email, token: myToken })
      if (act !== 'heartbeat') {
        await insertOpLog(sb, { actorEmail: caller.email, actorName: caller.name, kind: 'lock', label: act, ops: [{ action: act, takeover: act === 'takeover' ? updated.prev_holder_email : undefined }] })
      }
      const res: LockResponse = (act === 'acquire' || act === 'takeover') && myToken
        ? { success: true, lock, token: myToken }
        : { success: true, lock }
      return noStore(res)
    }
    const lock = evaluateLock(row, Date.now(), caller)
    return noStore<Fail>({
      success: false, lock,
      code: act === 'heartbeat' ? 'lock_lost' : 'held_by_other',
      error: '編輯鎖剛被其他人更新，請重試',
    }, 409)
  } catch (e) {
    console.error('[packaging/lock]', describeError(e))
    return noStore<Fail>({ success: false, error: publicDbError(e), code: 'db_error' }, 500)
  }
}
