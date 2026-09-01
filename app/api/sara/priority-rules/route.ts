import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, describeError } from '@/lib/supabaseAdmin'
import { guardAuth, guardPermission } from '@/lib/requireAuth'
import { DEFAULT_PRIORITY_RULES, PRIORITY_RULES_SETTINGS_KEY, normalizePriorityRules } from '@/lib/sara/priorityRules'

export const dynamic = 'force-dynamic'

// SARA 交期優先度規則的讀寫（app_settings.sara_priority_rules）。
// GET：目前生效的規則（未設定時回預設）；PUT：整組覆蓋（production_admin）。
export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const sb = getSupabaseAdminClient()
    const { data } = await sb.from('app_settings').select('value').eq('key', PRIORITY_RULES_SETTINGS_KEY).maybeSingle()
    const rules = data?.value != null ? normalizePriorityRules(data.value) : DEFAULT_PRIORITY_RULES
    return NextResponse.json({ success: true, rules, is_default: data?.value == null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: describeError(e) }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { rules?: unknown }
    const rules = normalizePriorityRules(body.rules)
    const sb = getSupabaseAdminClient()
    const { error } = await sb.from('app_settings').upsert(
      { key: PRIORITY_RULES_SETTINGS_KEY, value: rules, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
    if (error) throw error
    return NextResponse.json({ success: true, rules })
  } catch (e) {
    return NextResponse.json({ success: false, error: describeError(e) }, { status: 500 })
  }
}
