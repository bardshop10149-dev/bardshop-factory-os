import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { PAYMENT_PCTS, SHIP_METHODS, type PaymentPct, type ShipMethod } from '@/lib/purchasing/types'

export const dynamic = 'force-dynamic'

// POST：更新採購追蹤狀態（覆蓋層，不動 erp_pj_sync）。
//   { type:'line', doc_no, sub_no, shipped?, ship_method?, expected_ship_date? } → po_line_tracking upsert
//   { type:'payment', doc_no, payment_pct } → po_payment upsert（表頭層級）
type LineBody = {
  type: 'line'
  doc_no: string
  sub_no: string
  shipped?: boolean
  ship_method?: ShipMethod | null
  expected_ship_date?: string | null
}
type PaymentBody = { type: 'payment'; doc_no: string; payment_pct: PaymentPct }

const isDateText = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export async function POST(request: NextRequest) {
  const guard = await guardPermission('purchasing')
  if (!guard.ok) return guard.res

  let body: LineBody | PaymentBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const docNo = String(body.doc_no ?? '').trim()
  if (!docNo) return NextResponse.json({ success: false, error: '缺少 doc_no' }, { status: 400 })

  const supabase = getSupabaseAdminClient()
  const updatedBy = guard.member.realName ?? guard.member.email
  const now = new Date().toISOString()

  try {
    if (body.type === 'payment') {
      if (!PAYMENT_PCTS.includes(body.payment_pct)) {
        return NextResponse.json({ success: false, error: 'payment_pct 必須是 0/30/50/70/100' }, { status: 400 })
      }
      const { error } = await supabase
        .from('po_payment')
        .upsert({ doc_no: docNo, payment_pct: body.payment_pct, updated_by: updatedBy, updated_at: now }, { onConflict: 'doc_no' })
      if (error) throw new Error(error.message)
      return NextResponse.json({ success: true })
    }

    if (body.type === 'line') {
      const subNo = String(body.sub_no ?? '').trim()
      if (!subNo) return NextResponse.json({ success: false, error: '缺少 sub_no' }, { status: 400 })

      const row: Record<string, unknown> = { doc_no: docNo, sub_no: subNo, updated_by: updatedBy, updated_at: now }
      if (body.shipped !== undefined) row.shipped_at = body.shipped ? now : null
      if (body.ship_method !== undefined) {
        if (body.ship_method !== null && !SHIP_METHODS.includes(body.ship_method)) {
          return NextResponse.json({ success: false, error: `ship_method 必須是 ${SHIP_METHODS.join('/')}` }, { status: 400 })
        }
        row.ship_method = body.ship_method
      }
      if (body.expected_ship_date !== undefined) {
        if (body.expected_ship_date !== null && !isDateText(String(body.expected_ship_date))) {
          return NextResponse.json({ success: false, error: 'expected_ship_date 格式須為 YYYY-MM-DD' }, { status: 400 })
        }
        row.expected_ship_date = body.expected_ship_date
      }

      // upsert 為整列覆蓋：未帶的欄位需先讀既有值合併，避免部分更新洗掉其他狀態
      const { data: existing, error: readErr } = await supabase
        .from('po_line_tracking')
        .select('shipped_at, ship_method, expected_ship_date')
        .eq('doc_no', docNo)
        .eq('sub_no', subNo)
        .maybeSingle()
      if (readErr) throw new Error(readErr.message)
      if (existing) {
        if (row.shipped_at === undefined) row.shipped_at = existing.shipped_at
        if (row.ship_method === undefined) row.ship_method = existing.ship_method
        if (row.expected_ship_date === undefined) row.expected_ship_date = existing.expected_ship_date
      }

      const { error } = await supabase
        .from('po_line_tracking')
        .upsert(row, { onConflict: 'doc_no,sub_no' })
      if (error) throw new Error(error.message)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ success: false, error: 'type 必須是 line 或 payment' }, { status: 400 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
