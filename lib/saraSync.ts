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

function is404ErrorMessage(msg: string): boolean {
  return /(HTTP\s*404|\b404\b|Not\s+Found)/i.test(msg)
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

// ── 3b. 報工 ───────────────────────────────────────────────────────────
export async function syncReports(
  reportPaths: string[] = [
    '/data/wip',       // 塔台 2026-08-31 確認的報工紀錄端點
    '/data/report',
    '/data/work_report',
  ],
  reportBody: unknown = {},
): Promise<SyncResult> {
  const started = Date.now()
  try {
    let json: { data?: Array<Record<string, unknown>> } | null = null
    let usedPath: string | null = null
    const tried: string[] = []
    const errors: string[] = []

    for (const path of reportPaths) {
      tried.push(path)
      try {
        json = await saraFetch<{ data?: Array<Record<string, unknown>> }>(path, reportBody)
        usedPath = path
        break
      } catch (e) {
        const msg = errMsg(e)
        errors.push(`${path}: ${msg}`)
        if (!is404ErrorMessage(msg)) {
          throw new Error(msg)
        }
      }
    }

    if (!json || !usedPath) {
      throw new Error(
        `找不到可用的報工端點（皆回 404）：${tried.join(', ')}。` +
        '請向 SARA 確認報工 API 路徑/權限，或在 .env.local 設定 SARA_REPORT_PATHS 覆蓋。',
      )
    }

    const rows = (json.data ?? []).map((r, idx) => {
      const reportId = String(r.report_id ?? r.id ?? '').trim()
      const moNbr = String(r.mo_nbr ?? '').trim()
      const lotNbr = String(r.lot_nbr ?? '').trim()
      const jobSequence = Number(r.job_sequence ?? r.seq ?? 0) || null

      return {
        report_id: reportId || `${moNbr || 'NA'}-${lotNbr || 'NA'}-${jobSequence ?? 0}-${idx}`,
        mo_nbr: moNbr || null,
        lot_nbr: lotNbr || null,
        item_no: r.item_no ?? null,
        product_name: r.product_name ?? null,
        job_name: r.job_name ?? null,
        job_sequence: jobSequence,
        resource_id: r.resource_id != null ? Number(r.resource_id) : null,
        resource_name: r.resource_name ?? null,
        reported_qty: r.reported_qty != null ? Number(r.reported_qty) : null,
        good_qty: r.good_qty != null ? Number(r.good_qty) : null,
        ng_qty: r.ng_qty != null ? Number(r.ng_qty) : null,
        started_on: toIso(r.started_on as string | null),
        ended_on: toIso(r.ended_on as string | null),
        reported_at: toIso((r.reported_at ?? r.created_at) as string | null),
        operator_id: r.operator_id ?? null,
        operator_name: r.operator_name ?? null,
        status: r.status ?? null,
        raw: r,
        synced_at: new Date().toISOString(),
      }
    })

    if (rows.length > 0) {
      const sb = getSupabaseAdminClient()
      const CHUNK = 500
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await sb
          .from('sara_reports')
          .upsert(rows.slice(i, i + CHUNK), { onConflict: 'report_id' })
        if (error) throw new Error(errMsg(error))
      }
    }

    await logSync('report', true, rows.length, Date.now() - started, `path=${usedPath}`)
    return { count: rows.length, message: `來源端點：${usedPath}` }
  } catch (e) {
    const msg = errMsg(e)
    await logSync('report', false, null, Date.now() - started, msg)
    throw new Error(msg)
  }
}

// ── 3c. 報工紀錄（/data/wip → sara_wip_records）───────────────────────
// 塔台 2026-08-31 確認：報工紀錄要呼叫 /data/wip 取得（先前嘗試的 /data/report 等
// 路徑都不存在）。回應含分頁欄位 { data, truncated, limit, next_after_id }，
// 用 { after_id } 當游標翻頁；頁與頁之間可能有少量重疊列，以 work_order 去重即可。
// 寫入 sara_wip_records（塔台報工紀錄頁面讀的表，取代原本人工匯出 CSV 再匯入的流程）。
//
// ⚠️ 永久保存原則：塔台端只保留 6 個月的報工紀錄，sara_wip_records 是我們自己的
// 長期資料庫——同步一律只 upsert、絕對不可對此表做任何刪除，塔台端過期消失的
// 紀錄要繼續留在這裡（2026-08-31 使用者要求）。

/** 依製令/單號前綴推導廠區標籤（人工 CSV 匯入時是整批手選，自動同步改用前綴判斷） */
function wipSiteLabel(moNbr: string | null): string | null {
  const v = (moNbr ?? '').trim().toUpperCase()
  if (!v) return null
  if (v.startsWith('MOT') || v.startsWith('MOS') || v.startsWith('RO')) return '台北'
  if (v.startsWith('POC')) return '常平'
  if (v.startsWith('MPO') || v.startsWith('POO')) return '委外'
  return null
}

export async function syncWipRecords(): Promise<SyncResult> {
  const started = Date.now()
  try {
    interface WipRow {
      work_order: string
      mo_nbr: string | null
      product_name: string | null
      product_subname: string | null
      product_description: string | null
      lot_nbr: string | null
      doc_nbr: string | null
      workcenter_name: string | null
      job_name: string | null
      job_sequence: number | null
      status: string | null
      source_type: string | null
      wip_qty: number | null
      real_start_time: string | null
      real_end_time: string | null
      report_resource_name: string | null
      username: string | null
      job_note: string | null
    }
    interface WipPage {
      data?: WipRow[]
      truncated?: boolean
      next_after_id?: number | null
    }

    const byWorkOrder = new Map<string, WipRow>()
    let afterId: number | null = null
    const MAX_PAGES = 100 // 保險上限（5000 筆/頁 = 50 萬筆），避免 API 異常時無限迴圈
    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = afterId != null ? { after_id: afterId } : {}
      const json: WipPage = await saraFetch<WipPage>('/data/wip', body)
      for (const r of json.data ?? []) {
        const wo = String(r.work_order ?? '').trim()
        if (wo) byWorkOrder.set(wo, r)
      }
      if (!json.truncated || json.next_after_id == null) break
      afterId = json.next_after_id
    }

    const rows = Array.from(byWorkOrder.values()).map(r => ({
      work_order: r.work_order,
      id_list: null,
      mo_nbr: r.mo_nbr ?? null,
      product_name: r.product_name ?? null,
      product_subname: r.product_subname ?? null,
      product_description: r.product_description ?? null,
      lot_nbr: r.lot_nbr ?? null,
      doc_nbr: r.doc_nbr ?? null,
      workcenter_name: r.workcenter_name ?? null,
      job_name: r.job_name ?? null,
      job_sequence: r.job_sequence ?? null,
      status: r.status ?? null,
      source_type: r.source_type ?? null,
      wip_qty: r.wip_qty ?? null,
      real_start_time: r.real_start_time || null,
      real_end_time: r.real_end_time || null,
      report_resources: r.report_resource_name ?? null,
      username: r.username ?? null,
      site_label: wipSiteLabel(r.mo_nbr),
    }))

    if (rows.length > 0) {
      const sb = getSupabaseAdminClient()
      const CHUNK = 500
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await sb
          .from('sara_wip_records')
          .upsert(rows.slice(i, i + CHUNK), { onConflict: 'work_order' })
        if (error) throw new Error(errMsg(error))
      }
    }

    await logSync('wip_records', true, rows.length, Date.now() - started)
    return { count: rows.length }
  } catch (e) {
    const msg = errMsg(e)
    await logSync('wip_records', false, null, Date.now() - started, msg)
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
  job_name?: Array<{ id: number | null; job_name: string; type: string; line: string | null }>
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
      (r.job_name ?? [])
        .filter(j => j.id != null)   // SARA API 偶爾回傳 id: null，跳過避免 NOT NULL 違反
        .map(j => ({
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
