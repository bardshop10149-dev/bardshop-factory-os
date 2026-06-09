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

    const payloadBase = {
      real_name: body.real_name,
      nickname: body.nickname ?? '',
      department: body.department,
      email,
      password,
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
