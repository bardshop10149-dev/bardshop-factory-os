'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// 工單對位體檢（唯讀顯示）
//
// 「訂單修改紀錄」是事件流：誰在幾點改了什麼。
// 這一頁是現況清單：現在有哪些工單上印的行號已經對不到訂單了，要去處理。
// 兩者分開的原因：錯位常是好幾週前的改單造成的，不會出現在近幾天的修改紀錄裡。
// ─────────────────────────────────────────────────────────────────────────────

interface MisalignRow {
  mo: string
  so: string
  printedLine: string
  moPart: string | null
  moPartDesc: string | null
  moQty: number | null
  moStatus: string | null
  nowPart: string | null
  nowPartDesc: string | null
  realLines: string[]
  kind: 'shifted' | 'missing'
  dispatch: string
  dispatched: boolean
  partner: string | null
  sales: string | null
  duedate: string | null
  progress: number | null
  running: Array<{ station: string; job: string; status: string; qty: number | null; done: number | null; resource: string | null }>
  notify: string
}

interface Summary {
  checked: number
  ok: number
  shifted: number
  missing: number
  notApplicable: number
  noSuchLine: number
  accuracy: number | null
  orders: number
  dispatched: number
  producing: number
}

const KIND_LABEL: Record<string, { text: string; cls: string; hint: string }> = {
  shifted: {
    text: '行號跑掉',
    cls: 'bg-orange-900/60 text-orange-300 border-orange-700/50',
    hint: '這個品項還在同一張訂單上，但已經換到別的行；工單上印的行號失效了',
  },
  missing: {
    text: '品項已不在單上',
    cls: 'bg-red-900/60 text-red-300 border-red-700/50',
    hint: '這張工單要做的品項，訂單上已經找不到了（被改成別的料號或刪掉）',
  },
}

interface Props {
  /** 從「訂單修改紀錄」點過來時帶的訂單號，用來預先篩選 */
  initialSearch?: string
}

export default function SoMisalignCard({ initialSearch = '' }: Props) {
  const [rows, setRows] = useState<MisalignRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState(initialSearch)
  const [dispatchedOnly, setDispatchedOnly] = useState(false)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)

  // 從別的分頁點過來時，帶入該訂單號
  useEffect(() => { if (initialSearch) setSearch(initialSearch) }, [initialSearch])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/argoerp/so-misalign')
      const json = await res.json() as { status: string; rows?: MisalignRow[]; summary?: Summary; error?: string }
      if (json.status !== 'ok') throw new Error(json.error ?? '讀取失敗')
      setRows(json.rows ?? [])
      setSummary(json.summary ?? null)
      setLoadedAt(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (dispatchedOnly && !r.dispatched) return false
      if (!q) return true
      return [r.mo, r.so, r.moPart, r.nowPart, r.partner, r.sales]
        .some((v) => v && String(v).toLowerCase().includes(q))
    })
  }, [rows, search, dispatchedOnly])

  // 同一張訂單的工單併在一起顯示
  const groups = useMemo(() => {
    const out: { so: string; items: MisalignRow[] }[] = []
    for (const r of filtered) {
      const last = out.find((g) => g.so === r.so)
      if (last) last.items.push(r)
      else out.push({ so: r.so, items: [r] })
    }
    return out
  }, [filtered])

  const exportCsv = useCallback(() => {
    const head = ['訂單編號', '客戶', '業務', '交期', '工單號', '工單上寫的行號', '這張工單要做的品項',
      '品名規格', '訂單該行現在是', '該品項實際在', '異常類型', '發單狀態', '塔台進度%', '進行中工序', '應通知']
    const body = filtered.map((r) => [
      r.so, r.partner ?? '', r.sales ?? '', r.duedate ?? '', r.mo, `#${r.printedLine}`,
      r.moPart ?? '', r.moPartDesc ?? '', r.nowPart ?? '',
      r.realLines.length ? '#' + r.realLines.join(',') : '已不在此單',
      KIND_LABEL[r.kind]?.text ?? r.kind, r.dispatch, r.progress ?? '',
      r.running.map((x) => `${x.station}/${x.job}(${x.status})`).join(' '), r.notify,
    ])
    const csv = [head, ...body]
      .map((line) => line.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '工單對位異常清單.csv'
    a.click()
    URL.revokeObjectURL(url)
  }, [filtered])

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      {/* 標題列 */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">工單對位體檢</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-400">
            工單號末兩碼記的是「發單當下，這個品項排在訂單第幾行」。訂單事後被插入或刪除品項，
            後面的行號會整批位移，但已經印出去的工單還停在舊行號——
            現場拿工單去對訂單，就會對到別的品項。這裡列出目前所有對不上的工單。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="搜尋訂單 / 工單 / 料號 / 客戶"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-cyan-500/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            {loading ? '檢查中…' : '🔄 重新檢查'}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-40"
          >
            ⬇ 匯出 CSV
          </button>
        </div>
      </div>

      {/* 統計 */}
      {summary && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-slate-300">
            檢查 <span className="font-mono text-cyan-300">{summary.checked.toLocaleString()}</span> 張工單
          </span>
          <span className="rounded-lg border border-orange-700/50 bg-orange-900/40 px-3 py-1.5 text-orange-300">
            行號跑掉 <span className="font-mono">{summary.shifted}</span>
          </span>
          <span className="rounded-lg border border-red-700/50 bg-red-900/40 px-3 py-1.5 text-red-300">
            品項已不在單上 <span className="font-mono">{summary.missing}</span>
          </span>
          <button
            type="button"
            onClick={() => setDispatchedOnly((v) => !v)}
            title="只看已經發到現場的（現場手上的工單已經對不上訂單）"
            className={`rounded-lg border px-3 py-1.5 transition-colors ${
              dispatchedOnly
                ? 'border-red-600 bg-red-800/50 text-white'
                : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:text-white'
            }`}
          >
            ⚠ 只看已發到現場 <span className="ml-1 font-mono">{summary.dispatched}</span>
          </button>
          <span className="text-slate-400">
            涉及 <span className="font-mono text-cyan-300">{summary.orders}</span> 張訂單
            ．對位準確率 <span className="font-mono text-cyan-300">{summary.accuracy}%</span>
          </span>
          {loadedAt && (
            <span className="text-slate-500">檢查於 {loadedAt.toLocaleTimeString('zh-TW', { hour12: false })}</span>
          )}
        </div>
      )}

      {error && (
        <p className="mb-4 rounded-lg border border-red-800/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          ❌ {error}
        </p>
      )}

      {loading && (
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-10 text-center text-sm text-slate-500">
          比對中…（需讀取全部訂單行與製令，約數秒）
        </p>
      )}

      {!loading && groups.length === 0 && (
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-10 text-center text-sm text-slate-500">
          {rows.length === 0 ? '✅ 目前沒有對不上的工單' : '無符合條件的紀錄'}
        </p>
      )}

      {/* 依訂單分組 */}
      {!loading && groups.map((g) => {
        const head = g.items[0]
        const anyDispatched = g.items.some((x) => x.dispatched)
        return (
          <div key={g.so} className="mb-4 overflow-hidden rounded-xl border border-slate-800">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-800 bg-slate-900/70 px-4 py-2.5">
              <span className="font-mono text-sm font-semibold text-cyan-300">{g.so}</span>
              <span className="text-xs text-slate-300">{head.partner ?? '-'}</span>
              <span className="text-xs text-slate-500">業務：{head.sales ?? '-'}</span>
              <span className="text-xs text-slate-500">交期：{head.duedate ?? '-'}</span>
              <span className="ml-auto flex items-center gap-2">
                <span className="text-xs text-slate-400">{g.items.length} 張工單失效</span>
                <span className={`rounded border px-2 py-0.5 text-[11px] ${
                  anyDispatched
                    ? 'border-red-700/50 bg-red-900/60 text-red-300'
                    : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}>
                  {anyDispatched ? '須通知全廠' : '需通知美編部門'}
                </span>
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/40">
                    <th className="whitespace-nowrap px-3 py-2.5 text-left text-xs text-slate-300">工單號</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-left text-xs text-slate-300">工單<br />行號</th>
                    <th className="px-3 py-2.5 text-left text-xs text-slate-300">這張工單要做的品項</th>
                    <th className="px-3 py-2.5 text-left text-xs text-slate-300">但訂單該行現在是</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-left text-xs text-slate-300">異常類型</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-left text-xs text-slate-300">發單狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((r, i) => {
                    const k = KIND_LABEL[r.kind]
                    return (
                      <tr key={r.mo} className={`border-t border-slate-800/40 ${
                        i % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/10'} hover:bg-slate-800/40`}>
                        <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs text-slate-200">
                          {r.mo}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs">
                          <span className="font-semibold text-amber-300">#{r.printedLine}</span>
                        </td>
                        <td className="px-3 py-2 align-top text-xs">
                          <div className="font-medium text-slate-100">{r.moPart}</div>
                          {r.moPartDesc && (
                            <div className="max-w-[280px] truncate text-[11px] text-slate-500" title={r.moPartDesc}>
                              {r.moPartDesc}
                            </div>
                          )}
                          <div className="mt-0.5 text-[11px] text-red-400">
                            {r.realLines.length
                              ? `實際在 #${r.realLines.join(', #')}`
                              : '此品項已不在這張訂單上'}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top text-xs">
                          <div className="text-slate-300">{r.nowPart ?? '-'}</div>
                          {r.nowPartDesc && (
                            <div className="max-w-[260px] truncate text-[11px] text-slate-500" title={r.nowPartDesc}>
                              {r.nowPartDesc}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-top">
                          <span title={k?.hint} className={`cursor-help rounded border px-2 py-0.5 text-[11px] ${k?.cls}`}>
                            {k?.text}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 align-top text-xs">
                          <span className={`rounded border px-2 py-0.5 text-[11px] ${
                            r.dispatched
                              ? 'border-orange-700/50 bg-orange-900/60 text-orange-300'
                              : 'border-slate-700 bg-slate-800 text-slate-400'
                          }`}>
                            {r.dispatch}
                          </span>
                          {r.running.length > 0 && (
                            <div className="mt-1 text-[11px] text-red-300">
                              ● {r.running[0].station}／{r.running[0].job}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {/* 判讀說明 */}
      {!loading && (
        <div className="mt-4 space-y-1.5 rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-xs leading-relaxed text-slate-400">
          <p className="font-medium text-slate-300">判讀說明</p>
          <p>
            <span className="rounded border border-orange-700/50 bg-orange-900/60 px-1.5 text-orange-300">行號跑掉</span>
            ：品項還在同一張訂單，但換到別的行了。工單本身要做的東西沒錯，錯的是上面印的行號。
          </p>
          <p>
            <span className="rounded border border-red-700/50 bg-red-900/60 px-1.5 text-red-300">品項已不在單上</span>
            ：這張工單要做的品項，訂單上已經找不到——被改成別的料號或整行刪掉了。這種要確認工單還要不要做。
          </p>
          <p>
            <span className="text-slate-300">處理原則</span>：現場核對一律以工單上的
            <span className="text-slate-200">品項料號</span>為準，不要用行號去對訂單。
            訂單一旦發過單，就不要再插入或刪除品項行；需要增減請改用追加訂單，或與生管確認後重新發單。
          </p>
          {summary && (
            <p className="text-slate-500">
              本次比對 {summary.checked.toLocaleString()} 張行號制工單（MOT／MOS），
              {summary.ok.toLocaleString()} 張對得上。
              另有 {summary.notApplicable} 張 MOM 工單未列入——那是集單合併生產，
              編號是流水號不是行號，不適用本規則。
            </p>
          )}
        </div>
      )}
    </div>
  )
}
