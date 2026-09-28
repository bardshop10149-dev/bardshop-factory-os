'use client'

// D100 卡片詳情的「順序」列：A 線 第 3／7 張　[▲ 上移] [▼ 下移]
// 正式工作台（CardDetailDialog）與 AI 模擬區（SimCardDetail）共用同一個元件，兩邊外觀與行為一致。
// - 為什麼要有按鈕：兩週迷你卡約 64×30px 很難精準拖；手機／平板不能拖（D54）但可以按。
//   按鈕＝「拖到上一張之前／下下一張之前」的捷徑，送出的 op 與拖曳完全相同（boardLocal.laneStepPlan → planLaneReorder）。
// - 按下後對話框不關閉：畫面資料（樂觀更新）一變，這裡的「第 n 張」與按鈕狀態就跟著更新，可以連按。
// - 停用時：title 放原因；兩個都停用時直接顯示原因小字（手機沒有 hover，看不到 title）。

import type { LaneStepInfo } from './boardLocal'

export interface LaneOrderProps {
  /** 線名（例：A 線） */
  lineName: string
  info: LaneStepInfo
  onStep: (dir: 'up' | 'down') => void
  /** 按鈕的補充說明（例：每按一次＝一步復原） */
  hint?: string
}

const BTN = 'rounded border px-2 py-0.5 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-40'

export default function LaneOrderRow({ lineName, info, onStep, hint }: LaneOrderProps) {
  const both = info.up != null && info.down != null
  const downTitle = info.down ?? `往下排一格${info.pinned ? '（會解除延誤）' : ''}${hint ? `；${hint}` : ''}`
  const upTitle = info.up ?? `往上排一格${hint ? `；${hint}` : ''}`
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span><span className="text-slate-400">順序　　　</span>{lineName} 第 <span className="tabular-nums">{info.position}／{info.total}</span> 張</span>
        <span className="flex gap-1">
          <button
            type="button"
            onClick={() => onStep('up')}
            disabled={info.up != null}
            title={upTitle}
            aria-label="上移（在這條線往上排一格）"
            className={`${BTN} border-sky-700 bg-sky-950/50 text-sky-100 hover:bg-sky-900/60`}
          >▲ 上移</button>
          <button
            type="button"
            onClick={() => onStep('down')}
            disabled={info.down != null}
            title={downTitle}
            aria-label="下移（在這條線往下排一格）"
            className={`${BTN} border-sky-700 bg-sky-950/50 text-sky-100 hover:bg-sky-900/60`}
          >▼ 下移</button>
        </span>
      </div>
      {both && (
        <div className="text-[11px] leading-snug text-slate-500">
          {info.up === info.down ? info.up : `上移：${info.up}；下移：${info.down}`}
        </div>
      )}
    </div>
  )
}
