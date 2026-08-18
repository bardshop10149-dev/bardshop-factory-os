import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const SETTINGS_KEY = 'sara_csv_buffer'
// 記錄塔台「最後一次成功呼叫」的時間，跟 buffer 本身的 updated_at 分開存──
// buffer 的 updated_at 會被管理端上傳/清空等操作一起洗掉，不能拿來當「塔台上次呼出時間」用。
const LAST_PULLED_KEY = 'sara_csv_last_pulled_at'

export const CSV_H1 = 'Order Number,Manufacturing Order Number,Product Name,Product Description,Lot Number,Production Quantity,Due,Priority Level,Earliest Start Time,Job Sequence,Workcenter,Job Name,Job Quantity,Out Sourcing,Est. Time,Time Unit,BOM Components,Material Required Quantity,customer_id,assigned_machine,Rule,Parameter 1'
export const CSV_H2 = '訂單編號,(必填)工單編號,(必填)品號,規格,生產批號,(必填)生產需求數量,(必填)需求日,排程優先等級(1-99),最早可開始時間,(必填)工序,(必填)站點,(必填)製程名稱,製程數量,製程委外,(必填)預估工時,工時單位,BOM元件品號,物料需求數量,客戶名稱,分配機台,規則,參數1'

function checkApiKey(request: NextRequest): boolean {
  const envKey = process.env.SARA_EXCHANGE_API_KEY
  if (!envKey) return false
  const auth = request.headers.get('authorization') ?? ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() === envKey
  return new URL(request.url).searchParams.get('api_key') === envKey
}

function escCsv(v: string): string {
  return /[,"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

// GET — 塔台 API Key 拉取（回傳 CSV 文字），或管理端查詢（回傳 JSON rows）
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const isSaraCall = checkApiKey(request)

  if (!isSaraCall) {
    // 管理端需要登入
    const guard = await guardAuth()
    if (!guard.ok) return guard.res
  }

  try {
    const supabase = getSupabaseAdminClient()
    const { data } = await supabase.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
    const rows: string[][] = Array.isArray(data?.value) ? (data!.value as string[][]) : []

    if (isSaraCall) {
      // 塔台端每次成功呼叫（不論有沒有帶 mark_consumed）都記錄「最後拉取時間」，
      // 跟 buffer 本身的 updated_at 分開存，才不會被管理端的上傳/清空操作洗掉。
      const fetchedAt = new Date().toISOString()
      await supabase.from('app_settings').upsert(
        { key: LAST_PULLED_KEY, value: fetchedAt, updated_at: fetchedAt },
        { onConflict: 'key' }
      )

      // 若帶 mark_consumed=true，拉取後清空 buffer
      if (searchParams.get('mark_consumed') === 'true') {
        await supabase.from('app_settings').upsert(
          { key: SETTINGS_KEY, value: [], updated_at: fetchedAt },
          { onConflict: 'key' }
        )
      }

      // 塔台呼叫：回傳 JSON { success, count, fetched_at, data: [...] }
      const colHeaders = CSV_H1.split(',')
      const dataObjects = rows.map(row => {
        const obj: Record<string, string> = {}
        colHeaders.forEach((h, i) => { obj[h] = row[i] ?? '' })
        return obj
      })
      return NextResponse.json({
        success: true,
        count: rows.length,
        fetched_at: fetchedAt,
        data: dataObjects,
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // 管理端：回傳 JSON，附上塔台最後一次成功拉取的時間
    const { data: lastPulled } = await supabase.from('app_settings').select('value').eq('key', LAST_PULLED_KEY).maybeSingle()
    const lastPulledAt = typeof lastPulled?.value === 'string' ? lastPulled.value : null
    return NextResponse.json({ success: true, rows, count: rows.length, last_pulled_at: lastPulledAt }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

// POST — append or replace rows（管理端）
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { rows: string[][]; append?: boolean }
    const supabase = getSupabaseAdminClient()
    let finalRows: string[][]
    if (body.append) {
      const { data } = await supabase.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
      const existing: string[][] = Array.isArray(data?.value) ? (data!.value as string[][]) : []
      finalRows = [...existing, ...body.rows]
    } else {
      finalRows = body.rows
    }
    const { error } = await supabase.from('app_settings').upsert(
      { key: SETTINGS_KEY, value: finalRows, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
    if (error) throw error
    return NextResponse.json({ success: true, count: finalRows.length })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

// DELETE — clear buffer（管理端）
export async function DELETE() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from('app_settings').upsert(
      { key: SETTINGS_KEY, value: [], updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

