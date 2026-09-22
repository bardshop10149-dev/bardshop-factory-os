import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// 塔台異常回報（見 sql/20260921_sara_anomaly_reports.sql）
//
// 前台：印刷現場回報，不設功能權限——誰發現誰回報，只要求登入（才知道是誰報的）。
// 後台：生管處理完標記已完成，需要 production_admin。
//
// GET    ?status=&order_no=&limit=   列表
// POST   新增回報 { order_no, line_seq, mfg_order_number, product_name, product_desc, factory, snapshot, reason }
// PATCH  { id, action: 'resolve' | 'reopen', handled_note? }  生管結案／重新開啟
//        { id, reason }                                       回報人更正原因（限未完成）

const TABLE = 'sara_anomaly_reports'
const MAX_REASON_LEN = 2000

const asText = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}

export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const sp = request.nextUrl.searchParams
    const supabase = getSupabaseAdminClient()
    let q = supabase.from(TABLE).select('*').order('created_at', { ascending: false })

    const status = sp.get('status')
    if (status && status !== 'all') q = q.eq('status', status)
    const orderNo = sp.get('order_no')
    if (orderNo) q = q.ilike('order_no', `%${orderNo.trim()}%`)
    q = q.limit(Math.min(Number(sp.get('limit') ?? 300) || 300, 1000))

    const { data, error } = await q
    if (error) throw error
    return NextResponse.json({ success: true, reports: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as Record<string, unknown>
    const orderNo = asText(body.order_no)
    const reason = asText(body.reason)
    if (!orderNo) return NextResponse.json({ success: false, error: '請填寫銷售單號' }, { status: 400 })
    if (!reason) return NextResponse.json({ success: false, error: '請填寫異常原因' }, { status: 400 })
    if (reason.length > MAX_REASON_LEN) {
      return NextResponse.json({ success: false, error: `異常原因請控制在 ${MAX_REASON_LEN} 字以內` }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        order_no: orderNo,
        line_seq: asText(body.line_seq),
        mfg_order_number: asText(body.mfg_order_number),
        product_name: asText(body.product_name),
        product_desc: asText(body.product_desc),
        factory: asText(body.factory),
        snapshot: Array.isArray(body.snapshot) ? body.snapshot : [],
        reason,
        status: '待處理',
        // 回報人一律以登入者為準，不吃前端傳的值
        reporter_email: guard.member.email,
        reporter_name: guard.member.realName ?? guard.member.email,
      })
      .select('*')
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, report: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as Record<string, unknown>
    const id = Number(body.id)
    if (!Number.isFinite(id)) return NextResponse.json({ success: false, error: '缺少 id' }, { status: 400 })

    const supabase = getSupabaseAdminClient()
    const { data: target, error: findErr } = await supabase
      .from(TABLE).select('id, status, reporter_email').eq('id', id).maybeSingle()
    if (findErr) throw findErr
    if (!target) return NextResponse.json({ success: false, error: '找不到這筆回報' }, { status: 404 })

    const canManage = guard.member.isAdmin || guard.member.permissions.includes('production_admin')
    const action = asText(body.action)
    const now = new Date().toISOString()

    // ── 生管結案 / 重新開啟 ──
    if (action === 'resolve' || action === 'reopen') {
      if (!canManage) {
        return NextResponse.json({ success: false, error: '只有生產管理可以標記完成' }, { status: 403 })
      }
      const patch = action === 'resolve'
        ? {
            status: '已完成',
            resolved_at: now,
            resolved_by: guard.member.email,
            resolved_by_name: guard.member.realName ?? guard.member.email,
            handled_note: asText(body.handled_note),
            updated_at: now,
          }
        : { status: '待處理', resolved_at: null, resolved_by: null, resolved_by_name: null, updated_at: now }
      const { data, error } = await supabase.from(TABLE).update(patch).eq('id', id).select('*').single()
      if (error) throw error
      return NextResponse.json({ success: true, report: data })
    }

    // ── 回報人更正異常原因（已完成的就鎖起來，比照產期詢問備註的確認鎖定） ──
    const reason = asText(body.reason)
    if (!reason) return NextResponse.json({ success: false, error: '異常原因不可為空' }, { status: 400 })
    if (target.status === '已完成') {
      return NextResponse.json(
        { success: false, error: '這筆回報已標記完成，不可再修改（如需更正請生管先重新開啟）' },
        { status: 409 }
      )
    }
    const isOwner = !!guard.member.email && guard.member.email === target.reporter_email
    if (!isOwner && !canManage) {
      return NextResponse.json({ success: false, error: '只有回報人本人或生產管理可以修改' }, { status: 403 })
    }
    const { data, error } = await supabase
      .from(TABLE).update({ reason, updated_at: now }).eq('id', id).select('*').single()
    if (error) throw error
    return NextResponse.json({ success: true, report: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
