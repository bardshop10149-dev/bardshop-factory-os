'use client'

import { useEffect, useRef } from 'react'

/**
 * Session 自動續期（掛在 root layout，所有頁面生效）。
 *
 * 呼叫時機：進頁面、分頁回到前景（含電腦喚醒）、每 10 分鐘一次。
 * /api/auth/refresh 在 access token 剩餘 >15 分鐘時是 no-op，
 * 所以高頻呼叫成本極低；token 快到期時才真正輪替續期。
 * 失敗一律靜默（未登入頁面 401 是正常情況；真失效時由原本流程導回登入）。
 */
const INTERVAL_MS = 10 * 60 * 1000

export default function SessionKeeper() {
  const inflight = useRef(false)

  useEffect(() => {
    const ping = () => {
      if (inflight.current) return
      // 注意：不能以可讀 cookie 判斷是否登入——bardshop-role 與 token 同時到期，
      // 「分頁睡醒、token 已過期」正是最需要續期的時刻（refresh cookie 是 httpOnly 讀不到）。
      // 未登入時這只是一次極輕的 401，可接受。
      inflight.current = true
      fetch('/api/auth/refresh', { method: 'POST' })
        .catch(() => {})
        .finally(() => { inflight.current = false })
    }

    ping()
    const timer = setInterval(ping, INTERVAL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') ping() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return null
}
