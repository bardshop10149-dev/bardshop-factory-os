'use client'

// 單張訂單轉換——SARA 資料交換區內建的小型工序格式產生器。
// 輸入訂單號跨日期搜尋出單表 → 帶出該單所有列 → 可逐列更換套用的途程 →
// 產生 SARA 工序列（沿用 process-gen 同一套 item_routes → route_operations →
// operation_times 查詢與工時計算規則）→ 一鍵追加進交換區 CSV buffer。

import { useCallback, useMemo, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import { buildSaraRow, type SaraRow } from '../../../../lib/sara/buildSaraRow'

interface SheetHitRow {
  sheet_date: string
  order_number: string
  item_code: string
  item_name: string
  quantity: number
  due: string
  pan_count: number
  ref_number?: string      // 依廠區選擇的製令/採購/請購單號
  line_seq?: string
  customer?: string
  factory?: 'T' | 'C' | 'O'
  assigned_machine?: string
}

// 工時計算規則——與 process-gen 一致：轉運站固定 qty=1；包裝站用生產數量；
// 其他站點盤數優先；不足 10 分鐘補至 10 分鐘
const isPackagingStation = (s: string) => s.includes('包裝站')
const isTransitStation = (s: string) => s.includes('轉運')
const isPrintStation2F6F = (s: string) => s === '印刷站2F' || s === '印刷站6F'
function calcEst(std: number, qty: number, panCount: number, station: string): number {
  if (std === 0) return 0
  const isPacking = isPackagingStation(station)
  const isTransit = isTransitStation(station)
  const effQty = isTransit ? 1 : (panCount > 0 && !isPacking) ? panCount : qty
  return Math.max(10, Math.round(std * effQty * 10) / 10)
}
function fmtToday(): string {
  const d = new Date()
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外' }

export default function SingleOrderConvert({ onAppended }: { onAppended: () => void }) {
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

      // 同一列（訂單號+序號+品號）可能出現在多個日期，只留最新日期那筆
      const seen = new Set<string>()
      const parsed: SheetHitRow[] = []
      const sortedResults = [...(json.results ?? [])].sort((a, b) => b.sheet_date.localeCompare(a.sheet_date))
      for (const sheet of sortedResults) {
        for (const r of sheet.rows) {
          const orderNo = String(r.order_number ?? '').trim()
          const itemCode = String(r.item_code ?? '').trim()
          if (!orderNo || !itemCode) continue
          const lineSeq = String(r.line_no_input ?? '').trim() || String(r.match_line_no ?? '').trim()
          const dedupeKey = `${orderNo}|${lineSeq}|${itemCode}`
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          const qty = parseFloat(String(r.quantity ?? '').replace(/,/g, '')) || 0
          if (qty <= 0) continue
          const factory = ['T', 'C', 'O'].includes(String(r.factory ?? '')) ? String(r.factory) as 'T' | 'C' | 'O' : undefined
          // 依廠區選擇對應單號：台北=製令 / 常平=採購單 / 委外=請購單（與 process-gen 一致）
          const refNumber =
            factory === 'C' ? String(r.po_number ?? '').trim() || undefined :
            factory === 'O' ? String(r.pr_number ?? '').trim() || undefined :
                              String(r.mo_number ?? '').trim() || undefined
          parsed.push({
            sheet_date: sheet.sheet_date,
            order_number: orderNo,
            item_code: itemCode,
            item_name: String(r.item_name ?? r.note ?? '').trim(),
            quantity: qty,
            due: String(r.delivery_date ?? '').trim(),
            pan_count: parseFloat(String(r.plate_count ?? '').replace(/,/g, '')) || 0,
            ref_number: refNumber,
            line_seq: lineSeq || undefined,
            customer: String(r.customer ?? '').trim() || undefined,
            factory,
            assigned_machine: String(r.machine ?? r.assigned_machine ?? '').trim() || undefined,
          })
        }
      }
      if (parsed.length === 0) {
        setSearchError(`出單表裡找不到符合「${q}」的訂單`)
        return
      }

      // 台北廠製令機台：argoerp_mo_machine_assign 才是最新來源（與 process-gen 一致）
      const tMoNums = [...new Set(parsed.filter(r => r.factory === 'T' && r.ref_number).map(r => r.ref_number!))]
      if (tMoNums.length > 0) {
        const { data: machineRows } = await supabase
          .from('argoerp_mo_machine_assign')
          .select('mo_number, machine')
          .in('mo_number', tMoNums)
        const moMachineMap = new Map((machineRows ?? []).filter(m => m.machine).map(m => [m.mo_number, m.machine as string]))
        for (const r of parsed) {
          if (r.factory === 'T' && r.ref_number) {
            const fromTable = moMachineMap.get(r.ref_number)
            if (fromTable) r.assigned_machine = fromTable
          }
        }
      }

      // 預設途程 + 全部途程清單（供更換工序的下拉）
      const uniqueItems = [...new Set(parsed.map(r => r.item_code))]
      const [{ data: irData }, { data: roData }] = await Promise.all([
        supabase.from('item_routes').select('item_code, route_id').in('item_code', uniqueItems),
        supabase.from('route_operations').select('route_id'),
      ])
      const irMap: Record<string, string> = {}
      for (const r of (irData ?? []) as Array<{ item_code: string; route_id: string }>) irMap[r.item_code] = r.route_id
      setDefaultRoutes(irMap)
      setRouteOptions([...new Set(((roData ?? []) as Array<{ route_id: string }>).map(r => r.route_id))].sort())

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
    const warns: string[] = []
    const today = fmtToday()
    try {
      const routeIds = [...new Set(hitRows.map((r, i) => effectiveRoute(i, r)).filter(Boolean))]
      const missingRouteRows = hitRows.filter((r, i) => !effectiveRoute(i, r))
      if (missingRouteRows.length > 0) {
        warns.push(`${missingRouteRows.length} 列沒有途程（item_routes 無對應且未手動指定），已跳過：${[...new Set(missingRouteRows.map(r => r.item_code))].slice(0, 4).join('、')}`)
      }

      type RoRow = { route_id: string; sequence: number; op_name: string }
      const { data: roData } = routeIds.length
        ? await supabase.from('route_operations').select('route_id,sequence,op_name').in('route_id', routeIds).order('sequence')
        : { data: [] as RoRow[] }
      const roMap = new Map<string, { sequence: number; op_name: string }[]>()
      for (const r of (roData ?? []) as RoRow[]) {
        const arr = roMap.get(r.route_id) ?? []
        arr.push({ sequence: r.sequence, op_name: r.op_name })
        roMap.set(r.route_id, arr)
      }

      const uniqueOps = [...new Set(((roData ?? []) as RoRow[]).map(r => r.op_name))]
      type OtRow = { op_name: string; station: string; std_time_min: number }
      const { data: otData } = uniqueOps.length
        ? await supabase.from('operation_times').select('op_name,station,std_time_min').in('op_name', uniqueOps)
        : { data: [] as OtRow[] }
      const otMap = new Map<string, { station: string; std_time_min: number }>(
        ((otData ?? []) as OtRow[]).map(r => [r.op_name, { station: r.station ?? '', std_time_min: Number(r.std_time_min ?? 0) }])
      )

      const out: SaraRow[] = []
      hitRows.forEach((row, idx) => {
        const routeId = effectiveRoute(idx, row)
        if (!routeId) return
        const ops = roMap.get(routeId) ?? []
        if (ops.length === 0) {
          warns.push(`途程「${routeId}」在 route_operations 沒有工序資料（${row.item_code}），已跳過`)
          return
        }
        for (const op of ops) {
          const ot = otMap.get(op.op_name)
          const station = ot?.station ?? ''
          const std = ot?.std_time_min ?? 0
          const jobQty = (row.pan_count > 0 && !isPackagingStation(station)) ? row.pan_count : row.quantity
          out.push({
            order_number: row.order_number,
            mfg_order_number: row.ref_number || row.order_number,
            product_name: row.item_code,
            product_desc: row.item_name,
            lot_number: row.line_seq || row.order_number,
            prod_qty: row.quantity,
            due: row.due,
            priority: '',
            earliest_start: today,
            job_seq: op.sequence,
            workcenter: station,
            job_name: op.op_name,
            job_qty: jobQty,
            outsourcing: '',
            est_time: calcEst(std, row.quantity, row.pan_count, station),
            time_unit: '分鐘',
            bom: '',
            mat_req_qty: '',
            customer: row.customer,
            assigned_machine: (row.factory === 'T' && isPrintStation2F6F(station) && row.assigned_machine) ? row.assigned_machine : '',
            factory: row.factory,
          })
        }
      })
      setSaraRows(out)
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
