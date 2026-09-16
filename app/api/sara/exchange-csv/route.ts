import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import {
  BUFFER_KEY,
  LAST_PULLED_KEY,
  LAST_PULLED_KEY_2,
  checkApiKeyAgainst,
  readBufferRows,
  recordPull,
  rowsToObjects,
} from '@/lib/sara/exchangeCsv'

export const dynamic = 'force-dynamic'

// 塔台（SARA）專用端口。欄位定義與 buffer 存取共用 lib/sara/exchangeCsv.ts，
// 第二家取用方走 /api/sara/exchange-csv-2（同一份 buffer）。
//
// ⚠️ 兩支對外端點一律唯讀，任何外部呼叫都不能清空交換區。
// 交換區是塔台看板的「全量來源」——塔台每次拉走整份內容、不會清除我方資料，
// 所以交換區必須永遠保有完整的歷史品項；一旦被清空，塔台下一次拉取就會把看板
// 覆蓋成只剩當下那幾筆。2026-09-15 就是這樣出事的：有人帶 mark_consumed=true
// 來拉把交換區清空，當天 18:00 塔台只拉到 62 張工單，原本的 495 張全部從看板消失。
// 清空只保留給管理端（下方 DELETE，頁面上有二次確認），對外端點不提供。
const SETTINGS_KEY = BUFFER_KEY

function checkApiKey(request: NextRequest): boolean {
  return checkApiKeyAgainst(
    request.headers.get('authorization'),
    new URL(request.url).searchParams.get('api_key'),
    [process.env.SARA_EXCHANGE_API_KEY],
  )
}

// GET — 塔台 API Key 拉取（唯讀，回傳 JSON），或管理端查詢（回傳 JSON rows）
export async function GET(request: NextRequest) {
  const isSaraCall = checkApiKey(request)

  if (!isSaraCall) {
    // 管理端需要登入
    const guard = await guardAuth()
    if (!guard.ok) return guard.res
  }

  try {
    const supabase = getSupabaseAdminClient()
    const rows = await readBufferRows(supabase)

    if (isSaraCall) {
      // 塔台端每次成功呼叫都記錄「最後拉取時間」，跟 buffer 本身的 updated_at
      // 分開存，才不會被管理端的上傳/清空操作洗掉。
      const fetchedAt = new Date().toISOString()
      await recordPull(supabase, LAST_PULLED_KEY, fetchedAt)

      // 塔台呼叫：回傳 JSON { success, count, fetched_at, data: [...] }
      return NextResponse.json({
        success: true,
        count: rows.length,
        fetched_at: fetchedAt,
        // 2026-09-16 起本端點唯讀：mark_consumed 不再受理，拉取永遠不會清空 buffer
        mark_consumed_supported: false,
        data: rowsToObjects(rows),
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // 管理端：回傳 JSON，附上各取用方最後一次成功拉取的時間
    const { data: pulls } = await supabase
      .from('app_settings').select('key,value').in('key', [LAST_PULLED_KEY, LAST_PULLED_KEY_2])
    const pullAt = (key: string): string | null => {
      const v = pulls?.find(p => p.key === key)?.value
      return typeof v === 'string' ? v : null
    }
    return NextResponse.json({
      success: true,
      rows,
      count: rows.length,
      last_pulled_at: pullAt(LAST_PULLED_KEY),
      last_pulled_at_2: pullAt(LAST_PULLED_KEY_2),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

// POST — append or replace rows（管理端）
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { rows: string[][]; append?: boolean }
    const supabase = getSupabaseAdminClient()
    let finalRows: string[][]
    if (body.append) {
      const existing = await readBufferRows(supabase)
      finalRows = [...existing, ...body.rows]
    } else {
      finalRows = body.rows
    }
    const { error } = await supabase.from('app_settings').upsert(
      { key: SETTINGS_KEY, value: finalRows, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
    if (error) throw error
    return NextResponse.json({ success: true, count: finalRows.length })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

// DELETE — clear buffer（管理端）
export async function DELETE() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from('app_settings').upsert(
      { key: SETTINGS_KEY, value: [], updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
