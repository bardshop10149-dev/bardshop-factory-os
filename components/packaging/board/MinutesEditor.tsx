'use client'

// D69 卡片詳情的「工時」段：主管輸入這張（子）卡要花的時間，或回到標準估計值。
// - 畫面上輸入的是「目前有效數量」的工時（小時，最多 2 位小數）；存回 DB 的覆寫值以「本列 qty」為準，
//   由這裡用 overrideFromEffective 換算好再交給 onSubmit（待排池減少時卡片數量會被修剪，兩者可能不同）。
// - onSubmit(null, …)＝回到標準值（清除覆寫）。實際送 setMinutes（via 'dialog'）與 toast 由 (a) 的 useBoard 處理。
// - 已完成的卡也能改（記下實際花的時間，學習價值最高）；拉卡片下緣只給未完成卡（(a) 負責），這裡不分。
// - editable＝false（沒持有編輯鎖）時唯讀。每次修改伺服器都會另寫一筆學習紀錄（MinutesHistory 顯示）。

import { useState } from 'react'
import { ADJUST_REASON_MAX, MINUTES_OVERRIDE_MAX, type BoardCard } from '@/lib/packaging/scheduleTypes'
import { isValidOverride, overrideFromEffective } from '@/lib/packaging/scheduleMinutes'
import { hoursText } from '@/lib/packaging/boardView'
import { clock } from './boardFormat'
import { Btn } from './Modal'

/** 小時輸入：最多 3 位整數、2 位小數 */
const HOURS_RE = /^\d{1,3}(\.\d{1,2})?$/

/** 小時字串 → 有效工時（分鐘，1 位小數）；不合法回 null */
export function hoursInputToMinutes(text: string): number | null {
  const t = text.trim()
  if (!HOURS_RE.test(t)) return null
  const m = Math.round(Number(t) * 60 * 10) / 10
  return m > 0 ? m : null
}

export default function MinutesEditor({ bc, editable, busy = false, onSubmit }: {
  bc: BoardCard
  editable: boolean
  busy?: boolean
  /** minutes＝以本列 qty 為準的覆寫值（已換算）；null＝回到標準值 */
  onSubmit: (minutes: number | null, reason: string | null) => void
}) {
  const current = bc.minutes
  const [text, setText] = useState(() => hoursText(current) ?? '')
  const [reason, setReason] = useState('')

  const std = bc.minutesStd ?? null
  const ov = bc.minutesOverride ?? null
  const effMin = hoursInputToMinutes(text)
  const stored = effMin == null ? null : overrideFromEffective(effMin, bc.qty, bc.effectiveQty)
  const inputErr = text.trim() === '' ? '請輸入工時（小時）'
    : effMin == null ? '工時須大於 0，最多 2 位小數'
    : stored == null || !isValidOverride(stored) ? `工時上限 ${MINUTES_OVERRIDE_MAX / 60} 小時`
    : null
  const unchanged = effMin != null && current != null && Math.abs(effMin - current) < 0.05
  const reasonTrim = reason.trim()
  const reasonErr = reasonTrim.length > ADJUST_REASON_MAX ? `原因最多 ${ADJUST_REASON_MAX} 字` : null
  const canSave = editable && !busy && !inputErr && !reasonErr && !unchanged && stored != null
  const qtyNote = bc.effectiveQty !== bc.qty

  return (
    <div className="space-y-1.5">
      <div>
        <span className="text-slate-400">標準估計　</span>
        {std != null ? <span className="tabular-nums">{hoursText(std)} h</span> : <span className="text-orange-300">未知</span>}
        {bc.card.work.explain ? <span className="text-slate-400">（{bc.card.work.explain}）</span> : null}
      </div>
      <div>
        <span className="text-slate-400">目前　　　</span>
        {current != null ? <span className="font-semibold tabular-nums">{hoursText(current)} h</span> : <span className="text-orange-300">未知（未計入負荷）</span>}
        {ov
          ? <span className="ml-1 text-amber-300">主管改：{ov.byName ?? ov.by}（{clock(ov.at)}）</span>
          : <span className="ml-1 text-slate-400">標準</span>}
      </div>
      {editable ? (
        <form
          className="space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-2"
          onSubmit={e => { e.preventDefault(); if (canSave) onSubmit(stored, reasonTrim || null) }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              <span className="text-slate-400">改為</span>
              <input
                value={text}
                inputMode="decimal"
                onChange={e => setText(e.target.value)}
                aria-label="工時（小時）"
                className="w-20 rounded border border-slate-600 bg-slate-950 px-1.5 py-0.5 text-right tabular-nums text-slate-100"
              />
              <span className="text-slate-400">小時</span>
            </label>
            {effMin != null && !inputErr && <span className="text-[11px] text-slate-500">＝{effMin} 分</span>}
            {qtyNote && <span className="text-[11px] text-slate-500">（以目前數量計算；數量再變動時等比調整）</span>}
          </div>
          <input
            value={reason}
            maxLength={ADJUST_REASON_MAX}
            onChange={e => setReason(e.target.value)}
            placeholder="原因（選填）：例 手工貼標、新人上線…"
            className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-200 placeholder:text-slate-600"
          />
          <div className="flex flex-wrap items-center gap-2">
            {(inputErr || reasonErr) && text.trim() !== '' && <span className="text-[11px] text-orange-300">{inputErr ?? reasonErr}</span>}
            {!inputErr && unchanged && <span className="text-[11px] text-slate-500">和目前相同</span>}
            <span className="flex-1" />
            {ov && (
              <Btn disabled={busy} onClick={() => onSubmit(null, reasonTrim || null)}
                title="清除主管修改，改回依數量計算的標準估計">回到標準值</Btn>
            )}
            <Btn type="submit" tone="primary" disabled={!canSave}>{busy ? '處理中…' : '儲存工時'}</Btn>
          </div>
          <p className="text-[10px] leading-snug text-slate-500">每次修改都會留下紀錄（誰、何時、改前改後、原因），之後用來校正標準工時；改錯可用工作台的「復原」還原。</p>
        </form>
      ) : (
        <p className="text-[11px] text-slate-500">取得編輯權後可修改工時。</p>
      )}
    </div>
  )
}
