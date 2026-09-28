'use client'

// AI 模擬排程頁（P3，規格 §八；D77／D78／D83／D88）：與排程工作台相同版面的獨立空間。
//   建立（複製／清空）→ 鎖定不想動的卡／訂單／線 → AI 排程 → 主管在模擬區調整 → 退回上一步 → 採用此版排程
//
// 元件分工：
//   SimLayout（本檔）：工具列、檢視（日／全部天數）、拖放 → 模擬區操作（op）轉換、鎖定模式、對話框與抽屜開關
//   useSim：載入／輪詢、操作佇列（樂觀更新＋失敗回滾）、鎖定、退回、AI 執行輪詢
//   simBoard：鎖定判斷、顯示用標記（🔒／〔AI〕／〔正式〕）、樂觀更新包裝
//   重用正式工作台的「純顯示」元件：DayLanesView／MultiDayView（卡片、時間尺、負荷條）、PoolSidebar（待排池）、ParkingArea（待排區，唯讀）
//   ⚠ PoolSidebar 不傳任何手動參數（manual／showManualTag／manualManageHref）：模擬區不能加單（D102 起加單入口只在待排池頁，
//   PoolSidebar 已沒有「＋加入訂單」，但也不放「到待排池頁」連結，免得在模擬區引人去改正式供給）；
//   useBoard／BoardLayout 的「拖曳 → 正式 API」邏輯不重用（規格 §八）。
//
// 模擬區裡的卡分兩種（SimView.simCards）：
//   模擬列（可動、可鎖）＝範圍內（模擬日期 × 建立時啟用的線）、未完成；
//   正式區唯讀列＝已完成、延誤順延、範圍外的線、待排區——照樣顯示、照樣佔產能，但模擬區與 AI 都不動它。
// 拖放規則（伺服器 applySimOps 會再驗一次，這裡先擋、講清楚原因）：
//   只能排進模擬範圍內的日期與線；鎖定的卡／訂單／線不能動；沒有待排區（要先不排＝拖回待排池）；不能勾完成。
// D100（與正式工作台一致）：
//   - 「全部 N 天」檢視也能線內拖曳插隊（原本只有日檢視；Snow 在全部天數檢視拖回自己那格＝moveCard 同日同線直接 return，看起來拖不動）。
//     插入點：日＝時間尺 y、全部天數＝量清單 DOM（laneDrag，限定 .sim-board 底下）；要改哪些卡＝simBoard.simLaneReorder
//     （先整條線含唯讀卡 → 結果和插入線一致；要整條重新編號而碰到唯讀卡／鎖定卡時改用 planLaneReorderAnchored：它們當固定錨點、值不改，插入線畫在實際落點；做不到就不畫插入線、放下時說明原因）。
//   - 卡片詳情加「上移／下移」（simLaneStep），停用時說明原因（唯讀卡、鎖定、別人的模擬區、起始日已過、鎖定模式…）。
//   - 工時：卡片上顯示「工時 X.Xh」可點（MinutesChip），詳情工時段在最上面（MinutesEditor variant='sim'）；
//     產能入口一律「查看產能」（模擬區沿用正式產能），唯讀提示說明要去正式工作台改。
// D101 模擬區可以調整產線時數（只作用在模擬；採用時一起匯入正式產能表）：
//   - 產能對話框（線頭 ⚙＝單日、工具列「產線時數」＝表格）重用正式的 CapacityEditor，只換資料來源（source：讀 SimView.capacity、
//     存 POST session/capacity）；本人、起始日未過、AI 沒在跑、佇列清空時可改，否則唯讀。
//   - 工作台上方 SimCapacityBanner：列出調整過的格、正式在調整後被改過的格、鎖定線不會匯入的格。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  AI_DEFAULT_HORIZON,
  EMPTY_SIM_LOCKS,
  type SimLocks,
} from '@/lib/packaging/ai/types'
import { MINUTES_SNAP, type BoardCard, type BoardDay, type CapacityResponse, type PlacementOp, type YMD } from '@/lib/packaging/scheduleTypes'
import { isWeekend } from '@/lib/packaging/scheduleCalendar'
import type { PackagingCard as PackagingCardData } from '@/lib/packaging/types'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import { effectiveMinutes, overrideFromEffective } from '@/lib/packaging/scheduleMinutes'
import PackagingOrderModal from '@/components/packaging/PackagingOrderModal'
import { fmtQty } from '@/components/packaging/poolStyles'
import {
  isOwnLaneDrop, laneDropPlan, laneLineTopPx, lanePositionAfter, laneReplanBlockedReason, mergeCandidates, newId, parseDropId, ruleForBoardCard, ruleForPoolCard, storedOverrideOf,
  type DragRule, type LaneDropPlan, type LocalAction,
} from '@/components/packaging/board/boardLocal'
import type { ReorderChange } from '@/lib/packaging/laneOrder'
import { ago, clock, hours, md, mdw } from '@/components/packaging/board/boardFormat'
import PoolSidebar, { type PoolAction } from '@/components/packaging/board/PoolSidebar'
import ParkingArea from '@/components/packaging/board/ParkingArea'
import type { CardMenuHandlers } from '@/components/packaging/board/cardMenu'
import { SimplePoolCardFace } from '@/components/packaging/board/SimplePoolCard'
import { lineLabel } from '@/components/packaging/board/CardFace'
import { PlacementCardOverlay } from '@/components/packaging/board/PlacementCard'
import DayLanesView from '@/components/packaging/board/DayLanesView'
import MultiDayView from '@/components/packaging/board/MultiDayView'
import { ownLanePlan, pointerClientY, sameHint, type LaneReorderHint } from '@/components/packaging/board/laneDrag'
import type { LaneOrderProps } from '@/components/packaging/board/LaneOrderControls'
import SplitDialog from '@/components/packaging/board/SplitDialog'
import QtyDateDialog from '@/components/packaging/board/QtyDateDialog'
import CapacityEditor, { type CapacityEditorSource } from '@/components/packaging/board/CapacityEditor'
import Modal, { Btn } from '@/components/packaging/board/Modal'
import SimCloseDialog, { type ClosureDone } from './SimCloseDialog'
import { useSim } from './useSim'
import {
  AI_MARK, LIVE_MARK, LOCK_MARK, SIM_LANE_REASON, decorateSimBoard, locksCount, simAutoLane, simCardState, simLaneReorder, simLaneStep, simLaneStepInfo,
  soNumberOfKey, toggleCardLock, toggleLineLock, toggleOrderLock, type SimCardState, type SimOrderCtx,
} from './simBoard'
import { MODE_LABEL, UNDO_KIND_LABEL, capHoursText, capMinutesText, horizonLabel } from './simText'
import SimCapacityBanner, { liveChangedSince, liveLineOf } from './SimCapacityBanner'
import { SimCreateForm, type SimCreateValue } from './SimCreateDialog'
import SimCreateDialog from './SimCreateDialog'
import SimCardDetail from './SimCardDetail'
import AiRunPanel, { RunProgress, runElapsedMs } from './AiRunPanel'
import RunHistory from './RunHistory'
import RulesPanel from './RulesPanel'
import ThresholdsPanel from './ThresholdsPanel'
import AdoptDialog from './AdoptDialog'
import LockPanel from './LockPanel'
import Drawer from './Drawer'

/** 記住上次選的檢視（日／全部） */
const VIEW_KEY = 'packaging.ai.view.v1'
const POOL_HIDDEN_KEY = 'packaging.ai.poolHidden.v1'

function readLS(key: string): string | null {
  try { return typeof window === 'undefined' ? null : window.localStorage.getItem(key) } catch { return null }
}
function writeLS(key: string, v: string) {
  try { window.localStorage.setItem(key, v) } catch { /* 存不進去就算了 */ }
}

/**
 * 鎖定卡「灰底」：顯示元件是正式工作台共用的，不能加欄位（見 simBoard.ts 檔頭），
 * 改用 CSS 屬性選擇器——鎖定卡的品名前有 🔒，卡片根元素的 aria-label 就含 🔒。
 * 寫在一般 <style>（不在 Tailwind 的 @layer 裡）：未分層的樣式優先於 Tailwind 的 utilities，蓋得掉卡片原本的底色。
 * 只作用在 .sim-board 裡面，正式工作台不受影響。
 */
const SIM_CSS = `
.sim-board [aria-roledescription="排定卡"][aria-label*="${LOCK_MARK}"] {
  background-color: rgb(30 41 59);
  background-image: repeating-linear-gradient(135deg, rgba(148,163,184,0.16) 0 6px, transparent 6px 12px);
  border-color: rgb(100 116 139);
}
.sim-board.sim-lock-mode [aria-roledescription="排定卡"] { cursor: pointer; }
.sim-board.sim-lock-mode [aria-roledescription="排定卡"]:hover { outline: 2px solid rgb(245 158 11 / 0.7); outline-offset: -2px; }
`

type ActiveDrag =
  | { kind: 'pool'; card: PackagingCardData; rule: DragRule }
  | { kind: 'placement'; bc: BoardCard; rule: DragRule }

/** D100 量 DOM 時限定在模擬區畫面底下（laneDrag） */
const SIM_SCOPE = '.sim-board'
/** D101 產能對話框在模擬區「不能改」時的說明（別人的模擬區、起始日已過、AI 執行中、還有操作儲存中） */
const SIM_CAPACITY_READONLY = '模擬區的產線時數目前只能查看（別人的模擬區、起始日已過、AI 執行中或還有操作儲存中）；正式產能表請到正式排程工作台改'
/** D101 模擬產能表上方的說明 */
const SIM_CAPACITY_INTRO = '這裡改的時數只作用在模擬區（負荷條、AI 排程都用它），按「採用此版排程」時才會一起寫進正式產能表。'
  + '沒改的格子＝沿用正式產能表；↺＝這格回到正式值。範圍內的週六、週日可以開加班；正式已開的週末在這裡只能改時數、不能關。'

/** 模擬來源的錯誤碼 → 產能表認得的碼（其他一律 bad_request：產能表會顯示伺服器的中文訊息） */
const CAP_CODES = new Set(['forbidden', 'lock_required', 'lock_lost', 'bad_request', 'date_not_workday', 'weekend_has_cards', 'migration_required', 'line_invalid', 'db_error'])
type CapFailCode = Extract<CapacityResponse, { success: false }>['code']

type Dialog =
  | { t: 'reset' }
  | { t: 'run' }
  | { t: 'adopt' }
  | { t: 'split'; bc: BoardCard }
  | { t: 'move'; bc: BoardCard }
  | { t: 'partial'; card: PackagingCardData }
  /** D101：date 省略＝表格模式（工具列「產線時數」）；有 date＝單日（線頭 ⚙） */
  | { t: 'capacity'; date?: YMD; lineId?: number }
  /** D106 ②：模擬區已有內容時先確認「將覆蓋目前模擬區」 */
  | { t: 'pull' }
  /** D107：對這張卡的 SO-項次結案（確認對話框） */
  | { t: 'closeCase'; bc: BoardCard }

type DrawerKind = 'run' | 'history' | 'rules' | 'locks'

/** 桌機（≥ 1024px）才提供拖曳（同正式工作台 D54） */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    cb => {
      const mq = window.matchMedia('(min-width: 1024px)')
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia('(min-width: 1024px)').matches,
    () => true,
  )
}

const TOOL_BTN = 'rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'

export default function SimLayout({ meEmail }: { meEmail: string | null }) {
  const router = useRouter()
  const [denied, setDenied] = useState(false)
  const [owner, setOwner] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [drawer, setDrawer] = useState<DrawerKind | null>(null)
  const [rulesTab, setRulesTab] = useState<'rules' | 'thresholds'>('rules')
  const rulesDirtyRef = useRef({ rules: false, thresholds: false })
  const [lockMode, setLockMode] = useState(false)
  const [view, setView] = useState<'day' | 'all'>(() => (readLS(VIEW_KEY) === 'day' ? 'day' : 'all'))
  const [pickedDate, setPickedDate] = useState<YMD | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  /** D100：從「工時」小標／右鍵「調整工時…」打開 → 直接聚焦工時輸入框 */
  const [detailFocus, setDetailFocus] = useState(false)
  const [orderSo, setOrderSo] = useState<string | null>(null)
  const [poolHidden, setPoolHidden] = useState<boolean>(() => readLS(POOL_HIDDEN_KEY) === '1')
  const [createValue, setCreateValue] = useState<SimCreateValue>({ horizon: AI_DEFAULT_HORIZON, mode: 'copy', start: 'today' })
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null)
  const [reorderHint, setReorderHint] = useState<LaneReorderHint | null>(null)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const isDesktop = useIsDesktop()

  /** AI 執行結束（成功或失敗）：自動打開結果面板 */
  const onRunFinished = useCallback(() => setDrawer('run'), [])
  const sim = useSim({
    enabled: !denied,
    owner,
    onUnauthorized: () => router.replace('/login'),
    onForbidden: () => setDenied(true),
    onRunFinished,
  })

  const v = sim.view
  const session = v?.session ?? null
  const rawBoard = v?.board ?? null
  const isOwner = !!v?.isOwner
  const locks: SimLocks = session?.locks ?? EMPTY_SIM_LOCKS
  const scopeLineIds = useMemo(() => session?.lineIds ?? [], [session?.lineIds])
  const simCards = useMemo(() => v?.simCards ?? {}, [v?.simCards])
  const windowSet = useMemo(() => new Set(session?.windowDates ?? []), [session?.windowDates])
  // 執行中＝running 且沒逾時。逾時（stale：超過 6 分鐘沒結束，背景執行多半已中斷）不算執行中——
  //   否則 AI 排程／採用／重設全部停用，而能把它標成失敗的 POST session/run 又按不到，模擬區就永遠卡住（審查發現）
  const running = v?.runningRun && v.runningRun.status === 'running' && !v.runningRun.stale ? v.runningRun : null
  const staleRun = v?.runningRun && v.runningRun.status === 'running' && v.runningRun.stale ? v.runningRun : null
  const busy = sim.action != null
  const stale = !!session?.stale
  const lines = useMemo(() => rawBoard?.lines ?? [], [rawBoard?.lines])
  const editable = isOwner && !!session && !stale && !busy
  const noLockables = !!session && session.mode === 'clear' && session.placementCount === 0 && Object.keys(simCards).length === 0
  // D101 能不能改模擬產線時數：本人、起始日未過、AI 沒在跑（AI 是在建 run 當下的時數下排的）、佇列清空
  //   （不含 busy：儲存產能本身就是一個動作，含進來會讓對話框在儲存時閃成唯讀）
  const capEditable = isOwner && !!session && !stale && !(v?.runningRun && v.runningRun.status === 'running' && !v.runningRun.stale)
    && sim.pending === 0 && !sim.saving
  // 鎖定模式：沒有東西可鎖、不能寫時視同關閉（資料換了也跟著失效，不必另外同步狀態）
  const lockModeOn = lockMode && editable && !noLockables
  const canDrag = editable && isDesktop && !lockModeOn

  // 拖曳中追游標（D74 線內重排的插入點）
  const dragging = activeDrag != null
  useEffect(() => {
    if (!dragging) { pointerRef.current = null; return }
    const onPointer = (e: PointerEvent) => { pointerRef.current = { x: e.clientX, y: e.clientY } }
    const onTouch = (e: TouchEvent) => { const t = e.touches[0]; if (t) pointerRef.current = { x: t.clientX, y: t.clientY } }
    window.addEventListener('pointermove', onPointer, { capture: true, passive: true })
    window.addEventListener('touchmove', onTouch, { capture: true, passive: true })
    return () => {
      window.removeEventListener('pointermove', onPointer, { capture: true })
      window.removeEventListener('touchmove', onTouch, { capture: true })
    }
  }, [dragging])

  // 時鐘（進度秒數、「N 分鐘前」）：AI 執行中每秒，平常 5 秒
  const isRunning = running != null
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), isRunning ? 1000 : 5000)
    return () => window.clearInterval(id)
  }, [isRunning])

  // toast 自動消失
  const { toast, dismissToast, showToast } = sim
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(dismissToast, toast.kind === 'error' ? 10_000 : 6000)
    return () => window.clearTimeout(id)
  }, [toast, dismissToast])

  // ── 顯示用資料 ──────────────────────────────────────────────────────────
  const board = useMemo(
    () => (rawBoard ? decorateSimBoard(rawBoard, simCards, locks, scopeLineIds) : null),
    [rawBoard, simCards, locks, scopeLineIds],
  )
  const cardState = useCallback((bc: BoardCard): SimCardState => simCardState(bc, simCards, locks, scopeLineIds), [simCards, locks, scopeLineIds])
  /** D100 線內順序判斷用（哪些卡能改順序） */
  const simCtx = useMemo<SimOrderCtx>(() => ({ simCards, locks, scopeLineIds }), [simCards, locks, scopeLineIds])
  const usableLineIds = useMemo(() => scopeLineIds.filter(id => !locks.lineIds.includes(id)), [scopeLineIds, locks.lineIds])
  const usableLines = useMemo(
    () => lines.filter(l => l.active && usableLineIds.includes(l.id)).sort((a, b) => a.sortOrder - b.sortOrder),
    [lines, usableLineIds],
  )
  const scopeLines = useMemo(
    () => lines.filter(l => scopeLineIds.includes(l.id)).sort((a, b) => a.sortOrder - b.sortOrder),
    [lines, scopeLineIds],
  )
  const lineName = useCallback((id: number | null | undefined) => lineNameOf(lines, id), [lines])
  const days: BoardDay[] = useMemo(() => board?.days ?? [], [board])
  const shownDate = pickedDate && days.some(d => d.date === pickedDate) ? pickedDate : (days[0]?.date ?? null)
  const dayData = view === 'day' ? (days.find(d => d.date === shownDate) ?? null) : null
  const dayIdx = dayData ? days.findIndex(d => d.date === dayData.date) : -1
  const dateOptions = useMemo(
    () => days.filter(d => windowSet.has(d.date)).map(d => ({ date: d.date, label: d.label, kind: d.kind })),
    [days, windowSet],
  )

  /** 未加工的原始卡（詳情、鎖定清單用） */
  const rawCard = useCallback((id: string): BoardCard | null => {
    if (!rawBoard) return null
    for (const d of rawBoard.days) for (const c of d.cards) if (c.placementId === id) return c
    return rawBoard.holding.find(c => c.placementId === id) ?? null
  }, [rawBoard])

  // ── D101 模擬產線時數：CapacityEditor 的資料來源 ───────────────────────────
  const { getView, saveCapacity } = sim
  const lockedLineKey = locks.lineIds.join(',')
  const capDates = v?.capacity?.sim.effective.map(e => e.date) ?? []
  const capFrom = capDates[0] ?? null
  const capTo = capDates[capDates.length - 1] ?? null
  const simCapacitySource = useMemo<CapacityEditorSource | null>(() => {
    if (!capFrom || !capTo) return null
    const lockedIds = lockedLineKey ? lockedLineKey.split(',').map(Number) : []
    // 一律從 getView() 讀最新畫面（儲存成功後 acceptView 已更新；產能表按儲存後重讀就是新的模擬值，不必再發請求）
    const cap = () => getView()?.capacity ?? null
    const inRange = (d: YMD, from: YMD, to: YMD) => d >= from && d <= to
    return {
      noLock: true,
      title: `模擬產線時數（${md(capFrom)}～${md(capTo)}）`,
      tableRange: { from: capFrom, to: capTo },
      intro: SIM_CAPACITY_INTRO,
      hideLinesManager: true,
      hideNote: true,
      load: async (from, to) => {
        const c = cap()
        if (!c) return { json: null, error: '模擬區尚未建立' }
        return {
          json: {
            success: true,
            rows: c.sim.rows.filter(r => inRange(r.date, from, to)),
            effective: c.sim.effective.filter(e => inRange(e.date, from, to)),
            lines: c.sim.lines,
            lineRows: c.sim.lineRows.filter(r => inRange(r.date, from, to)),
          },
        }
      },
      save: async (rows) => {
        const r = await saveCapacity({ rows })
        if (r.json && r.json.success) return { json: { success: true, rows: [], effective: [] } }
        const j = r.json && !r.json.success ? r.json : null
        const code = (j?.code && CAP_CODES.has(j.code) ? j.code : 'bad_request') as CapFailCode
        return {
          json: { success: false, error: r.error ?? j?.error ?? '儲存失敗', code, ...(j?.date ? { date: j.date } : {}), ...(j?.cardCount != null ? { cardCount: j.cardCount } : {}) },
          error: r.error,
          missingTable: r.missingTable,
        }
      },
      weekendToggle: (date) => {
        const c = cap()
        if (!c) return { enabled: false }
        if (c.liveOpenWeekends.includes(date)) {
          // D101 驗證修正：正式在建立模擬區之後才開的週末不在模擬日期裡，也不會因為改時數被悄悄加進來 → 說清楚要重設
          if (!(getView()?.session?.windowDates ?? []).includes(date)) {
            return { enabled: false, title: '正式產能表是在建立模擬區之後才開這天加班，這天不在這次模擬的日期裡（不能在這裡調整）；要在模擬區使用這天，請重設模擬區' }
          }
          return { enabled: false, title: '正式產能表已開加班：模擬區只能調整各線時數、不能關（要關請到正式工作台的產能表）' }
        }
        if (!c.editableDates.includes(date)) return { enabled: false, title: '只能開模擬範圍內（第一天到最後一天之間）、今天以後的週末' }
        return { enabled: true, title: '在模擬區開這天的加班（只作用在模擬；採用時正式產能表一起開）' }
      },
      cellBadge: (date, lineId) => {
        const c = cap()
        if (!c) return null
        const wk = isWeekend(date)
        const live = liveLineOf(c, date, lineId)
        const liveText = live ? capMinutesText(live, wk) : '—'
        const lockNote = lockedIds.includes(lineId) ? '。這條線已鎖定：採用時不會匯入' : '。採用時會寫進正式產能表'
        const cell = c.cells.find(x => x.date === date && x.lineId === lineId)
        if (cell) {
          if (liveChangedSince(cell, live)) {
            return { text: '正式已改', tone: 'warn', title: `你調整時正式是 ${capHoursText(cell.base, wk)}，現在是 ${liveText}；採用會以模擬值為準${lockNote}` }
          }
          return { text: '模擬', tone: 'sim', title: `模擬調整過；正式：${liveText}${lockNote}` }
        }
        if (c.diffs.some(d => d.date === date && d.lineId === lineId)) {
          return { text: '≠正式', tone: 'sim', title: `沿用模擬調整過的前一個平日；正式：${liveText}` }
        }
        return null
      },
      hasOverride: (date, lineId) => !!cap()?.cells.some(x => x.date === date && x.lineId === lineId),
      dayHasOverride: (date) => {
        const c = cap()
        return !!c && (c.cells.some(x => x.date === date) || c.weekendsOpened.includes(date))
      },
    }
  }, [capFrom, capTo, lockedLineKey, getView, saveCapacity])

  // ── 操作（全部經 useSim.submitOps → POST session/ops） ─────────────────────
  const { submitOps, submitLocks } = sim

  /** 模擬列能不能動；不能時 toast 說明並回 false */
  const assertMovable = useCallback((bc: BoardCard): boolean => {
    const st = cardState(bc)
    if (!st.sim) { showToast('warn', `${st.readonlyReason ?? '正式排程的卡'}：模擬區不能動它`); return false }
    if (st.lockedBy.length > 0) { showToast('warn', `${lineLabel(bc.card)} 已鎖定（${st.lockedBy.includes('card') ? '卡片' : st.lockedBy.includes('order') ? '整張訂單' : '整條線'}），要先解除鎖定才能動`); return false }
    return true
  }, [cardState, showToast])

  /** 目標日期與線是否在模擬範圍、線是否可用 */
  const assertTarget = useCallback((toDate: YMD | null, lineId: number | null): boolean => {
    if (toDate == null) { showToast('warn', '模擬區沒有待排區；要先不排這張卡，請拖回左邊的待排池'); return false }
    if (!windowSet.has(toDate)) { showToast('warn', `模擬區只能排在模擬範圍內（${session ? `${md(session.windowDates[0])}～${md(session.windowDates[session.windowDates.length - 1])}` : ''}）`); return false }
    if (lineId == null) { showToast('warn', '這天沒有可排的線（線都被鎖定、停線或不在模擬範圍）'); return false }
    if (!scopeLineIds.includes(lineId)) { showToast('warn', `${lineName(lineId)} 不在這次模擬的範圍（建立模擬區之後才啟用的線）`); return false }
    if (locks.lineIds.includes(lineId)) { showToast('warn', `${lineName(lineId)} 已整條鎖定，不能放卡或移出`); return false }
    return true
  }, [windowSet, session, scopeLineIds, locks.lineIds, lineName, showToast])

  const autoLane = useCallback((date: YMD, moving: BoardCard | null): number | null => {
    const day = rawBoard?.days.find(d => d.date === date)
    const keep = moving?.lineId != null && usableLineIds.includes(moving.lineId) ? moving.lineId : null
    return simAutoLane(day, moving ? { placementId: moving.placementId } : null, usableLineIds, keep ?? usableLines[0]?.id ?? null)
  }, [rawBoard, usableLineIds, usableLines])

  const placePool = useCallback((card: PackagingCardData, qty: number, toDate: YMD, lineId: number, how = '排入') => {
    if (locks.soNumbers.includes(soNumberOfKey(card.soLineKey))) {
      showToast('warn', `訂單 ${soNumberOfKey(card.soLineKey)} 已鎖定：剩餘量不能再排（先解除訂單鎖定）`)
      return
    }
    const id = newId()
    submitOps(
      [{ op: 'place', id, soLineKey: card.soLineKey, qty, toDate, originCardId: card.cardId, lineId }],
      `${how} ${lineLabel(card)} ${fmtQty(qty)} → ${md(toDate)} ${lineName(lineId)}`,
      [{ t: 'place', id, qty, toDate, poolCard: card, lineId }],
    )
  }, [locks.soNumbers, lineName, showToast, submitOps])

  const moveCard = useCallback((bc: BoardCard, toDate: YMD, lineId: number) => {
    if (toDate === bc.planDate && lineId === bc.lineId) return
    submitOps(
      [{ op: 'move', id: bc.placementId, version: bc.version, toDate, lineId }],
      toDate === bc.displayDate && lineId !== bc.laneId ? `換線 ${lineLabel(bc.card)} → ${lineName(lineId)}` : `移動 ${lineLabel(bc.card)} → ${md(toDate)} ${lineName(lineId)}`,
      [{ t: 'move', id: bc.placementId, toDate, lineId }],
    )
  }, [lineName, submitOps])

  const unplaceCard = useCallback((bc: BoardCard) => {
    if (!assertMovable(bc)) return
    submitOps(
      [{ op: 'unplace', id: bc.placementId, version: bc.version }],
      `放回待排池 ${lineLabel(bc.card)}`,
      [{ t: 'unplace', id: bc.placementId }],
    )
  }, [assertMovable, submitOps])

  const setMinutes = useCallback((bc: BoardCard, minutes: number | null, reason: string | null, via: 'drag' | 'dialog') => {
    if (!assertMovable(bc)) return
    const cur = storedOverrideOf(bc)
    if (minutes === cur || (minutes != null && cur != null && Math.abs(minutes - cur) < 0.05)) return
    const eff = effectiveMinutes({ qty: bc.qty, effectiveQty: bc.effectiveQty, override: minutes, perUnit: bc.card.work.perUnit })
    submitOps(
      [{ op: 'setMinutes', id: bc.placementId, version: bc.version, minutes, reason: reason || null, via }],
      `改工時 ${lineLabel(bc.card)} ${hours(bc.minutes)}→${minutes == null ? '標準' : hours(eff)}h`,
      [{ t: 'setMinutes', id: bc.placementId, minutes, by: meEmail ?? '', byName: null, atIso: new Date().toISOString() }],
    )
  }, [assertMovable, meEmail, submitOps])

  /** D69 日檢視拉下緣（與正式工作台同規則：接近標準值半格內＝回到標準值） */
  const resizeMinutes = useCallback((bc: BoardCard, newEff: number) => {
    const std = bc.minutesStd ?? null
    const value = std != null && Math.abs(newEff - std) < MINUTES_SNAP / 2 ? null : overrideFromEffective(newEff, bc.qty, bc.effectiveQty)
    setMinutes(bc, value, null, 'drag')
  }, [setMinutes])

  /**
   * D74／D100 線內順序的送出（拖曳＝'drag'、卡片詳情上移／下移＝'up'／'down'）：changes 由 simLaneReorder／simLaneStep 算好
   * （已排除唯讀卡、鎖定卡、超過上限）。position＝移動後是第幾張（標籤「A 線 第 n 張」，同正式區）。
   */
  const submitLaneOrder = useCallback((bc: BoardCard, date: YMD, lineId: number, changes: ReorderChange[], how: 'drag' | 'up' | 'down', position: number) => {
    if (changes.length === 0) return
    const verb = how === 'drag' ? '調整順序' : how === 'up' ? '上移' : '下移'
    submitOps(
      changes.map((c): PlacementOp => (c.replan
        ? { op: 'move', id: c.id, version: c.version, toDate: date, lineId, sortIndex: c.sortIndex }
        : { op: 'reorder', id: c.id, version: c.version, sortIndex: c.sortIndex })),
      `${verb} ${lineLabel(bc.card)}（${lineName(lineId)} 第 ${position} 張）`,
      changes.map((c): LocalAction => (c.replan
        ? { t: 'move', id: c.id, toDate: date, lineId, sortIndex: c.sortIndex }
        : { t: 'reorder', id: c.id, sortIndex: c.sortIndex })),
    )
  }, [lineName, submitOps])

  /** D74／D100 拖曳放回自己那條線：beforeId＝游標算出的插入點（simLaneReorder 會處理唯讀卡與鎖定） */
  const reorderInLane = useCallback((bc: BoardCard, day: BoardDay, lineId: number, beforeId: string | null) => {
    const r = simLaneReorder(day, lineId, bc.placementId, beforeId, simCtx)
    if (!r.ok) {
      showToast('warn', r.reason === 'too_many' ? `${SIM_LANE_REASON.too_many}（這次要改 ${r.changes.length} 張）` : SIM_LANE_REASON[r.reason])
      return
    }
    submitLaneOrder(bc, day.date, lineId, r.changes, 'drag', lanePositionAfter(day, lineId, bc.placementId, r.changes))
  }, [simCtx, showToast, submitLaneOrder])

  /** D100 卡片詳情的上移／下移（用最新的樂觀畫面算，連按也對得上） */
  const stepInLane = useCallback((id: string, dir: 'up' | 'down') => {
    const bc = rawCard(id)
    if (!bc || !rawBoard || bc.displayDate == null || bc.laneId == null) return
    if (!assertMovable(bc)) return
    const day = rawBoard.days.find(d => d.date === bc.displayDate)
    if (!day) return
    const r = simLaneStep(day, bc.laneId, id, dir, simCtx)
    if (!r.ok) { showToast('warn', r.reason); return }
    submitLaneOrder(bc, day.date, bc.laneId, r.changes, dir, r.position)
  }, [rawCard, rawBoard, assertMovable, simCtx, showToast, submitLaneOrder])

  // ── 鎖定（D88） ────────────────────────────────────────────────────────
  const changeLocks = useCallback((next: SimLocks, label: string) => submitLocks(next, label), [submitLocks])

  const toggleCard = useCallback((bc: BoardCard) => {
    const raw = rawCard(bc.placementId) ?? bc
    const st = cardState(raw)
    if (!st.sim) { showToast('info', `${st.readonlyReason ?? '正式排程的卡'}：本來就不會被 AI 動，不用鎖`); return }
    const own = locks.placementIds.includes(raw.placementId)
    if (!own && st.lockedBy.length > 0) {
      showToast('info', `這張卡因為${st.lockedBy.includes('order') ? '整張訂單' : '整條線'}被鎖；要解除請到「鎖定清單」`)
      return
    }
    changeLocks(toggleCardLock(locks, raw.placementId), `${own ? '解除鎖定' : '鎖定'} ${lineLabel(raw.card)}`)
  }, [rawCard, cardState, locks, changeLocks, showToast])

  // ── 卡片右鍵選單 ────────────────────────────────────────────────────────
  const handlersFor = useCallback((bc: BoardCard, siblings: BoardCard[]): CardMenuHandlers => {
    const st = cardState(bc)
    const deny = () => { assertMovable(bc) }
    // D100「調整工時…」與卡片上的「工時」小標（MinutesChip 有 onEdit 才是按鈕）：
    //   - 鎖定模式開著：點卡片＝鎖定／解鎖（onOpenDetail）；小標若是按鈕會攔下點擊改成開詳情 → 不給，小標變純文字、點了照樣切換鎖定
    //   - 正式區唯讀的卡：詳情裡沒有工時編輯器（SimCardDetail 只對模擬列顯示）→ 不給，免得小標寫「點一下調整工時」卻改不了
    //   - 鎖定的模擬列：照給——詳情的工時段會寫「鎖定的卡不能改工時，先解除鎖定」
    const editMinutes = lockModeOn || !st.sim ? undefined : (c: BoardCard) => { setDetailId(c.placementId); setDetailFocus(true) }
    if (!st.sim || st.lockedBy.length > 0) {
      return {
        onToggleComplete: () => showToast('warn', '模擬區不能勾完成；完成請在正式排程工作台勾'),
        onSplit: deny, onMoveTo: deny, onToHolding: deny, onUnplace: deny,
        onEditMinutes: editMinutes,
      }
    }
    const others = mergeCandidates(siblings, bc).filter(o => {
      const s = cardState(o)
      return !!s.sim && s.lockedBy.length === 0
    })
    return {
      onToggleComplete: () => showToast('warn', '模擬區不能勾完成；完成請在正式排程工作台勾'),
      onSplit: c => setDialog({ t: 'split', bc: c }),
      onMoveTo: c => setDialog({ t: 'move', bc: c }),
      onToHolding: () => showToast('warn', '模擬區沒有待排區；要先不排這張卡，請用「放回待排池」'),
      onUnplace: c => unplaceCard(c),
      onMoveLine: (c, lineId) => { if (c.displayDate && assertTarget(c.displayDate, lineId)) moveCard(c, c.displayDate, lineId) },
      moveLines: usableLines,
      // D100：「調整工時…」與卡片上的「工時」小標都直接聚焦工時輸入框（鎖定模式時不給，見上）
      onEditMinutes: editMinutes,
      onMerge: others.length > 0 ? c => {
        submitOps(
          [{ op: 'merge', targetId: c.placementId, targetVersion: c.version, sources: others.map(o => ({ id: o.placementId, version: o.version })) }],
          `合併 ${lineLabel(c.card)}（${others.length + 1} 張）`,
          [{ t: 'merge', targetId: c.placementId, sourceIds: others.map(o => o.placementId) }],
        )
      } : undefined,
    }
  }, [cardState, assertMovable, assertTarget, moveCard, unplaceCard, usableLines, submitOps, showToast, lockModeOn])

  const onOpenDetail = useCallback((bc: BoardCard) => {
    if (lockModeOn) { toggleCard(bc); return }
    setDetailId(bc.placementId)
    setDetailFocus(false)
  }, [lockModeOn, toggleCard])
  const openOrder = useCallback((so: string) => { setDetailId(null); setOrderSo(so) }, [])

  const { reload: reloadSim } = sim
  /** D107 結案成功：伺服器已把這一行的卡從正式區與模擬區移除 → 關對話框、重抓模擬區、回饋 */
  const onClosureDone = useCallback((r: ClosureDone) => {
    setDialog(null)
    const n = typeof r.response.simRemoved === 'number' ? r.response.simRemoved : Array.isArray(r.response.simRemoved) ? r.response.simRemoved.length : null
    showToast('info', `已結案 ${r.soLineKey}：這一行不再拉回待排池${n != null ? `，已從模擬區移除 ${n} 張卡` : ''}；正在重新載入模擬區`)
    void reloadSim()
  }, [showToast, reloadSim])

  const onPoolAction = useCallback((card: PackagingCardData, action: PoolAction) => {
    if (action === 'partial') { setDialog({ t: 'partial', card }); return }
    showToast('warn', action === 'complete' ? '模擬區不能勾完成；完成請在正式排程工作台勾' : '模擬區沒有待排區；直接拖到模擬範圍內的日期即可')
  }, [showToast])

  // ── 拖曳 ────────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  )

  const onDragStart = (e: DragStartEvent) => {
    setReorderHint(null)
    const d = e.active.data.current as { kind?: string; card?: PackagingCardData | null; bc?: BoardCard } | undefined
    if (d?.kind === 'pool' && d.card) setActiveDrag({ kind: 'pool', card: d.card, rule: ruleForPoolCard(d.card) })
    else if (d?.kind === 'placement' && d.bc) setActiveDrag({ kind: 'placement', bc: d.bc, rule: ruleForBoardCard(d.bc) })
    sim.setDragging(true)
  }

  /** D74／D100 拖曳中：插入線（日＝時間尺、全部天數＝清單）；模擬區畫在「實際落點」（simLaneReorder 的 beforeId） */
  const onDragMove = (e: DragMoveEvent) => {
    const drag = activeDrag
    const t = e.over ? parseDropId(String(e.over.id)) : null
    const day = drag && rawBoard && t?.kind === 'lane' ? rawBoard.days.find(x => x.date === t.date) : undefined
    if (!drag || !day || t?.kind !== 'lane') { setReorderHint(h => (h ? null : h)); return }
    const laneKey = `${t.date}:${t.lineId}`
    const timeline = view === 'day'
    let next: LaneReorderHint
    if (drag.kind === 'placement' && isOwnLaneDrop(drag.bc, t)) {
      const movingId = drag.bc.placementId
      const plan = ownLanePlan({
        mode: timeline ? 'timeline' : 'list', day, lineId: t.lineId, movingId,
        clientY: pointerClientY(pointerRef.current, e), hideCompleted: false, scope: SIM_SCOPE,
      })
      // 要整條重新編號、會碰到唯讀卡／鎖定卡時，實際落點可能被夾到「固定在最上面」的卡之後 → 插入線畫在實際落點，說的和做的一樣。
      // 放回原位（stay）＝不送，插入線照游標畫；做不到（r.ok false：唯讀、鎖定、越不過固定卡、沒空隙）→ 不畫插入線，放下時 toast 說明原因
      const r = plan.stay ? null : simLaneReorder(day, t.lineId, movingId, plan.beforeId, simCtx)
      if (r && !r.ok) { setReorderHint(h => (h ? null : h)); return }
      const beforeId = r ? r.beforeId : plan.beforeId
      const topPx = !timeline ? 0 : beforeId === plan.beforeId ? plan.topPx : laneLineTopPx(day, t.lineId, movingId, beforeId, false)
      next = { laneKey, topPx: Math.round(topPx), mode: 'insert', beforeId }
    } else {
      next = { laneKey, topPx: timeline ? Math.round(laneDropPlan(day, t.lineId, null, null, false).topPx) : 0, mode: 'append', beforeId: null }
    }
    setReorderHint(h => (sameHint(h, next) ? h : next))
  }

  const onDragEnd = (e: DragEndEvent) => {
    const drag = activeDrag
    const clientY = pointerClientY(pointerRef.current, e)
    const target = e.over ? parseDropId(String(e.over.id)) : null
    // D100：拖回自己那條線的插入點——在 setState 之前量（DOM 還是拖曳中的樣子）
    let own: { day: BoardDay; lineId: number; plan: LaneDropPlan } | null = null
    if (drag?.kind === 'placement' && target?.kind === 'lane' && rawBoard && isOwnLaneDrop(drag.bc, target)) {
      const day = rawBoard.days.find(x => x.date === target.date)
      if (day) {
        own = {
          day, lineId: target.lineId,
          plan: ownLanePlan({ mode: view === 'day' ? 'timeline' : 'list', day, lineId: target.lineId, movingId: drag.bc.placementId, clientY, hideCompleted: false, scope: SIM_SCOPE }),
        }
      }
    }
    setActiveDrag(null)
    setReorderHint(null)
    sim.setDragging(false)
    if (!drag || !e.over || !rawBoard || !session || !target) return
    if (drag.kind === 'placement' && !assertMovable(drag.bc)) return
    if (target.kind === 'pool') { if (drag.kind === 'placement') unplaceCard(drag.bc); return }
    if (target.kind === 'holding') { showToast('warn', '模擬區沒有待排區；要先不排這張卡，請拖回待排池'); return }
    // D74／D100：拖回自己那條線（日／全部天數）＝上下重排
    if (drag.kind === 'placement' && isOwnLaneDrop(drag.bc, target)) {
      // D100：放回原位（看得到的順序沒變）＝不送
      if (own && !own.plan.stay) reorderInLane(drag.bc, own.day, own.lineId, own.plan.beforeId)
      return
    }
    if (drag.rule.blocked) return
    const toDate = target.date
    if (drag.rule.minDate && toDate < drag.rule.minDate) return
    const moving = drag.kind === 'placement' ? drag.bc : null
    const lineId = target.kind === 'lane' ? target.lineId : autoLane(toDate, moving)
    if (!assertTarget(toDate, lineId) || lineId == null) return
    if (drag.kind === 'pool') {
      const remaining = rawBoard.pool.cardMeta[drag.card.cardId]?.remainingQty ?? drag.card.qtyCard
      if (!(remaining > 0)) return
      placePool(drag.card, remaining, toDate, lineId, '拖曳')
      return
    }
    moveCard(drag.bc, toDate, lineId)
  }

  const onDragCancel = () => {
    setActiveDrag(null)
    setReorderHint(null)
    sim.setDragging(false)
  }

  // ── 其他動作 ────────────────────────────────────────────────────────────
  const goView = (next: 'day' | 'all') => { setView(next); writeLS(VIEW_KEY, next) }
  const closeDrawer = () => {
    if (drawer === 'rules' && (rulesDirtyRef.current.rules || rulesDirtyRef.current.thresholds)
      && !window.confirm('規則或門檻表有未儲存的修改，確定要關閉嗎？')) return
    rulesDirtyRef.current = { rules: false, thresholds: false }
    setDrawer(null)
  }
  const onRulesDirty = useCallback((d: boolean) => { rulesDirtyRef.current.rules = d }, [])
  const onThresholdsDirty = useCallback((d: boolean) => { rulesDirtyRef.current.thresholds = d }, [])

  const openRunPanel = (id?: number | null) => {
    setDrawer('run')
    const target = id ?? v?.runningRun?.id ?? v?.latestRun?.id ?? null
    if (target != null && sim.run?.id !== target) void sim.openRun(target)
  }

  const doLoadRun = (runId: number, which: 'result' | 'base') => {
    void sim.loadRun(runId, which).then(ok => { if (ok) setDrawer(null) })
  }

  // ── 狀態畫面 ────────────────────────────────────────────────────────────
  if (denied) return <AccessDenied />

  if (!v) {
    const err = sim.loadError
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050b14] p-4 text-white">
        {err ? (
          <div className="w-full max-w-lg rounded-2xl border border-red-800 bg-slate-900 p-8 text-center">
            <h1 className="text-lg font-bold text-red-300">{err.missingTable ? 'AI 模擬排程資料表尚未建立' : 'AI 模擬區載入失敗'}</h1>
            <p className="mt-3 break-words text-sm leading-relaxed text-slate-300">{err.message}</p>
            {err.missingTable && (
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                這是新功能的資料表，要由 Snow 在 Supabase 備份後手動套用。套用前正式排程工作台照常可用，只有 AI 模擬排程不能用。
              </p>
            )}
            <div className="mt-6 flex justify-center gap-2">
              <button type="button" onClick={() => void sim.reload()} disabled={sim.loading}
                className="rounded border border-slate-600 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50">{sim.loading ? '重試中…' : '重試'}</button>
              <Link href="/packaging" className="rounded border border-slate-600 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800">回包裝專區</Link>
            </div>
          </div>
        ) : (
          <div className="animate-pulse font-mono text-sm text-violet-300">載入 AI 模擬區…（待排池冷啟動約 3~6 秒）</div>
        )}
      </div>
    )
  }

  const ownerLabel = v.owner.name ?? v.owner.email
  // 被拖的排定卡所在的線（同線重排不套 D22 日期限制；日／全部天數共用）。
  // D100：延誤＋預排、還沒到預估可包日的卡除外（線內換位置＝move 會被 D22 擋；同正式工作台 BoardLayout）
  const ownLaneKey = activeDrag?.kind === 'placement' && activeDrag.bc.displayDate != null && activeDrag.bc.laneId != null
    && !laneReplanBlockedReason(activeDrag.bc)
    ? `${activeDrag.bc.displayDate}:${activeDrag.bc.laneId}` : null
  const lastUndo = session?.undo[session.undo.length - 1] ?? null
  const runBusy = !!running || sim.polling
  const detailRaw = detailId ? rawCard(detailId) : null
  const adoptBlock = !isOwner ? '別人的模擬區只能檢視'
    : !session ? '請先建立模擬區'
      : stale ? '起始日已過，請先重設模擬區'
        : runBusy ? 'AI 執行中，請等結果出來'
          : sim.pending > 0 || sim.saving ? '還有操作儲存中'
            : busy ? '請等目前的動作完成' : null
  // D106 兩個整批按鈕：本人、沒有 AI 在跑、佇列清空、沒有其他動作進行中（清空不看 stale；拉正式區另外看）
  const bulkBlock = !isOwner ? '別人的模擬區只能檢視'
    : !session ? '請先建立模擬區'
      : runBusy ? 'AI 執行中，請等結果出來'
        : sim.pending > 0 || sim.saving ? '還有操作儲存中'
          : busy ? '請等目前的動作完成' : null
  const capacityCount = (v?.capacity?.cells.length ?? 0) + (v?.capacity?.weekendsOpened.length ?? 0)
  const simHasContent = !!session && (session.placementCount > 0 || capacityCount > 0 || locksCount(locks) > 0)
  const runBlock = !isOwner ? '別人的模擬區只能檢視'
    : !session ? '請先建立模擬區'
      : stale ? '起始日已過，請先重設模擬區'
        : runBusy ? 'AI 正在執行'
          : sim.pending > 0 || sim.saving ? '還有操作儲存中'
            : busy ? '請等目前的動作完成' : null

  return (
    <div className={`sim-board min-h-screen bg-[#050b14] text-white lg:flex lg:h-screen lg:flex-col lg:overflow-hidden ${lockModeOn ? 'sim-lock-mode' : ''}`}>
      <style>{SIM_CSS}</style>

      {/* ─── 標題列 ─── */}
      <header className="shrink-0 space-y-2 px-4 pb-2 pt-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <div className="min-w-0">
            <Link href="/packaging" className="font-mono text-xs text-slate-400 hover:text-white">← 包裝專區</Link>
            <h1 className="text-xl font-bold">
              AI 模擬排程
              <span className="ml-2 rounded border border-violet-600/50 bg-violet-950/40 px-1.5 py-0.5 align-middle text-[11px] font-semibold text-violet-300">P3</span>
            </h1>
          </div>
          <p className="text-[11px] text-slate-400">
            今天 {mdw(v.today)}
            {session && (
              <>
                <span className="text-slate-300">・範圍 {mdw(session.windowDates[0])}～{mdw(session.windowDates[session.windowDates.length - 1])}</span>
                （{horizonLabel(session.horizon)}・{MODE_LABEL[session.mode]}）・模擬 {session.placementCount} 張
                <span className="text-slate-500">・更新 {clock(session.updatedAt, nowMs)}（{ago(session.updatedAt, nowMs + sim.serverOffsetMs)}）</span>
              </>
            )}
          </p>
          <div className="flex-1" />
          {v.owners.length > 1 || !isOwner ? (
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
              檢視
              <select
                value={isOwner ? '' : v.owner.email}
                onChange={e => setOwner(e.target.value || null)}
                className="max-w-[12rem] rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-xs text-slate-200"
                aria-label="切換檢視誰的模擬區"
              >
                <option value="">我的模擬區</option>
                {v.owners.filter(o => o.email !== v.me.email).map(o => (
                  <option key={o.email} value={o.email}>{o.name ?? o.email}（唯讀）</option>
                ))}
                {!isOwner && !v.owners.some(o => o.email === v.owner.email) && (
                  <option value={v.owner.email}>{ownerLabel}（唯讀）</option>
                )}
              </select>
            </label>
          ) : null}
          <button type="button" onClick={() => { setRulesTab('rules'); setDrawer('rules') }} className={TOOL_BTN + ' text-xs'}>規則與門檻</button>
          <button type="button" onClick={() => void sim.reload()} disabled={sim.loading || sim.pending > 0}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50">
            {sim.loading ? '更新中…' : '重新整理'}
          </button>
        </div>

        {!isOwner && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-800/70 bg-sky-950/30 px-3 py-2 text-xs text-sky-100">
            <b>唯讀檢視：{ownerLabel} 的模擬區</b>
            <span className="text-sky-200/70">・只有本人能改；規則與門檻是大家共用的，可以編輯</span>
            <span className="flex-1" />
            <button type="button" onClick={() => setOwner(null)} className="rounded border border-sky-700 px-2 py-0.5 hover:bg-sky-900/50">回到我的模擬區</button>
          </div>
        )}

        {/* ─── 工具列 ─── */}
        {session && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {isOwner && (
              <button type="button" onClick={() => setDialog({ t: 'reset' })} disabled={busy || runBusy || sim.pending > 0} className={TOOL_BTN}
                title="換範圍（2／4／6 天）、起始日或開始方式（複製／清空）；目前狀態會先存進退回上一步">重設…</button>
            )}
            {isOwner && (
              // D106 ①：一鍵清空（不另開確認：伺服器清空前先存進退回上一步，按一下就回來）；產線時數覆寫保留
              <button type="button" onClick={() => void sim.clearAll()} disabled={bulkBlock != null} className={TOOL_BTN}
                title={bulkBlock ?? '清掉模擬區全部排定卡（產線時數保留）；清空前自動存進退回上一步'}>清空排程</button>
            )}
            {isOwner && (
              // D106 ②：模擬區有內容（模擬列／產能覆寫／鎖定）先確認覆蓋；空的直接拉
              <button type="button" onClick={() => { if (simHasContent) setDialog({ t: 'pull' }); else void sim.pullLive() }}
                disabled={bulkBlock != null || stale} className={TOOL_BTN}
                title={bulkBlock ?? (stale ? '起始日已過，請先重設模擬區' : '把正式排程範圍內未完成的卡（日期、線、順序、工時）與各線產能 1:1 拉進模擬區；執行前自動存進退回上一步')}>拉正式區 1:1</button>
            )}
            <button
              type="button"
              aria-pressed={lockModeOn}
              onClick={() => setLockMode(!lockModeOn)}
              disabled={!editable || noLockables}
              title={noLockables ? '清空模式目前沒有卡可以鎖（手動排入後才能鎖）' : '開啟後點卡片＝鎖定／解除（灰底＋🔒），拖曳暫停'}
              className={`rounded border px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${
                lockModeOn ? 'border-amber-500 bg-amber-600 font-semibold text-white' : 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
              }`}
            >{LOCK_MARK} 鎖定模式{lockModeOn ? '：開' : ''}</button>
            <span className="flex flex-wrap items-center gap-1" role="group" aria-label="整條線鎖定">
              {scopeLines.map(l => {
                const on = locks.lineIds.includes(l.id)
                return (
                  <button
                    key={l.id}
                    type="button"
                    aria-pressed={on}
                    disabled={!editable || noLockables}
                    onClick={() => changeLocks(toggleLineLock(locks, l.id), `${on ? '解除鎖定' : '鎖定'} ${l.name}`)}
                    title={on ? `解除 ${l.name} 的整條鎖定` : `整條鎖定 ${l.name}：AI 不能放新卡、也不能移出；採用時這條線不動`}
                    className={`rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${
                      on ? 'border-amber-600 bg-amber-950/60 text-amber-100' : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                    }`}
                  >{on ? `${LOCK_MARK} ` : ''}{l.name}</button>
                )
              })}
            </span>
            <button type="button" onClick={() => setDrawer('locks')} className={TOOL_BTN}>鎖定清單（{locksCount(locks)}）</button>
            <button type="button" onClick={() => setDialog({ t: 'capacity' })} disabled={!simCapacitySource} className={TOOL_BTN}
              title={capEditable ? 'D101：調整模擬區的各線正常／加班時數（只作用在模擬；採用時一起寫進正式產能表）' : '查看模擬區的產線時數'}>
              產線時數{v.capacity && v.capacity.cells.length + v.capacity.weekendsOpened.length > 0 ? `（調整 ${v.capacity.cells.length + v.capacity.weekendsOpened.length}）` : ''}
            </button>
            <span className="mx-1 h-4 w-px bg-slate-700" />
            <button
              type="button"
              onClick={() => setDialog({ t: 'run' })}
              disabled={runBlock != null}
              title={runBlock ?? '讓 AI 排範圍內沒鎖定的卡（約 1～3 分鐘）'}
              className="rounded border border-violet-500 bg-violet-600 px-3 py-1 font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >✦ AI 排程</button>
            <button
              type="button"
              onClick={() => void sim.undoStep()}
              disabled={!isOwner || !lastUndo || busy || sim.pending > 0 || sim.saving}
              title={lastUndo ? `退回到「${lastUndo.label}」之前（${UNDO_KIND_LABEL[lastUndo.kind]}，${clock(lastUndo.at, nowMs)}）` : '沒有可以退回的步驟'}
              className={TOOL_BTN}
            >↶ 退回上一步{session.undo.length > 0 ? ` ${session.undo.length}` : ''}</button>
            <button type="button" onClick={() => setDrawer('history')} className={TOOL_BTN}>歷史</button>
            {(v.latestRun || running || sim.run) && (
              <button type="button" onClick={() => openRunPanel()} className={TOOL_BTN}>AI 結果</button>
            )}
            <span className="flex-1" />
            <SaveStatus sim={sim} nowMs={nowMs} editable={editable} />
            <button
              type="button"
              onClick={() => setDialog({ t: 'adopt' })}
              disabled={adoptBlock != null}
              title={adoptBlock ?? '把模擬版寫進正式排程（只覆蓋模擬的日期 × 未鎖定的線；採用前自動存版本）'}
              className="rounded border border-emerald-500 bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >採用此版排程</button>
          </div>
        )}

        {/* ─── 橫幅 ─── */}
        {running && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-700/60 bg-violet-950/30 px-3 py-2">
            <span className="text-xs font-bold text-violet-100">AI 排程中</span>
            <div className="min-w-0 flex-1">
              <RunProgress phase={running.phase} elapsedMs={runElapsedMs(running, nowMs, sim.serverOffsetMs)} compact />
            </div>
            <button type="button" onClick={() => openRunPanel(running.id)} className="rounded border border-violet-600 px-2 py-0.5 text-xs text-violet-100 hover:bg-violet-900/50">查看</button>
            {isOwner && (
              <span className="basis-full text-[11px] text-violet-200/70">執行期間也可以手動調整模擬區，但那樣 AI 的結果就不會自動放進來（之後可從「歷史」載入）。</span>
            )}
          </div>
        )}
        {staleRun && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-600/70 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
            <b>上次 AI 排程（#{staleRun.id}）超過 6 分鐘沒有結束，背景執行可能已中斷</b>
            <span className="text-amber-200/80">・模擬區沒有被改動；{isOwner ? '可以直接再按「AI 排程」重新執行（會把上次標成失敗）' : '只有本人能重新執行'}</span>
            <span className="flex-1" />
            <button type="button" onClick={() => openRunPanel(staleRun.id)} className="rounded border border-amber-600 px-2 py-0.5 hover:bg-amber-900/50">查看</button>
          </div>
        )}
        {stale && isOwner && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-orange-600/70 bg-orange-950/40 px-3 py-2 text-xs text-orange-100">
            <b>模擬起始日 {md(session?.windowDates[0])} 已經過了</b>・AI 排程與採用前請先重設模擬區（目前內容會存進「退回上一步」）
            <span className="flex-1" />
            <Btn tone="primary" onClick={() => setDialog({ t: 'reset' })} disabled={busy}>重設模擬區</Btn>
          </div>
        )}
        {lockModeOn && (
          <div className="rounded-lg border border-amber-600/70 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-100">
            <b>鎖定模式</b>：點卡片＝鎖定／解除（灰底＋{LOCK_MARK}）；整張訂單在卡片詳情鎖、整條線在上方線名按鈕鎖。拖曳暫停，按「{LOCK_MARK} 鎖定模式」結束。
          </div>
        )}
        {sim.loadError && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-yellow-700/60 bg-yellow-950/30 px-3 py-1.5 text-[11px] text-yellow-100">
            資料更新失敗（{clock(sim.loadError.at, nowMs)}）：{sim.loadError.message}。顯示的是較舊的資料。
            <button type="button" onClick={() => void sim.reload()} className="rounded border border-yellow-600 px-1.5 hover:bg-yellow-900/50">重試</button>
          </div>
        )}
        {session && (
          <SimCapacityBanner capacity={v.capacity ?? null} lines={lines} locks={locks} editable={capEditable}
            onOpen={() => setDialog({ t: 'capacity' })} />
        )}
        {sim.action && <div className="animate-pulse text-xs text-amber-300">{sim.action}中…</div>}

        {/* ─── 檢視切換 ─── */}
        {session && board && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div role="group" aria-label="檢視" className="inline-flex overflow-hidden rounded-lg border border-slate-600">
              <button type="button" aria-pressed={view === 'all'} onClick={() => goView('all')}
                className={`px-3 py-1 font-semibold ${view === 'all' ? 'bg-violet-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>全部 {days.length} 天</button>
              <button type="button" aria-pressed={view === 'day'} onClick={() => goView('day')}
                className={`px-3 py-1 font-semibold ${view === 'day' ? 'bg-violet-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>日</button>
            </div>
            {view === 'day' && (
              <div role="tablist" aria-label="模擬日期" className="flex flex-wrap gap-1">
                {days.map(d => (
                  <button key={d.date} type="button" role="tab" aria-selected={d.date === dayData?.date} onClick={() => setPickedDate(d.date)}
                    className={`rounded border px-2 py-1 ${d.date === dayData?.date ? 'border-violet-500 bg-violet-950/60 text-violet-100' : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'} ${
                      d.load === 'over_overtime' ? 'ring-1 ring-red-500/70' : ''}`}>{mdw(d.date)}</button>
                ))}
              </div>
            )}
            <span className="text-[11px] text-slate-500">
              圖例：{LOCK_MARK} 鎖定（AI 不動）・{AI_MARK} AI 排入・{LIVE_MARK} 正式排程的卡（唯讀）・「（範圍外）」不在模擬範圍的線
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setPoolHidden(h => { writeLS(POOL_HIDDEN_KEY, h ? '0' : '1'); return !h })}
              className="hidden rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-300 hover:bg-slate-800 lg:inline-block"
            >{poolHidden ? '▸ 顯示待排池' : '◂ 收起待排池'}</button>
          </div>
        )}
        {session && !isDesktop && (
          <div className="rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-300">
            手機／平板可以檢視、鎖定、按 AI 排程與採用；拖曳調整請用電腦（寬度 1024px 以上）。
          </div>
        )}
      </header>

      {/* ─── 還沒有模擬區 ─── */}
      {!session && (
        <main className="px-4 pb-8">
          {isOwner ? (
            <div className="mx-auto mt-4 max-w-2xl space-y-4 rounded-2xl border border-slate-700 bg-slate-900/70 p-5">
              <div>
                <h2 className="text-lg font-bold text-white">建立你的模擬區</h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  流程：建立模擬區 → 鎖定不想動的卡／訂單／線 → 按「AI 排程」→ 在模擬區調整 → 「採用此版排程」寫進正式排程。
                  模擬區每位主管各一份，互相可以唯讀查看。
                </p>
              </div>
              <SimCreateForm value={createValue} onChange={setCreateValue} disabled={busy} />
              <div className="flex justify-end">
                <Btn tone="primary" disabled={busy} onClick={() => void sim.createOrReset(createValue)}>{busy ? '建立中…' : '建立模擬區'}</Btn>
              </div>
            </div>
          ) : (
            <div className="mx-auto mt-8 max-w-md rounded-2xl border border-slate-700 bg-slate-900/70 p-6 text-center text-sm text-slate-300">
              {ownerLabel} 還沒有建立模擬區。
              <div className="mt-4"><Btn onClick={() => setOwner(null)}>回到我的模擬區</Btn></div>
            </div>
          )}
        </main>
      )}

      {/* ─── 模擬區 ─── */}
      {session && board && (
        <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
          <main className="flex flex-col gap-4 px-4 pb-4 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-3">
            <aside className={`eip-scrollbar order-2 min-w-0 lg:order-1 lg:w-[380px] lg:shrink-0 lg:overflow-y-auto lg:pr-1 2xl:w-[420px] ${poolHidden ? 'lg:hidden' : ''}`}>
              {/* ⚠ 不傳手動參數：模擬區不能加單、也不放到待排池頁的管理連結（規格 §八；D102 加單只在待排池頁） */}
              <PoolSidebar
                blocks={board.pool.blocks}
                cardMeta={board.pool.cardMeta}
                today={board.today}
                rollTarget={board.rollTarget}
                canDrag={canDrag}
                editable={editable}
                dragKind={activeDrag?.kind ?? null}
                onOpenOrder={openOrder}
                onPoolAction={onPoolAction}
              >
                <details className="rounded-xl border border-slate-800 bg-slate-950/40">
                  <summary className="cursor-pointer px-3 py-2 text-xs text-slate-300">
                    待排區（主管擱置 {board.holding.length} 張・模擬區唯讀，AI 不動）
                  </summary>
                  <div className="p-1.5">
                    <ParkingArea
                      cards={board.holding}
                      today={board.today}
                      dragRule={activeDrag?.rule ?? null}
                      editable={false}
                      canDrag={false}
                      hideCompleted={false}
                      handlersFor={handlersFor}
                      onOpenOrder={openOrder}
                      onOpenDetail={bc => setDetailId(bc.placementId)}
                    />
                  </div>
                </details>
              </PoolSidebar>
            </aside>

            <section className="relative order-1 flex min-w-0 flex-1 flex-col lg:order-3 lg:min-h-0" aria-label="模擬排程">
              {view === 'day' ? (
                dayData ? (
                  <DayLanesView
                    day={dayData}
                    today={board.today}
                    prevDate={dayIdx > 0 ? days[dayIdx - 1].date : null}
                    nextDate={dayIdx >= 0 && dayIdx < days.length - 1 ? days[dayIdx + 1].date : null}
                    dragRule={activeDrag?.rule ?? null}
                    dragging={!!activeDrag}
                    editable={editable}
                    canDrag={canDrag}
                    canResize={canDrag}
                    stale={false}
                    stacked={!isDesktop}
                    hideCompleted={false}
                    defaultLineName={usableLines[0]?.name ?? null}
                    handlersFor={handlersFor}
                    onOpenOrder={openOrder}
                    onOpenDetail={onOpenDetail}
                    onEditCapacity={(date, lineId) => setDialog({ t: 'capacity', date, lineId })}
                    onGoDate={d => setPickedDate(d)}
                    onResize={resizeMinutes}
                    onResizing={sim.setDragging}
                    reorderHint={reorderHint}
                    ownLaneKey={ownLaneKey}
                    capacityReadOnly={!capEditable}
                  />
                ) : (
                  <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-slate-800 text-xs text-slate-500">沒有日期</div>
                )
              ) : (
                <div className="relative min-h-[16rem] lg:min-h-0 lg:flex-1">
                  <MultiDayView
                    days={days}
                    dense={days.length > 7}
                    today={board.today}
                    dragRule={activeDrag?.rule ?? null}
                    // 欄頭「放開＝自動放到 X 線」的提示用的是全部線；模擬區只能放未鎖定的線 → 不顯示提示，免得說的和做的不一樣
                    drag={null}
                    defaultLineId={usableLines[0]?.id ?? null}
                    editable={editable}
                    canDrag={canDrag}
                    stale={false}
                    hideCompleted={false}
                    handlersFor={handlersFor}
                    onOpenOrder={openOrder}
                    onOpenDetail={onOpenDetail}
                    onPickDay={d => { setPickedDate(d); goView('day') }}
                    onEditCapacity={(date, lineId) => setDialog({ t: 'capacity', date, lineId })}
                    reorderHint={reorderHint}
                    ownLaneKey={ownLaneKey}
                    capacityReadOnly={!capEditable}
                  />
                </div>
              )}
            </section>
          </main>

          <DragOverlay dropAnimation={null}>
            {activeDrag?.kind === 'pool' ? (
              <div className="w-[300px] rotate-1 rounded-md border border-violet-400 bg-slate-900 shadow-2xl ring-2 ring-violet-400/40">
                <SimplePoolCardFace card={activeDrag.card} today={board.today} overlay />
              </div>
            ) : activeDrag?.kind === 'placement' ? (
              <PlacementCardOverlay bc={activeDrag.bc} today={board.today} />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* ─── 對話框 ─── */}
      {dialog?.t === 'pull' && session && (
        <Modal
          title="拉正式區 1:1，覆蓋目前的模擬區？"
          onClose={() => setDialog(null)}
          footer={<>
            <Btn onClick={() => setDialog(null)}>取消</Btn>
            <Btn tone="primary" disabled={busy || bulkBlock != null} onClick={() => { void sim.pullLive().then(ok => { if (ok) { setDialog(null); setLockMode(false) } }) }}>
              {busy ? '處理中…' : '確定覆蓋並拉進來'}
            </Btn>
          </>}
        >
          <div className="mb-3 rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-100">
            將覆蓋目前模擬區：模擬 {session.placementCount} 張卡
            {capacityCount > 0 ? `、調整過的產線時數 ${capacityCount} 項` : ''}
            {locksCount(locks) > 0 ? `、鎖定 ${locksCount(locks)} 項` : ''}
            。執行前會自動存進「退回上一步」，按一下就能回來。
          </div>
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-200">
            <li>範圍 {mdw(session.windowDates[0])}～{mdw(session.windowDates[session.windowDates.length - 1])} 內，正式排程<b>未完成</b>的卡（日期、線、線內順序、改過的工時）整份複製進來；已完成的卡不複製。</li>
            <li>各線產能回到<b>正式產能表的值</b>（模擬區調整過的時數與模擬才開的週末加班會拿掉）。</li>
            <li>範圍外的正式卡與待排區的卡本來就以「正式排程的卡（唯讀）」顯示，不用複製。</li>
            <li>鎖定：訂單鎖與整條線鎖保留；卡片鎖只保留「複製自正式卡」的那些。</li>
          </ul>
        </Modal>
      )}
      {dialog?.t === 'closeCase' && (
        <SimCloseDialog
          bc={dialog.bc}
          onClose={() => setDialog(null)}
          onDone={onClosureDone}
        />
      )}
      {dialog?.t === 'reset' && session && (
        <SimCreateDialog
          initial={{ horizon: session.horizon, mode: session.mode }}
          capacityCount={(v.capacity?.cells.length ?? 0) + (v.capacity?.weekendsOpened.length ?? 0)}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={val => { void sim.createOrReset(val).then(ok => { if (ok) { setDialog(null); setLockMode(false) } }) }}
        />
      )}
      {dialog?.t === 'run' && session && (
        <Modal
          title="讓 AI 排這個模擬區？"
          onClose={() => setDialog(null)}
          footer={<>
            <Btn onClick={() => setDialog(null)}>取消</Btn>
            <Btn tone="primary" disabled={busy || runBlock != null} onClick={() => { void sim.startRun().then(ok => { if (ok) setDialog(null) }) }}>
              {busy ? '送出中…' : '開始 AI 排程'}
            </Btn>
          </>}
        >
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-200">
            <li>範圍：{mdw(session.windowDates[0])}～{mdw(session.windowDates[session.windowDates.length - 1])}（{horizonLabel(session.horizon)}）・{scopeLines.map(l => l.name).join('、')}</li>
            <li>AI 會重排<b>沒鎖定</b>的模擬卡與待排池裡可排的卡；鎖定的卡／訂單／線（目前 {locksCount(locks)} 項）原位不動、照樣佔產能。</li>
            <li>待排區（主管擱置）、已完成、工時未知的卡不會交給 AI；工時未知的會列在結果裡請你手動排。</li>
            <li>AI 的排法會經過程式驗算：超產能、排在可包日之前、動到鎖定的部分會被修正或退回待排池，並寫在結果的「系統修正」。</li>
            <li>送給 AI 的資料已去識別化（客戶換成代號、不送備註／金額／地址，D84）；規則照「規則與門檻」最新版。</li>
            <li>約 1～3 分鐘。目前的模擬區會先存進「退回上一步」，不滿意可以一鍵退回。</li>
          </ul>
        </Modal>
      )}
      {dialog?.t === 'adopt' && session && (
        <AdoptDialog
          meEmail={v.me.email}
          lines={lines}
          getVersion={sim.getVersion}
          isIdle={sim.isIdle}
          onClose={() => setDialog(null)}
          onAdopted={r => { showToast('info', `已採用到正式排程（採用前版本 #${r.versionId}）`); void sim.reload() }}
          onFailed={() => { void sim.reload() }}
        />
      )}
      {dialog?.t === 'split' && (
        <SplitDialog
          bc={dialog.bc}
          days={dateOptions}
          lines={usableLines}
          onClose={() => setDialog(null)}
          onSubmit={(keepQty, parts) => {
            const bc = dialog.bc
            if (parts.some(p => p.toDate == null)) { showToast('warn', '模擬區沒有待排區：拆出來的每一張都要選模擬範圍內的日期'); return }
            const origUsable = bc.lineId != null && usableLineIds.includes(bc.lineId) ? bc.lineId : null
            const withIds = parts.map(p => ({
              id: newId(),
              qty: p.qty,
              toDate: p.toDate as YMD,
              lineId: p.line !== 'same' ? p.line : (origUsable ?? autoLane(p.toDate as YMD, null)),
            }))
            for (const p of withIds) if (!assertTarget(p.toDate, p.lineId)) return
            setDialog(null)
            submitOps(
              [{ op: 'split', id: bc.placementId, version: bc.version, keepQty, parts: withIds.map(p => ({ id: p.id, qty: p.qty, toDate: p.toDate, lineId: p.lineId })) }],
              `拆卡 ${lineLabel(bc.card)} → ${[keepQty, ...parts.map(p => p.qty)].map(fmtQty).join('／')}`,
              [{ t: 'split', id: bc.placementId, keepQty, parts: withIds }],
            )
          }}
        />
      )}
      {dialog?.t === 'move' && (
        <QtyDateDialog
          mode="move"
          title={`移動 ${lineLabel(dialog.bc.card)}`}
          days={dateOptions}
          today={board?.today ?? v.today}
          minDate={ruleForBoardCard(dialog.bc).minDate}
          lines={usableLines}
          onClose={() => setDialog(null)}
          onSubmit={(_q, toDate, line) => {
            const bc = dialog.bc
            const lineId = toDate == null ? null : line === 'auto' ? autoLane(toDate, bc) : line
            if (!assertTarget(toDate, lineId) || toDate == null || lineId == null) return
            setDialog(null)
            moveCard(bc, toDate, lineId)
          }}
        />
      )}
      {dialog?.t === 'partial' && board && (() => {
        const card = dialog.card
        const remaining = board.pool.cardMeta[card.cardId]?.remainingQty ?? card.qtyCard
        return (
          <QtyDateDialog
            mode="place"
            title={`排部分數量：${lineLabel(card)}`}
            days={dateOptions}
            today={board.today}
            maxQty={remaining}
            defaultQty={remaining}
            readyQty={card.qtyReady}
            minDate={ruleForPoolCard(card).minDate}
            lines={usableLines}
            onClose={() => setDialog(null)}
            onSubmit={(qty, toDate, line) => {
              const lineId = toDate == null ? null : line === 'auto' ? autoLane(toDate, null) : line
              if (!assertTarget(toDate, lineId) || toDate == null || lineId == null) return
              setDialog(null)
              if (qty && qty > 0) placePool(card, qty, toDate, lineId)
            }}
          />
        )
      })()}
      {dialog?.t === 'capacity' && simCapacitySource && (
        // D101：模擬區的產線時數（重用正式的產能表元件，只換資料來源；不需要正式編輯鎖）
        <CapacityEditor
          mode={dialog.date ? { kind: 'day', date: dialog.date, lineId: dialog.lineId } : { kind: 'table' }}
          today={v.today}
          editable={capEditable}
          readonlyHint={SIM_CAPACITY_READONLY}
          getLockToken={() => null}
          source={simCapacitySource}
          onClose={() => setDialog(null)}
          // 儲存成功時 useSim.saveCapacity 已用回應更新整個畫面（工作台負荷條＋產能表），不必再重抓
          onSaved={() => {}}
        />
      )}

      {detailRaw && (() => {
        const st = cardState(detailRaw)
        // D100 不能改（順序、工時）的共同原因：不是本人、起始日已過、有動作進行中
        const writeBlock = !isOwner ? '別人的模擬區只能檢視'
          : stale ? '模擬起始日已過，請先重設模擬區'
            : busy ? '請等目前的動作完成' : null
        // D100 順序列：排在日期上、那天在畫面上的卡；鎖定模式開著時點卡片是鎖定，這裡也先停用免得混淆
        const laneId = detailRaw.laneId ?? null
        const laneDay = detailRaw.planDate != null && detailRaw.displayDate != null && laneId != null
          ? rawBoard?.days.find(d => d.date === detailRaw.displayDate) : undefined
        let laneOrder: LaneOrderProps | null = null
        if (laneDay && laneId != null) {
          const info = simLaneStepInfo(laneDay, laneId, detailRaw.placementId, simCtx)
          const block = writeBlock ?? (lockModeOn ? `鎖定模式開著：先按「${LOCK_MARK} 鎖定模式」結束，再調整順序` : null)
          laneOrder = {
            lineName: lineName(laneId),
            info: block ? { ...info, up: block, down: block } : info,
            hint: '每按一次＝一格「退回上一步」（連按時還沒送出的會併成一格）',
            onStep: dir => { if (!block) stepInLane(detailRaw.placementId, dir) },
          }
        }
        const minutesHint = writeBlock ? `${writeBlock}，不能改工時`
          : st.lockedBy.length > 0 ? '鎖定的卡不能改工時，先解除鎖定' : null
        return (
        <SimCardDetail
          bc={detailRaw}
          state={st}
          laneOrder={laneOrder}
          focusMinutes={detailFocus}
          minutesReadonlyHint={minutesHint}
          today={v.today}
          lines={lines}
          editable={editable}
          busy={busy}
          onClose={() => setDetailId(null)}
          onOpenOrder={openOrder}
          onToggleCardLock={() => toggleCard(detailRaw)}
          onToggleOrderLock={() => {
            const so = soNumberOfKey(detailRaw.soLineKey)
            const on = locks.soNumbers.includes(so)
            changeLocks(toggleOrderLock(locks, detailRaw.soLineKey), `${on ? '解除鎖定' : '鎖定'}訂單 ${so}`)
          }}
          onSubmitMinutes={(m, reason) => setMinutes(detailRaw, m, reason, 'dialog')}
          // D107：結案是正式區的事實（只需 packaging_admin，不看模擬區的鎖）；但要等模擬區沒有東西在儲存，
          //   否則佇列裡的操作會撞到伺服器順手移除模擬卡後的新 version
          onCloseCase={() => { setDetailId(null); setDialog({ t: 'closeCase', bc: detailRaw }) }}
          closeCaseHint={!isOwner ? '請回到自己的模擬區再結案（結案會動到正式區與所有人的模擬區）'
            : sim.pending > 0 || sim.saving ? '還有操作儲存中，請稍候'
              : busy ? '請等目前的動作完成' : null}
        />
        )
      })()}
      {orderSo && <PackagingOrderModal so={orderSo} open onClose={() => setOrderSo(null)} />}

      {/* ─── 抽屜 ─── */}
      {drawer === 'run' && (
        <AiRunPanel
          run={sim.run}
          running={v.runningRun}
          loading={sim.runLoading}
          error={sim.runError}
          nowMs={nowMs}
          serverOffsetMs={sim.serverOffsetMs}
          lines={lines}
          currentWindow={session?.windowDates ?? null}
          isOwner={isOwner}
          busy={busy || sim.pending > 0}
          onClose={() => setDrawer(null)}
          onLoad={doLoadRun}
        />
      )}
      {drawer === 'history' && (
        <RunHistory
          owner={owner}
          isOwner={isOwner}
          currentWindow={session?.windowDates ?? null}
          busy={busy || sim.pending > 0}
          nowMs={nowMs}
          onClose={() => setDrawer(null)}
          onShow={id => openRunPanel(id)}
          onLoad={doLoadRun}
        />
      )}
      {drawer === 'locks' && (
        <LockPanel
          locks={locks}
          simCards={simCards}
          board={rawBoard}
          lines={lines}
          editable={editable}
          onChange={changeLocks}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer === 'rules' && (
        <RulesDrawer tab={rulesTab} onTab={setRulesTab} nowMs={nowMs} onClose={closeDrawer} onRulesDirty={onRulesDirty} onThresholdsDirty={onThresholdsDirty} />
      )}

      {/* ─── 提示 ─── */}
      {toast && (
        <div role="alert" className={`fixed bottom-4 left-1/2 z-[70] flex max-w-[92vw] -translate-x-1/2 items-start gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-2xl ${
          toast.kind === 'error' ? 'border-red-600 bg-red-950 text-red-100'
            : toast.kind === 'warn' ? 'border-orange-600 bg-orange-950 text-orange-100'
              : 'border-violet-600 bg-slate-900 text-violet-100'
        }`}>
          <span className="min-w-0 break-words">{toast.text}</span>
          <button type="button" onClick={dismissToast} aria-label="關閉提示" className="shrink-0 text-lg leading-none opacity-70 hover:opacity-100">×</button>
        </div>
      )}
    </div>
  )
}

/** 自動儲存狀態（同正式工作台的寫法） */
function SaveStatus({ sim, nowMs, editable }: { sim: ReturnType<typeof useSim>; nowMs: number; editable: boolean }) {
  if (sim.saveError) {
    return (
      <span className="flex flex-wrap items-center gap-2 rounded border border-red-700 bg-red-950/50 px-2 py-1 text-red-200">
        {sim.saveError.count} 個操作未儲存（{sim.saveError.message}）
        <button type="button" onClick={sim.retryNow} className="rounded border border-red-600 px-1.5 hover:bg-red-900/60">重試</button>
        <button type="button" onClick={sim.discardQueue} className="rounded border border-red-600 px-1.5 hover:bg-red-900/60">放棄並重新載入</button>
      </span>
    )
  }
  if (sim.pending > 0 || sim.saving) return <span className="text-amber-300">儲存中…（尚未儲存 {sim.pending}）</span>
  if (sim.lastSavedAt) return <span className="text-slate-400">模擬區已儲存 {clock(sim.lastSavedAt, nowMs)}</span>
  return editable ? <span className="text-slate-500">每次操作自動儲存（只存在模擬區）</span> : null
}

function RulesDrawer({ tab, onTab, nowMs, onClose, onRulesDirty, onThresholdsDirty }: {
  tab: 'rules' | 'thresholds'
  onTab: (t: 'rules' | 'thresholds') => void
  nowMs: number
  onClose: () => void
  onRulesDirty: (d: boolean) => void
  onThresholdsDirty: (d: boolean) => void
}) {
  const tabBtn = (t: 'rules' | 'thresholds', label: string) => (
    <button type="button" role="tab" aria-selected={tab === t} onClick={() => onTab(t)}
      className={`px-3 py-1 text-xs font-semibold ${tab === t ? 'bg-violet-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>{label}</button>
  )
  return (
    <Drawer title="規則與門檻" onClose={onClose}>
      <div role="tablist" className="mb-3 inline-flex overflow-hidden rounded-lg border border-slate-600">
        {tabBtn('rules', '主管建議規則')}
        {tabBtn('thresholds', '大量門檻表')}
      </div>
      {/* 兩個面板都保持掛載（切分頁不會丟掉未儲存的輸入），只切換顯示 */}
      <div className={tab === 'rules' ? '' : 'hidden'}><RulesPanel nowMs={nowMs} onDirtyChange={onRulesDirty} /></div>
      <div className={tab === 'thresholds' ? '' : 'hidden'}><ThresholdsPanel nowMs={nowMs} onDirtyChange={onThresholdsDirty} /></div>
    </Drawer>
  )
}

function AccessDenied() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#050b14] p-4">
      <div className="w-full max-w-md rounded-2xl border border-red-800 bg-slate-900 p-10 text-center">
        <h1 className="mb-3 text-xl font-bold text-red-400">沒有 AI 模擬排程的權限</h1>
        <p className="mb-6 text-sm leading-relaxed text-slate-400">需要「包裝專區（AI 模擬排程）」權限，請聯絡核心管理員在管理後台開通。</p>
        <Link href="/packaging" className="rounded border border-slate-600 px-6 py-2 text-sm text-slate-300 hover:bg-slate-700">← 回包裝專區</Link>
      </div>
    </div>
  )
}
