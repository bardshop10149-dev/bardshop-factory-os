'use client'

// D7 拆卡對話框：原卡留第一列，其餘各成新卡（新 id 由前端產生，Undo 時才能以原 id 重建）。
// 規則與伺服器 applyOps 相同：各列數量 > 0、最多 3 位小數、合計必須等於原卡「儲存數量」qty
// （被待排池修剪過的卡，有效數量較少，但拆分以儲存數量為準，讀取時會再依供給修剪）。

import { useMemo, useState } from 'react'
import type { BoardCard, BoardDay, YMD } from '@/lib/packaging/scheduleTypes'
import { fmtQty } from '@/components/packaging/poolStyles'
import Modal, { Btn } from './Modal'
import { md } from './boardFormat'

const MAX_PARTS = 10

interface Row { qty: string; date: YMD | '' }

function toNum(s: string): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** 3 位小數以內 */
function validQty(n: number): boolean {
  return Number.isFinite(n) && n > 0 && Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6
}

export default function SplitDialog({ bc, days, onClose, onSubmit }: {
  bc: BoardCard
  /** 可選的日期（工作台視窗內的日期欄） */
  days: BoardDay[]
  onClose: () => void
  onSubmit: (keepQty: number, parts: { qty: number; toDate: YMD | null }[]) => void
}) {
  const Q = bc.qty
  const defDate: YMD | '' = bc.planDate ?? ''
  const [rows, setRows] = useState<Row[]>(() => {
    const a = Math.floor(Q / 2)
    return [{ qty: String(Q - a), date: defDate }, { qty: String(a), date: defDate }]
  })

  const nums = rows.map(r => toNum(r.qty))
  const sum = nums.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0)
  const allValid = nums.every(validQty)
  const sumOk = Math.abs(sum - Q) < 1e-6
  const ok = rows.length >= 2 && allValid && sumOk

  const dateOptions = useMemo(() => {
    const list = days.map(d => ({ value: d.date, label: d.label }))
    // 原卡日期不在視窗內（例：延誤卡的原排日）時也要能選「同原卡」
    if (bc.planDate && !list.some(o => o.value === bc.planDate)) list.unshift({ value: bc.planDate, label: `${md(bc.planDate)}（原日期）` })
    return list
  }, [days, bc.planDate])

  const setRow = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const evenSplit = () => setRows(rs => {
    const n = rs.length
    const base = Math.floor(Q / n)
    return rs.map((r, i) => ({ ...r, qty: String(i === 0 ? Q - base * (n - 1) : base) }))
  })
  const restToLast = () => setRows(rs => {
    const head = rs.slice(0, -1).reduce((s, r) => s + (Number.isFinite(toNum(r.qty)) ? toNum(r.qty) : 0), 0)
    const rest = Math.round((Q - head) * 1000) / 1000
    return rs.map((r, i) => (i === rs.length - 1 ? { ...r, qty: String(rest) } : r))
  })

  const submit = () => {
    if (!ok) return
    const [keep, ...parts] = rows
    onSubmit(toNum(keep.qty), parts.map(p => ({ qty: toNum(p.qty), toDate: p.date || null })))
  }

  return (
    <Modal
      title={<>拆卡：<span className="font-mono">{bc.card.so}{bc.card.soLine ? `-${bc.card.soLine}` : ''}</span></>}
      onClose={onClose}
      footer={<>
        <span className={`mr-auto text-xs ${sumOk ? 'text-emerald-300' : 'text-orange-300'}`}>
          合計 {fmtQty(Math.round(sum * 1000) / 1000)}／{fmtQty(Q)}{!sumOk ? `（差 ${fmtQty(Math.round((Q - sum) * 1000) / 1000)}）` : ''}
        </span>
        <Btn onClick={onClose}>取消</Btn>
        <Btn tone="primary" disabled={!ok} onClick={submit}>確定拆卡</Btn>
      </>}
    >
      <p className="text-xs text-slate-400">
        原卡數量 <b className="text-slate-100">{fmtQty(Q)}</b>
        {bc.effectiveQty !== bc.qty && <>（待排池減少後有效 {fmtQty(bc.effectiveQty)}；以儲存數量拆分）</>}
        。第一列留在原卡，其餘各成一張新卡；日期可留空＝放進待排區。
      </p>
      <div className="mt-3 space-y-2">
        {rows.map((r, i) => {
          const n = toNum(r.qty)
          const bad = r.qty !== '' && !validQty(n)
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-xs text-slate-400">{i === 0 ? '原卡' : `新卡 ${i}`}</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={r.qty}
                onChange={e => setRow(i, { qty: e.target.value })}
                aria-label={`第 ${i + 1} 張數量`}
                className={`w-28 rounded border bg-slate-950 px-2 py-1 text-right text-sm ${bad ? 'border-rose-500' : 'border-slate-700'}`}
              />
              <select
                value={r.date}
                onChange={e => setRow(i, { date: e.target.value })}
                aria-label={`第 ${i + 1} 張日期`}
                disabled={i === 0}
                title={i === 0 ? '原卡日期不變；要改日期請拆完再拖' : undefined}
                className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm disabled:opacity-60"
              >
                <option value="">待排區（不排日期）</option>
                {dateOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {i >= 2 && (
                <button type="button" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}
                  aria-label="刪除這一列" className="rounded px-2 text-slate-400 hover:bg-slate-800 hover:text-white">×</button>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn disabled={rows.length >= MAX_PARTS} onClick={() => setRows(rs => [...rs, { qty: '0', date: defDate }])}>＋ 再加一張</Btn>
        <Btn onClick={evenSplit}>平均分配</Btn>
        <Btn onClick={restToLast}>剩餘全給最後一張</Btn>
      </div>
      {!allValid && <p className="mt-2 text-xs text-rose-300">每張數量要大於 0（最多 3 位小數）</p>}
    </Modal>
  )
}
