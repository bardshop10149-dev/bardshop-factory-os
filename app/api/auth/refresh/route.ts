import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseAdminClient } from '../../../../lib/supabaseAdmin'
import { buildSessionCookies, derivePermissions } from '../../../../lib/authShared'

export const dynamic = 'force-dynamic'

/**
 * Session 續期：用 httpOnly `bardshop-refresh` 換一組新 token，重設 4 顆 session cookies。
 *
 * 背景（2026-07-14）：登入時已發 7 天 refresh token，但先前沒有任何程式使用它——
 * access token（bardshop-token）一到 Supabase JWT 時效就整組過期，開著的頁面所有
 * API 呼叫開始 401「鬼打牆」，只能 F5 重新登入。此 endpoint + SessionKeeper
 * （root layout 掛載，定時/回前景時呼叫）讓 session 在頁面使用中自動延續。
 *
 * 設計：
 * - access token 剩餘壽命 > 15 分鐘 → no-op（避免多分頁同時 rotate 單次性 refresh token）
 * - 只讀寫 httpOnly cookies，回應不含任何 token 值
 * - 續期時重查 members 重發 role/permissions cookies（權限調整會在下次續期生效）
 */

const REFRESH_AHEAD_SECONDS = 15 * 60

/** 解出 JWT payload 的 exp（不驗簽——僅用於「要不要續期」的判斷；真正驗證在 requireAuth） */
function jwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

export async function POST() {
  let accessToken: string | undefined
  let refreshToken: string | undefined
  try {
    const store = await cookies()
    accessToken = store.get('bardshop-token')?.value
    refreshToken = store.get('bardshop-refresh')?.value
  } catch {
    return NextResponse.json({ ok: false, error: '無法讀取 cookies' }, { status: 400 })
  }

  if (!refreshToken) {
    return NextResponse.json({ ok: false, error: '無續期憑證' }, { status: 401 })
  }

  // 還很新鮮就不動（多分頁防撞：refresh token 為單次性輪替）
  if (accessToken) {
    const exp = jwtExp(accessToken)
    if (exp && exp - Math.floor(Date.now() / 1000) > REFRESH_AHEAD_SECONDS) {
      return NextResponse.json({ ok: true, refreshed: false })
    }
  }

  try {
    // 用 refresh token 換新 session（anon client，Auth API）
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data.session || !data.user) {
      // refresh token 也失效（>7 天未用或已被輪替淘汰）→ 需重新登入
      return NextResponse.json({ ok: false, error: '續期失效，請重新登入' }, { status: 401 })
    }
    const { access_token, refresh_token, expires_in } = data.session

    // 重查 members 取得最新角色/權限（與 requireAuth 相同：先 auth_user_id 再 email）
    const admin = getSupabaseAdminClient()
    let member: { real_name: string | null; is_admin: boolean | null; permissions: unknown } | null = null
    const byId = await admin
      .from('members')
      .select('real_name, is_admin, permissions')
      .eq('auth_user_id', data.user.id)
      .maybeSingle()
    member = byId.data
    if (!member && data.user.email) {
      const byEmail = await admin
        .from('members')
        .select('real_name, is_admin, permissions')
        .eq('email', data.user.email)
        .maybeSingle()
      member = byEmail.data
    }
    if (!member) {
      return NextResponse.json({ ok: false, error: '找不到對應成員' }, { status: 403 })
    }

    const { role, permissions } = derivePermissions(member)
    const response = NextResponse.json({ ok: true, refreshed: true })
    for (const c of buildSessionCookies({
      accessToken: access_token,
      refreshToken: refresh_token ?? refreshToken,
      expiresIn: expires_in,
      role,
      permissions,
    })) response.headers.append('Set-Cookie', c)
    return response
  } catch (err) {
    console.error('[api/auth/refresh]', err)
    return NextResponse.json({ ok: false, error: '伺服器發生錯誤' }, { status: 500 })
  }
}
