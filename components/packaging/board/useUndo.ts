'use client'

// D33：當次 50 步 Undo／Redo（只存在記憶體，重新整理就清空）。
//
// 每一格存的是「伺服器回傳的反向操作」（inverse），按 Undo 就把它當一般操作再送一次
// POST /api/packaging/placements —— 一樣驗鎖、驗版本，不另開後門 API。
// 堆疊規則與 lib/packaging/scheduleUndo.ts 規格相同（push 會清空 redo、超過 50 格擠掉最舊），
// 這裡用 useState 包成 hook；等純函式檔完成後可直接換成它的 pushUndo/takeUndo。

import { useCallback, useRef, useState } from 'react'
import { UNDO_LIMIT, type UndoEntry, type UndoState } from '@/lib/packaging/scheduleTypes'

const EMPTY: UndoState = { undo: [], redo: [] }

export interface UndoApi {
  state: UndoState
  canUndo: boolean
  canRedo: boolean
  /** 一般操作成功：推進 undo、清空 redo */
  push: (e: UndoEntry) => void
  /** Undo 成功後，把這次的反向操作推進 redo */
  pushRedo: (e: UndoEntry) => void
  /** Redo 成功後，把這次的反向操作推回 undo（不清空 redo） */
  pushUndoKeepRedo: (e: UndoEntry) => void
  /** 取出最上面一格（同步回傳，呼叫端馬上送出） */
  takeUndo: () => UndoEntry | null
  takeRedo: () => UndoEntry | null
  clear: () => void
}

export function useUndo(): UndoApi {
  const [state, setState] = useState<UndoState>(EMPTY)
  // 取出時要「同步」拿到那一格：setState 的 updater 不保證立即執行，所以另存一份 ref 當即時值
  const ref = useRef<UndoState>(EMPTY)

  const commit = useCallback((next: UndoState) => {
    ref.current = next
    setState(next)
  }, [])

  const push = useCallback((e: UndoEntry) => {
    commit({ undo: [...ref.current.undo, e].slice(-UNDO_LIMIT), redo: [] })
  }, [commit])

  const pushRedo = useCallback((e: UndoEntry) => {
    commit({ undo: ref.current.undo, redo: [...ref.current.redo, e].slice(-UNDO_LIMIT) })
  }, [commit])

  const pushUndoKeepRedo = useCallback((e: UndoEntry) => {
    commit({ undo: [...ref.current.undo, e].slice(-UNDO_LIMIT), redo: ref.current.redo })
  }, [commit])

  const takeUndo = useCallback((): UndoEntry | null => {
    const s = ref.current
    if (s.undo.length === 0) return null
    const entry = s.undo[s.undo.length - 1]
    commit({ undo: s.undo.slice(0, -1), redo: s.redo })
    return entry
  }, [commit])

  const takeRedo = useCallback((): UndoEntry | null => {
    const s = ref.current
    if (s.redo.length === 0) return null
    const entry = s.redo[s.redo.length - 1]
    commit({ undo: s.undo, redo: s.redo.slice(0, -1) })
    return entry
  }, [commit])

  const clear = useCallback(() => commit(EMPTY), [commit])

  return {
    state,
    canUndo: state.undo.length > 0,
    canRedo: state.redo.length > 0,
    push,
    pushRedo,
    pushUndoKeepRedo,
    takeUndo,
    takeRedo,
    clear,
  }
}
