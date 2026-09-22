import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// 產期詢問單的「備註事項」：送出後追加的補充說明。
// 資料表見 sql/20260911_schedule_inquiry_notes.sql、sql/20260918_schedule_inquiry_note_confirm.sql。
//
// 2026-09-18 起改為兩段式：備註在「生管確認」之前可以由作者編輯，確認之後鎖定不可再改。
// （原本是只能新增不能改寫——追溯性現在改由確認機制承擔：確認就是「誰在何時認可了這段
//   文字」的錨點，確認後的內容一樣改不了。）
//
// 作者一律由伺服器依登入身分帶入，不接受前端傳來的 author_name/author_email
// （與主 route 的 POST 同樣的理由：前端傳的身分不可信）。

export const NOTES_TABLE = 'schedule_inquiry_notes'
// 用 '*' 而不是逐欄列舉：這張表沒有敏感欄位，而列舉的話只要 migration 還沒套用到
// 雲端，缺一個欄位就整包查詢失敗、備註全部消失。'*' 讓新欄位「有就帶、沒有就算了」。
const NOTE_COLUMNS = '*'
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

// ============================================================
// PATCH —— 編輯備註內容，或由生管確認 / 取消確認
// body: { id: number, note?: string }            編輯內容（限未確認，且限作者本人或生管）
//       { id: number, action: 'confirm' | 'unconfirm' }  生管確認/取消確認
// ============================================================
export async function PATCH(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json().catch(() => null)
    const id = Number(body?.id)
    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ success: false, error: 'id 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { data: target, error: findErr } = await supabase
      .from(NOTES_TABLE)
      .select('id, author_email, confirmed_at')
      .eq('id', id)
      .maybeSingle()
    if (findErr) {
      return NextResponse.json({ success: false, error: formatSupabaseAdminError(findErr.message) }, { status: 500 })
    }
    if (!target) {
      return NextResponse.json({ success: false, error: '找不到這則備註' }, { status: 404 })
    }

    const canManage = guard.member.isAdmin || guard.member.permissions.includes('production_admin')
    const action = String(body?.action ?? '')

    // ── 生管確認 / 取消確認 ──
    if (action === 'confirm' || action === 'unconfirm') {
      if (!canManage) {
        return NextResponse.json({ success: false, error: '只有生產管理可以確認備註' }, { status: 403 })
      }
      const patch = action === 'confirm'
        ? {
            confirmed_at: new Date().toISOString(),
            confirmed_by: guard.member.email,
            confirmed_by_name: guard.member.realName ?? guard.member.email,
          }
        : { confirmed_at: null, confirmed_by: null, confirmed_by_name: null }
      const { data, error } = await supabase.from(NOTES_TABLE).update(patch).eq('id', id).select(NOTE_COLUMNS).single()
      if (error) {
        return NextResponse.json({ success: false, error: formatSupabaseAdminError(error.message) }, { status: 500 })
      }
      return NextResponse.json({ success: true, note: data })
    }

    // ── 編輯內容 ──
    const note = String(body?.note ?? '').trim()
    if (!note) {
      return NextResponse.json({ success: false, error: '備註內容不可為空' }, { status: 400 })
    }
    if (note.length > MAX_NOTE_LEN) {
      return NextResponse.json({ success: false, error: `備註請控制在 ${MAX_NOTE_LEN} 字以內` }, { status: 400 })
    }
    // 確認後鎖定：生管也一併擋下——確認的意義就是「這段文字定案了」，
    // 真要改就先取消確認，讓這個動作在紀錄上留下痕跡。
    if (target.confirmed_at) {
      return NextResponse.json(
        { success: false, error: '這則備註已由生管確認，不可再編輯（如需修改請先請生管取消確認）' },
        { status: 409 }
      )
    }
    const isOwner = !!guard.member.email && guard.member.email === target.author_email
    if (!isOwner && !canManage) {
      return NextResponse.json({ success: false, error: '只有備註的填寫人本人或生產管理可以編輯' }, { status: 403 })
    }

    const { data, error } = await supabase
      .from(NOTES_TABLE)
      .update({ note, updated_at: new Date().toISOString() })
      .eq('id', id)
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
