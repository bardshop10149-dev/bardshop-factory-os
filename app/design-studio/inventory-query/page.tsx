'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../../lib/supabaseClient'

const SETTINGS_KEY = 'design_studio_inventory_watchlist'

interface InventoryRow {
  item_code: string
  item_name: string | null
  spec: string | null
  unit_of_measure: string | null
  physical_count: number | null
  book_count: number | null
  updated_at: string | null
}

export default function InventoryQueryPage() {
  const [watchlist, setWatchlist] = useState<string[]>([])
  const [inputCode, setInputCode] = useState('')
  const [results, setResults] = useState<Map<string, InventoryRow | null>>(new Map())
  const [querying, setQuerying] = useState(false)
  const [msg, setMsg] = useState('')
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 載入追蹤清單 ──
  useEffect(() => {
    supabase.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()
      .then(({ data }) => {
        if (Array.isArray(data?.value)) setWatchlist(data!.value as string[])
      })
  }, [])

  // ── debounce 存回 Supabase ──
  const persistWatchlist = useCallback((list: string[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      supabase.from('app_settings').upsert({
        key: SETTINGS_KEY,
        value: list,
        updated_at: new Date().toISOString(),
      }).then(() => {}).catch(() => {})
    }, 600)
  }, [])

  const addCode = useCallback(() => {
    const code = inputCode.trim().toUpperCase()
    if (!code) return
    setWatchlist(prev => {
      if (prev.includes(code)) { setMsg(`⚠️ ${code} 已在清單中`); setTimeout(() => setMsg(''), 3000); return prev }
      const next = [...prev, code]
      persistWatchlist(next)
      return next
    })
    setInputCode('')
  }, [inputCode, persistWatchlist])

  const removeCode = useCallback((code: string) => {
    if (!confirm(`確定要解除追蹤「${code}」？`)) return
    setWatchlist(prev => {
      const next = prev.filter(c => c !== code)
      persistWatchlist(next)
      return next
    })
    setResults(prev => {
      const next = new Map(prev)
      next.delete(code)
      return next
    })
  }, [persistWatchlist])

  // ── 即時查詢 ──
  const handleQuery = useCallback(async () => {
    if (watchlist.length === 0) { setMsg('⚠️ 清單為空，請先新增料號'); setTimeout(() => setMsg(''), 4000); return }
    setQuerying(true)
    setMsg('')
    try {
      const { data, error } = await supabase
        .from('material_inventory_list')
        .select('item_code, item_name, spec, unit_of_measure, physical_count, book_count, updated_at')
        .in('item_code', watchlist)
      if (error) throw error
      const found = new Map<string, InventoryRow>()
      for (const row of (data ?? []) as InventoryRow[]) found.set(row.item_code, row)
      const next = new Map<string, InventoryRow | null>()
      for (const code of watchlist) next.set(code, found.get(code) ?? null)
      setResults(next)
      const ts = data?.[0]?.updated_at ?? null
      setSyncedAt(ts ? ts.slice(0, 19).replace('T', ' ') : null)
      const notFound = watchlist.filter(c => !found.has(c))
      if (notFound.length > 0) setMsg(`⚠️ 以下料號在庫存同步區查無資料：${notFound.join('、')}`)
      else setMsg(`✅ 查詢完成，共 ${data?.length ?? 0} 筆`)
      setTimeout(() => setMsg(''), 6000)
    } catch (e) {
      setMsg(`❌ 查詢失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setQuerying(false)
    }
  }, [watchlist])

  const stockLevel = (physical: number | null): { label: string; cls: string } => {
    if (physical === null) return { label: '—', cls: 'text-slate-500' }
    if (physical <= 0) return { label: '0', cls: 'text-red-400 font-bold' }
    if (physical < 10) return { label: String(physical), cls: 'text-amber-400 font-semibold' }
    return { label: String(physical), cls: 'text-emerald-400 font-semibold' }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-4xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <Link href="/design-studio" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            ← 美編天地
          </Link>
          <h1 className="text-3xl font-bold mt-3">庫存查詢</h1>
          <p className="text-slate-400 text-sm mt-1">新增追蹤料號，按下即時查詢比對同步區倉庫庫存</p>
        </div>

        {/* Message */}
        {msg && (
          <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${msg.startsWith('❌') ? 'bg-red-900/30 border border-red-700 text-red-300' : msg.startsWith('⚠') ? 'bg-amber-900/30 border border-amber-700 text-amber-300' : 'bg-emerald-900/30 border border-emerald-700 text-emerald-300'}`}>
            {msg}
          </div>
        )}

        {/* Add + Query row */}
        <div className="flex flex-wrap gap-3 items-end mb-6">
          <div className="flex gap-2 flex-1 min-w-[260px]">
            <input
              value={inputCode}
              onChange={e => setInputCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && addCode()}
              placeholder="輸入料號（Enter 新增）…"
              className="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white font-mono text-sm focus:outline-none focus:border-pink-500 placeholder:text-slate-500"
            />
            <button
              onClick={addCode}
              disabled={!inputCode.trim()}
              className="px-4 py-2 rounded-lg bg-pink-700 hover:bg-pink-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-colors whitespace-nowrap"
            >
              ＋新增
            </button>
          </div>
          <button
            onClick={() => void handleQuery()}
            disabled={querying || watchlist.length === 0}
            className="px-6 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold text-sm transition-colors whitespace-nowrap"
          >
            {querying ? '查詢中…' : '🔍 即時查詢庫存'}
          </button>
        </div>

        {/* Watchlist tags */}
        {watchlist.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6">
            {watchlist.map(code => (
              <span key={code} className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-sm font-mono text-slate-300">
                {code}
                <button
                  onClick={() => removeCode(code)}
                  className="text-slate-500 hover:text-red-400 transition-colors text-base leading-none ml-0.5"
                  title="移除"
                >×</button>
              </span>
            ))}
          </div>
        )}

        {/* Results */}
        {results.size > 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/60 flex items-center justify-between">
              <span className="text-sm font-semibold text-emerald-300">庫存查詢結果</span>
              {syncedAt && <span className="text-xs text-slate-500">同步時間：{syncedAt}</span>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/40 border-b border-slate-700 text-xs text-slate-400">
                    <th className="px-4 py-3 text-left font-medium">料號</th>
                    <th className="px-4 py-3 text-left font-medium">品名</th>
                    <th className="px-4 py-3 text-left font-medium max-w-[200px]">規格</th>
                    <th className="px-3 py-3 text-center font-medium">單位</th>
                    <th className="px-4 py-3 text-right font-medium text-emerald-400">實物庫存</th>
                    <th className="px-4 py-3 text-right font-medium text-sky-400">帳面庫存</th>
                    <th className="px-3 py-3 text-center font-medium w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {watchlist.filter(c => results.has(c)).map((code, i) => {
                    const row = results.get(code)
                    const sl = stockLevel(row?.physical_count ?? null)
                    return (
                      <tr key={code} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-900/40'}`}>
                        <td className="px-4 py-3 font-mono text-purple-300 whitespace-nowrap">{code}</td>
                        {row ? (
                          <>
                            <td className="px-4 py-3 text-slate-200 whitespace-nowrap">{row.item_name || '—'}</td>
                            <td className="px-4 py-3 text-slate-400 text-xs max-w-[200px] truncate" title={row.spec ?? ''}>{row.spec || '—'}</td>
                            <td className="px-3 py-3 text-center text-slate-400 text-xs">{row.unit_of_measure || '—'}</td>
                            <td className={`px-4 py-3 text-right tabular-nums ${sl.cls}`}>{sl.label}</td>
                            <td className="px-4 py-3 text-right tabular-nums text-sky-300">{row.book_count ?? '—'}</td>
                          </>
                        ) : (
                          <>
                            <td colSpan={4} className="px-4 py-3 text-slate-600 text-xs italic">此料號在庫存同步區查無資料（尚未同步或料號有誤）</td>
                            <td className="px-4 py-3 text-right text-slate-600">—</td>
                          </>
                        )}
                        <td className="px-3 py-3 text-center">
                          <button onClick={() => removeCode(code)} title="移除追蹤" className="text-slate-600 hover:text-red-400 transition-colors text-lg leading-none">×</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {watchlist.length === 0 && (
          <div className="text-center py-20 text-slate-600">
            <div className="text-4xl mb-3">📦</div>
            <p>尚無追蹤料號</p>
            <p className="text-xs mt-2">在上方輸入料號後按 Enter 或「＋新增」</p>
          </div>
        )}

      </div>
    </main>
  )
}
