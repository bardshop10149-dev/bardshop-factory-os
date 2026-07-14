import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { PAYMENT_PCTS, SHIP_METHODS, type PaymentPct, type ShipMethod } from '@/lib/purchasing/types'

export const dynamic = 'force-dynamic'

// POST：更新採購追蹤狀態（覆蓋層，不動 erp_pj_sync）。
//   { type:'line', doc_no, sub_no, sent?, shipped?, ship_method?, expected_ship_date? } → po_line_tracking upsert
//   { type:'payment', doc_no, payment_pct } → po_payment upsert（表頭層級）
// 里程碑：已發單(sent_at) / 已出貨(shipped_at) 皆採購手動 toggle；已到倉由入庫量自動判定（不存此表）
type LineBody = {
  type: 'line'
  doc_no: string
  sub_no: string
  sent?: boolean               // true=標記已發單；false=取消
  shipped?: boolean            // true=標記已出貨；false=取消
  ship_method?: ShipMethod | null
  expected_ship_date?: string | null
  note?: string | null         // 逐行手打備註（trim 後空字串視為清除；上限 500 字）
}

const NOTE_MAX_LEN = 500
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

      // upsert 為整列覆蓋 → 先讀既有值當基準，再套用狀態轉移，避免洗掉其他欄位
      const { data: existing, error: readErr } = await supabase
        .from('po_line_tracking')
        .select('sent_at, shipped_at, ship_method, expected_ship_date, note')
        .eq('doc_no', docNo)
        .eq('sub_no', subNo)
        .maybeSingle()
      if (readErr) throw new Error(readErr.message)

      let sentAt: string | null = existing?.sent_at ?? null
      let shippedAt: string | null = existing?.shipped_at ?? null
      let shipMethod: string | null = existing?.ship_method ?? null
      let expectedShip: string | null = existing?.expected_ship_date ?? null
      let note: string | null = existing?.note ?? null

      // 已發單 / 已出貨為兩個獨立里程碑，各自 toggle（保留原時戳、互不牽連）
      if (body.sent !== undefined) sentAt = body.sent ? (sentAt ?? now) : null
      if (body.shipped !== undefined) shippedAt = body.shipped ? now : null
      if (body.ship_method !== undefined) {
        if (body.ship_method !== null && !SHIP_METHODS.includes(body.ship_method)) {
          return NextResponse.json({ success: false, error: `ship_method 必須是 ${SHIP_METHODS.join('/')}` }, { status: 400 })
        }
        shipMethod = body.ship_method
      }
      if (body.expected_ship_date !== undefined) {
        if (body.expected_ship_date !== null && !isDateText(String(body.expected_ship_date))) {
          return NextResponse.json({ success: false, error: 'expected_ship_date 格式須為 YYYY-MM-DD' }, { status: 400 })
        }
        expectedShip = body.expected_ship_date
      }
      if (body.note !== undefined) {
        if (body.note !== null && typeof body.note !== 'string') {
          return NextResponse.json({ success: false, error: 'note 必須是文字' }, { status: 400 })
        }
        const trimmed = (body.note ?? '').trim()
        if (trimmed.length > NOTE_MAX_LEN) {
          return NextResponse.json({ success: false, error: `備註最多 ${NOTE_MAX_LEN} 字` }, { status: 400 })
        }
        note = trimmed || null
      }

      const { error } = await supabase
        .from('po_line_tracking')
        .upsert({
          doc_no: docNo, sub_no: subNo,
          sent_at: sentAt, shipped_at: shippedAt,
          ship_method: shipMethod, expected_ship_date: expectedShip,
          note,
          updated_by: updatedBy, updated_at: now,
        }, { onConflict: 'doc_no,sub_no' })
      if (error) throw new Error(error.message)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ success: false, error: 'type 必須是 line 或 payment' }, { status: 400 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
