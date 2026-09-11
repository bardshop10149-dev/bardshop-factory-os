import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// 產期詢問單的「備註事項」：送出後追加的補充說明（只能新增，不提供編輯/刪除）。
// 資料表見 sql/20260911_schedule_inquiry_notes.sql。
//
// 作者一律由伺服器依登入身分帶入，不接受前端傳來的 author_name/author_email
// （與主 route 的 POST 同樣的理由：前端傳的身分不可信）。

// route 檔只能匯出 HTTP method 與路由設定；此常數僅本檔使用
const NOTES_TABLE = 'schedule_inquiry_notes'
const NOTE_COLUMNS = 'id,inquiry_id,note,author_name,author_email,created_at'
const MAX_NOTE_LEN = 2000

// ============================================================
// GET ?inquiry_id=123 —— 取單一詢問單的備註事項（新增後重新整理該筆用）
// ============================================================
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const id = Number(request.nextUrl.searchParams.get('inquiry_id'))
    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ success: false, error: 'inquiry_id 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(NOTES_TABLE)
      .select(NOTE_COLUMNS)
      .eq('inquiry_id', id)
      .order('created_at', { ascending: true })

    if (error) {
      return NextResponse.json({ success: false, error: formatSupabaseAdminError(error.message) }, { status: 500 })
    }
    return NextResponse.json({ success: true, notes: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// POST —— 新增一則備註事項
// body: { inquiry_id: number, note: string }
// 任何登入者都能補（業務本人、代班的同事、生管都會有需要），每則都記名記時間。
// ============================================================
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json().catch(() => null)
    const inquiryId = Number(body?.inquiry_id)
    const note = String(body?.note ?? '').trim()

    if (!inquiryId || Number.isNaN(inquiryId)) {
      return NextResponse.json({ success: false, error: 'inquiry_id 不可為空' }, { status: 400 })
    }
    if (!note) {
      return NextResponse.json({ success: false, error: '備註內容不可為空' }, { status: 400 })
    }
    if (note.length > MAX_NOTE_LEN) {
      return NextResponse.json({ success: false, error: `備註請控制在 ${MAX_NOTE_LEN} 字以內` }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    // 詢問單必須存在；已被業務刪除的就不再接受補備註（該筆在業務端已經看不到了）
    const { data: target, error: findErr } = await supabase
      .from('schedule_inquiries')
      .select('id, deleted_at')
      .eq('id', inquiryId)
      .maybeSingle()
    if (findErr) {
      return NextResponse.json({ success: false, error: formatSupabaseAdminError(findErr.message) }, { status: 500 })
    }
    if (!target) {
      return NextResponse.json({ success: false, error: '找不到這筆詢問單' }, { status: 404 })
    }
    if (target.deleted_at) {
      return NextResponse.json({ success: false, error: '這筆詢問單已被刪除，無法新增備註' }, { status: 409 })
    }

    const { data, error } = await supabase
      .from(NOTES_TABLE)
      .insert({
        inquiry_id: inquiryId,
        note,
        author_name: guard.member.realName ?? guard.member.email,
        author_email: guard.member.email,
      })
      .select(NOTE_COLUMNS)
      .single()

    if (error) {
      return NextResponse.json({ success: false, error: formatSupabaseAdminError(error.message) }, { status: 500 })
    }
    return NextResponse.json({ success: true, note: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
