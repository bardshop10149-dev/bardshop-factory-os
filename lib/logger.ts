type LogPayload = {
  actionType: string
  target: string
  module?: string
  details?: string
  metadata?: Record<string, unknown>
}

/**
 * 系統操作日誌（前端呼叫端）。
 *
 * 只把「做了什麼」POST 給 /api/system-logs，操作者身分由伺服器端 guardAuth 認定——
 * 以前這裡用 anon key 直讀 members + 直寫 system_logs，而且因為瀏覽器沒有 Supabase
 * session，每一筆的操作者都是 "Unknown"。
 * 日誌失敗不應影響主要操作，所以一律吞掉錯誤只印 console。
 */
export const logSystemAction = async (
  actionTypeOrPayload: string | LogPayload,
  target?: string,
  details: string = '',
  metadata: Record<string, unknown> = {}
) => {
  try {
    const payload: LogPayload =
      typeof actionTypeOrPayload === 'string'
        ? {
            actionType: actionTypeOrPayload,
            target: target || '-',
            details,
            metadata,
          }
        : actionTypeOrPayload

    const res = await fetch('/api/system-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string }
      console.error('日誌寫入失敗:', j.error || `HTTP ${res.status}`)
    }
  } catch (err) {
    console.error('Logger Error:', err)
  }
}
