'use client'

import { BTN_TEXT } from './ui'

/**
 * 狀態列（§12.6 狀態提示）：role=status aria-live=polite；圓點＋固定符號（● 完成、○ 計算中、▲ 錯誤），
 * 顏色＋符號＋文字三者並存，不靠顏色單獨傳達。缺項是可點連結：點了 scroll＋focus。
 */
export type StatusKind = 'idle' | 'calc' | 'ok' | 'missing' | 'error'

export interface StatusInfo {
  kind: StatusKind
  text: string
  missing?: { label: string; onClick: () => void }[]
}

const SYMBOL: Record<StatusKind, string> = { idle: '○', calc: '○', ok: '●', missing: '▲', error: '▲' }
const COLOR: Record<StatusKind, string> = {
  idle: 'text-(--q-ink-3)',
  calc: 'text-(--q-ink-2)',
  ok: 'text-(--q-accent)',
  missing: 'text-(--q-seal)',
  error: 'text-(--q-seal)',
}

export function StatusLine({ status }: { status: StatusInfo }) {
  return (
    <div role="status" aria-live="polite" className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] leading-4 text-(--q-ink-2)">
      <span aria-hidden="true" className={`${COLOR[status.kind]}`}>
        {SYMBOL[status.kind]}
      </span>
      <span className={status.kind === 'missing' || status.kind === 'error' ? 'text-(--q-seal)' : ''}>{status.text}</span>
      {status.missing?.map((m, i) => (
        <span key={m.label} className="text-(--q-seal)">
          {i > 0 && '、'}
          <button type="button" onClick={m.onClick} className={`${BTN_TEXT} decoration-(--q-seal)/50`}>
            {m.label}
          </button>
        </span>
      ))}
    </div>
  )
}
