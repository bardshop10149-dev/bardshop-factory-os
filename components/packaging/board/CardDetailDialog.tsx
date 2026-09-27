'use client'

// D61 卡片詳情（左右共用）：點卡片本身（或聚焦後按 Enter）開啟；卡片上沒放的資訊全在這。
//   - 待排池卡：狀態、工時與來源、品項編碼、備註、完整 PACKING、可包量／預估可包日、已排量、旗標
//   - 排定卡（待排區、日／週／兩週）：上面那些，再加「排程」一段——排定日、原排日、延誤天數、完成人與時間、拆卡序、預排資訊、提醒
// 點「訂單詳情」＝開 PackagingOrderModal（全部品項＋示意圖），和點卡片上的單號一樣。
// CardInfo 也給待排池的滑過提示（SimplePool 的 PoolHoverTip）用。
// 分線輪：
//   - 排定卡多「線」（D67／D72：所屬線；原線已停用時說明暫放在哪條線）
//   - D69 排定卡多「工時」段（MinutesEditor：標準估計、目前值、主管修改）與「修改歷程」（MinutesHistory）
//     ——只有 (a) 傳了 minutesEdit 才顯示；待排池卡不傳（工時覆寫的顆粒度是擺放列，不是待排池卡）
//   - D66 手動加入的卡（待排池 'mn' 區塊、或由它排出去的卡）顯示「手動加入：誰、何時、原因」

import type { ReactNode } from 'react'
import type { BoardCard, ManualInclusionMeta, PackagingLine, PlacementFlag, PoolCardMeta } from '@/lib/packaging/scheduleTypes'
import type { DangerFlag, PackagingCard } from '@/lib/packaging/types'
import { SOURCE_STYLES, fmtQty } from '@/components/packaging/poolStyles'
import { hoursText, noteText, placementState } from '@/lib/packaging/boardView'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import { clock, md, mdw } from './boardFormat'
import Modal, { Btn } from './Modal'
import { lineLabel } from './CardFace'
import MinutesEditor from './MinutesEditor'
import MinutesHistory from './MinutesHistory'

const FLAG_TONE: Record<DangerFlag['level'] | PlacementFlag['level'], string> = {
  danger: 'text-red-300',
  warn: 'text-orange-300',
  info: 'text-slate-400',
}

/** D66：手動加入的標記文字「手動・王主管・9/27 14:05」（SimplePoolCard 角標也用） */
export function manualTag(m: ManualInclusionMeta): string {
  return `手動・${m.addedByName ?? m.addedBy}・${clock(m.addedAt)}`
}

/** D66 手動加入的說明（詳情與滑過提示） */
function ManualInfo({ m }: { m: ManualInclusionMeta }) {
  return (
    <div className="break-words text-violet-200">
      <span className="text-slate-400">手動加入　</span>
      {m.addedByName ?? m.addedBy}（{clock(m.addedAt)}）・{fmtQty(m.qty)}・{m.routeType}
      {m.reason && <span className="text-slate-400">・原因：{m.reason}</span>}
    </div>
  )
}

/**
 * 卡片上沒放的資訊：狀態、工時與來源、品項編碼、備註、完整 PACKING、可包量、已排量、全部旗標（info 灰色）。
 * placed：排定卡——拆卡序與可包量交給「排程」一段（PlacementInfo 的「拆卡」「預排…（可包 x/y）」）顯示，這裡不重複列
 */
export function CardInfo({ card, meta, placed = false }: { card: PackagingCard; meta: PoolCardMeta | undefined; placed?: boolean }) {
  const note = noteText(card)
  const hrs = hoursText(card.work.minutes)
  const sources = card.sources.map(s => s.docNo).filter(Boolean)
  return (
    <>
      {meta?.manual && <ManualInfo m={meta.manual} />}
      <div>
        <span className="text-slate-400">狀態　　</span>{card.statusLabel}
        {card.sample.isSample && <span className="ml-1 font-bold text-fuchsia-300">打樣</span>}
        {card.split && !placed && <span className="ml-1 text-slate-400">拆 {card.split.index}/{card.split.total}</span>}
      </div>
      <div>
        <span className="text-slate-400">工時　　</span>
        {hrs != null ? <span className="tabular-nums">{hrs} h</span> : <span className="text-orange-300">未知</span>}
        {card.work.explain ? <span className="text-slate-400">（{card.work.explain}）</span> : null}
      </div>
      <div className="break-words">
        <span className="text-slate-400">來源　　</span>{SOURCE_STYLES[card.sourceKind].label}
        {sources.length > 0 && <span className="ml-1 font-mono text-slate-300">{sources.join('、')}</span>}
      </div>
      <div><span className="text-slate-400">品項編碼　</span><span className="font-mono">{card.itemCode ?? '—'}</span></div>
      <div className="break-words"><span className="text-slate-400">備註　　</span>{note ?? '—'}</div>
      <div className="whitespace-pre-line break-words"><span className="text-slate-400">PACKING　</span>{card.packing?.trim() || '—'}</div>
      {!placed && card.qtyReady < card.qtyCard && (
        <div className="text-emerald-300">
          可包 {fmtQty(card.qtyReady)}／{fmtQty(card.qtyCard)}
          {card.estReadyDate ? `・預估 ${md(card.estReadyDate)} 可包` : '・預估可包日未知'}
          <span className="text-slate-400">（其餘排出去會是預排，D22）</span>
        </div>
      )}
      {meta && meta.placedQty > 0 && (
        <div className="text-slate-400">已排 {fmtQty(meta.placedQty)}／原 {fmtQty(meta.originalQty)}，剩 {fmtQty(meta.remainingQty)}</div>
      )}
      {card.flags.map(f => (
        <div key={f.code} className={FLAG_TONE[f.level]}>・{f.label}</div>
      ))}
    </>
  )
}

/** 排定卡才有的「排程」資訊 */
function PlacementInfo({ bc, lines }: { bc: BoardCard; lines?: PackagingLine[] }) {
  const s = placementState(bc)
  // 待排池卡本身的旗標（CardInfo 會列）和擺放的旗標可能是同一件事（例：預估可包日已過），同字的只列一次
  const cardFlagLabels = new Set(bc.card.flags.map(f => f.label))
  const row = (k: string, v: ReactNode) => (
    <div><span className="text-slate-400">{k}</span>{v}</div>
  )
  return (
    <>
      {row('排定日　　', bc.planDate
        ? <>{mdw(bc.planDate)}{bc.displayDate && bc.displayDate !== bc.planDate ? <span className="text-slate-400">（目前顯示在 {mdw(bc.displayDate)}）</span> : null}</>
        : <span className="text-slate-300">待排區（擱置、未排日期）</span>)}
      {bc.planDate && lines && lines.length > 0 && row('線　　　　', <LineText bc={bc} lines={lines} />)}
      {bc.originalDate && bc.originalDate !== bc.planDate && row('原排日　　', mdw(bc.originalDate))}
      {s.delayed && bc.delayWorkdays > 0 && row('延誤　　　', <span className="font-bold text-orange-300">{bc.delayWorkdays} 個工作日（D50：已自動順延到今天）</span>)}
      {row('數量　　　', <>
        <span className="tabular-nums">{fmtQty(bc.effectiveQty)}</span>
        {bc.effectiveQty !== bc.qty && <span className="text-slate-400">（排定時 {fmtQty(bc.qty)}，待排池數量減少後自動扣減）</span>}
      </>)}
      {row('工時　　　', bc.minutes != null ? <span className="tabular-nums">{hoursText(bc.minutes)} h</span> : <span className="text-orange-300">未知（未計入負荷）</span>)}
      {bc.split && row('拆卡　　　', `第 ${bc.split.index} 張／共 ${bc.split.total} 張（同一訂單行）`)}
      {s.pre && !s.done && row('預排　　　', <span className={s.warnFrame ? 'text-orange-300' : 'text-sky-200'}>
        {bc.readiness === 'pre' && bc.preReadyDate ? `預估 ${md(bc.preReadyDate)} 可包` : '可包日未知'}
        <span className="text-slate-400">（可包 {fmtQty(bc.readyQty)}／{fmtQty(bc.effectiveQty)}，D22）</span>
      </span>)}
      {row('完成　　　', bc.completed
        ? <span className="text-emerald-300">✓ {bc.completed.byName ?? bc.completed.by}（{clock(bc.completed.at)}）</span>
        : <span className="text-slate-300">未完成</span>)}
      {bc.source === 'ai' && row('來源　　　', <span className="text-violet-200">AI 排入</span>)}
      {bc.manual && <ManualInfo m={bc.manual} />}
      {bc.flags.filter(f => f.code !== 'delayed' && !cardFlagLabels.has(f.label)).map(f => (
        <div key={f.code} className={FLAG_TONE[f.level]}>・{f.label}</div>
      ))}
    </>
  )
}

/** 所屬線（D72）：laneId＝實際顯示的線；原線已停用／不存在時說明 */
function LineText({ bc, lines }: { bc: BoardCard; lines: PackagingLine[] }) {
  const lane = bc.laneId ?? bc.lineId ?? null
  const fallback = bc.lineId != null && lane != null && bc.lineId !== lane
  if (lane == null) return <span className="text-slate-400">—</span>
  return (
    <>
      <span className="font-semibold">{lineNameOf(lines, lane)}</span>
      {fallback && (
        <span className="text-orange-300">（原屬 {lineNameOf(lines, bc.lineId)}，該線已停用或不存在，暫時顯示在這裡，請改排到其他線）</span>
      )}
    </>
  )
}

export default function CardDetailDialog({ card, meta, placement, today, onClose, onOpenOrder, lines, minutesEdit }: {
  /** 待排池卡；排定卡傳 placement.card */
  card: PackagingCard
  meta?: PoolCardMeta
  /** 排定卡：多顯示「排程」一段 */
  placement?: BoardCard | null
  today: string
  onClose: () => void
  onOpenOrder: (so: string) => void
  /** 分線：顯示「所屬線」用（BoardOk.lines） */
  lines?: PackagingLine[]
  /**
   * D69：排定卡的工時編輯（(a) 在 BoardLayout 傳入；待排池卡不傳）。
   * editable＝持有編輯鎖；onSubmit 的 minutes＝「以本列 qty 為準」的覆寫值（已用 overrideFromEffective 換算），null＝回到標準值。
   * (a) 收到後送 setMinutes（via 'dialog'）；對話框送出後自行關閉。
   */
  minutesEdit?: {
    editable: boolean
    busy?: boolean
    onSubmit: (minutes: number | null, reason: string | null) => void
  } | null
}) {
  const overdue = card.dueDate != null && card.dueDate < today
  // 標準每件分鐘（修改歷程沒有紀錄可參考時用）：標準工時 ÷ 有效數量（有最少 10 分的下限，只當參考）
  const stdPerUnit = placement && placement.minutesStd != null && placement.effectiveQty > 0 ? placement.minutesStd / placement.effectiveQty : null
  return (
    <Modal
      title={<span className="font-mono">{placement ? '排定卡詳情' : '卡片詳情'}　{lineLabel(card)}</span>}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={() => { onClose(); onOpenOrder(card.so) }}>訂單詳情（全部品項＋示意圖）</Btn>
          <Btn tone="primary" onClick={onClose}>關閉</Btn>
        </>
      }
    >
      <div className="space-y-1 text-xs leading-relaxed">
        <div className="text-slate-300">{card.customer ?? '（無客戶名稱）'}</div>
        <div className="break-words text-sm font-semibold text-slate-100">{card.itemName ?? '（無品名）'}</div>
        <div className="flex flex-wrap gap-x-4">
          <span><span className="text-slate-400">交期　</span><span className={overdue ? 'font-bold text-red-300' : ''}>{md(card.dueDate)}</span></span>
          <span><span className="text-slate-400">數量　</span>{fmtQty(card.qtyCard)}{card.unit ? ` ${card.unit}` : ''}</span>
        </div>
        {placement && (
          <>
            <div className="my-1 border-t border-slate-800" />
            <div className="text-[11px] font-semibold text-slate-400">排程</div>
            <PlacementInfo bc={placement} lines={lines} />
          </>
        )}
        {placement && minutesEdit && (
          <>
            <div className="my-1 border-t border-slate-800" />
            <div className="text-[11px] font-semibold text-slate-400">工時（D69）</div>
            <MinutesEditor
              key={`${placement.placementId}:${placement.version}`}
              bc={placement}
              editable={minutesEdit.editable}
              busy={minutesEdit.busy}
              onSubmit={(m, reason) => { minutesEdit.onSubmit(m, reason); onClose() }}
            />
            <div className="mt-1 text-[11px] font-semibold text-slate-400">修改歷程</div>
            <MinutesHistory placementId={placement.placementId} itemCode={card.itemCode} stdPerUnit={stdPerUnit} lines={lines} />
          </>
        )}
        <div className="my-1 border-t border-slate-800" />
        <CardInfo card={card} meta={meta} placed={!!placement} />
      </div>
    </Modal>
  )
}
