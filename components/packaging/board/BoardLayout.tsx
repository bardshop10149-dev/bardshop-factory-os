'use client'

// 包裝排程工作台（P1，D21 左右分欄）：左＝待排池＋待排區，右＝今天起 10 個台灣工作日的日期欄。
//
// 元件分工：
//   BoardLayout（本檔）：DndContext、拖放 → 操作（op）轉換、工具列、對話框開關
//   useBoard：載入／輪詢／佇列／樂觀更新／Undo　useEditLock：編輯鎖　useUndo：50 步堆疊
//   PoolSidebar／ParkingArea／DayColumn／DraggableCard：畫面（卡片本體沿用 P0 PackagingCard，樣式不改）
//
// 資料一律經 /api/packaging/*（瀏覽器端 Supabase 是 anon，不直接查表）。
// 每次操作立即送出（自動儲存）；唯讀者與沒有編輯鎖的人看得到但不能拖、不能勾。

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
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  BOARD_MAX_WORKDAYS,
  type BoardCard,
  type BoardDay,
  type PlacementOp,
  type YMD,
} from '@/lib/packaging/scheduleTypes'
import type { PackagingCard as PackagingCardData } from '@/lib/packaging/types'
import PackagingCard from '@/components/packaging/PackagingCard'
import PackagingOrderModal from '@/components/packaging/PackagingOrderModal'
import { fmtQty } from '@/components/packaging/poolStyles'
import { newId, ruleForBoardCard, ruleForPoolCard, type DragRule } from './boardLocal'
import { ago, clock, hours, md, mdw } from './boardFormat'
import { useUndo } from './useUndo'
import { useEditLock } from './useEditLock'
import { useBoard } from './useBoard'
import PoolSidebar, { type PoolAction } from './PoolSidebar'
import ParkingArea from './ParkingArea'
import DayColumn, { mergeCandidates } from './DayColumn'
import { CardFrame, type CardMenuHandlers } from './DraggableCard'
import LockBanner from './LockBanner'
import SplitDialog from './SplitDialog'
import QtyDateDialog from './QtyDateDialog'
import CapacityEditor from './CapacityEditor'
import VersionsPanel from './VersionsPanel'

const HIDE_DONE_KEY = 'packaging.schedule.hideCompleted.v1'

type ActiveDrag =
  | { kind: 'pool'; card: PackagingCardData; rule: DragRule }
  | { kind: 'placement'; bc: BoardCard; rule: DragRule }

type Dialog =
  | { t: 'split'; bc: BoardCard }
  | { t: 'move'; bc: BoardCard }
  | { t: 'partial'; card: PackagingCardData }
  | { t: 'capacity-day'; date: YMD }
  | { t: 'capacity-table' }
  | { t: 'versions' }

/** 桌機（≥ 1024px）才提供拖曳（D54 現場裝置先不處理） */
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

function lineLabel(c: { so: string; soLine: string | null }): string {
  return `${c.so}${c.soLine ? `-${c.soLine}` : ''}`
}

function readInitialPanel(): Dialog | null {
  try {
    const p = new URLSearchParams(window.location.search).get('panel')
    if (p === 'capacity') return { t: 'capacity-table' }
    if (p === 'versions') return { t: 'versions' }
  } catch { /* 忽略 */ }
  return null
}

export default function BoardLayout() {
  const router = useRouter()
  const [denied, setDenied] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [dialog, setDialog] = useState<Dialog | null>(() => (typeof window === 'undefined' ? null : readInitialPanel()))
  const [orderSo, setOrderSo] = useState<string | null>(null)
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null)
  const [hideDone, setHideDone] = useState<boolean>(() => {
    try { return typeof window !== 'undefined' && window.localStorage.getItem(HIDE_DONE_KEY) === '1' } catch { return false }
  })
  const isDesktop = useIsDesktop()

  const undo = useUndo()
  const boardRef = useRef<ReturnType<typeof useBoard> | null>(null)
  const lk = useEditLock({
    onGained: () => undo.clear(),
    onLost: why => {
      undo.clear()
      if (why === 'lost' || why === 'released') boardRef.current?.clearQueue()
    },
  })
  const board = useBoard({
    enabled: !denied,
    lock: lk,
    undo,
    onUnauthorized: () => router.replace('/login'),
    onForbidden: () => setDenied(true),
  })
  useEffect(() => { boardRef.current = board })

  const data = board.data
  const me = data?.me

  const editable = !!me?.canEdit && lk.phase === 'mine'
  const canDrag = editable && isDesktop

  // 時鐘（「N 分鐘前」、鎖逾時倒數）
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [])

  // toast 6 秒後自動消失
  const toast = board.toast
  const dismissToast = board.dismissToast
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(dismissToast, toast.kind === 'error' ? 10_000 : 6000)
    return () => window.clearTimeout(id)
  }, [toast, dismissToast])

  // 鍵盤：Ctrl+Z 復原、Ctrl+Shift+Z／Ctrl+Y 重做（輸入框或對話框開著時不作用）
  const { undoStep, redoStep } = board
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (document.querySelector('[data-board-dialog]')) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoStep() }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redoStep() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoStep, redoStep])

  const toggleHideDone = () => setHideDone(v => {
    try { window.localStorage.setItem(HIDE_DONE_KEY, v ? '0' : '1') } catch { /* 忽略 */ }
    return !v
  })

  // ── 操作 ────────────────────────────────────────────────────────────────
  const { submit, showToast } = board
  const actor = useMemo(() => ({ email: me?.email ?? '', name: me?.name ?? null }), [me?.email, me?.name])

  const placePool = useCallback((card: PackagingCardData, qty: number, toDate: YMD | null, how = '排定') => {
    const id = newId()
    const op: PlacementOp = { op: 'place', id, soLineKey: card.soLineKey, qty, toDate, originCardId: card.cardId }
    submit([op], `${how} ${lineLabel(card)} ${fmtQty(qty)} → ${toDate ? md(toDate) : '待排區'}`, [{ t: 'place', id, qty, toDate, poolCard: card }])
  }, [submit])

  const moveCard = useCallback((bc: BoardCard, toDate: YMD | null) => {
    if (toDate === bc.planDate) return
    submit(
      [{ op: 'move', id: bc.placementId, version: bc.version, toDate }],
      `移動 ${lineLabel(bc.card)} → ${toDate ? md(toDate) : '待排區'}`,
      [{ t: 'move', id: bc.placementId, toDate }],
    )
  }, [submit])

  const unplaceCard = useCallback((bc: BoardCard) => {
    submit(
      [{ op: 'unplace', id: bc.placementId, version: bc.version }],
      `放回待排池 ${lineLabel(bc.card)}`,
      [{ t: 'unplace', id: bc.placementId }],
    )
  }, [submit])

  const handlersFor = useCallback((bc: BoardCard, siblings: BoardCard[]): CardMenuHandlers => {
    const others = mergeCandidates(siblings, bc)
    return {
      onToggleComplete: c => {
        if (c.completed) {
          submit([{ op: 'uncomplete', id: c.placementId, version: c.version }], `取消完成 ${lineLabel(c.card)}`,
            [{ t: 'uncomplete', id: c.placementId }], 'complete')
        } else {
          submit([{ op: 'complete', id: c.placementId, version: c.version }], `完成 ${lineLabel(c.card)}`,
            [{ t: 'complete', id: c.placementId, by: actor.email, byName: actor.name, atIso: new Date().toISOString() }], 'complete')
        }
      },
      onSplit: c => setDialog({ t: 'split', bc: c }),
      onMoveTo: c => setDialog({ t: 'move', bc: c }),
      onToHolding: c => moveCard(c, null),
      onUnplace: c => unplaceCard(c),
      onMerge: others.length > 0 ? c => {
        submit(
          [{ op: 'merge', targetId: c.placementId, targetVersion: c.version, sources: others.map(o => ({ id: o.placementId, version: o.version })) }],
          `合併 ${lineLabel(c.card)}（${others.length + 1} 張）`,
          [{ t: 'merge', targetId: c.placementId, sourceIds: others.map(o => o.placementId) }],
        )
      } : undefined,
    }
  }, [submit, actor, moveCard, unplaceCard])

  const onPoolAction = useCallback((card: PackagingCardData, action: PoolAction) => {
    if (!data) return
    const remaining = data.pool.cardMeta[card.cardId]?.remainingQty ?? card.qtyCard
    if (action === 'partial') { setDialog({ t: 'partial', card }); return }
    if (action === 'holding') { placePool(card, remaining, null, '擱置'); return }
    // 直接勾完成＝同一批 place（排到順延目標日，通常是今天）＋ complete（規格 §4.3）
    // 預排卡：place 會先驗 D22 → 伺服器必回 before_est_ready；選單已停用，這裡再擋一次（業務規則待 Snow 決定）
    const minDate = ruleForPoolCard(card).minDate
    if (minDate && minDate > data.rollTarget) {
      showToast('warn', `預排卡預估 ${md(minDate)} 才可包，不能直接完成；請先排到 ${md(minDate)} 或之後`)
      return
    }
    const id = newId()
    submit(
      [
        { op: 'place', id, soLineKey: card.soLineKey, qty: remaining, toDate: data.rollTarget, originCardId: card.cardId },
        { op: 'complete', id, version: 1 },
      ],
      `直接完成 ${lineLabel(card)} ${fmtQty(remaining)}`,
      [
        { t: 'place', id, qty: remaining, toDate: data.rollTarget, poolCard: card },
        { t: 'complete', id, by: actor.email, byName: actor.name, atIso: new Date().toISOString() },
      ],
      'complete',
    )
  }, [data, placePool, submit, actor, showToast])

  // ── 拖曳 ────────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  )

  const onDragStart = (e: DragStartEvent) => {
    const d = e.active.data.current as { kind?: string; card?: PackagingCardData | null; bc?: BoardCard } | undefined
    if (d?.kind === 'pool' && d.card) setActiveDrag({ kind: 'pool', card: d.card, rule: ruleForPoolCard(d.card) })
    else if (d?.kind === 'placement' && d.bc) setActiveDrag({ kind: 'placement', bc: d.bc, rule: ruleForBoardCard(d.bc) })
    board.setDragging(true)
  }

  const onDragEnd = (e: DragEndEvent) => {
    const drag = activeDrag
    setActiveDrag(null)
    board.setDragging(false)
    if (!drag || !e.over || !data) return
    const overId = String(e.over.id)
    const toDate: YMD | null | undefined = overId.startsWith('day:') ? overId.slice(4) : overId === 'holding' ? null : undefined
    if (drag.kind === 'pool') {
      if (toDate === undefined || drag.rule.blocked) return
      if (toDate && drag.rule.minDate && toDate < drag.rule.minDate) return
      const remaining = data.pool.cardMeta[drag.card.cardId]?.remainingQty ?? drag.card.qtyCard
      if (!(remaining > 0)) return
      placePool(drag.card, remaining, toDate, toDate ? '拖曳' : '擱置')
      return
    }
    // 擺放卡
    if (overId === 'pool') { unplaceCard(drag.bc); return }
    if (toDate === undefined || drag.rule.blocked) return
    if (toDate && drag.rule.minDate && toDate < drag.rule.minDate) return
    moveCard(drag.bc, toDate)
  }

  const onDragCancel = () => {
    setActiveDrag(null)
    board.setDragging(false)
  }

  // ── 狀態畫面 ────────────────────────────────────────────────────────────
  if (denied) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050b14] p-4">
        <div className="w-full max-w-md rounded-2xl border border-red-800 bg-slate-900 p-10 text-center">
          <h1 className="mb-3 text-xl font-bold text-red-400">存取被拒絕</h1>
          <p className="mb-6 text-sm text-slate-400">你沒有包裝專區的存取權限，請聯絡核心管理員開通。</p>
          <Link href="/" className="rounded border border-slate-600 px-6 py-2 text-sm text-slate-300 hover:bg-slate-700">← 返回首頁</Link>
        </div>
      </div>
    )
  }

  if (!data) {
    const err = board.loadError
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050b14] p-4 text-white">
        {err ? (
          <div className="w-full max-w-lg rounded-2xl border border-red-800 bg-slate-900 p-8 text-center">
            <h1 className="text-lg font-bold text-red-300">{err.missingTable ? '排程工作台尚未啟用' : '工作台載入失敗'}</h1>
            <p className="mt-3 break-words text-sm text-slate-300">{err.message}</p>
            {err.missingTable && (
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                P1 的 packaging_* 資料表要由 Snow 在 Supabase 備份後手動套用 migration；套用前工作台無法讀寫。待排池（唯讀）不受影響。
              </p>
            )}
            <div className="mt-6 flex justify-center gap-2">
              <button type="button" onClick={() => void board.reload()} disabled={board.loading}
                className="rounded border border-slate-600 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50">{board.loading ? '重試中…' : '重試'}</button>
              <Link href="/packaging/pool" className="rounded border border-slate-600 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800">看待排池</Link>
            </div>
          </div>
        ) : (
          <div className="animate-pulse font-mono text-sm text-amber-400">載入工作台…（待排池冷啟動約 3~6 秒）</div>
        )}
      </div>
    )
  }

  const cpSyncLabel = data.freshness.changping ? `常平資料 ${clock(data.freshness.changping, nowMs)}` : '常平資料時間不明'
  const loadErr = board.loadError
  const holdingCards = data.holding

  return (
    <div className="min-h-screen bg-[#050b14] text-white lg:flex lg:h-screen lg:flex-col lg:overflow-hidden">
      {/* ─── 標題列＋鎖橫幅＋工具列 ─── */}
      <header className="shrink-0 space-y-2 px-4 pb-2 pt-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <div className="min-w-0">
            <Link href="/packaging" className="text-xs font-mono text-slate-400 hover:text-white">← 包裝專區</Link>
            <h1 className="text-xl font-bold">
              包裝排程工作台
              <span className="ml-2 align-middle rounded border border-sky-600/50 bg-sky-950/40 px-1.5 py-0.5 text-[11px] font-semibold text-sky-300">P1</span>
            </h1>
          </div>
          <p className="text-[11px] text-slate-400">
            今天 {mdw(data.today)}
            {data.rollTarget !== data.today && <span className="text-orange-300">・今天非工作日，延誤卡順延到 {mdw(data.rollTarget)}</span>}
            <span className="text-slate-500">
              ・待排池彙整 {clock(data.pool.generatedAt, nowMs)}（{ago(data.pool.generatedAt, nowMs + lk.offsetMs)}）
              {board.lastLoadedAt ? `・畫面更新 ${clock(board.lastLoadedAt, nowMs)}` : ''}
            </span>
          </p>
          <div className="flex-1" />
          <button type="button" onClick={() => void board.reload(true)} disabled={board.loading || board.pending > 0}
            title="略過伺服器快取，重新彙整待排池（約 3~6 秒）"
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50">
            {board.loading ? '更新中…' : '重新整理'}
          </button>
        </div>

        <LockBanner lk={lk} canEdit={!!me?.canEdit} nowMs={nowMs} pending={board.pending} pausedForLock={board.paused === 'lock_required'} />

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" onClick={board.undoStep} disabled={!editable || !undo.canUndo || !board.canStep}
            title={undo.canUndo ? `復原：${undo.state.undo[undo.state.undo.length - 1]?.label}（Ctrl+Z）` : '沒有可復原的操作'}
            className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-200 hover:bg-slate-800 disabled:opacity-40">↶ 復原{undo.state.undo.length > 0 ? ` ${undo.state.undo.length}` : ''}</button>
          <button type="button" onClick={board.redoStep} disabled={!editable || !undo.canRedo || !board.canStep}
            title={undo.canRedo ? `重做：${undo.state.redo[undo.state.redo.length - 1]?.label}（Ctrl+Shift+Z）` : '沒有可重做的操作'}
            className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-200 hover:bg-slate-800 disabled:opacity-40">↷ 重做{undo.state.redo.length > 0 ? ` ${undo.state.redo.length}` : ''}</button>
          <span className="mx-1 h-4 w-px bg-slate-700" />
          <button type="button" onClick={() => setDialog({ t: 'capacity-table' })}
            className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-200 hover:bg-slate-800">產能表</button>
          <button type="button" onClick={() => setDialog({ t: 'versions' })}
            className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-200 hover:bg-slate-800">版本</button>
          <label className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-slate-300 hover:bg-slate-900">
            <input type="checkbox" checked={hideDone} onChange={toggleHideDone} className="accent-sky-500" />隱藏已完成
          </label>
          <span className="flex-1" />
          {/* 自動儲存狀態 */}
          {board.saveError ? (
            <span className="flex flex-wrap items-center gap-2 rounded border border-red-700 bg-red-950/50 px-2 py-1 text-red-200">
              {board.saveError.count} 個操作未儲存（{board.saveError.message}）
              <button type="button" onClick={board.retryNow} className="rounded border border-red-600 px-1.5 hover:bg-red-900/60">重試</button>
              <button type="button" onClick={board.discardQueue} className="rounded border border-red-600 px-1.5 hover:bg-red-900/60">放棄並重新載入</button>
            </span>
          ) : board.pending > 0 || board.saving ? (
            <span className="text-amber-300">儲存中…（尚未儲存 {board.pending}）</span>
          ) : board.lastSavedAt ? (
            <span className="text-slate-400">已自動儲存 {clock(board.lastSavedAt, nowMs)}</span>
          ) : editable ? (
            <span className="text-slate-500">每次操作自動儲存</span>
          ) : null}
        </div>

        {!isDesktop && (
          <div className="rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-300">
            手機／平板只能檢視；拖曳排程請用電腦（寬度 1024px 以上）。
          </div>
        )}
        {loadErr && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-yellow-700/60 bg-yellow-950/30 px-3 py-1.5 text-[11px] text-yellow-100">
            資料更新失敗（{clock(loadErr.at, nowMs)}）：{loadErr.message}。顯示的是較舊的資料。
            <button type="button" onClick={() => void board.reload()} className="rounded border border-yellow-600 px-1.5 hover:bg-yellow-900/50">重試</button>
          </div>
        )}
      </header>

      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
        <main className="flex flex-col gap-4 px-4 pb-4 lg:min-h-0 lg:flex-1 lg:flex-row">
          {/* ─── 左：待排池＋待排區 ─── */}
          <aside className="order-2 min-w-0 lg:order-1 lg:w-[400px] lg:shrink-0 lg:overflow-y-auto lg:pr-1">
            <PoolSidebar
              blocks={data.pool.blocks}
              cardMeta={data.pool.cardMeta}
              today={data.today}
              rollTarget={data.rollTarget}
              canDrag={canDrag}
              editable={editable}
              dragKind={activeDrag?.kind ?? null}
              onOpenOrder={setOrderSo}
              onPoolAction={onPoolAction}
              changpingSyncLabel={cpSyncLabel}
            >
              <ParkingArea
                cards={holdingCards}
                today={data.today}
                dragRule={activeDrag?.rule ?? null}
                editable={editable}
                canDrag={canDrag}
                hideCompleted={hideDone}
                handlersFor={handlersFor}
                onOpenOrder={setOrderSo}
                changpingSyncLabel={cpSyncLabel}
              />
              <BoardFooter data={data} />
            </PoolSidebar>
          </aside>

          {/* ─── 右：日期欄 ─── */}
          <section className="order-1 min-w-0 flex-1 lg:order-2 lg:overflow-x-auto lg:overflow-y-hidden" aria-label="日期欄">
            <div className="flex flex-col gap-3 lg:h-full lg:w-max lg:flex-row">
              {data.days.map(day => (
                <DayColumn
                  key={day.date}
                  day={day}
                  today={data.today}
                  dragRule={activeDrag?.rule ?? null}
                  editable={editable}
                  canDrag={canDrag}
                  hideCompleted={hideDone}
                  handlersFor={handlersFor}
                  onOpenOrder={setOrderSo}
                  onEditCapacity={(d: BoardDay) => setDialog({ t: 'capacity-day', date: d.date })}
                  changpingSyncLabel={cpSyncLabel}
                />
              ))}
              <div className="flex w-full shrink-0 flex-col gap-2 rounded-xl border border-dashed border-slate-800 p-3 text-xs text-slate-400 lg:w-[200px]">
                {data.later.count > 0 ? (
                  <p>
                    之後還有 <b className="text-slate-200">{data.later.count}</b> 張
                    （{hours(data.later.minutes)} 小時{data.later.firstDate ? `，最早 ${md(data.later.firstDate)}` : ''}）
                  </p>
                ) : <p>視窗之後沒有已排的卡</p>}
                {board.workdays < BOARD_MAX_WORKDAYS && (
                  <button type="button" onClick={board.loadMore} disabled={board.loading}
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200 hover:bg-slate-800 disabled:opacity-50">
                    再載入 10 個工作日
                  </button>
                )}
                <p className="text-[10px] text-slate-500">顯示 {data.window.workdays} 個工作日（{md(data.window.from)}～{md(data.window.to)}）；週六只在開加班時出現</p>
              </div>
            </div>
          </section>
        </main>

        <DragOverlay dropAnimation={null}>
          {activeDrag?.kind === 'pool' ? (
            <div className="w-[264px] rotate-1 rounded-lg shadow-2xl ring-2 ring-sky-400">
              <PackagingCard card={activeDrag.card} today={data.today} onOpenOrder={() => {}} />
            </div>
          ) : activeDrag?.kind === 'placement' ? (
            <CardFrame bc={activeDrag.bc} today={data.today} editable={false} onOpenOrder={() => {}} isOverlay />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* ─── 對話框 ─── */}
      {dialog?.t === 'split' && (
        <SplitDialog
          bc={dialog.bc}
          days={data.days}
          onClose={() => setDialog(null)}
          onSubmit={(keepQty, parts) => {
            const bc = dialog.bc
            const withIds = parts.map(p => ({ id: newId(), qty: p.qty, toDate: p.toDate }))
            setDialog(null)
            submit(
              [{ op: 'split', id: bc.placementId, version: bc.version, keepQty, parts: withIds }],
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
          days={data.days}
          today={data.today}
          minDate={ruleForBoardCard(dialog.bc).minDate}
          onClose={() => setDialog(null)}
          onSubmit={(_q, toDate) => { const bc = dialog.bc; setDialog(null); moveCard(bc, toDate) }}
        />
      )}
      {dialog?.t === 'partial' && (() => {
        const card = dialog.card
        const remaining = data.pool.cardMeta[card.cardId]?.remainingQty ?? card.qtyCard
        return (
          <QtyDateDialog
            mode="place"
            title={`排部分數量：${lineLabel(card)}`}
            days={data.days}
            today={data.today}
            maxQty={remaining}
            defaultQty={remaining}
            readyQty={card.qtyReady}
            minDate={ruleForPoolCard(card).minDate}
            onClose={() => setDialog(null)}
            onSubmit={(qty, toDate) => { setDialog(null); if (qty && qty > 0) placePool(card, qty, toDate) }}
          />
        )
      })()}
      {(dialog?.t === 'capacity-day' || dialog?.t === 'capacity-table') && (
        <CapacityEditor
          mode={dialog.t === 'capacity-day' ? { kind: 'day', date: dialog.date } : { kind: 'table' }}
          today={data.today}
          editable={editable}
          getLockToken={lk.getToken}
          onClose={() => setDialog(null)}
          onSaved={() => { void board.reload() }}
        />
      )}
      {dialog?.t === 'versions' && (
        <VersionsPanel
          editable={editable}
          getLockToken={lk.getToken}
          nowMs={nowMs}
          onClose={() => setDialog(null)}
          onRestored={msg => {
            undo.clear()
            board.showToast('info', msg)
            void board.reload()
          }}
        />
      )}

      {orderSo && <PackagingOrderModal so={orderSo} open onClose={() => setOrderSo(null)} />}

      {/* ─── 提示 ─── */}
      {toast && (
        <div role="alert" className={`fixed bottom-4 left-1/2 z-[70] flex max-w-[92vw] -translate-x-1/2 items-start gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-2xl ${
          toast.kind === 'error' ? 'border-red-600 bg-red-950 text-red-100'
            : toast.kind === 'warn' ? 'border-orange-600 bg-orange-950 text-orange-100'
              : 'border-sky-600 bg-slate-900 text-sky-100'
        }`}>
          <span className="min-w-0 break-words">{toast.text}</span>
          <button type="button" onClick={dismissToast} aria-label="關閉提示" className="shrink-0 text-lg leading-none opacity-70 hover:opacity-100">×</button>
        </div>
      )}
    </div>
  )
}

/** 左欄底部：略過的卡、異常清單筆數、規則說明 */
function BoardFooter({ data }: { data: NonNullable<ReturnType<typeof useBoard>['data']> }) {
  const s = data.skipped
  const hidden = s.lineGoneOpen + s.lineGoneCompleted
  return (
    <details className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-400">
      <summary className="cursor-pointer text-slate-300">
        說明與隱藏的卡
        {hidden + s.consumedPast > 0 && <span className="ml-1 text-slate-500">（隱藏 {hidden + s.consumedPast} 張）</span>}
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        {hidden > 0 && <li>{hidden} 張已排的卡因訂單已完成或結案（塔台結案、包裝報完工、SO 結案）而隱藏（資料保留）。</li>}
        {s.consumedPast > 0 && <li>{s.consumedPast} 張過去日期的卡已由待排池扣完（多半是塔台已報包裝完工），不顯示。</li>}
        {data.staleUnsyncedCount > 0 && (
          <li>另有 {data.staleUnsyncedCount} 行「發單超過 30 天仍未上塔台」不列入，清單見 <Link href="/packaging/pool" className="text-sky-300 underline">待排池</Link>。</li>
        )}
        <li>預排卡（虛線）＝尚未入庫／前站未完工的量；不能排在預估可包日之前（D22）。</li>
        <li>排定日已過仍未完成的卡會自動順延到今天並標「延誤 N 天」（D50）；拖到任何一天即解除。</li>
        <li>勾「完成」只記在包裝專區，不回寫塔台（D24）。</li>
        {data.notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </details>
  )
}
