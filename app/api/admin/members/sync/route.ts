import { NextResponse } from 'next/server'
import { formatSupabaseAdminError, getSupabaseAdminClient } from '../../../../../lib/supabaseAdmin'
import { guardAdmin } from '../../../../../lib/requireAuth'

type MemberRow = {
  id: number
  email: string | null
  password: string | null
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
      .select('id, email, password, auth_user_id')
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
    let createdAuthUsers = 0
    let skipped = 0
    const failed: Array<{ memberId: number; email: string; reason: string }> = []

    for (const member of rows) {
      const email = member.email?.trim()
      if (!email) {
        skipped += 1
        continue
      }

      try {
        let authUser = await findAuthUserByEmail(email)

        if (!authUser) {
          if (!member.password) {
            failed.push({ memberId: member.id, email, reason: '缺少密碼，無法建立 auth user' })
            continue
          }

          const { data: createdUserData, error: createError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password: String(member.password),
            email_confirm: true,
          })

          if (createError || !createdUserData.user?.id) {
            failed.push({
              memberId: member.id,
              email,
              reason: formatSupabaseAdminError(createError?.message || '建立 auth user 失敗'),
            })
            continue
          }

          authUser = createdUserData.user
          createdAuthUsers += 1
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
      createdAuthUsers,
      skipped,
      failed,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知錯誤'
    return NextResponse.json({ error: formatSupabaseAdminError(message) }, { status: 500 })
  }
}
