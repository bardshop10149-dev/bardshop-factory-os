import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { ClosureErrorCode, ClosureResponse, ClosuresListResponse } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { invalidateManualCache } from '@/lib/packaging/manualCache'
import { isLineKey } from '@/lib/packaging/scheduleOps'
import { buildClosureSnapshot, isYmd, parseClosureHint, parseClosureNote } from '@/lib/packaging/closures'
import {
  CLOSURES_MIGRATION_FILE,
  insertClosure,
  listClosures,
  loadActiveClosureByKey,
  loadSimSessionSlices,
  removeLineFromSimSessions,
  restoreClosure,
  simSlicesHaveLine,
  unplaceOpenPlacements,
} from '@/lib/packaging/closuresDb'
import { loadActiveInclusionByKey, loadSoLinesForSos } from '@/lib/packaging/manualDb'
import { soLineNoStr } from '@/lib/packaging/manualPool'
import { allocateSoldToLines } from '@/lib/packaging/salesAlloc'
import { loadSalesForSos } from '@/lib/packaging/salesSync'
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
//             同一行已有未復原的結案 → 409 already_closed。ERP、手動加入、排程／模擬區都查無此行 → 404 not_found。
//   D110（結案加速）：close **不再重組待排池**（冷實例 getPool＋getManualMergedPool 實測 2.6～26.9 秒，只為了取快照）。
//             快照改由「單張 SO 的 erp_so_lines／erp_so_sales（各約 0.13 秒）」組；卡片所在區塊與整行在待排池的數量由前端以
//             hint: { block?, qty? } 帶入（逐欄驗證、其餘欄位不信任前端，closures.parseClosureHint）。
//             流程＝①並行讀（查重、ERP 行、銷貨、手動加入、該行排定卡、各人模擬區）→ ②insert → ③並行（放回排定卡、清模擬區）
//             → ④op_log → 回應。③④一定在回應「之前」做完：serverless 回應送出後函式可能被凍結，放到回應後會做一半。
//             回應多一欄 simVersion（結案的人自己的模擬區的新 version，見 scheduleTypes.ClosureResponse）。
//   restore ：把未復原的那筆寫 restored_*（紀錄保留）→ 下一次讀取該行照正常規則回待排池。沒有 → 404 not_found。
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD（packaging 讀權；台北日、含首尾；預設近 30 天；最多 500 筆）→ ClosuresListResponse
//
// D107（Snow 補充）：**不需要工作台編輯鎖**——結案不是排程動作（主管常在模擬區操作、沒拿鎖）；lockToken 送了也忽略。
//   沒有鎖就沒有序列化：刪排定卡用 version 條件（撞到就重讀再刪一輪），模擬區用 version CAS；工作台那邊拿到
//   version_conflict／not_found 會重新載入。結案表本身靠部分唯一索引擋同一行重複結案。
// Content-Type 必須 application/json（擋 CSRF）、回應 no-store。只寫 packaging_closures／packaging_placements（刪）／
// packaging_sim_sessions（該行移除）／packaging_op_log。資料一律用 EIP 鏡像，不查 ARGO。

type Fail = { success: false; error: string; code: ClosureErrorCode; closed?: boolean }
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

    // ── close（D110：不重組待排池）──
    const hint = parseClosureHint(body.hint)
    // ① 並行讀：全部是「這一行／這張 SO」的小查詢，加上各人模擬區（每位主管一列）
    const [dup, soLines, soSales, manualInc, linePlacements, simSlices] = await Promise.all([
      // 先擋重複（部分唯一索引最後還會擋一次；先查是為了給清楚的訊息）
      loadActiveClosureByKey(sb, key),
      loadSoLinesForSos(sb, [so]),
      // D73：結案當下分配到本行的已銷貨量（表不存在／讀取失敗 → null）。要整張 SO 的行與銷貨才能照項次分配（同品號多行）
      loadSalesForSos(sb, [so]),
      // D66 手動加入（erp_so_lines 查無時的退路）；手動加入表未建 → 當作沒有
      loadActiveInclusionByKey(sb, key).catch((e: unknown) => {
        if (isMissingSchema(e)) return null
        throw e
      }),
      loadPlacementsByLines(sb, [key]),
      loadSimSessionSlices(sb),
    ])
    if (dup) return fail(409, 'already_closed', '這一行已經結案（要重新拉回待排池請到「結案池」復原）')

    const sl = soLines.find((l) => l.project_id.trim().toUpperCase() === so && soLineNoStr(l.line_no) === soLine) ?? null
    const sold = soSales && sl ? allocateSoldToLines(soLines, soSales).byLine.get(key) ?? null : null
    const snapshot = buildClosureSnapshot({
      soLineKey: key, so, soLine,
      erpLine: sl,
      manualQty: manualInc ? manualInc.qty : null,
      knownToSchedule: linePlacements.length > 0 || simSlicesHaveLine(simSlices, key),
      soldQty: sold ? sold.soldQty : null,
      hint,
      note: note.note,
    })
    if (!snapshot) return fail(404, 'not_found', 'ERP、手動加入與排程裡都查無此品項行（可能單號錯誤）')

    // ② 結案紀錄
    const inserted = await insertClosure(sb, snapshot, actor, nowIso)
    if (inserted === 'duplicate') return fail(409, 'already_closed', '這一行已經結案（剛被別人結案）')
    invalidateManualCache()

    // ③ 正式區：該行未完成的排定卡放回（刪除）；模擬區：該行模擬卡移除。兩者互不相干 → 並行；失敗都不撤回結案
    //    （結案紀錄已成立＝該行已不在待排池，留下的卡工作台會當「行已不在待排池」略過；錯誤回給前端提示重新整理）
    const open = linePlacements.filter((p) => !p.completed)
    const [unplacedR, simR] = await Promise.allSettled([
      unplaceOpenPlacements(sb, open),
      removeLineFromSimSessions(sb, key, nowIso, simSlices),
    ])
    const unplaced = unplacedR.status === 'fulfilled' ? summarize(unplacedR.value) : []
    const sim = simR.status === 'fulfilled' ? simR.value : { removed: 0, sessions: [] }
    const sideFailure = unplacedR.status === 'rejected' ? unplacedR.reason : simR.status === 'rejected' ? simR.reason : null
    let sideError: string | null = null
    if (sideFailure != null) {
      console.error('[packaging/closures close 附帶清理]', describeError(sideFailure))
      sideError = publicDbError(sideFailure, '結案後清理排定卡／模擬卡')
    }

    // ④ 操作紀錄（工作台輪詢指紋也看它）
    const opId = await insertOpLog(sb, {
      actorEmail: actor.email, actorName: actor.name, kind: 'closure', label: `結案 ${key}${unplaced.length ? `（放回 ${unplaced.length} 張排定卡）` : ''}`,
      ops: [{ action: 'close', closureId: inserted.id, soLineKey: key, note: note.note, qtyAtClose: snapshot.qtyAtClose, blockAtClose: snapshot.blockAtClose, unplaced, simRemoved: sim.removed, ms: Date.now() - nowMs }],
    })
    if (sideError) {
      // 結案已成立；附帶清理沒做完 → 回 500＋closed: true（前端不把卡放回畫面，只提示重新整理；工作台會略過那些卡）
      console.error(`[packaging/closures] 結案 #${inserted.id}（op_log ${opId ?? '未記'}）附帶清理失敗：${sideError}`)
      return noStore<Fail>({ success: false, code: 'db_error', closed: true, error: `已結案，但放回排定卡／清模擬區時失敗（${sideError}），請重新整理確認` }, 500)
    }
    const me = actor.email.trim().toLowerCase()
    return noStore<ClosureResponse>({
      success: true, closure: inserted, unplaced: unplaced.length, simRemoved: sim.removed,
      simVersion: sim.sessions.find((x) => x.ownerEmail === me)?.version ?? null,
    })
  } catch (e) {
    return dbFail(action, e)
  }
}

/** op_log 用的排定卡摘要（不存整列） */
function summarize(list: readonly { id: string; version: number; qty: number; planDate: string | null; lineId?: number | null }[]) {
  return list.map((p) => ({ id: p.id, version: p.version, qty: p.qty, planDate: p.planDate, lineId: p.lineId ?? null }))
}
