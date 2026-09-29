'use client'

// 鎖定清單（D88：可鎖單張卡、整張訂單、整條線；被鎖的卡原位不動、照樣佔產能，AI 看得到但不能改）。
// 卡片上的鎖頭是「鎖定模式」下點卡片切換、訂單鎖在卡片詳情、線鎖在工具列；這裡集中列出目前鎖了什麼，方便一次解除。

import type { BoardBody, SimCardMeta, SimLocks } from '@/lib/packaging/ai/types'
import type { BoardCard, PackagingLine } from '@/lib/packaging/scheduleTypes'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import { fmtQty } from '@/components/packaging/poolStyles'
import { Btn } from '@/components/packaging/board/Modal'
import { md } from '@/components/packaging/board/boardFormat'
import Drawer from './Drawer'
import { lockReasonsFor, locksCount, soNumberOfKey, toggleCardLock, toggleLineLock } from './simBoard'

export default function LockPanel({ locks, simCards, board, lines, editable, onChange, onClose }: {
  locks: SimLocks
  simCards: Record<string, SimCardMeta>
  /** 未加工的模擬區工作台 */
  board: BoardBody | null
  lines: PackagingLine[]
  editable: boolean
  onChange: (next: SimLocks, label: string) => void
  onClose: () => void
}) {
  const simRows: BoardCard[] = []
  for (const d of board?.days ?? []) for (const c of d.cards) if (simCards[c.placementId]) simRows.push(c)
  const byId = new Map(simRows.map(c => [c.placementId, c]))
  const lockedRows = simRows.filter(c => lockReasonsFor({ id: c.placementId, soLineKey: c.soLineKey, lineId: c.lineId ?? null }, locks).length > 0)
  const orderCount = (so: string) => simRows.filter(c => soNumberOfKey(c.soLineKey) === so).length
  const total = locksCount(locks)

  return (
    <Drawer title={`鎖定清單（${total}）`} onClose={onClose}>
      <div className="space-y-4 text-xs">
        <p className="text-[11px] leading-relaxed text-slate-400">
          鎖定的卡原位不動、照樣佔產能；AI 看得到但不能改，採用時也原樣保留。鎖定的訂單：剩餘量 AI 也不能新排；
          鎖定的線：AI 不能放新卡、也不能移出，採用時整條線不動（D87）。目前共 {lockedRows.length} 張卡處於鎖定狀態。
        </p>

        <section className="space-y-1.5">
          <h3 className="font-bold text-slate-200">整條線（{locks.lineIds.length}）</h3>
          {locks.lineIds.length === 0 ? <p className="text-[11px] text-slate-500">沒有（工具列的線名按鈕可以鎖整條線）</p> : (
            <ul className="space-y-1">
              {locks.lineIds.map(id => (
                <li key={id} className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950/40 px-2 py-1">
                  <span className="flex-1">🔒 {lineNameOf(lines, id)}</span>
                  <Btn disabled={!editable} onClick={() => onChange(toggleLineLock(locks, id), `解除鎖定 ${lineNameOf(lines, id)}`)}>解除</Btn>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-1.5">
          <h3 className="font-bold text-slate-200">整張訂單（{locks.soNumbers.length}）</h3>
          {locks.soNumbers.length === 0 ? <p className="text-[11px] text-slate-500">沒有（卡片詳情可以「鎖定整張訂單」）</p> : (
            <ul className="space-y-1">
              {locks.soNumbers.map(so => (
                <li key={so} className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950/40 px-2 py-1">
                  <span className="flex-1 font-mono">🔒 {so}<span className="ml-1 font-sans text-slate-500">（模擬區 {orderCount(so)} 張）</span></span>
                  <Btn disabled={!editable} onClick={() => onChange({ ...locks, soNumbers: locks.soNumbers.filter(x => x !== so) }, `解除鎖定訂單 ${so}`)}>解除</Btn>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-1.5">
          <h3 className="font-bold text-slate-200">單張卡（{locks.placementIds.length}）</h3>
          {locks.placementIds.length === 0 ? <p className="text-[11px] text-slate-500">沒有（開「鎖定模式」後點卡片）</p> : (
            <ul className="space-y-1">
              {locks.placementIds.map(id => {
                const c = byId.get(id)
                return (
                  <li key={id} className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950/40 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate">
                      🔒 {c ? <><span className="font-mono text-sky-300">{c.soLineKey}</span>
                        <span className="text-slate-400">　{c.planDate ? md(c.planDate) : ''} {lineNameOf(lines, c.lineId ?? null)}・{fmtQty(c.effectiveQty)}</span></>
                        : <span className="text-slate-500">（已不在模擬區的卡）</span>}
                    </span>
                    <Btn disabled={!editable} onClick={() => onChange(toggleCardLock(locks, id), `解除鎖定 ${c?.soLineKey ?? '卡片'}`)}>解除</Btn>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <div className="flex justify-end border-t border-slate-800 pt-3">
          <Btn tone="danger" disabled={!editable || total === 0} onClick={() => onChange({ placementIds: [], soNumbers: [], lineIds: [] }, '全部解除鎖定')}>全部解除</Btn>
        </div>
      </div>
    </Drawer>
  )
}
