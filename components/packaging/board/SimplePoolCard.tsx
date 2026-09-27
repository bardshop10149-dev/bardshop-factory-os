'use client'

// D58 待排池簡化卡片：卡片上只放 7 項——單號、製令、交期、客戶名稱、品項名稱、數量、PACKING。
// 其他資訊（工時與來源、品項編碼、備註、狀態、預估可包日、旗標）收進滑鼠停留／聚焦提示（SimplePool 的 PoolHoverTip）
// 與點卡片本身開的卡片詳情（D61）；點單號開訂單詳情（全部品項＋示意圖）。
// 點擊與拖曳的區分：PointerSensor distance 5（移動 5px 才算拖曳）；拖曳啟動後 dnd-kit 會攔掉隨後的 click，不會誤開詳情。
//
// 拆成兩層：
//   SimplePoolCardFace：純外觀＝CardFace（與右側排定卡共用，D60；拖曳中的 DragOverlay 也用它，飛出去的樣子＝原卡）
//   SimplePoolCard：外面包 useDraggable（id `pool:卡片id`、data { kind: 'pool', card }，BoardLayout 的 onDragStart 照舊認得）
// 右鍵選單由 PoolSidebar 處理：卡片根元素帶 data-pool-card-id，PoolSidebar 依它找回卡片。
// 可及性：不展開 useDraggable 的 attributes（role=button＋「按空白鍵拿起」說明）——工作台沒有 KeyboardSensor，
// 那段說明是做不到的操作，而且 role=button 裡再包單號 <button> 是巢狀互動元素。
// 改成自己給 tabIndex＋role=group：聚焦顯示提示、Enter 開卡片詳情、Shift+F10 開右鍵選單（鍵盤的替代操作）。
// D66：手動加入的卡在 CardFace 上方多一條「手動・王主管・9/27 14:05」標記（CardFace 左右共用、不改，所以加在外框）。

import { memo } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { ManualInclusionMeta } from '@/lib/packaging/scheduleTypes'
import type { PackagingCard } from '@/lib/packaging/types'
import { isCardDanger } from '@/lib/packaging/boardView'
import { isPlaceableBlock } from './boardLocal'
import CardFace from './CardFace'
import { manualTag } from './CardDetailDialog'

/** 危險＝已逾期或帶紅色旗標（左側細色條變紅） */
export function isPoolDanger(c: PackagingCard, today: string): boolean {
  return isCardDanger(c, today)
}

/** 待排池卡的外觀（CardFace md，左右共用同一份；拖曳中的 DragOverlay 也用它） */
export function SimplePoolCardFace({ card, today, onOpenOrder, overlay = false }: {
  card: PackagingCard
  today: string
  onOpenOrder?: (so: string) => void
  /** 拖曳中的浮動卡：不放可點的單號按鈕 */
  overlay?: boolean
}) {
  return (
    <CardFace
      card={card}
      today={today}
      bar={isPoolDanger(card, today) ? 'danger' : 'normal'}
      onOpenOrder={overlay ? undefined : onOpenOrder}
    />
  )
}

/** 包 memo：BoardLayout 每 5 秒更新時鐘會整頁重畫，待排池可能上百張（onHover／onOpenDetail 在 SimplePool 用 useCallback 固定） */
const SimplePoolCard = memo(function SimplePoolCard({ card, manual = null, today, canDrag, descId, onOpenOrder, onOpenDetail, onHover }: {
  card: PackagingCard
  /** D66 手動加入的紀錄（'mn' 卡）：卡片上方顯示「手動・誰・何時」 */
  manual?: ManualInclusionMeta | null
  today: string
  canDrag: boolean
  /** 鍵盤操作說明（SimplePool 放一份隱藏文字，所有卡共用） */
  descId: string
  onOpenOrder: (so: string) => void
  onOpenDetail: (card: PackagingCard) => void
  onHover: (card: PackagingCard | null, el: HTMLElement | null) => void
}) {
  const disabled = !canDrag || !isPlaceableBlock(card.block)
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `pool:${card.cardId}`,
    data: { kind: 'pool', card },
    disabled,
  })
  // 不套 transform：拖曳中顯示的是 DragOverlay，原位置只變淡
  return (
    <div
      ref={setNodeRef}
      data-pool-card-id={card.cardId}
      {...(disabled ? {} : listeners)}
      role="group"
      tabIndex={0}
      aria-roledescription="待排卡"
      aria-label={`${card.so}${card.soLine ? `-${card.soLine}` : ''} ${card.customer ?? ''} ${card.itemName ?? ''}`}
      aria-describedby={descId}
      onClick={() => onOpenDetail(card)}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail(card) }
      }}
      onMouseEnter={e => onHover(card, e.currentTarget)}
      onMouseLeave={() => onHover(null, null)}
      // 只有鍵盤聚焦（:focus-visible）才顯示提示；滑鼠按下也會聚焦，那時不要跳提示（右鍵選單、拖曳會跟它疊在一起）
      onFocus={e => { if (e.target === e.currentTarget && e.currentTarget.matches(':focus-visible')) onHover(card, e.currentTarget) }}
      onBlur={e => { if (e.target === e.currentTarget) onHover(null, null) }}
      className={`min-w-0 touch-manipulation rounded-md border border-slate-700 bg-slate-900 outline-none hover:border-slate-500 hover:bg-slate-800/80 focus-visible:ring-2 focus-visible:ring-sky-400 ${
        disabled ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
      } ${isDragging ? 'opacity-30' : ''}`}
    >
      {manual && (
        <div className="truncate border-b border-violet-900/60 bg-violet-950/40 px-2 py-0.5 text-[10px] text-violet-200"
          title={manual.reason ? `原因：${manual.reason}` : undefined}>
          {manualTag(manual)}{manual.reason ? `・${manual.reason}` : ''}
        </div>
      )}
      <SimplePoolCardFace card={card} today={today} onOpenOrder={onOpenOrder} />
    </div>
  )
})

export default SimplePoolCard
