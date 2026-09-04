import { NextRequest, NextResponse } from 'next/server'
import { syncWipRecords } from '@/lib/saraSync'

// 定時同步塔台報工紀錄（/data/wip → sara_wip_records），取代原本人工匯出 CSV 再匯入的流程。
// 塔台 2026-08-31 確認報工紀錄的正確端點是 /data/wip（分頁游標 after_id，全量約 4 萬筆、50 秒內完成）。
//
// 觸發方式與驗證：跟現有 /api/cron/* 一致——Vercel Cron 以 GET 呼叫，
// 自動帶 `Authorization: Bearer <CRON_SECRET>`；也接受 POST + WEBHOOK_SECRET 供手動測試。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

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
    const result = await syncWipRecords()
    return NextResponse.json({
      success: true,
      count: result.count,
      elapsedMs: Date.now() - started,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg, elapsedMs: Date.now() - started }, { status: 500 })
  }
}
