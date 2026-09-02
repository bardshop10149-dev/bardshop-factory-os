import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// 示意圖預覽（走 argo-tool 既有基礎設施，設計圖不落地雲端）
//
// argo-tool（bardshop-argo.com，Cloudflare Tunnel → 公司內常開機）早已內建：
//   GET /api/nas/diagrams?order_id=SO…        示意圖清單（含歷年庫 fallback）
//   GET /api/nas/diagram_thumbnail?…&token=   縮圖 JPEG（此端點特准 query token，給 <img> 用）
// 加上 EIP↔argo 的 SSO（/api/argo/launch 同款票證），拼起來就是完整預覽——
// 不需要任何新服務。本路由做 server-to-server 的部分：
//   guardAuth → 簽短期票證 → 換 argo token → 抓清單 → 回給瀏覽器
// 瀏覽器再用回傳的 token 直接 <img> argo 的縮圖端點（img 不受 CORS 限制）。
//
// 機密性：圖不存雲端；傳輸經 Cloudflare Tunnel 加密通道（與現場操作員
// 每天列印示意圖走的是同一條路）。
// ─────────────────────────────────────────────────────────────────────────────

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

interface DiagramFile {
  filename: string
  size: number | null
  item_name: string | null
  ext: string | null
  is_preferred: boolean | null
  so_folder_name: string
}
interface DiagramGroup { item_name: string | null; files: DiagramFile[] }

export async function GET(request: NextRequest) {
  const g = await guardAuth()
  if (!g.ok) return g.res

  const so = (request.nextUrl.searchParams.get('so') ?? '').trim().toUpperCase()
  if (!so || so.length > 40) {
    return NextResponse.json({ success: false, error: 'so 參數錯誤' }, { status: 400 })
  }

  const secret = process.env.ARGO_SSO_SECRET
  const argoBase = (process.env.ARGO_BASE_URL || '').replace(/\/+$/, '')
  if (!secret || !argoBase) {
    return NextResponse.json({ success: false, error: '尚未設定 ARGO_SSO_SECRET / ARGO_BASE_URL' }, { status: 500 })
  }

  try {
    // 簽短期 SSO 票證（同 /api/argo/launch 的格式，argo 端 _verify_sso_ticket 驗）
    const now = Math.floor(Date.now() / 1000)
    const payloadB64 = b64url(Buffer.from(JSON.stringify({
      sub: g.member.email,
      name: g.member.realName ?? '',
      iat: now,
      exp: now + 60,
    }), 'utf8'))
    const sig = b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest())

    const ssoRes = await fetch(`${argoBase}/api/auth/sso`, {
      method: 'POST',
      // Cloudflare 的 bot 防護會擋非瀏覽器 UA（Python urllib 實測 403），server-to-server 也要帶
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (EIP server)' },
      body: JSON.stringify({ ticket: `${payloadB64}.${sig}` }),
      cache: 'no-store',
    })
    const sso = (await ssoRes.json().catch(() => ({}))) as { token?: string; error?: string }
    if (!ssoRes.ok || !sso.token) {
      return NextResponse.json(
        { success: false, error: `ARGO 登入失敗：${sso.error || `HTTP ${ssoRes.status}`}` }, { status: 502 })
    }

    const listRes = await fetch(
      `${argoBase}/api/nas/diagrams?order_id=${encodeURIComponent(so)}`,
      { headers: { 'X-App-Token': sso.token, 'User-Agent': 'Mozilla/5.0 (EIP server)' }, cache: 'no-store' })
    const list = (await listRes.json().catch(() => ({}))) as
      { ok?: boolean; groups?: DiagramGroup[]; total?: number; detail?: string }
    if (!listRes.ok || !list.ok) {
      return NextResponse.json(
        { success: false, error: `示意圖查詢失敗：${list.detail || `HTTP ${listRes.status}`}` }, { status: 502 })
    }

    // token 交給瀏覽器組 <img> 縮圖網址——與「ARGO 外掛區」postMessage token 給 iframe 是同一信任模式
    return NextResponse.json({
      success: true,
      so,
      argoBase,
      token: sso.token,
      groups: list.groups ?? [],
      total: list.total ?? 0,
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `無法連線 ARGO：${e instanceof Error ? e.message : '未知錯誤'}` }, { status: 502 })
  }
}
