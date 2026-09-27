'use client'

// D49 每日產能：欄頭點擊（單日）與「產能表」（今天起 20 個工作日＋其間所有週六）共用。
// - 平日：人數、正常工時（小時，至 19:00，已扣請假／支援品檢）、可加班工時上限。
// - 週六：只有「開加班」開關＋加班工時＋人數；開啟後該週六出現在工作台（D51）。
// - 沒填的平日沿用「日期上最近的較早平日」（灰字「沿用 10/5」），可按「清除」回到沿用。
// - 關閉還有卡的週六會被伺服器擋下（saturday_has_cards），請先把卡移走。
// 產能是事實輸入，不進 Undo（D33）。資料一律經 /api/packaging/capacity。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CapacityInput, DailyCapacity, EffectiveCapacity, YMD } from '@/lib/packaging/scheduleTypes'
import Modal, { Btn } from './Modal'
import { addDays, hours, md, mdw, weekdayOf } from './boardFormat'
import { fetchCapacity, putCapacity } from './boardApi'

interface FormRow {
  date: YMD
  kind: 'weekday' | 'saturday'
  headcount: string
  regular: string
  ot: string
  satOpen: boolean
  note: string
  source: EffectiveCapacity['source']
  inheritedFrom: YMD | null
  /** 當天有沒有填過（有才可「清除」） */
  explicit: boolean
  dirty: boolean
  clear: boolean
}

function toForm(e: EffectiveCapacity, row: DailyCapacity | undefined): FormRow {
  const fromRow = !!row
  return {
    date: e.date,
    kind: e.kind,
    headcount: fromRow ? (row!.headcount == null ? '' : String(row!.headcount)) : (e.headcount == null ? '' : String(e.headcount)),
    regular: fromRow ? String(row!.regularHours) : (e.regularMinutes == null ? '' : hours(e.regularMinutes)),
    ot: fromRow ? String(row!.overtimeHoursMax) : hours(e.overtimeMinutes),
    satOpen: fromRow ? row!.isSaturdayOpen : false,
    note: row?.note ?? '',
    source: e.source,
    inheritedFrom: e.inheritedFrom,
    explicit: fromRow,
    dirty: false,
    clear: false,
  }
}

const HOURS_RE = /^\d{1,4}(\.\d{1,2})?$/

function rowError(r: FormRow): string | null {
  if (r.clear) return null
  if (r.headcount !== '' && !(/^\d{1,3}$/.test(r.headcount) && Number(r.headcount) <= 500)) return '人數須為 0~500 的整數'
  if (r.kind === 'weekday') {
    if (!HOURS_RE.test(r.regular) || Number(r.regular) > 5000) return '正常工時須為 0~5000（最多 2 位小數）'
  }
  if (!HOURS_RE.test(r.ot || '0') || Number(r.ot || 0) > 5000) return '加班上限須為 0~5000（最多 2 位小數）'
  if (r.kind === 'saturday' && r.satOpen && !(Number(r.ot) > 0)) return '開加班時加班工時要大於 0'
  return null
}

function toInput(r: FormRow): CapacityInput {
  if (r.clear) return { date: r.date, clear: true }
  return {
    date: r.date,
    headcount: r.headcount === '' ? null : Number(r.headcount),
    regularHours: r.kind === 'saturday' ? 0 : Number(r.regular),
    overtimeHoursMax: Number(r.ot || 0),
    isSaturdayOpen: r.kind === 'saturday' ? r.satOpen : false,
    note: r.note.trim() || null,
  }
}

export default function CapacityEditor({ mode, today, editable, getLockToken, onClose, onSaved }: {
  mode: { kind: 'day'; date: YMD } | { kind: 'table' }
  today: YMD
  /** 持有編輯鎖 */
  editable: boolean
  getLockToken: () => string | null
  onClose: () => void
  onSaved: () => void
}) {
  const [rows, setRows] = useState<FormRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  // 依賴拆成原始值：父層每次重繪都會傳新的 mode 物件，直接依賴物件會一直重抓、洗掉正在編輯的內容
  const modeKind = mode.kind
  const modeDate = mode.kind === 'day' ? mode.date : null
  const range = useMemo(() => (modeDate
    ? { from: modeDate, to: modeDate }
    // 20 個工作日約 4 週，遇連假多抓一些，畫面再取前 20 個工作日
    : { from: today, to: addDays(today, 41) }), [modeDate, today])

  const load = useCallback(async () => {
    setLoadErr(null)
    const r = await fetchCapacity(range.from, range.to)
    if (!r.json || !r.json.success) {
      setLoadErr(r.error ?? '讀取產能失敗')
      return
    }
    const byDate = new Map(r.json.rows.map(x => [x.date, x]))
    let list = [...r.json.effective].sort((a, b) => a.date.localeCompare(b.date))
    if (modeKind === 'table') {
      // 今天起 20 個工作日，加上其間所有週六
      const out: EffectiveCapacity[] = []
      let n = 0
      for (const e of list) {
        if (n >= 20) break
        if (e.kind === 'weekday') n++
        out.push(e)
      }
      list = out
    }
    setRows(list.map(e => toForm(e, byDate.get(e.date))))
  }, [range, modeKind])

  useEffect(() => { void load() }, [load])

  const patch = (date: YMD, p: Partial<FormRow>) =>
    setRows(rs => rs?.map(r => (r.date === date ? { ...r, ...p, dirty: true, clear: p.clear ?? false } : r)) ?? rs)

  const dirty = rows?.filter(r => r.dirty) ?? []
  const firstErr = dirty.map(rowError).find(Boolean) ?? null

  const save = async () => {
    const token = getLockToken()
    if (!token) { setError('需要先取得編輯權（開始編輯）'); return }
    if (dirty.length === 0 || firstErr) return
    setSaving(true)
    setError(null)
    try {
      const r = await putCapacity(token, dirty.map(toInput))
      if (r.json?.success) {
        onSaved()
        if (mode.kind === 'day') onClose()
        else await load()
        return
      }
      const j = r.json && !r.json.success ? r.json : null
      if (j?.code === 'saturday_has_cards') {
        setError(`${j.date ? mdw(j.date) : '該週六'} 還有 ${j.cardCount ?? '?'} 張未完成的卡，請先把卡移到其他天再關閉加班`)
      } else if (j?.code === 'date_not_workday') {
        setError(`${j.date ? mdw(j.date) + ' ' : ''}不是工作日（國定假日／週日不能設定產能）`)
      } else if (j?.code === 'lock_required' || j?.code === 'lock_lost') {
        setError('編輯權已失效，請重新取得編輯權後再儲存')
      } else {
        setError(r.error ?? '儲存失敗')
      }
    } finally {
      setSaving(false)
    }
  }

  const title = mode.kind === 'day' ? `產能設定：${mdw(mode.date)}` : '每日產能表（今天起 20 個工作日）'

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide={mode.kind === 'table'}
      footer={<>
        {error && <span className="mr-auto text-xs text-rose-300">{error}</span>}
        {!error && firstErr && <span className="mr-auto text-xs text-orange-300">{firstErr}</span>}
        {!editable && <span className="mr-auto text-xs text-slate-400">唯讀：取得編輯權後才能修改</span>}
        <Btn onClick={onClose}>{editable ? '取消' : '關閉'}</Btn>
        {editable && <Btn tone="primary" disabled={saving || dirty.length === 0 || !!firstErr} onClick={() => void save()}>{saving ? '儲存中…' : `儲存${dirty.length > 1 ? `（${dirty.length} 天）` : ''}`}</Btn>}
      </>}
    >
      {loadErr ? (
        <div className="rounded border border-rose-800 bg-rose-950/30 p-3 text-xs text-rose-200">
          {loadErr}
          <button type="button" onClick={() => void load()} className="ml-2 underline">重試</button>
        </div>
      ) : !rows ? (
        <p className="py-6 text-center text-xs text-slate-400">讀取中…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-slate-400">這段期間沒有可設定的日期（國定假日／週日）</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-xs">
            <thead className="text-left text-[11px] text-slate-400">
              <tr className="border-b border-slate-800">
                <th className="py-1.5 pr-2 font-normal">日期</th>
                <th className="py-1.5 pr-2 font-normal">人數</th>
                <th className="py-1.5 pr-2 font-normal">正常工時（h，至 19:00）</th>
                <th className="py-1.5 pr-2 font-normal">加班上限（h）</th>
                <th className="py-1.5 pr-2 font-normal">備註</th>
                <th className="py-1.5 font-normal" />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const inherited = !r.explicit && !r.dirty
                const dim = inherited ? 'text-slate-500' : 'text-slate-100'
                const isSat = r.kind === 'saturday' || weekdayOf(r.date) === 6
                const err = r.dirty ? rowError(r) : null
                return (
                  <tr key={r.date} className={`border-b border-slate-800/70 ${isSat ? 'bg-amber-950/20' : ''} ${r.clear ? 'opacity-50' : ''}`}>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <div className={r.date === today ? 'font-bold text-sky-300' : 'text-slate-200'}>{mdw(r.date)}</div>
                      <div className="text-[10px] text-slate-500">
                        {r.clear ? '儲存後回到沿用'
                          : r.explicit ? '已設定'
                          : r.source === 'inherited' && r.inheritedFrom ? `沿用 ${md(r.inheritedFrom)}`
                          : r.source === 'unset' ? '尚未設定'
                          : isSat ? '未開加班' : ''}
                      </div>
                    </td>
                    <td className="py-1.5 pr-2">
                      <input disabled={!editable} value={r.headcount} inputMode="numeric"
                        onChange={e => patch(r.date, { headcount: e.target.value })}
                        className={`w-14 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right ${dim}`} />
                    </td>
                    <td className="py-1.5 pr-2">
                      {isSat ? (
                        <label className="flex items-center gap-1.5 text-slate-300">
                          <input type="checkbox" disabled={!editable} checked={r.satOpen}
                            onChange={e => patch(r.date, { satOpen: e.target.checked })} className="accent-amber-500" />
                          開加班（出現在工作台）
                        </label>
                      ) : (
                        <input disabled={!editable} value={r.regular} inputMode="decimal"
                          placeholder={r.source === 'unset' ? '未設定' : undefined}
                          onChange={e => patch(r.date, { regular: e.target.value })}
                          className={`w-20 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right ${dim}`} />
                      )}
                    </td>
                    <td className="py-1.5 pr-2">
                      <input disabled={!editable || (isSat && !r.satOpen)} value={r.ot} inputMode="decimal"
                        onChange={e => patch(r.date, { ot: e.target.value })}
                        className={`w-20 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right disabled:opacity-40 ${dim}`} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input disabled={!editable} value={r.note} maxLength={200}
                        onChange={e => patch(r.date, { note: e.target.value })}
                        placeholder="請假、支援品檢…"
                        className="w-full min-w-[8rem] rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-200" />
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      {editable && r.explicit && !r.clear && (
                        <button type="button" onClick={() => patch(r.date, { clear: true })}
                          title="刪除這天的設定，回到沿用前一個平日（週六＝不開加班）"
                          className="rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-white">清除</button>
                      )}
                      {err && <div className="text-[10px] text-rose-300">{err}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            沒填的平日沿用「日期上最近的前一個平日」設定（灰字）；某天請假填得特別低時，之後沒填的平日也會沿用那個值，請留意。
            週六預設不上班，開加班後才會出現在工作台。
          </p>
        </div>
      )}
    </Modal>
  )
}
