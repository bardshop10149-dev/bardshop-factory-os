'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../../../lib/supabaseClient'

// ── 型別 ────────────────────────────────────────────────
interface InternalRow { product_code: string; material_code: string; quantity: number }
interface ErpRow      { parent_part: string; child_part: string; child_qty: number; bom_ver: number; line_no: number }

type Tab = 'overview' | 'sys_only' | 'erp_only' | 'diff' | 'match'

interface ProductDiff {
  code: string
  status: 'sys_only' | 'erp_only' | 'diff' | 'match'
  sysChildren:  { mat: string; qty: number }[]
  erpChildren:  { mat: string; qty: number; line: number }[]
  /** 差異描述（diff 時才填） */
  diffs: string[]
}

const STATUS_LABEL: Record<ProductDiff['status'], string> = {
  sys_only: '僅系統有',
  erp_only: '僅 ERP 有',
  diff:     '資料有差異',
  match:    '完全一致',
}
const STATUS_COLOR: Record<ProductDiff['status'], string> = {
  sys_only: 'text-amber-400',
  erp_only: 'text-blue-400',
  diff:     'text-red-400',
  match:    'text-emerald-400',
}
const STATUS_BG: Record<ProductDiff['status'], string> = {
  sys_only: 'bg-amber-400/10 border-amber-400/30',
  erp_only: 'bg-blue-400/10 border-blue-400/30',
  diff:     'bg-red-400/10 border-red-400/30',
  match:    'bg-emerald-400/10 border-emerald-400/30',
}

// ── 主元件 ──────────────────────────────────────────────
export default function BomDiffPage() {
  const [sysRows,   setSysRows]   = useState<InternalRow[]>([])
  const [erpRows,   setErpRows]   = useState<ErpRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [tab,       setTab]       = useState<Tab>('overview')
  const [search,    setSearch]    = useState('')
  const [expanded,  setExpanded]  = useState<Set<string>>(new Set())

  // ── 載入兩張表的全量資料 ───────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function fetchAll() {
      setLoading(true)
      setError('')
      try {
        // 分批取 bom（可能筆數多，range 分批）
        const PAGE = 1000
        let sysAll: InternalRow[] = []
        let from = 0
        while (true) {
          const { data, error: e } = await supabase
            .from('bom')
            .select('product_code, material_code, quantity')
            .range(from, from + PAGE - 1)
          if (e) throw e
          if (!data || data.length === 0) break
          sysAll = sysAll.concat(data as InternalRow[])
          if (data.length < PAGE) break
          from += PAGE
        }

        // mm_bom_structure 全量（3498 筆，一次取完）
        let erpAll: ErpRow[] = []
        from = 0
        while (true) {
          const { data, error: e } = await supabase
            .from('mm_bom_structure')
            .select('parent_part, child_part, child_qty, bom_ver, line_no')
            .range(from, from + PAGE - 1)
          if (e) throw e
          if (!data || data.length === 0) break
          erpAll = erpAll.concat(data as ErpRow[])
          if (data.length < PAGE) break
          from += PAGE
        }

        if (!cancelled) {
          setSysRows(sysAll)
          setErpRows(erpAll)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '載入失敗')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchAll()
    return () => { cancelled = true }
  }, [])

  // ── 計算比對結果 ──────────────────────────────────────
  const diffResult = useMemo<ProductDiff[]>(() => {
    if (sysRows.length === 0 && erpRows.length === 0) return []

    // group system BOM by product_code
    const sysMap = new Map<string, { mat: string; qty: number }[]>()
    for (const r of sysRows) {
      const key = r.product_code.trim().toUpperCase()
      if (!sysMap.has(key)) sysMap.set(key, [])
      sysMap.get(key)!.push({ mat: r.material_code.trim().toUpperCase(), qty: Number(r.quantity) })
    }

    // group ERP BOM by parent_part (bom_ver=1 優先，若有多版本取最小 ver)
    // 先找每個 parent_part 的最低 ver
    const erpVerMap = new Map<string, number>()
    for (const r of erpRows) {
      const key = r.parent_part.trim().toUpperCase()
      const cur = erpVerMap.get(key) ?? 9999
      if (r.bom_ver < cur) erpVerMap.set(key, r.bom_ver)
    }
    const erpMap = new Map<string, { mat: string; qty: number; line: number }[]>()
    for (const r of erpRows) {
      const key = r.parent_part.trim().toUpperCase()
      if (r.bom_ver !== (erpVerMap.get(key) ?? 1)) continue  // 只取最低版本
      if (!erpMap.has(key)) erpMap.set(key, [])
      erpMap.get(key)!.push({ mat: r.child_part.trim().toUpperCase(), qty: Number(r.child_qty), line: r.line_no })
    }

    const allCodes = new Set([...sysMap.keys(), ...erpMap.keys()])
    const results: ProductDiff[] = []

    for (const code of allCodes) {
      const sysChildren = sysMap.get(code) ?? []
      const erpChildren = erpMap.get(code) ?? []

      if (sysChildren.length === 0) {
        results.push({ code, status: 'erp_only', sysChildren: [], erpChildren, diffs: [] })
        continue
      }
      if (erpChildren.length === 0) {
        results.push({ code, status: 'sys_only', sysChildren, erpChildren: [], diffs: [] })
        continue
      }

      // 兩邊都有 → 比對子件
      const sysSet = new Map(sysChildren.map(c => [c.mat, c.qty]))
      const erpSet = new Map(erpChildren.map(c => [c.mat, c.qty]))
      const diffs: string[] = []

      // 系統有但 ERP 沒有的子件
      for (const [mat, qty] of sysSet) {
        if (!erpSet.has(mat)) diffs.push(`系統有子件 ${mat}（${qty}），ERP 無`)
      }
      // ERP 有但系統沒有的子件
      for (const [mat, qty] of erpSet) {
        if (!sysSet.has(mat)) diffs.push(`ERP 有子件 ${mat}（${qty}），系統無`)
      }
      // 兩邊都有但數量不同
      for (const [mat, sysQty] of sysSet) {
        const erpQty = erpSet.get(mat)
        if (erpQty !== undefined && Math.abs(erpQty - sysQty) > 0.0001)
          diffs.push(`${mat} 用量不同：系統 ${sysQty}，ERP ${erpQty}`)
      }

      results.push({
        code,
        status: diffs.length === 0 ? 'match' : 'diff',
        sysChildren,
        erpChildren,
        diffs,
      })
    }

    return results.sort((a, b) => {
      const order = { diff: 0, sys_only: 1, erp_only: 2, match: 3 }
      return order[a.status] - order[b.status] || a.code.localeCompare(b.code)
    })
  }, [sysRows, erpRows])

  // ── 統計 ─────────────────────────────────────────────
  const stats = useMemo(() => ({
    total:    diffResult.length,
    sysOnly:  diffResult.filter(r => r.status === 'sys_only').length,
    erpOnly:  diffResult.filter(r => r.status === 'erp_only').length,
    diff:     diffResult.filter(r => r.status === 'diff').length,
    match:    diffResult.filter(r => r.status === 'match').length,
    sysRows:  sysRows.length,
    erpRows:  erpRows.length,
  }), [diffResult, sysRows, erpRows])

  // ── 篩選 ─────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = diffResult
    if (tab === 'sys_only') list = list.filter(r => r.status === 'sys_only')
    else if (tab === 'erp_only') list = list.filter(r => r.status === 'erp_only')
    else if (tab === 'diff') list = list.filter(r => r.status === 'diff')
    else if (tab === 'match') list = list.filter(r => r.status === 'match')
    if (search.trim()) {
      const q = search.trim().toUpperCase()
      list = list.filter(r =>
        r.code.includes(q) ||
        r.sysChildren.some(c => c.mat.includes(q)) ||
        r.erpChildren.some(c => c.mat.includes(q))
      )
    }
    return list
  }, [diffResult, tab, search])

  const toggleExpand = (code: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code); else next.add(code)
      return next
    })
  }

  // ── 渲染 ─────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-6xl mx-auto">

        {/* 頁頭 */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">BOM 資料比對</h1>
          <p className="mt-1 text-sm text-slate-400">
            系統 BOM（<span className="font-mono text-slate-300">bom</span> 表）vs ARGO ERP BOM（<span className="font-mono text-slate-300">mm_bom_structure</span>）
          </p>
        </div>

        {error && <p className="mb-4 text-sm text-red-400">❌ {error}</p>}

        {loading ? (
          <div className="flex items-center justify-center py-24 gap-3 text-slate-400">
            <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            載入比對資料中...（系統 BOM + ERP BOM 全量）
          </div>
        ) : (
          <>
            {/* 統計卡片 */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
              {[
                { label: '系統 BOM 筆數',    val: stats.sysRows.toLocaleString(),   color: 'text-slate-300', bg: 'bg-slate-800' },
                { label: 'ERP BOM 筆數',     val: stats.erpRows.toLocaleString(),   color: 'text-slate-300', bg: 'bg-slate-800' },
                { label: '完全一致 成品',    val: stats.match,                       color: 'text-emerald-300', bg: 'bg-emerald-900/20' },
                { label: '有差異 成品',      val: stats.diff,                        color: 'text-red-300',    bg: 'bg-red-900/20' },
                { label: '僅系統有 成品',    val: stats.sysOnly,                     color: 'text-amber-300',  bg: 'bg-amber-900/20' },
                { label: '僅ERP有 成品',     val: stats.erpOnly,                     color: 'text-blue-300',   bg: 'bg-blue-900/20' },
              ].map(c => (
                <div key={c.label} className={`rounded-xl ${c.bg} border border-slate-700/50 px-4 py-3`}>
                  <p className="text-xs text-slate-500 mb-1">{c.label}</p>
                  <p className={`text-2xl font-bold font-mono ${c.color}`}>{c.val}</p>
                </div>
              ))}
            </div>

            {/* Tab 切換 */}
            <div className="flex flex-wrap gap-1 mb-4 rounded-xl border border-slate-800 bg-slate-900/40 p-1 w-fit">
              {([
                ['overview', '📊 全部'],
                ['diff',     '🔴 有差異'],
                ['sys_only', '🟡 僅系統有'],
                ['erp_only', '🔵 僅ERP有'],
                ['match',    '✅ 完全一致'],
              ] as [Tab, string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => { setTab(key); setSearch('') }}
                  className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                    tab === key ? 'bg-cyan-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  {label}
                  {key !== 'overview' && (
                    <span className="ml-1.5 text-xs opacity-70">
                      ({key === 'diff' ? stats.diff : key === 'sys_only' ? stats.sysOnly : key === 'erp_only' ? stats.erpOnly : stats.match})
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* 搜尋 */}
            <div className="mb-4 flex items-center gap-2">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜尋料號（成品或子件）..."
                className="w-72 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-500/50 focus:outline-none"
              />
              {search && (
                <button onClick={() => setSearch('')} className="text-xs text-slate-500 hover:text-white">清除</button>
              )}
              <span className="ml-auto text-xs text-slate-500">共 {filtered.length} 筆成品</span>
            </div>

            {/* 資料列表 */}
            <div className="space-y-2">
              {filtered.length === 0 && (
                <p className="text-center text-slate-500 text-sm py-12">無資料</p>
              )}
              {filtered.map(item => {
                const open = expanded.has(item.code)
                return (
                  <div key={item.code} className={`rounded-xl border ${STATUS_BG[item.status]} overflow-hidden`}>
                    {/* 標頭列 */}
                    <button
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
                      onClick={() => toggleExpand(item.code)}
                    >
                      <span className="font-mono text-white font-semibold flex-1">{item.code}</span>
                      <span className={`text-xs font-medium ${STATUS_COLOR[item.status]}`}>
                        {STATUS_LABEL[item.status]}
                      </span>
                      {item.status === 'diff' && (
                        <span className="text-xs text-red-300 bg-red-900/30 px-2 py-0.5 rounded-full">
                          {item.diffs.length} 項差異
                        </span>
                      )}
                      <span className="text-xs text-slate-500">
                        系統 {item.sysChildren.length} 子件 ／ ERP {item.erpChildren.length} 子件
                      </span>
                      <svg
                        className={`h-4 w-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>

                    {/* 展開詳情 */}
                    {open && (
                      <div className="border-t border-white/10 px-4 py-4">

                        {/* 差異說明 */}
                        {item.diffs.length > 0 && (
                          <div className="mb-4 space-y-1">
                            {item.diffs.map((d, i) => (
                              <p key={i} className="text-xs text-red-300 bg-red-900/20 px-3 py-1 rounded-lg">⚠ {d}</p>
                            ))}
                          </div>
                        )}

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                          {/* 系統 BOM */}
                          <div>
                            <p className="text-xs text-amber-400 font-medium mb-2">系統 BOM（{item.sysChildren.length} 子件）</p>
                            {item.sysChildren.length === 0 ? (
                              <p className="text-xs text-slate-600 italic">無資料</p>
                            ) : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-slate-500 border-b border-slate-700">
                                    <th className="text-left pb-1">子件料號</th>
                                    <th className="text-right pb-1 w-16">用量</th>
                                    <th className="text-right pb-1 w-16">ERP 有？</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {item.sysChildren.sort((a, b) => a.mat.localeCompare(b.mat)).map(c => {
                                    const erpHas = item.erpChildren.some(e => e.mat === c.mat)
                                    const erpQty = item.erpChildren.find(e => e.mat === c.mat)?.qty
                                    const qtyDiff = erpQty !== undefined && Math.abs(erpQty - c.qty) > 0.0001
                                    return (
                                      <tr key={c.mat} className="border-b border-slate-800">
                                        <td className={`py-1 font-mono ${!erpHas ? 'text-amber-300' : 'text-slate-200'}`}>{c.mat}</td>
                                        <td className={`py-1 text-right font-mono ${qtyDiff ? 'text-red-300' : 'text-slate-300'}`}>{c.qty}</td>
                                        <td className="py-1 text-right">
                                          {erpHas
                                            ? <span className="text-emerald-400">✓</span>
                                            : <span className="text-amber-400">✗</span>}
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            )}
                          </div>

                          {/* ERP BOM */}
                          <div>
                            <p className="text-xs text-blue-400 font-medium mb-2">ERP BOM（{item.erpChildren.length} 子件，最低版本）</p>
                            {item.erpChildren.length === 0 ? (
                              <p className="text-xs text-slate-600 italic">無資料</p>
                            ) : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-slate-500 border-b border-slate-700">
                                    <th className="text-left pb-1">子件料號</th>
                                    <th className="text-right pb-1 w-12">行號</th>
                                    <th className="text-right pb-1 w-16">用量</th>
                                    <th className="text-right pb-1 w-16">系統有？</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {item.erpChildren.sort((a, b) => a.line - b.line).map(c => {
                                    const sysHas = item.sysChildren.some(s => s.mat === c.mat)
                                    const sysQty = item.sysChildren.find(s => s.mat === c.mat)?.qty
                                    const qtyDiff = sysQty !== undefined && Math.abs(sysQty - c.qty) > 0.0001
                                    return (
                                      <tr key={`${c.mat}-${c.line}`} className="border-b border-slate-800">
                                        <td className={`py-1 font-mono ${!sysHas ? 'text-blue-300' : 'text-slate-200'}`}>{c.mat}</td>
                                        <td className="py-1 text-right font-mono text-slate-500">{c.line}</td>
                                        <td className={`py-1 text-right font-mono ${qtyDiff ? 'text-red-300' : 'text-slate-300'}`}>{c.qty}</td>
                                        <td className="py-1 text-right">
                                          {sysHas
                                            ? <span className="text-emerald-400">✓</span>
                                            : <span className="text-blue-400">✗</span>}
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
