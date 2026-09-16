'use client'

import type { ReactNode } from 'react'

/**
 * 小型共用件：16px 線條 SVG 圖示（不引入 icon library）、「※」訊息、橫幅、區段標題、select 樣式。
 * 全部零陰影、零漸層、圓角 ≤ 4px（設計書 §12.11）。
 */

/* ---------------------------------------------------------------- 圖示：16px、1.5px 線條、currentColor */

export function IconCheck({ className = 'size-3' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  )
}

export function IconCaret({ open, className = 'size-3' }: { open: boolean; className?: string }) {
  return (
    <svg
      className={`${className} transition-transform duration-(--q-dur) ease-(--q-ease) ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  )
}

export function IconX({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

export function IconChevronDown({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

/* ---------------------------------------------------------------- 樣式常數 */

export const SELECT_CLASS =
  'h-(--q-control-h) w-full appearance-none rounded-(--q-radius) border border-(--q-line) bg-(--q-card) px-3 pr-9 text-[14px] leading-[22px] text-(--q-ink) ' +
  'transition-[border-color] duration-(--q-dur-fast) hover:border-(--q-ink-2) focus:border-(--q-ink) focus:outline-none focus:ring-2 focus:ring-(--q-accent)/25 ' +
  'disabled:cursor-not-allowed disabled:text-(--q-disabled) disabled:hover:border-(--q-line)'

export const LABEL_CLASS = 'mb-1.5 block text-[12px] leading-4 font-medium tracking-[0.04em] text-(--q-ink-2)'

export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--q-accent)/25'

/** 次要鈕：墨線框、hover 反白 */
export const BTN_SECONDARY =
  `inline-flex h-8 items-center rounded-(--q-radius) border border-(--q-ink) px-3 text-[13px] leading-5 font-medium text-(--q-ink) transition-colors duration-(--q-dur-fast) hover:bg-(--q-ink) hover:text-(--q-paper) ${FOCUS_RING}`

/** 文字鈕：底線 */
export const BTN_TEXT = `rounded-[2px] underline underline-offset-2 decoration-(--q-line) hover:decoration-(--q-ink) ${FOCUS_RING}`

/* ---------------------------------------------------------------- 訊息 */

/** 欄位下的「※」訊息：tone 決定顏色，訊息本身不加驚嘆號 */
export function Msg({ tone, id, children }: { tone: 'seal' | 'warn' | 'ink'; id?: string; children: ReactNode }) {
  const color = tone === 'seal' ? 'text-(--q-seal)' : tone === 'warn' ? 'text-(--q-warn)' : 'text-(--q-ink-3)'
  return (
    <p id={id} className={`mt-1.5 text-[12px] leading-4 ${color}`}>
      ※ {children}
    </p>
  )
}

/** 橫幅：左 3px 粗線 + 淡底；tone=seal 用 role=alert */
export function Banner({ tone, children, action }: { tone: 'warn' | 'seal'; children: ReactNode; action?: ReactNode }) {
  const cls =
    tone === 'seal'
      ? 'border-(--q-seal) bg-(--q-seal-soft) text-(--q-seal)'
      : 'border-(--q-warn) bg-(--q-warn-soft) text-(--q-warn)'
  return (
    <div role={tone === 'seal' ? 'alert' : 'status'} className={`flex items-center justify-between gap-4 border-l-(length:--q-rule-2) ${cls} px-4 py-3 text-[13px] leading-5`}>
      <span>※ {children}</span>
      {action}
    </div>
  )
}

/* ---------------------------------------------------------------- 區段標題 */

export function SectionHeader({
  title,
  caption,
  summary,
  hasError,
}: {
  title: string
  /** 英文小標（未填時顯示） */
  caption: string
  /** 已填時換成即時摘要 */
  summary?: string | null
  hasError?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <h2 className="font-(family-name:--q-font-serif) text-[16px] leading-6 font-semibold text-(--q-ink)">{title}</h2>
      {summary ? (
        <span className="q-num flex items-center gap-1.5 text-[12px] leading-4 text-(--q-ink-2)">
          {hasError && <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-(--q-seal)" />}
          {summary}
        </span>
      ) : (
        <span className="text-[11px] leading-4 tracking-[0.14em] text-(--q-ink-3)">{caption}</span>
      )}
    </div>
  )
}

/** 原生 select 外框：右側 chevron 用 inline SVG */
export function SelectShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      {children}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-(--q-ink-2)">
        <IconChevronDown />
      </span>
    </div>
  )
}
