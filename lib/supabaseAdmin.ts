import { createClient } from '@supabase/supabase-js'

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const payload = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 把任意丟出的錯誤物件轉成可讀字串。
 * Supabase（PostgREST）的 error 是「純物件」而非 Error 實例——`String(e)` 會變成
 * "[object Object]" 完全看不出原因（2026-09-01 使用者回報「機台儲存失敗：[object Object]」），
 * 這裡明確抽出 message/code/details/hint 組合成可讀訊息。
 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return formatSupabaseAdminError(e.message)
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const o = e as { message?: string; details?: string; hint?: string; code?: string }
    const parts = [o.message, o.code && `code=${o.code}`, o.details, o.hint].filter(Boolean)
    if (parts.length > 0) return formatSupabaseAdminError(parts.join('｜'))
    try { return JSON.stringify(e) } catch { return String(e) }
  }
  return String(e)
}

export function formatSupabaseAdminError(message: string) {
  const normalized = message.toLowerCase()

  if (normalized.includes('invalid api key') || normalized.includes('invalid jwt')) {
    return 'Supabase Admin 金鑰無效。請確認 NEXT_PUBLIC_SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY 來自同一個 Supabase 專案，並同步更新本機與 Vercel 環境變數。'
  }

  if (normalized.includes('project mismatch')) {
    return message
  }

  return message
}

export function getSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    const missingVars: string[] = []
    if (!supabaseUrl) missingVars.push('NEXT_PUBLIC_SUPABASE_URL')
    if (!supabaseServiceRoleKey) missingVars.push('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE)')
    throw new Error(`Missing Supabase admin environment variables: ${missingVars.join(', ')}`)
  }

  const urlProjectRef = (() => {
    try {
      return new URL(supabaseUrl).hostname.split('.')[0]
    } catch {
      return ''
    }
  })()

  const jwtPayload = decodeJwtPayload(supabaseServiceRoleKey)
  const keyProjectRef = typeof jwtPayload?.ref === 'string' ? jwtPayload.ref : ''

  if (urlProjectRef && keyProjectRef && urlProjectRef !== keyProjectRef) {
    throw new Error(
      `Supabase project mismatch: NEXT_PUBLIC_SUPABASE_URL is '${urlProjectRef}', but SUPABASE_SERVICE_ROLE_KEY belongs to '${keyProjectRef}'.`
    )
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}
