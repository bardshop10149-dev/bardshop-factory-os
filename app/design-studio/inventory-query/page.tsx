'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'

interface InventoryRow {
  item_code: string
  item_name: string | null
  spec: string | null
  unit_of_measure: string | null
  physical_count: number | null
  book_count: number | null
  updated_at: string | null
}

function StockBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-500">—</span>
  if (value <= 0)     return <span className="text-red-400 font-bold tabular-nums">0</span>
  if (value < 10)     return <span className="text-amber-400 font-semibold tabular-nums">{value}</span>
  return <span className="text-emerald-400 font-semibold tabular-nums">{value}</span>
}

function InventoryTable({ rows, onAdd, onRemove, showAdd }: {
  rows: InventoryRow[]
  onAdd?: (code: string) => void
  onRemove?: (code: string) => void
  showAdd?: boolean
}) {
  if (rows.length === 0) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-800/40 border-b border-slate-700 text-xs text-slate-400">
            <th className="px-4 py-3 text-left font-medium">料號</th>
            <th className="px-4 py-3 text-left font-medium">品名</th>
            <th className="px-4 py-3 text-left font-medium">規格</th>
            <th className="px-3 py-3 text-center font-medium">單位</th>
            <th className="px-4 py-3 text-right font-medium text-emerald-400">實物庫存</th>
            <th className="px-4 py-3 text-right font-medium text-sky-400">帳面庫存</th>
            <th className="px-3 py-3 w-16"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.item_code} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-900/40'}`}>
              <td className="px-4 py-3 font-mono text-purple-300 whitespace-nowrap">{row.item_code}</td>
              <td className="px-4 py-3 text-slate-200 whitespace-nowrap">{row.item_name || '—'}</td>
              <td className="px-4 py-3 text-slate-400 text-xs max-w-[200px] truncate" title={row.spec ?? ''}>{row.spec || '—'}</td>
              <td className="px-3 py-3 text-center text-slate-400 text-xs">{row.unit_of_measure || '—'}</td>
              <td className="px-4 py-3 text-right"><StockBadge value={row.physical_count} /></td>
              <td className="px-4 py-3 text-right text-sky-300 tabular-nums">{row.book_count ?? '—'}</td>
              <td className="px-3 py-3 text-center">
                {showAdd && onAdd && (
                  <button onClick={() => onAdd(row.item_code)}
                    className="text-xs px-2 py-0.5 rounded bg-pink-700/60 hover:bg-pink-600 text-pink-200 transition-colors whitespace-nowrap">
                    ＋追蹤
                  </button>
                )}
                {!showAdd && onRemove && (
                  <button onClick={() => onRemove(row.item_code)} title="解除追蹤"
                    className="text-slate-600 hover:text-red-400 transition-colors text-lg leading-none">×</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function InventoryQueryPage() {
  const [watchlist, setWatchlist] = useState<string[]>([])
  const [inputCode, setInputCode] = useState('')
  const [watchResults, setWatchResults] = useState<InventoryRow[]>([])
  const [notFound, setNotFound] = useState<string[]>([])
  const [querying, setQuerying] = useState(false)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)

  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<InventoryRow[] | null>(null)
  const [lastKeyword, setLastKeyword] = useState('')

  const [msg, setMsg] = useState('')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    fetch('/api/inventory/watchlist', { cache: 'no-store' })
      .then(r => r.json())
      .then((json: { success: boolean; list?: string[] }) => {
        if (json.success && Array.isArray(json.list)) setWatchlist(json.list)
      })
  }, [])

  const persistWatchlist = useCallback((list: string[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      fetch('/api/inventory/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list }),
      }).catch(() => {})
    }, 600)
  }, [])

  const addCode = useCallback((rawCode: string) => {
    const code = rawCode.trim()
    if (!code) return
    setWatchlist(prev => {
      if (prev.includes(code)) {
        setMsg(`⚠️ ${code} 已在追蹤清單中`)
        setTimeout(() => setMsg(''), 3000)
        return prev
      }
      const next = [...prev, code]
      persistWatchlist(next)
      setMsg(`✅ 已加入追蹤：${code}`)
      setTimeout(() => setMsg(''), 3000)
      return next
    })
    setInputCode('')
  }, [persistWatchlist])

  const removeCode = useCallback((code: string) => {
    if (!confirm(`確定要解除追蹤「${code}」？`)) return
    setWatchlist(prev => {
      const next = prev.filter(c => c !== code)
      persistWatchlist(next)
      return next
    })
    setWatchResults(prev => prev.filter(r => r.item_code !== code))
    setNotFound(prev => prev.filter(c => c !== code))
  }, [persistWatchlist])

  // 追蹤清單查詢 — 走 API route（admin client 繞過 RLS）
  const handleQuery = useCallback(async () => {
    if (watchlist.length === 0) {
      setMsg('⚠️ 清單為空，請先新增料號')
      setTimeout(() => setMsg(''), 4000)
      return
    }
    setQuerying(true); setMsg('')
    try {
      const res = await fetch(`/api/inventory/search?codes=${encodeURIComponent(watchlist.join(','))}`, { cache: 'no-store' })
      const json = await res.json() as { success: boolean; rows?: InventoryRow[]; error?: string }
      if (!json.success) throw new Error(json.error)
      const rows = json.rows ?? []
      const foundCodes = new Set(rows.map(r => r.item_code))
      setWatchResults(rows)
      const nf = watchlist.filter(c => !foundCodes.has(c))
      setNotFound(nf)
      const ts = rows[0]?.updated_at ?? null
      setSyncedAt(ts ? ts.slice(0, 19).replace('T', ' ') : null)
      if (nf.length > 0) setMsg(`⚠️ 查無資料：${nf.join('、')}`)
      else setMsg(`✅ 查詢完成，共 ${rows.length} 筆`)
      setTimeout(() => setMsg(''), 6000)
    } catch (e) {
      setMsg(`❌ 查詢失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally { setQuerying(false) }
  }, [watchlist])

  // 關鍵字搜尋 — 同走 API route
  const handleSearch = useCallback(async () => {
    const kw = keyword.trim()
    if (!kw) return
    setSearching(true); setSearchResults(null); setLastKeyword(kw)
    try {
      const res = await fetch(`/api/inventory/search?keyword=${encodeURIComponent(kw)}`, { cache: 'no-store' })
      const json = await res.json() as { success: boolean; rows?: InventoryRow[]; error?: string }
      if (!json.success) throw new Error(json.error)
      setSearchResults(json.rows ?? [])
    } catch (e) {
      setMsg(`❌ 搜尋失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setMsg(''), 6000)
    } finally { setSearching(false) }
  }, [keyword])

  return (
    <main className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-5xl mx-auto">

        <div className="mb-6">
          <Link href="/design-studio" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">← 美編天地</Link>
          <h1 className="text-3xl font-bold mt-3">庫存查詢</h1>
          <p className="text-slate-400 text-sm mt-1">追蹤料號清單 ＋ 關鍵字搜尋，即時比對同步區倉庫庫存</p>
        </div>

        {msg && (
          <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${msg.startsWith('❌') ? 'bg-red-900/30 border border-red-700 text-red-300' : msg.startsWith('⚠') ? 'bg-amber-900/30 border border-amber-700 text-amber-300' : 'bg-emerald-900/30 border border-emerald-700 text-emerald-300'}`}>
            {msg}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">

          {/* 追蹤清單 */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-slate-700 bg-pink-900/20 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-pink-300">📌 追蹤清單（{watchlist.length} 筆）</span>
              <button
                onClick={() => void handleQuery()}
                disabled={querying || watchlist.length === 0}
                className="px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold text-xs transition-colors whitespace-nowrap"
              >
                {querying ? '查詢中…' : '🔍 即時查詢'}
              </button>
            </div>
            <div className="px-4 py-3 border-b border-slate-800">
              <div className="flex gap-2">
                <input
                  value={inputCode}
                  onChange={e => setInputCode(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addCode(inputCode)}
                  placeholder="輸入料號後 Enter 新增…"
                  className="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white font-mono text-sm focus:outline-none focus:border-pink-500 placeholder:text-slate-500"
                />
                <button onClick={() => addCode(inputCode)} disabled={!inputCode.trim()}
                  className="px-3 py-1.5 rounded-lg bg-pink-700 hover:bg-pink-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm transition-colors">
                  ＋
                </button>
              </div>
            </div>
            <div className="px-4 py-3 flex-1">
              {watchlist.length === 0 ? (
                <p className="text-slate-600 text-sm text-center py-6">尚無追蹤料號</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {watchlist.map(code => (
                    <span key={code} className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs font-mono text-slate-300">
                      {code}
                      <button onClick={() => removeCode(code)} className="text-slate-500 hover:text-red-400 transition-colors leading-none ml-0.5">×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 關鍵字搜尋 */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-slate-700 bg-sky-900/20">
              <span className="text-sm font-semibold text-sky-300">🔎 關鍵字搜尋</span>
              <p className="text-xs text-slate-500 mt-0.5">輸入料號、品名或規格關鍵字（例：8mm）</p>
            </div>
            <div className="px-4 py-3 border-b border-slate-800">
              <div className="flex gap-2">
                <input
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && void handleSearch()}
                  placeholder="輸入關鍵字後 Enter 搜尋…"
                  className="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-sky-500 placeholder:text-slate-500"
                />
                <button onClick={() => void handleSearch()} disabled={!keyword.trim() || searching}
                  className="px-4 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm transition-colors whitespace-nowrap">
                  {searching ? '搜尋中…' : '搜尋'}
                </button>
              </div>
            </div>
            <div className="px-4 py-3 flex-1">
              {searchResults === null ? (
                <p className="text-slate-600 text-sm text-center py-6">輸入關鍵字後按搜尋</p>
              ) : searchResults.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-6">查無符合「{lastKeyword}」的庫存料號</p>
              ) : (
                <p className="text-xs text-slate-500">共 {searchResults.length} 筆（最多 50）—— 搜尋結果顯示於下方</p>
              )}
            </div>
          </div>
        </div>

        {/* 追蹤清單查詢結果 */}
        {watchResults.length > 0 && (
          <div className="mb-6 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 bg-emerald-900/20 flex items-center justify-between flex-wrap gap-2">
              <span className="text-sm font-semibold text-emerald-300">追蹤清單庫存結果</span>
              <div className="flex items-center gap-3 flex-wrap">
                {notFound.length > 0 && <span className="text-xs text-amber-400">查無：{notFound.join('、')}</span>}
                {syncedAt && <span className="text-xs text-slate-500">同步：{syncedAt}</span>}
              </div>
            </div>
            <InventoryTable rows={watchResults} onRemove={removeCode} />
          </div>
        )}

        {/* 關鍵字搜尋結果 */}
        {searchResults && searchResults.length > 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 bg-sky-900/20 flex items-center justify-between">
              <span className="text-sm font-semibold text-sky-300">搜尋結果：「{lastKeyword}」</span>
              <span className="text-xs text-slate-500">{searchResults.length} 筆，點「＋追蹤」可加入清單</span>
            </div>
            <InventoryTable rows={searchResults} onAdd={addCode} showAdd />
          </div>
        )}

      </div>
    </main>
  )
}
