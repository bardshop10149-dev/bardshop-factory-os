// 包裝專區 P1 — 擺放寫入 API 的共用流程（POST /api/packaging/placements、/api/packaging/cards/complete；規格 §四.2～3）
//
// 流程：守門（packaging_admin，D30）→ Content-Type 必須 JSON（擋 CSRF）→ 驗鎖＋續命（D53）
//      → 讀觸及 SO 行的全部擺放 → 待排池（共用快取 10 分）→ applyOps 模擬驗證 → 「先減後增」寫入 → op_log。
// 只寫 packaging_placements／packaging_op_log／packaging_edit_lock（續命），絕不寫既有表（D4／D24）。

import type { NextRequest, NextResponse } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { ApplyErrorCode, ApplyResponse, LineSupply, PlacementOp } from '@/lib/packaging/scheduleTypes'
import type { PackagingCard } from '@/lib/packaging/types'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { getPool, POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { addDays, openSaturdaysOf } from '@/lib/packaging/scheduleCalendar'
import { lineSupply } from '@/lib/packaging/scheduleAllocate'
import { applyOps, parseOps, touchedKeys } from '@/lib/packaging/scheduleOps'
import {
  countOpenPlacements,
  insertOpLog,
  loadCapacityRows,
  loadPlacementsByIds,
  loadPlacementsByLines,
  publicDbError,
  verifyAndTouchLock,
  writeApplied,
} from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'

/** 規格 §四 HTTP 狀態對照 */
export function applyErrorStatus(code: ApplyErrorCode): number {
  switch (code) {
    case 'forbidden': return 403
    case 'lock_required':
    case 'lock_lost':
    case 'version_conflict':
    case 'id_exists':
    case 'not_found': // 列已不存在＝與其他變更衝突，前端依 code 重新載入
      return 409
    case 'bad_request': return 400
    case 'pool_unavailable':
    case 'db_error':
      return 500
    default: return 422
  }
}

/** 寫入最遠可排到 today + 120 日曆天（規格 §3.8 maxDate） */
export const MAX_PLAN_DAYS = 120
/**
 * 全表未完成擺放張數上限（目前數百張）。擋「每請求最多新增約 450 列、一直重送」把正式站表與快照灌爆；
 * 已超過時只擋「再變多」的請求（本批新增 > 刪除），挪動、合併、移除照常。
 */
export const MAX_OPEN_PLACEMENTS = 5000
const LABEL_MAX = 120

type Fail = Extract<ApplyResponse, { success: false }>
const failRes = (body: Omit<Fail, 'success'>): NextResponse =>
  noStore<Fail>({ success: false, ...body }, applyErrorStatus(body.code))

export async function handleApplyRequest(
  request: NextRequest,
  opts: { kind: 'placements' | 'complete'; allowed?: ReadonlySet<PlacementOp['op']> },
): Promise<NextResponse> {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return failRes({ code: 'bad_request', error: '請求格式錯誤（須為 JSON 物件）' })
  const lockToken = typeof body.lockToken === 'string' ? body.lockToken : null
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, LABEL_MAX) : null
  const parsed = parseOps(body.ops, opts.allowed)
  if (!parsed.ok) return failRes({ code: parsed.code, error: parsed.message, opIndex: parsed.opIndex })
  const ops = parsed.ops

  const actor = { email: g.member.email, name: g.member.realName }
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))

  try {
    const sb = getSupabaseAdminClient()

    // D53：驗鎖同時續命（每次寫入＝一次「有動作」）
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: lockToken }, nowMs)
    if (!lk.ok) {
      return failRes({
        code: lk.code, lock: lk.lock,
        error: lk.code === 'lock_lost' ? `編輯權已由 ${lk.lock.holderName ?? lk.lock.holderEmail ?? '其他人'} 接手` : '沒有編輯權或已逾時釋放，請重新取得編輯權',
      })
    }

    // 觸及的 SO 行：ops 直接帶的＋以 id 查出來的；再讀這些行的「全部」擺放（守恆檢查要看整行）
    const { lineKeys, ids } = touchedKeys(ops)
    const [byIdRows, pool, capRows] = await Promise.all([
      loadPlacementsByIds(sb, [...ids]),
      getPool({ maxAgeMs: POOL_WRITE_MAX_AGE_MS }).catch((e: unknown) => {
        console.error('[packaging/write] 待排池組裝失敗:', describeError(e))
        return null
      }),
      loadCapacityRows(sb, addDays(today, -1), addDays(today, MAX_PLAN_DAYS + 14)),
    ])
    if (!pool) return failRes({ code: 'pool_unavailable', error: '待排池暫時無法組裝，無法驗證，請稍後再試', lock: lk.lock })
    for (const p of byIdRows) lineKeys.add(p.soLineKey)
    const linePlacements = await loadPlacementsByLines(sb, [...lineKeys])
    const byId = new Map(linePlacements.map((p) => [p.id, p]))

    const cards = new Map<string, PackagingCard>()
    const cardsByLine = new Map<string, PackagingCard[]>()
    for (const b of pool.blocks) for (const c of b.cards) {
      cards.set(c.cardId, c)
      let arr = cardsByLine.get(c.soLineKey)
      if (!arr) { arr = []; cardsByLine.set(c.soLineKey, arr) }
      arr.push(c)
    }
    const supplyMemo = new Map<string, LineSupply | null>()
    const supplyOf = (key: string): LineSupply | null => {
      if (!supplyMemo.has(key)) {
        const list = cardsByLine.get(key)
        supplyMemo.set(key, list && list.length > 0 ? lineSupply(key, list) : null)
      }
      return supplyMemo.get(key)!
    }

    const res = applyOps({ byId }, ops, {
      today, nowIso, actor,
      openSats: openSaturdaysOf(capRows),
      supplyOf, cards,
      maxDate: addDays(today, MAX_PLAN_DAYS),
    })
    if (!res.ok) {
      return failRes({ code: res.code, error: res.message, opIndex: res.opIndex, current: res.current, lock: lk.lock })
    }

    // 總量上限：本批會讓未完成張數淨增加時才查（一個 count 請求）
    const openOf = (list: readonly { completed: unknown }[]) => list.filter((p) => !p.completed).length
    const delta = openOf(res.inserts) - openOf(res.deletes)
      + res.updates.reduce((n, u) => n + (u.before.completed && !u.after.completed ? 1 : !u.before.completed && u.after.completed ? -1 : 0), 0)
    if (delta > 0) {
      const openNow = await countOpenPlacements(sb)
      if (openNow + delta > MAX_OPEN_PLACEMENTS) {
        return failRes({ code: 'bad_request', error: `未完成的卡已達上限 ${MAX_OPEN_PLACEMENTS} 張，請先合併或移除`, lock: lk.lock })
      }
    }

    const w = await writeApplied(sb, res)
    if (!w.ok) {
      console.error('[packaging/write] 寫入失敗:', w.code, w.message, w.partial ? '(partial)' : '')
      return failRes({ code: w.code, error: w.partial ? `${w.message}（部分操作已寫入，請重新載入）` : w.message, current: w.current, partial: w.partial, lock: lk.lock })
    }

    const opLogId = await insertOpLog(sb, { actorEmail: actor.email, actorName: actor.name, kind: opts.kind, label, ops })
    return noStore<ApplyResponse>({
      success: true,
      rows: w.rows,
      deletedIds: w.deletedIds,
      inverse: res.inverse,
      // 刻意「不」等於 GET /board 的指紋：讓下一次輪詢一定拿完整資料，校正前端的樂觀更新
      revision: `w${opLogId ?? nowMs}`,
      lock: lk.lock,
    })
  } catch (e) {
    console.error(`[packaging/${opts.kind}]`, describeError(e))
    return failRes({ code: 'db_error', error: publicDbError(e) })
  }
}
