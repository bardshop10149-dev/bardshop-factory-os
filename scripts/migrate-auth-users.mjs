#!/usr/bin/env node
/**
 * scripts/migrate-auth-users.mjs
 *
 * 一次性遷移腳本：為現有 members 表中尚未建立 Supabase Auth 帳號的成員，
 * 在 auth.users 建立對應帳號，並回寫 members.auth_user_id。
 *
 * 執行前置條件：
 *   1. 本機已有 .env.local（NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY）
 *   2. members 表的 password 欄位仍為明文（遷移完成後再清空）
 *
 * 執行方式：
 *   node --env-file=.env.local scripts/migrate-auth-users.mjs [--dry-run]
 *
 * 選項：
 *   --dry-run   只印出計畫，不實際建立帳號或修改資料庫
 */

import { createClient } from '@supabase/supabase-js'

const DRY_RUN = process.argv.includes('--dry-run')

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SB_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE

if (!SB_URL || !SB_SECRET) {
  console.error('❌ 缺少環境變數：NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

if (DRY_RUN) console.log('🔍 Dry-run 模式：不會實際修改任何資料\n')

const admin = createClient(SB_URL, SB_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── 1. 讀取所有 members
const { data: members, error: membersError } = await admin
  .from('members')
  .select('id, email, password, real_name, is_admin, auth_user_id')
  .order('id', { ascending: true })

if (membersError) { console.error('❌ 讀取 members 失敗:', membersError.message); process.exit(1) }
console.log(`📋 共 ${members.length} 位成員`)

// ── 2. 讀取所有現有 auth.users（分頁）
const existingAuthEmails = new Map() // email -> auth_user_id
for (let page = 1; page <= 20; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
  if (error) { console.error('❌ listUsers 失敗:', error.message); process.exit(1) }
  for (const u of data.users) {
    if (u.email) existingAuthEmails.set(u.email.toLowerCase(), u.id)
  }
  if (data.users.length < 200) break
}
console.log(`🔑 auth.users 現有 ${existingAuthEmails.size} 筆\n`)

// ── 3. 逐一處理
let created = 0, skipped = 0, failed = 0, updated = 0

for (const m of members) {
  const email = m.email?.trim().toLowerCase()
  if (!email) { console.log(`  ⚠️  id=${m.id} 無 email，跳過`); skipped++; continue }

  const existingId = existingAuthEmails.get(email)

  let authUserId = existingId ?? null

  if (!existingId) {
    // 不在 auth.users → 建立
    if (DRY_RUN) {
      console.log(`  [DRY] 將建立 auth.users: ${email}`)
      created++
      continue
    }

    const password = m.password ? String(m.password) : null
    if (!password) {
      console.log(`  ⚠️  ${email}：無密碼，跳過建立（請管理員手動設定）`)
      skipped++
      continue
    }

    const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { real_name: m.real_name ?? '' },
    })

    if (createErr) {
      console.error(`  ❌ 建立失敗 ${email}:`, createErr.message)
      failed++
      continue
    }

    authUserId = newUser.user.id
    created++
    console.log(`  ✅ 建立 ${email}  → auth_id=${authUserId}`)
  } else {
    console.log(`  ✓  ${email} 已在 auth.users（id=${existingId}）`)
    skipped++
  }

  // 回寫 auth_user_id（若尚未設定或不一致）
  if (authUserId && m.auth_user_id !== authUserId) {
    if (DRY_RUN) {
      console.log(`  [DRY] 將更新 members.auth_user_id: ${email} → ${authUserId}`)
      updated++
      continue
    }
    const { error: upErr } = await admin
      .from('members')
      .update({ auth_user_id: authUserId })
      .eq('id', m.id)
    if (upErr) console.warn(`  ⚠️  回寫 auth_user_id 失敗 ${email}:`, upErr.message)
    else updated++
  }
}

console.log(`
═══════════════════════════════════════
 遷移完成
 建立 auth.users：${created} 筆
 已存在（跳過）：${skipped} 筆
 回寫 auth_user_id：${updated} 筆
 失敗：${failed} 筆
═══════════════════════════════════════

後續步驟：
  1. 執行 rls_verify.js Part B（提供 TEST_EMAIL + TEST_PASSWORD）確認登入正常
  2. 確認正常後，在 Supabase SQL Editor 套用 rls_policies.sql
  3. 通知所有成員更新密碼（舊明文密碼已外洩）
`)
