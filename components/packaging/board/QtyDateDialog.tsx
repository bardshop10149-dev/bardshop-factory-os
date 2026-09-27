'use client'

// 兩個小對話框共用：
// - 「排部分數量…」（待排池卡）：數量 ≤ 剩餘可排量＋日期（或待排區）→ place
// - 「移到日期…」（擺放卡；拖曳的鍵盤替代）：日期（或待排區）→ move
// 日期可選工作台視窗內的欄，也可手動輸入更後面的日期（伺服器會驗證是否為工作日／已開加班的週六）。

import { useState } from 'react'
import type { BoardDay, YMD } from '@/lib/packaging/scheduleTypes'
import { fmtQty } from '@/components/packaging/poolStyles'
import Modal, { Btn } from './Modal'
import { md } from './boardFormat'

const HOLD = '__hold__'
const CUSTOM = '__custom__'

export default function QtyDateDialog({ mode, title, days, today, maxQty, defaultQty, minDate: minDateProp, readyQty, onClose, onSubmit }: {
  mode: 'place' | 'move'
  title: string
  /** 可選的日期（日檢視只載入 1 天，由 BoardLayout 另外列出之後 10 個工作日） */
  days: Pick<BoardDay, 'date' | 'label' | 'kind'>[]
  today: YMD
  /** place：剩餘可排量 */
  maxQty?: number
  defaultQty?: number
  /** D22：預排卡最早可放的日期 */
  minDate?: YMD | null
  /** place：可包量；排的數量不超過它時沒有日期限制（不會變預排卡） */
  readyQty?: number
  onClose: () => void
  onSubmit: (qty: number | null, toDate: YMD | null) => void
}) {
  const [qty, setQty] = useState(String(defaultQty ?? maxQty ?? ''))
  const n = Number(qty)
  const minDate = mode === 'place' && readyQty != null && Number.isFinite(n) && n <= readyQty ? null : (minDateProp ?? null)
  const [sel, setSel] = useState<string>(() => days.find(d => !minDateProp || d.date >= minDateProp)?.date ?? HOLD)
  const [custom, setCustom] = useState('')

  const qtyOk = mode === 'move' || (Number.isFinite(n) && n > 0 && (maxQty == null || n <= maxQty + 1e-9))
  const date: YMD | null = sel === HOLD ? null : sel === CUSTOM ? (custom || null) : sel
  const customBad = sel === CUSTOM && (!custom || custom < today || (minDate != null && custom < minDate))
  const selEarly = minDate != null && date != null && date < minDate
  const ok = qtyOk && !customBad && !selEarly

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>取消</Btn>
        <Btn tone="primary" disabled={!ok} onClick={() => onSubmit(mode === 'place' ? n : null, date)}>確定</Btn>
      </>}
    >
      {mode === 'place' && (
        <label className="block">
          <span className="text-xs text-slate-400">數量（剩餘可排 {fmtQty(maxQty ?? 0)}）</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={qty}
            onChange={e => setQty(e.target.value)}
            className={`mt-1 w-40 rounded border bg-slate-950 px-2 py-1 text-right text-sm ${qtyOk ? 'border-slate-700' : 'border-rose-500'}`}
          />
        </label>
      )}
      <label className="mt-3 block">
        <span className="text-xs text-slate-400">排到哪一天</span>
        <select value={sel} onChange={e => setSel(e.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm">
          {days.map(d => {
            const early = minDate != null && d.date < minDate
            return (
              <option key={d.date} value={d.date} disabled={early}>
                {d.label}{d.kind === 'saturday_ot' ? '（加班）' : ''}{early ? `（早於預估可包 ${md(minDate)}）` : ''}
              </option>
            )
          })}
          <option value={CUSTOM}>其他日期…</option>
          <option value={HOLD}>待排區（先擱置，不排日期）</option>
        </select>
      </label>
      {sel === CUSTOM && (
        <label className="mt-2 block">
          <input
            type="date"
            value={custom}
            min={minDate && minDate > today ? minDate : today}
            onChange={e => setCustom(e.target.value)}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
          />
          <span className="ml-2 text-[11px] text-slate-500">須為工作日或已開加班的週六</span>
        </label>
      )}
      {minDate && <p className="mt-2 text-[11px] text-sky-300">預排卡：不能早於預估可包日 {md(minDate)}（D22）</p>}
    </Modal>
  )
}
