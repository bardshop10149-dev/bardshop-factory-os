import { NextResponse } from 'next/server'
import { guardAuth } from '@/lib/requireAuth'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { derivePermissions } from '@/lib/authShared'

export const dynamic = 'force-dynamic'

/**
 * 回傳「目前登入者自己」的身分與權限。
 *
 * 用途（SEC 修復）：取代前端頁面原本用 anon key 直接 `select is_admin, permissions from members`
 * 來判斷自己權限的做法——那條路徑一旦 members 開了 RLS 就會失效，且原本等於讓 anon 可讀整張
 * members（含明文密碼）。改由後端 guardAuth() 驗證 token 後、以 service role 查 DB 回傳，
 * 前端不再需要、也不應該直接碰 members 表。
 */
export async function GET() {
  const g = await guardAuth()
  if (!g.ok) return g.res

  // guardAuth 已從 DB 取得 is_admin / permissions；用共用邏輯推導最終權限（與登入一致）
  const { role, permissions } = derivePermissions({
    is_admin: g.member.isAdmin,
    permissions: g.member.permissions,
  })

  // 額外補 department（部分頁面顯示身分需要；guardAuth 本身不含此欄位）
  let department: string | null = null
  try {
    const { data } = await getSupabaseAdminClient()
      .from('members')
      .select('department')
      .eq('email', g.member.email)
      .maybeSingle()
    department = (data?.department as string | null) ?? null
  } catch { /* 取不到 department 不影響權限判斷 */ }

  return NextResponse.json({
    ok: true,
    email: g.member.email,
    real_name: g.member.realName,
    department,
    is_admin: g.member.isAdmin,
    role,
    permissions,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
