'use client'

// 簡化卡片的外觀（D58 待排池、D60 排定卡共用）：卡片上只放 7 項——單號、製令、交期、客戶名稱、品項名稱、數量、PACKING。
// 左右兩邊用同一份外觀，看到的卡才會一模一樣；差別只在外面包的殼：
//   SimplePoolCard（待排池，可拖到日期）／PlacementCard（排定卡：拖曳、右鍵選單、完成勾選）。
// 其他資訊（工時與來源、品項編碼、備註、狀態、預估可包日、旗標）收進卡片詳情（CardDetailDialog，D61）。
//
// 兩種大小：
//   md：待排池、待排區、日檢視卡片牆（每張 ≥ 260px）——有「交期／製令／數量／PACKING」小標籤
//   sm：週檢視（欄寬約 168px，卡寬約 150px）——同樣 7 項，字小一級、拿掉小標籤（改放 title），長文字截斷
// 兩週檢視的迷你卡只有單號＋數量，不用這個元件（見 PlacementCard）。
//
// 排定卡的狀態標記（完成 ✓、已扣完、延誤 N 天、預排、拆卡 i/n）由呼叫端傳入 marks，放在「客戶名稱」那一行的右側：
// 不另佔一行（D60），客戶名稱被擠時先截斷客戶名稱（它是 7 項裡最不影響排程判斷的）。
// D100：選填的 tail 放在第 5 行（PACKING）右側——排定卡（PlacementCard）用來放「工時」小標與角標；
//   不傳（待排池 SimplePoolCard、拖曳中的浮動卡、日檢視 LaneCard）時外觀與原本完全相同，7 項的排版不動。

import type { ReactNode } from 'react'
import type { PackagingCard } from '@/lib/packaging/types'
import { fmtQty } from '@/components/packaging/poolStyles'
import { moText, packingMain, type CardMark } from '@/lib/packaging/boardView'
import { md } from './boardFormat'

export type BarTone = 'done' | 'danger' | 'normal'

/** 左側細色條：紅＝逾期／危險、灰＝已完成、其他中性（顏色本身不帶文字資訊） */
export const BAR_CLASS: Record<BarTone, string> = {
  danger: 'bg-red-500',
  done: 'bg-slate-500',
  normal: 'bg-slate-700',
}

const MARK_CLASS: Record<CardMark['kind'], string> = {
  done: 'font-bold text-emerald-400',
  consumed: 'rounded bg-slate-700 px-1 text-slate-300',
  delayed: 'rounded bg-orange-600 px-1 font-bold text-white',
  pre: 'rounded border border-dashed border-sky-400/80 px-0.5 text-sky-200',
  preWarn: 'rounded border border-dashed border-orange-400 px-0.5 text-orange-200',
  split: 'text-slate-400',
}

/** 排定卡的小標記（也給迷你卡用） */
export function CardMarks({ marks, small = false }: { marks: CardMark[]; small?: boolean }) {
  if (marks.length === 0) return null
  return (
    <>
      {marks.map(m => (
        <span
          key={m.kind}
          title={m.title}
          aria-label={m.title}
          className={`shrink-0 whitespace-nowrap ${small ? 'text-[9px] leading-3' : 'text-[10px] leading-4'} ${MARK_CLASS[m.kind]}`}
        >{m.text}</span>
      ))}
    </>
  )
}

export function lineLabel(c: { so: string; soLine: string | null }): string {
  return `${c.so}${c.soLine ? `-${c.soLine}` : ''}`
}

/** 單號：可點（開訂單詳情＋示意圖）；拖曳中的浮動卡或沒給 onOpenOrder 時只是文字 */
export function OrderNo({ card, onOpenOrder, className = '' }: {
  card: Pick<PackagingCard, 'so' | 'soLine'>
  onOpenOrder?: (so: string) => void
  className?: string
}) {
  const label = <>{card.so}{card.soLine ? <span className="text-slate-400">-{card.soLine}</span> : null}</>
  if (!onOpenOrder) return <span className={`min-w-0 truncate font-mono font-semibold text-sky-300 ${className}`}>{label}</span>
  return (
    <button
      type="button"
      // 不讓按住單號變成拖曳、點單號不冒泡成「點卡片」（兩個點擊目的不同，D61）
      onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onOpenOrder(card.so) }}
      onKeyDown={e => e.stopPropagation()}
      title="開啟訂單詳情（全部品項＋示意圖）"
      className={`min-w-0 truncate text-left font-mono font-semibold text-sky-300 hover:text-sky-200 hover:underline ${className}`}
    >{label}</button>
  )
}

export default function CardFace({ card, today, size = 'md', onOpenOrder, bar, marks, check, muted = false, tail }: {
  card: PackagingCard
  today: string
  size?: 'md' | 'sm'
  /** 沒給＝單號只是文字（拖曳中的浮動卡） */
  onOpenOrder?: (so: string) => void
  bar: BarTone
  /** 排定卡的狀態標記（客戶名稱那一行右側） */
  marks?: CardMark[]
  /** 排定卡的完成勾選（第 1 行最右側） */
  check?: ReactNode
  /** 已完成：內容變淡（勾選框不受影響） */
  muted?: boolean
  /** D100：第 5 行（PACKING）右側的附加內容（排定卡的工時小標、角標）；已完成時跟著變淡 */
  tail?: ReactNode
}) {
  const overdue = card.dueDate != null && card.dueDate < today && !muted
  const mo = moText(card)
  const packing = packingMain(card.packing)
  const sm = size === 'sm'
  const label = (t: string) => (sm ? null : <span className="shrink-0 text-[10px] text-slate-400">{t}</span>)
  const fade = muted ? 'opacity-55' : ''
  return (
    <div className={`flex min-w-0 ${sm ? 'text-[11px] leading-[15px]' : 'text-xs leading-[18px]'}`}>
      <span className={`w-1 shrink-0 rounded-l-md ${BAR_CLASS[bar]}`} aria-hidden />
      <div className={`min-w-0 flex-1 ${sm ? 'space-y-px px-1.5 py-1' : 'space-y-0.5 px-2 py-1.5'}`}>
        {/* 第 1 行：單號（可點）＋交期（＋完成勾選） */}
        <div className={`flex items-center ${sm ? 'gap-1' : 'gap-2'}`}>
          <OrderNo card={card} onOpenOrder={onOpenOrder} className={`${fade} ${muted ? 'line-through decoration-slate-500' : ''}`} />
          <span className="flex-1" />
          <span className={`flex shrink-0 items-baseline gap-1 ${fade}`} title={sm ? '交期' : undefined}>
            {label('交期')}
            <span className={`tabular-nums ${overdue ? 'font-bold text-red-300' : 'text-slate-200'}`}>{md(card.dueDate)}</span>
          </span>
          {check}
        </div>
        {/* 第 2 行：製令＋數量 */}
        <div className={`flex items-baseline ${sm ? 'gap-1' : 'gap-2'} ${fade}`}>
          {label('製令')}
          <span
            className={`min-w-0 truncate font-mono ${sm ? 'text-[10px]' : 'text-xs'} ${mo?.isMo ? 'text-slate-200' : 'text-slate-500'}`}
            title={sm && mo ? `${mo.isMo ? '製令' : '來源單'} ${mo.text}` : undefined}
          >{mo?.text ?? ''}</span>
          <span className="flex-1" />
          {label('數量')}
          <span className="shrink-0 font-semibold tabular-nums text-slate-100" title={sm ? '數量' : undefined}>
            {fmtQty(card.qtyCard)}{card.unit && !sm ? <span className="ml-0.5 text-[10px] font-normal text-slate-500">{card.unit}</span> : null}
          </span>
        </div>
        {/* 第 3 行：客戶名稱（＋狀態標記；標記不跟著變淡，完成的 ✓ 要看得清楚） */}
        <div className="flex min-w-0 items-center gap-1">
          <span className={`min-w-0 flex-1 truncate text-slate-300 ${fade}`}>{card.customer ?? <span className="text-slate-500">（無客戶名稱）</span>}</span>
          {marks && marks.length > 0 && <span className="flex shrink-0 items-center gap-1"><CardMarks marks={marks} small={sm} /></span>}
        </div>
        {/* 第 4 行：品項名稱（最多 2 行） */}
        <div className={`line-clamp-2 break-words font-medium text-slate-100 ${fade}`}>{card.itemName ?? '（無品名）'}</div>
        {/* 第 5 行：PACKING（1 行）＋ tail（D100；沒有 tail 時與原本完全相同） */}
        <div className={`flex items-baseline gap-1.5 ${fade}`}>
          {label('PACKING')}
          <span className={`min-w-0 truncate text-amber-100/80 ${sm ? 'text-[10px]' : 'text-xs'}`} title={sm && packing ? `PACKING ${packing}` : undefined}>{packing ?? '—'}</span>
          {tail && <span className="ml-auto flex shrink-0 items-center gap-0.5 self-center">{tail}</span>}
        </div>
      </div>
    </div>
  )
}
