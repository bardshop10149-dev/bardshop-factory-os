'use client'

// D104／D107 在模擬區對一張卡「結案」（已完工卻漏銷貨／沒改交期、永遠排不掉的卡）。
//
// 結案是「正式區」的事實（packaging_closures，另一個 session 實作）：這一行（SO-項次）永久不再拉回待排池，
// 伺服器會一併把正式區與所有人模擬區裡這一行的卡移除。所以這個對話框：
//   - 不走模擬區的 version／undo（結案不是模擬區的一步，「退回上一步」退不回；復原只能到「已結案」清單手動復原，D104）；
//   - 成功後由 SimLayout 重新載入模擬區（該行的卡已消失）並顯示回饋。
// 這裡只做確認（單號-項次、品名、數量）＋備註輸入＋呼叫 API；錯誤顯示在對話框底部、輸入保留。

import { useState } from 'react'
import type { BoardCard } from '@/lib/packaging/scheduleTypes'
import { fmtQty } from '@/components/packaging/poolStyles'
import Modal, { Btn } from '@/components/packaging/board/Modal'
import { lineLabel } from '@/components/packaging/board/CardFace'
import { postClosure, type ClosureCloseResponse } from './simApi'

/** 備註上限（與 D104「備註（選填）」的常識長度；伺服器若另有上限會回錯誤訊息） */
export const CLOSURE_NOTE_MAX = 200

export interface ClosureDone {
  soLineKey: string
  response: Extract<ClosureCloseResponse, { success: true }>
}

export default function SimCloseDialog({ bc, onClose, onDone }: {
  /** 未加工的原始卡 */
  bc: BoardCard
  onClose: () => void
  /** 結案成功（呼叫端負責重新載入模擬區與 toast） */
  onDone: (r: ClosureDone) => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const card = bc.card
  const tooLong = Array.from(note).length > CLOSURE_NOTE_MAX

  const submit = async () => {
    if (busy || tooLong) return
    setBusy(true)
    setError(null)
    try {
      const trimmed = note.trim()
      const r = await postClosure({ action: 'close', soLineKey: bc.soLineKey, ...(trimmed ? { note: trimmed } : {}) })
      if (r.json && r.json.success) {
        onDone({ soLineKey: bc.soLineKey, response: r.json })
        return
      }
      setError(r.error ?? '結案失敗')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={<span>結案（不再拉回待排池）　<span className="font-mono">{lineLabel(card)}</span></span>}
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose} disabled={busy}>取消</Btn>
        <Btn tone="danger" disabled={busy || tooLong} onClick={() => { void submit() }}>{busy ? '結案中…' : '確定結案'}</Btn>
      </>}
    >
      <div className="space-y-2 text-xs leading-relaxed">
        <div className="rounded-lg border border-rose-800/70 bg-rose-950/30 px-3 py-2 text-rose-100">
          結案後這一行<b>永久不再拉回待排池</b>，正式排程與所有人模擬區裡這一行的卡都會被移除；
          「退回上一步」退不回，要復原只能到「已結案」清單手動復原（D104）。
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
            disabled={busy}
            rows={2}
            maxLength={CLOSURE_NOTE_MAX * 2}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 focus:border-rose-500 focus:outline-none"
          />
          <span className={`block text-[11px] ${tooLong ? 'text-red-300' : 'text-slate-500'}`}>{Array.from(note).length}／{CLOSURE_NOTE_MAX} 字{tooLong ? '（超過上限）' : ''}</span>
        </label>
        {error && <div role="alert" className="rounded border border-red-700 bg-red-950/60 px-3 py-2 text-red-100">{error}</div>}
      </div>
    </Modal>
  )
}
