import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { ClosureErrorCode, ClosureResponse, ClosuresListResponse } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { getPool, POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { getManualMergedPool, invalidateManualCache } from '@/lib/packaging/manualCache'
import { isLineKey } from '@/lib/packaging/scheduleOps'
import { isYmd, parseClosureNote } from '@/lib/packaging/closures'
import {
  CLOSURES_MIGRATION_FILE,
  insertClosure,
  listClosures,
  loadActiveClosureByKey,
  removeLineFromSimSessions,
  restoreClosure,
  unplaceOpenPlacements,
} from '@/lib/packaging/closuresDb'
import { loadSoLinesForSos } from '@/lib/packaging/manualDb'
import { soLineNoStr } from '@/lib/packaging/manualPool'
import { allocateSoldToLines } from '@/lib/packaging/salesAlloc'
import { loadSalesForSos } from '@/lib/packaging/salesSync'
import { normDate } from '@/lib/packaging/classify'
import { insertOpLog, isMissingSchema, loadPlacementsByLines, publicDbError } from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區：D104 主管結案（顆粒度＝SO 品項行）。規格 docs/design/2026-09-27-packaging-lines.md 第十四章
//
// POST ClosureRequest { action: 'close' | 'restore', soLineKey, note? }（packaging_admin；admin 自動通過，D30）→ ClosureResponse
//   close   ：packaging_closures 記一筆（未復原）→ 該行永久不進待排池（含 D66 手動加入）。同時：
//             ① 正式區該行「未完成」的排定卡以 id＋version 條件刪除（同放回待排池；已完成的不動）
//             ② 各人模擬區（packaging_sim_sessions.placements）該行的模擬卡以 version CAS 移除
//             ③ op_log kind 'closure'（不進 Undo：結案是單據事實，誤結請到「已結案清單」復原）
//             同一行已有未復原的結案 → 409 already_closed。ERP 與待排池都查無此行 → 404 not_found。
//   restore ：把未復原的那筆寫 restored_*（紀錄保留）→ 下一次讀取該行照正常規則回待排池。沒有 → 404 not_found。
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD（packaging 讀權；台北日、含首尾；預設近 30 天；最多 500 筆）→ ClosuresListResponse
//
// D107（Snow 補充）：**不需要工作台編輯鎖**——結案不是排程動作（主管常在模擬區操作、沒拿鎖）；lockToken 送了也忽略。
//   沒有鎖就沒有序列化：刪排定卡用 version 條件（撞到就重讀再刪一輪），模擬區用 version CAS；工作台那邊拿到
//   version_conflict／not_found 會重新載入。結案表本身靠部分唯一索引擋同一行重複結案。
// Content-Type 必須 application/json（擋 CSRF）、回應 no-store。只寫 packaging_closures／packaging_placements（刪）／
// packaging_sim_sessions（該行移除）／packaging_op_log。資料一律用 EIP 鏡像，不查 ARGO。

type Fail = { success: false; error: string; code: ClosureErrorCode }
const fail = (status: number, code: ClosureErrorCode, error: string) => noStore<Fail>({ success: false, code, error }, status)
const LINE_KEY_SPLIT_RE = /^(.+)-(\d{1,4})$/
const DEFAULT_LIST_DAYS = 30
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

function dbFail(where: string, e: unknown) {
  console.error(`[packaging/closures ${where}]`, describeError(e))
  if (isMissingSchema(e)) return fail(409, 'migration_required', `找不到資料表（結案功能尚未啟用），請先套用 ${CLOSURES_MIGRATION_FILE}`)
  return fail(500, 'db_error', publicDbError(e))
}

// ─────────────────────────────────────────────────────────────────────
// GET：已結案清單
// ─────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const g = await guardPackaging('read')
  if (!g.ok) return g.res
  const sp = request.nextUrl.searchParams
  const today = todayTaipei()
  const toRaw = sp.get('to')
  const fromRaw = sp.get('from')
  const to = isYmd(toRaw) ? toRaw : today
  const from = isYmd(fromRaw) ? fromRaw : addDays(to, -(DEFAULT_LIST_DAYS - 1))
  if (from > to) return noStore<ClosuresListResponse>({ success: false, code: 'bad_request', error: 'from 不可晚於 to' }, 400)
  try {
    const closures = await listClosures(getSupabaseAdminClient(), from, to)
    return noStore<ClosuresListResponse>({ success: true, from, to, closures })
  } catch (e) {
    return dbFail('GET', e)
  }
}

// ─────────────────────────────────────────────────────────────────────
// POST：結案／復原
// ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return fail(400, 'bad_request', '請求格式錯誤（須為 JSON 物件）')
  const action = body.action
  if (action !== 'close' && action !== 'restore') return fail(400, 'bad_request', 'action 只能是 close 或 restore')
  const key = typeof body.soLineKey === 'string' ? body.soLineKey.trim().toUpperCase() : ''
  const m = key.match(LINE_KEY_SPLIT_RE)
  if (!isLineKey(key) || !m) return fail(400, 'bad_request', '品項行格式錯誤（例：SO260924020-1）')
  const note = parseClosureNote(body.note)
  if (!note.ok) return fail(400, 'bad_request', note.message)

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const actor = { email: g.member.email, name: g.member.realName }
  const so = m[1]
  const soLine = String(parseInt(m[2], 10))

  try {
    const sb = getSupabaseAdminClient()

    if (action === 'restore') {
      const cur = await loadActiveClosureByKey(sb, key)
      if (!cur) return fail(404, 'not_found', '這一行沒有未復原的結案（可能已被復原）')
      const restored = await restoreClosure(sb, cur.id, actor, nowIso)
      if (!restored) return fail(404, 'not_found', '這一行沒有未復原的結案（可能剛被別人復原）')
      invalidateManualCache()
      await insertOpLog(sb, {
        actorEmail: actor.email, actorName: actor.name, kind: 'closure', label: `復原結案 ${key}`,
        ops: [{ action: 'restore', closureId: cur.id, soLineKey: key }],
      })
      return noStore<ClosureResponse>({ success: true, closure: restored, unplaced: 0, simRemoved: 0 })
    }

    // ── close ──
    // 先擋重複（部分唯一索引最後還會擋一次；先查是為了給清楚的訊息，不必先做完快照組裝）
    if (await loadActiveClosureByKey(sb, key)) return fail(409, 'already_closed', '這一行已經結案（要重新拉回待排池請到「已結案清單」復原）')

    // 結案當下的快照：待排池（含手動區塊、已扣掉其他結案行）裡這一行的卡；不在池內時退回 erp_so_lines
    const [basePool, soLines, soSales] = await Promise.all([
      getPool({ maxAgeMs: POOL_WRITE_MAX_AGE_MS }).catch((e: unknown) => {
        console.error('[packaging/closures] 待排池組裝失敗:', describeError(e))
        return null
      }),
      loadSoLinesForSos(sb, [so]),
      // D73：結案當下分配到本行的已銷貨量（表不存在／讀取失敗 → null）
      loadSalesForSos(sb, [so]),
    ])
    if (!basePool) return fail(500, 'pool_unavailable', '待排池暫時無法組裝，無法結案，請稍後再試')
    const merged = await getManualMergedPool(sb, basePool)
    const cards = merged.pool.blocks.flatMap((b) => b.cards).filter((c) => c.soLineKey.toUpperCase() === key)
    const sl = soLines.find((l) => l.project_id.trim().toUpperCase() === so && soLineNoStr(l.line_no) === soLine) ?? null
    if (cards.length === 0 && !sl) return fail(404, 'not_found', 'ERP 與待排池都查無此品項行（可能已結案或單號錯誤）')

    const first = cards[0] ?? null
    const sold = soSales ? allocateSoldToLines(soLines, soSales).byLine.get(key) ?? null : null
    const snapshot = {
      soLineKey: key, so, soLine,
      itemCode: first?.itemCode ?? ((sl?.mbp_part ?? '').trim() || null),
      itemName: first?.itemName ?? ((sl?.description ?? '').trim() || null),
      customer: first?.customer ?? sl?.partner_name ?? null,
      qtyAtClose: first ? Math.round(cards.reduce((a, c) => a + c.qtyCard, 0) * 1000) / 1000 : Math.max(0, Number(sl?.order_qty_oru) || 0),
      dueDate: first?.dueDate ?? (sl ? normDate(sl.duedate) : null),
      blockAtClose: first?.block ?? null,
      soldQtyAtClose: sold ? Math.round(sold.soldQty * 1000) / 1000 : null,
      note: note.note,
    }
    const inserted = await insertClosure(sb, snapshot, actor, nowIso)
    if (inserted === 'duplicate') return fail(409, 'already_closed', '這一行已經結案（剛被別人結案）')
    invalidateManualCache()

    // ① 正式區：該行未完成的排定卡放回（刪除）；② 模擬區：該行模擬卡移除。兩者失敗都不撤回結案
    //    （結案紀錄已成立＝該行已不在待排池，留下的卡工作台會當「行已不在待排池」略過；錯誤回給前端提示重新整理）
    let unplaced: ReturnType<typeof summarize> = []
    let simRemoved = 0
    let sideError: string | null = null
    try {
      const open = (await loadPlacementsByLines(sb, [key])).filter((p) => !p.completed)
      unplaced = summarize(await unplaceOpenPlacements(sb, open))
      simRemoved = await removeLineFromSimSessions(sb, key, nowIso)
    } catch (e) {
      console.error('[packaging/closures close 附帶清理]', describeError(e))
      sideError = publicDbError(e, '結案後清理排定卡／模擬卡')
    }

    const opId = await insertOpLog(sb, {
      actorEmail: actor.email, actorName: actor.name, kind: 'closure', label: `結案 ${key}${unplaced.length ? `（放回 ${unplaced.length} 張排定卡）` : ''}`,
      ops: [{ action: 'close', closureId: inserted.id, soLineKey: key, note: note.note, qtyAtClose: snapshot.qtyAtClose, blockAtClose: snapshot.blockAtClose, unplaced, simRemoved }],
    })
    if (sideError) {
      // 結案已成立；附帶清理沒做完 → 回 500 讓前端提示（前端會重新載入，工作台會略過那些卡）
      console.error(`[packaging/closures] 結案 #${inserted.id}（op_log ${opId ?? '未記'}）附帶清理失敗：${sideError}`)
      return fail(500, 'db_error', `已結案，但放回排定卡／清模擬區時失敗（${sideError}），請重新整理確認`)
    }
    return noStore<ClosureResponse>({ success: true, closure: inserted, unplaced: unplaced.length, simRemoved })
  } catch (e) {
    return dbFail(action, e)
  }
}

/** op_log 用的排定卡摘要（不存整列） */
function summarize(list: readonly { id: string; version: number; qty: number; planDate: string | null; lineId?: number | null }[]) {
  return list.map((p) => ({ id: p.id, version: p.version, qty: p.qty, planDate: p.planDate, lineId: p.lineId ?? null }))
}
