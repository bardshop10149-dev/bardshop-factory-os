import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import {
  MAX_ACTIVE_LINES,
  MAX_LINES,
  type LineErrorCode,
  type LineMutationResponse,
  type LinesResponse,
  type LockState,
} from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { defaultLineIdOf, isValidLineCode, nextLineCode, validateLineName } from '@/lib/packaging/scheduleLines'
import {
  ScheduleDbError,
  countOpenOnLine,
  insertLine,
  insertOpLog,
  isMissingSchema,
  linesMigrationMessage,
  loadLines,
  publicDbError,
  updateLine,
  verifyAndTouchLock,
} from '@/lib/packaging/scheduleDb'

export const dynamic = 'force-dynamic'

// 包裝專區 P1 分線輪：產線（線別）管理（D67／D71）。規格 docs/design/2026-09-27-packaging-lines.md §3.3、§4.4
//
// GET                    （讀）→ LinesResponse { lines（全部，含停用）, defaultLineId }
// POST  LineCreateRequest { lockToken, name, code? }（packaging_admin＋編輯鎖）→ LineMutationResponse
//   code 省略＝自動取下一個沒用過的 A～Z；code 須 ^[A-Z0-9]{1,4}$、不重複（code_exists）；
//   總數 ≤ MAX_LINES（too_many_lines）、啟用 ≤ MAX_ACTIVE_LINES（too_many_active）；sort_order＝目前最大＋10。
// PATCH LinePatchRequest { lockToken, id, name?, active?, sortOrder? } → LineMutationResponse
//   停用前該線不能有「未完成、已排進日期」的卡（line_has_cards，附 cardCount；不自動搬卡——會悄悄改掉主管安排且不在 Undo 裡）；
//   不能停用最後一條啟用中的線（last_active_line）；重新啟用檢查啟用上限。
// 線不能刪（歷史擺放與產能要留著），只能停用。寫 op_log（kind 'lines'）；不進 Undo（同產能、快照）。
// 只寫 packaging_lines／packaging_op_log（＋鎖續命）。

type Fail = Extract<LineMutationResponse, { success: false }>
const fail = (status: number, body: Omit<Fail, 'success'>) => noStore<Fail>({ success: false, ...body }, status)
const lockFail = (code: 'lock_required' | 'lock_lost', lock: LockState) =>
  fail(409, { code, lock, error: code === 'lock_lost' ? `編輯權已由 ${lock.holderName ?? lock.holderEmail ?? '其他人'} 接手` : '沒有編輯權或已逾時釋放，請重新取得編輯權' })
const PG_UNIQUE = '23505'

function dbFail(where: string, e: unknown) {
  console.error(`[packaging/lines ${where}]`, describeError(e))
  if (isMissingSchema(e)) return fail(409, { code: 'migration_required', error: linesMigrationMessage(e) })
  return fail(500, { code: 'db_error', error: publicDbError(e) })
}

export async function GET() {
  const g = await guardPackaging('read')
  if (!g.ok) return g.res
  try {
    const lines = await loadLines(getSupabaseAdminClient())
    return noStore<LinesResponse>({ success: true, lines, defaultLineId: defaultLineIdOf(lines) })
  } catch (e) {
    console.error('[packaging/lines GET]', describeError(e))
    const code: LineErrorCode = isMissingSchema(e) ? 'migration_required' : 'db_error'
    return noStore<LinesResponse>({ success: false, code, error: code === 'migration_required' ? linesMigrationMessage(e) : publicDbError(e) }, code === 'migration_required' ? 409 : 500)
  }
}

export async function POST(request: NextRequest) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return fail(400, { code: 'bad_request', error: '請求格式錯誤' })
  const nameErr = validateLineName(body.name)
  if (nameErr) return fail(400, { code: 'bad_request', error: nameErr })
  const name = (body.name as string).trim()
  const codeRaw = body.code == null || body.code === '' ? null : String(body.code).trim().toUpperCase()
  if (codeRaw != null && !isValidLineCode(codeRaw)) return fail(400, { code: 'bad_request', error: '代碼須為 1～4 個英文大寫或數字' })

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const actor = { email: g.member.email, name: g.member.realName }
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: typeof body.lockToken === 'string' ? body.lockToken : null }, nowMs)
    if (!lk.ok) return lockFail(lk.code, lk.lock)

    const lines = await loadLines(sb)
    if (lines.length >= MAX_LINES) return fail(409, { code: 'too_many_lines', error: `產線最多 ${MAX_LINES} 條（含停用）`, lock: lk.lock })
    if (lines.filter((l) => l.active).length >= MAX_ACTIVE_LINES) {
      return fail(409, { code: 'too_many_active', error: `同時啟用最多 ${MAX_ACTIVE_LINES} 條線，請先停用一條`, lock: lk.lock })
    }
    const code = codeRaw ?? nextLineCode(lines)
    if (!code) return fail(409, { code: 'too_many_lines', error: '英文代碼 A～Z 都用完了，請自訂代碼', lock: lk.lock })
    if (lines.some((l) => l.code.toUpperCase() === code)) return fail(409, { code: 'code_exists', error: `代碼 ${code} 已被使用`, lock: lk.lock })
    const sortOrder = Math.min(999, lines.reduce((m, l) => Math.max(m, l.sortOrder), 0) + 10)

    let line
    try {
      line = await insertLine(sb, { code, name, sortOrder, actorEmail: actor.email, actorName: actor.name, nowIso })
    } catch (e) {
      if (e instanceof ScheduleDbError && e.pgCode === PG_UNIQUE) return fail(409, { code: 'code_exists', error: `代碼 ${code} 已被使用`, lock: lk.lock })
      throw e
    }
    await insertOpLog(sb, { actorEmail: actor.email, actorName: actor.name, kind: 'lines', label: `新增產線 ${code}「${name}」`, ops: [{ action: 'create', id: line.id, code, name, sortOrder }] })
    const after = await loadLines(sb)
    return noStore<LineMutationResponse>({ success: true, line, lines: after, lock: lk.lock })
  } catch (e) {
    return dbFail('POST', e)
  }
}

export async function PATCH(request: NextRequest) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return fail(400, { code: 'bad_request', error: '請求格式錯誤' })
  const id = body.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 32767) return fail(400, { code: 'bad_request', error: 'id 須為正整數' })
  const patch: { name?: string; active?: boolean; sort_order?: number } = {}
  if (body.name !== undefined) {
    const err = validateLineName(body.name)
    if (err) return fail(400, { code: 'bad_request', error: err })
    patch.name = (body.name as string).trim()
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return fail(400, { code: 'bad_request', error: 'active 須為 true / false' })
    patch.active = body.active
  }
  if (body.sortOrder !== undefined) {
    const so = body.sortOrder
    if (typeof so !== 'number' || !Number.isInteger(so) || so < 0 || so > 999) return fail(400, { code: 'bad_request', error: '排序須為 0～999 的整數' })
    patch.sort_order = so
  }
  if (Object.keys(patch).length === 0) return fail(400, { code: 'bad_request', error: '沒有要修改的欄位' })

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const actor = { email: g.member.email, name: g.member.realName }
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: typeof body.lockToken === 'string' ? body.lockToken : null }, nowMs)
    if (!lk.ok) return lockFail(lk.code, lk.lock)

    const lines = await loadLines(sb)
    const cur = lines.find((l) => l.id === id)
    if (!cur) return fail(404, { code: 'not_found', error: '找不到這條線', lock: lk.lock })

    if (patch.active === false && cur.active) {
      // lines.md §3.3：不能停用最後一條啟用線；停用前該線不能有未完成、已排進日期的卡（過去日期的延誤卡也算）
      if (lines.filter((l) => l.active && l.id !== id).length === 0) {
        return fail(409, { code: 'last_active_line', error: '至少要保留一條啟用中的線', lock: lk.lock })
      }
      const n = await countOpenOnLine(sb, id)
      if (n > 0) return fail(409, { code: 'line_has_cards', cardCount: n, error: `${cur.name}還有 ${n} 張卡，請先移到其他線再停用`, lock: lk.lock })
    }
    if (patch.active === true && !cur.active && lines.filter((l) => l.active).length >= MAX_ACTIVE_LINES) {
      return fail(409, { code: 'too_many_active', error: `同時啟用最多 ${MAX_ACTIVE_LINES} 條線，請先停用一條`, lock: lk.lock })
    }

    const line = await updateLine(sb, id, patch, actor, nowIso)
    if (!line) return fail(404, { code: 'not_found', error: '找不到這條線', lock: lk.lock })
    const what = [
      patch.name !== undefined && patch.name !== cur.name ? `改名「${cur.name}」→「${patch.name}」` : '',
      patch.active !== undefined && patch.active !== cur.active ? (patch.active ? '啟用' : '停用') : '',
      patch.sort_order !== undefined && patch.sort_order !== cur.sortOrder ? '調整排序' : '',
    ].filter(Boolean).join('、') || '更新'
    await insertOpLog(sb, {
      actorEmail: actor.email, actorName: actor.name, kind: 'lines', label: `產線 ${cur.code}：${what}`,
      ops: [{ action: 'update', id, before: { name: cur.name, active: cur.active, sortOrder: cur.sortOrder }, after: { name: line.name, active: line.active, sortOrder: line.sortOrder } }],
    })
    const after = await loadLines(sb)
    return noStore<LineMutationResponse>({ success: true, line, lines: after, lock: lk.lock })
  } catch (e) {
    return dbFail('PATCH', e)
  }
}
