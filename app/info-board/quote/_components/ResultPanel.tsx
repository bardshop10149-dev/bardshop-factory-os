'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { CalcSizeResult, FxInfo, QuoteMode } from '@/lib/quote/api'
import { fmtInt, fmtTime, fmtNt, splitMoney } from '../_lib/format'
import type { OverrideState, RetiredOverride } from '../_lib/model'
import { parseInteger } from '../_lib/normalize'
import { BreakdownTable } from './BreakdownTable'
import { QuoteSummary, type CopyState } from './QuoteSummary'
import { StatusLine, type StatusInfo } from './StatusLine'
import { BTN_TEXT } from './ui'

/**
 * 結果面板（§12.7）：sticky、三固定分區——
 *   A 頁首（不捲）：標題、摘要句、狀態列、報價大數字、每盤／盤數
 *   B 中段（可捲）：五段明細、成本率
 *   C 頁尾（不捲）：主鈕、摘要
 * 大數字釘在頁首，五段全展開時大數字與主鈕都不會被捲走。
 */
export interface OverrideView {
  state: 'auto' | 'overridden' | 'invalid'
  override: OverrideState | null
  retired: RetiredOverride | null
  /** 退役瞬間 +1，讓每盤列閃一次 */
  flashTick: number
  /** 覆寫值 > 自動值（warn）；> 1.5 倍（seal，主鈕停用） */
  high: 'none' | 'warn' | 'seal'
}

export interface ResultPanelProps {
  /** 伺服器實際採用的模式；非 engineer 時 size 裡根本沒有成本欄位，面板只畫報價 */
  mode: QuoteMode
  /** 成本率被毛利率欄覆寫（明細註腳用） */
  costRatioOverridden?: boolean
  today: string
  summaryLine: string
  status: StatusInfo
  size: CalcSizeResult | null
  qty: number | null
  /** 無法計算的原因（顯示在第三行；null＝可以計算） */
  blockReason: string | null
  fx: FxInfo | null
  rateVersion: string | null
  stale: boolean
  lastCalcAt: Date | null
  slow: boolean
  pending: boolean
  showTwd: boolean
  onToggleTwd: () => void
  override: OverrideView
  onOverrideCommit: (value: number) => void
  onOverrideReset: () => void
  onOverrideReapply: () => void
  mainButton: { text: string; disabled: boolean; busy: boolean }
  onGenerate: () => void
  /** 產生報價失敗的訊息（留在主鈕下方，不用 toast） */
  logError: string | null
  log: { quoteNo: string; createdAt: Date; text: string } | null
  copyState: CopyState
  onCopy: (selectFallback: () => void) => void
}

function PerSheetValue({ value, flashTick }: { value: number; flashTick: number }) {
  return (
    <span key={flashTick} className={`q-num inline-block rounded-[2px] px-1 -mr-1 text-[15px] leading-[22px] ${flashTick ? 'q-flash' : ''}`}>
      {fmtInt(value)}
    </span>
  )
}

export function ResultPanel(p: ResultPanelProps) {
  const size = p.size
  const eng = p.mode === 'engineer'
  // 用 quoteUnit 判斷而不是 nPerSheetUsed：業務模式沒有每盤欄位，但無法拼板時引擎一樣回 quoteUnit 0
  const canQuote = !!size && p.blockReason === null && size.quoteUnit > 0
  const money = canQuote ? splitMoney(size!.quoteUnit) : null
  // 報價變動才閃一次（§12.8）：「保存上一次 render 的值」寫法，在 render 內比對，不用 effect
  const quoteNow = canQuote ? size!.quoteUnit : null
  const [prevQuote, setPrevQuote] = useState<number | null>(quoteNow)
  const [flashKey, setFlashKey] = useState(0)
  if (quoteNow !== prevQuote) {
    setPrevQuote(quoteNow)
    if (quoteNow !== null && prevQuote !== null && Math.abs(quoteNow - prevQuote) > 1e-9) setFlashKey(flashKey + 1)
  }

  /* 每盤覆寫：編輯狀態放這裡，值的生命週期在 page */
  const auto = size?.nPerSheetAuto ?? 0
  const used = p.override.override ? p.override.override.value : auto
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  // Esc 取消／Enter 確認後 input 卸載，Chrome 會對仍有焦點的元素再發一次 blur → onBlur={commitEdit}
  // 會把取消掉的 draft 又寫進覆寫。用 ref 標記「這輪已經結束」，後到的 blur 直接略過。
  const editDoneRef = useRef(false)
  useEffect(() => {
    if (editing) {
      editDoneRef.current = false
      editRef.current?.focus()
      editRef.current?.select()
    }
  }, [editing])
  const startEdit = () => {
    setDraft(String(used > 0 ? used : ''))
    setEditing(true)
  }
  const commitEdit = () => {
    if (editDoneRef.current) return
    editDoneRef.current = true
    setEditing(false)
    const n = parseInteger(draft)
    if (n === null || n < 1) return
    p.onOverrideCommit(n)
  }
  const cancelEdit = () => {
    editDoneRef.current = true
    setEditing(false)
  }
  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  const sheets = p.qty && used > 0 ? Math.ceil(p.qty / used) : null
  const nest = size?.nest ?? null
  const isOverridden = p.override.state === 'overridden'
  const retiredRecent = !!p.override.retired?.recent
  const twdEnabled = !!p.fx

  return (
    <aside
      id="q-panel"
      aria-label="報價單"
      className={`flex max-h-[calc(100dvh-3rem)] flex-col rounded-(--q-radius-lg) border border-(--q-line) border-t-(length:--q-rule-2) border-t-(--q-ink) bg-(--q-paper-2) lg:sticky lg:top-(--q-panel-top) lg:self-start ${
        p.slow ? 'q-progress' : ''
      }`}
    >
      {/* A 頁首（不捲） */}
      <div className="shrink-0 px-6 pt-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-(family-name:--q-font-serif) text-[20px] leading-7 font-semibold text-(--q-ink)">
            報價單
            <span className="ml-2 font-(family-name:--q-font-sans) text-[11px] leading-4 font-normal tracking-[0.14em] text-(--q-ink-3)">QUOTATION</span>
          </h2>
          <span className="q-num text-[12px] leading-4 text-(--q-ink-2)">{p.today}</span>
        </div>
        <p className="q-num mt-1.5 text-[13px] leading-5 text-(--q-ink-2)">{p.summaryLine}</p>
        <StatusLine status={p.status} />

        <div className="mt-4 border-t border-(--q-ink) pt-4">
          <div className="flex items-center justify-between">
            <span className="text-[12px] leading-4 tracking-[0.08em] text-(--q-ink-2)">報價</span>
            <button
              type="button"
              role="switch"
              aria-checked={p.showTwd && twdEnabled}
              aria-disabled={!twdEnabled || undefined}
              onClick={() => twdEnabled && p.onToggleTwd()}
              title={twdEnabled ? undefined : '匯率未設定'}
              className={`${BTN_TEXT} text-[12px] leading-4 ${twdEnabled ? 'text-(--q-accent)' : 'cursor-not-allowed text-(--q-disabled) no-underline'}`}
            >
              {twdEnabled ? (p.showTwd ? '隱藏 TWD' : '顯示 TWD') : '匯率未設定'}
            </button>
          </div>
          <div className={`mt-1 flex items-baseline gap-1.5 ${p.stale ? 'opacity-70' : ''}`} aria-live="polite" aria-atomic="true">
            <span className="text-[14px] leading-[22px] text-(--q-ink-2)">RMB</span>
            {money ? (
              <span key={flashKey} className={`inline-flex items-baseline rounded-[2px] ${flashKey ? 'q-flash' : ''}`}>
                <span className="q-num text-[40px] leading-[44px] font-semibold tracking-[-0.02em] text-(--q-ink) max-lg:text-[32px] max-lg:leading-[36px]">{money.int}</span>
                <span className="q-num text-[24px] leading-7 font-medium text-(--q-ink-2)">{money.dec}</span>
              </span>
            ) : (
              <span className="q-num text-[40px] leading-[44px] font-semibold text-(--q-ink-3) max-lg:text-[32px] max-lg:leading-[36px]" aria-label="尚無報價">
                —
              </span>
            )}
          </div>
          <p className="q-num mt-1 text-[13px] leading-5 text-(--q-ink-2)">
            {canQuote && p.qty ? (
              <>
                本單合計 ¥ {fmtInt(size!.quoteUnit * p.qty)} · {fmtInt(p.qty)} pcs
                {eng && size!.marginPct != null ? ` · 毛利 ${Math.round(size!.marginPct)}%` : ''}
              </>
            ) : (
              <span className="text-(--q-ink-3)">{p.blockReason ?? '填妥品項、尺寸、數量與板材後即時計算'}</span>
            )}
          </p>
          {p.showTwd && twdEnabled && (
            <p className="q-num mt-1 text-[16px] leading-6 text-(--q-ink)">
              {canQuote && size!.twdUnit !== null ? `≈ ${fmtNt(size!.twdUnit)}` : '≈ NT$ —'}
              <span className="ml-2 text-[12px] leading-4 text-(--q-ink-3)">
                匯率 {p.fx!.rate} · {p.fx!.asOf}
              </span>
            </p>
          )}
          {p.stale && p.lastCalcAt && (
            <p className="q-num mt-1 text-[12px] leading-4 text-(--q-warn)">※ 上次計算 {fmtTime(p.lastCalcAt)}，目前顯示為上次結果</p>
          )}
        </div>

        {/* 每盤數量列（工程模式才有：業務不需要知道拼板，也不給覆寫） */}
        {eng && (
        <>
        <div className={`mt-3 border-b border-(--q-line) py-2.5 transition-colors duration-(--q-dur-fast) ${isOverridden ? 'bg-(--q-seal-soft) -mx-2 px-2 rounded-(--q-radius)' : ''}`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] leading-5 text-(--q-ink-2)">每盤數量</span>
            <span className="flex items-baseline gap-2">
              {editing ? (
                <input
                  ref={editRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  aria-label="覆寫每盤數量"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={onEditKey}
                  className="q-num w-[72px] border-0 border-b border-(--q-ink) bg-transparent text-right text-[15px] leading-[22px] text-(--q-ink) outline-none"
                />
              ) : size && auto === 0 && p.qty ? (
                <span className="q-num text-[15px] leading-[22px] text-(--q-seal)">0</span>
              ) : size ? (
                <PerSheetValue value={used} flashTick={p.override.flashTick} />
              ) : (
                <span className="q-num text-[15px] leading-[22px] text-(--q-ink-3)">—</span>
              )}
              {isOverridden && (
                <span className="q-stamp rounded-[2px] border-[1.5px] border-(--q-seal) px-1.5 py-px text-[11px] leading-4 font-medium tracking-[0.1em] text-(--q-seal)">已覆寫</span>
              )}
              {!isOverridden && !editing && nest && auto > 0 && (
                <span className="q-num text-[11px] leading-4 text-(--q-ink-3)">
                  （{nest.cols} × {nest.rows}，{nest.rotated ? '旋轉' : '橫向'}）
                </span>
              )}
              {size && auto > 0 && !editing && (
                <button type="button" onClick={startEdit} className={`${BTN_TEXT} text-[12px] leading-4 text-(--q-ink-2)`}>
                  覆寫
                </button>
              )}
            </span>
          </div>
          {isOverridden && (
            <p className="q-num mt-1 flex flex-wrap items-baseline gap-x-2 text-[11px] leading-4 text-(--q-ink-3)">
              <span>自動計算 {fmtInt(auto)}</span>
              <span>·</span>
              <button type="button" onClick={p.onOverrideReset} className={`${BTN_TEXT} text-(--q-ink-2)`}>
                還原
              </button>
              {p.override.high === 'warn' && <span className="text-(--q-warn)">※ 高於自動值，請確認排版可行</span>}
              {p.override.high === 'seal' && <span className="text-(--q-seal)">※ 每盤數量超過拼板上限</span>}
            </p>
          )}
          {!isOverridden && p.override.retired && (
            <p className="q-num mt-1 flex flex-wrap items-baseline gap-x-2 text-[11px] leading-4 text-(--q-ink-3)">
              {retiredRecent ? (
                <span>已依新板材重算</span>
              ) : (
                <>
                  <span>上次手動 {fmtInt(p.override.retired.value)}</span>
                  <span>·</span>
                  <button type="button" onClick={p.onOverrideReapply} className={`${BTN_TEXT} text-(--q-ink-2)`}>
                    套回
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        {/* 盤數列 */}
        <div className="flex items-baseline justify-between py-2.5">
          <span className="text-[13px] leading-5 text-(--q-ink-2)">盤數</span>
          <span className="flex items-baseline gap-2">
            <span className={`q-num text-[15px] leading-[22px] ${sheets ? 'text-(--q-ink)' : 'text-(--q-ink-3)'}`}>{sheets ? fmtInt(sheets) : '—'}</span>
            {sheets && p.qty && (
              <span className="q-num text-[11px] leading-4 text-(--q-ink-3)">
                （{fmtInt(p.qty)} ÷ {fmtInt(used)}）
              </span>
            )}
          </span>
        </div>
        {sheets === 1 && p.qty && used > p.qty && (
          <p className="text-[12px] leading-4 text-(--q-warn)">※ 不足一盤，仍以 1 盤計價</p>
        )}
        </>
        )}
      </div>

      {/* B 中段（可捲）：成本明細只在工程模式；業務模式伺服器沒回 segments，這裡也不留空表 */}
      <div className={`q-scroll flex-1 overflow-y-auto border-t border-(--q-line) px-6 py-4 ${eng ? 'min-h-[160px]' : ''}`}>
        {eng ? (
          <BreakdownTable
            segments={size?.segments?.length ? size.segments : null}
            qty={p.qty}
            costUnit={canQuote ? (size!.costUnit ?? null) : null}
            costRatio={canQuote ? (size!.costRatio ?? null) : null}
            quoteUnit={canQuote ? size!.quoteUnit : null}
            loading={p.pending && !size}
            stale={p.stale}
            costRatioOverridden={p.costRatioOverridden}
          />
        ) : (
          <p className="text-[12px] leading-4 text-(--q-ink-3)">※ 包裝與工序已依品項預設計入</p>
        )}
        {size && size.warnings.length > 0 && (
          <ul className="mt-3 space-y-1 text-[12px] leading-4 text-(--q-warn)">
            {size.warnings.map((w) => (
              <li key={w}>※ {w}</li>
            ))}
          </ul>
        )}
      </div>

      {/* C 頁尾（不捲） */}
      <div className="shrink-0 border-t border-(--q-line) px-6 pb-5 pt-4">
        <button
          type="button"
          onClick={p.onGenerate}
          aria-disabled={p.mainButton.disabled || undefined}
          aria-busy={p.mainButton.busy || undefined}
          className={`flex h-11 w-full items-center justify-between rounded-(--q-radius) px-4 text-[15px] leading-[22px] font-medium tracking-[0.04em] transition-colors duration-(--q-dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--q-accent)/40 ${
            p.mainButton.disabled
              ? 'cursor-not-allowed bg-(--q-disabled) text-(--q-paper)'
              : 'bg-(--q-ink) text-(--q-paper) hover:bg-black active:translate-y-px'
          }`}
        >
          <span className="flex items-center gap-2">
            {p.mainButton.busy && (
              <svg className="size-4 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M8 2a6 6 0 1 1-4.24 1.76" strokeLinecap="round" />
              </svg>
            )}
            {p.mainButton.text}
          </span>
          {!p.mainButton.disabled && <span className="q-num text-[11px] leading-4 opacity-60">Ctrl + Enter</span>}
        </button>
        {p.logError && <p className="mt-2 text-[12px] leading-4 text-(--q-seal)">※ {p.logError}</p>}
        {p.log && <QuoteSummary quoteNo={p.log.quoteNo} createdAt={p.log.createdAt} text={p.log.text} copyState={p.copyState} onCopy={p.onCopy} />}
      </div>
    </aside>
  )
}
