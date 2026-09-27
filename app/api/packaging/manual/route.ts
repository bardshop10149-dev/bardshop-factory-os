import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import {
  ADJUST_REASON_MAX,
  MAX_ACTIVE_MANUAL,
  MAX_MANUAL_ITEMS_PER_REQUEST,
  type LockState,
  type ManualErrorCode,
  type ManualInclusion,
  type ManualInclusionMeta,
  type ManualLookupResponse,
  type ManualMutationResponse,
  type ManualRouteType,
} from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { getPool, POOL_READ_MAX_AGE_MS, POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { isLineKey, isQty } from '@/lib/packaging/scheduleOps'
import { explainManualLines } from '@/lib/packaging/manualLookup'
import { manualBlockedReason, manualMetaOf, manualRecordEnded, normalPoolLineKeys, soLineNoStr } from '@/lib/packaging/manualPool'
import { invalidateManualCache } from '@/lib/packaging/manualCache'
import {
  insertInclusion,
  loadActiveInclusionByKey,
  loadActiveInclusions,
  loadActiveInclusionsBySo,
  loadManualLookupData,
  loadSoLinesForSos,
  updateInclusion,
} from '@/lib/packaging/manualDb'
import {
  insertOpLog,
  isMissingSchema,
  linesMigrationMessage,
  loadPlacementsByLines,
  publicDbError,
  verifyAndTouchLock,
} from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P1 分線輪：D66 待排池手動加入（顆粒度＝SO 品項行，Snow 確認）。規格 docs/design/2026-09-27-packaging-lines.md §六、§4.5
//
// GET  ?so=SO260924020（讀）→ ManualLookupResponse：該 SO 全部品項行＋逐行「不在待排池的原因」
//      （in_pool／manual_active／non_physical／zero_qty／non_schedule_doc／tower_closed／packaged_done／sheet_stale／waiting_source／unknown），
//      以及建議途程類型與建議數量（廠商代碼不外露）。so 白名單 ^(SO|SOB|RO)[A-Z0-9-]{4,30}$（轉大寫）。
// POST ManualAddRequest { lockToken, items[1..50] }（packaging_admin＋編輯鎖）→ ManualMutationResponse
//      逐行驗證（伺服器重查 erp_so_lines，不信任前端），不合格的列進 skipped、其餘照常加入。
// PATCH ManualUpdateRequest { lockToken, soLineKey, qty?, routeType?, reason? } → ManualMutationResponse
//      qty 不可低於該行未完成擺放合計（qty_below_placed；解讀：手動輸入的量直接擋下，比悄悄修剪已排的卡清楚）。
// 移出：POST /api/packaging/manual/remove（軟刪除）。
// 三者都寫 op_log（kind 'manual'）、不進 Undo（同產能：是「供給」的事實輸入；誤加可移出、誤移出可再加）。
// 資料一律用 EIP 鏡像（erp_so_lines、erp_pj_sync、erp_mo_lines、sara_*、daily_order_sheets），不查 ARGO；
// 只寫 packaging_manual_inclusions／packaging_op_log（＋鎖續命）。

const SO_RE = /^(SO|SOB|RO)[A-Z0-9-]{4,30}$/
const LINE_KEY_SPLIT_RE = /^(.+)-(\d{1,4})$/
const ROUTE_TYPES: readonly ManualRouteType[] = ['自製', '常平', '委外']

type Fail = Extract<ManualMutationResponse, { success: false }>
const fail = (status: number, body: Omit<Fail, 'success'>) => noStore<Fail>({ success: false, ...body }, status)
const lockFail = (code: 'lock_required' | 'lock_lost', lock: LockState) =>
  fail(409, { code, lock, error: code === 'lock_lost' ? `編輯權已由 ${lock.holderName ?? lock.holderEmail ?? '其他人'} 接手` : '沒有編輯權或已逾時釋放，請重新取得編輯權' })

function dbFail(where: string, e: unknown) {
  console.error(`[packaging/manual ${where}]`, describeError(e))
  if (isMissingSchema(e)) return fail(409, { code: 'migration_required', error: linesMigrationMessage(e) })
  return fail(500, { code: 'db_error', error: publicDbError(e) })
}

const isRouteType = (x: unknown): x is ManualRouteType => typeof x === 'string' && (ROUTE_TYPES as readonly string[]).includes(x)
const reasonOf = (x: unknown): string | null | undefined => {
  if (x === undefined) return undefined
  if (x === null) return null
  if (typeof x !== 'string') return undefined
  return x.trim() ? x.trim() : null
}

// ─────────────────────────────────────────────────────────────────────
// GET：查詢某 SO 各品項行的狀態與原因
// ─────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const g = await guardPackaging('read')
  if (!g.ok) return g.res
  const so = (request.nextUrl.searchParams.get('so') ?? '').trim().toUpperCase()
  if (!SO_RE.test(so)) {
    return noStore<ManualLookupResponse>({ success: false, code: 'bad_request', error: '單號格式錯誤（例：SO260924020、SOB260902504、RO25080441）' }, 400)
  }
  const today = todayTaipei()
  try {
    const sb = getSupabaseAdminClient()
    const [data, active, pool] = await Promise.all([
      loadManualLookupData(sb, so, today),
      loadActiveInclusionsBySo(sb, so),
      getPool({ maxAgeMs: POOL_READ_MAX_AGE_MS }),
    ])
    const poolCards = pool.blocks.flatMap((b) => b.cards).filter((c) => c.soLineKey.toUpperCase().startsWith(`${so}-`))
    const manual = new Map<string, ManualInclusionMeta>(active.map((i) => [i.soLineKey, manualMetaOf(i)]))
    // 已全數完成的手動紀錄另外標出（待排池已無卡，畫面才能提示改由查詢結果移出）
    const placements = active.length > 0 ? await loadPlacementsByLines(sb, active.map((i) => i.soLineKey)) : []
    const manualDone = new Set(active.filter((i) => manualRecordEnded(i, placements, true) === 'done').map((i) => i.soLineKey))
    const lines = explainManualLines({ so, today, poolCards, manual, manualDone, ...data })
    return noStore<ManualLookupResponse>({
      success: true,
      so,
      found: data.soLines.length > 0,
      customer: data.soLines[0]?.partner_name ?? null,
      lines,
    })
  } catch (e) {
    console.error('[packaging/manual GET]', describeError(e))
    if (isMissingSchema(e)) return noStore<ManualLookupResponse>({ success: false, code: 'migration_required', error: linesMigrationMessage(e) }, 409)
    return noStore<ManualLookupResponse>({ success: false, code: 'db_error', error: publicDbError(e) }, 500)
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST：批次加入
// ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body || !Array.isArray(body.items)) return fail(400, { code: 'bad_request', error: '請求格式錯誤（items 必須是陣列）' })
  const items = body.items as unknown[]
  if (items.length < 1) return fail(400, { code: 'bad_request', error: '請至少勾選一行' })
  if (items.length > MAX_MANUAL_ITEMS_PER_REQUEST) return fail(400, { code: 'too_many', error: `一次最多加入 ${MAX_MANUAL_ITEMS_PER_REQUEST} 行` })

  const skipped: { soLineKey: string; code: ManualErrorCode; message: string }[] = []
  const wanted: { soLineKey: string; so: string; lineNo: string; qty: number; routeType: ManualRouteType; reason: string | null }[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const x = raw as Record<string, unknown> | null
    const key = typeof x?.soLineKey === 'string' ? x.soLineKey.trim().toUpperCase() : ''
    const m = key.match(LINE_KEY_SPLIT_RE)
    if (!x || !isLineKey(key) || !m || !SO_RE.test(m[1])) { skipped.push({ soLineKey: key || String(x?.soLineKey ?? ''), code: 'bad_request', message: '品項行格式錯誤' }); continue }
    if (seen.has(key)) { skipped.push({ soLineKey: key, code: 'bad_request', message: '同一行重複' }); continue }
    seen.add(key)
    // 數量可超過訂單量（解讀：訂單量單位與包裝數量可能不同，畫面只黃字提醒），但須 > 0、最多 3 位小數
    if (!isQty(x.qty)) { skipped.push({ soLineKey: key, code: 'qty_invalid', message: '數量須大於 0、最多 3 位小數' }); continue }
    if (x.routeType !== undefined && !isRouteType(x.routeType)) { skipped.push({ soLineKey: key, code: 'bad_request', message: '途程類型只能是自製／常平／委外' }); continue }
    const reason = reasonOf(x.reason)
    if (x.reason != null && (typeof x.reason !== 'string' || x.reason.length > ADJUST_REASON_MAX)) { skipped.push({ soLineKey: key, code: 'bad_request', message: `原因最多 ${ADJUST_REASON_MAX} 字` }); continue }
    wanted.push({ soLineKey: key, so: m[1], lineNo: String(parseInt(m[2], 10)), qty: x.qty, routeType: isRouteType(x.routeType) ? x.routeType : '自製', reason: reason ?? null })
  }

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const actor = { email: g.member.email, name: g.member.realName }
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: typeof body.lockToken === 'string' ? body.lockToken : null }, nowMs)
    if (!lk.ok) return lockFail(lk.code, lk.lock)

    const [soLines, active, pool] = await Promise.all([
      loadSoLinesForSos(sb, wanted.map((w) => w.so)),
      loadActiveInclusions(sb),
      getPool({ maxAgeMs: POOL_WRITE_MAX_AGE_MS }),
    ])
    const normal = normalPoolLineKeys(pool)
    const activeKeys = new Set(active.map((a) => a.soLineKey))
    const slByKey = new Map(soLines.map((sl) => [`${sl.project_id.trim().toUpperCase()}-${soLineNoStr(sl.line_no) ?? ''}`, sl]))
    // 名額只算「作用中」的紀錄：已全數完成、或 ERP 已查無此行的紀錄不佔位（它們在待排池已不出卡，畫面上無從移出）。
    // 只有可能超額時才多查一次（平常 active 遠低於上限，省掉 SO 行／擺放查詢）
    let room = MAX_ACTIVE_MANUAL - active.length
    if (room < wanted.length && active.length > 0) {
      const [activeSoLines, activePlacements] = await Promise.all([
        loadSoLinesForSos(sb, active.map((a) => a.so)),
        loadPlacementsByLines(sb, active.map((a) => a.soLineKey)),
      ])
      const existing = new Set(activeSoLines.map((sl) => `${sl.project_id.trim().toUpperCase()}-${soLineNoStr(sl.line_no) ?? ''}`))
      const ended = active.filter((a) => manualRecordEnded(a, activePlacements, existing.has(a.soLineKey)) != null).length
      room += ended
    }

    const inserted: ManualInclusion[] = []
    for (const w of wanted) {
      const sl = slByKey.get(w.soLineKey)
      if (!sl) { skipped.push({ soLineKey: w.soLineKey, code: 'so_line_not_found', message: 'ERP 查無此品項行（可能已結案或單號錯誤）' }); continue }
      if (normal.has(w.soLineKey)) { skipped.push({ soLineKey: w.soLineKey, code: 'already_in_pool', message: '已在待排池，不需手動加入' }); continue }
      if (activeKeys.has(w.soLineKey)) { skipped.push({ soLineKey: w.soLineKey, code: 'already_manual', message: '已手動加入（請改用「改數量」）' }); continue }
      const blocked = manualBlockedReason(sl)
      if (blocked) { skipped.push({ soLineKey: w.soLineKey, code: 'not_selectable', message: blocked }); continue }
      if (room <= 0) { skipped.push({ soLineKey: w.soLineKey, code: 'too_many', message: `手動加入同時最多 ${MAX_ACTIVE_MANUAL} 行，請先移出不需要的` }); continue }
      const r = await insertInclusion(sb, w, actor, nowIso)
      if (r === 'duplicate') { skipped.push({ soLineKey: w.soLineKey, code: 'already_manual', message: '已手動加入（請改用「改數量」）' }); continue }
      inserted.push(r)
      activeKeys.add(w.soLineKey)
      room--
    }

    let revision = `m${nowMs}`
    if (inserted.length > 0) {
      invalidateManualCache()
      const opId = await insertOpLog(sb, {
        actorEmail: actor.email, actorName: actor.name, kind: 'manual',
        label: `手動加入 ${inserted.length} 行（${[...new Set(inserted.map((i) => i.so))].join('、').slice(0, 80)}）`,
        ops: inserted.map((i) => ({ action: 'add', id: i.inclusionId, soLineKey: i.soLineKey, qty: i.qty, routeType: i.routeType, reason: i.reason })),
      })
      if (opId != null) revision = `m${opId}`
    }
    return noStore<ManualMutationResponse>({ success: true, inclusions: inserted, skipped, revision, lock: lk.lock })
  } catch (e) {
    return dbFail('POST', e)
  }
}

// ─────────────────────────────────────────────────────────────────────
// PATCH：改數量／途程類型／原因
// ─────────────────────────────────────────────────────────────────────

export async function PATCH(request: NextRequest) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return fail(400, { code: 'bad_request', error: '請求格式錯誤' })
  const key = typeof body.soLineKey === 'string' ? body.soLineKey.trim().toUpperCase() : ''
  if (!isLineKey(key)) return fail(400, { code: 'bad_request', error: '品項行格式錯誤' })
  const patch: { qty?: number; route_type?: ManualRouteType; reason?: string | null } = {}
  if (body.qty !== undefined) {
    if (!isQty(body.qty)) return fail(422, { code: 'qty_invalid', error: '數量須大於 0、最多 3 位小數' })
    patch.qty = body.qty
  }
  if (body.routeType !== undefined) {
    if (!isRouteType(body.routeType)) return fail(400, { code: 'bad_request', error: '途程類型只能是自製／常平／委外' })
    patch.route_type = body.routeType
  }
  if (body.reason !== undefined) {
    if (body.reason != null && (typeof body.reason !== 'string' || body.reason.length > ADJUST_REASON_MAX)) return fail(400, { code: 'bad_request', error: `原因最多 ${ADJUST_REASON_MAX} 字` })
    patch.reason = reasonOf(body.reason) ?? null
  }
  if (Object.keys(patch).length === 0) return fail(400, { code: 'bad_request', error: '沒有要修改的欄位' })

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const actor = { email: g.member.email, name: g.member.realName }
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: typeof body.lockToken === 'string' ? body.lockToken : null }, nowMs)
    if (!lk.ok) return lockFail(lk.code, lk.lock)

    const cur = await loadActiveInclusionByKey(sb, key)
    if (!cur) return fail(404, { code: 'not_found', error: '找不到有效的手動加入紀錄（可能已移出）', lock: lk.lock })
    if (patch.qty !== undefined && patch.qty < cur.qty) {
      const placed = (await loadPlacementsByLines(sb, [key])).filter((p) => !p.completed).reduce((s, p) => s + p.qty, 0)
      if (patch.qty + 1e-9 < placed) {
        return fail(422, { code: 'qty_below_placed', error: `已排出 ${Math.round(placed * 1000) / 1000}（未完成），數量不可低於已排量；請先把卡放回待排池`, lock: lk.lock })
      }
    }
    const updated = await updateInclusion(sb, cur.inclusionId, patch, actor, nowIso)
    if (!updated) return fail(404, { code: 'not_found', error: '找不到有效的手動加入紀錄（可能已移出）', lock: lk.lock })
    invalidateManualCache()
    const opId = await insertOpLog(sb, {
      actorEmail: actor.email, actorName: actor.name, kind: 'manual',
      label: `改手動加入 ${key}${patch.qty !== undefined ? ` 數量 ${cur.qty}→${patch.qty}` : ''}`,
      ops: [{ action: 'update', id: cur.inclusionId, soLineKey: key, before: { qty: cur.qty, routeType: cur.routeType, reason: cur.reason }, after: { qty: updated.qty, routeType: updated.routeType, reason: updated.reason } }],
    })
    return noStore<ManualMutationResponse>({ success: true, inclusions: [updated], skipped: [], revision: `m${opId ?? nowMs}`, lock: lk.lock })
  } catch (e) {
    return dbFail('PATCH', e)
  }
}
