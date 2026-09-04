'use client'

// 自動轉換待處理列的「貼上製程」面板
//
// 每日 17:05 自動轉換跳過的列（無途程／不符自動規則），原本只能到「途程列表」替品號建途程、
// 或重新載入該日出單表手動處理。這裡讓生管直接把製程貼進來（每行一道製程名稱，或從
// 單品查詢／Excel 複製的表格），對照 operation_times 補上站點與標準工時，產生 SARA 工序列
// 後一鍵加入交換區，並同時把這筆從待處理清單移除。

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

interface OpInfo { station: string; std: number }
interface ParsedOp { seq: number; op_name: string; station: string; std: number; known: boolean }

const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外' }

/** 製程名稱比對用的正規化：去空白、全形符號轉半形、忽略大小寫 */
function normOp(s: string): string {
  return s.replace(/\s+/g, '')
    .replace(/／/g, '/').replace(/（/g, '(').replace(/）/g, ')').replace(/＋/g, '+')
    .toLowerCase()
}

/**
 * 把貼上的文字拆成製程名稱清單。支援：
 *  - 每行一道製程（可帶前導編號：「1. 印刷」「10 裁切」「(3) 包裝」）
 *  - 單行用 → / -> / 、 / , / ／ 串起來：「印刷→裁切→包裝」
 *  - Tab 分隔的表格（單品查詢複製、Excel 貼上）：自動跳過標題列，每列取對得上
 *    operation_times 的那一格；對不上就取最長的非數字欄位
 */
export function parseProcessText(text: string, ops: Map<string, OpInfo>): string[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return []
  // 注意不能用「/」當分隔：製程名稱本身常含斜線（QC檢驗/入庫、委外/7天回）
  const SEP = /->|→|＞|>|、|，|,/
  if (lines.length === 1 && !lines[0].includes('\t') && SEP.test(lines[0]) && !ops.has(normOp(lines[0]))) {
    return lines[0].split(SEP).map(s => s.trim()).filter(Boolean)
  }
  const out: string[] = []
  for (const line of lines) {
    if (line.includes('\t')) {
      if (/job_name|製程名稱|manufacturing_order_number|工序/i.test(line) && !ops.has(normOp(line))) continue
      const cells = line.split('\t').map(c => c.trim()).filter(Boolean)
      const known = cells.find(c => ops.has(normOp(c)))
      const fallback = cells.filter(c => !/^[\d.,]+$/.test(c)).sort((a, b) => b.length - a.length)[0]
      const pick = known ?? fallback
      if (pick) out.push(pick)
      continue
    }
    const stripped = line.replace(/^[(（]?\d+[)）.、:：\s]+/, '').trim()
    if (stripped) out.push(stripped)
  }
  return out
}

export default function PendingPastePanel({
  item, prioFor, onDone, onClose,
}: {
  item: PendingItemLike
  prioFor: (due: string) => string
  onDone: () => void
  onClose: () => void
}) {
  const [ops, setOps] = useState<Map<string, OpInfo>>(new Map())
  const [opsLoading, setOpsLoading] = useState(true)
  const [sheetRow, setSheetRow] = useState<InputRow | null>(null)
  const [rowLoading, setRowLoading] = useState(true)
  const [rowError, setRowError] = useState('')
  const [moNumber, setMoNumber] = useState('')
  const [text, setText] = useState('')
  const [appending, setAppending] = useState(false)
  const [msg, setMsg] = useState('')

  // 製程對照表（operation_times 全表約數百列，一次載入本機比對即可）
  useEffect(() => {
    void (async () => {
      try {
        const { data } = await supabase.from('operation_times').select('op_name,station,std_time_min')
        const m = new Map<string, OpInfo>()
        for (const r of (data ?? []) as { op_name: string; station: string | null; std_time_min: number | null }[]) {
          m.set(normOp(r.op_name), { station: r.station ?? '', std: Number(r.std_time_min ?? 0) })
        }
        setOps(m)
      } finally {
        setOpsLoading(false)
      }
    })()
  }, [])

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
        if (!hit) {
          setRowError(`在 ${item.sheet_date} 出單表找不到 ${item.order_number} / ${item.item_code}，工單號需手動填寫`)
        }
        setSheetRow(hit)
        setMoNumber(hit?.mo_number ?? '')
      } catch (e) {
        setRowError(`出單表載入失敗：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setRowLoading(false)
      }
    })()
  }, [item.sheet_date, item.order_number, item.item_code, item.line_seq, item.quantity])

  const parsed: ParsedOp[] = useMemo(() => {
    return parseProcessText(text, ops).map((name, i) => {
      const info = ops.get(normOp(name))
      return { seq: i + 1, op_name: name, station: info?.station ?? '', std: info?.std ?? 0, known: !!info }
    })
  }, [text, ops])

  const unknownOps = parsed.filter(p => !p.known).map(p => p.op_name)

  // 產生 SARA 工序列（與 process-gen 手動套用途程同一套規則）
  const saraRows: SaraRow[] = useMemo(() => {
    if (parsed.length === 0) return []
    const base: InputRow = sheetRow ?? {
      order_number: item.order_number, item_code: item.item_code, item_spec: item.item_spec,
      quantity: item.quantity, due: '', pan_count: 0, line_seq: item.line_seq || undefined,
      factory: (['T', 'C', 'O'].includes(item.factory) ? item.factory : undefined) as InputRow['factory'],
    }
    const mo = moNumber.trim() || base.order_number
    const today = fmtToday()
    return parsed.map(op => {
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
  }, [parsed, sheetRow, item, moNumber, prioFor])

  const handleAppend = useCallback(async () => {
    if (saraRows.length === 0) return
    if (unknownOps.length > 0 && !confirm(`有 ${unknownOps.length} 道製程在 operation_times 查無資料（站點/工時會是空白）：${unknownOps.slice(0, 5).join('、')}\n\n仍要加入交換區嗎？`)) return
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
      // 已送進交換區 → 從待處理清單移除（不再二次確認，避免打斷流程）
      await fetch('/api/sara/process-gen-pending', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [`${item.order_number}||${item.item_code}||${item.line_seq}`] }),
      })
      setMsg(`✅ 已加入交換區 ${saraRows.length} 列（累積 ${j.count} 列），此筆已從待處理移除`)
      onDone()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAppending(false)
    }
  }, [saraRows, unknownOps, moNumber, item, onDone])

  return (
    <div className="rounded-lg border border-emerald-800/50 bg-slate-900/80 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span>📋 貼上製程 — <span className="font-mono text-cyan-300">{item.order_number}{item.line_seq ? ` #${item.line_seq}` : ''}</span></span>
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

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={5}
        placeholder={'每行貼一道製程名稱（需與工序總表 operation_times 的製程名稱一致），例：\nUV印刷\n雷射切割\n包裝\n也可以貼「印刷→裁切→包裝」或從單品查詢／Excel 複製的表格'}
        className="w-full px-3 py-2 rounded bg-slate-950 border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-600/60"
      />

      {opsLoading && <div className="text-[11px] text-slate-500">載入工序總表中…</div>}

      {parsed.length > 0 && (
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
                <tr key={i} className={`border-t border-slate-800/60 ${parsed[i].known ? 'text-slate-300' : 'text-amber-300 bg-amber-950/30'}`}>
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

      {unknownOps.length > 0 && (
        <div className="text-[11px] text-amber-300">
          ⚠ {unknownOps.length} 道製程在工序總表查無資料（站點/工時空白，SARA 匯入需要站點）：{unknownOps.slice(0, 6).join('、')}{unknownOps.length > 6 ? '…' : ''}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => void handleAppend()}
          disabled={appending || saraRows.length === 0 || rowLoading}
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
