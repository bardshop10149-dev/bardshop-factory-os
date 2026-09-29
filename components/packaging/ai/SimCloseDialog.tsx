'use client'

// D104／D107 在模擬區對一張卡「結案」（已完工卻漏銷貨／沒改交期、永遠排不掉的卡）。
//
// 結案是「正式區」的事實（packaging_closures）：這一行（SO-項次）永久不再拉回待排池，
// 伺服器會一併把正式區與所有人模擬區裡這一行的卡移除。所以：
//   - 不走模擬區的 undo（結案不是模擬區的一步，「退回上一步」退不回；復原到工具列的「結案池」，D104／D110）；
//   - D110：這個對話框**不打 API、不等伺服器**——按「確定結案」就把備註交給 SimLayout（onConfirm）並關閉；
//     SimLayout 交給 useSim.submitClosure：該行的卡立刻從畫面消失、排進模擬區的操作佇列背景送出，失敗才放回原位並提示。
// 這裡只做確認（單號-項次、品名、數量）＋備註輸入。

import { useState } from 'react'
import type { BoardCard } from '@/lib/packaging/scheduleTypes'
import { fmtQty } from '@/components/packaging/poolStyles'
import Modal, { Btn } from '@/components/packaging/board/Modal'
import { lineLabel } from '@/components/packaging/board/CardFace'

/** 備註上限（同伺服器 CLOSURE_NOTE_MAX；超過時伺服器會拒絕，這裡先擋） */
export const CLOSURE_NOTE_MAX = 200

export default function SimCloseDialog({ bc, onClose, onConfirm }: {
  /** 未加工的原始卡 */
  bc: BoardCard
  onClose: () => void
  /** 主管按下「確定結案」（備註已去頭尾空白，空的＝null）；呼叫端負責關對話框、樂觀更新與送出 */
  onConfirm: (note: string | null) => void
}) {
  const [note, setNote] = useState('')
  const card = bc.card
  const tooLong = Array.from(note).length > CLOSURE_NOTE_MAX

  const submit = () => {
    if (tooLong) return
    onConfirm(note.trim() || null)
  }

  return (
    <Modal
      title={<span>結案（不再拉回待排池）　<span className="font-mono">{lineLabel(card)}</span></span>}
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>取消</Btn>
        <Btn tone="danger" disabled={tooLong} onClick={submit}>確定結案</Btn>
      </>}
    >
      <div className="space-y-2 text-xs leading-relaxed">
        <div className="rounded-lg border border-rose-800/70 bg-rose-950/30 px-3 py-2 text-rose-100">
          結案後這一行<b>永久不再拉回待排池</b>，正式排程與所有人模擬區裡這一行的卡都會被移除；
          「退回上一步」退不回，要復原請到工具列的「結案池」按復原。
        </div>
        <dl className="grid grid-cols-[6rem_1fr] gap-y-1 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
          <dt className="text-slate-400">單號-項次</dt><dd className="font-mono text-slate-100">{bc.soLineKey}</dd>
          <dt className="text-slate-400">客戶</dt><dd className="text-slate-200">{card.customer ?? '（無客戶名稱）'}</dd>
          <dt className="text-slate-400">品名</dt><dd className="break-words font-semibold text-slate-100">{card.itemName ?? '（無品名）'}</dd>
          <dt className="text-slate-400">這張卡數量</dt><dd className="tabular-nums text-slate-200">{fmtQty(bc.effectiveQty)}{card.unit ? ` ${card.unit}` : ''}</dd>
          <dt className="text-slate-400">訂單總量</dt><dd className="tabular-nums text-slate-200">{fmtQty(card.qtyTotal)}{card.unit ? ` ${card.unit}` : ''}</dd>
        </dl>
        <label className="block">
          <span className="text-slate-300">備註（選填，例：已出貨未銷貨／業務未改交期）</span>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={2}
            maxLength={CLOSURE_NOTE_MAX * 2}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 focus:border-rose-500 focus:outline-none"
          />
          <span className={`block text-[11px] ${tooLong ? 'text-red-300' : 'text-slate-500'}`}>{Array.from(note).length}／{CLOSURE_NOTE_MAX} 字{tooLong ? '（超過上限）' : ''}</span>
        </label>
      </div>
    </Modal>
  )
}
