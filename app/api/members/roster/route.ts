import { NextResponse } from 'next/server'
import { formatSupabaseAdminError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

/**
 * 員工名冊（供任務看板等一般功能指派使用）。
 *
 * SEC 修復：取代任務看板等頁面用 anon key 直讀 members——那條路等於讓匿名可讀整張員工表
 * （含明文密碼欄位）。此端點：
 *   - 只要求「已登入」（guardAuth），任何登入同事都能取用（任務指派本來就需要看到同事清單）。
 *   - 只回傳指派所需的非機密欄位，**絕不含 password**。
 *   - 預設只回 status='Active' 的成員；帶 ?all=true 可取全部（仍不含 password）。
 */
export async function GET(request: Request) {
  const g = await guardAuth()
  if (!g.ok) return g.res
  try {
    const url = new URL(request.url)
    const all = url.searchParams.get('all') === 'true'

    const supabase = getSupabaseAdminClient()
    let query = supabase
      .from('members')
      .select('id, real_name, department, email, status, is_admin')
      .order('id', { ascending: true })
    if (!all) query = query.eq('status', 'Active')

    const { data, error } = await query
    if (error) {
      return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 500 })
    }
    return NextResponse.json({ ok: true, members: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}
