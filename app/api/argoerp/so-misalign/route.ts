import { NextResponse } from 'next/server'

import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import { matchMoToOrder, type MatchKind } from '@/lib/moLineMatch'

// ─────────────────────────────────────────────────────────────────────────────
// 工單對位體檢（唯讀）
//
// 回答的是「現在」的問題：有哪些製令工單，上面印的行號已經對不到訂單了？
// 這與「訂單修改紀錄」不同——那是事件流（誰在幾點改了什麼），
// 這裡是現況清單（現在有幾張工單是錯的，要去處理）。
// 錯位往往是好幾週前的改單造成的，不會出現在近幾天的修改紀錄裡。
//
// 判定方式見 lib/moLineMatch.ts：工單號末兩碼＝發單當下的訂單行號，
// 訂單事後插行／刪行會讓行號整批位移，已發出去的工單就對不上。
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = 1000

type Supa = ReturnType<typeof getSupabaseAdminClient>

async function readAll<T>(supabase: Supa, table: string, select: string,
                          apply?: (q: ReturnType<Supa['from']> extends never ? never : any) => any): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1)
    if (apply) q = apply(q)
    const { data, error } = await q
    if (error) throw error
    const batch = (data ?? []) as unknown as T[]
    out.push(...batch)
    if (batch.length < PAGE) break
  }
  return out
}

export interface MisalignRow {
  mo: string
  so: string
  /** 工單上印的行號 */
  printedLine: string
  /** 這張工單要做的品項 */
  moPart: string | null
  moPartDesc: string | null
  moQty: number | null
  moStatus: string | null
  /** 訂單該行現在是什麼品項 */
  nowPart: string | null
  nowPartDesc: string | null
  /** 該品項現在實際在第幾行 */
  realLines: string[]
  kind: 'shifted' | 'missing'
  /** 未發單 / 已發單 / 已備料 */
  dispatch: string
  dispatched: boolean
  partner: string | null
  sales: string | null
  duedate: string | null
  /** 塔台整批進度 */
  progress: number | null
  running: Array<{ station: string; job: string; status: string; qty: number | null; done: number | null; resource: string | null }>
  /** 建議通知對象 */
  notify: string
}

export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res

  try {
    const supabase = getSupabaseAdminClient()

    interface SoRow {
      project_id: string; line_no: string | number; mbp_part: string | null
      description: string | null; order_qty_oru: number | null; duedate: string | null
      partner_name: string | null; sales_name: string | null
    }
    interface MoRow {
      project_id: string; mbp_part: string | null; order_qty: number | null
      hold_status: string | null; source_order: string
    }
    interface JobRow {
      doc_nbr: string; product_name: string | null; workcenter_name: string | null
      job_name: string | null; system_status: string | null; qty: number | null
      wip_qty: number | null; report_resource_name: string | null
    }
    interface LotRow { doc_nbr: string; product_name: string | null; progress_percentage: number | null }

    const [soLines, moLines, uploads, preps, jobs, lots] = await Promise.all([
      readAll<SoRow>(supabase, 'erp_so_lines',
        'project_id,line_no,mbp_part,description,order_qty_oru,duedate,partner_name,sales_name'),
      readAll<MoRow>(supabase, 'erp_mo_lines',
        'project_id,mbp_part,order_qty,hold_status,source_order',
        (q) => q.like('source_order', 'SO%')),
      readAll<{ mo_number: string }>(supabase, 'argoerp_mo_upload_log', 'mo_number'),
      readAll<{ mo_number: string; status: string | null }>(supabase, 'argoerp_material_prep_log', 'mo_number,status'),
      readAll<JobRow>(supabase, 'sara_wip_schedule',
        'doc_nbr,product_name,workcenter_name,job_name,system_status,qty,wip_qty,report_resource_name'),
      readAll<LotRow>(supabase, 'sara_lot_progress', 'doc_nbr,product_name,progress_percentage'),
    ])

    // 訂單索引
    const orderLines = new Map<string, Map<string, string | null>>()
    const partLines = new Map<string, Map<string, string[]>>()
    const meta = new Map<string, { partner: string | null; sales: string | null; duedate: string | null }>()
    const descOf = new Map<string, string | null>()
    for (const r of soLines) {
      const ln = String(r.line_no)
      if (!orderLines.has(r.project_id)) orderLines.set(r.project_id, new Map())
      orderLines.get(r.project_id)!.set(ln, r.mbp_part)
      if (!partLines.has(r.project_id)) partLines.set(r.project_id, new Map())
      const pm = partLines.get(r.project_id)!
      if (r.mbp_part) pm.set(r.mbp_part, [...(pm.get(r.mbp_part) ?? []), ln])
      if (!meta.has(r.project_id)) {
        meta.set(r.project_id, { partner: r.partner_name, sales: r.sales_name, duedate: r.duedate })
      }
      if (r.mbp_part && !descOf.has(r.mbp_part)) descOf.set(r.mbp_part, r.description)
    }

    const uploaded = new Set(uploads.map((u) => u.mo_number))
    const prepared = new Map(preps.map((p) => [p.mo_number, p.status]))
    const runningBy = new Map<string, JobRow[]>()
    for (const j of jobs) {
      if (j.system_status !== 'running' && j.system_status !== 'pause') continue
      if (!j.product_name) continue
      const k = `${j.doc_nbr}|${j.product_name}`
      runningBy.set(k, [...(runningBy.get(k) ?? []), j])
    }
    const progressBy = new Map<string, number | null>()
    for (const l of lots) {
      if (l.doc_nbr && l.product_name) progressBy.set(`${l.doc_nbr}|${l.product_name}`, l.progress_percentage)
    }

    const stats: Record<MatchKind, number> = {
      ok: 0, shifted: 0, missing: 0, no_such_line: 0, not_applicable: 0,
    }
    const rows: MisalignRow[] = []

    for (const m of moLines) {
      const ol = orderLines.get(m.source_order)
      const pl = partLines.get(m.source_order)
      if (!ol || !pl) continue
      const res = matchMoToOrder({
        moNbr: m.project_id, moPart: m.mbp_part, orderLines: ol, partLines: pl,
      })
      stats[res.kind] += 1
      if (res.kind !== 'shifted' && res.kind !== 'missing') continue

      const flags: string[] = []
      if (uploaded.has(m.project_id)) flags.push('已發單')
      if (prepared.get(m.project_id)) flags.push('已備料')
      const dispatched = flags.length > 0
      const run = (m.mbp_part ? runningBy.get(`${m.source_order}|${m.mbp_part}`) : undefined) ?? []
      const md = meta.get(m.source_order) ?? { partner: null, sales: null, duedate: null }

      rows.push({
        mo: m.project_id,
        so: m.source_order,
        printedLine: res.printedLine ?? '',
        moPart: m.mbp_part,
        moPartDesc: m.mbp_part ? descOf.get(m.mbp_part) ?? null : null,
        moQty: m.order_qty,
        moStatus: m.hold_status,
        nowPart: res.nowPart,
        nowPartDesc: res.nowPart ? descOf.get(res.nowPart) ?? null : null,
        realLines: res.realLines,
        kind: res.kind,
        dispatch: flags.join('/') || '僅開立',
        dispatched,
        partner: md.partner,
        sales: md.sales,
        duedate: md.duedate,
        progress: (m.mbp_part ? progressBy.get(`${m.source_order}|${m.mbp_part}`) : null) ?? null,
        running: run.map((r) => ({
          station: r.workcenter_name ?? '', job: r.job_name ?? '', status: r.system_status ?? '',
          qty: r.qty, done: r.wip_qty, resource: r.report_resource_name,
        })),
        // 已發到現場的工單行號已失效 → 全廠；還沒發單的只需美編確認
        notify: dispatched ? '全廠' : '美編部門',
      })
    }

    // 危險的排前面：生產中 → 已發單 → 其餘；同組再依訂單、工單號
    const rank = (r: MisalignRow) => (r.running.length ? 2 : r.dispatched ? 1 : 0)
    rows.sort((a, b) => rank(b) - rank(a) || a.so.localeCompare(b.so) || a.mo.localeCompare(b.mo))

    const checked = stats.ok + stats.shifted + stats.missing
    return NextResponse.json({
      status: 'ok',
      rows,
      summary: {
        checked,                                   // 實際做過對位的工單數
        ok: stats.ok,
        shifted: stats.shifted,                    // 行號跑掉
        missing: stats.missing,                    // 品項已不在訂單上
        notApplicable: stats.not_applicable,       // MOM 等非行號制，未判斷
        noSuchLine: stats.no_such_line,            // 訂單已無該行（多為已結案舊單）
        accuracy: checked ? Number((stats.ok / checked * 100).toFixed(2)) : null,
        orders: new Set(rows.map((r) => r.so)).size,
        dispatched: rows.filter((r) => r.dispatched).length,
        producing: rows.filter((r) => r.running.length > 0).length,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
