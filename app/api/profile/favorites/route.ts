import { NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

/**
 * 側欄「我的最愛」——目前登入者自己的 members.favorites。
 *
 * 取代 context/FavoritesContext.tsx 原本用 anon key 直讀／直改 members 的做法
 * （那條路等於任何人都能 update 任何成員的任何欄位，含 is_admin）。
 * 身分一律以 guardAuth 為準，只能讀寫自己那一列。
 */

const MAX_ITEMS = 200
const MAX_PATH_LEN = 200

export async function GET() {
  const g = await guardAuth()
  if (!g.ok) return g.res

  const admin = getSupabaseAdminClient()
  const { data, error } = await admin
    .from('members')
    .select('favorites')
    .eq('email', g.member.email)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 500 })
  }
  const favorites = Array.isArray(data?.favorites) ? (data.favorites as string[]) : []
  return NextResponse.json({ favorites }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(request: Request) {
  const g = await guardAuth()
  if (!g.ok) return g.res

  const body = (await request.json().catch(() => ({}))) as { favorites?: unknown }
  const favorites = body.favorites
  if (
    !Array.isArray(favorites) ||
    favorites.length > MAX_ITEMS ||
    !favorites.every(p => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_LEN)
  ) {
    return NextResponse.json({ error: 'favorites 格式不正確' }, { status: 400 })
  }

  const admin = getSupabaseAdminClient()
  const { error } = await admin
    .from('members')
    .update({ favorites })
    .eq('email', g.member.email)
  if (error) {
    return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
