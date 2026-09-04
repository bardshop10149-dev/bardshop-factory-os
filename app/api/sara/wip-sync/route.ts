import { NextRequest, NextResponse } from 'next/server'

import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import { saraProjects, saraWip, moToSoLine } from '@/lib/saraWebClient'

// ─────────────────────────────────────────────────────────────────────────────
// 塔台現場進度同步（網頁版 API → Supabase）
//
// 取代原本人工匯出 CSV 再匯入的作法（sara_wip_records 因此停在 2026-07-31）。
// 只打兩支端點就能拿到全廠現況，所以整批覆蓋即可，不需要增量比對：
//   /api/project/management/table → 每批進度（做到幾成、跳站警示）
//   /api/wip/schedule             → 每道已排程工序（現在哪一站、是否在跑）
//
// 寫入策略＝upsert 全部 + 刪除本次沒出現的列。
// 護欄：SARA 回空陣列時完全不動資料庫（避免登入失敗或改版把現況洗掉）。
//
// GET  = 唯讀預覽，不寫入（給人工確認資料長相）
// POST = 實際同步
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK = 500

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function text(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  return String(v)
}

async function pull() {
  const [projects, wip] = await Promise.all([saraProjects(), saraWip()])
  const syncedAt = new Date().toISOString()

  const lotRows = projects.map((p) => ({
    lot_id: p.id,
    mo_nbr: text(p.mo_nbr),
    doc_nbr: text(p.doc_nbr),
    so_line_no: moToSoLine(p.mo_nbr),
    product_name: text(p.product_name),
    product_description: text(p.product_description),
    lot_nbr: text(p.lot_nbr),
    qty: num(p.qty),
    due: text(p.due),
    health_state: text(p.health_state),
    action_state: text(p.action_state),
    progress_percentage: num(p.progress_percentage),
    warning_state: p.warning_state ?? null,
    ach_state: text(p.ach_state),
    customer_name: text(p.customer_name),
    plan_start_time: text(p.plan_start_time),
    plan_end_time: text(p.plan_end_time),
    synced_at: syncedAt,
  }))

  const wipRows = wip.map((w) => ({
    jid: w.jid,
    lot_id: w.lid ?? null,
    mo_nbr: text(w.mo_nbr),
    doc_nbr: text(w.doc_nbr),
    so_line_no: moToSoLine(w.mo_nbr),
    product_name: text(w.product_name),
    lot_nbr: text(w.lot_nbr),
    workcenter_name: text(w.workcenter_name),
    job_name: text(w.job_name),
    job_sequence: num(w.job_sequence),
    qty: num(w.qty),
    wip_qty: num(w.wip_qty),
    system_status: text(w.system_status),
    is_running: typeof w.is_running === 'boolean' ? w.is_running : null,
    real_start_time: text(w.real_start_time),
    real_end_time: text(w.real_end_time),
    plan_start_time: text(w.plan_start_time),
    plan_end_time: text(w.plan_end_time),
    report_resource_name: text(w.report_resource_name),
    resource_names: text(w.resource_names),
    sourcing: text(w.sourcing),
    factory_name: text(w.factory_name),
    synced_at: syncedAt,
  }))

  // 同一批 lot_id / jid 只保留一列（防 SARA 回重複列導致 upsert 衝突）
  const dedupe = <T extends Record<string, unknown>>(rows: T[], key: keyof T): T[] => {
    const m = new Map<unknown, T>()
    for (const r of rows) if (!m.has(r[key])) m.set(r[key], r)
    return Array.from(m.values())
  }

  return {
    syncedAt,
    lotRows: dedupe(lotRows, 'lot_id'),
    wipRows: dedupe(wipRows, 'jid'),
  }
}

export async function GET(request: NextRequest) {
  // Vercel Cron 以 GET 呼叫並自動帶 `Authorization: Bearer <CRON_SECRET>`——帶了有效
  // secret 就直接執行完整同步（跟 POST 相同），供 vercel.json 排程用；
  // 否則維持原本行為：登入者的唯讀預覽。
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  if (bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))) {
    return runSync()
  }

  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const { lotRows, wipRows } = await pull()
    const running = wipRows.filter((w) => w.system_status === 'running' || w.system_status === 'pause')
    return NextResponse.json({
      status: 'ok',
      preview: true,
      lots: lotRows.length,
      jobs: wipRows.length,
      running: running.length,
      withProgress: lotRows.filter((l) => (l.progress_percentage ?? 0) > 0).length,
      warned: lotRows.filter((l) => Array.isArray(l.warning_state) && l.warning_state.length > 0).length,
      mappableToSoLine: lotRows.filter((l) => l.so_line_no).length,
      sampleLot: lotRows[0] ?? null,
      sampleRunning: running.slice(0, 3),
    })
  } catch (e) {
    return NextResponse.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  // 內部排程呼叫（cron / webhook）走 X-Internal-Secret，其餘要求登入
  const internal = request.headers.get('X-Internal-Secret') ?? ''
  const secret = process.env.WEBHOOK_SECRET ?? ''
  if (!(secret && internal === secret)) {
    const guard = await guardAuth()
    if (!guard.ok) return guard.res
  }
  return runSync()
}

async function runSync() {
  const started = Date.now()
  try {
    const { syncedAt, lotRows, wipRows } = await pull()

    // 護欄：任一邊空的就整輪放棄，不寫入也不刪除
    if (lotRows.length === 0 || wipRows.length === 0) {
      return NextResponse.json({
        status: 'error',
        error: `SARA 回傳空資料（批 ${lotRows.length} / 工序 ${wipRows.length}），為保護既有資料本輪不寫入`,
      }, { status: 502 })
    }

    const supabase = getSupabaseAdminClient()

    for (const part of chunk(lotRows, CHUNK)) {
      const { error } = await supabase.from('sara_lot_progress').upsert(part, { onConflict: 'lot_id' })
      if (error) throw error
    }
    for (const part of chunk(wipRows, CHUNK)) {
      const { error } = await supabase.from('sara_wip_schedule').upsert(part, { onConflict: 'jid' })
      if (error) throw error
    }

    // 刪除本次沒出現的列（＝已結案或已完成而離開排程）
    const { data: delLots } = await supabase
      .from('sara_lot_progress').delete().lt('synced_at', syncedAt).select('lot_id')
    const { data: delJobs } = await supabase
      .from('sara_wip_schedule').delete().lt('synced_at', syncedAt).select('jid')

    const running = wipRows.filter((w) => w.system_status === 'running' || w.system_status === 'pause')

    // 留一筆同步紀錄（沿用 erp_sync_logs，失敗不阻斷）
    await supabase.from('erp_sync_logs').insert({
      action: 'sync_sara_wip',
      mode: 'full',
      ok: true,
      count: lotRows.length + wipRows.length,
      inserted: null,
      updated: null,
      deleted: (delLots?.length ?? 0) + (delJobs?.length ?? 0),
      unchanged: null,
      elapsed_ms: Date.now() - started,
      message: `批 ${lotRows.length} / 工序 ${wipRows.length} / 進行中 ${running.length}`,
      payload: { lots: lotRows.length, jobs: wipRows.length, running: running.length },
    }).then(() => {}, () => { /* log 失敗不影響同步 */ })

    return NextResponse.json({
      status: 'ok',
      lots: lotRows.length,
      jobs: wipRows.length,
      running: running.length,
      withProgress: lotRows.filter((l) => (l.progress_percentage ?? 0) > 0).length,
      warned: lotRows.filter((l) => Array.isArray(l.warning_state) && l.warning_state.length > 0).length,
      mappableToSoLine: lotRows.filter((l) => l.so_line_no).length,
      deletedLots: delLots?.length ?? 0,
      deletedJobs: delJobs?.length ?? 0,
      elapsedMs: Date.now() - started,
    })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    await getSupabaseAdminClient().from('erp_sync_logs').insert({
      action: 'sync_sara_wip', mode: 'full', ok: false, count: null,
      elapsed_ms: Date.now() - started, message: msg.slice(0, 500),
    }).then(() => {}, () => {})
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
