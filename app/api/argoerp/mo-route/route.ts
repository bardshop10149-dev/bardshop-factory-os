import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import { saraFindProjects, saraJobsOfLot, saraWebConfigured, type SaraProject } from '@/lib/saraWebClient'
import { fetchMoReceipt, type MoReceipt } from '@/lib/argoQuery'

// ─────────────────────────────────────────────────────────────────────────────
// 製令(MOT) → 塔台所有製程與各站報工量
//
// GET /api/argoerp/mo-route?mo=MOT26080651214
//
// 資料來源優先序：
//   ① 塔台網頁版 API（即時）— /api/project/management/table 找批(lot)，
//      再以 /api/project/job/table 取該批「完整工序（含未排程者）」，
//      直接帶回 應做 required_qty / 已報工 reported_qty / 剩餘 remaining_qty。
//   ② 塔台不可用時（未設帳密或連線失敗）退回資料庫：
//      標準途程(item_routes→route_operations→operation_times) + 報工快照(sara_wip_records)。
//      快照是人工上傳的 CSV，可能不是最新，故僅作備援並在回應標明 source。
//
// 一張製令在塔台可能對到多個批(lot)，全部列出，各自帶自己的工序。
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export interface MoRouteStep {
  sequence: number | null
  station: string | null       // 站點
  opName: string | null        // 工序
  requiredQty: number | null   // 應做（塔台來源才有）
  reportedQty: number          // 已報工
  remainingQty: number | null  // 剩餘（塔台來源才有）
  resources: string[]          // 指定資源／機台‧人員
  note: string | null
  sourcing: string | null      // 自製／委外
  reported: boolean
  inStandardRoute: boolean     // 備援來源才有意義
  statuses: string[]           // 備援來源才有（塔台以數量表達進度）
  firstStart: string | null
  lastEnd: string | null
}

export interface MoRouteLot {
  lotId: number | null
  lotNbr: string | null
  docNbr: string | null
  productName: string | null
  productDesc: string | null
  customerName: string | null
  qty: number | null
  progressPercentage: number | null
  healthState: string | null
  actionState: string | null
  achState: string | null
  warningState: unknown
  steps: MoRouteStep[]
}

interface WipRow {
  product_name: string | null
  lot_nbr: string | null
  job_sequence: number | null
  workcenter_name: string | null
  job_name: string | null
  status: string | null
  wip_qty: number | null
  report_resources: string | null
  real_start_time: string | null
  real_end_time: string | null
  site_label: string | null
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** designated_resources 可能是陣列／物件／字串，統一攤成字串陣列 */
function toResourceList(v: unknown): string[] {
  if (!v) return []
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : (x as { name?: string })?.name ?? String(x))).filter(Boolean)
  }
  if (typeof v === 'string') return v.split(/[,、]/).map((s) => s.trim()).filter(Boolean)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.name === 'string') return [o.name]
    return Object.values(o).filter((x): x is string => typeof x === 'string')
  }
  return []
}

export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res

  const mo = (request.nextUrl.searchParams.get('mo') ?? '').trim()
  if (!mo) return NextResponse.json({ status: 'error', error: '缺少 mo 參數' }, { status: 400 })

  const sb = getSupabaseAdminClient()

  // ── 繳庫狀況（即時問 ARGO）───────────────────────────────────
  // 先發車、最後才 await，讓它跟塔台查詢平行跑，不額外增加等待。
  // 這是判斷「這張製令做完了沒」的唯一可靠來源：塔台結案後該批會從清單消失，
  // 屆時只看報工會誤判成「未開始」；常平／委外不報工的單同理。
  const receiptPromise: Promise<MoReceipt> = fetchMoReceipt(mo)

  // ── 製令基本資料（ERP 側，供顯示與備援 join）─────────────────────
  const { data: moLines } = await sb
    .from('erp_mo_lines')
    .select('project_id, line_no, mbp_part, mbp_lot_no, order_qty, hold_status, begin_date, end_date, mo_begin_date, source_order')
    .eq('project_id', mo)
    .order('line_no', { ascending: true })
  const head = (moLines ?? [])[0] as Record<string, unknown> | undefined
  const itemCode = String(head?.mbp_part ?? '').trim()
  const sourceOrder = String(head?.source_order ?? '').trim()

  const erpInfo = {
    itemCode: itemCode || null,
    orderQty: num(head?.order_qty),
    holdStatus: (head?.hold_status as string | null) ?? null,
    beginDate: (head?.mo_begin_date as string | null) ?? (head?.begin_date as string | null) ?? null,
    endDate: (head?.end_date as string | null) ?? null,
    sourceOrder: sourceOrder || null,
  }

  // ── ① 塔台即時 ────────────────────────────────────────────────
  if (saraWebConfigured()) {
    try {
      let projects: SaraProject[] = await saraFindProjects(mo)
      let matchedBy: 'mo' | 'source_order' = 'mo'
      // 塔台部分批是掛在訂單層級（mo_nbr 存的是 SO/SOB），故退而用來源訂單再找一次
      if (projects.length === 0 && sourceOrder) {
        projects = await saraFindProjects(sourceOrder)
        if (projects.length > 0) matchedBy = 'source_order'
      }
      // globalFilter 是模糊比對，只保留單號真的相符的批
      const target = matchedBy === 'mo' ? mo : sourceOrder
      const exact = projects.filter(
        (p) => String(p.mo_nbr ?? '').trim() === target || String(p.doc_nbr ?? '').trim() === target,
      )
      const useProjects = exact.length > 0 ? exact : projects

      if (useProjects.length > 0) {
        const lots: MoRouteLot[] = []
        for (const p of useProjects.slice(0, 20)) {
          const jobs = await saraJobsOfLot(p.id)
          const steps: MoRouteStep[] = jobs
            .map((j) => ({
              sequence: j.job_sequence,
              station: j.workcenter_name,
              opName: j.job_name,
              requiredQty: j.required_qty == null ? null : num(j.required_qty),
              reportedQty: num(j.reported_qty),
              remainingQty: j.remaining_qty == null ? null : num(j.remaining_qty),
              resources: toResourceList(j.designated_resources),
              note: j.job_note ?? null,
              sourcing: j.sourcing ?? null,
              reported: num(j.reported_qty) > 0,
              inStandardRoute: true,
              statuses: [],
              firstStart: null,
              lastEnd: null,
            }))
            .sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999))

          lots.push({
            lotId: p.id,
            lotNbr: p.lot_nbr,
            docNbr: p.doc_nbr,
            productName: p.product_name,
            productDesc: p.product_description,
            customerName: p.customer_name,
            qty: p.qty == null ? null : num(p.qty),
            progressPercentage: p.progress_percentage == null ? null : num(p.progress_percentage),
            healthState: p.health_state,
            actionState: p.action_state,
            achState: p.ach_state,
            warningState: p.warning_state,
            steps,
          })
        }

        return NextResponse.json({
          status: 'ok',
          source: 'sara_live',
          mo,
          matchedBy,
          erpInfo,
          receipt: await receiptPromise,
          lots,
          totals: {
            lotCount: lots.length,
            stepCount: lots.reduce((n, l) => n + l.steps.length, 0),
            reportedStepCount: lots.reduce((n, l) => n + l.steps.filter((s) => s.reported).length, 0),
          },
        })
      }
      // 塔台查無此製令 → 落到備援（可能是舊單已從塔台移除）
    } catch (e) {
      // 塔台連線／登入失敗 → 靜默降級為備援，並在回應帶出原因
      const reason = e instanceof Error ? e.message : String(e)
      const fb = await fallbackFromDb(sb, mo, itemCode, sourceOrder, erpInfo)
      return NextResponse.json({ ...fb, receipt: await receiptPromise, saraError: reason })
    }
  }

  // ── ② 備援：資料庫（標準途程 + 報工快照）──────────────────────
  const fb = await fallbackFromDb(sb, mo, itemCode, sourceOrder, erpInfo)
  return NextResponse.json({ ...fb, receipt: await receiptPromise })
}

type Sb = ReturnType<typeof getSupabaseAdminClient>

async function fallbackFromDb(
  sb: Sb,
  mo: string,
  itemCode: string,
  sourceOrder: string,
  erpInfo: Record<string, unknown>,
) {
  // 報工快照：先用製令號，再退回來源訂單號
  const wipCols = 'product_name, lot_nbr, job_sequence, workcenter_name, job_name, status, wip_qty, report_resources, real_start_time, real_end_time, site_label'
  let matchedBy: 'mo' | 'source_order' | null = null
  let wip: WipRow[] = []
  const { data: byMo } = await sb.from('sara_wip_records').select(wipCols).eq('mo_nbr', mo)
  if ((byMo ?? []).length > 0) {
    wip = byMo as unknown as WipRow[]
    matchedBy = 'mo'
  } else if (sourceOrder) {
    const { data: bySo } = await sb.from('sara_wip_records').select(wipCols).eq('mo_nbr', sourceOrder)
    if ((bySo ?? []).length > 0) {
      wip = bySo as unknown as WipRow[]
      matchedBy = 'source_order'
    }
  }

  // 標準途程：品號 → 途程 → 工序 → 站點
  const standard: Array<{ sequence: number; opName: string; station: string | null }> = []
  let routeId: string | null = null
  if (itemCode) {
    const { data: ir } = await sb.from('item_routes').select('route_id').eq('item_code', itemCode).limit(1)
    routeId = ((ir ?? [])[0] as { route_id?: string } | undefined)?.route_id ?? null
    if (routeId) {
      const { data: ops } = await sb
        .from('route_operations').select('sequence, op_name')
        .eq('route_id', routeId).order('sequence', { ascending: true })
      const opRows = (ops ?? []) as unknown as { sequence: number; op_name: string }[]
      const opNames = opRows.map((o) => o.op_name).filter(Boolean)
      const stationMap = new Map<string, string>()
      if (opNames.length > 0) {
        const { data: ot } = await sb.from('operation_times').select('op_name, station').in('op_name', opNames)
        for (const r of (ot ?? []) as unknown as { op_name: string; station: string | null }[]) {
          if (r.op_name && r.station) stationMap.set(r.op_name, r.station)
        }
      }
      for (const o of opRows) {
        standard.push({ sequence: o.sequence, opName: o.op_name, station: stationMap.get(o.op_name) ?? null })
      }
    }
  }

  const keyOf = (opName: string | null, station: string | null) => (opName || station || '').trim().toLowerCase()
  const agg = new Map<string, MoRouteStep>()
  for (const st of standard) {
    agg.set(keyOf(st.opName, st.station), {
      sequence: st.sequence, station: st.station, opName: st.opName,
      requiredQty: null, reportedQty: 0, remainingQty: null,
      resources: [], note: null, sourcing: null,
      reported: false, inStandardRoute: true, statuses: [], firstStart: null, lastEnd: null,
    })
  }
  for (const r of wip) {
    const k = keyOf(r.job_name, r.workcenter_name)
    let step = agg.get(k)
    if (!step) {
      step = {
        sequence: r.job_sequence, station: r.workcenter_name, opName: r.job_name,
        requiredQty: null, reportedQty: 0, remainingQty: null,
        resources: [], note: null, sourcing: null,
        reported: false, inStandardRoute: false, statuses: [], firstStart: null, lastEnd: null,
      }
      agg.set(k, step)
    }
    step.reported = true
    step.reportedQty += num(r.wip_qty)
    if (step.sequence == null && r.job_sequence != null) step.sequence = r.job_sequence
    if (!step.station && r.workcenter_name) step.station = r.workcenter_name
    if (r.status && !step.statuses.includes(r.status)) step.statuses.push(r.status)
    for (const piece of String(r.report_resources ?? '').split(/[,、]/).map((x) => x.trim()).filter(Boolean)) {
      if (!step.resources.includes(piece)) step.resources.push(piece)
    }
    if (r.real_start_time && (!step.firstStart || r.real_start_time < step.firstStart)) step.firstStart = r.real_start_time
    if (r.real_end_time && (!step.lastEnd || r.real_end_time > step.lastEnd)) step.lastEnd = r.real_end_time
  }

  const steps = [...agg.values()].sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999))
  const first = wip[0]

  const lot: MoRouteLot = {
    lotId: null,
    lotNbr: first?.lot_nbr ?? null,
    docNbr: null,
    productName: first?.product_name ?? null,
    productDesc: null,
    customerName: null,
    qty: num(erpInfo.orderQty) || null,
    progressPercentage: null,
    healthState: null,
    actionState: null,
    achState: null,
    warningState: null,
    steps,
  }

  return {
    status: 'ok',
    source: 'db_fallback' as const,
    mo,
    matchedBy,
    erpInfo: { ...erpInfo, routeId },
    lots: steps.length > 0 ? [lot] : [],
    totals: {
      lotCount: steps.length > 0 ? 1 : 0,
      stepCount: steps.length,
      reportedStepCount: steps.filter((s) => s.reported).length,
    },
  }
}
