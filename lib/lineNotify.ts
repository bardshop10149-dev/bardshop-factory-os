// LINE Messaging API 群組推播共用函式
// （原本只有 /api/webhook/line-notify 的異常單通知在用，抽出來供每日採購單彙總等排程共用）

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'

export interface LinePushResult {
  groupId: string
  ok: boolean
  status: number
  error?: string
}

/**
 * 推送文字訊息到多個 LINE 群組；回傳每個群組的結果，不丟例外（由呼叫端決定怎麼處理失敗）。
 * tokenOverride：指定用哪個官方帳號的 channel token 發送（免費額度是「每個官方帳號各自
 * 200 則/月」，用途不同的通知分開不同 OA 就能各自有獨立額度）；不指定時用主帳號。
 */
export async function pushLineTextToGroups(groupIds: string[], text: string, tokenOverride?: string): Promise<LinePushResult[]> {
  const token = tokenOverride || process.env.LINE_CHANNEL_ACCESS_TOKEN || ''
  if (!token) {
    return groupIds.map(groupId => ({ groupId, ok: false, status: 0, error: '未設定 LINE channel access token' }))
  }
  const results = await Promise.allSettled(
    groupIds.map(async (groupId): Promise<LinePushResult> => {
      const res = await fetch(LINE_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text }] }),
      })
      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        return { groupId, ok: false, status: res.status, error: errBody.slice(0, 300) }
      }
      return { groupId, ok: true, status: res.status }
    })
  )
  return results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { groupId: groupIds[i], ok: false, status: 0, error: String(r.reason) }
  )
}
