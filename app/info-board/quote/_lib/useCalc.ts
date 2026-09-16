'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalcRequest, CalcResponse } from '@/lib/quote/api'

/**
 * 試算 hook（設計書 §12.7 即時重算邊界）：
 *   - 150ms debounce：業務連續打字時不會每個鍵都打 API。
 *   - 遞增 requestId：慢的舊回應晚到也丟掉，畫面永遠是最後一次輸入的結果。
 *   - >200ms 才顯示進度：快的回應不閃進度線。
 *   - 錯誤保留上次結果：只標 stale ＋ 錯誤訊息，數字不清空。
 *   - request 為 null（缺項）→ 結果清空、顯示「—」。
 */

export type CalcErrorKind = 'network' | 'auth' | 'server'

export interface CalcState {
  result: CalcResponse | null
  /** 對應 result 的 request（避免 result 與畫面輸入錯位） */
  resultFor: CalcRequest | null
  /** 有錯誤時保留上次結果並標 stale */
  stale: boolean
  error: { kind: CalcErrorKind; message: string; code?: string } | null
  /** API >200ms 才為 true */
  slow: boolean
  /** 有請求在飛行中（狀態列「○ 計算中」） */
  pending: boolean
  lastCalcAt: Date | null
  retry: () => void
}

const DEBOUNCE_MS = 150
const SLOW_MS = 200

export function useCalc(request: CalcRequest | null): CalcState {
  const [result, setResult] = useState<CalcResponse | null>(null)
  const [resultFor, setResultFor] = useState<CalcRequest | null>(null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<CalcState['error']>(null)
  const [slow, setSlow] = useState(false)
  const [pending, setPending] = useState(false)
  const [lastCalcAt, setLastCalcAt] = useState<Date | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  const reqIdRef = useRef(0)
  // 錯誤時要知道「有沒有上次結果」才決定 stale；用 ref 避免閉包吃到舊 state
  const resultRef = useRef<CalcResponse | null>(null)
  resultRef.current = result

  const retry = useCallback(() => setRetryTick((t) => t + 1), [])

  // 用 JSON 當依賴：request 物件每次 render 都是新的，但內容一樣就不重算
  const requestKey = request ? JSON.stringify(request) : ''

  useEffect(() => {
    if (!request) {
      reqIdRef.current += 1
      setResult(null)
      setResultFor(null)
      setStale(false)
      setError(null)
      setSlow(false)
      setPending(false)
      return
    }

    const myId = ++reqIdRef.current
    const controller = new AbortController()
    let slowTimer: ReturnType<typeof setTimeout> | null = null

    const debounce = setTimeout(async () => {
      if (myId !== reqIdRef.current) return
      setPending(true)
      slowTimer = setTimeout(() => {
        if (myId === reqIdRef.current) setSlow(true)
      }, SLOW_MS)

      try {
        const res = await fetch('/api/quote/calc', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        })
        if (myId !== reqIdRef.current) return

        let body: unknown = null
        try {
          body = await res.json()
        } catch {
          body = null
        }
        if (myId !== reqIdRef.current) return

        if (res.status === 401 || res.status === 403) {
          setError({ kind: 'auth', message: '沒有報價計算機權限', code: String(res.status) })
          setStale(resultRef.current !== null)
          return
        }

        const ok = typeof body === 'object' && body !== null && (body as { success?: boolean }).success === true
        if (!res.ok || !ok) {
          const msg =
            typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
              ? (body as { error: string }).error
              : '費率服務暫時無法連線'
          setError({ kind: 'server', message: msg, code: String(res.status) })
          setStale(resultRef.current !== null)
          return
        }

        const data = body as { success: true } & CalcResponse
        setResult(data)
        setResultFor(request)
        setStale(false)
        setError(null)
        setLastCalcAt(new Date())
      } catch (err) {
        if (controller.signal.aborted || myId !== reqIdRef.current) return
        setError({ kind: 'network', message: '費率服務暫時無法連線', code: err instanceof Error ? err.name : undefined })
        setStale(resultRef.current !== null)
      } finally {
        if (slowTimer) clearTimeout(slowTimer)
        if (myId === reqIdRef.current) {
          setSlow(false)
          setPending(false)
        }
      }
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(debounce)
      if (slowTimer) clearTimeout(slowTimer)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, retryTick])

  return { result, resultFor, stale, error, slow, pending, lastCalcAt, retry }
}
