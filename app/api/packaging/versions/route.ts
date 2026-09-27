import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { VersionCreateResponse, VersionsListResponse } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { buildSnapshot, snapshotTooLarge } from '@/lib/packaging/scheduleSnapshot'
import {
  deleteExpiredVersions,
  insertOpLog,
  insertVersion,
  latestVersionAt,
  listVersions,
  loadOpenPlacements,
  publicDbError,
  verifyAndTouchLock,
} from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'

export const dynamic = 'force-dynamic'

// 包裝專區 P1：版本快照（D33）。規格 §3.9、§四.5
//
// GET                    （讀）→ VersionsListResponse：只回 meta（不含 snapshot），近 90 天、新到舊、最多 200 筆
// POST { lockToken, label }（packaging_admin＋編輯鎖）→ 把「目前所有未完成擺放」存成快照（source = manual），
//                         順手刪 90 天前的版本 → VersionCreateResponse
// 快照不改排程，所以不進 Undo。只寫 packaging_schedule_versions／packaging_op_log。

const LIST_LIMIT = 200
const LABEL_MAX = 80
/** 同一人手動建立版本的最短間隔（快照是整份排程的 jsonb，連點或腳本重送會一直累積在正式站） */
const CREATE_MIN_INTERVAL_MS = 30_000

export async function GET() {
  const g = await guardPackaging('read')
  if (!g.ok) return g.res
  try {
    const sb = getSupabaseAdminClient()
    const versions = await listVersions(sb, Date.now(), LIST_LIMIT)
    return noStore<VersionsListResponse>({ success: true, versions })
  } catch (e) {
    console.error('[packaging/versions GET]', describeError(e))
    return noStore({ success: false, error: publicDbError(e), code: 'db_error' }, 500)
  }
}

type CreateFail = Extract<VersionCreateResponse, { success: false }>
const fail = (status: number, body: Omit<CreateFail, 'success'>) => noStore<CreateFail>({ success: false, ...body }, status)

export async function POST(request: NextRequest) {
  const g = await guardPackaging('write')
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  const label = typeof body?.label === 'string' ? body.label.trim() : ''
  if (!body || label.length < 1 || label.length > LABEL_MAX) return fail(400, { code: 'bad_request', error: `版本名稱須為 1～${LABEL_MAX} 字` })

  const nowMs = Date.now()
  const actor = { email: g.member.email, name: g.member.realName }
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: actor.email, token: typeof body.lockToken === 'string' ? body.lockToken : null }, nowMs)
    if (!lk.ok) return fail(409, { code: lk.code, error: lk.code === 'lock_lost' ? '編輯權已被其他人接手' : '沒有編輯權或已逾時釋放，請重新取得編輯權' })

    const last = await latestVersionAt(sb, actor.email, 'manual')
    if (last && nowMs - Date.parse(last) < CREATE_MIN_INTERVAL_MS) {
      return fail(429, { code: 'bad_request', error: `剛剛才存過版本，請 ${Math.ceil(CREATE_MIN_INTERVAL_MS / 1000)} 秒後再試` })
    }

    const open = await loadOpenPlacements(sb)
    const snapshot = buildSnapshot(open, todayTaipei(new Date(nowMs)), new Date(nowMs).toISOString())
    const big = snapshotTooLarge(snapshot)
    if (big) return fail(422, { code: 'bad_request', error: big })
    const version = await insertVersion(sb, { label, source: 'manual', snapshot, actorEmail: actor.email, actorName: actor.name })
    await deleteExpiredVersions(sb, nowMs)
    await insertOpLog(sb, { actorEmail: actor.email, actorName: actor.name, kind: 'version_create', label, ops: [{ versionId: version.id, placementCount: version.placementCount }] })
    return noStore<VersionCreateResponse>({ success: true, version })
  } catch (e) {
    console.error('[packaging/versions POST]', describeError(e))
    return fail(500, { code: 'db_error', error: publicDbError(e) })
  }
}
