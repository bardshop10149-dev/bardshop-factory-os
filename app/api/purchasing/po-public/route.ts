import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import type { PublicPoLine, ShipMethod } from '@/lib/purchasing/types'
import { normalizeDateText } from '@/lib/purchasing/types'

export const dynamic = 'force-dynamic'

// GET ?po=採購單號 或 ?so=訂單號 — 跨區（業務查詢等）可見的 PO 追蹤資訊。
//
// ★ 結構性防外流：本檔對 erp_pj_sync 的 select 字面上不含 customer_vendor，
//   且完全不查 po_payment / erp_vendors；回傳逐欄映射到 PublicPoLine（不用 spread），
//   上游 schema 變動也帶不出供應商 / 付款欄位。
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res

  const po = (request.nextUrl.searchParams.get('po') ?? '').trim()
  const so = (request.nextUrl.searchParams.get('so') ?? '').trim()
  if (!po && !so) {
    return NextResponse.json({ success: false, error: '請帶 ?po= 或 ?so=' }, { status: 400 })
  }

  const supabase = getSupabaseAdminClient()
  const SELECT = 'doc_no, sub_no, item_code, description, qty, unit, status, end_date'

  try {
    type Row = {
      doc_no: string; sub_no: string; item_code: string | null; description: string | null
      qty: number | null; unit: string | null; status: string | null; end_date: string | null
    }
    const rows: Row[] = []
    if (po) {
      const { data, error } = await supabase
        .from('erp_pj_sync').select(SELECT).eq('doc_type', '採購單號').eq('doc_no', po)
      if (error) throw new Error(error.message)
      rows.push(...((data ?? []) as Row[]))
    } else {
      // 常平 PO 以批號（MBP_LOT_NO）記 SO 號、委外以 SO_PROJECT_ID —— 兩者都查
      for (const field of ['SO_PROJECT_ID', 'MBP_LOT_NO'] as const) {
        const { data, error } = await supabase
          .from('erp_pj_sync').select(SELECT).eq('doc_type', '採購單號').eq(`extra->>${field}`, so)
        if (error) throw new Error(error.message)
        for (const r of (data ?? []) as Row[]) {
          if (!rows.some((x) => x.doc_no === r.doc_no && x.sub_no === r.sub_no)) rows.push(r)
        }
      }
    }

    const trackingMap = new Map<string, { shipped_at: string | null; ship_method: string | null; expected_ship_date: string | null }>()
    const docNos = [...new Set(rows.map((r) => r.doc_no))]
    if (docNos.length > 0) {
      const { data, error } = await supabase
        .from('po_line_tracking')
        .select('doc_no, sub_no, shipped_at, ship_method, expected_ship_date')
        .in('doc_no', docNos)
      if (error) throw new Error(error.message)
      for (const t of data ?? []) trackingMap.set(`${t.doc_no}|${t.sub_no}`, t)
    }

    const lines: PublicPoLine[] = rows.map((r) => {
      const t = trackingMap.get(`${r.doc_no}|${r.sub_no}`)
      return {
        doc_no: r.doc_no,
        sub_no: r.sub_no,
        item_code: r.item_code,
        description: r.description,
        qty: r.qty,
        unit: r.unit,
        po_status: r.status,
        due_date: normalizeDateText(r.end_date),
        progress: t?.shipped_at ? '已出貨' : '排程製作中',
        ship_method: (t?.ship_method ?? null) as ShipMethod | null,
        expected_ship_date: t?.expected_ship_date ?? null,
      }
    })

    return NextResponse.json({ success: true, lines })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
