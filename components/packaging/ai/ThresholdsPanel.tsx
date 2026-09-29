'use client'

// 大量門檻表（D92；規格 §七、§4.4）：數量 ≥ 門檻＝「大量」（A 線優先，D81）。程式先判好再交給 AI，AI 不自己判。
// 判定順序：品類名稱「完全相同」的列優先 → 否則品名「包含」關鍵字的列（取最長的關鍵字）→ 都沒有＝不判大量，摘要提醒主管補。
// 整表替換：新增／修改／刪除在畫面上改好，按一次「儲存」送出（伺服器寫 op_log，記前後值）。不需要編輯鎖。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AI_THRESHOLDS_MAX_ROWS,
  AI_THRESHOLD_KEY_MAX,
  AI_THRESHOLD_MAX,
  AI_THRESHOLD_MIN,
  AI_THRESHOLD_NOTE_MAX,
  type BulkThreshold,
  type BulkThresholdInput,
} from '@/lib/packaging/ai/types'
import { Btn } from '@/components/packaging/board/Modal'
import { clock } from '@/components/packaging/board/boardFormat'
import { fetchThresholds, putThresholds } from './simApi'

interface EditRow {
  uid: number
  key: string
  threshold: string
  note: string
  /** 伺服器上的原值（新增的列 null） */
  orig: BulkThreshold | null
}

let uidSeq = 0
const toEdit = (r: BulkThreshold): EditRow => ({ uid: ++uidSeq, key: r.key, threshold: String(r.threshold), note: r.note ?? '', orig: r })

/** 一列的錯誤（沒錯 null）；dupKeys＝重複的 key（trim 後） */
function rowError(r: EditRow, dupKeys: Set<string>): string | null {
  const k = r.key.trim()
  if (k.length === 0) return '請填品類或關鍵字'
  if (k.length > AI_THRESHOLD_KEY_MAX) return `最多 ${AI_THRESHOLD_KEY_MAX} 字`
  if (dupKeys.has(k)) return '重複'
  const n = Number(r.threshold)
  if (!/^\d+$/.test(r.threshold.trim()) || !Number.isInteger(n) || n < AI_THRESHOLD_MIN || n > AI_THRESHOLD_MAX) {
    return `門檻須為 ${AI_THRESHOLD_MIN}～${AI_THRESHOLD_MAX.toLocaleString()} 的整數`
  }
  if (r.note.length > AI_THRESHOLD_NOTE_MAX) return `備註最多 ${AI_THRESHOLD_NOTE_MAX} 字`
  return null
}

export default function ThresholdsPanel({ nowMs, onDirtyChange }: {
  nowMs: number
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [rows, setRows] = useState<EditRow[] | null>(null)
  const [saved, setSaved] = useState<BulkThreshold[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await fetchThresholds()
    if (r.json && r.json.success) {
      setSaved(r.json.rows)
      setRows(r.json.rows.map(toEdit))
      setErr(null)
    } else {
      setErr(r.error ?? '讀取門檻表失敗')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const dupKeys = useMemo(() => {
    const seen = new Set<string>()
    const dup = new Set<string>()
    for (const r of rows ?? []) {
      const k = r.key.trim()
      if (!k) continue
      if (seen.has(k)) dup.add(k)
      seen.add(k)
    }
    return dup
  }, [rows])

  const errors = useMemo(() => new Map((rows ?? []).map(r => [r.uid, rowError(r, dupKeys)])), [rows, dupKeys])
  const hasError = [...errors.values()].some(e => e != null)
  const dirty = useMemo(() => {
    if (!rows) return false
    if (rows.length !== saved.length) return true
    return rows.some((r, i) => {
      const s = saved[i]
      return !s || r.key.trim() !== s.key || Number(r.threshold) !== s.threshold || (r.note.trim() || null) !== (s.note ?? null)
    })
  }, [rows, saved])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  const update = (uid: number, patch: Partial<EditRow>) => setRows(rs => rs?.map(r => (r.uid === uid ? { ...r, ...patch } : r)) ?? rs)
  const remove = (uid: number) => setRows(rs => rs?.filter(r => r.uid !== uid) ?? rs)
  const add = () => setRows(rs => [...(rs ?? []), { uid: ++uidSeq, key: '', threshold: '', note: '', orig: null }])

  const save = async () => {
    if (!rows || hasError) return
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      const body: BulkThresholdInput[] = rows.map(r => ({ key: r.key.trim(), threshold: Number(r.threshold), note: r.note.trim() || null }))
      const r = await putThresholds({ rows: body })
      if (r.json && r.json.success) {
        setSaved(r.json.rows)
        setRows(r.json.rows.map(toEdit))
        setMsg(`已儲存（${r.json.rows.length} 列）；下次 AI 排程會用新的門檻`)
      } else {
        setErr(r.error ?? '儲存失敗')
      }
    } finally {
      setBusy(false)
    }
  }

  const tooMany = (rows?.length ?? 0) > AI_THRESHOLDS_MAX_ROWS
  const input = 'w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 focus:border-violet-500 focus:outline-none disabled:opacity-60'

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-slate-400">
        數量達到門檻＝「大量」（A 線優先，D81）。比對順序：<b className="text-slate-300">品類名稱完全相同</b>優先，其次<b className="text-slate-300">品名包含關鍵字</b>（取最長的關鍵字）；
        都沒有的品類不判大量，AI 摘要會列出來提醒補。
      </p>
      {err && (
        <div className="rounded border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
          {err}
          {!rows && <button type="button" onClick={() => void load()} className="ml-2 underline">重試</button>}
        </div>
      )}
      {msg && <div className="rounded border border-sky-800 bg-sky-950/30 px-3 py-2 text-xs text-sky-200">{msg}</div>}

      {!rows ? (
        !err && <p className="py-6 text-center text-xs text-slate-400">讀取中…</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-separate border-spacing-y-1 text-xs">
              <thead>
                <tr className="text-left text-[11px] text-slate-400">
                  <th className="px-1 font-normal">品類／品名關鍵字</th>
                  <th className="w-28 px-1 font-normal">門檻（件）</th>
                  <th className="px-1 font-normal">備註</th>
                  <th className="w-10 px-1 font-normal"><span className="sr-only">刪除</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const e = errors.get(r.uid)
                  return (
                    <tr key={r.uid} className="align-top">
                      <td className="px-1">
                        <input value={r.key} maxLength={AI_THRESHOLD_KEY_MAX + 10} disabled={busy} aria-label="品類或關鍵字"
                          onChange={ev => update(r.uid, { key: ev.target.value })} className={input} placeholder="例：拼板立牌" />
                        {e && <div className="mt-0.5 text-[10px] text-rose-300">{e}</div>}
                        {!e && r.orig && (
                          <div className="mt-0.5 text-[10px] text-slate-500">{r.orig.updatedByName ?? '—'}・{clock(r.orig.updatedAt, nowMs)}</div>
                        )}
                      </td>
                      <td className="px-1">
                        <input value={r.threshold} inputMode="numeric" disabled={busy} aria-label="門檻"
                          onChange={ev => update(r.uid, { threshold: ev.target.value.replace(/[^\d]/g, '') })} className={`${input} tabular-nums`} placeholder="500" />
                      </td>
                      <td className="px-1">
                        <input value={r.note} maxLength={AI_THRESHOLD_NOTE_MAX} disabled={busy} aria-label="備註"
                          onChange={ev => update(r.uid, { note: ev.target.value })} className={input} placeholder="（選填）" />
                      </td>
                      <td className="px-1 text-center">
                        <button type="button" disabled={busy} onClick={() => remove(r.uid)} aria-label={`刪除 ${r.key || '這一列'}`}
                          className="rounded px-1.5 py-0.5 text-rose-300 hover:bg-slate-800 disabled:opacity-40">✕</button>
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={4} className="px-1 py-3 text-center text-[11px] text-slate-500">還沒有門檻（所有品類都不判大量）</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Btn onClick={add} disabled={busy || (rows.length >= AI_THRESHOLDS_MAX_ROWS)}>＋ 新增一列</Btn>
            {tooMany && <span className="text-[11px] text-rose-300">最多 {AI_THRESHOLDS_MAX_ROWS} 列</span>}
            {dirty && <span className="text-[11px] text-amber-300">有未儲存的修改</span>}
            <span className="flex-1" />
            <Btn disabled={!dirty || busy} onClick={() => { setRows(saved.map(toEdit)); setMsg(null) }}>放棄修改</Btn>
            <Btn tone="primary" disabled={!dirty || busy || hasError || tooMany} onClick={() => void save()}>{busy ? '儲存中…' : '儲存門檻表'}</Btn>
          </div>
        </>
      )}
    </div>
  )
}
