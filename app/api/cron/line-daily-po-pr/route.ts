import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { pushLineTextToGroups } from '@/lib/lineNotify'

// 每日採購/請購單彙總 LINE 通知：把當天出單表上的常平採購單號（POC）與委外請購單號（MPO/POO）
// 彙整成一則訊息，發到採購單位的 LINE 群組。排程每天 18:00 台北時間（自動開單 17:01、
// SARA 工序轉換 17:05 之後）。當天沒有任何單號時不發送（節省 LINE 訊息額度）。
//
// 帳號與群組設定：為了不佔用主帳號的免費推播額度（每月 200 則、異常單通知在用），
// 這條通知走「專用的第二個 LINE 官方帳號」——免費額度是每個官方帳號各自獨立計算，
// 每日一則彙總（月用量約 30 則）用專屬帳號綽綽有餘、完全免費。需設定環境變數：
//   LINE_PURCHASING_CHANNEL_TOKEN  = 採購通知專用官方帳號的 channel access token
//   LINE_PURCHASING_CHANNEL_SECRET = 同帳號的 channel secret（供 line-events webhook 驗簽）
//   LINE_PURCHASING_GROUP_ID       = 採購群組 ID（可逗號分隔多個）
// 取得群組 ID：把新機器人邀進目標群組，/api/webhook/line-events 會在 log 記錄 groupId
// （新帳號的 Webhook URL 設成同一支 /api/webhook/line-events 即可）。
//
// 觸發方式與驗證：跟現有 /api/cron/* 一致——Vercel Cron 以 GET 呼叫帶 CRON_SECRET；
// 也接受 POST + WEBHOOK_SECRET 供手動測試。?dry=1 只回傳訊息內容不實際發送（測試用）；
// ?date=YYYY-MM-DD 可指定日期補發。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  return run(request)
}
export async function POST(request: NextRequest) {
  return run(request)
}

function taipeiTodayStr(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

async function run(request: NextRequest) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  const authorized = !!bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))
  if (!authorized) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const dateParam = request.nextUrl.searchParams.get('date')
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : taipeiTodayStr()
    const dry = request.nextUrl.searchParams.get('dry') === '1'

    const supabase = getSupabaseAdminClient()
    const { data: sheet, error } = await supabase
      .from('daily_order_sheets').select('rows').eq('sheet_date', date).maybeSingle()
    if (error) throw new Error(error.message)
    const rows = Array.isArray(sheet?.rows) ? (sheet!.rows as Record<string, unknown>[]) : []

    // 彙整：單號 → 涵蓋的項數（同一張採購/請購單常涵蓋多筆序號）
    const poMap = new Map<string, number>()   // 常平採購單（POC）
    const prMap = new Map<string, number>()   // 委外請購單（MPO/POO）
    for (const r of rows) {
      const factory = String(r.factory ?? '')
      if (factory === 'C') {
        const po = String(r.po_number ?? '').trim().toUpperCase()
        if (po) poMap.set(po, (poMap.get(po) ?? 0) + 1)
      } else if (factory === 'O') {
        const pr = String(r.pr_number ?? '').trim().toUpperCase()
        if (pr) prMap.set(pr, (prMap.get(pr) ?? 0) + 1)
      }
    }

    if (poMap.size === 0 && prMap.size === 0) {
      return NextResponse.json({ success: true, date, sent: false, reason: '當日出單表沒有任何採購/請購單號，不發送' })
    }

    const lines: string[] = [`📦 【每日採購/請購單彙總】${date}`, '']
    if (poMap.size > 0) {
      lines.push(`🟠 常平採購單（${poMap.size} 張）：`)
      for (const [po, count] of [...poMap.entries()].sort()) lines.push(`・${po}（${count} 項）`)
      lines.push('')
    }
    if (prMap.size > 0) {
      lines.push(`🟣 委外請購單（${prMap.size} 張）：`)
      for (const [pr, count] of [...prMap.entries()].sort()) lines.push(`・${pr}（${count} 項）`)
      lines.push('')
    }
    lines.push('（資料來源：當日出單表，系統自動發送）')
    const message = lines.join('\n')

    if (dry) {
      return NextResponse.json({ success: true, date, dry: true, message, poCount: poMap.size, prCount: prMap.size })
    }

    const groupIds = (process.env.LINE_PURCHASING_GROUP_ID || '').split(',').map(s => s.trim()).filter(Boolean)
    const purchasingToken = process.env.LINE_PURCHASING_CHANNEL_TOKEN || ''
    if (groupIds.length === 0 || !purchasingToken) {
      return NextResponse.json({
        success: false,
        error: '未設定採購通知專用帳號（LINE_PURCHASING_CHANNEL_TOKEN / LINE_PURCHASING_GROUP_ID），請依註解說明建立專用官方帳號並設定環境變數',
        message,
      }, { status: 500 })
    }

    const results = await pushLineTextToGroups(groupIds, message, purchasingToken)
    const failed = results.filter(r => !r.ok)
    return NextResponse.json({
      success: failed.length === 0,
      date, sent: true,
      groups: results,
      poCount: poMap.size, prCount: prMap.size,
      ...(failed.length > 0 ? { error: `部分群組推播失敗（${failed.length}/${results.length}）` } : {}),
    }, { status: failed.length === 0 ? 200 : 502 })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
