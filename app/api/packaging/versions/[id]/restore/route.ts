import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { Placement, RestorePreviewResponse, RestoreResponse, VersionMeta } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { getPool, POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { buildSnapshot, parseSnapshot, planRestore } from '@/lib/packaging/scheduleSnapshot'
import { versionRowToMeta } from '@/lib/packaging/scheduleMap'
import {
  deleteExpiredVersions,
  deleteOpenPlacements,
  getOpLogMaxId,
  getVersionRow,
  insertOpLog,
  insertPlacements,
  insertVersion,
  loadOpenPlacements,
  publicDbError,
  verifyAndTouchLock,
} from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P1：版本還原（D33）。規格 §3.9、§四.5
//
// GET  （packaging_admin，不需鎖、不寫入）→ RestorePreviewResponse { version, plan }：先給主管看會動到幾張
// POST { lockToken }（packaging_admin＋編輯鎖）：
//   1. 先把目前的未完成擺放存成 auto_before_restore 備份（讓「還原」本身也能反悔）
//   2. 刪除所有未完成擺放（已完成列不動：完成是事實不是計畫）
//   3. 以新 id 寫入快照列（version 1）
//   → RestoreResponse { plan, backup, revision }
// 無交易：2 之後、3 之前失敗＝排程暫時清空，但一定已有備份版本，錯誤訊息會寫「請從版本 #N 還原」（規格 §9.1 第 1 條）。
// 只寫 packaging_schedule_versions／packaging_placements／packaging_op_log。

type Ctx = { params: Promise<{ id: string }> }

async function parseId(ctx: Ctx): Promise<number | null> {
  const raw = (await ctx.params).id
  const n = Number(raw)
  return /^\d{1,15}$/.test(raw ?? '') && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 目前待排池的 SO 行（lineGoneCount 用）；待排池暫時失敗不擋還原，只是這個數字算不出來 */
async function poolLineSet(): Promise<Set<string> | null> {
  try {
    const pool = await getPool({ maxAgeMs: POOL_WRITE_MAX_AGE_MS })
    const s = new Set<string>()
    for (const b of pool.blocks) for (const c of b.cards) s.add(c.soLineKey)
    return s
  } catch (e) {
    console.error('[packaging/restore] 待排池組裝失敗（lineGoneCount 以 0 計）:', describeError(e))
    return null
  }
}

export async function GET(_request: NextRequest, ctx: Ctx) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const id = await parseId(ctx)
  if (id == null) return noStore<RestorePreviewResponse>({ success: false, error: '版本編號錯誤', code: 'bad_request' }, 400)
  try {
    const sb = getSupabaseAdminClient()
    const row = await getVersionRow(sb, id)
    if (!row) return noStore<RestorePreviewResponse>({ success: false, error: '找不到這個版本（可能已超過 90 天被刪除）', code: 'not_found' }, 404)
    const snap = parseSnapshot(row.snapshot)
    if (!snap) return noStore<RestorePreviewResponse>({ success: false, error: '快照格式不符，無法還原', code: 'bad_request' }, 422)
    const [open, lines] = await Promise.all([loadOpenPlacements(sb), poolLineSet()])
    const today = todayTaipei()
    const { plan } = planRestore(open, snap, { today, poolLines: lines ?? new Set(snap.placements.map((p) => p.soLineKey)), newId: () => '' })
    return noStore<RestorePreviewResponse>({ success: true, version: versionRowToMeta(row), plan })
  } catch (e) {
    console.error('[packaging/restore GET]', describeError(e))
    return noStore<RestorePreviewResponse>({ success: false, error: publicDbError(e), code: 'db_error' }, 500)
  }
}

type RestoreFail = Extract<RestoreResponse, { success: false }>
const fail = (status: number, body: Omit<RestoreFail, 'success'>) => noStore<RestoreFail>({ success: false, ...body }, status)

export async function POST(request: NextRequest, ctx: Ctx) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const id = await parseId(ctx)
  if (id == null) return fail(400, { code: 'bad_request', error: '版本編號錯誤' })
  const body = await readJson(request)
  if (!body) return fail(400, { code: 'bad_request', error: '請求格式錯誤' })

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  const actor = { email: g.member.email, name: g.member.realName }
  let backup: VersionMeta | null = null
  let deleted = false
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: typeof body.lockToken === 'string' ? body.lockToken : null }, nowMs)
    if (!lk.ok) return fail(409, { code: lk.code, error: lk.code === 'lock_lost' ? '編輯權已被其他人接手' : '沒有編輯權或已逾時釋放，請重新取得編輯權' })

    const row = await getVersionRow(sb, id)
    if (!row) return fail(404, { code: 'not_found', error: '找不到這個版本（可能已超過 90 天被刪除）' })
    const snap = parseSnapshot(row.snapshot)
    if (!snap) return fail(422, { code: 'bad_request', error: '快照格式不符，無法還原' })

    const [open, lines] = await Promise.all([loadOpenPlacements(sb), poolLineSet()])

    // 1. 還原前自動備份（D33：讓還原本身可以反悔）
    backup = await insertVersion(sb, {
      label: `還原前備份（還原版本 #${id}）`,
      source: 'auto_before_restore',
      snapshot: buildSnapshot(open, today, nowIso),
      actorEmail: actor.email, actorName: actor.name,
    })

    const { plan, deleteIds, inserts } = planRestore(open, snap, {
      today,
      poolLines: lines ?? new Set(snap.placements.map((p) => p.soLineKey)),
      newId: () => crypto.randomUUID(),
    })

    // 2. 刪除所有未完成擺放（已完成列不動）
    await deleteOpenPlacements(sb, deleteIds)
    deleted = true

    // 3. 以新 id 寫入快照列
    const rows: Placement[] = inserts.map((r) => ({
      id: r.id, soLineKey: r.soLineKey, qty: r.qty, planDate: r.planDate, originalDate: r.originalDate,
      source: r.source, originCardId: r.originCardId, completed: null, version: 1,
      createdAt: nowIso, createdBy: actor.email, createdByName: actor.name,
      updatedAt: nowIso, updatedBy: actor.email, updatedByName: actor.name,
    }))
    await insertPlacements(sb, rows)

    await deleteExpiredVersions(sb, nowMs)
    const opId = await insertOpLog(sb, {
      actorEmail: actor.email, actorName: actor.name, kind: 'version_restore',
      label: `還原版本 #${id}「${row.label}」`,
      ops: [{ versionId: id, backupId: backup.id, ...plan }],
    })
    const revision = `r${opId ?? (await getOpLogMaxId(sb).catch(() => nowMs))}`
    return noStore<RestoreResponse>({ success: true, plan, backup, revision })
  } catch (e) {
    console.error('[packaging/restore POST]', describeError(e))
    const msg = publicDbError(e, '還原')
    const hint = deleted && backup ? `（排程可能已被清空，請從版本 #${backup.id}「還原前備份」還原）` : ''
    return fail(500, { code: 'db_error', error: `${msg}${hint}` })
  }
}
