import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * 忘記密碼：寄送 Supabase 密碼重設信。
 * 為防帳號列舉，無論該 Email 是否存在，一律回傳 ok。
 * 重設連結會導回本站 /reset-password 落地頁。
 */
export async function POST(request: Request) {
  try {
    const { email } = (await request.json().catch(() => ({}))) as { email?: string }
    const target = email?.trim().toLowerCase()
    if (!target) {
      return NextResponse.json({ error: '請提供 Email' }, { status: 400 })
    }

    const origin = request.headers.get('origin') ?? new URL(request.url).origin
    const redirectTo = `${origin}/reset-password`

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    await supabase.auth.resetPasswordForEmail(target, { redirectTo })

    return NextResponse.json({ ok: true })
  } catch {
    // 一律不洩漏細節
    return NextResponse.json({ ok: true })
  }
}
