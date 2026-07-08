import { NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { loadLookups } from '@/lib/purchasing/data'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET：查詢建議清單（承辦人工號+姓名、OPEN PO 料號+品名），頁面 datalist 用。
// 僅採購權限（品項/承辦人屬採購單內容的衍生資訊）。
export async function GET() {
  const guard = await guardPermission('purchasing')
  if (!guard.ok) return guard.res

  try {
    const lookups = await loadLookups(getSupabaseAdminClient())
    return NextResponse.json({ success: true, ...lookups })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
