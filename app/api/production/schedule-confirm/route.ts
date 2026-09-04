import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const TABLE = 'schedule_inquiries'

const SELECT_COLUMNS =
  'id,inquiry_date,customer_name,order_no,salesperson,items,planned_order_date,expected_date,remark,planner_reply,author_name,author_email,department,created_at,updated_at'

// 允許前端寫入/更新的欄位白名單。
// 注意：author_name / author_email 刻意不在此清單中——一律由伺服器依登入身分帶入，
// 不信任前端傳來的值（這是本次安全修復順便補上的正確行為）。
const ALLOWED_FIELDS = [
  'inquiry_date',
  'customer_name',
  'order_no',
  'salesperson',
  'items',
  'planned_order_date',
  'expected_date',
  'remark',
  'planner_reply',
  'updated_at',
] as const

function pickAllowed(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ALLOWED_FIELDS) {
    if (rec[k] !== undefined) out[k] = rec[k]
  }
  return out
}

// ============================================================
// GET：列出所有詢問紀錄（依 created_at 新到舊；篩選/排序邏輯維持在前端）
// ?count=pending：只回傳「尚未回覆」筆數（供後台導覽列提示徽章用，輕量 head 查詢）
// ============================================================
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()

    if (request.nextUrl.searchParams.get('count') === 'pending') {
      const { count, error } = await supabase
        .from(TABLE)
        .select('id', { count: 'exact', head: true })
        .is('planner_reply', null)

      if (error) {
        return NextResponse.json(
          { success: false, error: formatSupabaseAdminError(error.message) },
          { status: 500 }
        )
      }
      return NextResponse.json({ success: true, count: count ?? 0 })
    }

    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, records: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// POST：新增一筆詢問紀錄
// author_name 由伺服器依 guardAuth() 回傳的登入身分帶入
// （member.realName ?? member.email），不接受前端傳入的值。
// ============================================================
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const payload = {
      ...pickAllowed(body ?? {}),
      author_name: guard.member.realName ?? guard.member.email,
      author_email: guard.member.email,
    }

    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .insert(payload)
      .select(SELECT_COLUMNS)
      .single()

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, record: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// PATCH：更新一筆詢問紀錄（編輯內容 / 生管回覆 / 標記完成 / 取消完成）
// body: { id: number, fields: Partial<...> }
// ============================================================
export async function PATCH(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const id = Number(body?.id)
    const fields: Record<string, unknown> = body?.fields ?? {}

    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ success: false, error: 'id 不可為空' }, { status: 400 })
    }

    const cleaned = pickAllowed(fields)
    if (Object.keys(cleaned).length === 0) {
      return NextResponse.json({ success: false, error: '沒有可更新的欄位' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .update(cleaned)
      .eq('id', id)
      .select(SELECT_COLUMNS)
      .single()

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, record: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// DELETE：刪除一筆詢問紀錄（?id= 或 body 帶 { id }）
// ============================================================
export async function DELETE(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const url = new URL(request.url)
    let idRaw: string | null = url.searchParams.get('id')

    if (!idRaw) {
      try {
        const body = await request.json()
        idRaw = body?.id != null ? String(body.id) : null
      } catch {
        idRaw = null
      }
    }

    const id = idRaw ? Number(idRaw) : NaN
    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ success: false, error: 'id 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    // 權限：只有「填單本人」或管理員／生管可以刪除。
    // 原本這支只擋登入（guardAuth），任何登入者都能刪掉別人的詢問單——刪除不可復原，
    // 這裡補上擁有者檢查（2026-09-04 新增刪除按鈕時一併修正）。
    const { data: target, error: findErr } = await supabase
      .from(TABLE).select('id, author_email, customer_name').eq('id', id).maybeSingle()
    if (findErr) {
      return NextResponse.json({ success: false, error: formatSupabaseAdminError(findErr.message) }, { status: 500 })
    }
    if (!target) {
      return NextResponse.json({ success: false, error: '找不到這筆詢問單（可能已被刪除）' }, { status: 404 })
    }
    const isOwner = !!guard.member.email && guard.member.email === target.author_email
    const canManage = guard.member.isAdmin || guard.member.permissions.includes('production_admin')
    if (!isOwner && !canManage) {
      return NextResponse.json(
        { success: false, error: '只有填單人本人或生產管理可以刪除這筆詢問單' },
        { status: 403 }
      )
    }

    const { error } = await supabase.from(TABLE).delete().eq('id', id)

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, deleted_id: id })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
