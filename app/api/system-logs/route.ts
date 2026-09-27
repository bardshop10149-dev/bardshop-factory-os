import { NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

/**
 * 系統操作日誌寫入（lib/logger.ts 的後端）。
 *
 * 以前 logger 在瀏覽器端用 anon key 直接 insert system_logs，操作者靠 supabase.auth.getUser()
 * 判斷——但 EIP 的登入是伺服器端 httpOnly cookie，瀏覽器根本沒有 Supabase session，
 * 所以每一筆都記成 "Unknown"。改由這裡以 guardAuth 認定操作者，前端只送「做了什麼」。
 */

type Body = {
  actionType?: string
  target?: string
  module?: string
  details?: string
  metadata?: Record<string, unknown>
}

const MAX_TEXT = 2000

function clip(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

export async function POST(request: Request) {
  const g = await guardAuth()
  if (!g.ok) return g.res

  const body = (await request.json().catch(() => ({}))) as Body
  const actionType = clip(body.actionType, 100)
  if (!actionType) return NextResponse.json({ error: '缺少 actionType' }, { status: 400 })

  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata
    : {}

  const admin = getSupabaseAdminClient()
  const { error } = await admin.from('system_logs').insert({
    actor_user_id: g.member.authUserId,
    user_name: g.member.realName || g.member.email,
    user_email: g.member.email,
    user_department: g.member.department,
    action_type: actionType,
    target_resource: clip(body.target, 500) || '-',
    module: clip(body.module, 100) || null,
    details: clip(body.details),
    metadata,
  })
  if (error) {
    return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
