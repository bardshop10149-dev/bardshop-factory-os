// 包裝專區 P1 — 編輯鎖判定（純函式，規格 §3.7；D53）
//
// 單列鎖（packaging_edit_lock.id = 1）。設計重點：
// - 「逾時」是讀取時判斷的（now − last_action_at > 5 分鐘＝視為已釋放），所以不需要排程工作清鎖。
// - 身分用 email＋token：同一人開兩個分頁，只有拿到 token 的那一頁能寫；接手自己另一台電腦也走同一流程。
// - 本檔只「算出要怎麼改」（LockPlan），真正的更新由 scheduleDb.casLock 以 token 做 compare-and-set。
//
// 不 import supabase、不讀時鐘（nowMs 由參數傳入）；相對路徑 import、不用 enum。

import { LOCK_IDLE_MS, type EditLockRow, type LockAction, type LockPlan, type LockState } from './scheduleTypes'

/** 被接手的一方在多久內還看得到「已由 XXX 接手」 */
export const TAKEN_OVER_NOTICE_MS = 10 * 60_000

const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** 空鎖列（DB 還沒有 id=1 那列時用） */
export function emptyLockRow(): EditLockRow {
  return {
    id: 1, holder_email: null, holder_name: null, token: null, acquired_at: null, heartbeat_at: null,
    last_action_at: null, prev_holder_email: null, prev_holder_name: null, taken_over_at: null,
    updated_at: new Date(0).toISOString(),
  }
}

/** D53：有效持有＝有持有者，且最後動作距今 ≤ 5 分鐘 */
function isHeld(row: EditLockRow | null, nowMs: number): boolean {
  if (!row || !row.holder_email) return false
  const last = ms(row.last_action_at)
  return last != null && nowMs - last <= LOCK_IDLE_MS
}

/**
 * 鎖列 → 給畫面看的 LockState。
 * isMine：有效持有、email 相同（不分大小寫）、token 相同。
 * takenOverBy：呼叫者（帶著舊 token 的分頁）是 prev_holder、接手發生在 10 分鐘內、目前持有者不是他 → 顯示「已由 XXX 接手」。
 */
export function evaluateLock(row: EditLockRow | null, nowMs: number, caller: { email: string; token: string | null }): LockState {
  const held = isHeld(row, nowMs)
  const last = ms(row?.last_action_at)
  const isMine = held && !!caller.token && sameEmail(row!.holder_email, caller.email) && row!.token === caller.token
  let takenOverBy: LockState['takenOverBy'] = null
  const tAt = ms(row?.taken_over_at)
  if (
    row && row.holder_email && tAt != null && nowMs - tAt <= TAKEN_OVER_NOTICE_MS &&
    sameEmail(row.prev_holder_email, caller.email) &&
    caller.token != null && caller.token !== row.token
  ) {
    takenOverBy = { email: row.holder_email, name: row.holder_name, at: row.taken_over_at! }
  }
  return {
    held,
    holderEmail: held ? row!.holder_email : null,
    holderName: held ? row!.holder_name : null,
    acquiredAt: held ? row!.acquired_at : null,
    lastActionAt: held ? row!.last_action_at : null,
    expiresAt: held && last != null ? new Date(last + LOCK_IDLE_MS).toISOString() : null,
    isMine,
    takenOverBy,
  }
}

/**
 * 規格 §3.7 鎖操作表：
 * | acquire   | 無有效持有者 → 新 token；isMine（重整後帶舊 token）→ 只更新時間；別人有效持有 → held_by_other |
 * | heartbeat | isMine → heartbeat_at＝now，active 才延長 last_action_at；否則 lock_lost（被接手或已逾時） |
 * | release   | isMine → 清空持有者；否則 noop |
 * | takeover  | 任何 packaging_admin（權限由 API 守門）→ 新 token、記 prev_holder（原持有者有效時）、taken_over_at |
 * 所有 update 都以「目前 token」為條件（expectToken），期間有人搶先 → 0 列 → API 重讀重算。
 */
export function planLockAction(
  action: LockAction,
  row: EditLockRow,
  caller: { email: string; name: string | null; token: string | null; active?: boolean },
  nowMs: number,
  newToken: () => string,
): LockPlan {
  const st = evaluateLock(row, nowMs, caller)
  const now = new Date(nowMs).toISOString()
  const touchMine: LockPlan = {
    kind: 'update', expectToken: row.token, newToken: null,
    patch: { heartbeat_at: now, last_action_at: now, updated_at: now },
  }
  // 新 token。預設一併清掉 prev_holder_*／taken_over_at：只有「接手有效持有者」才寫入接手紀錄，
  // 否則上一輪接手留下的紀錄會讓原被接手者在 10 分鐘內看到錯的「已由 XXX 接手」（正常取得的人被標成接手者）。
  const fresh = (extra: Partial<Omit<EditLockRow, 'id'>>): LockPlan => {
    const token = newToken()
    return {
      kind: 'update', expectToken: row.token, newToken: token,
      patch: {
        holder_email: caller.email, holder_name: caller.name, token,
        acquired_at: now, heartbeat_at: now, last_action_at: now, updated_at: now,
        prev_holder_email: null, prev_holder_name: null, taken_over_at: null,
        ...extra,
      },
    }
  }

  switch (action) {
    case 'acquire':
      if (st.isMine) return touchMine
      if (st.held) return { kind: 'reject', code: 'held_by_other' }
      return fresh({})
    case 'heartbeat':
      if (!st.isMine) return { kind: 'reject', code: 'lock_lost' }
      return {
        kind: 'update', expectToken: row.token, newToken: null,
        patch: caller.active ? { heartbeat_at: now, last_action_at: now, updated_at: now } : { heartbeat_at: now, updated_at: now },
      }
    case 'release':
      if (!st.isMine) return { kind: 'noop' }
      return {
        kind: 'update', expectToken: row.token, newToken: null,
        patch: { holder_email: null, holder_name: null, token: null, updated_at: now },
      }
    case 'takeover':
      if (st.isMine) return touchMine
      if (st.held) {
        return fresh({ prev_holder_email: row.holder_email, prev_holder_name: row.holder_name, taken_over_at: now })
      }
      return fresh({})
    default:
      return { kind: 'reject', code: 'lock_lost' }
  }
}
