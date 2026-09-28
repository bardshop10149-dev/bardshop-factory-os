'use client'

// 模擬區的卡片詳情（規格 §八：每張 AI 卡點開詳情可看 aiReason；卡片詳情「鎖整張訂單」）。
//
// 為什麼不直接用正式工作台的 CardDetailDialog：它沒有「AI 理由」「鎖定」兩段，而且它的「修改歷程」會用擺放 id 查
// 工時學習紀錄（模擬列的 id 不在正式表，查了也是空的、還會誤導）。這裡重用它匯出的 CardInfo（卡片本身的資訊）
// 與 MinutesEditor（改工時＝模擬區 setMinutes 操作），模擬區專屬的部分自己畫。
// 顯示一律用「未加工」的原始卡（品名不含 🔒／〔AI〕標記）。
// D100（與正式區 CardDetailDialog 一致）：
//   - 工時段移到最上面、加外框「工時（可調整）」；MinutesEditor 用 variant='sim'（不收原因、說明「不留學習紀錄、用退回上一步」），
//     不能改時顯示具體原因（別人的模擬區／起始日已過／鎖定…）；focusMinutes＝直接聚焦輸入框。
//   - 「線」下面加「順序」列（LaneOrderRow 上移／下移），由 SimLayout 算好按鈕狀態傳進來。

import type { BoardCard, PackagingLine } from '@/lib/packaging/scheduleTypes'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import { hoursText, placementState } from '@/lib/packaging/boardView'
import { fmtQty } from '@/components/packaging/poolStyles'
import Modal, { Btn } from '@/components/packaging/board/Modal'
import { CardInfo } from '@/components/packaging/board/CardDetailDialog'
import MinutesEditor from '@/components/packaging/board/MinutesEditor'
import { lineLabel } from '@/components/packaging/board/CardFace'
import LaneOrderRow, { type LaneOrderProps } from '@/components/packaging/board/LaneOrderControls'
import { md, mdw } from '@/components/packaging/board/boardFormat'
import { soNumberOfKey, type SimCardState } from './simBoard'
import { LOCK_REASON_LABEL, SIM_SOURCE_LABEL } from './simText'

export default function SimCardDetail({
  bc, state, today, lines, editable, busy, onClose, onOpenOrder, onToggleCardLock, onToggleOrderLock, onSubmitMinutes,
  laneOrder, focusMinutes = false, minutesReadonlyHint, onCloseCase, closeCaseHint,
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
  /** D100：線內順序（上移／下移）；不傳＝不顯示 */
  laneOrder?: LaneOrderProps | null
  /** D100：打開時直接聚焦工時輸入框 */
  focusMinutes?: boolean
  /** D100：工時不能改的原因（null＝可以改）；省略時依 editable／鎖定推 */
  minutesReadonlyHint?: string | null
  /** D107：對這一行（SO-項次）結案（開確認對話框）；不傳＝不顯示 */
  onCloseCase?: () => void
  /** D107：不能結案的原因（null＝可以）；有 onCloseCase 時才看 */
  closeCaseHint?: string | null
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
  // 工時段：模擬列、未完成才能改（正式區唯讀的卡、已完成的卡只在「排程」列看工時）
  const showMinutes = !!sim && !bc.completed
  const minutesHint = minutesReadonlyHint !== undefined ? minutesReadonlyHint
    : !editable ? '唯讀檢視，不能改工時' : locked ? '鎖定的卡不能改工時，先解除鎖定' : null
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

        {showMinutes && (
          <section aria-label="工時（可調整）" className="mt-2 space-y-1 rounded-lg border border-amber-700/50 bg-amber-950/10 p-2">
            <div className="text-[11px] font-semibold text-amber-200">工時（可調整）<span className="ml-1 font-normal text-slate-400">只改模擬區；採用時才會寫進正式排程</span></div>
            <MinutesEditor
              key={`${bc.placementId}:${bc.minutes ?? 'x'}`}
              bc={bc}
              variant="sim"
              editable={minutesHint == null}
              readonlyHint={minutesHint}
              busy={busy}
              autoFocus={focusMinutes}
              onSubmit={(m, reason) => { onSubmitMinutes(m, reason); onClose() }}
            />
          </section>
        )}

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
        {bc.planDate && laneOrder && <LaneOrderRow {...laneOrder} />}
        {!showMinutes && row('工時　　　', bc.minutes != null ? <span className="tabular-nums">{hoursText(bc.minutes)} h</span> : <span className="text-orange-300">未知（未計入負荷）</span>)}
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

        {onCloseCase && !bc.completed && (
          // D107：結案是正式區的事實（這一行永久不再拉回待排池；正式區與所有模擬區的卡一起移除），不走模擬區 undo
          <>
            <div className="my-1 border-t border-slate-800" />
            <div className="text-[11px] font-semibold text-slate-400">結案（D104：已完工卻漏銷貨／沒改交期、永遠排不掉的卡）</div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Btn tone="danger" onClick={onCloseCase} disabled={busy || closeCaseHint != null} title={closeCaseHint ?? undefined}>結案（不再拉回待排池）…</Btn>
              <span className="text-[11px] text-slate-500">{closeCaseHint ?? '整行 SO-項次一起結案；「退回上一步」退不回，復原要到「已結案」清單'}</span>
            </div>
          </>
        )}

        <div className="my-1 border-t border-slate-800" />
        <CardInfo card={card} meta={undefined} placed />
      </div>
    </Modal>
  )
}
