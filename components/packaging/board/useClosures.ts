'use client'

// D110 結案的前端狀態（hook）：本地「已結案」記號、結案池清單、正式工作台的結案佇列。
// 規則（為什麼這樣做）寫在純函式檔 closureLocal.ts；這裡只把它們接上 React 與 API。
//
// 三個 hook：
//   useClosedMarks   記號（pending／confirmed）。工作台與模擬區各用一份；模擬區的那一份在 ai/useSim.ts 裡。
//   useClosureList   結案池清單（GET /api/packaging/closures，近 30 天）＋今天筆數；兩邊共用。
//   useClosureQueue  正式工作台的結案佇列（一次送一個、暫時性失敗重試）。
//                    模擬區不用這個：結案會讓模擬區 version +1，必須跟模擬區自己的操作排在同一條佇列（見 useSim）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Closure } from '@/lib/packaging/scheduleTypes'
import { fetchClosures, postClosure } from './boardApi'
import {
  NO_MARKS,
  clearMark,
  closeRequestOf,
  closureKey,
  createClosureRunner,
  pruneMarks,
  setMark,
  todayClosedCount,
  upsertClosure,
  type ClosableBoard,
  type ClosedMark,
  type ClosedMarks,
  type ClosedOutcome,
  type ClosureIntent,
  type ClosureRunner,
} from './closureLocal'

// ─────────────────────────────────────────────────────────────────────
// 記號
// ─────────────────────────────────────────────────────────────────────

export interface ClosedMarksApi {
  /** 目前的記號（畫面用它濾卡：hideClosedLines(data, marks)） */
  marks: ClosedMarks
  has: (soLineKey: string) => boolean
  mark: (soLineKey: string, m: ClosedMark) => void
  clear: (soLineKey: string) => void
  /** 伺服器資料已不含該行 → confirmed 的記號拿掉 */
  prune: (body: ClosableBoard) => void
}

export function useClosedMarks(): ClosedMarksApi {
  const [marks, setMarks] = useState<ClosedMarks>(NO_MARKS)
  // ref 才是「現在」的值：佇列在同一個事件裡連續改記號時，state 還沒重畫
  const ref = useRef<ClosedMarks>(NO_MARKS)
  const update = useCallback((fn: (m: ClosedMarks) => ClosedMarks) => {
    const next = fn(ref.current)
    if (next === ref.current) return
    ref.current = next
    setMarks(next)
  }, [])
  const has = useCallback((k: string) => ref.current.has(closureKey(k)), [])
  const mark = useCallback((k: string, m: ClosedMark) => update(cur => setMark(cur, k, m)), [update])
  const clear = useCallback((k: string) => update(cur => clearMark(cur, k)), [update])
  const prune = useCallback((body: ClosableBoard) => update(cur => pruneMarks(cur, body)), [update])
  return useMemo(() => ({ marks, has, mark, clear, prune }), [marks, has, mark, clear, prune])
}

// ─────────────────────────────────────────────────────────────────────
// 結案池清單
// ─────────────────────────────────────────────────────────────────────

export interface ClosureListApi {
  /** 近 30 天（含已復原的），最新在前；還沒載入過＝空陣列 */
  list: Closure[]
  /** 伺服器的台北今天（清單回應的 to）；還沒載入過＝null */
  today: string | null
  /** 今天結案、仍未復原的筆數（按鈕上的 N） */
  todayCount: number
  loading: boolean
  error: string | null
  loaded: boolean
  refresh: () => Promise<void>
  /** 新結案或剛復原的那一筆直接併進清單（不必為了一筆再抓整份） */
  upsert: (c: Closure) => void
}

export function useClosureList(enabled: boolean): ClosureListApi {
  const [list, setList] = useState<Closure[]>([])
  const [today, setToday] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  /** 本機併入的紀錄（seq 遞增）：清單請求「發出之後」才併入的，回應回來時要再併一次，否則會被舊清單蓋掉 */
  const localRef = useRef<{ seq: number; item: Closure }[]>([])
  const seqRef = useRef(0)
  const loadingRef = useRef(false)
  const againRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (loadingRef.current) { againRef.current = true; return }
    loadingRef.current = true
    setLoading(true)
    try {
      const issuedAt = seqRef.current
      const r = await fetchClosures()
      if (r.json && r.json.success) {
        let next = r.json.closures
        for (const l of localRef.current) if (l.seq > issuedAt) next = upsertClosure(next, l.item)
        localRef.current = localRef.current.filter(l => l.seq > issuedAt)
        setList(next)
        setToday(r.json.to)
        setError(null)
        setLoaded(true)
      } else {
        setError(r.error ?? '讀取結案池失敗')
      }
    } finally {
      loadingRef.current = false
      setLoading(false)
      if (againRef.current) {
        againRef.current = false
        void refresh()
      }
    }
  }, [])

  const upsert = useCallback((c: Closure) => {
    localRef.current.push({ seq: ++seqRef.current, item: c })
    setList(cur => upsertClosure(cur, c))
  }, [])

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  const todayCount = useMemo(() => (today ? todayClosedCount(list, today) : 0), [list, today])
  return useMemo(
    () => ({ list, today, todayCount, loading, error, loaded, refresh, upsert }),
    [list, today, todayCount, loading, error, loaded, refresh, upsert],
  )
}

// ─────────────────────────────────────────────────────────────────────
// 正式工作台的結案佇列
// ─────────────────────────────────────────────────────────────────────

export interface ClosureQueueHost {
  /** 結案成立（含 409 本來就結案了、含附帶清理未完成的警告） */
  onClosed: (intent: ClosureIntent, outcome: ClosedOutcome) => void
  /** 結案失敗：記號已拿掉、卡片已回原位 */
  onFailed: (intent: ClosureIntent, message: string) => void
  onUnauthorized: () => void
}

/**
 * 佇列本體是 closureLocal.createClosureRunner（不依賴 React）；這裡只負責：
 * - 整個元件生命週期用同一個 runner：第一次按結案時才建立、放在 ref（不在 render 期間建立——
 *   runner 的回呼會讀 hostRef，React 規定 ref 只能在事件處理或 effect 裡讀）
 * - host 的回呼每次重畫都是新的函式 → 經由 ref 取最新的，runner 不必重建（重建會丟掉排隊中的結案）
 * - 元件卸載後不取消：已排入的結案照樣送完（主管按了確定就是要結；送出只靠 fetch，不靠元件還在）
 */
export function useClosureQueue(marks: ClosedMarksApi, host: ClosureQueueHost) {
  const [pending, setPending] = useState(0)
  const hostRef = useRef(host)
  useEffect(() => { hostRef.current = host })
  const runnerRef = useRef<ClosureRunner | null>(null)
  const { has, mark, clear } = marks

  /** 排入結案：立刻記 pending（卡片消失）、背景依序送出。已在結案中／已結案的行不重複排（回 false） */
  const close = useCallback((intent: ClosureIntent): boolean => {
    runnerRef.current ??= createClosureRunner({
      send: i => postClosure(closeRequestOf(i)),
      has, mark, clear,
      onClosed: (i, o) => hostRef.current.onClosed(i, o),
      onFailed: (i, m) => hostRef.current.onFailed(i, m),
      onUnauthorized: () => hostRef.current.onUnauthorized(),
      onPending: setPending,
      schedule: (fn, ms) => { window.setTimeout(fn, ms) },
    })
    return runnerRef.current.close(intent)
  }, [has, mark, clear])

  // 還有結案沒送完就關分頁／重新整理：提示（同工作台操作佇列）
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if ((runnerRef.current?.pending() ?? 0) > 0) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [])

  return { close, pending }
}

// ─────────────────────────────────────────────────────────────────────
// 復原（結案池面板的「復原」；兩邊共用）
// ─────────────────────────────────────────────────────────────────────

export type RestoreCallResult =
  /** 復原成功：closure＝寫了 restored_* 的那一筆 */
  | { ok: true; closure: Closure }
  /** gone＝這一行已經沒有未復原的結案（別人剛復原過）：清單要重抓、畫面照樣要重新載入 */
  | { ok: false; gone: boolean; unauthorized: boolean; message: string }

/** 復原不是樂觀更新：要等伺服器說好才動畫面（復原後卡片的位置、數量要由伺服器重算，前端猜不出來） */
export async function restoreClosureCall(c: Pick<Closure, 'soLineKey'>): Promise<RestoreCallResult> {
  const r = await postClosure({ action: 'restore', soLineKey: c.soLineKey })
  if (r.json && r.json.success) return { ok: true, closure: r.json.closure }
  const code = r.json && !r.json.success ? r.json.code : null
  return {
    ok: false,
    gone: r.status === 404 && code === 'not_found',
    unauthorized: r.status === 401,
    message: r.status === 403 ? '復原需要包裝主管權限（packaging_admin）' : (r.error ?? '復原失敗'),
  }
}
