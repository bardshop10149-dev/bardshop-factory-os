import { NextResponse } from 'next/server'
import { formatSupabaseAdminError, getSupabaseAdminClient } from '../../../../../lib/supabaseAdmin'
import { guardAdmin } from '../../../../../lib/requireAuth'

/**
 * 把「還沒綁 auth_user_id」的成員，對應到既有的 Supabase Auth 帳號。
 *
 * 2026-09-27 起 members.password 欄位已刪除（sql/20260927_lockdown_anon.sql；該欄早已全空），
 * 所以這支不再「用明文密碼替成員建 Auth 帳號」——找不到 Auth 帳號的成員會列在 failed，
 * 請管理員到「組織成員管理 → 設定登入密碼」替他建立。
 */
type MemberRow = {
  id: number
  email: string | null
  auth_user_id: string | null
}

const normalizeEmail = (email: string) => email.trim().toLowerCase()

async function findAuthUserByEmail(email: string) {
  const supabaseAdmin = getSupabaseAdminClient()
  const target = normalizeEmail(email)

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error

    const users = data?.users ?? []
    const matched = users.find((user) => normalizeEmail(user.email || '') === target)
    if (matched) return matched

    if (users.length < 200) break
  }

  return null
}

export async function POST() {
  try {
    const guard = await guardAdmin()
    if (!guard.ok) return guard.res

    const supabaseAdmin = getSupabaseAdminClient()
    const { data: members, error: membersError } = await supabaseAdmin
      .from('members')
      .select('id, email, auth_user_id')
      .is('auth_user_id', null)
      .order('id', { ascending: true })

    if (membersError) {
      return NextResponse.json(
        { error: `讀取 members 失敗: ${formatSupabaseAdminError(membersError.message)}` },
        { status: 400 }
      )
    }

    const rows = (members || []) as MemberRow[]
    let updated = 0
    let skipped = 0
    const failed: Array<{ memberId: number; email: string; reason: string }> = []

    for (const member of rows) {
      const email = member.email?.trim()
      if (!email) {
        skipped += 1
        continue
      }

      try {
        const authUser = await findAuthUserByEmail(email)

        if (!authUser) {
          failed.push({ memberId: member.id, email, reason: '尚無 Auth 帳號，請用「設定登入密碼」替此成員建立' })
          continue
        }

        const { error: updateError } = await supabaseAdmin
          .from('members')
          .update({ auth_user_id: authUser.id })
          .eq('id', member.id)

        if (updateError) {
          failed.push({ memberId: member.id, email, reason: `回寫 auth_user_id 失敗: ${updateError.message}` })
          continue
        }

        updated += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知錯誤'
        failed.push({ memberId: member.id, email, reason: formatSupabaseAdminError(message) })
      }
    }

    return NextResponse.json({
      ok: true,
      totalCandidates: rows.length,
      updated,
      createdAuthUsers: 0, // 保留欄位讓前端相容；本路由不再建立 Auth 帳號
      skipped,
      failed,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}
