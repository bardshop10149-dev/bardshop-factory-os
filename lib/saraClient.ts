/**
 * SARA Factory API client (server-side)
 * Docs: https://sara-factory.com/api/data_export
 *
 * 使用方式：
 *   import { saraFetch } from '@/lib/saraClient'
 *   const orders = await saraFetch('/data/order')
 *
 * 必要環境變數：
 *   SARA_CLIENT_SECRET = "..."  // 由 SARA 系統產生，含作用域
 *   SARA_BASE_URL      = "https://sara-factory.com/api/data_export" (可選，預設此值)
 */

const DEFAULT_BASE = 'https://sara-factory.com/api/data_export'

interface CachedToken {
  token: string
  expiredAt: number // epoch ms
}

let cached: CachedToken | null = null

function getBase(): string {
  return process.env.SARA_BASE_URL?.replace(/\/+$/, '') || DEFAULT_BASE
}

function getSecret(): string {
  const s = process.env.SARA_CLIENT_SECRET
  if (!s) {
    throw new Error('未設定 SARA_CLIENT_SECRET 環境變數')
  }
  return s
}

/** 取得（必要時刷新）暫時令牌 */
export async function getSaraToken(force = false): Promise<string> {
  const now = Date.now()
  // 預留 60 秒緩衝
  if (!force && cached && cached.expiredAt - 60_000 > now) {
    return cached.token
  }

  const res = await fetch(`${getBase()}/temp_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_secret: getSecret() }),
    cache: 'no-store',
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`SARA temp_token 取得失敗 HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const json = await res.json() as { token?: string; api_key?: string; expired_at?: string } & Record<string, unknown>
  const apiKey = json.token ?? json.api_key
  if (!apiKey) {
    throw new Error(`SARA temp_token 回應缺少 token / api_key 欄位。實際回應欄位：${Object.keys(json).join(', ')}`)
  }

  // expired_at 形式："2024-03-14 10:45:47"（伺服器時間，視為 UTC）
  const expIso = json.expired_at?.replace(' ', 'T') + 'Z'
  const expMs = json.expired_at ? Date.parse(expIso) : now + 30 * 60 * 1000
  cached = {
    token: apiKey,
    expiredAt: Number.isFinite(expMs) ? expMs : now + 30 * 60 * 1000,
  }
  return cached.token
}

/** 呼叫 SARA 任一端點（自動帶 Bearer 與 token 過期重試） */
export async function saraFetch<T = unknown>(
  path: string,
  body: unknown = {},
): Promise<T> {
  const url = `${getBase()}${path.startsWith('/') ? path : `/${path}`}`
  let token = await getSaraToken()

  const doCall = async () => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  })

  let res = await doCall()

  // 401 → 強制刷新 token 重試一次
  if (res.status === 401) {
    token = await getSaraToken(true)
    res = await doCall()
  }

  const text = await res.text()
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }

  if (!res.ok) {
    const msg = typeof parsed === 'string'
      ? parsed
      : (parsed as { message?: string; error?: string } | null)?.message
        ?? (parsed as { error?: string } | null)?.error
        ?? `HTTP ${res.status}`
    // 附帶 token 預覽協助診斷
    const tokenInfo = token ? `[token: ${token.slice(0, 8)}...len=${token.length}]` : '[token: <empty>]'
    throw new Error(`SARA ${path} 失敗：${msg} ${tokenInfo}`)
  }

  return parsed as T
}

/** 取得目前快取 token（debug 用） */
export function getSaraTokenCacheState(): { hasToken: boolean; expiredAt?: string } {
  if (!cached) return { hasToken: false }
  return { hasToken: true, expiredAt: new Date(cached.expiredAt).toISOString() }
}
