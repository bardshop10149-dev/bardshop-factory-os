'use client'

import { useMemo, useState } from 'react'
import type { CalcSegment, SegmentKey } from '@/lib/quote/types'
import { fmtFixed, fmtInt, fmtYen } from '../_lib/format'
import { BTN_TEXT, FOCUS_RING, IconCaret } from './ui'

/**
 * 五段明細表（§12.6）：thead 單墨線、tfoot 雙線合計（會計帳簿），子列 .q-collapse 展開。
 *
 * 金額欄一律「¥／pcs」：主列取引擎 G 欄（每件含報廢）；子列＝該列總額 ÷ Q（每件未含報廢），
 * 最後一列「÷ Q × (1 + 報廢)」把子列接回主列，算式用真實數字。
 * 預設五段全部展開（Snow：工程模式要全部顯示成本），本次可收合、下次進來又是全開。
 * 降級：`lines` 缺或空 → 不渲染 caret、段名後綴「（無明細）」。
 */
const SEG_NAME: Record<SegmentKey, string> = {
  material: '材料',
  print: '印刷貼合清洗',
  cut: '切割',
  packLabor: '包裝人工',
  packMaterial: '包材配件',
}
const ALL_KEYS: SegmentKey[] = ['material', 'print', 'cut', 'packLabor', 'packMaterial']

function Amount({ value, flash, digits = 3, className = '' }: { value: number | null; flash?: number; digits?: number; className?: string }) {
  if (value === null || !(value > 0)) return <span className={`q-num text-(--q-ink-3) ${className}`}>—</span>
  return (
    <span key={flash} className={`q-num inline-block rounded-[2px] px-1 -mr-1 ${flash ? 'q-flash' : ''} ${className}`}>
      {fmtFixed(value, digits)}
    </span>
  )
}

export function BreakdownTable({
  segments,
  qty,
  costUnit,
  costRatio,
  quoteUnit,
  loading,
  stale,
  costRatioOverridden = false,
}: {
  segments: CalcSegment[] | null
  qty: number | null
  costUnit: number | null
  costRatio: number | null
  quoteUnit: number | null
  /** 尚無結果且計算中：每格「—」＋ 佔位脈動 */
  loading: boolean
  stale: boolean
  /** 成本率被本張試算的毛利率欄覆寫（不是品項預設） */
  costRatioOverridden?: boolean
}) {
  const byKey = useMemo(() => {
    const m = new Map<SegmentKey, CalcSegment>()
    for (const s of segments ?? []) m.set(s.key, s)
    return m
  }, [segments])

  // 展開狀態：使用者沒動過（openState=null）就五段全開——工程模式的用途就是把成本全攤開看
  const [openState, setOpenState] = useState<Record<string, boolean> | null>(null)
  const defaultOpen = useMemo<Record<string, boolean>>(() => Object.fromEntries(ALL_KEYS.map((k) => [k, true])), [])
  const open = openState ?? defaultOpen

  const setOpenPersist = (next: Record<string, boolean>) => setOpenState(next)
  const toggle = (k: SegmentKey) => setOpenPersist({ ...open, [k]: !open[k] })
  const allOpen = ALL_KEYS.every((k) => open[k])
  const toggleAll = () => setOpenPersist(Object.fromEntries(ALL_KEYS.map((k) => [k, !allOpen])))

  // 只有金額真正變動的格子才閃（§12.8 動態 2）。用 React 官方「保存上一次 render 的值」寫法：
  // 把本次金額簽名存進 state，簽名變了就在 render 內 setState 記下變動的 key（不是 effect，不會多一輪）。
  // Amount 用 tick 當 React key 重新掛載 → 動畫重播；沒變動的格子 tick=0 不掛 .q-flash
  const amounts = useMemo(() => {
    const entries: [string, number][] = []
    for (const [k, s] of byKey) entries.push([k, s.perUnitWithScrap])
    if (costUnit !== null) entries.push(['__cost', costUnit])
    return entries
  }, [byKey, costUnit])
  const signature = JSON.stringify(amounts)
  const [prevSignature, setPrevSignature] = useState(signature)
  const [flash, setFlash] = useState<{ keys: Set<string>; tick: number }>({ keys: new Set(), tick: 0 })
  if (signature !== prevSignature) {
    const before = new Map<string, number>(JSON.parse(prevSignature) as [string, number][])
    const changed = new Set<string>()
    for (const [k, v] of amounts) {
      const b = before.get(k)
      if (b !== undefined && Math.abs(b - v) > 1e-9) changed.add(k)
    }
    setPrevSignature(signature)
    if (changed.size) setFlash({ keys: changed, tick: flash.tick + 1 })
  }
  const tick = (k: string) => (flash.keys.has(k) ? flash.tick : 0)

  const rows = ALL_KEYS.map((key) => ({ key, seg: byKey.get(key) ?? null }))

  return (
    <div className={`${stale ? 'opacity-70' : ''} transition-opacity duration-(--q-dur)`}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-[12px] leading-4 font-medium tracking-[0.04em] text-(--q-ink-2)">成本明細</h3>
        <button type="button" onClick={toggleAll} className={`${BTN_TEXT} text-[11px] leading-4 text-(--q-ink-2)`} disabled={!segments}>
          {allOpen ? '全部收合' : '全部展開'}
        </button>
      </div>
      <table className="mt-2 w-full text-[13px] leading-5">
        <thead className="border-b border-(--q-ink)">
          <tr className="text-[11px] leading-4 tracking-[0.04em] text-(--q-ink-2)">
            <th scope="col" className="py-1.5 text-left font-medium">
              項目
            </th>
            <th scope="col" className="q-num py-1.5 text-right font-medium">
              金額 ¥／pcs
            </th>
          </tr>
        </thead>
        {rows.map(({ key, seg }) => {
          const hasLines = !!seg && Array.isArray(seg.lines) && seg.lines.length > 0
          const isOpen = !!open[key] && hasLines
          const panelId = `q-seg-${key}`
          const scrapMul = seg && seg.perUnit > 0 ? seg.perUnitWithScrap / seg.perUnit : null
          return (
            <tbody key={key}>
              <tr className="border-b border-(--q-line)">
                <td className="py-2 pr-2">
                  {hasLines ? (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      onClick={() => toggle(key)}
                      className={`flex items-center gap-2 rounded-[2px] text-(--q-ink) ${FOCUS_RING}`}
                    >
                      <span className="text-(--q-ink-3)">
                        <IconCaret open={isOpen} />
                      </span>
                      {SEG_NAME[key]}
                    </button>
                  ) : (
                    <span className="flex items-center gap-2 text-(--q-ink)">
                      <span className="inline-block size-3" aria-hidden="true" />
                      {SEG_NAME[key]}
                      {seg && <span className="text-[11px] text-(--q-ink-3)">（無明細）</span>}
                    </span>
                  )}
                </td>
                <td className="py-2 text-right">
                  {loading && !seg ? (
                    <span className="inline-block h-4 w-14 animate-pulse rounded-[2px] bg-(--q-paper-2)" aria-label="計算中" />
                  ) : (
                    <Amount value={seg ? seg.perUnitWithScrap : null} flash={tick(key)} />
                  )}
                </td>
              </tr>
              {hasLines && seg && (
                <tr>
                  <td colSpan={2} className="p-0">
                    <div id={panelId} className="q-collapse" data-open={isOpen ? 'true' : 'false'}>
                      <div>
                        <div className="bg-(--q-paper-2)/60 text-[12px] leading-4 text-(--q-ink-2)">
                          {seg.lines.map((ln, i) => (
                            <div key={`${ln.name}-${i}`} className="grid grid-cols-[1fr_auto_88px] items-baseline gap-3 py-1.5 pl-7 pr-1">
                              <span className="truncate" title={ln.name}>
                                {ln.name}
                              </span>
                              <span className="q-num max-w-[220px] truncate text-right text-[11px] text-(--q-ink-3)" title={ln.formula}>
                                {ln.formula}
                              </span>
                              <span className="q-num text-right">{qty && qty > 0 && ln.amount ? fmtFixed(ln.amount / qty, 3) : '—'}</span>
                            </div>
                          ))}
                          {qty && qty > 0 && scrapMul !== null && (
                            <div className="grid grid-cols-[1fr_auto_88px] items-baseline gap-3 border-t border-(--q-line) py-1.5 pl-7 pr-1">
                              <span>段小計含報廢</span>
                              <span className="q-num text-right text-[11px] text-(--q-ink-3)">
                                {fmtYen(seg.amount, 2)} ÷ {fmtInt(qty)} pcs × {fmtFixed(scrapMul, 2)} 報廢
                              </span>
                              <span className="q-num text-right">{fmtFixed(seg.perUnitWithScrap, 3)}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          )
        })}
        <tfoot>
          <tr className="border-t border-(--q-ink) border-b-[3px] border-double border-b-(--q-ink) font-medium">
            <td className="py-2">成本單價</td>
            <td className="py-2 text-right">
              {loading && costUnit === null ? (
                <span className="inline-block h-4 w-16 animate-pulse rounded-[2px] bg-(--q-paper-2)" aria-label="計算中" />
              ) : (
                <Amount value={costUnit} flash={tick('__cost')} digits={2} />
              )}
            </td>
          </tr>
        </tfoot>
      </table>
      {costUnit !== null && costRatio !== null && quoteUnit !== null && costUnit > 0 && (
        <p className="q-num mt-2 text-[12px] leading-4 text-(--q-ink-2)">
          成本率 {fmtFixed(costRatio, 2)}（{costRatioOverridden ? '本張毛利率覆寫' : '依品項預設'}，成本 {fmtYen(costUnit)} → 報價 {fmtYen(quoteUnit)}）
        </p>
      )}
      <p className="mt-1.5 text-[11px] leading-4 text-(--q-ink-3)">明細取 3 位小數，合計取 2 位；盤數無條件進位</p>
    </div>
  )
}
