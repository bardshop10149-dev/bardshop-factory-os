'use client'

// 單張訂單轉換——SARA 資料交換區內建的小型工序格式產生器。
// 輸入訂單號跨日期搜尋出單表 → 帶出該單所有列 → 可逐列更換套用的途程 →
// 產生 SARA 工序列（沿用 process-gen 同一套 item_routes → route_operations →
// operation_times 查詢與工時計算規則）→ 一鍵追加進交換區 CSV buffer。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildSaraRow, type SaraRow } from '../../../../lib/sara/buildSaraRow'
import { DEFAULT_PRIORITY_RULES, type PriorityRule } from '../../../../lib/sara/priorityRules'
// 出單表列 → SARA 工序列的解析與計算規則共用 lib/sara/clientRowGen.ts
//（改單面板 OrderRouteChange 用同一套，避免兩邊各自維護造成漂移）
import {
  applyMachineAssignments,
  generateSaraRows,
  loadRouteMeta,
  parseSheetHits,
  FACTORY_LABEL,
  type SheetHitRow,
} from '../../../../lib/sara/clientRowGen'

export default function SingleOrderConvert({ onAppended }: { onAppended: () => void }) {
  // 交期優先度規則（與 process-gen / 每日自動轉換共用同一份，見 /api/sara/priority-rules）
  const prioRulesRef = useRef<PriorityRule[]>(DEFAULT_PRIORITY_RULES)
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/sara/priority-rules', { cache: 'no-store' })
        const j = await res.json() as { success: boolean; rules?: PriorityRule[] }
        if (j.success && Array.isArray(j.rules)) prioRulesRef.current = j.rules
      } catch { /* 載入失敗沿用預設規則 */ }
    })()
  }, [])

  const [orderInput, setOrderInput] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [hitRows, setHitRows] = useState<SheetHitRow[]>([])
  const [routeOverrides, setRouteOverrides] = useState<Record<number, string>>({})   // index → route_id
  const [defaultRoutes, setDefaultRoutes] = useState<Record<string, string>>({})     // item_code → route_id
  const [routeOptions, setRouteOptions] = useState<string[]>([])

  const [generating, setGenerating] = useState(false)
  const [genWarns, setGenWarns] = useState<string[]>([])
  const [saraRows, setSaraRows] = useState<SaraRow[]>([])

  const [appending, setAppending] = useState(false)
  const [appendMsg, setAppendMsg] = useState('')

  // ── 搜尋訂單（跨日期，沿用出單表既有 ?search= API）──
  const handleSearch = useCallback(async () => {
    const q = orderInput.trim()
    if (!q) return
    setSearching(true)
    setSearchError('')
    setHitRows([])
    setSaraRows([])
    setGenWarns([])
    setRouteOverrides({})
    setAppendMsg('')
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?search=${encodeURIComponent(q)}`, { cache: 'no-store' })
      const json = await res.json() as { success: boolean; error?: string; results?: Array<{ sheet_date: string; rows: Record<string, unknown>[] }> }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)

      const parsed = parseSheetHits(json.results ?? [])
      if (parsed.length === 0) {
        setSearchError(`出單表裡找不到符合「${q}」的訂單`)
        return
      }
      await applyMachineAssignments(parsed)
      const meta = await loadRouteMeta([...new Set(parsed.map(r => r.item_code))])
      setDefaultRoutes(meta.defaultRoutes)
      setRouteOptions(meta.routeOptions)

      setHitRows(parsed)
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }, [orderInput])

  const effectiveRoute = useCallback((idx: number, row: SheetHitRow): string => {
    return (routeOverrides[idx] ?? defaultRoutes[row.item_code] ?? '').trim()
  }, [routeOverrides, defaultRoutes])

  // ── 產生 SARA 工序列 ──
  const handleGenerate = useCallback(async () => {
    if (hitRows.length === 0) return
    setGenerating(true)
    setGenWarns([])
    setSaraRows([])
    setAppendMsg('')
    try {
      const { rows, warns } = await generateSaraRows(hitRows, (row, idx) => effectiveRoute(idx, row), prioRulesRef.current)
      setSaraRows(rows)
      setGenWarns(warns)
    } catch (e) {
      setGenWarns([`錯誤：${e instanceof Error ? e.message : String(e)}`])
    } finally {
      setGenerating(false)
    }
  }, [hitRows, effectiveRoute])

  // ── 加入交換區 ──
  const handleAppend = useCallback(async () => {
    if (saraRows.length === 0) return
    setAppending(true)
    setAppendMsg('')
    try {
      const dataRows = saraRows.map(buildSaraRow)
      const res = await fetch('/api/sara/exchange-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: dataRows, append: true }),
      })
      const j = await res.json() as { success: boolean; count?: number; error?: string }
      if (!j.success) throw new Error(j.error)
      setAppendMsg(`✅ 已追加 ${saraRows.length} 列（累積 ${j.count} 列）`)
      onAppended()
      setTimeout(() => setAppendMsg(''), 6000)
    } catch (e) {
      setAppendMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAppending(false)
    }
  }, [saraRows, onAppended])

  const previewRows = useMemo(() => saraRows.slice(0, 100), [saraRows])

  return (
    <div className="mb-6 rounded-xl border border-teal-800/40 bg-teal-950/20 p-5 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-teal-300">🔄 單張訂單轉換</h2>
        <p className="text-xs text-slate-400 mt-0.5">輸入訂單號從出單表帶出資料，套用/更換途程後產生 SARA 工序列，直接追加進交換區</p>
      </div>

      {/* 搜尋 */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={orderInput}
          onChange={e => setOrderInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleSearch() }}
          placeholder="輸入訂單號（可部分比對）…"
          className="flex-1 min-w-[220px] px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-teal-500/60"
        />
        <button
          onClick={() => void handleSearch()}
          disabled={searching || !orderInput.trim()}
          className="px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
        >
          {searching ? '搜尋中…' : '搜尋出單表'}
        </button>
        {searchError && <span className="text-red-400 text-xs">{searchError}</span>}
      </div>

      <datalist id="single-convert-routes">
        {routeOptions.map(r => <option key={r} value={r} />)}
      </datalist>

      {/* 命中列 + 途程選擇 */}
      {hitRows.length > 0 && (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-[11px]">
              <thead className="bg-slate-900">
                <tr className="text-slate-500">
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">出單日</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">訂單號</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">廠區</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">單號</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">品號</th>
                  <th className="px-2 py-1.5 text-right whitespace-nowrap">數量</th>
                  <th className="px-2 py-1.5 text-right whitespace-nowrap">盤數</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">交期</th>
                  <th className="px-2 py-1.5 text-left min-w-[220px]">套用途程（可更換）</th>
                </tr>
              </thead>
              <tbody>
                {hitRows.map((r, i) => {
                  const route = effectiveRoute(i, r)
                  return (
                    <tr key={i} className="border-t border-slate-800/60 text-slate-300">
                      <td className="px-2 py-1 whitespace-nowrap text-slate-500">{r.sheet_date}</td>
                      <td className="px-2 py-1 font-mono text-cyan-300 whitespace-nowrap">{r.order_number}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{r.factory ? FACTORY_LABEL[r.factory] : '—'}</td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap">{r.ref_number ?? '—'}</td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap">{r.item_code}</td>
                      <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{r.quantity}</td>
                      <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{r.pan_count || '—'}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{r.due}</td>
                      <td className="px-2 py-1">
                        <input
                          list="single-convert-routes"
                          value={routeOverrides[i] ?? defaultRoutes[r.item_code] ?? ''}
                          onChange={e => setRouteOverrides(prev => ({ ...prev, [i]: e.target.value }))}
                          placeholder="無途程，請輸入"
                          className={`w-full px-2 py-1 rounded bg-slate-800 border text-xs focus:outline-none ${route ? 'border-slate-700 text-slate-200' : 'border-amber-600/60 text-amber-300'}`}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <button
            onClick={() => void handleGenerate()}
            disabled={generating}
            className="px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
          >
            {generating ? '⏳ 查詢途程中…' : '⚙ 產生 SARA 格式'}
          </button>
        </div>
      )}

      {genWarns.length > 0 && (
        <div className="px-3 py-2 rounded-lg bg-amber-950/40 border border-amber-700/40 space-y-0.5">
          {genWarns.map((w, i) => <div key={i} className="text-amber-300 text-xs">⚠ {w}</div>)}
        </div>
      )}

      {/* 產出預覽 + 加入交換區 */}
      {saraRows.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
              產出 <span className="text-teal-300 font-bold">{saraRows.length}</span> 工序列
            </span>
            <button
              onClick={() => void handleAppend()}
              disabled={appending}
              className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
            >
              {appending ? '追加中…' : '➕ 加入交換區 CSV'}
            </button>
            {appendMsg && <span className={`text-xs ${appendMsg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{appendMsg}</span>}
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-800 max-h-72 overflow-y-auto">
            <table className="w-full text-[11px]">
              <thead className="bg-slate-900 sticky top-0">
                <tr className="text-slate-500">
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">訂單</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">工單號</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">品號</th>
                  <th className="px-2 py-1.5 text-center whitespace-nowrap">工序</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">站點</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">製程名稱</th>
                  <th className="px-2 py-1.5 text-right whitespace-nowrap">製程量</th>
                  <th className="px-2 py-1.5 text-right whitespace-nowrap">工時(min)</th>
                  <th className="px-2 py-1.5 text-left whitespace-nowrap">機台</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-800/60 text-slate-300">
                    <td className="px-2 py-1 font-mono text-cyan-300 whitespace-nowrap">{r.order_number}</td>
                    <td className="px-2 py-1 font-mono whitespace-nowrap">{r.mfg_order_number}</td>
                    <td className="px-2 py-1 font-mono whitespace-nowrap">{r.product_name}</td>
                    <td className="px-2 py-1 text-center whitespace-nowrap">{r.job_seq}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.workcenter}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-teal-300">{r.job_name}</td>
                    <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{r.job_qty}</td>
                    <td className="px-2 py-1 text-right font-mono text-amber-300 whitespace-nowrap">{r.est_time}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.assigned_machine || '—'}</td>
                  </tr>
                ))}
                {saraRows.length > previewRows.length && (
                  <tr><td colSpan={9} className="px-2 py-1.5 text-center text-slate-500">… 其餘 {saraRows.length - previewRows.length} 列省略（實際加入時會全部寫入）</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
