import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const KEY = 'design_studio_inventory_watchlist'

export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()
    const { data } = await supabase
      .from('app_settings').select('value').eq('key', KEY).maybeSingle()
    const list = Array.isArray(data?.value) ? (data!.value as string[]) : []
    return NextResponse.json({ success: true, list }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const { list } = await request.json() as { list: string[] }
    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from('app_settings').upsert({
      key: KEY, value: list, updated_at: new Date().toISOString(),
    }, { onConflict: 'key' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
