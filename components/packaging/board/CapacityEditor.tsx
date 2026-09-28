'use client'

// D49 每日產能：欄頭 ⚙（單日）與「產能表」（今天起 20 個工作日＋其間所有週六、週日）共用。
// 分線輪（D67／D71，lines.md §5.3）：產能改為「一天 × 一條線」填寫——
// - 產能表每個日期一列；欄＝各啟用線的「正常／加班」兩格，加上唯讀的合計（D71：總時數＝各線加總，即時算）。
// - 單日模式（日檢視線頭的 ⚙）：同一天的精簡版，一條線一列；mode.lineId＝從哪條線的 ⚙ 打開，該線自動聚焦。
// - D65：組長直接填總時數（小時）；沒有人數欄。
// - 平日：正常時數（至 19:00）、加班時數（19:00 後的上限）。沒填的線沿用「該線」日期上最近的較早平日值（D49 各線各自沿用，灰字）。
// - 週六、週日（D63）：一天一個「開加班」開關＋各線只有加班格；國定假日的週末不能開。關閉還有卡的週末會被伺服器擋下（weekend_has_cards）。
// - 「清除」：整天清除＝刪當天全部設定（回到沿用／不開加班）；線格旁的 ↺＝只清這條線這天（回到該線沿用）。
// - D64 批次填寫：選「全部線」或某一條線，填正常／加班 →「套用到全部平日」→ 表內標出將改變的格子（預覽）→ 確認 → 一次 PUT。週末不套用。
// - 「線別管理」→ LinesManager（新增、改名、停用、排序）；有未儲存的修改時先停用，避免欄位變動洗掉輸入。
// 產能與線別是事實輸入／設定，不進 Undo（D33）。資料一律經 /api/packaging/capacity、/lines；寫入要持有編輯鎖（D53）。
// 表單的換算、檢查、批次填寫規則在 lib/packaging/capacityForm.ts（純函式，有單元測試）。

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { EffectiveCapacity, PackagingLine, YMD } from '@/lib/packaging/scheduleTypes'
import {
  applyBulkFill,
  bulkFillRowsError,
  bulkFillSummary,
  formRowError,
  formRowToInput,
  patchCell,
  patchRow,
  planBulkFill,
  rowTotals,
  toFormRow,
  type BulkFillCellChange,
  type BulkFillChange,
  type BulkFillValues,
  type CapacityFormRow,
  type CapacityLineCell,
} from '@/lib/packaging/capacityForm'
import { activeLinesOf } from '@/lib/packaging/scheduleLines'
import { weekendName } from '@/lib/packaging/scheduleCalendar'
import Modal, { Btn } from './Modal'
import LinesManager from './LinesManager'
import { addDays, md, mdw } from './boardFormat'
import { fetchCapacity, putCapacity } from './boardApi'

/** 產能表列出幾個工作日（D64：批次填寫的範圍＝這 20 個工作日） */
const TABLE_WORKDAYS = 20

const INPUT_CLS = 'w-14 rounded border bg-slate-950 px-1 py-0.5 text-right tabular-nums disabled:opacity-40'

/** 合計顯示：null＝未設定 */
const totalText = (h: number | null): string => (h == null ? '—' : String(h))

/** 一格的狀態小字（沿用 9/26、未設定…） */
function cellHint(c: CapacityLineCell, weekend: boolean): string {
  if (c.clear) return weekend ? '儲存後回到 0' : '儲存後回到沿用'
  if (c.dirty) return '待儲存'
  if (c.explicit) return '已設定'
  if (weekend) return ''
  if (c.source === 'inherited' && c.inheritedFrom) return `沿用 ${md(c.inheritedFrom)}`
  if (c.source === 'unset') return '未設定'
  return ''
}

/** 同一條線的兩個儲存格（React 的 key 要放在外層，所以包一層） */
function CellPair({ a, b }: { a: ReactNode; b: ReactNode }) {
  return <>{a}{b}</>
}

export default function CapacityEditor({ mode, today, editable, getLockToken, onClose, onSaved, readonlyHint }: {
  /** day 模式可指定 lineId：從日檢視某條線的線頭 ⚙ 打開時，該線欄位自動聚焦 */
  mode: { kind: 'day'; date: YMD; lineId?: number } | { kind: 'table' }
  today: YMD
  /** 持有編輯鎖 */
  editable: boolean
  getLockToken: () => string | null
  onClose: () => void
  /** 產能或線別有任何儲存成功都呼叫（父層據此重新載入工作台） */
  onSaved: () => void
  /** D100 唯讀時底部的說明（省略＝「取得編輯權後才能修改」；AI 模擬區就算有編輯權也改不了，要說清楚去哪改） */
  readonlyHint?: string
}) {
  const [rows, setRows] = useState<CapacityFormRow[] | null>(null)
  const [allLines, setAllLines] = useState<PackagingLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [linesOpen, setLinesOpen] = useState(false)
  // D64 批次填寫
  const [bulk, setBulk] = useState<BulkFillValues>({ regular: '', ot: '' })
  /** 批次填寫的對象：'all'＝全部啟用線，數字＝某一條線 */
  const [bulkTarget, setBulkTarget] = useState<'all' | number>('all')
  /** 預覽中（按了「套用到全部平日」、還沒確認）：各平日的變更 */
  const [preview, setPreview] = useState<BulkFillChange[] | null>(null)

  // 依賴拆成原始值：父層每次重繪都會傳新的 mode 物件，直接依賴物件會一直重抓、洗掉正在編輯的內容
  const modeKind = mode.kind
  const modeDate = mode.kind === 'day' ? mode.date : null
  const focusLineId = mode.kind === 'day' ? (mode.lineId ?? null) : null
  const range = useMemo(() => (modeDate
    ? { from: modeDate, to: modeDate }
    // 20 個工作日約 4 週，遇連假多抓一些，畫面再取前 20 個工作日
    : { from: today, to: addDays(today, 41) }), [modeDate, today])

  const activeLines = useMemo(() => activeLinesOf(allLines), [allLines])
  const lineIds = useMemo(() => activeLines.map(l => l.id), [activeLines])

  const load = useCallback(async () => {
    setLoadErr(null)
    const r = await fetchCapacity(range.from, range.to)
    if (!r.json || !r.json.success) {
      setLoadErr(r.error ?? '讀取產能失敗')
      return
    }
    const lines = r.json.lines ?? []
    const ids = activeLinesOf(lines).map(l => l.id)
    const byDate = new Map(r.json.rows.map(x => [x.date, x]))
    const lineRows = r.json.lineRows ?? []
    let list = [...r.json.effective].sort((a, b) => a.date.localeCompare(b.date))
    if (modeKind === 'table') {
      // 今天起 20 個工作日，加上其間所有週六、週日
      const out: EffectiveCapacity[] = []
      let n = 0
      for (const e of list) {
        if (n >= TABLE_WORKDAYS) break
        if (e.kind === 'weekday') n++
        out.push(e)
      }
      list = out
    }
    setAllLines(lines)
    setRows(list.map(e => toFormRow(e, byDate.get(e.date), lineRows, ids)))
    // 線別變了（停用了原本選的線）：批次對象回到全部
    setBulkTarget(t => (t === 'all' || ids.includes(t) ? t : 'all'))
  }, [range, modeKind])

  useEffect(() => { void load() }, [load])

  const updateRow = (date: YMD, fn: (r: CapacityFormRow) => CapacityFormRow) => {
    setPreview(null) // 手動改表格＝預覽作廢（避免確認時套到和預覽不同的內容）
    setRows(rs => rs?.map(r => (r.date === date ? fn(r) : r)) ?? rs)
  }

  const dirty = rows?.filter(r => r.dirty) ?? []
  const firstErr = dirty.map(r => formRowError(r, activeLines)).find(Boolean) ?? null

  /**
   * 送出 list 中所有待儲存的列（一般儲存＝目前表格；批次確認＝套用後的表格）。
   * 回傳是否成功（沒有要送的列也算成功）；批次確認失敗時要靠它把表格還原。
   */
  const saveRows = async (list: readonly CapacityFormRow[]): Promise<boolean> => {
    const token = getLockToken()
    if (!token) { setError('需要先取得編輯權（開始編輯）'); return false }
    const toSend = list.filter(r => r.dirty)
    if (toSend.length === 0) return true
    const err = toSend.map(r => formRowError(r, activeLines)).find(Boolean)
    if (err) { setError(err); return false }
    setSaving(true)
    setError(null)
    try {
      const r = await putCapacity(token, toSend.map(row => formRowToInput(row, lineIds)))
      if (r.json?.success) {
        onSaved()
        setPreview(null)
        if (mode.kind === 'day') onClose()
        else await load()
        return true
      }
      const j = r.json && !r.json.success ? r.json : null
      if (j?.code === 'weekend_has_cards') {
        setError(`${j.date ? mdw(j.date) : '該週末'} 還有 ${j.cardCount ?? '?'} 張未完成的卡，請先把卡移到其他天再關閉加班`)
      } else if (j?.code === 'migration_required' || r.missingTable) {
        setError(r.error ?? j?.error ?? '資料庫尚未更新，這次沒有儲存')
      } else if (j?.code === 'date_not_workday') {
        setError(j.error || `${j.date ? mdw(j.date) + ' ' : ''}是國定假日，不能設定`)
      } else if (j?.code === 'line_invalid') {
        // 別人剛停用了某條線：欄位要重新讀取（未儲存的輸入會被洗掉，所以只提示、不自動重讀）
        setError(`${j.error || '有線已停用'}；請關閉後重新開啟產能表再填`)
      } else if (j?.code === 'lock_required' || j?.code === 'lock_lost') {
        setError('編輯權已失效，請重新取得編輯權後再儲存')
      } else {
        setError(r.error ?? '儲存失敗')
      }
      return false
    } finally {
      setSaving(false)
    }
  }

  // ── D64 批次填寫 ──
  const bulkLineIds = useMemo(() => (bulkTarget === 'all' ? lineIds : lineIds.filter(id => id === bulkTarget)), [bulkTarget, lineIds])
  const bulkErr = rows ? bulkFillRowsError(rows, bulk, bulkLineIds) : null
  const bulkTouched = bulk.regular.trim() !== '' || bulk.ot.trim() !== ''
  const previewMap = useMemo(() => {
    const m = new Map<string, BulkFillCellChange>()
    for (const d of preview ?? []) for (const c of d.cells) m.set(`${d.date}|${c.lineId}`, c)
    return m
  }, [preview])
  const setBulkField = (k: keyof BulkFillValues, v: string) => {
    setPreview(null)
    setBulk(b => ({ ...b, [k]: v }))
  }
  const startPreview = () => {
    if (!rows || bulkErr) return
    setError(null)
    setPreview(planBulkFill(rows, bulk, bulkLineIds))
  }
  const confirmBulk = async () => {
    if (!rows || !preview || bulkErr) return
    const before = rows
    const next = applyBulkFill(rows, bulk, bulkLineIds)
    setRows(next)
    const ok = await saveRows(next)
    if (ok) { setPreview(null); return }
    // 儲存失敗：表格還原成套用前（不留下「看起來套好了、其實沒存」的值），預覽列保留，修正問題後可再按確認
    setRows(before)
    setError(e => `${e ?? '儲存失敗'}（批次套用沒有儲存，表格已還原為套用前）`)
  }
  const pv = preview ? bulkFillSummary(preview) : null
  const pvDates = new Set((preview ?? []).map(c => c.date))
  const otherDirty = dirty.filter(r => !pvDates.has(r.date)).length
  const bulkTargetName = bulkTarget === 'all' ? '全部線' : (activeLines.find(l => l.id === bulkTarget)?.name ?? '')

  const title = mode.kind === 'day' ? `產能設定：${mdw(mode.date)}` : `每日產能表（今天起 ${TABLE_WORKDAYS} 個工作日）`
  const locked = !editable || !!preview || saving

  // ── 一格（某天某線）的兩個輸入框 ──
  const cellInputs = (r: CapacityFormRow, lineId: number, autoFocus: boolean): { regular: ReactNode; ot: ReactNode } | null => {
    const c = r.lines[lineId]
    if (!c) return null
    const isWk = r.kind === 'weekend'
    const inherited = !c.explicit && !c.dirty
    const dim = inherited || c.clear ? 'text-slate-500' : 'text-slate-100'
    const p = previewMap.get(`${r.date}|${lineId}`)
    const ring = (on: boolean | undefined) => (on ? 'border-amber-400 ring-1 ring-amber-400' : 'border-slate-700')
    const lineName = activeLines.find(l => l.id === lineId)?.name ?? ''
    const hint = cellHint(c, isWk) || undefined
    return {
      regular: isWk ? <span className="text-slate-600">—</span> : (
        <div className="flex items-center gap-0.5">
          <input disabled={locked || r.clear} value={c.regular} inputMode="decimal" autoFocus={autoFocus}
            aria-label={`${mdw(r.date)} ${lineName}正常時數`}
            placeholder={c.source === 'unset' ? '未設定' : undefined}
            title={hint}
            onChange={e => updateRow(r.date, row => patchCell(row, lineId, { regular: e.target.value }))}
            className={`${INPUT_CLS} ${ring(p?.regular)} ${dim} placeholder:text-slate-600`} />
          {p?.regular && <span className="text-[10px] font-semibold text-amber-300">→{bulk.regular.trim()}</span>}
        </div>
      ),
      ot: (
        <div className="flex items-center gap-0.5">
          <input disabled={locked || r.clear || (isWk && !r.weekendOpen)} value={c.ot} inputMode="decimal"
            autoFocus={autoFocus && isWk && r.weekendOpen}
            aria-label={`${mdw(r.date)} ${lineName}加班時數`}
            placeholder={isWk ? '0' : undefined}
            title={hint}
            onChange={e => updateRow(r.date, row => patchCell(row, lineId, { ot: e.target.value }))}
            className={`${INPUT_CLS} ${ring(p?.ot)} ${dim}`} />
          {p?.ot && <span className="text-[10px] font-semibold text-amber-300">→{bulk.ot.trim()}</span>}
          {/* 只清這條線這天（平日：回到該線沿用；週末：加班回到 0） */}
          {editable && !preview && !r.clear && c.explicit && !c.clear && (!isWk || r.weekendOpen) && (
            <button type="button" onClick={() => updateRow(r.date, row => patchCell(row, lineId, { clear: true }))}
              aria-label={`清除 ${mdw(r.date)} ${lineName}的設定`}
              title={isWk ? `清除${lineName}這天的加班（回到 0）` : `清除${lineName}這天的設定，回到沿用該線前一個平日`}
              className="px-0.5 text-[11px] text-slate-500 hover:text-white">↺</button>
          )}
        </div>
      ),
    }
  }

  /** 整天的狀態小字 */
  const dayHint = (r: CapacityFormRow): string => {
    if (r.clear) return '儲存後回到沿用'
    if (r.holidayWeekend) return '國定假日'
    const unset = r.kind === 'weekday' ? lineIds.filter(id => r.lines[id]?.source === 'unset' && !r.lines[id]?.dirty).length : 0
    const base = r.kind === 'weekend' ? (r.weekendOpen ? '開加班' : '未開加班')
      : r.source === 'explicit' ? '已設定'
      : r.source === 'inherited' && r.inheritedFrom ? `沿用 ${md(r.inheritedFrom)}`
      : r.source === 'unset' ? '尚未設定' : ''
    return unset > 0 && r.source !== 'unset' ? `${base}・${unset} 線未設定` : base
  }

  const weekendToggle = (r: CapacityFormRow) => (
    <label className={`flex items-center gap-1 whitespace-nowrap text-[11px] ${r.holidayWeekend ? 'text-slate-500' : 'text-amber-200'}`}
      title={r.holidayWeekend ? '國定假日不能開加班（D48 未定義假日加班）' : `${weekendName(r.date)}只有加班（D63）；開啟後出現在工作台`}>
      <input type="checkbox" disabled={locked || r.clear || (r.holidayWeekend && !r.weekendOpen)} checked={r.weekendOpen}
        onChange={e => updateRow(r.date, row => patchRow(row, { weekendOpen: e.target.checked }))} className="accent-amber-500" />
      {r.holidayWeekend ? '不能開加班' : `開${weekendName(r.date)}加班`}
    </label>
  )

  const clearDayBtn = (r: CapacityFormRow) => (editable && !preview && r.explicit && !r.clear ? (
    <button type="button" onClick={() => updateRow(r.date, row => patchRow(row, { clear: true }))}
      title="刪除這天全部線的設定，回到各線沿用前一個平日（週六、週日＝不開加班）"
      className="rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-white">清除整天</button>
  ) : null)

  // ── 表格模式：一個日期一列 ──
  const table = (list: CapacityFormRow[]) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs" style={{ minWidth: `${480 + activeLines.length * 140}px` }}>
        <thead className="text-left text-[11px] text-slate-400">
          <tr className="border-b border-slate-800">
            <th rowSpan={2} className="py-1 pr-2 align-bottom font-normal">日期</th>
            {activeLines.map(l => (
              <th key={l.id} colSpan={2} className="border-l border-slate-800 px-1.5 py-1 text-center font-semibold text-slate-200">{l.name}</th>
            ))}
            <th colSpan={2} className="border-l-2 border-slate-600 px-1.5 py-1 text-center font-semibold text-sky-200" title="D71：各線加總（唯讀）">合計</th>
            <th rowSpan={2} className="py-1 pl-2 align-bottom font-normal">備註</th>
            <th rowSpan={2} className="py-1 font-normal" />
          </tr>
          <tr className="border-b border-slate-800">
            {activeLines.map(l => (
              <CellPair key={l.id}
                a={<th className="border-l border-slate-800 px-1.5 pb-1 font-normal">正常</th>}
                b={<th className="px-1.5 pb-1 font-normal">加班</th>} />
            ))}
            <th className="border-l-2 border-slate-600 px-1.5 pb-1 font-normal">正常</th>
            <th className="px-1.5 pb-1 font-normal">加班</th>
          </tr>
        </thead>
        <tbody>
          {list.map(r => {
            const isWk = r.kind === 'weekend'
            const err = r.dirty ? formRowError(r, activeLines) : null
            const t = rowTotals(r, lineIds)
            const inPreview = pvDates.has(r.date)
            return (
              <tr key={r.date} className={`border-b border-slate-800/70 align-top ${isWk ? 'bg-amber-950/20' : ''} ${inPreview ? 'bg-amber-900/10' : ''} ${r.clear ? 'opacity-50' : ''}`}>
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  <div className={r.date === today ? 'font-bold text-sky-300' : 'text-slate-200'}>{mdw(r.date)}</div>
                  <div className="text-[10px] text-slate-500">{dayHint(r)}</div>
                  {isWk && <div className="mt-0.5">{weekendToggle(r)}</div>}
                </td>
                {activeLines.map(l => {
                  const ci = cellInputs(r, l.id, false)
                  return (
                    <CellPair key={l.id}
                      a={<td className="border-l border-slate-800 px-1.5 py-1.5">{ci?.regular}</td>}
                      b={<td className="px-1.5 py-1.5">{ci?.ot}</td>} />
                  )
                })}
                <td className="border-l-2 border-slate-600 px-1.5 py-1.5 text-right tabular-nums text-sky-100"
                  title={t.pending ? '有待清除的線：儲存後重新計算' : undefined}>
                  {isWk ? <span className="text-slate-600">—</span> : <>{totalText(t.regular)}{t.pending ? '*' : ''}</>}
                </td>
                <td className="px-1.5 py-1.5 text-right tabular-nums text-sky-100">{t.ot}{t.pending ? '*' : ''}</td>
                <td className="py-1.5 pl-2">
                  <input disabled={locked || r.clear} value={r.note} maxLength={200}
                    onChange={e => updateRow(r.date, row => patchRow(row, { note: e.target.value }))}
                    placeholder="請假、支援品檢…"
                    className="w-full min-w-[7rem] rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-200" />
                </td>
                <td className="py-1.5 pl-1 text-right whitespace-nowrap">
                  {clearDayBtn(r)}
                  {err && <div className="max-w-[12rem] whitespace-normal text-[10px] text-rose-300">{err}</div>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  // ── 單日模式：一條線一列 ──
  const dayForm = (r: CapacityFormRow) => {
    const isWk = r.kind === 'weekend'
    const t = rowTotals(r, lineIds)
    const err = r.dirty ? formRowError(r, activeLines) : null
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span>{dayHint(r)}</span>
          {isWk && weekendToggle(r)}
          <span className="flex-1" />
          {clearDayBtn(r)}
        </div>
        <table className={`w-full border-collapse text-xs ${r.clear ? 'opacity-50' : ''}`}>
          <thead className="text-left text-[11px] text-slate-400">
            <tr className="border-b border-slate-800">
              <th className="py-1 pr-2 font-normal">線</th>
              <th className="py-1 pr-2 font-normal">{isWk ? '' : '正常（h，至 19:00）'}</th>
              <th className="py-1 pr-2 font-normal">加班（h）</th>
              <th className="py-1 font-normal">狀態</th>
            </tr>
          </thead>
          <tbody>
            {activeLines.map(l => {
              const c = r.lines[l.id]
              const focus = focusLineId === l.id
              const ci = cellInputs(r, l.id, focus && editable)
              return (
                <tr key={l.id} className={`border-b border-slate-800/70 ${focus ? 'bg-sky-950/40' : ''}`}>
                  <td className="py-1.5 pr-2 font-semibold text-slate-200">{l.name}</td>
                  <td className="py-1.5 pr-2">{ci?.regular}</td>
                  <td className="py-1.5 pr-2">{ci?.ot}</td>
                  <td className="py-1.5 text-[10px] text-slate-500">{c ? cellHint(c, isWk) : ''}</td>
                </tr>
              )
            })}
            <tr className="text-sky-100">
              <td className="py-1.5 pr-2 font-semibold">合計</td>
              <td className="py-1.5 pr-2 tabular-nums">{isWk ? '' : `${totalText(t.regular)} h`}</td>
              <td className="py-1.5 pr-2 tabular-nums">{t.ot} h</td>
              <td className="py-1.5 text-[10px] text-slate-500">{t.pending ? '有待清除的線，儲存後重算' : '各線加總（唯讀）'}</td>
            </tr>
          </tbody>
        </table>
        <input disabled={locked || r.clear} value={r.note} maxLength={200}
          onChange={e => updateRow(r.date, row => patchRow(row, { note: e.target.value }))}
          placeholder="備註：請假、支援品檢…"
          className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-200" />
        {err && <div className="text-[11px] text-rose-300">{err}</div>}
      </div>
    )
  }

  return (
    <>
      <Modal
        title={title}
        onClose={onClose}
        wide={mode.kind === 'table' || activeLines.length > 3}
        footer={<>
          {error && <span className="mr-auto text-xs text-rose-300">{error}</span>}
          {!error && firstErr && <span className="mr-auto text-xs text-orange-300">{firstErr}</span>}
          {!error && !firstErr && !editable && <span className="mr-auto text-xs text-slate-400">{readonlyHint ?? '唯讀：取得編輯權後才能修改'}</span>}
          <Btn onClick={() => setLinesOpen(true)} disabled={dirty.length > 0 || saving || (!rows && !loadErr)}
            title={dirty.length > 0 ? '有未儲存的修改：請先儲存或取消，再調整線別' : '新增、改名、停用產線，調整順序'}>線別管理</Btn>
          <Btn onClick={onClose}>{editable ? '取消' : '關閉'}</Btn>
          {editable && <Btn tone="primary" disabled={saving || !!preview || dirty.length === 0 || !!firstErr} onClick={() => void saveRows(rows ?? [])}>{saving ? '儲存中…' : `儲存${dirty.length > 1 ? `（${dirty.length} 天）` : ''}`}</Btn>}
        </>}
      >
        {loadErr ? (
          <div className="rounded border border-rose-800 bg-rose-950/30 p-3 text-xs text-rose-200">
            {loadErr}
            <button type="button" onClick={() => void load()} className="ml-2 underline">重試</button>
          </div>
        ) : !rows ? (
          <p className="py-6 text-center text-xs text-slate-400">讀取中…</p>
        ) : activeLines.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">目前沒有啟用中的產線，請按「線別管理」啟用或新增一條線。</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">這段期間沒有可設定的日期（國定假日）</p>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-400">
              由組長填寫<b className="text-slate-200">每條線當天的總時數</b>（小時；已扣請假、支援品檢）。正常＝做到 19:00 為止的合計，加班＝19:00 之後可加班的上限。
              <b className="text-sky-200">合計＝各線加總</b>（唯讀，就是工作台上整天的總時數）。
            </p>

            {/* ── D64 批次填寫（只有產能表、持有編輯權時） ── */}
            {mode.kind === 'table' && editable && (
              <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-2">
                <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5 text-xs">
                  <span className="self-center font-semibold text-slate-200">批次填寫</span>
                  <label className="flex flex-col gap-0.5 text-[11px] text-slate-400">
                    套用到
                    <select value={String(bulkTarget)} disabled={saving || !!preview}
                      onChange={e => { setPreview(null); setBulkTarget(e.target.value === 'all' ? 'all' : Number(e.target.value)) }}
                      className="rounded border border-slate-600 bg-slate-950 px-1 py-0.5 text-slate-100">
                      <option value="all">全部線（每條線各填這個值）</option>
                      {activeLines.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-slate-400">
                    正常（h）
                    <input value={bulk.regular} inputMode="decimal" disabled={saving}
                      onChange={e => setBulkField('regular', e.target.value)} placeholder="不變"
                      className={`${INPUT_CLS} w-20 border-slate-600 text-slate-100`} />
                  </label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-slate-400">
                    加班（h）
                    <input value={bulk.ot} inputMode="decimal" disabled={saving}
                      onChange={e => setBulkField('ot', e.target.value)} placeholder="不變"
                      className={`${INPUT_CLS} w-20 border-slate-600 text-slate-100`} />
                  </label>
                  <Btn disabled={saving || !!preview || !bulkTouched || !!bulkErr} onClick={startPreview}
                    title="把表內所有平日（不含週六、週日、國定假日）所選線的格子填成這兩個值；會先標出將改變的格子，確認後才儲存">
                    套用到全部平日
                  </Btn>
                  {bulkTouched && bulkErr && <span className="self-center text-[11px] text-orange-300">{bulkErr}</span>}
                  <span className="self-center text-[10px] text-slate-500">空白＝該欄不變；「全部線」＝每條線各自填入這個值（不是平分）；週末不套用</span>
                </div>
                {preview && pv && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-600/70 bg-amber-950/40 px-2 py-1.5 text-[11px] text-amber-100">
                    <span className="mr-auto">
                      將把 <b>{pv.days}</b> 個平日「<b>{bulkTargetName}</b>」
                      {bulk.regular.trim() !== '' && <>的正常時數設為 <b>{bulk.regular.trim()} h</b></>}
                      {bulk.regular.trim() !== '' && bulk.ot.trim() !== '' && '、'}
                      {bulk.ot.trim() !== '' && <>{bulk.regular.trim() === '' ? '的' : ''}加班時數設為 <b>{bulk.ot.trim()} h</b></>}
                      ：有 <b>{pv.cells}</b> 格數值會改變（下表橘框）
                      {pv.overwrites > 0 && <>，其中 <b>{pv.overwrites}</b> 格（日×線）原本已設定、會被覆蓋</>}
                      。週六、週日不變。
                      {otherDirty > 0 && <span className="text-amber-300">另有 {otherDirty} 天的手動修改會一起儲存。</span>}
                    </span>
                    <Btn onClick={() => setPreview(null)} disabled={saving}>取消</Btn>
                    <Btn tone="primary" onClick={() => void confirmBulk()} disabled={saving}>{saving ? '儲存中…' : '確認套用並儲存'}</Btn>
                  </div>
                )}
              </div>
            )}

            {mode.kind === 'day' ? dayForm(rows[0]) : table(rows)}

            <p className="text-[11px] leading-relaxed text-slate-500">
              沒填的線沿用「該線」日期上最近的前一個平日設定（灰字；各線各自沿用）；某天請假填得特別低時，之後沒填的平日也會沿用那個值，請留意。
              週六、週日預設不上班，開加班後才會出現在工作台（只填各線加班時數）。「↺」只清除那條線那天；「清除整天」清除全部線。
            </p>
          </div>
        )}
      </Modal>
      {linesOpen && (
        <LinesManager
          editable={editable}
          getLockToken={getLockToken}
          onClose={() => setLinesOpen(false)}
          onChanged={() => { onSaved(); void load() }}
        />
      )}
    </>
  )
}
