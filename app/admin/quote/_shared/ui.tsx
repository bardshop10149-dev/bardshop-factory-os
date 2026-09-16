'use client'

/**
 * 報價系統後台共用小元件。走 EIP 後台既有的深色 slate 風格（同 /admin/team），
 * 本區主題色用 amber（menuItems 的「報價系統」group theme）。
 * 不用前台的紙墨設計——那是給業務看的。
 */
import type { ReactNode } from 'react'
import Link from 'next/link'
import { NOT_READY_MSG } from './api'

export const INPUT_CLS =
  'w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white focus:border-amber-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed'
export const INPUT_SM_CLS =
  'bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white focus:border-amber-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed'
export const TH_CLS = 'text-left text-[11px] uppercase tracking-wider text-slate-500 font-bold px-2 py-2 border-b border-slate-700 whitespace-nowrap'
export const TD_CLS = 'px-2 py-1.5 border-b border-slate-800 align-middle text-sm'
export const MONO = 'font-mono tabular-nums'

/* ---------------------------------------------------------------- 頁首 */

const SUB_NAV: { href: string; label: string }[] = [
  { href: '/admin/quote/products', label: '品項維護' },
  { href: '/admin/quote/prices', label: '材料價格表' },
  { href: '/admin/quote/settings', label: '全域參數' },
  { href: '/admin/quote/import', label: 'Excel 匯入' },
]

export function PageHeader({ title, subtitle, current, actions }: { title: string; subtitle: string; current: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col md:flex-row justify-between md:items-end mb-6 gap-4">
      <div>
        <h1 className="text-xl md:text-3xl font-bold text-white tracking-tight">{title}</h1>
        <p className="text-amber-500/80 mt-1 font-mono text-sm uppercase">QUOTE SYSTEM // {subtitle}</p>
        <div className="flex flex-wrap gap-2 mt-3">
          {SUB_NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`px-3 py-1 rounded border text-xs font-bold transition-colors ${
                n.href === current
                  ? 'bg-amber-950/60 border-amber-500/70 text-amber-300'
                  : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              {n.label}
            </Link>
          ))}
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-2 items-center">{actions}</div>}
    </div>
  )
}

/* ---------------------------------------------------------------- 訊息 */

export function Notice({ kind, children }: { kind: 'error' | 'warn' | 'info' | 'ok'; children: ReactNode }) {
  const cls = {
    error: 'bg-red-950/40 border-red-800 text-red-300',
    warn: 'bg-yellow-950/40 border-yellow-700 text-yellow-300',
    info: 'bg-sky-950/40 border-sky-800 text-sky-300',
    ok: 'bg-emerald-950/40 border-emerald-800 text-emerald-300',
  }[kind]
  return <div className={`border rounded px-4 py-3 text-sm mb-4 whitespace-pre-wrap ${cls}`}>{children}</div>
}

export function NotReadyBanner({ message }: { message?: string }) {
  return (
    <Notice kind="warn">
      <div className="font-bold mb-1">資料表尚未建立</div>
      <div>{message || NOT_READY_MSG}</div>
      <div className="mt-1 text-xs text-yellow-200/70">執行後重新整理本頁即可。動 schema 前請先手動備份（設計書 §11）。</div>
    </Notice>
  )
}

export function LoadingBlock({ text = '載入中…' }: { text?: string }) {
  return <div className="text-center py-16 text-slate-500 animate-pulse">{text}</div>
}

/* ---------------------------------------------------------------- 徽章 */

const BADGE: Record<string, { cls: string; label: string }> = {
  draft: { cls: 'bg-slate-800 text-slate-300 border-slate-600', label: '草稿' },
  testing: { cls: 'bg-yellow-900/40 text-yellow-300 border-yellow-700', label: '測試中' },
  published: { cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700', label: '已發布' },
  proposed: { cls: 'bg-sky-900/40 text-sky-300 border-sky-700', label: '待核可' },
  approved: { cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700', label: '已核可' },
  rejected: { cls: 'bg-red-900/40 text-red-300 border-red-800', label: '已退回' },
  pass: { cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700', label: 'PASS' },
  fail: { cls: 'bg-red-900/40 text-red-300 border-red-800', label: 'FAIL' },
  'no-approved-cases': { cls: 'bg-slate-800 text-slate-400 border-slate-600', label: '無已核可案例' },
}

export function Badge({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return <span className="text-slate-600 text-xs">—</span>
  const b = BADGE[value] ?? { cls: 'bg-slate-800 text-slate-300 border-slate-600', label: value }
  return <span className={`inline-block px-2 py-0.5 rounded border text-[11px] font-bold whitespace-nowrap ${b.cls}`}>{label ?? b.label}</span>
}

/* ---------------------------------------------------------------- 區塊與欄位 */

export function Section({ title, desc, actions, children }: { title: string; desc?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-slate-900/50 border border-slate-700 rounded-xl p-4 md:p-5 mb-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 border-b border-slate-700 pb-2 mb-4">
        <div>
          <h2 className="text-sm font-bold text-amber-500 uppercase tracking-wider">{title}</h2>
          {desc && <div className="text-xs text-slate-500 mt-1">{desc}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2 shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="block text-xs text-slate-400 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500 mt-1">{hint}</span>}
    </label>
  )
}

export function NumInput({
  value, onChange, step = 'any', min, disabled, className, placeholder,
}: {
  value: number | null | undefined
  onChange: (v: number) => void
  step?: number | 'any'
  min?: number
  disabled?: boolean
  className?: string
  placeholder?: string
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      disabled={disabled}
      placeholder={placeholder}
      className={`${className ?? INPUT_CLS} ${MONO}`}
      value={value == null || !Number.isFinite(value) ? '' : value}
      onChange={(e) => {
        const raw = e.target.value
        onChange(raw === '' ? NaN : Number(raw))
      }}
    />
  )
}

export function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={`inline-flex items-center gap-2 text-sm select-none ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="w-4 h-4 rounded border-slate-600 bg-slate-900 accent-amber-500"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={checked ? 'text-white' : 'text-slate-400'}>{label}</span>
    </label>
  )
}

/* ---------------------------------------------------------------- 按鈕 */

type BtnVariant = 'primary' | 'ghost' | 'danger' | 'ok' | 'link'

export function Btn({
  variant = 'ghost', size = 'md', className, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' }) {
  const base = 'rounded border font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'
  const sz = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-4 py-2 text-sm'
  const v = {
    primary: 'bg-amber-600 hover:bg-amber-500 border-amber-500 text-white',
    ghost: 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-slate-300',
    danger: 'bg-red-900/40 hover:bg-red-900/70 border-red-700 text-red-300',
    ok: 'bg-emerald-900/40 hover:bg-emerald-900/70 border-emerald-600 text-emerald-300',
    link: 'bg-transparent border-transparent text-amber-400 hover:text-amber-300 px-1',
  }[variant]
  return <button type="button" className={`${base} ${sz} ${v} ${className ?? ''}`} {...rest} />
}

/* ---------------------------------------------------------------- JSON 檢視 */

export function JsonView({ value, maxHeight = '24rem' }: { value: unknown; maxHeight?: string }) {
  let text = ''
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return (
    <pre
      className="bg-black/40 border border-slate-800 rounded p-3 text-[12px] text-slate-300 font-mono overflow-auto whitespace-pre"
      style={{ maxHeight }}
    >
      {text}
    </pre>
  )
}

/* ---------------------------------------------------------------- 儲存列 */

export function SaveBar({
  dirty, saving, onSave, onReset, extra,
}: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void; extra?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-20 mt-4 -mx-4 md:-mx-6 lg:-mx-8 px-4 md:px-6 lg:px-8 py-3 bg-[#0b1120]/95 backdrop-blur border-t border-slate-700 flex flex-wrap items-center gap-3">
      <span className={`text-xs ${dirty ? 'text-yellow-300' : 'text-slate-500'}`}>{dirty ? '● 有未儲存的變更' : '○ 沒有變更'}</span>
      <div className="flex-1" />
      {extra}
      <Btn variant="ghost" onClick={onReset} disabled={!dirty || saving}>還原</Btn>
      <Btn variant="primary" onClick={onSave} disabled={!dirty || saving}>{saving ? '儲存中…' : '儲存變更'}</Btn>
    </div>
  )
}
