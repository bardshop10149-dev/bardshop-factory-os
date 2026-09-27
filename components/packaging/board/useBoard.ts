'use client'

// 工作台資料 hook：載入、60 秒輪詢（D52）、操作佇列（自動儲存，D33）、樂觀更新、Undo／Redo。
//
// 資料流：
//   拖曳／勾選 → submit(ops, label, 本機動作)
//     ① 先在本機套用（applyLocal，拖曳手感即時）
//     ② 放進佇列；佇列「一次只送一個請求」——後一個操作的版本號要等前一個寫完才確定
//     ③ 送出前依已知版本重算 version（rebaseOpVersions），成功後用回應 rows 更新已知版本、把 inverse 推進 Undo
//     ④ 佇列清空 → 重抓一次工作台（伺服器重算分配、產能、延誤），畫面以伺服器為準
//   輪詢：佇列非空或正在拖曳時跳過；分頁在背景時暫停，回到前景立即補抓。
//   「過時回應」防護：每個 GET 發出時記下 mutationGen（有新操作排入或寫入成功就 +1），
//   回來時若 gen 已變＝這份資料是寫入前的 DB 快照，丟掉不套用、改成之後再抓一次；
//   拖曳中回來的回應也先不套用（避免被拖的卡／目標欄被換掉），放開後補抓。

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BOARD_DEFAULT_WORKDAYS,
  BOARD_MAX_WORKDAYS,
  BOARD_POLL_MS,
  type ApplyResponse,
  type CompleteRequest,
  type Placement,
  type PlacementOp,
} from '@/lib/packaging/scheduleTypes'
import { MIGRATION_HINT, fetchBoard, postComplete, postPlacements, type ApiResult } from './boardApi'
import { applyLocal, rebaseOpVersions, versionMapOf, type BoardOk, type LocalAction } from './boardLocal'
import type { EditLockApi } from './useEditLock'
import type { UndoApi } from './useUndo'

export type Endpoint = 'placements' | 'complete'

interface QueueItem {
  key: number
  endpoint: Endpoint
  ops: PlacementOp[]
  label: string
  mode: 'normal' | 'undo' | 'redo'
  attempts: number
}

export interface Toast {
  id: number
  kind: 'info' | 'warn' | 'error'
  text: string
}

export interface LoadError {
  message: string
  missingTable: boolean
  at: number
}

/** 網路錯誤／5xx 的重試間隔（規格 §7.3：1s、3s、9s） */
const RETRY_DELAYS = [1000, 3000, 9000]

function patchVersions(d: BoardOk, rows: Placement[]): BoardOk {
  if (rows.length === 0) return d
  const v = new Map(rows.map(r => [r.id, r.version]))
  const fix = <T extends { placementId: string; version: number }>(c: T): T =>
    v.has(c.placementId) ? { ...c, version: v.get(c.placementId)! } : c
  return {
    ...d,
    days: d.days.map(day => ({ ...day, cards: day.cards.map(fix) })),
    holding: d.holding.map(fix),
  }
}

export function useBoard(opts: {
  enabled: boolean
  lock: EditLockApi
  undo: UndoApi
  onUnauthorized: () => void
  onForbidden: () => void
}) {
  const { enabled, lock, undo } = opts
  const [data, setData] = useState<BoardOk | null>(null)
  const [loadError, setLoadError] = useState<LoadError | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)
  const [workdays, setWorkdays] = useState(BOARD_DEFAULT_WORKDAYS)

  const [pending, setPending] = useState(0)
  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<{ message: string; count: number } | null>(null)
  const [paused, setPausedState] = useState<null | 'lock_required'>(null)
  const [toast, setToast] = useState<Toast | null>(null)

  const revRef = useRef<string | null>(null)
  const versionsRef = useRef<Map<string, number>>(new Map())
  const queueRef = useRef<QueueItem[]>([])
  const keyRef = useRef(0)
  const busyRef = useRef(false)
  const pausedRef = useRef<null | 'lock_required' | 'error'>(null)
  const dirtyRef = useRef(false)
  const loadingRef = useRef(false)
  const reloadAgainRef = useRef(false)
  const lastLoadRef = useRef(0)
  const dragPauseRef = useRef(false)
  /** 寫入世代：enqueue 與每次寫入成功各 +1；用來辨識「在寫入之前就發出的 GET」 */
  const mutationGenRef = useRef(0)
  const workdaysRef = useRef(workdays)
  const lockRef = useRef(lock)
  const undoRef = useRef(undo)
  const cbRef = useRef(opts)
  useEffect(() => {
    lockRef.current = lock
    undoRef.current = undo
    cbRef.current = opts
  })

  const showToast = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ id: Date.now() + Math.random(), kind, text })
  }, [])

  // ── 載入 ──────────────────────────────────────────────────────────────
  const load = useCallback(async (o: { force?: boolean; fresh?: boolean } = {}) => {
    if (loadingRef.current) {
      if (o.force) reloadAgainRef.current = true
      return
    }
    loadingRef.current = true
    setLoading(true)
    try {
      const reqToken = lockRef.current.getToken()
      const gen = mutationGenRef.current
      const r = await fetchBoard({
        workdays: workdaysRef.current,
        rev: o.force || o.fresh ? null : revRef.current,
        fresh: o.fresh,
        lockToken: reqToken,
      })
      if (r.status === 401) { cbRef.current.onUnauthorized(); return }
      if (r.status === 403) { cbRef.current.onForbidden(); return }
      const j = r.json
      if (j && j.success) {
        lastLoadRef.current = Date.now()
        setLastLoadedAt(Date.now())
        setLoadError(null)
        lockRef.current.ingest(j.lock, j.serverTime, reqToken)
        // 佇列裡還有操作時不套用（避免蓋掉樂觀更新）；佇列清空後 pump 會再抓一次
        if (queueRef.current.length > 0 || busyRef.current) {
          dirtyRef.current = true
          return
        }
        // 這個請求發出後有新的寫入（已排入或已寫完）：回應是寫入前的快照，套用會讓卡片跳回原位、
        // 已知版本號倒退（之後 rebase 出舊 version → 假的 version_conflict）→ 丟掉，finally 再抓一次
        if (mutationGenRef.current !== gen) {
          reloadAgainRef.current = true
          return
        }
        if (j.unchanged) return
        // 拖曳中不重畫（DragOverlay／drop 目標要和畫面一致）；放開時 setDragging(false) 會補抓
        if (dragPauseRef.current) {
          dirtyRef.current = true
          return
        }
        revRef.current = j.revision
        versionsRef.current = versionMapOf(j)
        setData(j)
        return
      }
      setLoadError({ message: r.error ?? '載入失敗', missingTable: r.missingTable, at: Date.now() })
    } finally {
      loadingRef.current = false
      setLoading(false)
      if (reloadAgainRef.current) {
        reloadAgainRef.current = false
        void load({ force: true })
      }
    }
  }, [])

  const reload = useCallback((fresh = false) => load({ force: true, fresh }), [load])

  useEffect(() => {
    workdaysRef.current = workdays
    if (enabled) void load({ force: true })
  }, [enabled, workdays, load])

  // 輪詢（D52：所有人每 60 秒）；背景分頁暫停，切回前景若已超過 60 秒立刻補抓
  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      if (queueRef.current.length > 0 || busyRef.current || dragPauseRef.current) return
      void load()
    }
    const id = window.setInterval(tick, BOARD_POLL_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoadRef.current > BOARD_POLL_MS) tick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [enabled, load])

  // 佇列非空時離開頁面要提示
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (queueRef.current.length > 0 || busyRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [])

  // ── 佇列 ──────────────────────────────────────────────────────────────
  const syncPending = useCallback(() => setPending(queueRef.current.length), [])

  /** 丟掉佇列（含送出失敗的那一個）並重抓工作台 */
  const dropAll = useCallback((msg: string | null, kind: Toast['kind'] = 'warn') => {
    const n = queueRef.current.length
    queueRef.current = []
    pausedRef.current = null
    setPausedState(null)
    setSaveError(null)
    syncPending()
    dirtyRef.current = false
    if (msg) showToast(kind, n > 1 ? `${msg}（另有 ${n - 1} 個後續操作已取消）` : msg)
    void load({ force: true })
  }, [load, showToast, syncPending])

  const pump = useCallback(async (): Promise<void> => {
    if (busyRef.current || pausedRef.current) return
    const item = queueRef.current[0]
    if (!item) {
      if (dirtyRef.current) {
        dirtyRef.current = false
        void load({ force: true })
      }
      return
    }
    const lk = lockRef.current
    const token = lk.getToken()
    if (!token || lk.phase !== 'mine') {
      dropAll('目前沒有編輯權，操作未儲存')
      return
    }
    busyRef.current = true
    setSaving(true)
    const ops = rebaseOpVersions(item.ops, versionsRef.current)
    let r: ApiResult<ApplyResponse>
    try {
      r = item.endpoint === 'complete'
        ? await postComplete({ lockToken: token, ops: ops as CompleteRequest['ops'], label: item.label })
        : await postPlacements({ lockToken: token, ops, label: item.label })
    } finally {
      busyRef.current = false
      setSaving(false)
    }

    const ok = r.json && r.json.success ? r.json : null
    if (ok) {
      mutationGenRef.current++
      for (const row of ok.rows) versionsRef.current.set(row.id, row.version)
      for (const id of ok.deletedIds) versionsRef.current.delete(id)
      setData(d => (d ? patchVersions(d, ok.rows) : d))
      lk.ingest(ok.lock, null, token)
      const u = undoRef.current
      const entry = { label: item.label.replace(/^(復原|重做)：/, ''), ops: ok.inverse, at: new Date().toISOString() }
      if (ok.inverse.length > 0) {
        if (item.mode === 'normal') u.push(entry)
        else if (item.mode === 'undo') u.pushRedo(entry)
        else u.pushUndoKeepRedo(entry)
      }
      queueRef.current.shift()
      syncPending()
      setLastSavedAt(Date.now())
      setSaveError(null)
      dirtyRef.current = true
      return pump()
    }

    // ── 失敗處理（規格 §7.3） ──
    const fail = r.json && !r.json.success ? r.json : null
    const code = fail?.code
    if (r.status === 401) { cbRef.current.onUnauthorized(); return }
    if (r.missingTable) { dropAll(MIGRATION_HINT, 'error'); return }
    if (fail?.partial) {
      undoRef.current.clear()
      dropAll('部分操作未完成，已重新載入最新狀態（復原紀錄已清空）', 'error')
      return
    }
    if (code === 'lock_lost') {
      const n = queueRef.current.length
      queueRef.current = []
      syncPending()
      lk.markLost(fail?.lock)
      undoRef.current.clear()
      showToast('error', `編輯權已被接手，${n} 個尚未儲存的操作已捨棄`)
      void load({ force: true })
      return
    }
    if (code === 'lock_required') {
      // 逾時釋放：佇列保留，重新取得編輯權後繼續送（版本沒變就會成功）
      pausedRef.current = 'lock_required'
      setPausedState('lock_required')
      lk.markExpired(fail?.lock)
      showToast('warn', `編輯權已逾時釋放；重新取得後會繼續儲存 ${queueRef.current.length} 個操作`)
      return
    }
    if (code === 'version_conflict' || code === 'not_found' || code === 'id_exists') {
      dropAll(item.mode === 'normal'
        ? `這張卡剛被其他變更更新過，已重新載入（${fail?.error ?? code}）`
        : '這一步已被其他變更覆蓋，無法復原；已重新載入')
      return
    }
    if (code === 'pool_unavailable') {
      dropAll('待排池暫時無法取得，操作未儲存，請稍後再試', 'error')
      return
    }
    if (code === 'forbidden' || r.status === 403) {
      dropAll('你沒有編輯排程的權限（需要 packaging_admin）', 'error')
      return
    }
    const transient = r.network || (r.status >= 500 && r.status !== 501)
    if (transient) {
      item.attempts++
      if (item.attempts <= RETRY_DELAYS.length) {
        window.setTimeout(() => { void pump() }, RETRY_DELAYS[item.attempts - 1])
        return
      }
      pausedRef.current = 'error'
      setSaveError({ message: r.error ?? '儲存失敗', count: queueRef.current.length })
      return
    }
    // 驗證錯誤（422 等）：還原樂觀更新（重抓）、顯示伺服器訊息
    dropAll(fail?.error ?? r.error ?? '操作未通過驗證', 'error')
  }, [dropAll, load, showToast, syncPending])

  const enqueue = useCallback((item: Omit<QueueItem, 'key' | 'attempts'>) => {
    mutationGenRef.current++
    queueRef.current.push({ ...item, key: ++keyRef.current, attempts: 0 })
    syncPending()
    void pump()
  }, [pump, syncPending])

  /** 一般操作：本機先套用，再排進佇列送出 */
  const submit = useCallback((ops: PlacementOp[], label: string, locals: LocalAction[], endpoint: Endpoint = 'placements') => {
    if (lockRef.current.phase !== 'mine') {
      showToast('warn', '目前是唯讀模式，請先按「開始編輯」')
      return
    }
    if (ops.length === 0) return
    if (locals.length > 0) setData(d => (d ? locals.reduce(applyLocal, d) : d))
    enqueue({ endpoint, ops, label, mode: 'normal' })
  }, [enqueue, showToast])

  const canStep = pending === 0 && !saving && lock.phase === 'mine'

  const undoStep = useCallback(() => {
    if (queueRef.current.length > 0 || busyRef.current || lockRef.current.phase !== 'mine') return
    const e = undoRef.current.takeUndo()
    if (!e) return
    enqueue({ endpoint: 'placements', ops: e.ops, label: `復原：${e.label}`, mode: 'undo' })
  }, [enqueue])

  const redoStep = useCallback(() => {
    if (queueRef.current.length > 0 || busyRef.current || lockRef.current.phase !== 'mine') return
    const e = undoRef.current.takeRedo()
    if (!e) return
    enqueue({ endpoint: 'placements', ops: e.ops, label: `重做：${e.label}`, mode: 'redo' })
  }, [enqueue])

  /** 儲存失敗（重試 3 次仍失敗）後的「重試」 */
  const retryNow = useCallback(() => {
    for (const it of queueRef.current) it.attempts = 0
    pausedRef.current = null
    setSaveError(null)
    void pump()
  }, [pump])

  /** 重新取得編輯權後繼續送出暫停中的佇列 */
  useEffect(() => {
    if (lock.phase === 'mine' && pausedRef.current === 'lock_required') {
      pausedRef.current = null
      setPausedState(null)
      void pump()
    }
  }, [lock.phase, pump])

  const discardQueue = useCallback(() => dropAll('已放棄未儲存的操作'), [dropAll])

  /** 失去編輯權（被接手／自己結束）：丟掉佇列 */
  const clearQueue = useCallback(() => {
    if (queueRef.current.length === 0) return
    queueRef.current = []
    pausedRef.current = null
    setPausedState(null)
    syncPending()
    void load({ force: true })
  }, [load, syncPending])

  const loadMore = useCallback(() => {
    setWorkdays(w => Math.min(BOARD_MAX_WORKDAYS, w + 10))
  }, [])

  const setDragging = useCallback((v: boolean) => {
    dragPauseRef.current = v
    // 拖曳中有輪詢回應被擱置：放開後補抓。佇列非空時交給 pump 在清空後處理（它也看 dirtyRef）
    if (!v && dirtyRef.current && queueRef.current.length === 0 && !busyRef.current) {
      dirtyRef.current = false
      void load({ force: true })
    }
  }, [load])

  return {
    data,
    loadError,
    loading,
    lastLoadedAt,
    workdays,
    loadMore,
    reload,
    submit,
    undoStep,
    redoStep,
    canStep,
    pending,
    saving,
    lastSavedAt,
    saveError,
    paused,
    retryNow,
    discardQueue,
    clearQueue,
    toast,
    dismissToast: useCallback(() => setToast(null), []),
    showToast,
    setDragging,
  }
}

export type BoardApi = ReturnType<typeof useBoard>
