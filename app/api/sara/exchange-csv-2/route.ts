import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import {
  LAST_PULLED_KEY_2,
  checkApiKeyAgainst,
  readBufferRows,
  recordPull,
  rowsToObjects,
} from '@/lib/sara/exchangeCsv'

export const dynamic = 'force-dynamic'

/**
 * 交換區第二支對外端口（2026-09-15 新增）
 *
 * 跟 /api/sara/exchange-csv 回傳「完全相同」的資料——兩支讀的是同一份
 * app_settings.sara_csv_buffer，欄位與 JSON 格式共用 lib/sara/exchangeCsv.ts。
 *
 * 與塔台那支的三點差異，都是為了讓兩家互不干擾：
 *   1. 自己的 API Key（SARA_EXCHANGE_API_KEY_2）；未設定時退回吃主 Key，
 *      這樣環境變數還沒填就能先串測，但填了之後就能單獨換發／停用這一家。
 *   2. 拉取時間記在 sara_csv_last_pulled_at_2，不覆蓋塔台那一格——
 *      17:45 的 sara-buffer-check 靠塔台那一格判斷塔台是否斷線。
 *   3. 唯讀：不支援 mark_consumed，永遠不清空 buffer。buffer 是共用的，
 *      這一家清掉塔台就拉不到了，所以清空只能由塔台或管理端執行。
 *
 * GET /api/sara/exchange-csv-2
 *   Header: Authorization: Bearer <SARA_EXCHANGE_API_KEY_2>（或 ?api_key=）
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const authorized = checkApiKeyAgainst(
    request.headers.get('authorization'),
    searchParams.get('api_key'),
    [process.env.SARA_EXCHANGE_API_KEY_2, process.env.SARA_EXCHANGE_API_KEY],
  )
  if (!authorized) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: invalid or missing API key' },
      { status: 401 }
    )
  }

  try {
    const supabase = getSupabaseAdminClient()
    const rows = await readBufferRows(supabase)

    const fetchedAt = new Date().toISOString()
    await recordPull(supabase, LAST_PULLED_KEY_2, fetchedAt)

    return NextResponse.json({
      success: true,
      count: rows.length,
      fetched_at: fetchedAt,
      // 明示這支不吃 mark_consumed，對方若照抄塔台的網址也不會誤以為資料已被消化
      mark_consumed_supported: false,
      data: rowsToObjects(rows),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
