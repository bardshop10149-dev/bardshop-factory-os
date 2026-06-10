import { NextResponse } from 'next/server'
import { formatSupabaseAdminError, getSupabaseAdminClient } from '../../../../../lib/supabaseAdmin'
import { guardAdmin } from '../../../../../lib/requireAuth'

/**
 * 設定 / 重設某成員的「Supabase Auth 登入密碼」。
 *
 * 背景（修復「團隊管理改密碼不生效」）：
 *   登入是用 Supabase Auth 驗證密碼，但團隊管理改密碼原本只 UPDATE 了 members.password，
 *   從未寫進 Auth，導致改了密碼仍登不進去。此端點以 service_role 真正更新 Auth：
 *   - 已有 Auth 帳號 → 更新密碼
 *   - 尚無 Auth 帳號（例如自助申請、從未建立登入帳號者）→ 一併建立並回綁 auth_user_id
 */

type SetPasswordBody = {
  memberId?: number
  email?: string
  password?: string
}

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

    const body = (await request.json()) as SetPasswordBody
    const password = body.password
    if (!password || password.length < 6) {
      return NextResponse.json({ error: '密碼至少需 6 碼' }, { status: 400 })
    }

    // 找出該成員（優先用 memberId，其次 email）
    const lookup = supabaseAdmin.from('members').select('id, email, auth_user_id')
    const { data: member } = body.memberId != null
      ? await lookup.eq('id', body.memberId).maybeSingle()
      : await lookup.eq('email', (body.email ?? '').trim()).maybeSingle()

    if (!member) {
      return NextResponse.json({ error: '找不到該成員' }, { status: 404 })
    }
    if (!member.email) {
      return NextResponse.json({ error: '該成員沒有 email，無法設定登入帳號' }, { status: 400 })
    }

    // 找對應的 Auth 使用者：有就改密碼，沒有就建立
    const authUser = await findAuthUserByEmail(member.email)
    let authUserId: string

    if (authUser) {
      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, { password })
      if (updErr) {
        return NextResponse.json({ error: `更新登入密碼失敗: ${updErr.message}` }, { status: 400 })
      }
      authUserId = authUser.id
    } else {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: member.email,
        password,
        email_confirm: true,
      })
      if (createErr || !created?.user?.id) {
        return NextResponse.json({ error: `建立登入帳號失敗: ${createErr?.message ?? '未知錯誤'}` }, { status: 400 })
      }
      authUserId = created.user.id
    }

    // 確保 members.auth_user_id 與 Auth 綁定一致
    if (member.auth_user_id !== authUserId) {
      await supabaseAdmin.from('members').update({ auth_user_id: authUserId }).eq('id', member.id)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}
