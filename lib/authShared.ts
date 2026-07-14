// 登入 / 續期共用的角色權限邏輯（原內嵌於 app/api/auth/login/route.ts，
// 因 refresh endpoint 也需要同一套推導，抽出單一來源）

/** 管理員固定擁有所有權限 */
export const ADMIN_PERMISSIONS = [
  'dashboard', 'notice', 'estimation', 'tasks',
  'qa_report', 'qa', 'production_admin', 'system_settings',
  'argo_db', 'design', 'material', 'product_dev', 'info_board', 'argo_tool',
  'purchasing',
]

/** 舊格式 permissions 正規化（與 login/page.tsx 原邏輯一致） */
export function normalizeLegacyPermissions(raw: string[]): string[] {
  const out = new Set<string>()
  for (const p of raw) {
    if (p === 'production') out.add('dashboard')
    else if (p === 'admin') { out.add('production_admin'); out.add('system_settings') }
    else out.add(p)
  }
  return Array.from(out)
}

/** 由 members 列推導 role 與最終 permissions（login / refresh 共用） */
export function derivePermissions(member: { is_admin: boolean | null; permissions: unknown }): {
  role: 'admin' | 'ops'
  permissions: string[]
} {
  const finalPermissions = Boolean(member.is_admin)
    ? ADMIN_PERMISSIONS
    : normalizeLegacyPermissions(Array.isArray(member.permissions) ? (member.permissions as string[]) : [])
  const isAdmin = Boolean(member.is_admin) || finalPermissions.includes('production_admin')
  return { role: isAdmin ? 'admin' : 'ops', permissions: finalPermissions }
}

/** 登入 / 續期共用：組出 4 顆 session cookies 的 Set-Cookie 字串 */
export function buildSessionCookies(args: {
  accessToken: string
  refreshToken: string
  expiresIn: number | null | undefined
  role: string
  permissions: string[]
}): string[] {
  const maxAge = args.expiresIn ?? 3600        // Supabase access_token 預設 1h
  const refreshMaxAge = 60 * 60 * 24 * 7       // refresh_token 7 天
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return [
    `bardshop-token=${args.accessToken}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${secure}`,
    `bardshop-refresh=${args.refreshToken}; Path=/; Max-Age=${refreshMaxAge}; SameSite=Lax; HttpOnly${secure}`,
    `bardshop-role=${args.role}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`,
    `bardshop-permissions=${encodeURIComponent(args.permissions.join(','))}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`,
  ]
}
