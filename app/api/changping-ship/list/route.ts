import { NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardChangpingShipOwner } from '@/lib/changpingShipOwner'

export const dynamic = 'force-dynamic'

// GET:常平訂單資料區列表(黃底=常平已出貨 標記快照)
// 權限:後台勾了 changping_ship 的人（目前只有 Snow 10011）;管理員不自動通過。
// 表由 service_role 持有,前端不直連 —— 一律經此 API。
//
// 單號欄兩種來源(Snow 2026-09-14 要求 PO/SO 都要帶):
//   po_no / so_no  = 常平工作表原文(SO 欄常夾雜「RO…/常平/PR…」等註記,且單號可能是作廢前的舊號)
//   po_line / so_erp = 由 matched_lines 回查 ARGO 同步表得到的**權威**採購行與來源單
const MAX_ROWS = 6000   // 全量後標記約 4~5 千筆;超過取 last_seen 最新的
const IN_CHUNK = 200

// 型別推導吃不了串接的 select 字串 → 照 lib/purchasing/data.ts 慣例以介面斷言
interface MarkRec {
  still_marked: boolean
  applied_at: string | null
  match_status: string | null
  matched_lines: { doc_no: string; sub_no: string }[] | null
  po_line?: string | null
  so_erp?: string | null
  [key: string]: unknown
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function GET() {
  const guard = await guardChangpingShipOwner()
  if (!guard.ok) return guard.res

  const supabase = getSupabaseAdminClient()
  try {
    const { data, error } = await supabase
      .from('changping_ship_marks')
      .select('mark_key, sheet, row_no, detail_id, po_no, pr_no, so_no, vendor, item_code, item_name, qty, '
        + 'order_date, hope_date, transport, expected_ship, ship_date_text, ship_date, fill_color, '
        + 'still_marked, first_seen_at, last_seen_at, matched_lines, match_status, applied_at, apply_note')
      .order('last_seen_at', { ascending: false })
      .order('sheet', { ascending: false })
      .order('row_no', { ascending: true })
      .limit(MAX_ROWS)
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as unknown as MarkRec[]

    // 帶上權威單號:matched_lines(採購單號+序) → ARGO 同步表回查來源單(SO_PROJECT_ID)。
    // 工作表的 SO 欄有 6 成夾雜註記文字,且 PO 可能是作廢前舊號,不能直接當單號用。
    const docNos = [...new Set(rows.flatMap((r) => (r.matched_lines ?? []).map((l) => l.doc_no)))]
    const soByLine = new Map<string, string>()
    const PAGE = 1000
    for (const part of chunk(docNos, IN_CHUNK)) {
      for (let offset = 0; ; offset += PAGE) {
        const { data: pj, error: pjErr } = await supabase
          .from('erp_pj_sync')
          .select('doc_no, sub_no, so:extra->>SO_PROJECT_ID')
          .eq('doc_type', '採購單號')
          .in('doc_no', part)
          .order('doc_no', { ascending: true })
          .order('sub_no', { ascending: true })
          .range(offset, offset + PAGE - 1)
        if (pjErr) throw new Error(pjErr.message)
        const page = (pj ?? []) as unknown as { doc_no: string; sub_no: string; so: string | null }[]
        for (const x of page) {
          if (x.so) soByLine.set(`${x.doc_no}|${x.sub_no}`, x.so)
        }
        if (page.length < PAGE) break
      }
    }
    for (const r of rows) {
      const lines = r.matched_lines ?? []
      r.po_line = lines.length
        ? [...new Set(lines.map((l) => `${l.doc_no}#${l.sub_no}`))].join(', ')
        : null
      const sos = [...new Set(lines.map((l) => soByLine.get(`${l.doc_no}|${l.sub_no}`)).filter(Boolean))]
      r.so_erp = sos.length ? (sos as string[]).join(', ') : null
    }

    const counts = {
      total: rows.length,
      active: rows.filter((r) => r.still_marked).length,
      applied: rows.filter((r) => r.applied_at != null).length,
      unmatched: rows.filter((r) => r.match_status === 'no_line').length,
    }
    return NextResponse.json({ success: true, rows, counts })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
