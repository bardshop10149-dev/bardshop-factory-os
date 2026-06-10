import { NextRequest, NextResponse } from 'next/server'

const LINE_CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || ''
const LINE_GROUP_IDS = (process.env.LINE_GROUP_ID || '').split(',').map(id => id.trim()).filter(Boolean)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // 1. 驗證 Supabase Webhook 來源（fail-closed：未設定 secret 一律拒絕，
    //    避免任何人偽造 record 觸發 LINE 推播）
    if (!WEBHOOK_SECRET) {
      console.error('[line-notify] WEBHOOK_SECRET 未設定，拒絕請求')
      return NextResponse.json({ error: 'Webhook 未正確設定' }, { status: 503 })
    }
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${WEBHOOK_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!LINE_CHANNEL_TOKEN || LINE_GROUP_IDS.length === 0) {
      return NextResponse.json({ error: 'LINE credentials not configured' }, { status: 500 })
    }

    const record = body.record
    const eventType = body.type // INSERT or UPDATE

    if (!record) {
      return NextResponse.json({ error: 'No record in payload' }, { status: 400 })
    }

    // 只在以下情況發送通知：
    // 1. INSERT（新增異常單）→ 一律通知
    // 2. UPDATE → 只在狀態變成 'confirmed'（已確認/已完成）時通知
    //    注意：Supabase webhook 的 old_record 預設不含完整欄位，
    //    所以不能用 old_record.status 判斷，改用 record.status 判斷
    if (eventType === 'UPDATE') {
      if (record.status !== 'confirmed') {
        return NextResponse.json({ ok: true, skipped: 'not a completion update' })
      }
    }

    // 2. 組裝 LINE 訊息
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })

    const statusText = record.status === 'pending' ? '🔴 待處理' : '🟢 已完成'

    const isUpdate = eventType === 'UPDATE'
    const title = isUpdate ? '✅ 【異常單處理完成】' : '🚨 【異常單通知】'

    const lines = [
      title,
      '',
      `📋 工單編號：${record.order_number || '-'}`,
      `🔢 品項編碼：${record.item_code || '-'}`,
      `📦 品名/名稱：${record.item_name || '-'}`,
      `⚠️ 異常原因：${record.reason || '-'}`,
      `🏷️ 分類：${record.qa_category || '-'}`,
      `🏢 回報部門：${record.qa_department || '-'}`,
      `👤 回報人員：${record.qa_reporter || '-'}`,
      `🏭 處理部門：${record.handler_department || '-'}`,
      `🔧 處理人員：${(record.handler_names || record.qa_handlers || []).join('、') || '-'}`,
      `📌 狀態：${statusText}`,
      `🕐 通知時間：${now}`,
    ]

    if (isUpdate && record.handler_record) {
      lines.splice(lines.length - 2, 0, `📝 處理紀錄：${record.handler_record}`)
    }

    const message = lines.join('\n')

    // 3. 推送到所有 LINE 群組
    const results = await Promise.allSettled(
      LINE_GROUP_IDS.map(async (groupId) => {
        const res = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${LINE_CHANNEL_TOKEN}`,
          },
          body: JSON.stringify({
            to: groupId,
            messages: [{ type: 'text', text: message }],
          }),
        })
        if (!res.ok) {
          const errorBody = await res.text()
          console.error(`LINE push failed for group ${groupId}: ${res.status} ${errorBody}`)
        } else {
          console.log(`LINE push OK for group ${groupId}`)
        }
        return { groupId, status: res.status }
      })
    )

    const failures = results.filter(r => r.status === 'rejected')
    if (failures.length > 0) {
      console.error('Some LINE pushes rejected:', failures)
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Webhook handler error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
