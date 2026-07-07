import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// Allowlist of keys that client pages may read/write via this route.
const ALLOWED_KEYS = new Set(['due_date_thresholds', 'material_prep_plate_prefixes', 'material_prep_overrides'])

// GET /api/app-settings?key=<key>
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  const key = new URL(request.url).searchParams.get('key')
  if (!key || !ALLOWED_KEYS.has(key)) {
    return NextResponse.json({ error: 'invalid key' }, { status: 400 })
  }
  const supabase = getSupabaseAdminClient()
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .single()
  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ value: data?.value ?? null })
}

// PUT /api/app-settings  body: { key, value }
export async function PUT(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  let body: { key?: string; value?: unknown }
  try { body = await request.json() as { key?: string; value?: unknown } }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }
  const { key, value } = body
  if (!key || !ALLOWED_KEYS.has(key)) {
    return NextResponse.json({ error: 'invalid key' }, { status: 400 })
  }
  const supabase = getSupabaseAdminClient()
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
