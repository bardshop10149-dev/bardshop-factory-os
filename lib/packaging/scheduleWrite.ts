// 包裝專區 P1 — 擺放寫入 API 的共用流程（POST /api/packaging/placements、/api/packaging/cards/complete；規格 §四.2～3）
//
// 流程：守門（packaging_admin，D30）→ Content-Type 必須 JSON（擋 CSRF）→ 驗鎖＋續命（D53）
//      → 讀觸及 SO 行的全部擺放 → 待排池（共用快取 10 分）→ applyOps 模擬驗證 → 「先減後增」寫入 → op_log。
// 只寫 packaging_placements／packaging_op_log／packaging_edit_lock（續命）；分線輪另寫 packaging_time_adjustments（D69 學習紀錄）。
// 絕不寫既有表（D4／D24）。
// 分線輪（lines.md §4.2）：多讀線別（D72 驗 lineId）與 D66 手動區塊（併進待排池再算 supplyOf）；
//   本批有值改變的 setMinutes → 寫入成功後插學習紀錄，失敗回 adjustmentLogFailed（工時已改成功）。
// D74：reorder 只改 sort_index；sql/20260928 未套用（沒有這欄）時 reorder 回提示，其他操作照常（寫入時略過該欄）。

import type { NextRequest, NextResponse } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { ApplyErrorCode, ApplyResponse, LineSupply, Placement, PlacementOp, TimeAdjustmentRow } from '@/lib/packaging/scheduleTypes'
import type { PackagingCard } from '@/lib/packaging/types'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { getPool, POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { addDays, openWeekendDaysOf } from '@/lib/packaging/scheduleCalendar'
import { allocateLine, lineSupply } from '@/lib/packaging/scheduleAllocate'
import { applyOps, parseOps, touchedKeys, type ApplyOk } from '@/lib/packaging/scheduleOps'
import { defaultLineIdOf } from '@/lib/packaging/scheduleLines'
import { buildAdjustment } from '@/lib/packaging/scheduleMinutes'
import { getManualMergedPool } from '@/lib/packaging/manualCache'
import {
  countOpenPlacements,
  insertOpLog,
  insertTimeAdjustments,
  isMissingSchema,
  linesMigrationMessage,
  loadCapacityRows,
  loadLineCapacityRows,
  loadLines,
  loadPlacementsByIds,
  loadPlacementsByLines,
  publicDbError,
  sortIndexColumnMissing,
  sortIndexMigrationMessage,
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
  const hasReorder = ops.some((o) => o.op === 'reorder')
  if (hasReorder && sortIndexColumnMissing()) return failRes({ code: 'db_error', error: sortIndexMigrationMessage() })

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
    const [byIdRows, basePool, capRows, lines, lineRows] = await Promise.all([
      loadPlacementsByIds(sb, [...ids]),
      getPool({ maxAgeMs: POOL_WRITE_MAX_AGE_MS }).catch((e: unknown) => {
        console.error('[packaging/write] 待排池組裝失敗:', describeError(e))
        return null
      }),
      loadCapacityRows(sb, addDays(today, -1), addDays(today, MAX_PLAN_DAYS + 14)),
      loadLines(sb),
      loadLineCapacityRows(sb, addDays(today, -1), addDays(today, MAX_PLAN_DAYS + 14)),
    ])
    if (!basePool) return failRes({ code: 'pool_unavailable', error: '待排池暫時無法組裝，無法驗證，請稍後再試', lock: lk.lock })
    // D66：手動區塊併進待排池（'mn' 卡是一般供給，place／complete 走同一套驗證）
    const pool = (await getManualMergedPool(sb, basePool)).pool
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

    const activeIds = new Set(lines.filter((l) => l.active).map((l) => l.id))
    const openWeekends = openWeekendDaysOf(capRows, lineRows, activeIds)
    const res = applyOps({ byId }, ops, {
      today, nowIso, actor,
      openWeekends,
      supplyOf, cards,
      maxDate: addDays(today, MAX_PLAN_DAYS),
      lines: new Map(lines.map((l) => [l.id, l])),
      defaultLineId: defaultLineIdOf(lines),
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

    const w = await writeApplied(sb, res, { requiresSortIndex: hasReorder })
    if (!w.ok) {
      console.error('[packaging/write] 寫入失敗:', w.code, w.message, w.partial ? '(partial)' : '')
      return failRes({ code: w.code, error: w.partial ? `${w.message}（部分操作已寫入，請重新載入）` : w.message, current: w.current, partial: w.partial, lock: lk.lock })
    }

    // D69 規則 6：先改工時、後記紀錄（先記後改失敗會留下「沒發生的修改」誤導學習）
    let adjustmentLogFailed = false
    if (res.minuteEdits.length > 0) {
      const adj = buildMinuteAdjustments(res, { supplyOf, cards, today, openWeekends, actor })
      adjustmentLogFailed = !(await insertTimeAdjustments(sb, adj))
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
      ...(adjustmentLogFailed ? { adjustmentLogFailed: true } : {}),
    })
  } catch (e) {
    console.error(`[packaging/${opts.kind}]`, describeError(e))
    // 分線輪 migration 未套用（packaging_lines 等表或 line_id 欄不存在）→ 明確提示要套哪個檔
    if (isMissingSchema(e)) return failRes({ code: 'db_error', error: linesMigrationMessage(e) })
    return failRes({ code: 'db_error', error: publicDbError(e) })
  }
}

/**
 * D69 學習紀錄：每個值有變的 setMinutes 一列。品號、品名、PACKING、途程、work.source／explain 取自該行待排池底卡
 * （與畫面 BoardCard.card 同一張：以寫入後狀態重跑 allocateLine 的 baseCardId），qty＝有效數量。
 */
function buildMinuteAdjustments(
  res: ApplyOk,
  ctx: {
    supplyOf: (key: string) => LineSupply | null
    cards: ReadonlyMap<string, PackagingCard>
    today: string
    openWeekends: ReadonlySet<string>
    actor: { email: string; name: string | null }
  },
): Omit<TimeAdjustmentRow, 'id' | 'created_at'>[] {
  const byLine = new Map<string, Placement[]>()
  for (const p of res.next.values()) {
    let arr = byLine.get(p.soLineKey)
    if (!arr) { arr = []; byLine.set(p.soLineKey, arr) }
    arr.push(p)
  }
  return res.minuteEdits.map((e) => {
    const supply = ctx.supplyOf(e.after.soLineKey)
    let effectiveQty = e.after.qty
    let card: PackagingCard | null = null
    if (supply) {
      const a = allocateLine({ supply, placements: byLine.get(e.after.soLineKey) ?? [], today: ctx.today, openWeekends: ctx.openWeekends })
      const pa = a.placements.find((x) => x.placementId === e.after.id)
      if (pa && !e.after.completed) effectiveQty = pa.effectiveQty
      const cid = pa?.baseCardId ?? e.after.originCardId
      card = (cid ? ctx.cards.get(cid) : undefined) ?? null
    }
    if (!card && e.after.originCardId) card = ctx.cards.get(e.after.originCardId) ?? null
    return buildAdjustment({
      before: e.before, after: e.after, card, effectiveQty,
      perUnit: supply?.perUnit ?? card?.work.perUnit ?? null,
      reason: e.reason, via: e.via, actor: ctx.actor,
    })
  })
}
