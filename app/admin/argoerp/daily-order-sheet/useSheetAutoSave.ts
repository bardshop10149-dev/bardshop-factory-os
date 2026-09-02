'use client'

// 出單表自動儲存：把「改動 → 儲存」從使用者要記得按的動作，變成系統自動處理的背景行為。
//
// 設計要點：
// 1. 所有寫入都走 PATCH 的差異語法（updates/replace/add/remove），只送真正改動的列，
//    不再整份 rows 覆蓋——這是「別人（或自己的舊分頁）的操作把我的資料蓋掉」這類問題的
//    結構性解法（2026-09-01/02 連續兩起事故的共同成因）。
// 2. 進來的改動先累積在佇列裡，1 秒沒有新改動才送出（debounce），連續編輯不會打爆伺服器。
// 3. 送出中若又有新改動，會排進下一批，不會遺失也不會互相覆蓋。
// 4. 失敗不靜默：狀態轉為 error 並保留待送佇列，呼叫端顯示「重試」讓使用者一鍵重送。

import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface SheetDelta {
  updates?: Array<Record<string, unknown> & { row_key: string }>
  replace?: Array<{ match_row_key: string; row: Record<string, unknown> }>
  add?: Array<Record<string, unknown>>
  remove?: string[]
  raw_text?: string
}

const DEBOUNCE_MS = 1000

/**
 * 比較同一批列的前後版本，只取出真正變動的欄位，組成 updates/replace delta。
 * 給「比對／同步」這類會重算整個陣列的操作使用——它們照舊在本地算出完整的 next 陣列，
 * 但送到伺服器的只有實際變動的欄位，不會把沒動到的列一起覆蓋（避免蓋掉別人同時間的更新）。
 * row_key 有變動的列（例如廠區轉換）走 replace；其餘走欄位級 updates。
 */
export function diffRows(
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
): SheetDelta {
  const beforeByKey = new Map(before.map(r => [r.row_key as string, r]))
  const updates: Array<Record<string, unknown> & { row_key: string }> = []
  const replace: Array<{ match_row_key: string; row: Record<string, unknown> }> = []

  // before 與 after 同索引對應（這些操作都是 map() 產生的等長陣列）
  after.forEach((row, i) => {
    const prev = before[i]
    if (!prev) return
    const prevKey = prev.row_key as string
    const nextKey = row.row_key as string
    if (prevKey !== nextKey) {
      replace.push({ match_row_key: prevKey, row })
      return
    }
    const changed: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(prev), ...Object.keys(row)])
    for (const k of keys) {
      if (k === 'row_key') continue
      const a = prev[k]
      const b = row[k]
      if (a === b) continue
      // 物件/陣列欄位（如 sketch_urls、duplicate_alert_dates）以 JSON 比對
      if (a != null && b != null && typeof a === 'object' && typeof b === 'object') {
        if (JSON.stringify(a) === JSON.stringify(b)) continue
      }
      changed[k] = b === undefined ? null : b
    }
    if (Object.keys(changed).length > 0) updates.push({ row_key: nextKey, ...changed })
  })

  void beforeByKey
  return {
    ...(updates.length > 0 ? { updates } : {}),
    ...(replace.length > 0 ? { replace } : {}),
  }
}

/** 把多筆 delta 合併成一批（同 row_key 的欄位更新會疊加，後到的值覆蓋先到的） */
function mergeDeltas(queue: SheetDelta[]): SheetDelta {
  const updateMap = new Map<string, Record<string, unknown> & { row_key: string }>()
  const replaceMap = new Map<string, { match_row_key: string; row: Record<string, unknown> }>()
  const addMap = new Map<string, Record<string, unknown>>()
  const removeSet = new Set<string>()
  let rawText: string | undefined

  for (const d of queue) {
    for (const u of d.updates ?? []) {
      const prev = updateMap.get(u.row_key)
      updateMap.set(u.row_key, prev ? { ...prev, ...u } : { ...u })
    }
    for (const r of d.replace ?? []) replaceMap.set(r.match_row_key, r)
    for (const a of d.add ?? []) addMap.set(a.row_key as string, a)
    for (const k of d.remove ?? []) {
      removeSet.add(k)
      // 已排定刪除的列，先前排隊的欄位更新/新增就沒有意義了
      updateMap.delete(k)
      addMap.delete(k)
    }
    if (d.raw_text !== undefined) rawText = d.raw_text
  }

  return {
    ...(updateMap.size > 0 ? { updates: [...updateMap.values()] } : {}),
    ...(replaceMap.size > 0 ? { replace: [...replaceMap.values()] } : {}),
    ...(addMap.size > 0 ? { add: [...addMap.values()] } : {}),
    ...(removeSet.size > 0 ? { remove: [...removeSet] } : {}),
    ...(rawText !== undefined ? { raw_text: rawText } : {}),
  }
}

export function useSheetAutoSave(sheetDate: string) {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const queueRef = useRef<SheetDelta[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 讓 flush 讀得到最新日期，避免 callback 綁到舊的 sheetDate
  const dateRef = useRef(sheetDate)
  useEffect(() => { dateRef.current = sheetDate }, [sheetDate])

  const flush = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current) return false
    if (queueRef.current.length === 0) return true
    if (!dateRef.current) return false

    const batch = mergeDeltas(queueRef.current)
    queueRef.current = []
    inFlightRef.current = true
    setStatus('saving')
    setErrorMsg('')

    try {
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: dateRef.current, ...batch }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`)

      inFlightRef.current = false
      if (queueRef.current.length > 0) {
        // 送出期間又有新改動 → 立刻接著送下一批
        void flush()
        return true
      }
      setStatus('saved')
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => {
        setStatus(prev => (prev === 'saved' ? 'idle' : prev))
      }, 3000)
      return true
    } catch (e) {
      // 失敗的這批放回佇列最前面，讓使用者按重試時不會遺失
      queueRef.current = [batch, ...queueRef.current]
      inFlightRef.current = false
      setStatus('error')
      setErrorMsg(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [])

  /** 排入一筆改動；1 秒內沒有新改動就自動送出 */
  const queue = useCallback((delta: SheetDelta) => {
    queueRef.current.push(delta)
    setStatus(prev => (prev === 'saving' ? prev : 'pending'))
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void flush() }, DEBOUNCE_MS)
  }, [flush])

  /** 立即送出（換日期、離開頁面、使用者按重試時用） */
  const flushNow = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    return flush()
  }, [flush])

  // 切換日期前先把待存的改動送出，避免改動被留在上一個日期的佇列裡
  const prevDateRef = useRef(sheetDate)
  useEffect(() => {
    if (prevDateRef.current !== sheetDate) {
      const pending = queueRef.current.length > 0
      if (pending) {
        // 用上一個日期把佇列清乾淨
        const prevDate = prevDateRef.current
        const cur = dateRef.current
        dateRef.current = prevDate
        void flush().finally(() => { dateRef.current = cur })
      }
      prevDateRef.current = sheetDate
    }
  }, [sheetDate, flush])

  // 關閉/重新整理分頁時，若還有沒存完的改動就擋一下
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (queueRef.current.length > 0 || inFlightRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
  }, [])

  return { status, errorMsg, queue, flushNow, hasPending: () => queueRef.current.length > 0 }
}
