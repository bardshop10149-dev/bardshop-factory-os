import { NextResponse } from 'next/server'

const EXPIRED = '; Path=/; Max-Age=0; SameSite=Lax'
const EXPIRED_HTTPONLY = `${EXPIRED}; HttpOnly`

export async function POST() {
  const response = NextResponse.json({ ok: true })

  // 清除所有 bardshop-* cookies
  response.headers.append('Set-Cookie', `bardshop-token=${EXPIRED_HTTPONLY}`)
  response.headers.append('Set-Cookie', `bardshop-refresh=${EXPIRED_HTTPONLY}`)
  response.headers.append('Set-Cookie', `bardshop-role=${EXPIRED}`)
  response.headers.append('Set-Cookie', `bardshop-permissions=${EXPIRED}`)

  return response
}
