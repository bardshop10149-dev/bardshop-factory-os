import crypto from 'crypto'

/**
 * 驗證 LINE Webhook 的 `x-line-signature`。
 * LINE 以 channel secret 對「原始請求 body」做 HMAC-SHA256,再 base64。
 * 必須使用原始字串(非 JSON.parse 後重組)計算,且以 timing-safe 方式比對。
 *
 * 回傳 false 的情況:未設定 channel secret、缺 signature、長度不符、比對失敗。
 */
export function verifyLineSignature(
  rawBody: string,
  signature: string | null | undefined,
  channelSecret: string | undefined,
): boolean {
  if (!channelSecret || !signature) return false

  const expected = crypto
    .createHmac('sha256', channelSecret)
    .update(rawBody)
    .digest('base64')

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
