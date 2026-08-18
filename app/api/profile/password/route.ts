import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

/**
 * 使用者「自助修改密碼」。
 * 流程：先用「目前密碼」驗證身分（防 session 被盜後任意改密碼），
 *       再以 service_role 更新 Supabase Auth 密碼，並同步 members.password。
 */
export async function POST(request: Request) {
  const g = await guardAuth()
  if (!g.ok) return g.res

  const body = (await request.json().catch(() => ({}))) as {
    current_password?: string
    new_password?: string
  }
  const currentPassword = body.current_password
  const newPassword = body.new_password

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: '請輸入目前密碼與新密碼' }, { status: 400 })
  }
  if (newPassword.length < 6) {
    return NextResponse.json({ error: '新密碼至少需 6 碼' }, { status: 400 })
  }
  if (newPassword === currentPassword) {
    return NextResponse.json({ error: '新密碼不可與目前密碼相同' }, { status: 400 })
  }

  // 1. 驗證「目前密碼」是否正確（對自己的 email 做一次登入驗證）
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email: g.member.email,
    password: currentPassword,
  })
  if (signInErr || !signIn?.session) {
    return NextResponse.json({ error: '目前密碼不正確' }, { status: 400 })
  }

  // 2. 以 service_role 更新 Auth 登入密碼
  const admin = getSupabaseAdminClient()
  const { error: updErr } = await admin.auth.admin.updateUserById(g.member.authUserId, {
    password: newPassword,
  })
  if (updErr) {
    return NextResponse.json({ error: `更新密碼失敗: ${updErr.message}` }, { status: 400 })
  }

  // SEC 修復 V1：不再把明文密碼同步寫回 members.password。
  // 登入完全走 Supabase Auth（signInWithPassword），該欄位只寫不讀、純屬外洩風險，故移除寫入。

  return NextResponse.json({ ok: true })
}
