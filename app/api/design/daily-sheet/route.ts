import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, describeError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import type { SourceRow } from '@/lib/argoerp/dailyOrderSheetShared'

export const dynamic = 'force-dynamic'

const TABLE = 'design_daily_sheets'

// 美編天地「每日出單表」：美編直接在系統內填寫的試算表式出單表，取代貼 Excel 的前段流程。
// 每天 16:00 由 /api/cron/design-sheet-transfer 排程整批轉入生管的 daily_order_sheets。
//
// 16:00 鎖定規則：新增資料若目標日是「今天」且現在已過台北時間 16:00，一律拒絕
// （今天的出單表已經在等待/完成轉入，不可再塞資料進去）——只套用在「未指定 target_date，
// 由伺服器自動判斷」的情境（銷售訂單查詢頁的「傳送到出單表」）；生管「退單移到隔日出單表」
// 一定明確指定目標日期（通常是未來日），不受此限制。

function taipeiNow(): Date {
  return new Date(Date.now() + 8 * 3600 * 1000)
}
function taipeiDateStr(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
/** 現在（台北）未過 16:00 → 今天；已過 16:00 → 明天 */
function autoTargetDate(): string {
  const now = taipeiNow()
  const target = new Date(now)
  if (now.getUTCHours() >= 16) target.setUTCDate(target.getUTCDate() + 1)
  return taipeiDateStr(target)
}

// GET ?date=YYYY-MM-DD → 該日的美編出單表（不存在時回傳空 rows）
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const date = request.nextUrl.searchParams.get('date')
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: '請提供有效的 date (YYYY-MM-DD)' }, { status: 400 })
    }
    const sb = getSupabaseAdminClient()
    const { data, error } = await sb.from(TABLE).select('*').eq('sheet_date', date).maybeSingle()
    if (error) throw error
    return NextResponse.json({
      success: true,
      sheet: data ?? { sheet_date: date, rows: [], transferred_at: null, updated_at: null },
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: describeError(e) }, { status: 500 })
  }
}

// PUT { date, rows } → 整批覆蓋該日內容（美編出單表頁面的「儲存」按鈕）
export async function PUT(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { date?: string; rows?: unknown[] }
    const { date, rows } = body
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: '請提供有效的 date (YYYY-MM-DD)' }, { status: 400 })
    }
    if (!Array.isArray(rows)) {
      return NextResponse.json({ success: false, error: 'rows 必須是陣列' }, { status: 400 })
    }
    const sb = getSupabaseAdminClient()
    const { data, error } = await sb.from(TABLE).upsert({
      sheet_date: date,
      rows,
      updated_at: new Date().toISOString(),
      updated_by: guard.member.email,
    }, { onConflict: 'sheet_date' }).select().single()
    if (error) throw error
    return NextResponse.json({ success: true, sheet: data })
  } catch (e) {
    return NextResponse.json({ success: false, error: describeError(e) }, { status: 500 })
  }
}

// POST { target_date?, rows } → 追加列到指定日期（不給 target_date 時伺服器依 16:00 規則自動判斷）
// 用途：銷售訂單查詢頁「傳送到出單表」、生管出單表「移到隔日出單表」（退單）
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { target_date?: string; rows?: Partial<SourceRow>[] }
    const rows = body.rows
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ success: false, error: 'rows 不可為空' }, { status: 400 })
    }

    let targetDate: string
    if (body.target_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.target_date)) {
        return NextResponse.json({ success: false, error: 'target_date 格式須為 YYYY-MM-DD' }, { status: 400 })
      }
      // 明確指定「今天」時仍套用 16:00 鎖定（防止舊分頁/過期畫面在鎖定後誤送）；
      // 指定其他日期（含退單常用的未來日）不受限制。
      const today = taipeiDateStr(taipeiNow())
      if (body.target_date === today && taipeiNow().getUTCHours() >= 16) {
        return NextResponse.json({ success: false, error: `已過 16:00，今天（${today}）的出單表已鎖定，請改送隔天` }, { status: 409 })
      }
      targetDate = body.target_date
    } else {
      targetDate = autoTargetDate()
    }

    const sb = getSupabaseAdminClient()
    const { data: existing } = await sb.from(TABLE).select('rows').eq('sheet_date', targetDate).maybeSingle()
    const existingRows = Array.isArray(existing?.rows) ? existing!.rows as Record<string, unknown>[] : []
    const mergedRows = [...existingRows, ...rows]

    const { data, error } = await sb.from(TABLE).upsert({
      sheet_date: targetDate,
      rows: mergedRows,
      updated_at: new Date().toISOString(),
      updated_by: guard.member.email,
    }, { onConflict: 'sheet_date' }).select().single()
    if (error) throw error
    return NextResponse.json({ success: true, target_date: targetDate, appended: rows.length, sheet: data })
  } catch (e) {
    return NextResponse.json({ success: false, error: describeError(e) }, { status: 500 })
  }
}
