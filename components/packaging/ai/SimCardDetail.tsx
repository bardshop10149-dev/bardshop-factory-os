'use client'

// 模擬區的卡片詳情（規格 §八：每張 AI 卡點開詳情可看 aiReason；卡片詳情「鎖整張訂單」）。
//
// 為什麼不直接用正式工作台的 CardDetailDialog：它沒有「AI 理由」「鎖定」兩段，而且它的「修改歷程」會用擺放 id 查
// 工時學習紀錄（模擬列的 id 不在正式表，查了也是空的、還會誤導）。這裡重用它匯出的 CardInfo（卡片本身的資訊）
// 與 MinutesEditor（改工時＝模擬區 setMinutes 操作），模擬區專屬的部分自己畫。
// 顯示一律用「未加工」的原始卡（品名不含 🔒／〔AI〕標記）。

import type { BoardCard, PackagingLine } from '@/lib/packaging/scheduleTypes'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import { hoursText, placementState } from '@/lib/packaging/boardView'
import { fmtQty } from '@/components/packaging/poolStyles'
import Modal, { Btn } from '@/components/packaging/board/Modal'
import { CardInfo } from '@/components/packaging/board/CardDetailDialog'
import MinutesEditor from '@/components/packaging/board/MinutesEditor'
import { lineLabel } from '@/components/packaging/board/CardFace'
import { md, mdw } from '@/components/packaging/board/boardFormat'
import { soNumberOfKey, type SimCardState } from './simBoard'
import { LOCK_REASON_LABEL, SIM_SOURCE_LABEL } from './simText'

export default function SimCardDetail({
  bc, state, today, lines, editable, busy, onClose, onOpenOrder, onToggleCardLock, onToggleOrderLock, onSubmitMinutes,
}: {
  /** 未加工的原始卡 */
  bc: BoardCard
  state: SimCardState
  today: string
  lines: PackagingLine[]
  /** 本人的模擬區、可寫入 */
  editable: boolean
  busy: boolean
  onClose: () => void
  onOpenOrder: (so: string) => void
  onToggleCardLock: () => void
  onToggleOrderLock: () => void
  /** 模擬區 setMinutes（minutes＝以本列 qty 為準；null＝回到標準值） */
  onSubmitMinutes: (minutes: number | null, reason: string | null) => void
}) {
  const card = bc.card
  const overdue = card.dueDate != null && card.dueDate < today
  const s = placementState(bc)
  const sim = state.sim
  const lockedCard = state.lockedBy.includes('card')
  const lockedOrder = state.lockedBy.includes('order')
  const lockedLine = state.lockedBy.includes('line')
  const locked = state.lockedBy.length > 0
  const so = soNumberOfKey(bc.soLineKey)
  const row = (k: string, v: React.ReactNode) => (
    <div><span className="text-slate-400">{k}</span>{v}</div>
  )

  return (
    <Modal
      title={<span className="font-mono">{sim ? '模擬卡詳情' : '正式排程的卡（唯讀）'}　{lineLabel(card)}</span>}
      onClose={onClose}
      footer={<>
        <Btn onClick={() => { onClose(); onOpenOrder(card.so) }}>訂單詳情（全部品項＋示意圖）</Btn>
        <Btn tone="primary" onClick={onClose}>關閉</Btn>
      </>}
    >
      <div className="space-y-1 text-xs leading-relaxed">
        <div className="text-slate-300">{card.customer ?? '（無客戶名稱）'}</div>
        <div className="break-words text-sm font-semibold text-slate-100">{card.itemName ?? '（無品名）'}</div>
        <div className="flex flex-wrap gap-x-4">
          <span><span className="text-slate-400">交期　</span><span className={overdue ? 'font-bold text-red-300' : ''}>{md(card.dueDate)}</span></span>
          <span><span className="text-slate-400">數量　</span>{fmtQty(bc.effectiveQty)}{card.unit ? ` ${card.unit}` : ''}</span>
        </div>

        <div className="my-1 border-t border-slate-800" />
        <div className="text-[11px] font-semibold text-slate-400">模擬區</div>
        {sim ? (
          <>
            {row('來源　　　', <span className={sim.simSource === 'ai' ? 'font-semibold text-violet-200' : ''}>{SIM_SOURCE_LABEL[sim.simSource]}</span>)}
            {sim.simSource === 'ai' && row('AI 理由　　', sim.aiReason
              ? <span className="text-violet-100">{sim.aiReason}</span>
              : <span className="text-slate-500">（AI 認為理所當然，沒有另外寫理由）</span>)}
            {sim.livePlacementId && sim.simSource === 'copy' && row('對應正式卡　', <span className="text-slate-400">採用時會移動這張正式卡（保留原卡與工時紀錄）</span>)}
          </>
        ) : (
          <div className="rounded border border-slate-700 bg-slate-950/50 px-2 py-1.5 text-slate-300">
            {state.readonlyReason}：模擬區與 AI 都不會動它，採用時也不受影響。它照樣佔當天的產能。
          </div>
        )}
        {row('排定日　　', bc.planDate ? mdw(bc.planDate) : '待排區')}
        {bc.planDate && row('線　　　　', <span className="font-semibold">{lineNameOf(lines, bc.laneId ?? bc.lineId ?? null)}</span>)}
        {row('工時　　　', bc.minutes != null ? <span className="tabular-nums">{hoursText(bc.minutes)} h</span> : <span className="text-orange-300">未知（未計入負荷）</span>)}
        {s.pre && !s.done && row('預排　　　', <span className="text-sky-200">
          {bc.readiness === 'pre' && bc.preReadyDate ? `預估 ${md(bc.preReadyDate)} 可包` : '可包日未知'}
          <span className="text-slate-400">（可包 {fmtQty(bc.readyQty)}／{fmtQty(bc.effectiveQty)}，D22）</span>
        </span>)}
        {bc.completed && row('完成　　　', <span className="text-emerald-300">✓ {bc.completed.byName ?? bc.completed.by}</span>)}

        {sim && (
          <>
            <div className="my-1 border-t border-slate-800" />
            <div className="text-[11px] font-semibold text-slate-400">鎖定（D88：鎖定的卡原位不動、照樣佔產能，AI 看得到但不能改）</div>
            {locked ? (
              <div className="font-semibold text-amber-200">🔒 {state.lockedBy.map(r => LOCK_REASON_LABEL[r]).join('、')}</div>
            ) : (
              <div className="text-slate-400">未鎖定：AI 排程時可以移動、減量或移回待排池</div>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Btn onClick={onToggleCardLock} disabled={!editable || busy}>{lockedCard ? '解除這張卡的鎖定' : '🔒 鎖定這張卡'}</Btn>
              <Btn onClick={onToggleOrderLock} disabled={!editable || busy}>{lockedOrder ? `解除訂單 ${so} 的鎖定` : `🔒 鎖定整張訂單 ${so}`}</Btn>
            </div>
            {lockedLine && <div className="text-[11px] text-slate-500">這條線整條被鎖：到工具列的「鎖定」清單解除。</div>}
            {!editable && <div className="text-[11px] text-slate-500">唯讀檢視：只有模擬區的主人可以改鎖定。</div>}
          </>
        )}

        {sim && !bc.completed && (
          <>
            <div className="my-1 border-t border-slate-800" />
            <div className="text-[11px] font-semibold text-slate-400">工時（D69，只改模擬區；採用時才會寫進正式排程）</div>
            <MinutesEditor
              key={`${bc.placementId}:${bc.minutes ?? 'x'}`}
              bc={bc}
              editable={editable && !locked}
              busy={busy}
              onSubmit={(m, reason) => { onSubmitMinutes(m, reason); onClose() }}
            />
            {locked && editable && <div className="text-[11px] text-slate-500">鎖定的卡不能改工時，先解除鎖定。</div>}
          </>
        )}

        <div className="my-1 border-t border-slate-800" />
        <CardInfo card={card} meta={undefined} placed />
      </div>
    </Modal>
  )
}
