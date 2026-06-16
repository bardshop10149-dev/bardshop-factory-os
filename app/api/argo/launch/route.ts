import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * 進入「ARGO 外掛區」：以登入者身分簽一張短期 SSO 票證，server-to-server 換取 argo token，
 * 並記一筆「誰進入」的系統日誌。前端拿 token 後 postMessage 給 argo iframe 完成單一登入。
 */
export async function POST() {
  const g = await guardAuth()
  if (!g.ok) return g.res

  const secret = process.env.ARGO_SSO_SECRET
  const argoBase = (process.env.ARGO_BASE_URL || '').replace(/\/+$/, '')
  if (!secret || !argoBase) {
    return NextResponse.json({ error: 'ARGO 外掛區尚未設定（缺 ARGO_SSO_SECRET / ARGO_BASE_URL）' }, { status: 500 })
  }

  // 簽 SSO 票證（對應 argo backend/main.py 的 _verify_sso_ticket）
  const now = Math.floor(Date.now() / 1000)
  const payloadB64 = b64url(Buffer.from(JSON.stringify({
    sub: g.member.email,
    name: g.member.realName ?? '',
    iat: now,
    exp: now + 60,
  }), 'utf8'))
  const sig = b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest())
  const ticket = `${payloadB64}.${sig}`

  // server-to-server 換 argo token
  let argoToken = ''
  try {
    const r = await fetch(`${argoBase}/api/auth/sso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    })
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; token?: string; error?: string }
    if (!r.ok || !j.token) {
      return NextResponse.json({ error: `ARGO 登入失敗：${j.error || `HTTP ${r.status}`}` }, { status: 502 })
    }
    argoToken = j.token
  } catch (e) {
    return NextResponse.json({ error: `無法連線 ARGO：${e instanceof Error ? e.message : '未知錯誤'}` }, { status: 502 })
  }

  // 記 LOG（誰進入 ARGO 外掛區）— 用 service_role 以 guardAuth 身分寫，失敗不擋
  try {
    const admin = getSupabaseAdminClient()
    await admin.from('system_logs').insert({
      actor_user_id: g.member.authUserId,
      user_name: g.member.realName || g.member.email,
      user_email: g.member.email,
      action_type: '進入 ARGO 外掛區',
      target_resource: 'argo',
      module: 'ARGO外掛區',
      details: '',
      metadata: {},
    })
  } catch { /* LOG 失敗不擋登入 */ }

  return NextResponse.json({ ok: true, token: argoToken, argoBase })
}
