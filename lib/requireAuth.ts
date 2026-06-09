import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSupabaseAdminClient } from './supabaseAdmin'

/**
 * 伺服器端認證 / 授權守門。
 *
 * 設計原則(對應 SEC-03 / SEC-04 修復):
 *   - 只信任 httpOnly 的 `bardshop-token`(Supabase access_token),並向 Supabase Auth
 *     實際驗證(`auth.getUser(token)` 會驗簽章與到期)。
 *   - 角色 / 權限一律以資料庫 `members` 為準,**不信任前端可竄改的 `bardshop-role`
 *     / `bardshop-permissions` cookie**。
 *
 * 用法(non-throwing,方便在 route handler 直接 early-return):
 *   const g = await guardAdmin()
 *   if (!g.ok) return g.res
 *   const member = g.member
 */

export type AuthedMember = {
  authUserId: string
  email: string
  realName: string | null
  isAdmin: boolean
  permissions: string[]
}

type Guarded =
  | { ok: true; member: AuthedMember }
  | { ok: false; res: NextResponse }

function deny(status: number, message: string): { ok: false; res: NextResponse } {
  return { ok: false, res: NextResponse.json({ error: message }, { status }) }
}

/**
 * 驗證請求附帶的 `bardshop-token`,回傳對應的 members 資料。
 * 失敗時回傳可直接 return 的 NextResponse。
 */
export async function guardAuth(): Promise<Guarded> {
  let token: string | undefined
  try {
    const cookieStore = await cookies()
    token = cookieStore.get('bardshop-token')?.value
  } catch {
    return deny(401, '未登入')
  }

  if (!token) return deny(401, '未登入')

  let admin
  try {
    admin = getSupabaseAdminClient()
  } catch (err) {
    console.error('[requireAuth] admin client 建立失敗:', err)
    return deny(500, '伺服器設定錯誤')
  }

  // 向 Supabase Auth 驗證 access_token(驗簽章 + 到期)。
  // 傳入 token 時,此呼叫使用該使用者 token 而非 service key。
  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  if (userErr || !userData?.user) {
    return deny(401, '登入已失效，請重新登入')
  }
  const authUser = userData.user

  // 角色 / 權限以 DB 為準:先用 auth_user_id,再退回 email(與 lib/logger.ts 一致)。
  let member: {
    email: string | null
    real_name: string | null
    is_admin: boolean | null
    permissions: unknown
  } | null = null

  const byId = await admin
    .from('members')
    .select('email, real_name, is_admin, permissions')
    .eq('auth_user_id', authUser.id)
    .maybeSingle()
  member = byId.data

  if (!member && authUser.email) {
    const byEmail = await admin
      .from('members')
      .select('email, real_name, is_admin, permissions')
      .eq('email', authUser.email)
      .maybeSingle()
    member = byEmail.data
  }

  if (!member) return deny(403, '找不到對應成員，請聯絡管理員')

  return {
    ok: true,
    member: {
      authUserId: authUser.id,
      email: member.email ?? authUser.email ?? '',
      realName: member.real_name ?? null,
      isAdmin: Boolean(member.is_admin),
      permissions: Array.isArray(member.permissions)
        ? (member.permissions as string[])
        : [],
    },
  }
}

/** 需要管理員。 */
export async function guardAdmin(): Promise<Guarded> {
  const g = await guardAuth()
  if (!g.ok) return g
  if (!g.member.isAdmin) return deny(403, '需要管理員權限')
  return g
}

/** 需要特定權限(admin 自動通過)。 */
export async function guardPermission(permission: string): Promise<Guarded> {
  const g = await guardAuth()
  if (!g.ok) return g
  if (g.member.isAdmin) return g
  if (!g.member.permissions.includes(permission)) {
    return deny(403, `需要權限：${permission}`)
  }
  return g
}
