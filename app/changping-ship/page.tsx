'use client'

// 常平訂單資料區 — 訂單工作表「黃底=常平已出貨」標記快照
// 資料來源:每天 07:00 ChangpingShipSync 從釘釘下載訂單工作表,黃底列經
// /api/changping-ship/import 寫入;此頁唯讀呈現(出貨燈/備註已自動套用到採購專區)。

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'

interface MatchedLine { doc_no: string; sub_no: string }

interface MarkRow {
  mark_key: string
  sheet: string
  row_no: number | null
  detail_id: string | null
  po_no: string
  pr_no: string | null
  so_no: string | null
  vendor: string | null
  item_code: string | null
  item_name: string | null
  qty: number | null
  order_date: string | null
  hope_date: string | null
  transport: string | null
  expected_ship: string | null
  ship_date_text: string | null
  ship_date: string | null
  fill_color: string | null
  still_marked: boolean
  first_seen_at: string
  last_seen_at: string
  matched_lines: MatchedLine[] | null
  match_status: string | null
  applied_at: string | null
  apply_note: string | null
}

interface Counts { total: number; active: number; applied: number; unmatched: number }

const fmtTs = (s: string | null) => (s ? s.slice(0, 16).replace('T', ' ') : '—')

export default function ChangpingShipPage() {
  const [rows, setRows] = useState<MarkRow[]>([])
  const [counts, setCounts] = useState<Counts | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [onlyActive, setOnlyActive] = useState(true)

  useEffect(() => {
    fetch('/api/changping-ship/list')
      .then(async (res) => {
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
        setRows(json.rows ?? [])
        setCounts(json.counts ?? null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const kw = search.trim().toUpperCase()
    return rows.filter((r) => {
      if (onlyActive && !r.still_marked) return false
      if (!kw) return true
      return [r.po_no, r.so_no, r.pr_no, r.item_code, r.item_name, r.detail_id]
        .some((v) => (v ?? '').toUpperCase().includes(kw))
    })
  }, [rows, search, onlyActive])

  const badge = (r: MarkRow) => {
    if (r.match_status === 'no_line') {
      return <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/15 text-rose-400 border border-rose-500/30">對不到採購行</span>
    }
    if (r.applied_at) {
      return <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">已亮燈</span>
    }
    return <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-500/15 text-slate-400 border border-slate-500/30">待套用</span>
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Link href="/" className="text-slate-400 hover:text-white text-sm">← 首頁</Link>
          <h1 className="text-xl font-bold text-white">常平訂單資料區</h1>
          <span className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-0.5">
            訂單工作表黃底 = 常平已出貨
          </span>
          {counts && (
            <span className="text-xs text-slate-500">
              目前黃底 {counts.active} 筆|累計 {counts.total}|已亮燈 {counts.applied}|對不到 {counts.unmatched}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋單號 / 品號 / 品名…"
            className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm w-64 focus:outline-none focus:border-amber-500"
          />
          <label className="flex items-center gap-1.5 text-sm text-slate-400 cursor-pointer">
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
            只看目前仍是黃底的
          </label>
          <span className="text-xs text-slate-600">每天 07:00 自動同步;出貨燈與備註已自動寫入採購專區</span>
        </div>

        {loading && <div className="text-slate-500 py-10 text-center">載入中…</div>}
        {error && <div className="text-rose-400 py-6 text-center">{error}</div>}

        {!loading && !error && (
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-900 text-slate-400 text-left text-xs">
                  <th className="px-3 py-2 whitespace-nowrap">常平出貨日</th>
                  <th className="px-3 py-2 whitespace-nowrap">採購單號</th>
                  <th className="px-3 py-2 whitespace-nowrap">來源單</th>
                  <th className="px-3 py-2">品號 / 品名</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap">數量</th>
                  <th className="px-3 py-2 whitespace-nowrap">狀態</th>
                  <th className="px-3 py-2 whitespace-nowrap">套用明細</th>
                  <th className="px-3 py-2 whitespace-nowrap">首次 / 最近掃到</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.mark_key} className={`border-t border-slate-800/70 ${r.still_marked ? '' : 'opacity-50'}`}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-middle border border-black/30"
                        style={{ backgroundColor: r.fill_color ? `#${r.fill_color.slice(2)}` : '#888' }}
                        title={`標記色 ${r.fill_color ?? '?'}${r.still_marked ? '' : '(已清除)'}`}
                      />
                      <span className="text-amber-300">{r.ship_date_text || '(未填)'}</span>
                      {r.ship_date && <span className="text-slate-500 text-xs ml-1">({r.ship_date})</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-cyan-300">{r.po_no}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-slate-400 text-xs max-w-[160px] truncate" title={r.so_no ?? ''}>{r.so_no ?? '—'}</td>
                    <td className="px-3 py-2 min-w-[220px]">
                      <div className="font-mono text-xs text-slate-300">{r.item_code ?? '—'}</div>
                      <div className="text-xs text-slate-500 line-clamp-2" title={r.item_name ?? ''}>{r.item_name ?? ''}</div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{r.qty ?? '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{badge(r)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500 max-w-[220px] truncate" title={r.apply_note ?? ''}>
                      {(r.matched_lines ?? []).map((l) => `${l.doc_no}#${l.sub_no}`).join(', ') || '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-500">
                      {fmtTs(r.first_seen_at)}<br />{fmtTs(r.last_seen_at)}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-slate-600">沒有符合的標記</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
