'use client'

// 工作台資料 hook：載入、60 秒輪詢（D52）、操作佇列（自動儲存，D33）、樂觀更新、Undo／Redo。
//
// 資料流：
//   拖曳／勾選 → submit(ops, label, 本機動作)
//     ① 先在本機套用（applyLocal，拖曳手感即時）
//     ② 放進佇列；佇列「一次只送一個請求」——後一個操作的版本號要等前一個寫完才確定
//     ③ 送出前依已知版本重算 version（rebaseOpVersions），成功後用回應 rows 更新已知版本、把 inverse 推進 Undo
//     ④ 佇列清空 → 停手 3 秒後重抓一次工作台（伺服器重算分配、產能、延誤），畫面以伺服器為準（D98 ①，見下）
//   輪詢：佇列非空或正在拖曳時跳過；分頁在背景時暫停，回到前景立即補抓。
//   「過時回應」防護：每個 GET 發出時記下 mutationGen（有新操作排入或寫入成功就 +1），
//   回來時若 gen 已變＝這份資料是寫入前的 DB 快照，丟掉不套用、改成之後再抓一次；
//   拖曳中回來的回應也先不套用（避免被拖的卡／目標欄被換掉），放開後補抓。
//   檢視視窗（D56：日 1／週 5／兩週 10 個工作日，起點 from）改變時 windowGen +1；
//   發出時的 windowGen 與回來時不同＝舊視窗的回應，丟掉再抓（否則日檢視會短暫顯示成別天）。
//
// D98 加速（主管反映「拖完要等、會卡、紀錄太多」）：
//   ① 存檔後不再每次立刻整張重抓：佇列清空後「停手 RELOAD_SETTLE_MS（3 秒）」才重抓一次；期間有新操作、正在拖曳就延後。
//      只改內部觸發的校正（存檔後、放開拖曳後補抓、寫入前發出的過時回應）；手動重新整理、換檢視、版本還原等照舊立即。
//      一般拖曳：樂觀更新＋寫入回應的 rows（patchVersions）已讓畫面與版本號正確，重抓只是校正伺服器才算得出的分配／延誤／產能，晚 3 秒無妨。
//      例外（佇列清空就立刻重抓，並放行等合併的批：requestDrainReload）：
//        · Undo／Redo、放回待排池（queueMerge.needsPromptReload：本機沒套用／池量沒還原，畫面要靠重抓）
//        · 還原失敗操作的明確重抓（dropAll、lock_lost、併批部分失敗…）被佇列或拖曳擋下時——放開拖曳後也照樣立刻，不降級成停手 3 秒
//      有這種待立刻重抓時，新操作也不等合併（畫面上可能還有不存在的卡，越快落地越好）。
//   ④ 一般操作送出前先等 MERGE_HOLD_MS（1.5 秒，拖曳中繼續等、最長 MERGE_MAX_HOLD_MS），期間的連續操作併成一次 POST
//      （一次寫入、一筆 op_log、一個 Undo 單位）。能不能併由 queueMerge.canMerge 判斷（觸及 id 不重疊等，理由見該檔）。
//      勾完成（complete API）、Undo／Redo 不併也不等，而且會把前面還在等的一起放行（佇列一定照順序送）。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  BOARD_POLL_MS,
  type ApplyResponse,
  type BoardCard,
  type CompleteRequest,
  type MinutesEditVia,
  type Placement,
  type PlacementOp,
  type YMD,
} from '@/lib/packaging/scheduleTypes'
import { hoursText } from '@/lib/packaging/boardView'
import { MIGRATION_HINT, fetchBoard, postComplete, postPlacements, type ApiResult } from './boardApi'
import { applyLocal, rebaseOpVersions, storedOverrideOf, versionMapOf, type BoardOk, type LocalAction } from './boardLocal'
import type { EditLockApi } from './useEditLock'
import type { UndoApi } from './useUndo'
import {
  MERGE_HOLD_MS,
  RELOAD_SETTLE_MS,
  appendToBatch,
  canMerge,
  countActions,
  holdDelayMs,
  isDeferrable,
  needsPromptReload,
  settleDecision,
  singleBatch,
  splitBatchAtOp,
  type BatchPart,
} from './queueMerge'

export type Endpoint = 'placements' | 'complete'

interface QueueItem {
  key: number
  endpoint: Endpoint
  ops: PlacementOp[]
  /** 送給伺服器的標籤（併批時＝mergeLabels(各操作標籤)） */
  label: string
  /** 併進這一批的各個使用者操作（標籤＋貢獻幾個 op；「尚未儲存 N」以它計、失敗時據以對回是哪個操作） */
  parts: BatchPart[]
  mode: 'normal' | 'undo' | 'redo'
  attempts: number
  /** 已送出過（送出中、網路失敗重試中、等重新取得編輯權）：不可再併入新操作 */
  sent: boolean
  /** ④ 最早可送出的時間（ms）；0＝不等（勾完成、Undo／Redo、已被放行） */
  holdUntil: number
  /** ④ 這一批第一個操作排入的時間（最長等待 MERGE_MAX_HOLD_MS 的起點） */
  firstAt: number
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
/**
 * 卸載後（App 內換頁）等存檔送完、才釋放編輯鎖的上限（whenSaved）。
 * 網路重試 1+3+9 秒、寫入本身可能要同步重組待排池（數秒）；超過就不等了——鎖照樣釋放，最壞只是別人多等這幾十秒。
 */
const SAVE_DRAIN_MAX_MS = 30_000
const SAVE_DRAIN_POLL_MS = 100

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

/** 目前要向伺服器要的視窗：from＝檢視起點（null＝今天）、workdays＝天數 */
export interface BoardWindowReq {
  from: YMD | null
  workdays: number
}

export function useBoard(opts: {
  enabled: boolean
  /** 初始視窗（之後用 setWindow 改） */
  initialWindow: BoardWindowReq
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
  const [windowReq, setWindowReq] = useState<BoardWindowReq>(opts.initialWindow)

  const [pending, setPending] = useState(0)
  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<{ message: string; count: number } | null>(null)
  const [paused, setPausedState] = useState<null | 'lock_required'>(null)
  const [toast, setToast] = useState<Toast | null>(null)

  const revRef = useRef<string | null>(null)
  /** 最新資料（setMinutes 取目前使用者當樂觀更新的修改者） */
  const dataRef = useRef<BoardOk | null>(null)
  useEffect(() => { dataRef.current = data }, [data])
  const versionsRef = useRef<Map<string, number>>(new Map())
  const queueRef = useRef<QueueItem[]>([])
  const keyRef = useRef(0)
  const busyRef = useRef(false)
  const pausedRef = useRef<null | 'lock_required' | 'error'>(null)
  const dirtyRef = useRef(false)
  const loadingRef = useRef(false)
  /** 載入中又要求強制重抓：載完再抓一次。'settle'＝只是 ① 停手重抓（被佇列擋下時交給停手計時），'explicit'＝其他 */
  const reloadAgainRef = useRef<false | 'explicit' | 'settle'>(false)
  const lastLoadRef = useRef(0)
  const dragPauseRef = useRef(false)
  /** 寫入世代：enqueue 與每次寫入成功各 +1；用來辨識「在寫入之前就發出的 GET」 */
  const mutationGenRef = useRef(0)
  const windowRef = useRef(windowReq)
  /** 視窗世代：setWindow 改到不同視窗就 +1，用來丟掉舊視窗的回應 */
  const windowGenRef = useRef(0)
  /** ④ 佇列最前面那批「等合併」到期時叫 pump 的計時器 */
  const holdTimerRef = useRef<number | null>(null)
  /** ① 「停手 3 秒才重抓」的計時器 */
  const settleTimerRef = useRef<number | null>(null)
  /** ① load 裡要排「停手重抓」，但 scheduleSettledReload 依賴 load（循環）→ 經由 ref 呼叫 */
  const settleRef = useRef<(restart: boolean) => void>(() => {})
  /** 已卸載：不再排任何計時器（卸載當下的送出照樣完成） */
  const disposedRef = useRef(false)
  /**
   * 佇列清空時要「立刻」重抓、不等停手 3 秒（一律經由 requestDrainReload 設定）：
   * ④ 併批部分失敗、前段另外重送中（存完要把失敗那個操作的樂觀更新還原）；Undo／Redo、放回待排池存完（needsPromptReload）；
   * 明確重抓（手動重新整理、換檢視、失敗還原）被佇列或拖曳擋下（同舊行為：佇列清空／放開後馬上補抓）。
   * 不變式：它為 true 時佇列裡沒有等合併的批（requestDrainReload 放行、enqueue 不再壓）。
   */
  const reloadOnDrainRef = useRef(false)
  /** ④ 放行等合併的批（flushHeld 依賴 pump，定義在後面；reload／setWindow 經由 ref 呼叫） */
  const flushRef = useRef<() => void>(() => {})
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

  /**
   * 佇列清空（或放開拖曳）時立刻重抓，而且還在等合併的批一併放行：佇列越快清空，重抓越快落地。
   * 不放行的話，連續操作會把合併等候一路延到 MERGE_MAX_HOLD_MS，畫面上「已失敗／已被復原掉」的卡就留那麼久。
   */
  const requestDrainReload = useCallback(() => {
    reloadOnDrainRef.current = true
    flushRef.current()
  }, [])

  // ── 載入 ──────────────────────────────────────────────────────────────
  /**
   * settle：D98 ① 「停手 3 秒」觸發的內部重抓。其他強制重抓（手動重新整理、換檢視、失敗還原…）若被佇列擋下，
   * 佇列清空時「立刻」補抓（reloadOnDrainRef，同舊行為）；settle 的則回到停手計時，不因此多一次整張重畫。
   */
  const load = useCallback(async (o: { force?: boolean; fresh?: boolean; settle?: boolean } = {}) => {
    if (loadingRef.current) {
      if (o.force) reloadAgainRef.current = o.settle && reloadAgainRef.current !== 'explicit' ? 'settle' : 'explicit'
      return
    }
    loadingRef.current = true
    setLoading(true)
    try {
      const reqToken = lockRef.current.getToken()
      const gen = mutationGenRef.current
      const wgen = windowGenRef.current
      const r = await fetchBoard({
        from: windowRef.current.from,
        workdays: windowRef.current.workdays,
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
        // 佇列裡還有操作（含 ④ 等合併中的）時不套用（避免蓋掉樂觀更新）；佇列清空後 pump 會排「停手 3 秒」再抓，
        // 明確重抓則改成「清空就立刻抓」（等合併的批一併放行）
        if (queueRef.current.length > 0 || busyRef.current) {
          dirtyRef.current = true
          if (o.force && !o.settle) requestDrainReload()
          return
        }
        // 這個請求發出後有新的寫入（已排入或已寫完）：回應是寫入前的快照，套用會讓卡片跳回原位、
        // 已知版本號倒退（之後 rebase 出舊 version → 假的 version_conflict）→ 丟掉。
        // D98 ①：走到這裡佇列已清空（上面先擋了非空）＝那些寫入都完成了，pump 清空時已排好「停手 3 秒」重抓；
        // 輪詢／停手重抓只確保有排（不重新計時），不再立刻整張重抓。明確的強制重抓照舊：載完立刻再抓一次
        if (mutationGenRef.current !== gen) {
          if (o.force && !o.settle) {
            reloadAgainRef.current = 'explicit'
            return
          }
          dirtyRef.current = true
          settleRef.current(false)
          return
        }
        // 發出後換了檢視視窗：這份是舊視窗的資料 → 丟掉，finally 再抓新視窗
        if (windowGenRef.current !== wgen) {
          reloadAgainRef.current = 'explicit'
          return
        }
        if (j.unchanged) return
        // 拖曳中不重畫（DragOverlay／drop 目標要和畫面一致）；放開時 setDragging(false) 補抓。
        // 明確重抓（失敗還原、lock_lost、手動重新整理…）要保留「立刻」的性質：放開後馬上抓，不降級成停手 3 秒——
        // 否則 ④ 之下（批在放下 1.5 秒後才送，失敗回應常落在下一次拖曳中）失敗操作的假卡會在畫面上多留好幾秒
        if (dragPauseRef.current) {
          dirtyRef.current = true
          if (o.force && !o.settle) requestDrainReload()
          return
        }
        revRef.current = j.revision
        versionsRef.current = versionMapOf(j)
        setData(j)
        // 佇列空、發出後沒有新寫入、不在拖曳＝這份就是所有寫入之後的完整狀態 → 等著的「停手重抓」「清空時立刻重抓」都可以取消
        dirtyRef.current = false
        reloadOnDrainRef.current = false
        if (settleTimerRef.current != null) {
          window.clearTimeout(settleTimerRef.current)
          settleTimerRef.current = null
        }
        return
      }
      setLoadError({ message: r.error ?? '載入失敗', missingTable: r.missingTable, at: Date.now() })
    } finally {
      loadingRef.current = false
      setLoading(false)
      const again = reloadAgainRef.current
      if (again) {
        reloadAgainRef.current = false
        void load({ force: true, settle: again === 'settle' })
      }
    }
  }, [requestDrainReload])

  /** 手動重新整理／版本還原後等明確重抓：立即（佇列還有等合併的批就先放行，存完立刻補抓） */
  const reload = useCallback((fresh = false) => {
    flushRef.current()
    return load({ force: true, fresh })
  }, [load])

  /**
   * D98 ① 「停手 RELOAD_SETTLE_MS 才重抓」：restart＝重新計時（佇列剛清空、剛放開拖曳）；false＝已有計時就沿用。
   * 到時再判斷一次（settleDecision）：佇列又有東西 → 交給清空時的 pump 重排；拖曳中 → 再等一輪。
   */
  const scheduleSettledReload = useCallback((restart: boolean) => {
    if (disposedRef.current) return
    if (settleTimerRef.current != null) {
      if (!restart) return
      window.clearTimeout(settleTimerRef.current)
    }
    const fire = () => {
      settleTimerRef.current = null
      if (disposedRef.current) return
      const d = settleDecision({
        dirty: dirtyRef.current,
        queueLength: queueRef.current.length,
        busy: busyRef.current,
        dragging: dragPauseRef.current,
      })
      if (d === 'defer') {
        settleTimerRef.current = window.setTimeout(fire, RELOAD_SETTLE_MS)
        return
      }
      if (d === 'reload') {
        dirtyRef.current = false
        void load({ force: true, settle: true })
      }
    }
    settleTimerRef.current = window.setTimeout(fire, RELOAD_SETTLE_MS)
  }, [load])
  useEffect(() => { settleRef.current = scheduleSettledReload }, [scheduleSettledReload])

  /**
   * D110：工作台操作佇列「以外」的寫入剛完成（結案：伺服器刪了該行未完成的排定卡、該行離開待排池）。
   * ① 寫入世代 +1：在它之前發出的 GET 是寫入前的快照，回來時照既有規則丟掉（否則那份舊資料會被當成最新、
   *    還順手把等著的重抓取消掉，畫面要等到下一次 60 秒輪詢才校正）
   * ② 標記待重抓：佇列是空的就排「停手 3 秒重抓」（連續結案多張只抓一次）；佇列還有東西＝清空時 pump 會排
   * 畫面不靠這次重抓把卡拿掉（那是本地記號的事，closureLocal.ts）；重抓只是校正伺服器才算得出的產能與分配。
   */
  const noteExternalWrite = useCallback(() => {
    mutationGenRef.current++
    dirtyRef.current = true
    if (queueRef.current.length === 0 && !busyRef.current) scheduleSettledReload(true)
  }, [scheduleSettledReload])

  const clearSettle = useCallback(() => {
    if (settleTimerRef.current != null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])

  const clearHold = useCallback(() => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (enabled) void load({ force: true })
  }, [enabled, windowReq, load])

  /** 換檢視視窗（D56）；同一個視窗不重抓 */
  const setWindow = useCallback((w: BoardWindowReq) => {
    const cur = windowRef.current
    if (cur.from === w.from && cur.workdays === w.workdays) return
    windowRef.current = w
    windowGenRef.current++
    // 換檢視要立刻看到新範圍：等合併的批先放行（佇列清空前新視窗的資料不能套用，見 load）
    flushRef.current()
    setWindowReq(w)
  }, [])

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

  // 佇列非空時離開頁面要提示（④ 等合併中的操作也在佇列裡，一樣會提示）
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
  /** 「尚未儲存 N」以使用者操作數計（併批後一個請求可能含多個操作） */
  const syncPending = useCallback(() => setPending(countActions(queueRef.current)), [])

  /** 丟掉佇列（含送出失敗的那一個、還在等合併的）並重抓工作台 */
  const dropAll = useCallback((msg: string | null, kind: Toast['kind'] = 'warn') => {
    const n = countActions(queueRef.current)
    queueRef.current = []
    clearHold()
    pausedRef.current = null
    setPausedState(null)
    setSaveError(null)
    syncPending()
    dirtyRef.current = false
    reloadOnDrainRef.current = false
    clearSettle()
    if (msg) showToast(kind, n > 1 ? `${msg}（另有 ${n - 1} 個後續操作已取消）` : msg)
    void load({ force: true })
  }, [clearHold, clearSettle, load, showToast, syncPending])

  const pump = useCallback(async (): Promise<void> => {
    if (busyRef.current || pausedRef.current) return
    const item = queueRef.current[0]
    if (!item) {
      if (disposedRef.current) return // 卸載後送完的：不必再重抓
      if (reloadOnDrainRef.current) {
        // 併批部分失敗後的前段已存完（把沒存到的那個操作從畫面上還原）、Undo／Redo／放回待排池存完、
        // 或明確重抓被佇列／拖曳擋下過（放開時 setDragging 也走這裡）：立刻重抓
        reloadOnDrainRef.current = false
        dirtyRef.current = false
        clearSettle()
        void load({ force: true })
        return
      }
      // D98 ①：佇列清空不立刻整張重抓，停手 3 秒再抓（期間再有操作就重新計時）
      if (dirtyRef.current) scheduleSettledReload(true)
      return
    }
    // D98 ④：還在等合併（最後一次排入後 1.5 秒內、拖曳中）→ 到時間再來
    const wait = holdDelayMs(item, Date.now(), dragPauseRef.current)
    if (wait > 0) {
      clearHold()
      if (!disposedRef.current) {
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null
          void pump()
        }, wait)
      }
      return
    }
    clearHold()
    const lk = lockRef.current
    const token = lk.getToken()
    // phase 'mine' 但 token 已清＝useEditLock 剛判定逾時、畫面狀態還沒重畫（被接手／自己結束時 onLost 已同步清空佇列，走不到這裡）
    if (lk.phase === 'expired' || (lk.phase === 'mine' && !token)) {
      // 編輯權逾時釋放（心跳／輪詢先發現）：與伺服器回 lock_required 同樣處理——佇列保留，重新取得後繼續送。
      // D98 ④ 之後操作會先等 1.5 秒才送，這段期間發現逾時的機會變多；舊寫法在這裡整批丟掉會多丟使用者的操作
      pausedRef.current = 'lock_required'
      setPausedState('lock_required')
      showToast('warn', `編輯權已逾時釋放；重新取得後會繼續儲存 ${countActions(queueRef.current)} 個操作`)
      return
    }
    if (!token || lk.phase !== 'mine') {
      dropAll('目前沒有編輯權，操作未儲存')
      return
    }
    busyRef.current = true
    // 從這裡起這一批「已送出」：伺服器可能已經看過它，之後的操作一律另開一批（重試時送的內容必須和第一次一樣）
    item.sent = true
    item.holdUntil = 0
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
      // D69：工時已改成功，但學習紀錄沒存到（伺服器先改後記，lines.md §3.6 規則 6）
      if (ok.adjustmentLogFailed) showToast('warn', '工時已修改，但「修改紀錄」未存到（不影響排程；日後校正工時會少這一筆）')
      // Undo／Redo、放回待排池：畫面要靠重抓才正確 → 佇列清空就立刻抓（不等停手 3 秒），後面等合併的也放行（見 needsPromptReload）
      if (needsPromptReload(item)) requestDrainReload()
      return pump()
    }

    // ── 失敗處理（規格 §7.3） ──
    const fail = r.json && !r.json.success ? r.json : null
    const code = fail?.code

    /**
     * ④ 併批（多個操作）因其中某個 op 被擋（伺服器逐一驗證、整批沒寫）：分開送時，失敗那個操作之前的早就存好了，
     * 所以只丟「失敗的那個與之後排隊的」，前段另成一批立刻重送（splitBatchAtOp）。回傳 false＝不適用，照舊 dropAll。
     */
    const keepPrefix = (msg: string, kind: Toast['kind']): boolean => {
      if (item.mode !== 'normal' || item.parts.length < 2 || typeof fail?.opIndex !== 'number') return false
      // 送出期間佇列被清掉（失去編輯權等）：不可把這批救回來
      if (queueRef.current[0] !== item) return false
      const cut = splitBatchAtOp(item, fail.opIndex)
      if (!cut || !cut.kept) return false
      const later = countActions(queueRef.current) - cut.kept.parts.length - 1
      queueRef.current = [{
        ...item,
        ...cut.kept,
        key: ++keyRef.current,
        attempts: 0,
        // 立刻送、不再併入新操作（新操作是在「含失敗操作」的畫面上做的，另排在後面）
        sent: true,
        holdUntil: 0,
      }]
      syncPending()
      requestDrainReload()
      clearSettle()
      showToast(kind, `未儲存「${cut.failedLabel}」：${msg}（前面 ${cut.kept.parts.length} 個操作照常儲存${later > 0 ? `；另有 ${later} 個後續操作已取消` : ''}）`)
      void pump()
      return true
    }

    if (r.status === 401) { cbRef.current.onUnauthorized(); return }
    if (r.missingTable) { dropAll(MIGRATION_HINT, 'error'); return }
    if (fail?.partial) {
      undoRef.current.clear()
      dropAll('部分操作未完成，已重新載入最新狀態（復原紀錄已清空）', 'error')
      return
    }
    if (code === 'lock_lost') {
      const n = countActions(queueRef.current)
      queueRef.current = []
      clearHold()
      reloadOnDrainRef.current = false
      syncPending()
      lk.markLost(fail?.lock)
      undoRef.current.clear()
      showToast('error', `編輯權已被接手，${n} 個尚未儲存的操作已捨棄`)
      void load({ force: true })
      return
    }
    if (code === 'lock_required') {
      // 逾時釋放：佇列保留（含還在等合併的），重新取得編輯權後繼續送（版本沒變就會成功）
      pausedRef.current = 'lock_required'
      setPausedState('lock_required')
      lk.markExpired(fail?.lock)
      showToast('warn', `編輯權已逾時釋放；重新取得後會繼續儲存 ${countActions(queueRef.current)} 個操作`)
      return
    }
    if (code === 'version_conflict' || code === 'not_found' || code === 'id_exists') {
      const msg = item.mode === 'normal'
        ? `這張卡剛被其他變更更新過，已重新載入（${fail?.error ?? code}）`
        : '這一步已被其他變更覆蓋，無法復原；已重新載入'
      if (!keepPrefix(msg, 'warn')) dropAll(msg)
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
      setSaveError({ message: r.error ?? '儲存失敗', count: countActions(queueRef.current) })
      return
    }
    // 驗證錯誤（422 等）：還原樂觀更新（重抓）、顯示伺服器訊息
    const msg = fail?.error ?? r.error ?? '操作未通過驗證'
    if (!keepPrefix(msg, 'error')) dropAll(msg, 'error')
  }, [clearHold, clearSettle, dropAll, load, requestDrainReload, scheduleSettledReload, showToast, syncPending])

  /**
   * 排進佇列。D98 ④：一般操作（placements、非 Undo／Redo）能併進最後一批就併（canMerge），並從現在起再等 MERGE_HOLD_MS；
   * 不能併就另開一批（一樣會等）。勾完成、Undo／Redo 不等：前面還在等的一起放行，照順序立刻送。
   * 有「清空就立刻重抓」在等（reloadOnDrainRef：失敗還原、Undo 結果還沒上畫面）時，一般操作也不等——
   * 畫面上可能還有不存在的卡，合併省下的那點請求不值得讓它多留；照樣可以併（併進還沒送的批、一起立刻送）。
   */
  const enqueue = useCallback((item: { endpoint: Endpoint; ops: PlacementOp[]; label: string; mode: QueueItem['mode'] }) => {
    mutationGenRef.current++
    // ① 有新操作：「停手 3 秒重抓」重新來過（佇列清空時 pump 會再排）
    clearSettle()
    const q = queueRef.current
    const now = Date.now()
    const deferrable = isDeferrable(item)
    const hold = deferrable && !reloadOnDrainRef.current
    const last = q[q.length - 1]
    if (deferrable && last && canMerge(last, item).ok) {
      Object.assign(last, appendToBatch(last, item))
      last.holdUntil = hold ? now + MERGE_HOLD_MS : 0
    } else {
      if (!hold) for (const it of q) it.holdUntil = 0
      q.push({
        ...item,
        ...singleBatch(item.ops, item.label),
        key: ++keyRef.current,
        attempts: 0,
        sent: false,
        holdUntil: hold ? now + MERGE_HOLD_MS : 0,
        firstAt: now,
      })
    }
    syncPending()
    void pump()
  }, [clearSettle, pump, syncPending])

  /** ④ 放行所有還在等合併的批，照順序立刻送（按 Undo／Redo、切到背景、卸載時） */
  const flushHeld = useCallback(() => {
    let any = false
    for (const it of queueRef.current) {
      if (it.holdUntil > 0) { it.holdUntil = 0; any = true }
    }
    if (any) void pump()
  }, [pump])
  useEffect(() => { flushRef.current = flushHeld }, [flushHeld])

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

  /**
   * D69 改工時（日檢視拉卡片下緣＝drag、卡片詳情＝dialog）。
   * minutes＝以本列 qty 為準的覆寫值（null＝回到標準估計）；與目前相同就不送（伺服器也不會記學習紀錄）。
   * 走同一個佇列與 Undo（反向操作由伺服器回 setMinutes via 'undo'）。
   */
  const setMinutes = useCallback((bc: BoardCard, minutes: number | null, reason: string | null, via: MinutesEditVia, label: string) => {
    const me = dataRef.current?.me
    const cur = storedOverrideOf(bc)
    if (minutes === cur || (minutes != null && cur != null && Math.abs(minutes - cur) < 0.05)) return
    submit(
      [{ op: 'setMinutes', id: bc.placementId, version: bc.version, minutes, reason: reason || null, via }],
      label || `改工時 ${bc.soLineKey} ${hoursText(bc.minutes) ?? '?'}→${minutes == null ? '標準' : `${hoursText(minutes)}`}h`,
      [{ t: 'setMinutes', id: bc.placementId, minutes, by: me?.email ?? '', byName: me?.name ?? null, atIso: new Date().toISOString() }],
    )
  }, [submit])

  const canStep = pending === 0 && !saving && lock.phase === 'mine'

  // 拖曳／拉下緣中（dragPauseRef）不接受 Undo／Redo：畫面上正在拉的卡會被反向操作換掉位置，放開時對到別的起點
  // D98 ④：佇列還有東西時照舊不接受（反向操作要等伺服器回 inverse），但會先放行等合併的批，存完就能按
  const undoStep = useCallback(() => {
    if (queueRef.current.length > 0) { flushHeld(); return }
    if (busyRef.current || dragPauseRef.current || lockRef.current.phase !== 'mine') return
    const e = undoRef.current.takeUndo()
    if (!e) return
    enqueue({ endpoint: 'placements', ops: e.ops, label: `復原：${e.label}`, mode: 'undo' })
  }, [enqueue, flushHeld])

  const redoStep = useCallback(() => {
    if (queueRef.current.length > 0) { flushHeld(); return }
    if (busyRef.current || dragPauseRef.current || lockRef.current.phase !== 'mine') return
    const e = undoRef.current.takeRedo()
    if (!e) return
    enqueue({ endpoint: 'placements', ops: e.ops, label: `重做：${e.label}`, mode: 'redo' })
  }, [enqueue, flushHeld])

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

  /** 失去編輯權（被接手／自己結束）：丟掉佇列（含還在等合併的） */
  const clearQueue = useCallback(() => {
    if (queueRef.current.length === 0) return
    queueRef.current = []
    clearHold()
    reloadOnDrainRef.current = false
    pausedRef.current = null
    setPausedState(null)
    syncPending()
    void load({ force: true })
  }, [clearHold, load, syncPending])

  /** dnd-kit 拖曳與日檢視拉卡片下緣（D69）共用：拖動中不套用輪詢結果、不接受 Undo／Redo、不送出等合併的批 */
  const setDragging = useCallback((v: boolean) => {
    dragPauseRef.current = v
    if (v) return
    const q = queueRef.current
    if (q.length > 0) {
      // D98 ④ 放開也算一次動作：最後一批（還沒送的）從現在起再等 MERGE_HOLD_MS，
      // 放開後緊接著的排入（onDragEnd 先 setDragging(false) 再 submit）才併得進來；最長仍受 MERGE_MAX_HOLD_MS 限制
      const last = q[q.length - 1]
      if (!last.sent && last.holdUntil > 0) last.holdUntil = Math.max(last.holdUntil, Date.now() + MERGE_HOLD_MS)
      // 拖曳中到期、被擋住的批：重新判斷（最前面那批已過期就送出）
      void pump()
      return
    }
    // 拖曳中有回應被擱置：放開後交給 pump 的「佇列清空」分支補抓——明確重抓（失敗還原等，reloadOnDrainRef）立刻抓，
    // 其他（輪詢、存檔後校正）停手 3 秒再抓（D98 ①）。
    // 延到這個事件處理結束（microtask）再判斷：onDragEnd 先 setDragging(false) 再 submit，放開後緊接著的排入要先進佇列——
    // 否則先發出的 GET 一回來就被新操作擋下（白抓一次），而新操作還會因為當時沒有待重抓而多等 1.5 秒合併，還原反而更晚
    queueMicrotask(() => { void pump() })
  }, [pump])

  // D98 ④ 切到背景（換分頁、縮小視窗、手機鎖屏）：還在等合併的批立刻送，不留到回來才存
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'hidden') flushHeld() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [flushHeld])

  /**
   * 佇列送完（清空）或送不動了（暫停：等重新取得編輯權、重試用盡）就 resolve；最長 SAVE_DRAIN_MAX_MS。
   * 給卸載時的 useEditLock 用（releaseAfter）：App 內換頁時先把存檔送完、再釋放編輯鎖。
   * 若兩個請求一起發出，伺服器端誰先處理不保證——釋放先到的話寫入會被拒（lock_required），而元件已卸載、
   * 使用者看不到暫停提示，等於靜默遺失；佇列裡第二批要等第一批回來才送，那時鎖幾乎一定已釋放。
   * 用輪詢而不是在 pump 各個出口通知：出口很多（成功、暫停、放棄、重試計時、401…），漏一個就會卡到上限；輪詢只看狀態，不會漏。
   */
  const whenSaved = useCallback((): Promise<void> => new Promise<void>(resolve => {
    const idle = () => !busyRef.current && (queueRef.current.length === 0 || pausedRef.current != null)
    if (idle()) { resolve(); return }
    const start = Date.now()
    const id = window.setInterval(() => {
      if (!idle() && Date.now() - start < SAVE_DRAIN_MAX_MS) return
      window.clearInterval(id)
      resolve()
    }, SAVE_DRAIN_POLL_MS)
  }), [])

  // 卸載：清掉計時器（① 停手重抓、④ 等合併），之後不再排新的。
  // ④ App 內換頁（Next Link）只會卸載、不會觸發 beforeunload 提示：還在等合併的批在這裡立刻送出。
  // 編輯鎖要等這些存檔送完才釋放（BoardLayout 把 whenSaved 交給 useEditLock 的 releaseAfter），不然兩者在伺服器端競速、寫入可能被拒。
  // 用 layout effect：cleanup 比 useEditLock 的 useEffect cleanup 早執行，whenSaved 被呼叫時寫入已經發出（順序反過來也對：輪詢會等到送完）。
  useLayoutEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      clearHold()
      clearSettle()
      flushHeld()
    }
  }, [clearHold, clearSettle, flushHeld])

  return {
    data,
    loadError,
    loading,
    lastLoadedAt,
    windowReq,
    setWindow,
    reload,
    noteExternalWrite,
    submit,
    setMinutes,
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
    whenSaved,
    toast,
    dismissToast: useCallback(() => setToast(null), []),
    showToast,
    setDragging,
  }
}

export type BoardApi = ReturnType<typeof useBoard>
