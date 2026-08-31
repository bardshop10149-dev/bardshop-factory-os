import { NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// 塔台排程唯讀查詢（供「塔台即時看板」的排程檢視使用）。
// sara_wip_schedule 有 RLS、anon 讀不到，因此由這支 API 以 service role 代讀，
// 僅回傳顯示需要的欄位。資料由 /api/sara/wip-sync 定時從塔台同步，本 API 不做任何寫入。
export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()
    // 只取「還沒過期」的排程：計畫結束時間在昨天以後（plan_* 為 'YYYY-MM-DD HH:mm' 文字，
    // 字串比較即可），加上目前標記為進行中的
    const nowTaipei = new Date(Date.now() + 8 * 3600 * 1000)
    const y = new Date(nowTaipei.getTime() - 24 * 3600 * 1000)
    const yesterdayStr = `${y.getUTCFullYear()}-${String(y.getUTCMonth() + 1).padStart(2, '0')}-${String(y.getUTCDate()).padStart(2, '0')}`

    const { data, error } = await supabase
      .from('sara_wip_schedule')
      .select('jid, mo_nbr, doc_nbr, so_line_no, product_name, lot_nbr, workcenter_name, job_name, job_sequence, qty, wip_qty, system_status, is_running, plan_start_time, plan_end_time, real_start_time, resource_names, sourcing, synced_at')
      .or(`plan_end_time.gte.${yesterdayStr},is_running.eq.true`)
      .order('plan_start_time', { ascending: true })
      .limit(3000)
    if (error) throw error

    const rows = data ?? []
    const syncedAt = rows.reduce<string | null>((max, r) => {
      const s = (r as { synced_at?: string }).synced_at ?? null
      return s && (!max || s > max) ? s : max
    }, null)
    return NextResponse.json({ success: true, rows, synced_at: syncedAt }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
