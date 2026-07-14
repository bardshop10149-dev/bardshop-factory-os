import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseAdminClient } from '../../../../lib/supabaseAdmin'
import { buildSessionCookies, derivePermissions } from '../../../../lib/authShared'

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string }
    const email = body.email?.trim().toLowerCase()
    const password = body.password

    if (!email || !password) {
      return NextResponse.json({ error: '請輸入 Email 與密碼' }, { status: 400 })
    }

    // ── Step 1: Supabase Auth 驗證（anon key，此為 Auth API，非 DB 操作）
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password })

    if (authError || !authData.session) {
      // 不透露是帳號還是密碼錯，防止帳號列舉
      return NextResponse.json({ error: '帳號或密碼錯誤' }, { status: 401 })
    }

    const { access_token, refresh_token, expires_in } = authData.session

    // ── Step 2: 用 service_role 查 members 取得角色/權限（不走 RLS）
    const admin = getSupabaseAdminClient()
    const { data: member, error: memberError } = await admin
      .from('members')
      .select('id, email, real_name, is_admin, permissions, auth_user_id')
      .eq('email', email)
      .maybeSingle()

    if (memberError || !member) {
      return NextResponse.json({ error: '找不到對應成員，請聯絡管理員' }, { status: 403 })
    }

    // ── Step 3: 計算 role + permissions（與 refresh endpoint 共用 lib/authShared）
    const { role, permissions: finalPermissions } = derivePermissions(member)

    // ── Step 4: 回寫 auth_user_id（若尚未設定）
    if (!member.auth_user_id && authData.user?.id) {
      await admin
        .from('members')
        .update({ auth_user_id: authData.user.id })
        .eq('id', member.id)
    }

    // ── Step 5: 設定 cookies（與 /api/auth/refresh 共用 buildSessionCookies）
    //   - bardshop-token   → httpOnly（防 JS 竄改，middleware 可讀）
    //   - bardshop-refresh → httpOnly（/api/auth/refresh 續期用）
    //   - bardshop-role / bardshop-permissions → 非 httpOnly（前端 RBAC 顯示用）
    const response = NextResponse.json({
      ok: true,
      name: member.real_name,
      email: member.email,
      role,
    })
    for (const c of buildSessionCookies({
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in,
      role,
      permissions: finalPermissions,
    })) response.headers.append('Set-Cookie', c)

    return response
  } catch (err) {
    console.error('[api/auth/login]', err)
    return NextResponse.json({ error: '伺服器發生錯誤，請稍後再試' }, { status: 500 })
  }
}
