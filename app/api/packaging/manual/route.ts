import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import {
  ADJUST_REASON_MAX,
  MAX_ACTIVE_MANUAL,
  MAX_MANUAL_ITEMS_PER_REQUEST,
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
import { allocateSoldToLines } from '@/lib/packaging/salesAlloc'
import { loadSalesForSos } from '@/lib/packaging/salesSync'
import { manualBlockedReason, manualMetaOf, manualQtyFloorError, manualRecordEnded, normalPoolLineKeys, soLineNoStr } from '@/lib/packaging/manualPool'
import { invalidateManualCache } from '@/lib/packaging/manualCache'
import {
  insertInclusion,
  loadActiveInclusionByKey,
  loadActiveInclusions,
  loadActiveInclusionsBySo,
  loadManualLookupData,
  loadSoLinesForSos,
  restoreInclusionFields,
  updateInclusion,
} from '@/lib/packaging/manualDb'
import {
  insertOpLog,
  isMissingSchema,
  linesMigrationMessage,
  loadPlacementsByLines,
  publicDbError,
} from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P1 分線輪：D66 待排池手動加入（顆粒度＝SO 品項行，Snow 確認）。規格 docs/design/2026-09-27-packaging-lines.md §六、§4.5
//
// GET  ?so=SO260924020（讀）→ ManualLookupResponse：該 SO 全部品項行＋逐行「不在待排池的原因」
//      （in_pool／manual_active／non_physical／zero_qty／non_schedule_doc／tower_closed／packaged_done／sheet_stale／waiting_source／unknown），
//      以及建議途程類型與建議數量（廠商代碼不外露）。so 白名單 ^(SO|SOB|RO)[A-Z0-9-]{4,30}$（轉大寫）。
//      D103：各行另帶 completedQty（已勾完成擺放合計，不分何時完成；0 省略）——加入的數量是總量（含已完成），
//      加入前就有的完成量（正常區塊時期、舊紀錄移出前）也算進去，加入對話框據此提示。
// POST ManualAddRequest { items[1..50] }（packaging_admin）→ ManualMutationResponse
//      逐行驗證（伺服器重查 erp_so_lines，不信任前端），不合格的列進 skipped、其餘照常加入。
//      D103：加入不設下限（數量 ≤ 已完成＝加入即算包完、不出卡，可移出；畫面黃字提醒、不擋）。
// PATCH ManualUpdateRequest { soLineKey, qty?, routeType?, reason? }（packaging_admin）→ ManualMutationResponse
//      qty 不可低於該行未完成擺放合計（qty_below_placed；解讀：手動輸入的量直接擋下，比悄悄修剪已排的卡清楚）。
//      D103（Snow 確認）：qty＝這筆訂單的總量（含已完成），不是剩餘量 → 下限＝已完成＋未完成擺放：
//      低於已完成 → qty_below_completed；低於已完成＋未完成 → qty_below_placed；剛好等於已完成 → 允許（剩 0、進已全數完成）。
// 移出：POST /api/packaging/manual/remove（軟刪除）。
// 三者都寫 op_log（kind 'manual'）、不進 Undo（同產能：是「供給」的事實輸入；誤加可移出、誤移出可再加）。
// 資料一律用 EIP 鏡像（erp_so_lines、erp_pj_sync、erp_mo_lines、sara_*、daily_order_sheets），不查 ARGO；
// 只寫 packaging_manual_inclusions／packaging_op_log。
//
// D102（Snow 確認：「一樣可以新增訂單，在工作區按重新整理即可把新的卡片加入」）：寫入不再要求編輯鎖（lockToken）。
//   為什麼可以拿掉：手動加入改的是「供給」（待排池有哪些卡、量多少），不是「排程」（哪張卡排哪天）。
//   編輯鎖保護的是排程不被兩個人同時拖亂；供給本來就會被 ERP／塔台同步隨時改變，工作台每次讀取都用
//   當下供給重新分配（scheduleAllocate），所以多一個人改供給不會讓排程壞掉。真正要守的「數量不超排」仍在伺服器：
//   PATCH 不可低於未完成擺放（qty_below_placed；D103 起＝已完成＋未完成）、移出前不可有未完成排定卡（manual_has_placements）、
//   排程寫入（placements）照舊驗供給。仍要求 packaging_admin（guardPackaging('write')）、requireJson（擋 CSRF）、noStore。
//   沒有鎖就沒有序列化：「先讀已排量、後寫」會被工作台同時寫入的擺放穿過 → 改量／移出都「寫完再讀一次」，撞到就撤回；
//   工作台那邊也寫後回讀（manualReconcile.ts），兩邊成對才把窗口關掉（D102 驗證修正，見 manualPool.ts 說明）。
//   舊前端若還送 lockToken：直接忽略（不驗、也不幫鎖續命）。回應不再帶 lock。
//   op_log 照寫 → 工作台的 revision 會變，下一次輪詢（或按重新整理）就看到新卡。

const SO_RE = /^(SO|SOB|RO)[A-Z0-9-]{4,30}$/
const LINE_KEY_SPLIT_RE = /^(.+)-(\d{1,4})$/
const ROUTE_TYPES: readonly ManualRouteType[] = ['自製', '常平', '委外']

type Fail = Extract<ManualMutationResponse, { success: false }>
const fail = (status: number, body: Omit<Fail, 'success'>) => noStore<Fail>({ success: false, ...body }, status)

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
    const [data, active, pool, soSales] = await Promise.all([
      loadManualLookupData(sb, so, today),
      loadActiveInclusionsBySo(sb, so),
      getPool({ maxAgeMs: POOL_READ_MAX_AGE_MS }),
      // D73：這張 SO 的銷貨鏡像（表不存在／讀取失敗 → null，不判 sold_out）
      loadSalesForSos(sb, [so]),
    ])
    const poolCards = pool.blocks.flatMap((b) => b.cards).filter((c) => c.soLineKey.toUpperCase().startsWith(`${so}-`))
    const manual = new Map<string, ManualInclusionMeta>(active.map((i) => [i.soLineKey, manualMetaOf(i)]))
    // 已全數完成的手動紀錄另外標出（待排池已無卡，畫面才能提示改由查詢結果移出）
    // D103：手動數量是總量（含已完成），加入前就有的完成量（正常區塊時期、舊紀錄移出前）也會算進去
    //   → 這張 SO 全部行的擺放一次讀出（同一個查詢，原本只讀有效紀錄的行），各行已完成量帶給加入對話框提示。
    const lineKeys = new Set(active.map((i) => i.soLineKey))
    for (const sl of data.soLines) { const n = soLineNoStr(sl.line_no); if (n) lineKeys.add(`${so}-${n}`) }
    const placements = lineKeys.size > 0 ? await loadPlacementsByLines(sb, [...lineKeys]) : []
    const manualDone = new Set(active.filter((i) => manualRecordEnded(i, placements, true) === 'done').map((i) => i.soLineKey))
    const completedByKey = new Map<string, number>()
    for (const p of placements) if (p.completed) completedByKey.set(p.soLineKey, (completedByKey.get(p.soLineKey) ?? 0) + p.qty)
    const sold = soSales ? allocateSoldToLines(data.soLines, soSales).byLine : null
    const lines = explainManualLines({ so, today, poolCards, manual, manualDone, ...data, sold, completedByKey })
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
    const [soLines, active, pool] = await Promise.all([
      loadSoLinesForSos(sb, wanted.map((w) => w.so)),
      loadActiveInclusions(sb),
      getPool({ maxAgeMs: POOL_WRITE_MAX_AGE_MS }),
    ])
    const normal = normalPoolLineKeys(pool)
    const activeKeys = new Set(active.map((a) => a.soLineKey))
    const slByKey = new Map(soLines.map((sl) => [`${sl.project_id.trim().toUpperCase()}-${soLineNoStr(sl.line_no) ?? ''}`, sl]))
    // 名額只算「作用中」的紀錄：已全數完成、或 ERP 已查無此行的紀錄不佔位（它們在待排池已不出卡）。
    // D102 後多人可同時加入，兩個請求同時搶最後幾格時可能多出幾行（上限是防呆、不是硬性容量），不另加鎖。
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
      // 同一行兩人同時加入：DB 唯一索引只讓一筆成功，另一筆回 'duplicate' → 列入 skipped（不靠編輯鎖也不會重複）
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
    return noStore<ManualMutationResponse>({ success: true, inclusions: inserted, skipped, revision })
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
    const cur = await loadActiveInclusionByKey(sb, key)
    if (!cur) return fail(404, { code: 'not_found', error: '找不到有效的手動加入紀錄（可能已移出）' })
    // D103：這一行的已完成／未完成擺放合計（寫前檢查與寫後回讀共用）
    const sums = async () => {
      let placed = 0, completed = 0
      for (const p of await loadPlacementsByLines(sb, [key])) { if (p.completed) completed += p.qty; else placed += p.qty }
      return { placed: Math.round(placed * 1000) / 1000, completed: Math.round(completed * 1000) / 1000 }
    }
    // D103：數量＝總量（含已完成）→ 下限＝已完成＋未完成擺放。改低一定查；改高也查（多一次單行查詢）：
    //   只有「舊紀錄已低於下限」會被擋（例：D103 前把數量當剩餘量改低過），訊息告訴主管最少要填多少。
    //   沒有銷貨（或總量 ≤ 訂單量）時，過了下限就保證不修剪已排的卡。
    //   已知限制（D103 前就有，不是回歸）：D73 部分銷貨且總量 > 訂單量時，salesAlloc 改用比例封頂
    //   （可排＝總量 × 未出貨 ÷ 訂單量），改低總量會把可排壓到低於未完成擺放 → 過了下限仍可能修剪已排的卡。
    //   要完全擋住得用新總量重建卡片、跑 allocateLine 再比；很少見（單位不同的單才會總量 > 訂單量），先列限制（lines.md §6.3）。
    if (patch.qty !== undefined && patch.qty !== cur.qty) {
      const s = await sums()
      const floor = manualQtyFloorError(patch.qty, s.completed, s.placed)
      // D102：改量在待排池頁做、把排定卡拖回待排池要在排程工作台做 → 訊息講清楚去哪裡處理
      if (floor) return fail(422, { code: floor.code, error: floor.error })
    }
    const updated = await updateInclusion(sb, cur.inclusionId, patch, actor, nowIso)
    if (!updated) return fail(404, { code: 'not_found', error: '找不到有效的手動加入紀錄（可能已移出）' })
    invalidateManualCache()
    // D102 寫後回讀（同 manual/remove）：改低數量時，工作台（持鎖者）可能正好在「上面讀已排量」與「寫入」之間又排了卡
    //   （它用舊數量驗證供給 → 通過）。寫完再加總一次未完成擺放：超過新數量 → 把這次的修改改回（CAS：updated_at 仍是這次寫的值，
    //   免得蓋掉別人剛做的修改），回 422。工作台那邊也會寫後回讀（manualReconcile.ts），兩邊至少一邊看得到另一邊。
    //   D103：比的是「已完成＋未完成」（總量語意），與寫前檢查同一個函式。
    if (patch.qty !== undefined && patch.qty < cur.qty) {
      const after = await sums()
      const floorAfter = manualQtyFloorError(patch.qty, after.completed, after.placed, { concurrent: true })
      if (floorAfter) {
        const back = await restoreInclusionFields(sb, cur.inclusionId, { updatedAt: updated.updatedAt }, {
          qty: cur.qty,
          ...(patch.route_type !== undefined ? { route_type: cur.routeType } : {}),
          ...(patch.reason !== undefined ? { reason: cur.reason } : {}),
        }, actor, new Date().toISOString())
        invalidateManualCache()
        if (!back) console.error(`[packaging/manual PATCH] ${key} 改回數量時紀錄已被改動（CAS 未命中）`)
        return fail(422, { code: floorAfter.code, error: floorAfter.error })
      }
    }
    const opId = await insertOpLog(sb, {
      actorEmail: actor.email, actorName: actor.name, kind: 'manual',
      label: `改手動加入 ${key}${patch.qty !== undefined ? ` 數量 ${cur.qty}→${patch.qty}` : ''}`,
      ops: [{ action: 'update', id: cur.inclusionId, soLineKey: key, before: { qty: cur.qty, routeType: cur.routeType, reason: cur.reason }, after: { qty: updated.qty, routeType: updated.routeType, reason: updated.reason } }],
    })
    return noStore<ManualMutationResponse>({ success: true, inclusions: [updated], skipped: [], revision: `m${opId ?? nowMs}` })
  } catch (e) {
    return dbFail('PATCH', e)
  }
}
