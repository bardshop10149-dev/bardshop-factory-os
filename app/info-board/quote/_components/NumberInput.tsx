'use client'

import { useId, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { LABEL_CLASS, Msg } from './ui'

/**
 * 數字欄（設計書 §12.6）：`type=text inputMode=decimal`，**不用 type=number**。
 *
 * 為什麼不用 type=number：Windows 注音 IME 打全形「５」時 type=number 會直接吞掉；
 * 而且 type=number 不能顯示千分位、滾輪會誤改值。改用 text，自己在
 * `compositionend` 與 `blur` 做正規化（normalize prop），composing 期間完全不動。
 */
export interface NumberInputProps {
  id?: string
  label?: string
  value: string
  onChange: (raw: string) => void
  /** 正規化：回傳要寫回欄位的字串（compositionend / blur 才呼叫） */
  normalize: (raw: string) => string
  /** 正規化後的額外處理（例如 W 欄貼「5x5」拆 W/H）；回 true 表示已接手，不再寫回 normalize 結果 */
  onCommit?: (raw: string) => boolean | void
  unit?: string
  placeholder?: string
  error?: string | null
  warning?: string | null
  hint?: string | null
  disabled?: boolean
  /** Enter 跳下一欄 */
  onEnter?: () => void
  inputRef?: Ref<HTMLInputElement>
  ariaLabel?: string
  className?: string
  /** 欄位內對齊，預設右對齊 */
  align?: 'right' | 'left'
  /** 只留紅框、不在欄位下方顯示訊息（窄欄位時由外層整列顯示，避免訊息把格子撐歪） */
  hideMessage?: boolean
}

export function NumberInput({
  id,
  label,
  value,
  onChange,
  normalize,
  onCommit,
  unit,
  placeholder,
  error,
  warning,
  hint,
  disabled,
  onEnter,
  inputRef,
  ariaLabel,
  className = '',
  align = 'right',
  hideMessage = false,
}: NumberInputProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const msgId = `${inputId}-msg`
  const composing = useRef(false)
  const [, force] = useState(0)

  const commit = (raw: string) => {
    if (composing.current) return
    if (onCommit && onCommit(raw) === true) return
    const next = normalize(raw)
    if (next !== raw) onChange(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      commit(e.currentTarget.value)
      onEnter?.()
    }
  }

  const hasError = !!error
  const frame = hasError
    ? 'border-(--q-seal) ring-2 ring-(--q-seal)/20'
    : warning
      ? 'border-(--q-warn) focus-within:border-(--q-ink)'
      : 'border-(--q-line) hover:border-(--q-ink-2) focus-within:border-(--q-ink)'

  const message = error ?? warning ?? hint ?? null
  const tone: 'seal' | 'warn' | 'ink' = error ? 'seal' : warning ? 'warn' : 'ink'

  return (
    <div className={className}>
      {label && (
        <label htmlFor={inputId} className={LABEL_CLASS}>
          {label}
        </label>
      )}
      <div
        className={`flex h-(--q-control-h) items-stretch rounded-(--q-radius) border bg-(--q-card) transition-[border-color] duration-(--q-dur-fast) focus-within:ring-2 focus-within:ring-(--q-accent)/25 ${frame} ${
          disabled ? 'opacity-60' : ''
        }`}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={hasError || undefined}
          aria-describedby={message ? msgId : undefined}
          onChange={(e) => onChange(e.target.value)}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={(e) => {
            composing.current = false
            force((n) => n + 1)
            commit(e.currentTarget.value)
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          className={`q-num min-w-0 flex-1 bg-transparent px-3 text-[15px] leading-[22px] text-(--q-ink) outline-none placeholder:text-(--q-ink-3) disabled:cursor-not-allowed ${
            align === 'right' ? 'text-right' : 'text-left'
          }`}
        />
        {unit && (
          <span className="flex items-center border-l border-(--q-line) px-2.5 text-[12px] leading-4 text-(--q-ink-3)">{unit}</span>
        )}
      </div>
      {message && !hideMessage && (
        <Msg tone={tone} id={msgId}>
          {message}
        </Msg>
      )}
    </div>
  )
}
