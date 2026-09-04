import { NextRequest, NextResponse } from 'next/server'
import { runAutoProcessGen } from '@/lib/sara/autoProcessGen'

// 每日排程：把當天出單表自動轉成 SARA 工序列寫入交換區（詳見 lib/sara/autoProcessGen.ts）。
// 每天 17:05（台北時間）執行，排在自動開單（17:01）之後跑，讓當天轉單完成的列都能帶到正確的製令/採購/請購單號。
//
// ⚠️ 硬性截止時間：塔台每天固定 18:00 主動來拉交換區（我方無法推送），18:00 之後才寫進去的
// 資料要等隔天才會被取走，現場當天會看到「塔臺無資料」而無法作業。因此本排程刻意跑兩次：
//   17:05（主要）與 17:40（保險），本身具冪等性（比對送出台帳與交換區現有內容，不會重複寫入）。
// 兩次的用意：任何一次因部署、暫時性錯誤或排程異動而漏跑，另一次仍能在 18:00 前補上。
// （2026-09-02 事故：排程時間由 17:50 改為 17:05 的部署發生在 17:11——新時間已過、舊時間已移除，
//   當天兩邊都沒觸發，整日工序未送達塔台，隔天現場全面回報「塔臺無資料」。）
//
// 觸發方式與驗證：跟現有 /api/cron/* 一致——Vercel Cron 以 GET 呼叫，
// 自動帶 `Authorization: Bearer <CRON_SECRET>`；也接受 POST + WEBHOOK_SECRET 供手動測試。
// 可用 ?date=YYYY-MM-DD 手動指定日期（補跑）。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request: NextRequest) {
  return run(request)
}
export async function POST(request: NextRequest) {
  return run(request)
}

async function run(request: NextRequest) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  const authorized = !!bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))
  if (!authorized) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const dateParam = request.nextUrl.searchParams.get('date')
    // 指定日期 → 只跑那一天（人工補跑）；否則跑「今天＋前兩天」——
    // 前幾天出單、事後才補轉單的列能在後續的排程被撈到補送，
    // 對應日期的待處理清單也會重算自癒（已送過的由 ledger 擋掉，不會重複）。
    const dates = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? [dateParam]
      : [0, 1, 2].map(back => {
          const d = new Date(Date.now() + 8 * 3600 * 1000 - back * 86400 * 1000)
          return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
        })
    const results = []
    for (const date of dates) {
      results.push(await runAutoProcessGen(date))
    }
    return NextResponse.json({ success: true, results, elapsedMs: Date.now() - started })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg, elapsedMs: Date.now() - started }, { status: 500 })
  }
}
