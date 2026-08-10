import { NextResponse } from 'next/server'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  const key = process.env.SARA_EXCHANGE_API_KEY ?? null
  return NextResponse.json({ key }, { headers: { 'Cache-Control': 'no-store' } })
}
