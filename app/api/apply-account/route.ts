import { NextResponse } from 'next/server'
import { formatSupabaseAdminError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

/**
 * 公開「申請帳號」端點（不需登入）。
 *
 * SEC 修復 V1/V3：原本 apply-account 頁面用前端 anon key 直接 insert members（含明文密碼），
 * 這代表 anon 對 members 有寫入權，且明文密碼被存進 DB。改由後端以 service role 處理：
 *   1. 申請當下就直接建立 Supabase Auth 使用者（email_confirm），密碼只進 Auth，不存明文。
 *   2. members 只寫非機密欄位 + auth_user_id，狀態 PendingApproval、無任何權限
 *      → 申請者雖能通過 Auth 驗證，但沒有權限，實際進不了任何功能，須待管理員審核指派權限。
 *   3. 因為 Auth 使用者已在申請時建立，不再需要「審核同步」去讀明文密碼補建 Auth，
 *      整條流程不再有明文密碼落地。
 */

const isMissingPendingColumnError = (error: { message?: string } | null | undefined) =>
  Boolean(error?.message?.includes('is_pending_approval'))

const normalizeEmail = (email: string) => email.trim().toLowerCase()

// GET：提供公開申請頁的部門下拉選單（避免申請頁再用 anon 直讀 DB）
export async function GET() {
  try {
    const supabaseAdmin = getSupabaseAdminClient()
    const { data, error } = await supabaseAdmin
      .from('departments')
      .select('id, name')
      .order('id', { ascending: true })
    if (error) {
      return NextResponse.json({ error: formatSupabaseAdminError(error.message) }, { status: 500 })
    }
    return NextResponse.json({ ok: true, departments: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      real_name?: string
      nickname?: string
      department?: string
      email?: string
      password?: string
    }

    const real_name = body.real_name?.trim()
    const department = body.department?.trim()
    const email = body.email ? normalizeEmail(body.email) : ''
    const password = body.password

    if (!real_name || !department || !email || !password) {
      return NextResponse.json({ error: '請填寫姓名、部門、Email 與密碼' }, { status: 400 })
    }
    if (password.length < 6) {
      return NextResponse.json({ error: '密碼至少需 6 碼' }, { status: 400 })
    }

    const supabaseAdmin = getSupabaseAdminClient()

    // 1. Email 唯一性檢查
    const { data: existingMember } = await supabaseAdmin
      .from('members')
      .select('id')
      .eq('email', email)
      .maybeSingle()
    if (existingMember?.id) {
      return NextResponse.json({ error: '此 Email 已被使用，請改用其他信箱。' }, { status: 409 })
    }

    // 2. 建立 Supabase Auth 使用者（密碼只進 Auth）
    const { data: createdUserData, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        real_name,
        nickname: body.nickname?.trim() || '',
        department,
      },
    })
    if (createUserError || !createdUserData.user?.id) {
      // 不透露過多細節，但區分「已存在」與其他錯誤
      const msg = createUserError?.message ?? '建立帳號失敗'
      const isDup = /already registered|already exists|duplicate/i.test(msg)
      return NextResponse.json(
        { error: isDup ? '此 Email 已被使用，請改用其他信箱。' : `申請失敗：${formatSupabaseAdminError(msg)}` },
        { status: isDup ? 409 : 400 }
      )
    }
    const authUserId = createdUserData.user.id

    // 3. 寫入 members（不含明文密碼），狀態 PendingApproval、無權限
    const payloadBase = {
      real_name,
      nickname: body.nickname?.trim() ?? '',
      department,
      email,
      permissions: [] as string[],
      status: 'PendingApproval',
      is_admin: false,
      auth_user_id: authUserId,
    }
    const payloadWithPending = { ...payloadBase, is_pending_approval: true }

    let insertError = null
    const { error: firstErr } = await supabaseAdmin.from('members').insert([payloadWithPending])
    if (isMissingPendingColumnError(firstErr)) {
      const { error: retryErr } = await supabaseAdmin.from('members').insert([payloadBase])
      insertError = retryErr
    } else {
      insertError = firstErr
    }

    if (insertError) {
      // members 寫入失敗時，回收剛建立的 Auth 使用者，避免產生孤兒帳號
      await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {})
      return NextResponse.json(
        { error: `申請失敗：${formatSupabaseAdminError(insertError.message)}` },
        { status: 400 }
      )
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}
