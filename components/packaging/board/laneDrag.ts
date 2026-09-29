// D100 線內拖曳插隊的 DOM 小工具（正式工作台 BoardLayout、AI 模擬區 SimLayout 共用；只在瀏覽器端呼叫）。
//
// 為什麼量 DOM，而不是每張卡各做一個 droppable（或改用 @dnd-kit/sortable）：
//   - 巢狀 droppable 在 pointerWithin 下會同時命中「線」與「卡」，目標不確定（MultiDayView 檔頭已註明兩種 droppable 刻意不巢狀）
//   - sortable 要改共用的 PlacementCard／useCardDrag（id pl:），會帶位移動畫，還會和跨欄拖曳、DragOverlay 互相干擾
//   - 日檢視 D74 本來就是「量線本體的位置 → 換算游標 y」，多日檢視同一思路：量每張卡的 getBoundingClientRect，
//     交給同一個 insertIndexAt（boardLocal.planLaneDrop），插入點規則（夾延誤卡、排除自己）完全共用
// scope：限定在哪個容器底下找（模擬區傳 '.sim-board'；正式區不傳）。兩個頁面不會同時存在，限定只是保險。
// 只讀不寫：每次 pointermove 最多觸發一次版面計算，一條線不到幾十張卡，成本很低。

import type { BoardDay } from '@/lib/packaging/scheduleTypes'
import { laneDropPlan, multiDayDropPlan, type LaneDropPlan, type LaneRect } from './boardLocal'

/**
 * 拖曳中的插入線（兩個工作台 → DayLanesView／MultiDayView）：laneKey＝`${date}:${lineId}`。
 * topPx：日檢視時間軸本體內的位置（多日檢視不用，固定 0，避免捲動時每一格都重畫）。
 * beforeId：多日檢視畫在哪張卡上方（null＝最後一張下方）。mode：insert＝同線重排、append＝從別處放進來（放在最後）。
 */
export interface LaneReorderHint {
  laneKey: string
  topPx: number
  mode: 'insert' | 'append'
  beforeId?: string | null
}

export function sameHint(a: LaneReorderHint | null, b: LaneReorderHint): boolean {
  return !!a && a.laneKey === b.laneKey && a.topPx === b.topPx && a.mode === b.mode && (a.beforeId ?? null) === (b.beforeId ?? null)
}

export function dropLineLabel(mode: LaneReorderHint['mode']): string {
  return mode === 'insert' ? '放在這裡' : '放到最後'
}

/** 游標的 client y：優先用視窗 pointermove 追到的最新值；沒有時退回 dnd-kit 的起點＋位移（容器捲動過會有誤差） */
export function pointerClientY(tracked: { y: number } | null, e: { activatorEvent: Event | null; delta: { y: number } }): number | null {
  if (tracked) return tracked.y
  const a = e.activatorEvent as (Event & { clientY?: number; touches?: TouchList }) | null
  const y0 = typeof a?.clientY === 'number' ? a.clientY : a?.touches?.[0]?.clientY
  return typeof y0 === 'number' ? y0 + e.delta.y : null
}

function query(scope: string, sel: string): Element | null {
  if (typeof document === 'undefined') return null
  return document.querySelector(scope ? `${scope} ${sel}` : sel)
}

/** 游標在日檢視某條線時間軸本體內的 y（本體＝LaneColumn 的 data-lane-body；量不到回 null＝放最後） */
export function laneBodyY(laneKey: string, clientY: number | null, scope = ''): number | null {
  if (clientY == null) return null
  const el = query(scope, `[data-lane-body="${laneKey}"]`)
  return el ? clientY - el.getBoundingClientRect().top : null
}

/** 週／兩週檢視某條線（MultiDayView 的 data-lane-list）每張卡目前的位置（client 座標，已含捲動） */
export function measureLaneItems(laneKey: string, scope = ''): Map<string, LaneRect> {
  const out = new Map<string, LaneRect>()
  const list = query(scope, `[data-lane-list="${laneKey}"]`)
  if (!list) return out
  list.querySelectorAll<HTMLElement>('[data-lane-item]').forEach(el => {
    const id = el.dataset.laneItem
    if (!id) return
    const r = el.getBoundingClientRect()
    out.set(id, { topPx: r.top, heightPx: r.height })
  })
  return out
}

/**
 * 拖回自己那條線時的插入點：
 *   timeline（日檢視）＝時間尺版面 laneDropPlan＋游標在本體內的 y（D74 原本的做法，結果不變）
 *   list（週／兩週）＝DOM 量到的清單位置 multiDayDropPlan＋游標 clientY
 */
export function ownLanePlan(p: {
  mode: 'timeline' | 'list'
  day: Pick<BoardDay, 'cards' | 'lanes' | 'date'>
  lineId: number
  movingId: string
  clientY: number | null
  hideCompleted: boolean
  scope?: string
}): LaneDropPlan {
  const laneKey = `${p.day.date}:${p.lineId}`
  if (p.mode === 'timeline') {
    return laneDropPlan(p.day, p.lineId, p.movingId, laneBodyY(laneKey, p.clientY, p.scope), p.hideCompleted)
  }
  return multiDayDropPlan(p.day, p.lineId, p.movingId, measureLaneItems(laneKey, p.scope), p.clientY, p.hideCompleted)
}
