import { NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

/**
 * 個人中心 —— 目前登入者「自己」的資料。
 * 一律以 guardAuth 取得的身分為準，使用者只能讀/改自己。
 */

// GET: 取得自己的個人資料
export async function GET() {
  const g = await guardAuth()
  if (!g.ok) return g.res

  const admin = getSupabaseAdminClient()
  const { data, error } = await admin
    .from('members')
    .select('real_name, nickname, department, email, last_login')
    .eq('email', g.member.email)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 500 })
  }

  return NextResponse.json({
    real_name: data?.real_name ?? g.member.realName ?? '',
    nickname: data?.nickname ?? '',
    department: data?.department ?? '',
    email: data?.email ?? g.member.email,
    last_login: data?.last_login ?? null,
  })
}

// PATCH: 更新自己「可自編」的欄位（目前僅暱稱；姓名/部門/Email/權限不開放自改）
export async function PATCH(request: Request) {
  const g = await guardAuth()
  if (!g.ok) return g.res

  const body = (await request.json().catch(() => ({}))) as { nickname?: string }
  if (typeof body.nickname !== 'string') {
    return NextResponse.json({ error: '沒有可更新的欄位' }, { status: 400 })
  }
  const nickname = body.nickname.trim()
  if (nickname.length > 50) {
    return NextResponse.json({ error: '暱稱請勿超過 50 字' }, { status: 400 })
  }

  const admin = getSupabaseAdminClient()
  const { error } = await admin
    .from('members')
    .update({ nickname })
    .eq('email', g.member.email)

  if (error) {
    return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
