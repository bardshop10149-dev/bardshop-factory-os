'use client'

// 排定卡（D60：右側日／週／兩週檢視與待排區的排定項目改成卡片，外觀與左側待排池的簡化卡片相同）。
//
// 大小（lib/packaging/boardView.ts cardSizeFor）：
//   md   ＝日檢視卡片牆、待排區：CardFace md（7 項＋小標籤）
//   sm   ＝週檢視（欄寬約 168px）：CardFace sm（同 7 項，字小、長文字截斷）
//   mini ＝兩週檢視（欄寬約 80px）：只剩單號＋數量＋1 個最重要的標記，左側同樣有細色條（D56「兩週看負荷」精神不變）
// 狀態：已完成＝灰＋勾（D24）、延誤 N 天＝橘標（D50）、預排＝虛線框（D22）、拆卡 i/n——都不另佔文字行。
// 分線輪：右下角小角標（手動加入 D66／調整過工時 D69／線已停用），見 cardParts PlacementBadges。
// D100：卡片上加「工時 X.Xh」（cardParts MinutesChip）——週／兩週原本完全看不到工時，改工時的入口只剩點不到的 ✎。
//   md／sm：放在第 5 行（PACKING）右側（CardFace tail），可點＝開卡片詳情並聚焦工時輸入；角標也移到這裡（原本絕對定位會蓋住 PACKING）。
//   mini：第 3 行純文字（迷你卡上的按鈕會吃掉拖曳與點擊；點整張卡本來就開詳情）。
// 日檢視改用時間尺上的 LaneCard（長度＝工時，D68）；本元件用在週／兩週的各線小欄與待排區。
//
// 操作（D61）：
//   點卡片本身／聚焦後 Enter → 卡片詳情（CardDetailDialog，與左側同一個）
//   點單號 → 訂單詳情＋示意圖（PackagingOrderModal）——md／sm 卡。
//     兩週迷你卡（約 70×30px）的單號只是文字、不是按鈕：按鈕會吃掉上半張卡的拖曳（stopPropagation）與點擊（開成訂單），
//     使用者很容易按到。迷你卡的訂單詳情從卡片詳情的「訂單詳情」鈕或右鍵選單進入。
//   拖曳 → 日與日之間、拖回待排區、拖回待排池（PointerSensor distance 5：移動 5px 才算拖曳；拖曳啟動後 dnd-kit 會攔掉隨後的 click，不會誤開詳情）
//   右鍵（鍵盤 Shift+F10）→ 選單：勾完成／取消、拆卡、移到日期、移到待排區、放回待排池、訂單詳情
//   勾選框（md／sm）→ 完成（D24）；迷你卡沒有勾選框，用右鍵

import { memo } from 'react'
import type { BoardCard } from '@/lib/packaging/scheduleTypes'
import { fmtQty } from '@/components/packaging/poolStyles'
import { cardBarTone, cardMarks, isCardDanger, placementFrame, placementState, type CardSize } from '@/lib/packaging/boardView'
import { md } from './boardFormat'
import CardFace, { BAR_CLASS, CardMarks, OrderNo, lineLabel } from './CardFace'
import type { CardMenuHandlers } from './cardMenu'
import { DoneCheck, MinutesChip, PlacementBadges, cardTitle, useCardDrag, useCardMenu } from './cardParts'

const FRAME_CLASS: Record<ReturnType<typeof placementFrame>, string> = {
  solid: 'border-slate-700 hover:border-slate-500',
  pre: 'border-dashed border-sky-400/80',
  preWarn: 'border-dashed border-orange-400',
}

/** 拖曳排定卡時跟著游標的樣子＝那張卡本身（md，寬度固定，不跟欄寬走） */
export function PlacementCardOverlay({ bc, today }: { bc: BoardCard; today: string }) {
  const s = placementState(bc)
  return (
    <div className={`w-[300px] rotate-1 rounded-md border bg-slate-900 shadow-2xl ring-2 ring-sky-400/40 ${
      placementFrame(s) === 'solid' ? 'border-sky-400' : FRAME_CLASS[placementFrame(s)]
    }`}>
      <CardFace
        card={bc.card}
        today={today}
        bar={cardBarTone(s, isCardDanger(bc.card, today, bc.flags))}
        marks={cardMarks(bc, 'md', md)}
      />
    </div>
  )
}

/** 包 memo：BoardLayout 每 5 秒更新時鐘會整頁重畫；handlers 由 useHandlerMap 依 placementId 快取才穩定 */
const PlacementCard = memo(function PlacementCard({ bc, today, size, editable, canDrag, handlers, onOpenOrder, onOpenDetail }: {
  bc: BoardCard
  today: string
  size: CardSize
  editable: boolean
  canDrag: boolean
  handlers: CardMenuHandlers
  onOpenOrder: (so: string) => void
  onOpenDetail: (bc: BoardCard) => void
}) {
  const s = placementState(bc)
  const { setNodeRef, isDragging, listeners, disabled } = useCardDrag(bc, canDrag)
  const menu = useCardMenu(bc, { editable, handlers, onOpenOrder, withComplete: true })
  const bar = cardBarTone(s, isCardDanger(bc.card, today, bc.flags))
  const marks = cardMarks(bc, size, md)
  const muted = s.done || s.consumed
  const mini = size === 'mini'

  const root = (
    <div
      ref={setNodeRef}
      {...listeners}
      role="group"
      tabIndex={0}
      aria-roledescription="排定卡"
      aria-label={`${lineLabel(bc.card)} ${bc.card.customer ?? ''} ${bc.card.itemName ?? ''}${s.done ? '（已完成）' : ''}`}
      aria-keyshortcuts="Enter Shift+F10"
      title={mini || size === 'sm' ? cardTitle(bc, mini) : '點卡片看詳情・點單號看訂單・右鍵：完成、拆卡、移動…'}
      onClick={() => onOpenDetail(bc)}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail(bc) }
      }}
      onContextMenu={menu.onContextMenu}
      className={`relative min-w-0 touch-manipulation rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
        FRAME_CLASS[placementFrame(s)]
      } ${muted ? 'bg-slate-800/50' : 'bg-slate-900 hover:bg-slate-800/80'} ${
        disabled ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
      } ${isDragging ? 'opacity-30' : ''} ${menu.open ? 'ring-2 ring-sky-500' : ''}`}
    >
      {mini ? (
        // 兩週迷你卡：單號＋數量（＋1 個標記）；其餘看滑過提示與卡片詳情
        <div className="flex min-w-0 text-[10px] leading-[13px]">
          <span className={`w-1 shrink-0 rounded-l-md ${BAR_CLASS[bar]}`} aria-hidden />
          <div className="min-w-0 flex-1 px-1 py-0.5">
            {/* 不傳 onOpenOrder＝純文字（整張迷你卡都是「卡片本身」：可拖、點了開卡片詳情；也不會有自己的 title 蓋掉卡片的滑過提示） */}
            <OrderNo card={bc.card} className={`block ${muted ? 'opacity-55 line-through decoration-slate-500' : ''}`} />
            <div className="flex items-center gap-0.5">
              <span className={`min-w-0 truncate font-semibold tabular-nums text-slate-100 ${muted ? 'opacity-55' : ''}`}>{fmtQty(bc.effectiveQty)}</span>
              <span className="flex-1" />
              <CardMarks marks={marks} small />
            </div>
            {/* D100 第 3 行：工時（純文字；兩週是「看負荷」的檢視，一眼看到每張卡幾小時） */}
            <div className={`flex min-w-0 ${muted ? 'opacity-55' : ''}`}><MinutesChip bc={bc} size="mini" /></div>
          </div>
        </div>
      ) : (
        <CardFace
          card={bc.card}
          today={today}
          size={size}
          onOpenOrder={onOpenOrder}
          bar={bar}
          marks={marks}
          muted={muted}
          check={<DoneCheck bc={bc} editable={editable} handlers={handlers} />}
          tail={<>
            <MinutesChip bc={bc} size={size} onEdit={handlers.onEditMinutes} />
            <PlacementBadges bc={bc} hideMinutes />
          </>}
        />
      )}
      {/* 迷你卡（約 64px 寬）放不下角標：手動／線停用寫在滑過提示（cardTitle）；工時在第 3 行 */}
    </div>
  )
  // 選單（portal）放在卡片元素外面：合成事件會沿元件樹冒泡，放裡面的話點選單會變成「點卡片」
  return <>{root}{menu.menu}</>
})

export default PlacementCard
