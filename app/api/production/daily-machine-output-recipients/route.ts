import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth, guardPermission } from '@/lib/requireAuth'

// 各機台日產出通知信的收件人清單——存在 app_settings（跟 SARA CSV 交換區 buffer
// 同一套機制），可以自由新增/刪除，不用改程式碼或環境變數。
//
// GET  → 回傳目前收件人清單
// POST body: { action: 'add' | 'remove', email: string }

export const dynamic = 'force-dynamic'

const SETTINGS_KEY = 'daily_machine_output_recipients'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const sb = getSupabaseAdminClient()
    const { data } = await sb.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
    const recipients: string[] = Array.isArray(data?.value) ? (data!.value as string[]) : []
    return NextResponse.json({ success: true, recipients }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { action?: 'add' | 'remove'; email?: string }
    const email = (body.email ?? '').trim().toLowerCase()
    if (body.action !== 'add' && body.action !== 'remove') {
      return NextResponse.json({ success: false, error: 'action 必須是 add 或 remove' }, { status: 400 })
    }
    if (!email || (body.action === 'add' && !EMAIL_RE.test(email))) {
      return NextResponse.json({ success: false, error: '請提供有效的 email' }, { status: 400 })
    }

    const sb = getSupabaseAdminClient()
    const { data } = await sb.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
    const current: string[] = Array.isArray(data?.value) ? (data!.value as string[]) : []

    const next = body.action === 'add'
      ? (current.includes(email) ? current : [...current, email])
      : current.filter(e => e !== email)

    const { error } = await sb.from('app_settings').upsert(
      { key: SETTINGS_KEY, value: next, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
    if (error) throw error

    return NextResponse.json({ success: true, recipients: next })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
