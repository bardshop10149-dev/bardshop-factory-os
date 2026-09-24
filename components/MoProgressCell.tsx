'use client'

// 出單表「生產進度」欄：把塔台的逐道工序狀態壓縮成一格看得懂的東西。
//
// 資料來自 /api/argoerp/sheet-progress（伺服器端彙總 sara_wip_records ＋
// sara_wip_schedule ＋ sara_lot_progress，見該檔說明）。這裡只負責呈現：
//   一節 = 一道工序，綠色＝已報工完成、黃色＝正在跑、橘色＝暫停、灰色＝還沒開工。
// 滑鼠移上去看得到每一道工序的站點、製程名稱、報工數量與完工時間。

export type StepStatus = 'finished' | 'running' | 'pause' | 'pending'

export interface SheetProgressStep {
  sequence: number | null
  station: string | null
  jobName: string | null
  status: StepStatus
  qty: number | null
  endTime: string | null
}

export interface SheetProgress {
  doneCount: number
  totalCount: number
  runningCount: number
  percentage: number | null
  healthState: string | null
  lastReportAt: string | null
  steps: SheetProgressStep[]
}

const SEGMENT_CLASS: Record<StepStatus, string> = {
  finished: 'bg-emerald-500',
  running: 'bg-amber-400',
  pause: 'bg-orange-500/70',
  pending: 'bg-slate-700',
}

const STATUS_LABEL: Record<StepStatus, string> = {
  finished: '✅ 已完成',
  running: '🟡 進行中',
  pause: '⏸ 暫停',
  pending: '⬜ 未開工',
}

/** 2026-09-11T12:23:24+00:00 → 09/11 20:23（塔台時間一律以台北呈現） */
function shortTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function tooltipOf(progress: SheetProgress): string {
  const lines = progress.steps.map(s => {
    const seq = s.sequence != null ? `#${s.sequence}` : '#—'
    const qty = s.qty != null ? `　報工 ${s.qty}` : ''
    const end = s.endTime ? `　${shortTime(s.endTime)}` : ''
    return `${seq} ${s.station ?? '—'}／${s.jobName ?? '—'}　${STATUS_LABEL[s.status]}${qty}${end}`
  })
  const head = `已完成 ${progress.doneCount}／${progress.totalCount} 道工序`
    + (progress.percentage != null ? `（塔台進度 ${progress.percentage}%）` : '')
  return [head, ...lines].join('\n')
}

export function MoProgressCell({
  progress,
  hasMo,
  factory,
  onOpen,
}: {
  progress: SheetProgress | undefined
  /** 這一列是否有台北製令——沒有製令（常平採購／委外請購）塔台本來就不會有進度 */
  hasMo: boolean
  /** 廠區：常平(C) 直接標示在常平廠生產，不用去對塔台的逐道工序 */
  factory?: string
  onOpen: () => void
}) {
  // 常平列：貨是在常平廠做的，塔台上只有轉運／包裝這類少數工序會報工，
  // 逐道工序的進度條對常平沒有意義（而且 9/4 以前的常平工單號在塔台是不帶行號的
  // 裸單號，本來就對不起來）。直接標示「常平廠生產」比顯示一個「—」有用。
  if (factory === 'C') {
    return (
      <span
        title="這一列走常平廠的途程，實際生產在常平；塔台上不會有完整的逐道工序報工"
        className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-950/40 text-amber-300 border border-amber-800/50"
      >
        常平廠生產
      </span>
    )
  }
  if (!hasMo) return <span className="text-slate-600">—</span>
  if (!progress || progress.totalCount === 0) {
    return (
      <span className="text-[10px] text-slate-600" title="塔台尚未建立這張製令的工序，或還沒同步到">
        無塔台資料
      </span>
    )
  }

  const { doneCount, totalCount, runningCount, steps, lastReportAt } = progress
  const allDone = doneCount === totalCount

  return (
    <button
      onClick={onOpen}
      title={tooltipOf(progress)}
      className="text-left w-full group"
    >
      <div className="flex items-center gap-1.5">
        <div className="flex gap-[2px] flex-1 min-w-[52px]">
          {steps.map((s, i) => (
            <span
              key={`${s.sequence ?? 'x'}-${i}`}
              className={`h-2 flex-1 rounded-[2px] ${SEGMENT_CLASS[s.status]} ${s.status === 'running' ? 'animate-pulse' : ''}`}
            />
          ))}
        </div>
        <span className={`text-[11px] font-mono tabular-nums shrink-0 ${
          allDone ? 'text-emerald-300' : runningCount > 0 ? 'text-amber-300' : 'text-slate-400'
        }`}>
          {doneCount}/{totalCount}
        </span>
      </div>
      <div className="text-[10px] text-slate-500 mt-0.5 group-hover:text-slate-400 truncate">
        {allDone ? '全部完成'
          : runningCount > 0 ? `${steps.find(s => s.status === 'running')?.station ?? ''}進行中`
          : doneCount === 0 ? '尚未開工'
          : `下一站 ${steps.find(s => s.status !== 'finished')?.station ?? '—'}`}
        {lastReportAt && <span className="ml-1 text-slate-600">{shortTime(lastReportAt)}</span>}
      </div>
    </button>
  )
}
