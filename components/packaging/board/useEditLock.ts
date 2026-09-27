'use client'

// D53 編輯鎖（前端）：同一時間只有一人能編輯，其他人唯讀；5 分鐘無動作自動釋放；可「接手編輯」。
//
// 機制：
// - 按「開始編輯」才 acquire（不自動取得：admin 只是看也會佔住鎖，規格 §9.2-6）。
// - 取得後每 30 秒送 heartbeat；active＝這 30 秒內有沒有滑鼠／鍵盤／觸控操作。
//   只有 active=true 伺服器才延長 last_action_at，所以「開著分頁去吃飯」5 分鐘後鎖會自然釋放，不需要清鎖排程。
// - token 存 sessionStorage（每個分頁各自一份）：同一個人開兩個分頁，只有拿到 token 的那個分頁能寫。
// - 關分頁（pagehide）或 App 內切到別頁（元件卸載）都送 keepalive release；送不到也沒關係，5 分鐘後自然逾時。
// - 被接手：下一次心跳或寫入收到 lock_lost → 轉唯讀，由呼叫端清空 Undo 與佇列。

import { useCallback, useEffect, useRef, useState } from 'react'
import { LOCK_HEARTBEAT_MS, type LockState } from '@/lib/packaging/scheduleTypes'
import { beaconRelease, postLock } from './boardApi'

const TOKEN_KEY = 'packaging.schedule.lockToken.v1'

function readToken(): string | null {
  try { return window.sessionStorage.getItem(TOKEN_KEY) } catch { return null }
}
function writeToken(t: string | null) {
  try {
    if (t) window.sessionStorage.setItem(TOKEN_KEY, t)
    else window.sessionStorage.removeItem(TOKEN_KEY)
  } catch { /* 無痕模式寫不進去：只影響重新整理後能否續用 */ }
}

export type LockPhase =
  | 'none'       // 不持有（可能有人在編輯，也可能沒人）
  | 'mine'       // 自己持有
  | 'lost'       // 被接手（紅色橫幅，直到重新取得或關閉提示）
  | 'expired'    // 逾時釋放（5 分鐘無動作），可重新取得

export interface EditLockApi {
  lock: LockState | null
  phase: LockPhase
  token: string | null
  /** 送出請求用的 token（含重新整理前留下、尚待伺服器確認的） */
  getToken: () => string | null
  /** 伺服器時間 − 本機時間（毫秒），倒數顯示用 */
  offsetMs: number
  busy: boolean
  error: string | null
  /** 被接手時的接手者 */
  lostTo: { name: string; at: string | null } | null
  acquire: () => Promise<boolean>
  takeover: () => Promise<boolean>
  release: () => Promise<void>
  /** 「繼續編輯」：立刻送一次 active 心跳延長 5 分鐘 */
  touch: () => Promise<void>
  /**
   * 由工作台 GET／寫入回應帶進來的鎖狀態。reqToken＝發出那個請求時帶的 token：
   * 與目前 token 不同（例如按「開始編輯」之前就送出的輪詢）時只更新顯示、不據以判定被接手／逾時。
   */
  ingest: (lock: LockState, serverTime: string | null, reqToken: string | null) => void
  /** 寫入 API 回 lock_lost */
  markLost: (lock: LockState | null | undefined) => void
  /** 寫入 API 回 lock_required（逾時） */
  markExpired: (lock: LockState | null | undefined) => void
  clearError: () => void
}

export function useEditLock(opts: {
  /** 取得鎖（含接手）成功：呼叫端清空 Undo */
  onGained?: () => void
  /** 失去鎖（被接手、逾時、自己結束）：呼叫端清空 Undo 與佇列 */
  onLost?: (why: 'lost' | 'expired' | 'released') => void
}): EditLockApi {
  const [lock, setLock] = useState<LockState | null>(null)
  const [token, setTokenState] = useState<string | null>(null)
  const [phase, setPhase] = useState<LockPhase>('none')
  const [offsetMs, setOffsetMs] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lostTo, setLostTo] = useState<{ name: string; at: string | null } | null>(null)

  const tokenRef = useRef<string | null>(null)
  const phaseRef = useRef<LockPhase>('none')
  const activeRef = useRef(false)
  const cbRef = useRef(opts)
  useEffect(() => { cbRef.current = opts })

  const setToken = useCallback((t: string | null) => {
    tokenRef.current = t
    setTokenState(t)
    writeToken(t)
  }, [])
  const setPhaseBoth = useCallback((p: LockPhase) => {
    phaseRef.current = p
    setPhase(p)
  }, [])

  // 重新整理後：sessionStorage 裡若有 token，先拿來帶在第一次 GET board（x-packaging-lock），
  // 由伺服器的 isMine 判定是否仍有效（ingest）。用「第一次讀取時才載入」而不是 effect，確保工作台第一次請求就帶得到。
  const loadedRef = useRef(false)
  const getToken = useCallback((): string | null => {
    if (!loadedRef.current) {
      loadedRef.current = true
      if (!tokenRef.current) tokenRef.current = readToken()
    }
    return tokenRef.current
  }, [])

  const handleLost = useCallback((l: LockState | null | undefined) => {
    if (phaseRef.current !== 'mine') return
    setToken(null)
    setPhaseBoth('lost')
    if (l) setLock(l)
    setLostTo({ name: l?.holderName || l?.holderEmail || '其他主管', at: l?.acquiredAt ?? null })
    cbRef.current.onLost?.('lost')
  }, [setPhaseBoth, setToken])

  const handleExpired = useCallback((l: LockState | null | undefined) => {
    if (phaseRef.current !== 'mine') return
    setToken(null)
    setPhaseBoth('expired')
    if (l) setLock(l)
    cbRef.current.onLost?.('expired')
  }, [setPhaseBoth, setToken])

  const ingest = useCallback((l: LockState, serverTime: string | null, reqToken: string | null) => {
    const st = serverTime ? Date.parse(serverTime) : NaN
    if (Number.isFinite(st)) setOffsetMs(st - Date.now())
    const t = getToken()
    // 請求發出後 token 已換（剛取得／剛接手／剛釋放）：這份回應的 isMine 已過時，只在沒持有時拿來顯示
    if (reqToken !== t) {
      if (phaseRef.current !== 'mine') setLock(l)
      return
    }
    setLock(l)
    if (!t) return
    if (l.isMine) {
      if (phaseRef.current !== 'mine') {
        // 重新整理後以舊 token 續用（伺服器確認仍是本人持有）
        setTokenState(t)
        setPhaseBoth('mine')
      }
      return
    }
    if (phaseRef.current === 'mine') {
      if (l.held) handleLost(l)
      else handleExpired(l)
    } else {
      // 重新整理前的 token 已失效
      setToken(null)
    }
  }, [getToken, handleExpired, handleLost, setPhaseBoth, setToken])

  const acquireLike = useCallback(async (action: 'acquire' | 'takeover'): Promise<boolean> => {
    // 權限（packaging_admin）由伺服器判定；畫面只對 me.canEdit 的人顯示按鈕
    setBusy(true)
    setError(null)
    try {
      const r = await postLock({ action, token: getToken() })
      if (r.json?.success) {
        const tk = r.json.token ?? tokenRef.current
        setLock(r.json.lock)
        if (!tk) {
          setError('伺服器沒有回傳編輯權杖，請重新整理後再試')
          return false
        }
        setToken(tk)
        setPhaseBoth('mine')
        setLostTo(null)
        activeRef.current = true
        cbRef.current.onGained?.()
        return true
      }
      const j = r.json && !r.json.success ? r.json : null
      if (j?.lock) setLock(j.lock)
      if (j?.code === 'held_by_other') {
        const who = j.lock?.holderName || j.lock?.holderEmail || '其他主管'
        setError(`${who} 正在編輯中；如需修改請按「接手編輯」`)
      } else {
        setError(r.error ?? '取得編輯權失敗')
      }
      return false
    } finally {
      setBusy(false)
    }
  }, [getToken, setPhaseBoth, setToken])

  const acquire = useCallback(() => acquireLike('acquire'), [acquireLike])
  const takeover = useCallback(() => acquireLike('takeover'), [acquireLike])

  const release = useCallback(async () => {
    const t = tokenRef.current
    setBusy(true)
    try {
      if (t) {
        const r = await postLock({ action: 'release', token: t })
        if (r.json?.success) setLock(r.json.lock)
      }
    } finally {
      setToken(null)
      setPhaseBoth('none')
      setBusy(false)
      cbRef.current.onLost?.('released')
    }
  }, [setPhaseBoth, setToken])

  const beat = useCallback(async (active: boolean) => {
    const t = tokenRef.current
    if (!t || phaseRef.current !== 'mine') return
    const r = await postLock({ action: 'heartbeat', token: t, active })
    if (r.json?.success) {
      setLock(r.json.lock)
      return
    }
    const j = r.json && !r.json.success ? r.json : null
    if (j?.code === 'lock_lost') {
      if (j.lock?.held) handleLost(j.lock)
      else handleExpired(j.lock)
    }
    // 網路錯誤：不處理，下一次心跳再試；5 分鐘內都還有效
  }, [handleExpired, handleLost])

  const touch = useCallback(async () => {
    activeRef.current = false
    await beat(true)
  }, [beat])

  // 持有時：活動偵測＋每 30 秒心跳
  useEffect(() => {
    if (phase !== 'mine') return
    const mark = () => { activeRef.current = true }
    window.addEventListener('pointerdown', mark, true)
    window.addEventListener('keydown', mark, true)
    window.addEventListener('wheel', mark, { capture: true, passive: true })
    const id = window.setInterval(() => {
      const active = activeRef.current
      activeRef.current = false
      void beat(active)
    }, LOCK_HEARTBEAT_MS)
    return () => {
      window.removeEventListener('pointerdown', mark, true)
      window.removeEventListener('keydown', mark, true)
      window.removeEventListener('wheel', mark, { capture: true })
      window.clearInterval(id)
    }
  }, [phase, beat])

  // 關分頁：sendBeacon 釋放
  useEffect(() => {
    const onHide = () => {
      const t = tokenRef.current
      if (t && phaseRef.current === 'mine') {
        beaconRelease(t)
        writeToken(null)
      }
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      // App 內用 Next Link 切到別頁不會觸發 pagehide，只會卸載元件 → 這裡也要釋放，
      // 否則鎖會被佔住最多 5 分鐘、別人只能「接手」。代價：切回來要重按「開始編輯」（token 一併清掉）。
      // （開發模式 StrictMode 的「掛載→卸載→再掛載」發生在第一次掛載時，此時 phase 還是 'none'，不會誤放。）
      onHide()
    }
  }, [])

  return {
    lock,
    phase,
    token,
    getToken,
    offsetMs,
    busy,
    error,
    lostTo,
    acquire,
    takeover,
    release,
    touch,
    ingest,
    markLost: handleLost,
    markExpired: handleExpired,
    clearError: useCallback(() => setError(null), []),
  }
}
