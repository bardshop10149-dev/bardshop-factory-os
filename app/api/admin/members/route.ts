import { NextResponse } from 'next/server'
import { formatSupabaseAdminError, getSupabaseAdminClient } from '../../../../lib/supabaseAdmin'
import { guardAdmin } from '../../../../lib/requireAuth'

type CreateMemberBody = {
  real_name?: string
  nickname?: string
  department?: string
  email?: string
  password?: string
  permissions?: string[]
  status?: string
  is_admin?: boolean
  is_pending_approval?: boolean
}

const isMissingPendingColumnError = (error: { message?: string } | null | undefined) =>
  Boolean(error?.message?.includes('is_pending_approval'))

const normalizeEmail = (email: string) => email.trim().toLowerCase()

async function findAuthUserByEmail(email: string) {
  const supabaseAdmin = getSupabaseAdminClient()
  const target = normalizeEmail(email)

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error

    const users = data?.users ?? []
    const matched = users.find((user) => normalizeEmail(user.email || '') === target)
    if (matched) return matched

    if (users.length < 200) break
  }

  return null
}

export async function POST(request: Request) {
  try {
    const guard = await guardAdmin()
    if (!guard.ok) return guard.res
    const supabaseAdmin = getSupabaseAdminClient()

    const body = (await request.json()) as CreateMemberBody
    const email = body.email?.trim()
    const password = body.password

    if (!email || !password || !body.real_name || !body.department) {
      return NextResponse.json({ error: '缺少必填欄位' }, { status: 400 })
    }

    let authUserId: string | null = null

    const { data: createdUserData, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        real_name: body.real_name,
        nickname: body.nickname || '',
        department: body.department,
      },
    })

    if (createUserError) {
      const existingUser = await findAuthUserByEmail(email)
      if (!existingUser?.id) {
        return NextResponse.json({ error: `建立 Auth 使用者失敗: ${createUserError.message}` }, { status: 400 })
      }
      authUserId = existingUser.id
    } else {
      authUserId = createdUserData.user?.id ?? null
    }

    // SEC 修復 V1：密碼只寫進 Supabase Auth（上面 createUser 已帶入），
    // members 表不再存明文 password 欄位。
    const payloadBase = {
      real_name: body.real_name,
      nickname: body.nickname ?? '',
      department: body.department,
      email,
      permissions: Array.isArray(body.permissions) ? body.permissions : [],
      status: body.status ?? 'Active',
      is_admin: Boolean(body.is_admin),
      auth_user_id: authUserId,
    }

    const payloadWithPending = {
      ...payloadBase,
      is_pending_approval: Boolean(body.is_pending_approval),
    }

    const { data: existingMember } = await supabaseAdmin
      .from('members')
      .select('id')
      .eq('email', email)
      .maybeSingle()

    if (existingMember?.id) {
      return NextResponse.json({ error: `Email「${email}」已存在於 members。` }, { status: 409 })
    }

    let insertError = null
    const { error: firstInsertError } = await supabaseAdmin.from('members').insert([payloadWithPending])

    if (isMissingPendingColumnError(firstInsertError)) {
      const { error: retryError } = await supabaseAdmin.from('members').insert([payloadBase])
      insertError = retryError
    } else {
      insertError = firstInsertError
    }

    if (insertError) {
      return NextResponse.json(
        { error: `新增 members 失敗: ${formatSupabaseAdminError(insertError.message)}` },
        { status: 400 }
      )
    }

    return NextResponse.json({ ok: true, auth_user_id: authUserId })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}

// ============================================================
// GET：列出所有 members（供組織成員管理頁使用）
// SEC 修復：取代前端 anon key 直讀 members；一律不回傳 password 欄位。
// ============================================================
export async function GET() {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.res
  try {
    const supabaseAdmin = getSupabaseAdminClient()
    const { data, error } = await supabaseAdmin
      .from('members')
      .select('id, auth_user_id, real_name, nickname, department, email, permissions, status, is_admin, is_pending_approval, last_login')
      .order('is_admin', { ascending: false })
      .order('id', { ascending: true })
    if (error) {
      return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 500 })
    }
    return NextResponse.json({ ok: true, members: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}

// ============================================================
// PATCH：更新一筆 member（權限 / 角色 / 部門 / 狀態…）
// SEC 修復 V2：取代前端 anon update members（提權漏洞根源——anon 原本可把自己 is_admin 改成 true）。
// 欄位白名單，且刻意不接受 password（改密碼一律走 /api/admin/members/set-password）。
// ============================================================
export async function PATCH(request: Request) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.res
  try {
    const body = (await request.json()) as { id?: number; fields?: Record<string, unknown> }
    const id = Number(body?.id)
    const fields = body?.fields ?? {}
    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ error: '缺少 member id' }, { status: 400 })
    }

    const ALLOWED = ['real_name', 'nickname', 'department', 'email', 'permissions', 'status', 'is_admin', 'is_pending_approval'] as const
    const cleaned: Record<string, unknown> = {}
    for (const k of ALLOWED) {
      if (fields[k] !== undefined) cleaned[k] = fields[k]
    }
    if (Object.keys(cleaned).length === 0) {
      return NextResponse.json({ error: '沒有可更新的欄位' }, { status: 400 })
    }

    const supabaseAdmin = getSupabaseAdminClient()
    // 先嘗試含 is_pending_approval 的更新；若該欄位不存在則退回不含它
    let { error } = await supabaseAdmin.from('members').update(cleaned).eq('id', id)
    if (isMissingPendingColumnError(error)) {
      const withoutPending = { ...cleaned }
      delete withoutPending.is_pending_approval
      ;({ error } = await supabaseAdmin.from('members').update(withoutPending).eq('id', id))
    }
    if (error) {
      return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}

// ============================================================
// DELETE：刪除一筆 member（?id= 或 body { id }）
// SEC 修復：取代前端 anon delete members。
// ============================================================
export async function DELETE(request: Request) {
  const guard = await guardAdmin()
  if (!guard.ok) return guard.res
  try {
    const url = new URL(request.url)
    let idRaw = url.searchParams.get('id')
    if (!idRaw) {
      try {
        const body = await request.json()
        idRaw = body?.id != null ? String(body.id) : null
      } catch { idRaw = null }
    }
    const id = idRaw ? Number(idRaw) : NaN
    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ error: '缺少 member id' }, { status: 400 })
    }
    const supabaseAdmin = getSupabaseAdminClient()
    const { error } = await supabaseAdmin.from('members').delete().eq('id', id)
    if (error) {
      return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}
