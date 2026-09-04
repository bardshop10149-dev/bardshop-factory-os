'use client'

// 自動轉換待處理列的「貼上途程」面板
//
// 每日 17:05 自動轉換跳過的列（無途程／不符自動規則），原本只能到「途程列表」替品號建途程、
// 或重新載入該日出單表手動處理。這裡讓生管直接把途程名稱（route_id）貼進來，系統自動從
// route_operations 帶出該途程的製程、對照 operation_times 補站點與標準工時，產生 SARA 工序列
// 後一鍵加入交換區並把這筆從待處理清單移除；可同時把「品號 ↔ 途程」寫進 item_routes，
// 之後同品號再出單就會被每日排程自動套用，不用再人工處理。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import { buildSaraRow, type SaraRow } from '../../../../lib/sara/buildSaraRow'
import { calcEst, fmtToday, isPackagingStation, isPrintStation2F6F, loadSheetInputRows, type InputRow } from './sheetRows'

export interface PendingItemLike {
  sheet_date: string
  order_number: string
  item_code: string
  item_spec: string
  factory: string
  quantity: number
  line_seq: string
  reason: string
}

interface RouteOption { route_id: string; op_count: number }
interface RouteOp { seq: number; op_name: string; station: string; std: number; hasTime: boolean }

const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外' }

export default function PendingPastePanel({
  item, prioFor, onDone, onClose,
}: {
  item: PendingItemLike
  prioFor: (due: string) => string
  onDone: () => void
  onClose: () => void
}) {
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([])
  const [routeInput, setRouteInput] = useState('')
  const [existingRoute, setExistingRoute] = useState<string | null>(null)   // item_routes 既有對應
  const [saveMapping, setSaveMapping] = useState(true)

  const [sheetRow, setSheetRow] = useState<InputRow | null>(null)
  const [rowLoading, setRowLoading] = useState(true)
  const [rowError, setRowError] = useState('')
  const [moNumber, setMoNumber] = useState('')

  const [ops, setOps] = useState<RouteOp[]>([])
  const [opsLoading, setOpsLoading] = useState(false)
  const [opsError, setOpsError] = useState('')
  const [appending, setAppending] = useState(false)
  const [msg, setMsg] = useState('')

  // 途程清單（供 datalist 挑選／貼上後比對）＋此品號既有的 item_routes 對應
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/production/item-routes', { cache: 'no-store' })
        const j = await res.json() as { success: boolean; routes?: RouteOption[] }
        if (j.success && Array.isArray(j.routes)) setRouteOptions(j.routes)
      } catch { /* 清單載入失敗仍可手動輸入 */ }
      const { data } = await supabase.from('item_routes').select('route_id').eq('item_code', item.item_code).limit(1).maybeSingle()
      const existing = (data?.route_id as string | undefined) ?? null
      setExistingRoute(existing)
      // 既有對應但被判定異常（廠區不符）而進待處理的，預設先帶出原途程方便比對
      if (existing) { setRouteInput(existing); setSaveMapping(false) }
    })()
  }, [item.item_code])

  // 從該日出單表把同一筆列帶出來（工單號、交期、盤數、客戶、機台都在出單表上）
  useEffect(() => {
    void (async () => {
      setRowLoading(true)
      setRowError('')
      try {
        const rows = await loadSheetInputRows(item.sheet_date)
        const sameLine = rows.filter(r => r.order_number === item.order_number && r.item_code === item.item_code)
        const hit =
          sameLine.find(r => item.line_seq && (r.line_seq ?? '') === item.line_seq)
          ?? sameLine.find(r => r.quantity === item.quantity)
          ?? sameLine[0]
          ?? null
        if (!hit) setRowError(`在 ${item.sheet_date} 出單表找不到 ${item.order_number} / ${item.item_code}，工單號需手動填寫`)
        setSheetRow(hit)
        setMoNumber(hit?.mo_number ?? '')
      } catch (e) {
        setRowError(`出單表載入失敗：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setRowLoading(false)
      }
    })()
  }, [item.sheet_date, item.order_number, item.item_code, item.line_seq, item.quantity])

  const routeId = routeInput.trim()
  const routeKnown = useMemo(() => routeOptions.some(r => r.route_id === routeId), [routeOptions, routeId])

  // 途程名稱一對上就自動帶出製程（貼上或從清單挑選都會觸發）
  useEffect(() => {
    if (!routeId) { setOps([]); setOpsError(''); return }
    let cancelled = false
    void (async () => {
      setOpsLoading(true)
      setOpsError('')
      try {
        type RoRow = { sequence: number; op_name: string }
        const { data: roData } = await supabase
          .from('route_operations').select('sequence,op_name').eq('route_id', routeId).order('sequence')
        const rows = (roData ?? []) as RoRow[]
        if (cancelled) return
        if (rows.length === 0) {
          setOps([])
          setOpsError(routeKnown ? `途程「${routeId}」在 route_operations 沒有工序資料` : `找不到途程「${routeId}」，請確認名稱（可從清單挑選）`)
          return
        }
        type OtRow = { op_name: string; station: string | null; std_time_min: number | null }
        const { data: otData } = await supabase
          .from('operation_times').select('op_name,station,std_time_min').in('op_name', rows.map(r => r.op_name))
        if (cancelled) return
        const otMap = new Map<string, { station: string; std: number }>(
          ((otData ?? []) as OtRow[]).map(r => [r.op_name, { station: r.station ?? '', std: Number(r.std_time_min ?? 0) }])
        )
        setOps(rows.map(r => {
          const ot = otMap.get(r.op_name)
          return { seq: r.sequence, op_name: r.op_name, station: ot?.station ?? '', std: ot?.std ?? 0, hasTime: !!ot }
        }))
      } catch (e) {
        if (!cancelled) { setOps([]); setOpsError(e instanceof Error ? e.message : String(e)) }
      } finally {
        if (!cancelled) setOpsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [routeId, routeKnown])

  const missingTimes = ops.filter(o => !o.hasTime).map(o => o.op_name)

  // 產生 SARA 工序列（與 process-gen 手動套用途程同一套規則）
  const saraRows: SaraRow[] = useMemo(() => {
    if (ops.length === 0) return []
    const base: InputRow = sheetRow ?? {
      order_number: item.order_number, item_code: item.item_code, item_spec: item.item_spec,
      quantity: item.quantity, due: '', pan_count: 0, line_seq: item.line_seq || undefined,
      factory: (['T', 'C', 'O'].includes(item.factory) ? item.factory : undefined) as InputRow['factory'],
    }
    const mo = moNumber.trim() || base.order_number
    const today = fmtToday()
    return ops.map(op => {
      const jobQty = (base.pan_count > 0 && !isPackagingStation(op.station)) ? base.pan_count : base.quantity
      return {
        order_number: base.order_number, mfg_order_number: mo,
        product_name: base.item_code, product_desc: base.item_spec,
        lot_number: base.line_seq || base.order_number,
        prod_qty: base.quantity, due: base.due,
        priority: prioFor(base.due), earliest_start: today,
        job_seq: op.seq, workcenter: op.station, job_name: op.op_name,
        job_qty: jobQty, outsourcing: '', est_time: calcEst(op.std, base.quantity, base.pan_count, op.station),
        time_unit: '分鐘', bom: '', mat_req_qty: '',
        customer: base.customer,
        assigned_machine: (base.factory === 'T' && isPrintStation2F6F(op.station) && base.assigned_machine)
          ? base.assigned_machine : '',
        factory: base.factory,
      }
    })
  }, [ops, sheetRow, item, moNumber, prioFor])

  const handleAppend = useCallback(async () => {
    if (saraRows.length === 0) return
    if (missingTimes.length > 0 && !confirm(`有 ${missingTimes.length} 道製程在 operation_times 查無生產時間（工時會是 0）：${missingTimes.slice(0, 5).join('、')}\n\n仍要加入交換區嗎？`)) return
    if (!moNumber.trim() && !confirm(`未填工單號，將以訂單號 ${item.order_number} 當工單號送出，確定？`)) return
    setAppending(true)
    setMsg('')
    try {
      const res = await fetch('/api/sara/exchange-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: saraRows.map(buildSaraRow), append: true }),
      })
      const j = await res.json() as { success: boolean; count?: number; error?: string }
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)

      // 同時把品號↔途程寫進 item_routes（僅在此品號尚無對應時；失敗不影響已送出的工序列）
      let mappingNote = ''
      if (saveMapping && !existingRoute) {
        try {
          const r2 = await fetch('/api/production/item-routes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_code: item.item_code, item_name: item.item_spec, route_id: routeId }),
          })
          const j2 = await r2.json() as { success: boolean; error?: string }
          mappingNote = j2.success ? '，並已存成此品號的途程' : `（途程對應未存：${j2.error ?? `HTTP ${r2.status}`}）`
        } catch (e) {
          mappingNote = `（途程對應未存：${e instanceof Error ? e.message : String(e)}）`
        }
      }

      // 已送進交換區 → 從待處理清單移除（不再二次確認，避免打斷流程）
      await fetch('/api/sara/process-gen-pending', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [`${item.order_number}||${item.item_code}||${item.line_seq}`] }),
      })
      setMsg(`✅ 已加入交換區 ${saraRows.length} 列（累積 ${j.count} 列）${mappingNote}，此筆已從待處理移除`)
      onDone()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAppending(false)
    }
  }, [saraRows, missingTimes, moNumber, item, routeId, saveMapping, existingRoute, onDone])

  const datalistId = `pending-route-options-${item.order_number}-${item.item_code}-${item.line_seq}`.replace(/[^\w-]/g, '_')

  return (
    <div className="rounded-lg border border-emerald-800/50 bg-slate-900/80 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span>📋 貼上途程 — <span className="font-mono text-cyan-300">{item.order_number}{item.line_seq ? ` #${item.line_seq}` : ''}</span></span>
        <span className="font-mono text-purple-300">{item.item_code}</span>
        <span>{FACTORY_LABEL[item.factory] ?? item.factory}</span>
        <span>數量 <span className="font-mono text-emerald-300">{sheetRow?.quantity ?? item.quantity}</span></span>
        {sheetRow?.pan_count ? <span>盤數 <span className="font-mono">{sheetRow.pan_count}</span></span> : null}
        {sheetRow?.due && <span>交期 <span className="font-mono">{sheetRow.due}</span></span>}
        <label className="flex items-center gap-1">
          工單號
          <input
            value={moNumber}
            onChange={e => setMoNumber(e.target.value)}
            placeholder={rowLoading ? '載入中…' : '未轉單，請手動填'}
            className={`w-44 px-2 py-0.5 rounded bg-slate-950 border text-xs font-mono focus:outline-none ${moNumber.trim() ? 'border-slate-700 text-slate-200' : 'border-amber-600/60 text-amber-300'}`}
          />
        </label>
        {rowError && <span className="text-amber-400">⚠ {rowError}</span>}
      </div>

      <datalist id={datalistId}>
        {routeOptions.map(r => <option key={r.route_id} value={r.route_id}>{`${r.op_count} 道製程`}</option>)}
      </datalist>
      <div className="flex flex-wrap items-center gap-2">
        <input
          list={datalistId}
          value={routeInput}
          onChange={e => setRouteInput(e.target.value)}
          placeholder="貼上或選擇途程名稱，例：常平一般壓克力製程"
          autoFocus
          className={`flex-1 min-w-[280px] px-3 py-1.5 rounded bg-slate-950 border text-xs text-slate-200 focus:outline-none focus:border-emerald-600/60 ${routeId && !routeKnown && !opsLoading && ops.length === 0 ? 'border-amber-600/60' : 'border-slate-700'}`}
        />
        {opsLoading && <span className="text-[11px] text-slate-500">帶入製程中…</span>}
        {existingRoute && (
          <span className="text-[11px] text-slate-500">此品號目前途程：<span className="text-slate-300">{existingRoute}</span>（要改請至工序總表更新頁）</span>
        )}
        {!existingRoute && (
          <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
            <input type="checkbox" checked={saveMapping} onChange={e => setSaveMapping(e.target.checked)} className="accent-emerald-500" />
            同時存成此品號的途程（之後自動轉換直接套用）
          </label>
        )}
      </div>
      {opsError && <div className="text-[11px] text-amber-400">⚠ {opsError}</div>}

      {saraRows.length > 0 && (
        <div className="overflow-x-auto rounded border border-slate-800">
          <table className="w-full text-[11px]">
            <thead className="bg-slate-950 text-slate-500">
              <tr>
                <th className="px-2 py-1 text-center whitespace-nowrap">工序</th>
                <th className="px-2 py-1 text-left whitespace-nowrap">站點</th>
                <th className="px-2 py-1 text-left">製程名稱</th>
                <th className="px-2 py-1 text-right whitespace-nowrap">製程量</th>
                <th className="px-2 py-1 text-right whitespace-nowrap">工時(min)</th>
                <th className="px-2 py-1 text-left whitespace-nowrap">機台</th>
              </tr>
            </thead>
            <tbody>
              {saraRows.map((r, i) => (
                <tr key={i} className={`border-t border-slate-800/60 ${ops[i].hasTime ? 'text-slate-300' : 'text-amber-300 bg-amber-950/30'}`}>
                  <td className="px-2 py-1 text-center font-mono">{r.job_seq}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{r.workcenter || <span className="text-amber-400">（查無）</span>}</td>
                  <td className="px-2 py-1">{r.job_name}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.job_qty}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.est_time}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{r.assigned_machine || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {missingTimes.length > 0 && (
        <div className="text-[11px] text-amber-300">
          ⚠ {missingTimes.length} 道製程在工序總表查無生產時間（站點/工時空白）：{missingTimes.slice(0, 6).join('、')}{missingTimes.length > 6 ? '…' : ''}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => void handleAppend()}
          disabled={appending || saraRows.length === 0 || rowLoading || opsLoading}
          className="px-3 py-1.5 rounded text-xs bg-emerald-700 hover:bg-emerald-600 text-white font-bold disabled:opacity-40"
        >
          {appending ? '加入中…' : `➕ 加入交換區並標記已處理（${saraRows.length} 列）`}
        </button>
        <button onClick={onClose} disabled={appending} className="px-3 py-1.5 rounded text-xs bg-slate-800 border border-slate-700 text-slate-400 hover:text-white">
          收合
        </button>
        {msg && <span className={`text-[11px] ${msg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{msg}</span>}
      </div>
    </div>
  )
}
