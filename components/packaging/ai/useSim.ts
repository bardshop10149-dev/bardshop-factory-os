'use client'

// AI 模擬區的資料 hook：載入／輪詢、手動操作佇列（樂觀更新＋失敗回滾）、鎖定、退回上一步、建立／重設、AI 執行與進度輪詢。
//
// 為什麼不重用正式工作台的 useBoard（規格 §八「驗證發現」）：
//   useBoard 的佇列會把拖曳送到正式 API（/api/packaging/placements，要編輯鎖），模擬區絕不能寫正式表；
//   模擬區的併發保護也不同——不是「每張卡的 version」，而是「整個模擬區一個 version」（樂觀 CAS，每次寫入 +1）。
//
// 資料流：
//   拖曳／選單 → submitOps(ops, label, 本機動作)
//     ① 先在本機套用（applyLocalToBody；跟正式工作台同一套搬卡規則，拖曳手感即時）
//     ② 放進佇列；一次只送一個請求——下一個請求要帶「上一個寫完後」的模擬區 version
//     ③ 成功：伺服器回整份 SimView（組合狀態重算過的工作台）；佇列清空時以伺服器版本為準
//     ④ 失敗：
//        version_conflict（AI 剛寫回、或同一人在別的分頁操作）→ 丟掉佇列、重新載入
//        locked／out_of_window／not_sim_row／其他驗證錯誤 → 回滾到上一次伺服器確認的畫面、顯示原因
//        網路／5xx → 1s、3s、9s 重試，仍失敗就停下來讓主管選「重試」或「放棄」
//   鎖定（D88）走同一個佇列（整份替換 locks），順序才不會亂。
//   D100：連按上移／下移時，還在排隊（尚未送出）的「只調整順序」那一批與新的一批併成一個請求（simBoard.mergeQueuedReorderOps）——
//     每個請求推一格「退回上一步」（上限 30 格），連按十幾次會把「AI 排程前」那格擠掉。
//   建立／重設、退回上一步、載入歷史、AI 排程：佇列清空才能做（要帶最新 version），做完以回應為準。
//   D101 產線時數（saveCapacity）也一樣：佇列要空、帶最新 version；但結果完整回給產能表（CapacityEditor 自己顯示錯誤、失敗不關視窗）。
//
// D110 結案（submitClosure）也走同一條佇列，而且是樂觀更新：
//   - 按下確定 → 該 SO-項次記「結案記號」，這一行的卡立刻從畫面濾掉（closureLocal.hideClosedLines；底下的資料不動）
//   - 為什麼要排進「同一條」佇列：伺服器結案時會順手把該行的模擬卡從模擬區拿掉 → 模擬區 version +1。
//     結案若在佇列外面送，佇列裡下一個拖曳帶的還是舊 version → 撞 version_conflict → 整個佇列被丟掉、
//     畫面回滾到「結案前」的伺服器畫面（已結案的卡又出現）。排在同一條佇列、成功後用回應的 simVersion 接下去就不會撞。
//   - 成功（含 409 本來就結案了）→ 記號改 confirmed；失敗 → 拿掉記號（卡片回原位）＋錯誤提示，後面的操作照常送
//   - 記號要到伺服器回來的畫面「本身已不含該行」才拿掉（輪詢／較早發出的回應晚到也不會把卡帶回來）
//
// 「過時回應」防護（同 useBoard）：GET 發出時記下 genRef，回來時若已有新寫入＝寫入前的快照 → 丟掉再抓。
// AI 執行（§4.1）：POST run 只回 runId，實際在伺服器背景跑；這裡每 AI_POLL_MS（3 秒）GET runs/[id]，
//   結束（done／failed）就重新載入模擬區並通知畫面打開結果面板。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AI_POLL_MS,
  SIM_MAX_OPS_PER_REQUEST,
  type AiRunDetail,
  type SimCreateRequest,
  type SimLocks,
  type SimView,
  type SimViewResponse,
} from '@/lib/packaging/ai/types'
import type { CapacityInput, PlacementOp } from '@/lib/packaging/scheduleTypes'
import type { LocalAction } from '@/components/packaging/board/boardLocal'
import {
  createSim,
  fetchRun,
  fetchSim,
  postLoadRun,
  postSimLocks,
  postSimCapacity,
  postSimClear,
  postSimOps,
  postSimPullLive,
  postSimRun,
  postSimRunCancel,
  postClosure,
  postSimUndo,
  type AiApiResult,
} from './simApi'
import {
  classifyCloseResult,
  closeRequestOf,
  hideClosedLines,
  type CloseOutcome,
  type ClosureIntent,
} from '@/components/packaging/board/closureLocal'
import { useClosedMarks } from '@/components/packaging/board/useClosures'
import { mergeLabels } from '@/components/packaging/board/queueMerge'
import { applyLocalToBody, applyLocalToSimCards, mergeQueuedReorderOps, withLocks } from './simBoard'
import { RUN_ERROR_LABEL } from './simText'

export interface SimToast {
  id: number
  kind: 'info' | 'warn' | 'error'
  text: string
}

export interface SimLoadError {
  message: string
  missingTable: boolean
  code: string | null
  at: number
}

type NewQueueItem =
  | { kind: 'ops'; ops: PlacementOp[]; label: string }
  | { kind: 'locks'; locks: SimLocks; label: string }
  /** D110 結案（不帶模擬區 version；成功後用回應的 simVersion 更新） */
  | { kind: 'closure'; intent: ClosureIntent; label: string }
/** labels：D100 併進這一批的各次操作標籤（合併後的標籤由它重組，不會越併越長巢狀） */
type QueueItem = NewQueueItem & { key: number; attempts: number; labels?: string[] }

/** 網路錯誤／5xx 的重試間隔（同正式工作台 1s、3s、9s） */
const RETRY_DELAYS = [1000, 3000, 9000]
/** 平常（沒有 AI 在跑）多久重抓一次模擬區：待排池會隨到貨／報工變動 */
const VIEW_POLL_MS = 60_000

type ViewResp = Extract<SimViewResponse, { success: true }>

/** D110 結案的結果（給畫面：更新結案池清單、提示） */
export type SimClosureEvent =
  | { ok: true; intent: ClosureIntent; outcome: Extract<CloseOutcome, { kind: 'closed' }> }
  | { ok: false; intent: ClosureIntent; message: string }

export function useSim(opts: {
  enabled: boolean
  /** 看誰的模擬區；null＝自己 */
  owner: string | null
  onUnauthorized: () => void
  onForbidden: () => void
  /** AI 執行結束（done／failed） */
  onRunFinished?: (run: AiRunDetail) => void
  /** D110 結案送完（成功、本來就結案了、或失敗已把卡放回原位）；提示文字由這裡的 hook 負責，畫面只需更新結案池清單 */
  onClosureSettled?: (ev: SimClosureEvent) => void
}) {
  const { enabled, owner } = opts
  const [view, setView] = useState<SimView | null>(null)
  const [loadError, setLoadError] = useState<SimLoadError | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)
  const [serverOffsetMs, setServerOffsetMs] = useState(0)

  const [pending, setPending] = useState(0)
  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<{ message: string; count: number } | null>(null)
  /** 佇列以外的動作進行中（建立／重設、退回、載入歷史、AI 排程）；值＝畫面顯示的文字 */
  const [action, setAction] = useState<string | null>(null)
  const [toast, setToast] = useState<SimToast | null>(null)

  /** 目前輪詢中的 AI 執行 */
  const [pollRunId, setPollRunId] = useState<number | null>(null)
  /** 最近一次取得的 AI 執行詳情（輪詢中＝進度；結束＝結果） */
  const [run, setRun] = useState<AiRunDetail | null>(null)
  const [runLoading, setRunLoading] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  const viewRef = useRef<SimView | null>(null)
  /** 最後一次伺服器確認過的畫面（失敗回滾用） */
  const serverViewRef = useRef<SimView | null>(null)
  /** 最後一次伺服器確認過的模擬區 version（下一個寫入帶它） */
  const versionRef = useRef<number | null>(null)
  const queueRef = useRef<QueueItem[]>([])
  const keyRef = useRef(0)
  const busyRef = useRef(false)
  const actionRef = useRef(false)
  const pausedRef = useRef<null | 'error'>(null)
  const dirtyRef = useRef(false)
  const loadingRef = useRef(false)
  const reloadAgainRef = useRef(false)
  const genRef = useRef(0)
  const lastLoadRef = useRef(0)
  const dragPauseRef = useRef(false)
  const ownerRef = useRef(owner)
  const pollRunRef = useRef<number | null>(null)
  const cbRef = useRef(opts)
  useEffect(() => { cbRef.current = opts })
  /** D110 結案記號（pending／confirmed）：畫面用它把已結案的行濾掉 */
  const closedMarks = useClosedMarks()
  const { has: hasClosedMark, mark: markClosed, clear: clearClosedMark, prune: pruneClosedMarks } = closedMarks

  const showToast = useCallback((kind: SimToast['kind'], text: string) => {
    setToast({ id: Date.now() + Math.random(), kind, text })
  }, [])

  const setViewBoth = useCallback((v: SimView | null) => {
    viewRef.current = v
    setView(v)
  }, [])

  const startPolling = useCallback((id: number) => {
    if (pollRunRef.current === id) return
    pollRunRef.current = id
    setPollRunId(id)
  }, [])

  /** 伺服器回來的完整模擬區（GET 或寫入回應）：畫面、回滾基準、version 一起換 */
  const acceptView = useCallback((v: ViewResp) => {
    serverViewRef.current = v
    versionRef.current = v.session?.version ?? null
    setViewBoth(v)
    const st = Date.parse(v.serverTime)
    if (Number.isFinite(st)) setServerOffsetMs(st - Date.now())
    // 逾時（stale：超過 AI_RUN_STALE_MS 仍 running，背景執行多半已中斷）不輪詢——否則會永遠輪詢下去、畫面永遠顯示執行中
    if (v.runningRun && v.runningRun.status === 'running' && !v.runningRun.stale) startPolling(v.runningRun.id)
  }, [setViewBoth, startPolling])

  // ── 載入 ──────────────────────────────────────────────────────────────
  const load = useCallback(async (): Promise<void> => {
    if (loadingRef.current) { reloadAgainRef.current = true; return }
    loadingRef.current = true
    setLoading(true)
    try {
      const gen = genRef.current
      const who = ownerRef.current
      const r = await fetchSim(who)
      if (r.status === 401) { cbRef.current.onUnauthorized(); return }
      if (r.status === 403) { cbRef.current.onForbidden(); return }
      if (r.json && r.json.success) {
        lastLoadRef.current = Date.now()
        // 發出後換了檢視對象／有新寫入（已排入或已寫完）→ 這份是舊的，丟掉再抓
        if (who !== ownerRef.current || genRef.current !== gen) { reloadAgainRef.current = true; return }
        // 佇列或其他動作進行中、拖曳中：不蓋掉樂觀更新，之後補抓
        if (queueRef.current.length > 0 || busyRef.current || actionRef.current || dragPauseRef.current) { dirtyRef.current = true; return }
        acceptView(r.json)
        setLoadError(null)
        setLastLoadedAt(Date.now())
        return
      }
      setLoadError({ message: r.error ?? '載入失敗', missingTable: r.missingTable, code: r.code, at: Date.now() })
    } finally {
      loadingRef.current = false
      setLoading(false)
      if (reloadAgainRef.current) {
        reloadAgainRef.current = false
        void load()
      }
    }
  }, [acceptView])

  const reload = useCallback(() => load(), [load])

  // 換檢視對象（看自己／看別人的模擬區）：清掉畫面與佇列後重抓；第一次掛載只載入
  useEffect(() => {
    const changed = ownerRef.current !== owner
    ownerRef.current = owner
    if (changed) {
      genRef.current++
      // D110：還沒送出的結案一併取消——記號要拿掉，否則卡片被藏起來、卻從來沒有真的結案
      //（已送出的那一個照常完成：pump 會認出它已不在佇列裡，不去動換人之後的 version）
      for (const it of queueRef.current) {
        if (it.kind === 'closure' && !(busyRef.current && it === queueRef.current[0])) clearClosedMark(it.intent.soLineKey)
      }
      queueRef.current = []
      pausedRef.current = null
      serverViewRef.current = null
      versionRef.current = null
      viewRef.current = null
      pollRunRef.current = null
    }
    if (enabled) void load()
    if (!changed) return
    // 畫面狀態清空放在下一個 tick（effect 內同步 setState 會多一次連鎖重畫）；新資料若已先到（viewRef 有值）就不清
    const id = window.setTimeout(() => {
      if (viewRef.current == null) setView(null)
      setPollRunId(null)
      setRun(null)
      setPending(0)
      setSaveError(null)
    }, 0)
    return () => window.clearTimeout(id)
  }, [enabled, owner, load, clearClosedMark])

  // 平常 60 秒重抓；背景分頁暫停，回到前景若已超過就立刻補抓
  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      if (queueRef.current.length > 0 || busyRef.current || actionRef.current || dragPauseRef.current) return
      void load()
    }
    const id = window.setInterval(tick, VIEW_POLL_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoadRef.current > VIEW_POLL_MS) tick()
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

  /**
   * 丟掉佇列。rollback：畫面回到最後一次伺服器確認的狀態；reload：再向伺服器重抓一次。
   */
  const dropAll = useCallback((msg: string | null, kind: SimToast['kind'], how: { rollback?: boolean; reload?: boolean }) => {
    const n = queueRef.current.length
    // D110：被丟掉的結案（還沒送出）＝沒有結成 → 記號拿掉，卡片回原位
    for (const it of queueRef.current) if (it.kind === 'closure') clearClosedMark(it.intent.soLineKey)
    queueRef.current = []
    pausedRef.current = null
    setSaveError(null)
    syncPending()
    dirtyRef.current = false
    if (how.rollback && serverViewRef.current) setViewBoth(serverViewRef.current)
    if (msg) showToast(kind, n > 1 ? `${msg}（另有 ${n - 1} 個後續操作已取消）` : msg)
    if (how.reload) void load()
  }, [clearClosedMark, load, setViewBoth, showToast, syncPending])

  /**
   * D110：伺服器剛改過模擬區、但沒告訴我們新 version（409 本來就結案了、附帶清理沒做完、舊版伺服器）→ 自己讀一次。
   * 只拿「回滾基準」與 version；畫面維持現在的（佇列裡還沒送出的操作已經樂觀套用在上面）。讀不到就算了——
   * 下一個操作若撞 version_conflict，既有流程會重新載入。
   */
  const resyncVersion = useCallback(async (): Promise<void> => {
    const who = ownerRef.current
    const r = await fetchSim(who)
    if (!(r.json && r.json.success) || who !== ownerRef.current || !r.json.isOwner) return
    const v = r.json
    serverViewRef.current = v
    versionRef.current = v.session?.version ?? null
    const cur = viewRef.current
    if (cur && v.session) setViewBoth({ ...cur, session: { ...v.session, locks: cur.session?.locks ?? v.session.locks } })
  }, [setViewBoth])

  const pump = useCallback(async (): Promise<void> => {
    if (busyRef.current || pausedRef.current) return
    const item = queueRef.current[0]
    if (!item) {
      if (dirtyRef.current) {
        dirtyRef.current = false
        void load()
      }
      return
    }

    // ── D110 結案：不帶模擬區 version；成功後接上伺服器回的新 version ──
    if (item.kind === 'closure') {
      const who = ownerRef.current
      busyRef.current = true
      setSaving(true)
      let out: CloseOutcome
      try {
        out = classifyCloseResult(await postClosure(closeRequestOf(item.intent)), item.attempts)
        // 送出期間換了檢視對象＝viewRef／versionRef 已是別人那一份的，不可以動
        const mine = who === ownerRef.current
        if (out.kind === 'closed' && mine) {
          genRef.current++
          if (typeof out.simVersion === 'number') {
            const ver = out.simVersion
            versionRef.current = ver
            const bump = (x: SimView | null): SimView | null => (x && x.session ? { ...x, session: { ...x.session, version: ver } } : x)
            serverViewRef.current = bump(serverViewRef.current)
            setViewBoth(bump(viewRef.current))
          } else if (out.simVersion === undefined) {
            await resyncVersion()
          }
        }
      } finally {
        busyRef.current = false
        setSaving(false)
      }
      if (out.kind === 'retry') {
        if (queueRef.current[0] !== item) { clearClosedMark(item.intent.soLineKey); return pump() }
        item.attempts++
        window.setTimeout(() => { void pump() }, out.delayMs)
        return
      }
      if (queueRef.current[0] === item) {
        queueRef.current.shift()
        syncPending()
      }
      const label = item.intent.label
      if (out.kind === 'closed') {
        markClosed(item.intent.soLineKey, 'confirmed')
        setLastSavedAt(Date.now())
        // 佇列清空後重抓一次：校正伺服器才算得出的部分（產能負荷、待排池數量）。畫面上的卡不靠這次重抓拿掉
        dirtyRef.current = true
        if (out.warning) showToast('warn', `${label}：${out.warning}`)
        else if (out.already) showToast('info', `${label} 本來就已經結案（可能是別人剛結的），已從畫面移除`)
        else showToast('info', `已結案 ${label}${out.simRemoved > 0 ? `，模擬區移除 ${out.simRemoved} 張卡` : ''}${out.unplaced > 0 ? `，正式排程放回 ${out.unplaced} 張` : ''}（可在「結案池」復原）`)
        cbRef.current.onClosureSettled?.({ ok: true, intent: item.intent, outcome: out })
      } else {
        // 失敗：拿掉記號＝卡片回到原位（底下的資料沒動過）；後面排隊的操作與這次結案無關，照常送
        clearClosedMark(item.intent.soLineKey)
        if (out.kind === 'unauthorized') { cbRef.current.onUnauthorized(); return }
        showToast('error', `結案失敗：${label} 的卡片已放回原位（${out.message}）`)
        cbRef.current.onClosureSettled?.({ ok: false, intent: item.intent, message: out.message })
      }
      return pump()
    }

    const version = versionRef.current
    if (version == null) {
      dropAll('模擬區尚未建立或已不存在，操作未儲存', 'warn', { rollback: true, reload: true })
      return
    }
    busyRef.current = true
    setSaving(true)
    let r: AiApiResult<SimViewResponse>
    try {
      r = item.kind === 'ops'
        ? await postSimOps({ version, ops: item.ops, label: item.label })
        : await postSimLocks({ version, locks: item.locks })
    } finally {
      busyRef.current = false
      setSaving(false)
    }

    const ok = r.json && r.json.success ? r.json : null
    if (ok) {
      genRef.current++
      serverViewRef.current = ok
      versionRef.current = ok.session?.version ?? null
      queueRef.current.shift()
      syncPending()
      setLastSavedAt(Date.now())
      setSaveError(null)
      if (queueRef.current.length === 0) {
        setViewBoth(ok)
      } else {
        // 後面還有操作：畫面保留樂觀狀態（含尚未送出的變更），只更新模擬區的版本與退回清單；
        // 鎖定以畫面上的（最新意圖）為準
        const cur = viewRef.current
        if (cur && ok.session) setViewBoth({ ...cur, session: { ...ok.session, locks: cur.session?.locks ?? ok.session.locks } })
      }
      return pump()
    }

    // ── 失敗 ──
    if (r.status === 401) { cbRef.current.onUnauthorized(); return }
    const code = r.code
    if (r.missingTable) { dropAll(r.error, 'error', { rollback: true, reload: true }); return }
    if (code === 'version_conflict' || code === 'no_session' || code === 'session_stale' || code === 'not_owner') {
      dropAll(
        code === 'version_conflict'
          ? '模擬區剛被其他操作更新過（AI 剛寫回，或你在另一個分頁操作），已重新載入'
          : (r.error ?? '模擬區狀態已改變，已重新載入'),
        'warn',
        { rollback: true, reload: true },
      )
      return
    }
    const transient = r.network || (r.status >= 500 && r.status !== 501 && code !== 'pool_unavailable')
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
    // 驗證錯誤（鎖定、範圍外、守恆、D22…）：回滾並顯示伺服器的說明
    dropAll(r.error ?? '操作未通過驗證', 'error', { rollback: true, reload: code === 'pool_unavailable' })
  }, [clearClosedMark, dropAll, load, markClosed, resyncVersion, setViewBoth, showToast, syncPending])

  const enqueue = useCallback((item: NewQueueItem) => {
    genRef.current++
    const q = queueRef.current
    const last = q[q.length - 1]
    // D100：佇列第 2 個以後的項目一定還沒送出過（pump 一次只送第 1 個；第 1 個可能正在送、或送過正在等重試 → 絕不改它）。
    //   新的一批與最後一批都只有 reorder → 併成一批（同一張卡後者覆蓋；模擬列版本固定 1，不會衝突）
    if (item.kind === 'ops' && q.length >= 2 && last && last.kind === 'ops') {
      const merged = mergeQueuedReorderOps(last.ops, item.ops, SIM_MAX_OPS_PER_REQUEST)
      if (merged) {
        const labels = [...(last.labels ?? [last.label]), item.label]
        last.ops = merged
        last.labels = labels
        last.label = mergeLabels(labels)
        syncPending()
        return
      }
    }
    q.push({ ...item, key: ++keyRef.current, attempts: 0 })
    syncPending()
    void pump()
  }, [pump, syncPending])

  const canWrite = useCallback((): boolean => {
    const v = viewRef.current
    if (!v || !v.isOwner) { showToast('warn', '這是別人的模擬區，只能檢視'); return false }
    if (!v.session) { showToast('warn', '請先建立模擬區'); return false }
    if (actionRef.current) { showToast('warn', '請等目前的動作完成'); return false }
    return true
  }, [showToast])

  /** 模擬區手動操作（D77）：本機先套用，再排進佇列送出 */
  const submitOps = useCallback((ops: PlacementOp[], label: string, locals: LocalAction[]) => {
    if (ops.length === 0 || !canWrite()) return
    const cur = viewRef.current
    if (cur?.board && locals.length > 0) {
      setViewBoth({ ...cur, board: applyLocalToBody(cur.board, locals), simCards: applyLocalToSimCards(cur.simCards, locals) })
    }
    enqueue({ kind: 'ops', ops, label: label.slice(0, 120) })
  }, [canWrite, enqueue, setViewBoth])

  /** 鎖定（D88）：整份替換；畫面立刻反映（灰底＋🔒） */
  const submitLocks = useCallback((locks: SimLocks, label: string) => {
    if (!canWrite()) return
    const cur = viewRef.current
    if (cur) setViewBoth(withLocks(cur, locks))
    enqueue({ kind: 'locks', locks, label })
  }, [canWrite, enqueue, setViewBoth])

  /**
   * D110 結案（樂觀更新）：立刻記 pending（這一行的卡從畫面消失）、排進佇列依序送出；可以連續結好幾張。
   * 回 false＝沒排進去（別人的模擬區、其他動作進行中、這一行已在結案中）——原因已用 toast 說明。
   */
  const submitClosure = useCallback((intent: ClosureIntent): boolean => {
    const v = viewRef.current
    if (!v || !v.isOwner) { showToast('warn', '請回到自己的模擬區再結案（結案會動到正式區與所有人的模擬區）'); return false }
    if (actionRef.current) { showToast('warn', '請等目前的動作完成'); return false }
    if (hasClosedMark(intent.soLineKey)) { showToast('info', `${intent.label} 已在結案中`); return false }
    markClosed(intent.soLineKey, 'pending')
    enqueue({ kind: 'closure', intent, label: `結案 ${intent.label}` })
    return true
  }, [enqueue, hasClosedMark, markClosed, showToast])

  const retryNow = useCallback(() => {
    for (const it of queueRef.current) it.attempts = 0
    pausedRef.current = null
    setSaveError(null)
    void pump()
  }, [pump])

  const discardQueue = useCallback(() => dropAll('已放棄未儲存的操作', 'warn', { rollback: true, reload: true }), [dropAll])

  /** 拖曳／拉下緣中：不套用輪詢結果（DragOverlay 與放置目標要和畫面一致） */
  const setDragging = useCallback((v: boolean) => {
    dragPauseRef.current = v
    if (!v && dirtyRef.current && queueRef.current.length === 0 && !busyRef.current) {
      dirtyRef.current = false
      void load()
    }
  }, [load])

  // ── 佇列以外的動作（要帶最新 version，佇列必須是空的） ─────────────────────
  const runAction = useCallback(async (
    label: string,
    fn: (version: number | null) => Promise<AiApiResult<SimViewResponse>>,
    opt: { needSession?: boolean; successMsg?: string } = {},
  ): Promise<boolean> => {
    const v = viewRef.current
    if (!v || !v.isOwner) { showToast('warn', '這是別人的模擬區，只能檢視'); return false }
    if (opt.needSession !== false && !v.session) { showToast('warn', '請先建立模擬區'); return false }
    if (queueRef.current.length > 0 || busyRef.current) { showToast('warn', '還有操作儲存中，請稍候再試'); return false }
    if (actionRef.current) { showToast('warn', '請等目前的動作完成'); return false }
    actionRef.current = true
    setAction(label)
    try {
      const r = await fn(versionRef.current)
      if (r.status === 401) { cbRef.current.onUnauthorized(); return false }
      if (r.json && r.json.success) {
        genRef.current++
        const { notice, ...view } = r.json
        acceptView(view)
        setLastSavedAt(Date.now())
        // 伺服器附了提醒（例：退回的那一步是舊版程式記錄的，時數無法還原）→ 以警告取代成功訊息，不能被「已退回」蓋掉
        if (notice) showToast('warn', notice)
        else if (opt.successMsg) showToast('info', opt.successMsg)
        return true
      }
      if (r.code === 'version_conflict') {
        showToast('warn', '模擬區剛被其他操作更新過（AI 剛寫回，或你在另一個分頁操作），已重新載入，請再試一次')
        void load()
        return false
      }
      showToast(r.missingTable ? 'error' : 'warn', r.error ?? `${label}失敗`)
      if (r.code === 'no_session' || r.code === 'session_exists') void load()
      return false
    } finally {
      actionRef.current = false
      setAction(null)
      if (dirtyRef.current) { dirtyRef.current = false; void load() }
    }
  }, [acceptView, load, showToast])

  /** 建立或重設（§三；重設會先把舊狀態推進 undo，可退回） */
  const createOrReset = useCallback((req: Omit<SimCreateRequest, 'version'>) => {
    const had = !!viewRef.current?.session
    return runAction(had ? '重設模擬區' : '建立模擬區', version => createSim({ ...req, version: had ? version : null }), {
      needSession: false,
      successMsg: had ? '模擬區已重設（按「退回上一步」可回到重設前）' : '模擬區已建立',
    })
  }, [runAction])

  /** D106 ① 一鍵清空模擬區排程（產線時數覆寫保留；伺服器清空前先推 undo） */
  const clearAll = useCallback(() => {
    const n = viewRef.current?.session?.placementCount ?? 0
    return runAction('清空模擬區排程', version => postSimClear({ version: version ?? 0 }), {
      successMsg: `已清空模擬區排程（${n} 張；產線時數保留，按「退回上一步」可回來）`,
    })
  }, [runAction])

  /** D106 ② 拉正式區 1:1（覆蓋模擬列、產能覆寫回到正式值；伺服器執行前先推 undo）。「已有內容先確認」由畫面做 */
  const pullLive = useCallback(() => {
    return runAction('拉正式區 1:1', version => postSimPullLive({ version: version ?? 0 }), {
      successMsg: '已把正式排程與各線產能 1:1 拉進模擬區（按「退回上一步」可回到拉之前）',
    })
  }, [runAction])

  /** 退回上一步（D77；整份快照還原） */
  const undoStep = useCallback(() => {
    const label = viewRef.current?.session?.undo.at(-1)?.label
    return runAction('退回上一步', version => postSimUndo({ version: version ?? 0 }), {
      successMsg: label ? `已退回：${label}` : '已退回上一步',
    })
  }, [runAction])

  /**
   * D101 模擬區調整產線時數（產能表的「儲存」）。規則同 runAction（本人、佇列清空、帶最新 version、一次一個動作），
   * 但錯誤不 toast、原樣回傳——產能表對話框自己顯示在底部，而且失敗時使用者的輸入要留著（不能關視窗）。
   * 成功時以回應為準（acceptView：工作台負荷條與產能表一起更新）；version_conflict → 重新載入。
   */
  const saveCapacity = useCallback(async (req: { rows: CapacityInput[] } | { clearAll: true }): Promise<AiApiResult<SimViewResponse>> => {
    const local = (error: string): AiApiResult<SimViewResponse> => ({ status: 0, json: null, error, code: 'client', missingTable: false, network: false })
    const v = viewRef.current
    if (!v || !v.isOwner) return local('這是別人的模擬區，只能檢視')
    if (!v.session) return local('請先建立模擬區')
    if (queueRef.current.length > 0 || busyRef.current) return local('還有操作儲存中，請稍候再按儲存')
    if (actionRef.current) return local('請等目前的動作完成再儲存')
    actionRef.current = true
    setAction('儲存模擬產線時數')
    try {
      const r = await postSimCapacity({ version: versionRef.current ?? 0, ...req })
      if (r.status === 401) { cbRef.current.onUnauthorized(); return r }
      if (r.json && r.json.success) {
        genRef.current++
        acceptView(r.json)
        setLastSavedAt(Date.now())
        return r
      }
      if (r.code === 'version_conflict') {
        void load()
        return { ...r, error: '模擬區剛被其他操作更新過（AI 剛寫回，或你在另一個分頁操作），已重新載入；請關閉後重新開啟產能表再改' }
      }
      return r
    } finally {
      actionRef.current = false
      setAction(null)
      if (dirtyRef.current) { dirtyRef.current = false; void load() }
    }
  }, [acceptView, load])

  /** 把某次 AI 的結果（result）或 AI 前狀態（base）載入模擬區（先推 undo） */
  const loadRun = useCallback((runId: number, which: 'result' | 'base') => {
    return runAction('載入歷史結果', version => postLoadRun({ version: version ?? 0, runId, which }), {
      successMsg: which === 'result' ? `已載入 AI 第 #${runId} 次的結果（按「退回上一步」可回到載入前）` : `已載入第 #${runId} 次 AI 執行前的狀態`,
    })
  }, [runAction])

  /** AI 排程（§4.1）：成功只拿到 runId，之後輪詢進度 */
  const startRun = useCallback(async (): Promise<boolean> => {
    const v = viewRef.current
    if (!v || !v.isOwner || !v.session) { showToast('warn', '請先建立模擬區'); return false }
    if (queueRef.current.length > 0 || busyRef.current) { showToast('warn', '還有操作儲存中，請稍候再試'); return false }
    if (actionRef.current) { showToast('warn', '請等目前的動作完成'); return false }
    actionRef.current = true
    setAction('送出 AI 排程')
    try {
      const r = await postSimRun({ version: versionRef.current ?? 0 })
      if (r.status === 401) { cbRef.current.onUnauthorized(); return false }
      if (r.json && r.json.success) {
        const runId = r.json.runId
        const nowIso = new Date().toISOString()
        const cur = viewRef.current
        if (cur) setViewBoth({ ...cur, runningRun: { id: runId, status: 'running', phase: 'preparing', startedAt: nowIso, elapsedMs: 0, stale: false, estimate: null } })
        setRun(null)
        setRunError(null)
        startPolling(runId)
        return true
      }
      if (r.code === 'run_in_progress') {
        showToast('warn', r.error ?? '已有 AI 正在執行，改為顯示它的進度')
        void load()
        return false
      }
      if (r.code === 'version_conflict') {
        showToast('warn', '模擬區剛被更新過，已重新載入，請再按一次 AI 排程')
        void load()
        return false
      }
      const msg = r.code === 'ai_not_configured' ? (r.error ?? RUN_ERROR_LABEL.ai_not_configured) : (r.error ?? 'AI 排程無法開始')
      showToast(r.code === 'throttled' ? 'warn' : 'error', msg)
      return false
    } finally {
      actionRef.current = false
      setAction(null)
      // D110：送出期間回來的重抓結果被擱置（load 看到 actionRef 就只標 dirty）→ 這裡補抓，同 runAction／saveCapacity
      if (dirtyRef.current) { dirtyRef.current = false; void load() }
    }
  }, [load, setViewBoth, showToast, startPolling])

  // ── AI 執行進度輪詢 ─────────────────────────────────────────────────────
  useEffect(() => {
    if (pollRunId == null) return
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      const r = await fetchRun(pollRunId)
      if (!alive) return
      if (r.json && r.json.success) {
        const detail = r.json.run
        setRun(detail)
        setRunError(null)
        if (detail.status !== 'running') {
          pollRunRef.current = null
          setPollRunId(null)
          const cur = viewRef.current
          if (cur) setViewBoth({ ...cur, runningRun: null })
          void load()
          cbRef.current.onRunFinished?.(detail)
          return
        }
        if (detail.stale) {
          // 超過 AI_RUN_STALE_MS 仍 running：背景執行多半已中斷 → 停止輪詢、不再當「執行中」（畫面解除封鎖，可重新按 AI 排程）
          pollRunRef.current = null
          setPollRunId(null)
          const cur = viewRef.current
          if (cur) {
            setViewBoth({
              ...cur,
              runningRun: { id: detail.id, status: detail.status, phase: detail.phase, startedAt: detail.startedAt, elapsedMs: detail.elapsedMs, stale: true, estimate: detail.estimate },
            })
          }
          return
        }
        const cur = viewRef.current
        if (cur) {
          setViewBoth({
            ...cur,
            runningRun: { id: detail.id, status: detail.status, phase: detail.phase, startedAt: detail.startedAt, elapsedMs: detail.elapsedMs, stale: false, estimate: detail.estimate },
          })
        }
      } else if (r.status === 401) {
        cbRef.current.onUnauthorized()
        return
      } else if (r.status === 404 || r.missingTable) {
        pollRunRef.current = null
        setPollRunId(null)
        setRunError(r.error ?? '找不到這次 AI 執行紀錄')
        return
      }
      // 網路錯誤等：下一輪再試
      timer = window.setTimeout(() => { void tick() }, AI_POLL_MS)
    }
    timer = window.setTimeout(() => { void tick() }, 800)
    return () => {
      alive = false
      if (timer != null) window.clearTimeout(timer)
    }
  }, [pollRunId, load, setViewBoth])

  /** 打開某次 AI 執行的結果（歷史、上次結果） */
  const openRun = useCallback(async (id: number) => {
    setRunLoading(true)
    setRunError(null)
    try {
      const r = await fetchRun(id)
      if (r.json && r.json.success) {
        setRun(r.json.run)
        if (r.json.run.status === 'running' && !r.json.run.stale) startPolling(r.json.run.id)
      } else {
        setRunError(r.error ?? '讀取 AI 執行紀錄失敗')
      }
    } finally {
      setRunLoading(false)
    }
  }, [startPolling])

  /**
   * 取消執行中的 AI 排程（POST runs/[id]/cancel）。成功＝伺服器已把 run 標成「已取消」：先停輪詢（避免 3 秒空窗）、清 runningRun、
   * 把回應的 run 當結果（onRunFinished 自動開結果抽屜，沿用既有路徑）。已消耗的 AI 用量仍會計費；60 秒節流照舊（取消不退費）。
   * run_not_running＝送出時 AI 剛好結束 → 改為顯示它的結果。
   */
  const cancelRun = useCallback(async (runId: number): Promise<boolean> => {
    if (actionRef.current) { showToast('warn', '請等目前的動作完成'); return false }
    actionRef.current = true
    setAction('取消 AI 排程')
    try {
      const r = await postSimRunCancel(runId)
      if (r.status === 401) { cbRef.current.onUnauthorized(); return false }
      if (r.json && r.json.success) {
        const detail = r.json.run
        pollRunRef.current = null
        setPollRunId(null)
        const cur = viewRef.current
        if (cur) setViewBoth({ ...cur, runningRun: null })
        setRun(detail)
        setRunError(null)
        void load()
        showToast('info', `已取消 AI 排程 #${runId}（已消耗的 AI 用量仍會計費；60 秒內再按「AI 排程」會被節流）`)
        cbRef.current.onRunFinished?.(detail)
        return true
      }
      if (r.code === 'run_not_running') {
        showToast('warn', 'AI 剛好已經結束，改為顯示結果')
        pollRunRef.current = null
        setPollRunId(null)
        void load()
        void openRun(runId)
        return true
      }
      showToast('error', r.error ?? '取消 AI 排程失敗')
      return false
    } finally {
      actionRef.current = false
      setAction(null)
      if (dirtyRef.current) { dirtyRef.current = false; void load() }
    }
  }, [load, openRun, setViewBoth, showToast])

  // D110：畫面用的 view＝濾掉有結案記號的行；viewRef／serverViewRef（樂觀更新與回滾的基準）不動
  const shownView = useMemo<SimView | null>(() => {
    if (!view || !view.board) return view
    const board = hideClosedLines(view.board, closedMarks.marks)
    return board === view.board ? view : { ...view, board }
  }, [view, closedMarks.marks])
  // 伺服器回來的畫面本身已不含該行 → 記號功成身退
  useEffect(() => { if (view?.board) pruneClosedMarks(view.board) }, [view, pruneClosedMarks])

  return {
    view: shownView,
    /** D110 結案（樂觀更新＋佇列）；見 submitClosure */
    submitClosure,
    /** D110 復原結案後：拿掉這一行的結案記號（卡片才回得來） */
    unhideLine: clearClosedMark,
    loadError,
    loading,
    lastLoadedAt,
    serverOffsetMs,
    reload,
    pending,
    saving,
    lastSavedAt,
    saveError,
    retryNow,
    discardQueue,
    action,
    submitOps,
    submitLocks,
    createOrReset,
    clearAll,
    pullLive,
    undoStep,
    loadRun,
    startRun,
    cancelRun,
    run,
    runLoading,
    runError,
    openRun,
    polling: pollRunId != null,
    /** 最新確認過的模擬區 version（採用要帶） */
    getVersion: useCallback(() => versionRef.current, []),
    /** D101 最新的畫面（產能表從這裡讀模擬值：儲存成功後 acceptView 已更新，不必再發請求） */
    getView: useCallback(() => viewRef.current, []),
    saveCapacity,
    /** 佇列是否清空（採用前要確認） */
    isIdle: useCallback(() => queueRef.current.length === 0 && !busyRef.current && !actionRef.current, []),
    setDragging,
    toast,
    showToast,
    dismissToast: useCallback(() => setToast(null), []),
  }
}

export type SimApi = ReturnType<typeof useSim>
