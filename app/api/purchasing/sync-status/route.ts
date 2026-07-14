import { NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// GET：採購單同步（sync_po）最近執行紀錄 — 供採購專區顯示「上次更新時間」。
// 主來源 erp_sync_logs（每次同步一列，含 0 變動的執行；service-role only 故須經此後端）。
// 後備：erp_sync_logs 無資料（migration 未跑／log 被略過）時，退回 erp_pj_sync
// 採購單號列的最大 synced_at（僅變動列會更新，時間為近似值 → source 標記 'synced_at'）。
export async function GET() {
  const guard = await guardPermission('purchasing')
  if (!guard.ok) return guard.res

  const supabase = getSupabaseAdminClient()
  try {
    const { data, error } = await supabase
      .from('erp_sync_logs')
      .select('created_at, ok, count, inserted, updated, deleted, unchanged, elapsed_ms, message')
      .eq('action', 'sync_po')
      .order('created_at', { ascending: false })
      .limit(6)

    if (!error && data && data.length > 0) {
      return NextResponse.json({
        success: true,
        source: 'logs',
        last: data[0],
        recent: data.map(r => r.created_at),
      })
    }

    // 後備：同步表最後寫入時間（近似）
    const { data: pj, error: pjErr } = await supabase
      .from('erp_pj_sync')
      .select('synced_at')
      .eq('doc_type', '採購單號')
      .order('synced_at', { ascending: false })
      .limit(1)
    if (pjErr) throw pjErr
    const at = pj?.[0]?.synced_at ?? null
    return NextResponse.json({
      success: true,
      source: 'synced_at',
      last: at ? { created_at: at, ok: true } : null,
      recent: at ? [at] : [],
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
