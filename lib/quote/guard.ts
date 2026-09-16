/**
 * 報價系統 API 的授權守門。
 *
 * 正式環境一律走 lib/requireAuth 的 guardPermission（驗 Supabase token + 重查 members）。
 * 只有「本機開發 + QUOTE_DEV_SEED=1」時才回一個假成員：這個旗標本來就代表
 * 「不連資料庫、用 seed JSON 跑」，沒有真 Supabase session 可驗，所以連授權一起跳過。
 * 兩個條件缺一不可（NODE_ENV 由 next dev/build 決定，Vercel 正式站永遠是 production）。
 */
import { guardPermission, type AuthedMember } from '@/lib/requireAuth'
import type { NextResponse } from 'next/server'

export type QuoteGuard =
  | { ok: true; member: AuthedMember }
  | { ok: false; res: NextResponse }

export function isDevSeedAuthBypass(): boolean {
  return process.env.QUOTE_DEV_SEED === '1' && process.env.NODE_ENV === 'development'
}

export async function guardQuote(permission: 'quote_user' | 'quote_admin'): Promise<QuoteGuard> {
  if (isDevSeedAuthBypass()) {
    return {
      ok: true,
      member: {
        authUserId: 'dev-seed',
        email: 'dev-seed@local',
        realName: '開發用假帳號',
        department: null,
        isAdmin: true,
        permissions: ['info_board', 'quote_user', 'quote_admin'],
      },
    }
  }
  return guardPermission(permission)
}
