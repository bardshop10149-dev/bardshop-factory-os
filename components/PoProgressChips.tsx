'use client'

/**
 * 採購進度三里程碑（唯讀展示版）：發單 → 出貨 → 到倉＋連續光條，
 * 與採購專區進度格同視覺（business 端不可點，僅顯示）。
 * ARGO 單據狀態 OPEN 自動視為已發單（與採購專區一致，Snow 2026-07-14）。
 */
export default function PoProgressChips({ progress, poStatus }: { progress?: string | null; poStatus?: string | null }) {
  const ladder = ['未發單', '已發單', '已出貨', '已到倉']
  let level = Math.max(0, ladder.indexOf(progress ?? '未發單'))
  const isOpen = (poStatus ?? '').trim().toUpperCase() === 'OPEN'
  if (isOpen && level < 1) level = 1

  const chip = (active: boolean, activeCls: string) =>
    `text-[10px] px-1 py-0.5 rounded font-semibold border whitespace-nowrap ${
      active ? activeCls : 'bg-slate-800 text-slate-500 border-slate-700'
    }`
  const pct = (level / 3) * 100
  const fillCls =
    level >= 3 ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)]'
    : level === 2 ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.75)]'
    : level === 1 ? 'bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.75)]'
    : ''

  return (
    <div className="flex flex-col gap-1 w-fit">
      <div className="flex items-center gap-0.5">
        <span
          className={chip(level >= 1, 'bg-sky-900/60 text-sky-300 border-sky-600/60')}
          title={isOpen ? 'ARGO 單據狀態 OPEN，自動視為已發單' : undefined}
        >發單</span>
        <span className={chip(level >= 2, 'bg-amber-900/60 text-amber-300 border-amber-600/60')}>出貨</span>
        <span className={chip(level >= 3, 'bg-emerald-900/60 text-emerald-300 border-emerald-600/60')}>到倉</span>
      </div>
      <div className="h-[3px] w-full rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full rounded-full ${fillCls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
