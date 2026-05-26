'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../../../lib/supabaseClient'

interface BomRow {
  id: number
  parent_part: string
  bom_ver: number
  line_no: number
  child_part: string
  child_qty: number
  child_scrap: number
  lot_base: number | null
  synced_at: string
}

type Mode = 'forward' | 'reverse'
type Tab  = 'search' | 'browse'

const PAGE_SIZE = 100

export default function BomStructurePage() {
  const [tab, setTab]           = useState<Tab>('browse')
  const [query, setQuery]       = useState('')
  const [input, setInput]       = useState('')
  const [mode, setMode]         = useState<Mode>('forward')
  const [rows, setRows]         = useState<BomRow[]>([])
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [syncing, setSyncing]   = useState(false)
  const [syncMsg, setSyncMsg]   = useState<string | null>(null)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  // browse 分頁
  const [browseRows, setBrowseRows]     = useState<BomRow[]>([])
  const [browseTotal, setBrowseTotal]   = useState(0)
  const [browsePage, setBrowsePage]     = useState(0)
  const [browseFilter, setBrowseFilter] = useState('')
  const [browseLoading, setBrowseLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 載入最新同步時間
  useEffect(() => {
    supabase.from('mm_bom_structure').select('synced_at').order('synced_at', { ascending: false }).limit(1)
      .then(({ data }) => { if (data?.[0]) setSyncedAt(data[0].synced_at) })
  }, [])

  // 瀏覽模式：分頁載入
  const loadBrowse = useCallback(async (page: number, filter: string) => {
    setBrowseLoading(true)
    try {
      const from = page * PAGE_SIZE
      const to   = from + PAGE_SIZE - 1
      let q = supabase
        .from('mm_bom_structure')
        .select('id,parent_part,bom_ver,line_no,child_part,child_qty,child_scrap,lot_base,synced_at', { count: 'exact' })
        .order('parent_part', { ascending: true })
        .order('line_no',    { ascending: true })
        .range(from, to)
      if (filter.trim()) {
        q = q.or(`parent_part.ilike.%${filter.trim()}%,child_part.ilike.%${filter.trim()}%`)
      }
      const { data, count, error: err } = await q
      if (err) throw err
      setBrowseRows((data ?? []) as BomRow[])
      setBrowseTotal(count ?? 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
    } finally {
      setBrowseLoading(false)
    }
  }, [])

  // 進入 browse tab 時自動載入
  useEffect(() => {
    if (tab === 'browse') void loadBrowse(browsePage, browseFilter)
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const search = useCallback(async (q: string, m: Mode) => {
    const trimmed = q.trim().toUpperCase()
    if (!trimmed) { setRows([]); return }
    setLoading(true)
    setError('')
    try {
      const col = m === 'forward' ? 'parent_part' : 'child_part'
      const { data, error: err } = await supabase
        .from('mm_bom_structure')
        .select('id,parent_part,bom_ver,line_no,child_part,child_qty,child_scrap,lot_base,synced_at')
        .ilike(col, `%${trimmed}%`)
        .order('parent_part', { ascending: true })
        .order('line_no',    { ascending: true })
      if (err) throw err
      setRows((data ?? []) as BomRow[])
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleSearch = () => {
    setQuery(input)
    void search(input, mode)
  }

  const handleModeToggle = (m: Mode) => {
    setMode(m)
    if (query) void search(query, m)
  }

  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_bom_structure' }),
      })
      const json = await res.json() as { status: string; syncedCount?: number; totalFromArgo?: number; error?: string }
      if (json.status === 'ok') {
        setSyncMsg(`✅ 同步完成：${json.syncedCount ?? 0} 筆（ARGO 取得 ${json.totalFromArgo} 筆）`)
        setSyncedAt(new Date().toISOString())
        if (query) void search(query, mode)
        void loadBrowse(0, browseFilter)
        setBrowsePage(0)
      } else {
        setSyncMsg(`❌ 同步失敗：${json.error ?? '未知錯誤'}`)
      }
    } catch (e) {
      setSyncMsg(`❌ ${e instanceof Error ? e.message : '連線錯誤'}`)
    } finally {
      setSyncing(false)
    }
  }

  // 把結果依母件分組（正向模式有意義）
  const grouped = mode === 'forward'
    ? rows.reduce<Record<string, BomRow[]>>((acc, r) => {
        const key = `${r.parent_part}__v${r.bom_ver}`
        ;(acc[key] ??= []).push(r)
        return acc
      }, {})
    : null

  const totalBrowsePages = Math.ceil(browseTotal / PAGE_SIZE)

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-5xl mx-auto">

        {/* 頁頭 */}
        <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">BOM 展開結構</h1>
            {syncedAt && (
              <p className="mt-1 text-xs text-slate-400">
                最後同步：{new Date(syncedAt).toLocaleString('zh-TW', { hour12: false })}
              </p>
            )}
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            {syncMsg && <span className={`text-xs ${syncMsg.startsWith('❌') ? 'text-red-400' : 'text-emerald-400'}`}>{syncMsg}</span>}
            <button
              onClick={() => void handleSync()}
              disabled={syncing}
              className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {syncing ? '同步中...' : '⟳ 同步 ARGO'}
            </button>
          </div>
        </div>

        {/* Tab 切換 */}
        <div className="flex gap-0 mb-6 rounded-lg overflow-hidden border border-slate-700 w-fit text-sm">
          <button
            onClick={() => setTab('browse')}
            className={`px-5 py-2 transition-colors ${tab === 'browse' ? 'bg-slate-700 text-white font-medium' : 'bg-slate-900 text-slate-400 hover:text-white'}`}
          >
            📋 瀏覽全部
          </button>
          <button
            onClick={() => setTab('search')}
            className={`px-5 py-2 transition-colors ${tab === 'search' ? 'bg-slate-700 text-white font-medium' : 'bg-slate-900 text-slate-400 hover:text-white'}`}
          >
            🔍 料號查詢
          </button>
        </div>

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        {/* ── 瀏覽全部 tab ── */}
        {tab === 'browse' && (
          <>
            {/* 篩選 + 分頁控制 */}
            <div className="mb-4 flex flex-wrap gap-3 items-center">
              <input
                type="text"
                value={browseFilter}
                onChange={e => setBrowseFilter(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    setBrowsePage(0)
                    void loadBrowse(0, browseFilter)
                  }
                }}
                placeholder="篩選料號（母件 或 子件）..."
                className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50 w-64"
              />
              <button
                onClick={() => { setBrowsePage(0); void loadBrowse(0, browseFilter) }}
                disabled={browseLoading}
                className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-sm text-white transition-colors"
              >
                {browseLoading ? '載入中...' : '套用篩選'}
              </button>
              {browseFilter && (
                <button
                  onClick={() => { setBrowseFilter(''); setBrowsePage(0); void loadBrowse(0, '') }}
                  className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-400 hover:text-white transition-colors"
                >
                  ✕ 清除
                </button>
              )}
              <span className="text-xs text-slate-500 ml-auto">
                共 <span className="text-cyan-300 font-mono font-semibold">{browseTotal.toLocaleString()}</span> 筆
                {totalBrowsePages > 1 && (
                  <> · 第 <span className="text-white font-mono">{browsePage + 1}</span> / {totalBrowsePages} 頁</>
                )}
              </span>
            </div>

            <div className="rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 bg-slate-900 text-slate-400 text-xs">
                    <th className="px-4 py-2 text-left">母件料號</th>
                    <th className="px-4 py-2 text-right w-16">版本</th>
                    <th className="px-4 py-2 text-right w-12">行</th>
                    <th className="px-4 py-2 text-left">子件料號</th>
                    <th className="px-4 py-2 text-right w-20">用量</th>
                    <th className="px-4 py-2 text-right w-20">損耗率</th>
                    <th className="px-4 py-2 text-right w-20">批量基準</th>
                  </tr>
                </thead>
                <tbody>
                  {browseLoading && (
                    <tr><td colSpan={7} className="text-center py-10 text-slate-500 text-sm">載入中...</td></tr>
                  )}
                  {!browseLoading && browseRows.length === 0 && (
                    <tr><td colSpan={7} className="text-center py-10 text-slate-500 text-sm">尚無資料，請先執行同步</td></tr>
                  )}
                  {!browseLoading && browseRows.map((r, i) => {
                    const prevParent = i > 0 ? browseRows[i - 1].parent_part : null
                    const newGroup = r.parent_part !== prevParent
                    return (
                      <tr key={r.id} className={`border-b border-slate-800 hover:bg-slate-900/40 transition-colors ${newGroup && i > 0 ? 'border-t border-slate-700' : ''}`}>
                        <td className={`px-4 py-2 font-mono text-xs ${newGroup ? 'text-cyan-300 font-semibold' : 'text-slate-600'}`}>
                          {newGroup ? r.parent_part : ''}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-500 text-xs">{r.bom_ver}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-500 text-xs">{r.line_no}</td>
                        <td className="px-4 py-2 font-mono text-slate-200 text-xs">{r.child_part}</td>
                        <td className="px-4 py-2 text-right font-mono text-emerald-300 text-xs">{r.child_qty}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-400 text-xs">{r.child_scrap}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-400 text-xs">{r.lot_base ?? '-'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* 分頁按鈕 */}
            {totalBrowsePages > 1 && (
              <div className="mt-4 flex gap-2 justify-center items-center">
                <button
                  onClick={() => { const p = 0; setBrowsePage(p); void loadBrowse(p, browseFilter) }}
                  disabled={browsePage === 0 || browseLoading}
                  className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-xs text-slate-300 disabled:opacity-30 hover:bg-slate-700"
                >«</button>
                <button
                  onClick={() => { const p = browsePage - 1; setBrowsePage(p); void loadBrowse(p, browseFilter) }}
                  disabled={browsePage === 0 || browseLoading}
                  className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-xs text-slate-300 disabled:opacity-30 hover:bg-slate-700"
                >‹ 上一頁</button>
                <span className="text-xs text-slate-400 px-2">
                  第 {browsePage + 1} / {totalBrowsePages} 頁
                </span>
                <button
                  onClick={() => { const p = browsePage + 1; setBrowsePage(p); void loadBrowse(p, browseFilter) }}
                  disabled={browsePage >= totalBrowsePages - 1 || browseLoading}
                  className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-xs text-slate-300 disabled:opacity-30 hover:bg-slate-700"
                >下一頁 ›</button>
                <button
                  onClick={() => { const p = totalBrowsePages - 1; setBrowsePage(p); void loadBrowse(p, browseFilter) }}
                  disabled={browsePage >= totalBrowsePages - 1 || browseLoading}
                  className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-xs text-slate-300 disabled:opacity-30 hover:bg-slate-700"
                >»</button>
              </div>
            )}
          </>
        )}

        {/* ── 料號查詢 tab ── */}
        {tab === 'search' && (
          <>
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex rounded-lg overflow-hidden border border-slate-700 text-sm shrink-0">
                <button
                  onClick={() => handleModeToggle('forward')}
                  className={`px-4 py-2 transition-colors ${mode === 'forward' ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                >
                  正向（母件→子件）
                </button>
                <button
                  onClick={() => handleModeToggle('reverse')}
                  className={`px-4 py-2 transition-colors ${mode === 'reverse' ? 'bg-violet-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                >
                  反查（子件→被用於）
                </button>
              </div>
              <div className="flex gap-2 flex-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  placeholder={mode === 'forward' ? '輸入成品料號（母件）...' : '輸入材料料號（子件）...'}
                  className="flex-1 px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50"
                />
                <button
                  onClick={handleSearch}
                  disabled={loading}
                  className="px-5 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-sm text-white transition-colors"
                >
                  {loading ? '搜尋中...' : '搜尋'}
                </button>
              </div>
            </div>

            {rows.length === 0 && !loading && (
              <p className="text-slate-500 text-sm text-center py-16">
                {query ? '查無資料' : '輸入料號後點搜尋'}
              </p>
            )}

            {mode === 'forward' && grouped && Object.entries(grouped).map(([key, items]) => {
              const [parentPart] = key.split('__v')
              const ver = items[0].bom_ver
              return (
                <div key={key} className="mb-6 rounded-xl border border-slate-800 overflow-hidden">
                  <div className="bg-slate-900 px-4 py-3 flex items-center gap-3">
                    <span className="font-mono text-cyan-300 font-semibold">{parentPart}</span>
                    <span className="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded">BOM v{ver}</span>
                    <span className="text-xs text-slate-500 ml-auto">{items.length} 項子件</span>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700 bg-slate-900/50 text-slate-400 text-xs">
                        <th className="px-4 py-2 text-right w-12">行號</th>
                        <th className="px-4 py-2 text-left">子件料號</th>
                        <th className="px-4 py-2 text-right w-24">用量</th>
                        <th className="px-4 py-2 text-right w-24">損耗率</th>
                        <th className="px-4 py-2 text-right w-24">批量基準</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(r => (
                        <tr key={r.id} className="border-b border-slate-800 hover:bg-slate-900/40 transition-colors">
                          <td className="px-4 py-2 text-right font-mono text-slate-500 text-xs">{r.line_no}</td>
                          <td className="px-4 py-2 font-mono text-slate-200">{r.child_part}</td>
                          <td className="px-4 py-2 text-right font-mono text-emerald-300">{r.child_qty}</td>
                          <td className="px-4 py-2 text-right font-mono text-slate-400">{r.child_scrap}</td>
                          <td className="px-4 py-2 text-right font-mono text-slate-400">{r.lot_base ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })}

            {mode === 'reverse' && rows.length > 0 && (
              <div className="rounded-xl border border-slate-800 overflow-hidden">
                <div className="bg-slate-900 px-4 py-3 text-xs text-slate-400">
                  共 <span className="text-violet-300 font-mono font-semibold">{rows.length}</span> 筆，子件料號含「{query}」
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 bg-slate-900/50 text-slate-400 text-xs">
                      <th className="px-4 py-2 text-left">母件料號（成品）</th>
                      <th className="px-4 py-2 text-left">子件料號</th>
                      <th className="px-4 py-2 text-right w-16">版本</th>
                      <th className="px-4 py-2 text-right w-16">行號</th>
                      <th className="px-4 py-2 text-right w-24">用量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id} className="border-b border-slate-800 hover:bg-slate-900/40 transition-colors">
                        <td className="px-4 py-2 font-mono text-cyan-300">{r.parent_part}</td>
                        <td className="px-4 py-2 font-mono text-slate-200">{r.child_part}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-500">{r.bom_ver}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-500">{r.line_no}</td>
                        <td className="px-4 py-2 text-right font-mono text-emerald-300">{r.child_qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
