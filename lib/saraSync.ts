import { saraFetch } from './saraClient'
import { getSupabaseAdminClient } from './supabaseAdmin'

export interface SyncResult { count: number; message?: string }

// Supabase error / 任意物件 -> 可讀字串
function errMsg(e: unknown): string {
  if (!e) return 'unknown error'
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (typeof e === 'object') {
    const o = e as { message?: string; details?: string; hint?: string; code?: string }
    const parts = [o.message, o.code && `code=${o.code}`, o.details, o.hint].filter(Boolean)
    if (parts.length > 0) return parts.join(' | ')
    try { return JSON.stringify(e) } catch { return String(e) }
  }
  return String(e)
}

// SARA 時間為 UTC+0；空字串轉 null
function toIso(s?: string | null): string | null {
  if (!s) return null
  const t = s.trim()
  if (!t) return null
  const iso = t.includes('T') ? t : t.replace(' ', 'T')
  return iso.endsWith('Z') ? iso : iso + 'Z'
}

async function logSync(
  action: string,
  ok: boolean,
  count: number | null,
  elapsedMs: number,
  message?: string,
  payload?: unknown,
) {
  try {
    const sb = getSupabaseAdminClient()
    await sb.from('sara_sync_logs').insert({
      action,
      ok,
      count,
      elapsed_ms: elapsedMs,
      message: message ?? null,
      payload: payload ?? null,
    })
  } catch {
    // 不阻斷主流程
  }
}

// ── 1. 站點 ───────────────────────────────────────────────────────────
export async function syncWorkcenters(): Promise<SyncResult> {
  const started = Date.now()
  try {
    const json = await saraFetch<{ data?: Array<{ id: number; workcenter_name: string }> }>(
      '/data/workcenter',
    )
    const rows = (json.data ?? []).map(r => ({
      id: r.id,
      workcenter_name: r.workcenter_name,
      raw: r,
      synced_at: new Date().toISOString(),
    }))
    if (rows.length > 0) {
      const sb = getSupabaseAdminClient()
      const { error } = await sb.from('sara_workcenters').upsert(rows, { onConflict: 'id' })
      if (error) throw new Error(errMsg(error))
    }
    await logSync('workcenter', true, rows.length, Date.now() - started)
    return { count: rows.length }
  } catch (e) {
    const msg = errMsg(e)
    await logSync('workcenter', false, null, Date.now() - started, msg)
    throw new Error(msg)
  }
}

// ── 2. 製程 ───────────────────────────────────────────────────────────
export async function syncJobs(): Promise<SyncResult> {
  const started = Date.now()
  try {
    const json = await saraFetch<{
      data?: Array<{
        id: number
        job_name: string
        sourcing: string
        est_time_mode: string
        workcenter_id: number
        workcenter_name: string
      }>
    }>('/data/jlb')
    const rows = (json.data ?? []).map(r => ({
      id: r.id,
      job_name: r.job_name,
      sourcing: r.sourcing,
      est_time_mode: r.est_time_mode,
      workcenter_id: r.workcenter_id ?? null,
      workcenter_name: r.workcenter_name ?? null,
      raw: r,
      synced_at: new Date().toISOString(),
    }))
    if (rows.length > 0) {
      const sb = getSupabaseAdminClient()
      const { error } = await sb.from('sara_jobs').upsert(rows, { onConflict: 'id' })
      if (error) throw new Error(errMsg(error))
    }
    await logSync('jlb', true, rows.length, Date.now() - started)
    return { count: rows.length }
  } catch (e) {
    const msg = errMsg(e)
    await logSync('jlb', false, null, Date.now() - started, msg)
    throw new Error(msg)
  }
}

// ── 3. 工單 ───────────────────────────────────────────────────────────
export async function syncOrders(): Promise<SyncResult> {
  const started = Date.now()
  try {
    const json = await saraFetch<{ data?: Array<Record<string, unknown>> }>('/data/order')
    const seen = new Set<string>()
    const rows: Record<string, unknown>[] = []
    for (const r of json.data ?? []) {
      const mo = String(r.mo_nbr ?? '').trim()
      if (!mo || seen.has(mo)) continue
      seen.add(mo)
      rows.push({
        mo_nbr: mo,
        doc_nbr: r.doc_nbr ?? null,
        plan_start_time: toIso(r.plan_start_time as string | null),
        plan_end_time: toIso(r.plan_end_time as string | null),
        product_name: r.product_name,
        description: r.description ?? null,
        required_qty: r.required_qty ?? null,
        lot_nbr: r.lot_nbr,
        is_internal: !!r.is_internal,
        item_no: r.item_no ?? null,
        due: toIso(r.due as string | null),
        raw: r,
        synced_at: new Date().toISOString(),
      })
    }
    if (rows.length > 0) {
      const sb = getSupabaseAdminClient()
      const CHUNK = 500
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await sb
          .from('sara_orders')
          .upsert(rows.slice(i, i + CHUNK), { onConflict: 'mo_nbr' })
        if (error) throw new Error(errMsg(error))
      }
    }
    await logSync('order', true, rows.length, Date.now() - started)
    return { count: rows.length }
  } catch (e) {
    const msg = errMsg(e)
    await logSync('order', false, null, Date.now() - started, msg)
    throw new Error(msg)
  }
}

// ── 4. 資源（含子表） ─────────────────────────────────────────────────
interface SaraResource {
  id: number
  resource_name: string
  resource_type: string
  capacity_type: string
  standard_capacity: number
  is_extra: boolean
  changeover_time?: number | null
  change_over_time?: number | null
  disabled: boolean
  job_name?: Array<{ id: number; job_name: string; type: string; line: string | null }>
  events?: Array<{
    started_on: string
    ended_on: string
    event_name: string
    available: boolean
  }>
}

export async function syncResources(): Promise<SyncResult> {
  const started = Date.now()
  try {
    const json = await saraFetch<{ data?: SaraResource[] }>('/data/resource')
    const list = json.data ?? []
    const sb = getSupabaseAdminClient()

    const mainRows = list.map(r => ({
      id: r.id,
      resource_name: r.resource_name,
      resource_type: r.resource_type,
      capacity_type: r.capacity_type,
      standard_capacity: r.standard_capacity,
      is_extra: !!r.is_extra,
      changeover_time: r.changeover_time ?? r.change_over_time ?? null,
      disabled: !!r.disabled,
      raw: r,
      synced_at: new Date().toISOString(),
    }))

    if (mainRows.length > 0) {
      const { error } = await sb.from('sara_resources').upsert(mainRows, { onConflict: 'id' })
      if (error) throw new Error(errMsg(error))
    }

    // 子表：先刪本批 resource_id 的舊資料再插入
    const ids = list.map(r => r.id)
    if (ids.length > 0) {
      const { error: e1 } = await sb.from('sara_resource_jobs').delete().in('resource_id', ids)
      if (e1) throw new Error(`刪除 sara_resource_jobs 失敗: ${errMsg(e1)}`)
      const { error: e2 } = await sb.from('sara_resource_events').delete().in('resource_id', ids)
      if (e2) throw new Error(`刪除 sara_resource_events 失敗: ${errMsg(e2)}`)
    }

    const jobRows = list.flatMap(r =>
      (r.job_name ?? []).map(j => ({
        resource_id: r.id,
        job_id: j.id,
        job_name: j.job_name,
        type: j.type,
        line: j.line ?? null,
      })),
    )
    if (jobRows.length > 0) {
      const { error } = await sb
        .from('sara_resource_jobs')
        .insert(jobRows)
      if (error) throw new Error(`插入 sara_resource_jobs 失敗: ${errMsg(error)}`)
    }

    // events：同一 resource 內去重後再 insert
    const eventRows = list.flatMap(r => {
      const seen = new Set<string>()
      return (r.events ?? []).flatMap(e => {
        const key = `${r.id}|${e.started_on}|${e.ended_on}|${e.event_name}`
        if (seen.has(key)) return []
        seen.add(key)
        return [{
          resource_id: r.id,
          started_on: toIso(e.started_on),
          ended_on: toIso(e.ended_on),
          event_name: e.event_name,
          available: !!e.available,
        }]
      })
    })
    if (eventRows.length > 0) {
      const { error } = await sb.from('sara_resource_events').insert(eventRows)
      if (error) throw new Error(`插入 sara_resource_events 失敗: ${errMsg(error)}`)
    }

    const summary = `子表：jobs ${jobRows.length}、events ${eventRows.length}`
    await logSync('resource', true, mainRows.length, Date.now() - started, summary)
    return { count: mainRows.length, message: summary }
  } catch (e) {
    const msg = errMsg(e)
    await logSync('resource', false, null, Date.now() - started, msg)
    throw new Error(msg)
  }
}

// ── 5. 途程 ───────────────────────────────────────────────────────────
export interface LotDetailItem {
  mo_nbr: string
  product_name: string
  lot_nbr: string
}

export async function syncLotRoutes(items: LotDetailItem[]): Promise<SyncResult> {
  const started = Date.now()
  try {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('items 不可為空')
    }
    const json = await saraFetch<{ data?: Array<Record<string, unknown>> }>(
      '/data/lot_detail',
      { items },
    )
    const rows = (json.data ?? []).map(r => ({
      mo_nbr: r.mo_nbr,
      product_name: r.product_name,
      lot_nbr: r.lot_nbr,
      job_sequence: r.job_sequence,
      job_name: r.job_name,
      jlb_id: r.jlb_id,
      required_qty: r.required_qty,
      status: r.status ?? null,
      primary_resources: r.primary_resources ?? {},
      secondary_resources: r.secondary_resources ?? {},
      assigned_resources: r.assigned_resources ?? null,
      plan_start_time: toIso(r.plan_start_time as string | null),
      plan_end_time: toIso(r.plan_end_time as string | null),
      raw: r,
      synced_at: new Date().toISOString(),
    }))
    if (rows.length > 0) {
      const sb = getSupabaseAdminClient()
      const CHUNK = 500
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await sb
          .from('sara_lot_routes')
          .upsert(rows.slice(i, i + CHUNK), { onConflict: 'mo_nbr,lot_nbr,job_sequence' })
        if (error) throw new Error(errMsg(error))
      }
    }
    await logSync('lot_detail', true, rows.length, Date.now() - started, undefined, { items })
    return { count: rows.length }
  } catch (e) {
    const msg = errMsg(e)
    await logSync('lot_detail', false, null, Date.now() - started, msg, { items })
    throw new Error(msg)
  }
}
