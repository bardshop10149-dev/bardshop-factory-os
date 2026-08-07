import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

/**
 * SARA 資料交換區 API
 *
 * ── 塔台端（外部呼叫）──────────────────────────────────────────────
 * GET  /api/sara/exchange
 *   Header: Authorization: Bearer <SARA_EXCHANGE_API_KEY>
 *   Params:
 *     type           - 篩選資料類型（如 mo_list）；不填則回傳全部
 *     ref_key        - 篩選參考鍵
 *     since          - 篩選 created_at >= (YYYY-MM-DD 或 ISO)
 *     status         - 'pending'（預設）| 'consumed' | 'all'
 *     mark_consumed  - 'true' → 拉取後自動標記為 consumed
 *     limit          - 最多回傳幾筆（預設 500）
 *
 * ── 管理端（需 production_admin 權限）─────────────────────────────
 * POST /api/sara/exchange
 *   Body: { data_type, ref_key?, payload, note?, expires_at? }
 *   → 寫入一筆交換資料
 *
 * DELETE /api/sara/exchange
 *   Body: { ids?: number[], older_than_days?: number, status?: string }
 *   → 刪除指定條件的資料
 */

const TABLE = 'sara_exchange'

/** 驗證塔台 API Key */
function checkApiKey(request: NextRequest): boolean {
  const envKey = process.env.SARA_EXCHANGE_API_KEY
  if (!envKey) return false  // 未設定則拒絕

  // Authorization: Bearer <key>
  const auth = request.headers.get('authorization') ?? ''
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() === envKey
  }
  // 或 query param ?api_key=<key>（方便測試）
  const { searchParams } = new URL(request.url)
  return searchParams.get('api_key') === envKey
}

// ── GET：塔台拉取資料 ────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  if (!checkApiKey(request)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: invalid or missing API key' },
      { status: 401 }
    )
  }

  const { searchParams } = new URL(request.url)
  const type         = searchParams.get('type')         // 篩選 data_type
  const refKey       = searchParams.get('ref_key')      // 篩選 ref_key
  const since        = searchParams.get('since')        // created_at >=
  const statusFilter = searchParams.get('status') ?? 'pending'  // pending | consumed | all
  const markConsumed = searchParams.get('mark_consumed') === 'true'
  const limit        = Math.min(parseInt(searchParams.get('limit') ?? '500', 10) || 500, 2000)

  const supabase = getSupabaseAdminClient()
  let q = supabase
    .from(TABLE)
    .select('id,data_type,ref_key,payload,status,note,created_at,consumed_at,expires_at')
    .order('created_at', { ascending: true })
    .limit(limit)

  if (type) q = q.eq('data_type', type)
  if (refKey) q = q.eq('ref_key', refKey)
  if (since) q = q.gte('created_at', since)
  if (statusFilter !== 'all') q = q.eq('status', statusFilter)

  // 過濾未到期
  q = q.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)

  const { data, error } = await q
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const rows = data ?? []

  // 標記為 consumed
  if (markConsumed && rows.length > 0) {
    const ids = rows.map(r => r.id)
    await supabase
      .from(TABLE)
      .update({ status: 'consumed', consumed_at: new Date().toISOString() })
      .in('id', ids)
  }

  return NextResponse.json({
    success: true,
    count: rows.length,
    data: rows,
    fetched_at: new Date().toISOString(),
  })
}

// ── POST：管理端寫入資料 ─────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res

  try {
    const body = await request.json() as {
      data_type?: string
      ref_key?: string
      payload?: unknown
      note?: string
      expires_at?: string
      // 批次寫入
      batch?: Array<{ data_type: string; ref_key?: string; payload: unknown; note?: string }>
    }

    const supabase = getSupabaseAdminClient()

    // 批次寫入
    if (Array.isArray(body.batch) && body.batch.length > 0) {
      const rows = body.batch.map(b => ({
        data_type:  b.data_type,
        ref_key:    b.ref_key ?? null,
        payload:    b.payload,
        note:       b.note ?? null,
        status:    'pending',
      }))
      const { data, error } = await supabase.from(TABLE).insert(rows).select('id,data_type,ref_key,created_at')
      if (error) throw error
      return NextResponse.json({ success: true, inserted: data?.length ?? 0, rows: data })
    }

    // 單筆寫入
    if (!body.data_type || body.payload === undefined) {
      return NextResponse.json({ success: false, error: '請提供 data_type 和 payload' }, { status: 400 })
    }
    const { data, error } = await supabase.from(TABLE).insert({
      data_type:  body.data_type,
      ref_key:    body.ref_key ?? null,
      payload:    body.payload,
      note:       body.note ?? null,
      expires_at: body.expires_at ?? null,
      status:    'pending',
    }).select().single()
    if (error) throw error
    return NextResponse.json({ success: true, row: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// ── DELETE：管理端清除資料 ───────────────────────────────────────────
export async function DELETE(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res

  try {
    const body = await request.json() as {
      ids?: number[]
      older_than_days?: number
      status?: string
    }

    const supabase = getSupabaseAdminClient()

    if (Array.isArray(body.ids) && body.ids.length > 0) {
      const { error } = await supabase.from(TABLE).delete().in('id', body.ids)
      if (error) throw error
      return NextResponse.json({ success: true, deleted_ids: body.ids })
    }

    let q = supabase.from(TABLE).delete()
    if (body.older_than_days) {
      const cutoff = new Date(Date.now() - body.older_than_days * 86400_000).toISOString()
      q = q.lt('created_at', cutoff)
    }
    if (body.status) {
      q = q.eq('status', body.status)
    }
    const { error } = await q
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
