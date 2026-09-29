'use client'

// D104 結案確認對話框：顯示單號-項次、品名、數量、交期、原區塊，備註輸入（≤ CLOSURE_NOTE_MAX 字）→ 送 POST /api/packaging/closures。
// 不需編輯鎖（結案是單據事實，不是排程動作）；不進 Undo（誤結請到「已結案清單」復原——面板延後，先由 GET API 提供）。
// 送出後由呼叫端重新載入工作台：伺服器已把該行未完成的排定卡放回（刪除）、模擬區的卡移除。

import { useState } from 'react'
import { CLOSURE_NOTE_MAX } from '@/lib/packaging/scheduleTypes'
import { POOL_BLOCK_META, type PoolBlockId } from '@/lib/packaging/types'
import Modal, { Btn } from './Modal'
import { md } from './boardFormat'
import { postClosure } from './boardApi'

/** 對話框要顯示的那一行（來源可能是待排池卡或排定卡；伺服器自己重算快照，這裡只是給主管確認） */
export interface CloseTarget {
  soLineKey: string
  so: string
  soLine: string | null
  customer: string | null
  itemCode: string | null
  itemName: string | null
  /** 待排池卡＝剩餘可排量；排定卡＝這張卡的量 */
  qty: number
  unit: string | null
  dueDate: string | null
  block: PoolBlockId | null
  /** 這一行目前在工作台上的未完成排定卡張數（會一併放回）；不知道就省略 */
  openPlacements?: number
}

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000))

export default function ClosureDialog({ target, busyHint, onClose, onDone }: {
  target: CloseTarget
  /** 工作台還有未儲存的操作時給提示、先擋送出（避免與自動儲存交錯） */
  busyHint?: string | null
  onClose: () => void
  /** 結案成功：訊息＋伺服器放回的排定卡張數＋清掉的模擬卡張數（呼叫端清 Undo、重新載入） */
  onDone: (r: { message: string; unplaced: number; simRemoved: number }) => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const label = `${target.so}${target.soLine ? `-${target.soLine}` : ''}`

  const submit = async () => {
    if (busy || busyHint) return
    setBusy(true)
    setErr(null)
    try {
      const r = await postClosure({ action: 'close', soLineKey: target.soLineKey, note: note.trim() || null })
      if (r.json?.success) {
        const { unplaced, simRemoved } = r.json
        onDone({
          message: `已結案 ${label}${unplaced > 0 ? `，放回 ${unplaced} 張排定卡` : ''}${simRemoved > 0 ? `，清掉模擬區 ${simRemoved} 張` : ''}`,
          unplaced, simRemoved,
        })
      } else {
        setErr(r.error ?? '結案失敗')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`結案：${label}`}
      onClose={onClose}
      footer={(
        <>
          <Btn onClick={onClose} disabled={busy}>取消</Btn>
          <Btn tone="danger" onClick={() => void submit()} disabled={busy || !!busyHint} title={busyHint ?? undefined}>
            {busy ? '結案中…' : '確定結案'}
          </Btn>
        </>
      )}
    >
      <div className="space-y-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-slate-400">單號-項次</dt><dd className="font-mono text-slate-100">{label}</dd>
          <dt className="text-slate-400">客戶</dt><dd className="text-slate-200">{target.customer ?? '—'}</dd>
          <dt className="text-slate-400">品名</dt>
          <dd className="text-slate-200">{target.itemName ?? '—'}{target.itemCode ? <span className="ml-1 font-mono text-[11px] text-slate-500">{target.itemCode}</span> : null}</dd>
          <dt className="text-slate-400">數量</dt><dd className="tabular-nums text-slate-200">{fmtQty(target.qty)}{target.unit ? ` ${target.unit}` : ''}</dd>
          <dt className="text-slate-400">交期</dt><dd className="text-slate-200">{target.dueDate ? md(target.dueDate) : '—'}</dd>
          <dt className="text-slate-400">原區塊</dt><dd className="text-slate-200">{target.block ? POOL_BLOCK_META[target.block].title : '—'}</dd>
        </dl>
        <div className="rounded border border-rose-800/60 bg-rose-950/30 px-3 py-2 text-[12px] leading-relaxed text-rose-100">
          結案後這個 SO 品項行<b>永久不再進待排池</b>（含手動加入）；
          {target.openPlacements != null && target.openPlacements > 0
            ? <>目前 <b>{target.openPlacements}</b> 張未完成的排定卡會一併放回（刪除），</>
            : <>同行未完成的排定卡會一併放回（刪除），</>}
          各人模擬區裡這一行的卡也會移除。已勾完成的不受影響。
          <span className="block text-rose-300/80">不進「復原」（Ctrl+Z）；要拉回請由主管在已結案清單復原。</span>
        </div>
        <label className="block text-xs text-slate-300">
          備註（選填，例：已出貨未開銷貨單、交期改到下月）
          <textarea
            autoFocus
            value={note}
            maxLength={CLOSURE_NOTE_MAX}
            onChange={e => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
          <span className="text-[10px] text-slate-500">{note.length}／{CLOSURE_NOTE_MAX}</span>
        </label>
        {busyHint && <p className="text-xs text-amber-300">{busyHint}</p>}
        {err && <p className="text-xs text-rose-300">{err}</p>}
      </div>
    </Modal>
  )
}
