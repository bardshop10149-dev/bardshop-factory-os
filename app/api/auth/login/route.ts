import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseAdminClient } from '../../../../lib/supabaseAdmin'

// 管理員固定擁有所有權限
const ADMIN_PERMISSIONS = [
  'dashboard', 'notice', 'estimation', 'tasks',
  'qa_report', 'qa', 'production_admin', 'system_settings',
]

/**
 * 舊格式 permissions 正規化（與 login/page.tsx 原邏輯一致）
 */
function normalizeLegacyPermissions(raw: string[]): string[] {
  const out = new Set<string>()
  for (const p of raw) {
    if (p === 'production') out.add('dashboard')
    else if (p === 'admin') { out.add('production_admin'); out.add('system_settings') }
    else out.add(p)
  }
  return Array.from(out)
}

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

    // ── Step 3: 計算 role + permissions
    const finalPermissions = Boolean(member.is_admin)
      ? ADMIN_PERMISSIONS
      : normalizeLegacyPermissions(Array.isArray(member.permissions) ? member.permissions : [])
    const isAdmin = Boolean(member.is_admin) || finalPermissions.includes('production_admin')
    const role = isAdmin ? 'admin' : 'ops'

    // ── Step 4: 回寫 auth_user_id（若尚未設定）
    if (!member.auth_user_id && authData.user?.id) {
      await admin
        .from('members')
        .update({ auth_user_id: authData.user.id })
        .eq('id', member.id)
    }

    // ── Step 5: 設定 cookies
    //   - bardshop-token   → httpOnly（防 JS 竄改，middleware 可讀）
    //   - bardshop-refresh → httpOnly（Token refresh 用）
    //   - bardshop-role / bardshop-permissions → 非 httpOnly（前端 RBAC 顯示用）
    const maxAge = expires_in ?? 3600     // Supabase access_token 預設 1h
    const refreshMaxAge = 60 * 60 * 24 * 7  // refresh_token 7 天

    const response = NextResponse.json({
      ok: true,
      name: member.real_name,
      email: member.email,
      role,
    })

    // httpOnly cookies（安全憑證）
    response.headers.append('Set-Cookie',
      `bardshop-token=${access_token}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly`)
    response.headers.append('Set-Cookie',
      `bardshop-refresh=${refresh_token}; Path=/; Max-Age=${refreshMaxAge}; SameSite=Lax; HttpOnly`)

    // 前端可讀 cookies（僅 UI 邏輯用）
    response.headers.append('Set-Cookie',
      `bardshop-role=${role}; Path=/; Max-Age=${maxAge}; SameSite=Lax`)
    response.headers.append('Set-Cookie',
      `bardshop-permissions=${encodeURIComponent(finalPermissions.join(','))}; Path=/; Max-Age=${maxAge}; SameSite=Lax`)

    return response
  } catch (err) {
    console.error('[api/auth/login]', err)
    return NextResponse.json({ error: '伺服器發生錯誤，請稍後再試' }, { status: 500 })
  }
}
