import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, describeError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import { getSoSketches, normalizeSoParam } from '@/lib/packaging/sketches'
import type { SketchResponse } from '@/lib/packaging/types'

export const dynamic = 'force-dynamic'

// 包裝專區：訂單示意圖（唯讀）
//
// GET ?so=SO單號[&fresh=1]  → SketchResponse：該 SO 各品項行的示意圖網址（依項次排序；無圖的行 images=[]）
//
// 網址一律由 lib/packaging/sketches.ts 的 resolveSketchUrl() 產出（之後改短期簽名網址只動那裡），
// 前端直接用回傳的 url，不可自行拼接 Storage 路徑。
// 權限：packaging（唯讀）或 packaging_admin（編輯含唯讀），admin 自動通過（規格 §7.2 / §8 guardPackaging('read')）。

export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  const { isAdmin, permissions } = guard.member
  if (!isAdmin && !permissions.includes('packaging') && !permissions.includes('packaging_admin')) {
    return NextResponse.json({ success: false, error: '需要權限：packaging' } satisfies SketchResponse, { status: 403 })
  }

  const sp = request.nextUrl.searchParams
  const so = normalizeSoParam(sp.get('so'))
  if (!so) {
    return NextResponse.json({ success: false, error: '請提供正確的 SO 單號' } satisfies SketchResponse, { status: 400 })
  }

  try {
    const supabase = getSupabaseAdminClient()
    const lines = await getSoSketches(supabase, so, { fresh: sp.get('fresh') === '1' })
    const body: SketchResponse = { success: true, so, lines }
    // 之後會是短期簽名網址，瀏覽器／CDN 都不可快取
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[packaging/sketches]', so, e)
    return NextResponse.json({ success: false, error: describeError(e) } satisfies SketchResponse, { status: 500 })
  }
}
