import { NextRequest, NextResponse } from 'next/server'
import { guardAuthCached } from '@/lib/requireAuth'
import {
  decideAccess,
  findDisallowedEmbeds,
  hasRowFilter,
  memberSatisfies,
} from '@/lib/dbProxyAllowlist'

export const dynamic = 'force-dynamic'

/**
 * 瀏覽器端資料表「代查閘門」（2026-09-27 資安修復）。
 *
 * 前端 `lib/supabaseClient` 的 `.from()` 現在指到這裡（/api/db 當 supabase URL，
 * supabase-js 會自己接上 /rest/v1/<table>?...），所以 60 個頁面的查詢程式碼一行不用改；
 * 這支 route 做的事：
 *   1. guardAuthCached()：驗 httpOnly 的 bardshop-token（瀏覽器沒有 Supabase session，
 *      所以「to authenticated」的 RLS 對前端沒用，必須在這裡驗）。
 *   2. 對照 lib/dbProxyAllowlist：表名、HTTP 動詞、權限；select 裡的嵌入關聯也要在名單上。
 *   3. 以 service role 原樣轉發（查詢字串、Prefer / Range 等 PostgREST 標頭、body），
 *      回應「串流」回去——Vercel Function 回應本文上限 4.5MB 只限非串流回應。
 *
 * 不轉發的東西：
 *   - 瀏覽器帶來的 apikey / Authorization（anon key）——一律換成 service role。
 *   - Accept-Profile / Content-Profile——鎖定 public schema，避免被指去 auth / storage schema。
 *   - /rest/v1/rpc/*（table 段會是 "rpc"，不在名單 → 404）。
 */

// PostgREST 看得懂、且前端 supabase-js 會送的請求標頭
const FORWARD_REQUEST_HEADERS = ['accept', 'content-type', 'prefer', 'range', 'range-unit'] as const
// 回給 supabase-js 解析用的回應標頭（Content-Range 是 count: 'exact' 的來源）
const FORWARD_RESPONSE_HEADERS = ['content-type', 'content-range', 'preference-applied', 'content-location', 'location'] as const

const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/

function jsonError(status: number, message: string, extra: Record<string, unknown> = {}) {
  // 用 PostgREST 一樣的 { message } 形狀，supabase-js 會把它放進 error.message
  return NextResponse.json({ message, code: 'EIP_DB_PROXY', ...extra }, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function handle(request: NextRequest, ctx: { params: Promise<{ table: string }> }) {
  const g = await guardAuthCached()
  if (!g.ok) return g.res

  const { table } = await ctx.params
  if (!TABLE_NAME_RE.test(table)) return jsonError(404, '不合法的資料表名稱')

  const decision = decideAccess(table, request.method)
  if (!decision.ok) return jsonError(decision.status, decision.reason)
  if (!memberSatisfies(g.member, decision.requirement)) {
    return jsonError(403, `需要權限：${decision.requirement}`)
  }

  const search = request.nextUrl.searchParams
  const badEmbeds = findDisallowedEmbeds(search.get('select'))
  if (badEmbeds.length > 0) {
    return jsonError(403, `select 嵌入了不開放的關聯：${badEmbeds.join(', ')}`)
  }
  if ((request.method === 'PATCH' || request.method === 'DELETE') && !hasRowFilter(search)) {
    return jsonError(400, `${request.method} 必須帶篩選條件（拒絕整表操作）`)
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
  if (!supabaseUrl || !serviceKey) return jsonError(500, '伺服器設定錯誤：缺少 Supabase 環境變數')

  const upstreamUrl = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/${table}${request.nextUrl.search}`
  const headers = new Headers()
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(h)
    if (v) headers.set(h, v)
  }
  headers.set('apikey', serviceKey)
  headers.set('Authorization', `Bearer ${serviceKey}`)
  if (request.method === 'GET' || request.method === 'HEAD') headers.set('Accept-Profile', 'public')
  else headers.set('Content-Profile', 'public')

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? await request.text() : undefined,
      cache: 'no-store',
    })
  } catch (e) {
    console.error('[api/db] upstream fetch 失敗:', e)
    return jsonError(502, '資料庫代查失敗')
  }

  const resHeaders = new Headers({ 'Cache-Control': 'no-store' })
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) resHeaders.set(h, v)
  }
  // HEAD / 204 不能帶 body；其餘直接把上游的串流接過來
  const body = request.method === 'HEAD' || upstream.status === 204 ? null : upstream.body
  return new Response(body, { status: upstream.status, headers: resHeaders })
}

export const GET = handle
export const HEAD = handle
export const POST = handle
export const PATCH = handle
export const DELETE = handle
