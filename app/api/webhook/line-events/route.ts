import { NextRequest, NextResponse } from 'next/server'
import { verifyLineSignature } from '@/lib/lineSignature'

/**
 * 接收 LINE Webhook 事件（用於取得 Group ID）。
 * 已加上 LINE 簽章驗證（x-line-signature, HMAC-SHA256 + LINE_CHANNEL_SECRET），
 * 僅處理來自 LINE 平台的合法回呼，避免成為匿名 log/noise 注入點。
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-line-signature')
  // 支援多個官方帳號共用同一個 webhook（主帳號＝異常單通知；採購帳號＝每日採購/請購單彙總，
  // 為免費額度各自獨立而分開兩個 OA）——任一 channel secret 驗過即放行
  const ok = verifyLineSignature(rawBody, signature, process.env.LINE_CHANNEL_SECRET)
    || verifyLineSignature(rawBody, signature, process.env.LINE_PURCHASING_CHANNEL_SECRET)
  if (!ok) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  try {
    const body = JSON.parse(rawBody)
    const events = body.events || []
    for (const event of events) {
      if (event.source?.groupId) {
        console.log('LINE group id discovered:', event.source.groupId)
      }
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true })
  }
}
