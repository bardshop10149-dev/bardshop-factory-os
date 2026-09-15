import { NextResponse } from 'next/server'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  const key = process.env.SARA_EXCHANGE_API_KEY ?? null
  // 第二支端口（/api/sara/exchange-csv-2）的專屬 Key；未設定時該端口會退回吃主 Key，
  // 這裡回 null 讓頁面把這件事講清楚。
  const key2 = process.env.SARA_EXCHANGE_API_KEY_2 ?? null
  return NextResponse.json({ key, key2 }, { headers: { 'Cache-Control': 'no-store' } })
}
