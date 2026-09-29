// 包裝專區 P1 — Undo／Redo 堆疊（純函式 reducer，規格 §3.8；D33 當次 50 步）
//
// 每一格存「伺服器回傳的反向操作」（inverse）；按 Undo 就把 entry.ops 當一般操作再送一次
// POST /api/packaging/placements（一樣驗鎖、驗版本，不另開後門 API）。
// 本檔只管堆疊規則，不碰 React：前端 hook（components/packaging/board/useUndo.ts）用 useState 包它即可。
//
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import { UNDO_LIMIT, type UndoEntry, type UndoState } from './scheduleTypes'

const cap = (list: readonly UndoEntry[]): UndoEntry[] => list.slice(-UNDO_LIMIT)

/** 空堆疊（取得／失去鎖、快照還原、partial 錯誤、重新整理時清空） */
export function clearUndo(): UndoState {
  return { undo: [], redo: [] }
}

/** 一般操作成功：推進 undo（超過 50 格擠掉最舊）、清空 redo */
export function pushUndo(s: UndoState, e: UndoEntry): UndoState {
  return { undo: cap([...s.undo, e]), redo: [] }
}

/** Undo 送出成功後：把「這次回應的 inverse」推進 redo（undo 不動） */
export function pushRedo(s: UndoState, e: UndoEntry): UndoState {
  return { undo: s.undo, redo: cap([...s.redo, e]) }
}

/** Redo 送出成功後：把這次的 inverse 推回 undo，但「不」清空 redo（還能繼續 Redo） */
export function pushUndoKeepRedo(s: UndoState, e: UndoEntry): UndoState {
  return { undo: cap([...s.undo, e]), redo: s.redo }
}

/** 取出 undo 最上面一格；空的時 entry＝null、state 原樣 */
export function takeUndo(s: UndoState): { entry: UndoEntry | null; state: UndoState } {
  if (s.undo.length === 0) return { entry: null, state: s }
  return { entry: s.undo[s.undo.length - 1], state: { undo: s.undo.slice(0, -1), redo: s.redo } }
}

/** 取出 redo 最上面一格；空的時 entry＝null、state 原樣 */
export function takeRedo(s: UndoState): { entry: UndoEntry | null; state: UndoState } {
  if (s.redo.length === 0) return { entry: null, state: s }
  return { entry: s.redo[s.redo.length - 1], state: { undo: s.undo, redo: s.redo.slice(0, -1) } }
}
