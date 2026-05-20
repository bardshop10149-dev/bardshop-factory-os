'use client'

/**
 * 出單表➜委外請購
 * ArgoERP 請購單介面 — IFAF043
 *
 * 請購單號規則：MPO + 銷售訂單數字部分 + 兩碼序號（SO 上的序號）
 * 欄位：APPLY_ID / APPLY_DATE / SEG_SEGMENT_NO_DEPARTMENT / HOLD_STATUS /
 *       REMARK / LINE_NO / MBP_PART / MBP_VER / UNIT_OF_MEASURE_ORU /
 *       ORDER_QTY_ORU / CURRENCY / DUEDATE
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import SoOrderModal from '../../../../components/SoOrderModal'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface SourceRow {
  row_key?: string
  order_number: string; doc_type: string; factory: 'T' | 'C' | 'O'
  receiver: string; is_sample: string; has_material: string
  designer: string; customer: string; line_nickname: string
  handler: string; issuer: string
  item_code: string; item_name: string; note: string
  quantity: string; delivery_date: string; plate_count: string
  upload_ro: string; order_status: string; pm_note: string
  // 從 daily_order_sheets 帶回的已匹配欄位
  match_status?: string
  match_line_no?: string | null
  match_pdl_seq?: number | null
  match_reason?: string | null
  mo_status?: string
}

interface PrHeader {
  department:     string   // SEG_SEGMENT_NO_DEPARTMENT
  hold_status:    'HOLD' | 'CLOSE' | 'UNSIGNED'
  interface_id:   string   // 請購單 ERP 介面 ID
}

interface LineEdit {
  mbp_ver:  string
  uom:      string
  currency: string
}

interface MatchResult {
  status:  'matched' | 'no_order' | 'no_qty_match'
  line_no: string | null
  reason:  string
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const HEADER_KEY = 'argoerp_pr_o_header_v1'

const ERP_KEYS = [
  'APPLY_ID', 'APPLY_DATE', 'SEG_SEGMENT_NO_DEPARTMENT', 'HOLD_STATUS',
  'REMARK', 'LINE_NO', 'MBP_PART', 'MBP_VER', 'UNIT_OF_MEASURE_ORU',
  'ORDER_QTY_ORU', 'CURRENCY', 'DUEDATE',
] as const

const DEF_LINE: LineEdit = { mbp_ver: '1', uom: 'PCS', currency: 'TWD' }

function fmtDate(d: Date) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function parseSoDigits(orderNumber: string): string {
  const m = orderNumber.match(/^[A-Za-z]+(\d+)/)
  return m ? m[1] : orderNumber.replace(/\D/g, '')
}

function makeDefaultHeader(): PrHeader {
  return { department: 'M1100', hold_status: 'UNSIGNED', interface_id: 'IFAF105' }
}

function buildApplyId(orderNumber: string, lineNo: string | null): string {
  const digits = parseSoDigits(orderNumber)
  const seq = lineNo ? String(Number(lineNo)).padStart(2, '0') : '00'
  return `MPO${digits}${seq}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export default function PrBatchExportOPage() {
  const [sourceRows, setSourceRows]     = useState<SourceRow[]>([])
  const [lineEdits, setLineEdits]       = useState<LineEdit[]>([])
  const [header, setHeader]             = useState<PrHeader>(makeDefaultHeader)
  const [headerOpen, setHeaderOpen]     = useState(false)
  const [matchResults, setMatchResults] = useState<MatchResult[]>([])
  const [matching, setMatching]         = useState(false)
  const [soModalId, setSoModalId]       = useState<string | null>(null)

  const [availDates, setAvailDates]     = useState<{ sheet_date: string; row_count: number }[]>([])
  const [datesLoading, setDatesLoading] = useState(false)
  const [pickerDate, setPickerDate]     = useState('')
  const [loadedDate, setLoadedDate]     = useState<string | null>(null)

  const [importing, setImporting]       = useState(false)
  const [msg, setMsg]                   = useState('')
  const [activeTab, setActiveTab]       = useState<'pending' | 'skip'>('pending')

  // ── 初始化表頭設定（不還原資料列）──
  useEffect(() => {
    try {
      const h = localStorage.getItem(HEADER_KEY)
      if (h) {
        const saved = JSON.parse(h) as Partial<PrHeader>
        setHeader(prev => ({ ...prev, ...saved }))
      }
    } catch {}
  }, [])
  useEffect(() => {
    localStorage.setItem(HEADER_KEY, JSON.stringify(header))
  }, [header])

  // ── 載入可用出單日期 ──
  useEffect(() => {
    setDatesLoading(true)
    fetch('/api/argoerp/daily-order-sheet')
      .then(r => r.json())
      .then(j => {
        if (j.success) {
          setAvailDates(j.sheets ?? [])
          if (!pickerDate && j.sheets?.length) setPickerDate(j.sheets[0].sheet_date)
        }
      })
      .catch(() => {})
      .finally(() => setDatesLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 載入出單表 ──
  const loadSheet = useCallback(async (date: string) => {
    if (!date) return
    try {
      const r = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`)
      const j = await r.json()
      if (!j.success || !j.sheet) { alert(`找不到 ${date} 的出單表`); return }
      const allORows = (j.sheet.rows ?? []).filter((x: SourceRow) => x.factory === 'O')
      if (allORows.length === 0) { alert(`${date} 出單表中沒有委外廠訂單`); return }
      setSourceRows(allORows)
      setLineEdits(allORows.map(() => ({ ...DEF_LINE })))
      setLoadedDate(date)
      // 套用出單表上預存的 SO 比對結果
      const hasMatch = allORows.some((r: SourceRow) => r.match_status)
      if (hasMatch) {
        setMatchResults(allORows.map((r: SourceRow) => ({
          status: (r.match_status as MatchResult['status']) || 'no_order',
          line_no: r.match_line_no ?? null,
          reason: r.match_reason ?? '',
        })))
      } else {
        setMatchResults([])
      }
    } catch (e) { alert(`載入失敗：${e}`) }
  }, [])

  // ── 執行 SO 序號比對 ──
  const runMatch = useCallback(async () => {
    if (sourceRows.length === 0) return
    setMatching(true); setMsg('')
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
      const sbKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      const sb = createClient(sbUrl, sbKey)

      const results: MatchResult[] = []
      const uomMap = new Map<number, string>() // rowIndex → unit_of_measure_oru
      // 追蹤已被拁走的 line_no，防止兩筆同商品同數量的明細都拁到同一行
      const claimedLines = new Map<string, Set<string>>() // project_id → Set<line_no>

      for (let idx = 0; idx < sourceRows.length; idx++) {
        const row = sourceRows[idx]
        const digits = parseSoDigits(row.order_number)
        const { data } = await sb
          .from('erp_so_lines')
          .select('line_no, pdl_seq, order_qty_oru, unit_of_measure_oru')
          .eq('project_id', row.order_number)
          .eq('mbp_part', row.item_code)
          .limit(10)

        const pickLine = (candidates: typeof data) => {
          if (!candidates || candidates.length === 0) return null
          const claimed = claimedLines.get(row.order_number) ?? new Set<string>()
          const qty = Number(row.quantity)
          // 先找尚未被拁走且數量符合的
          const best = candidates.find(
            r => !claimed.has(String(r.line_no)) && Math.abs(Number(r.order_qty_oru) - qty) < 0.01
          )
            // 如果沒有，取尚未被拁走的任一行
            ?? candidates.find(r => !claimed.has(String(r.line_no)))
            // 最後退而求其次：拁到數量符合的（已被拁）
            ?? candidates.find(r => Math.abs(Number(r.order_qty_oru) - qty) < 0.01)
            ?? candidates[0]
          if (best) {
            if (!claimedLines.has(row.order_number)) claimedLines.set(row.order_number, new Set())
            claimedLines.get(row.order_number)!.add(String(best.line_no))
          }
          return best ?? null
        }

        if (!data || data.length === 0) {
          // 嘗試只用數字部分比對 project_id
          const { data: d2 } = await sb
            .from('erp_so_lines')
            .select('line_no, pdl_seq, order_qty_oru, unit_of_measure_oru')
            .ilike('project_id', `%${digits}%`)
            .eq('mbp_part', row.item_code)
            .limit(10)
          if (!d2 || d2.length === 0) {
            results.push({ status: 'no_order', line_no: null, reason: '找不到對應 SO 明細' })
            continue
          }
          const hit = pickLine(d2)
          if (hit?.unit_of_measure_oru) uomMap.set(idx, hit.unit_of_measure_oru)
          results.push({
            status: hit ? 'matched' : 'no_qty_match',
            line_no: hit ? String(hit.line_no) : null,
            reason: hit ? '' : '數量不符',
          })
          continue
        }
        const hit = pickLine(data)
        if (hit?.unit_of_measure_oru) uomMap.set(idx, hit.unit_of_measure_oru)
        results.push({
          status: 'matched',
          line_no: String(hit!.line_no),
          reason: '',
        })
      }
      setMatchResults(results)
      if (uomMap.size > 0) {
        setLineEdits(prev => prev.map((e, i) => uomMap.has(i) ? { ...e, uom: uomMap.get(i)! } : e))
      }
      setMsg(`✅ 比對完成：${results.filter(r => r.status === 'matched').length}/${results.length} 筆已比對`)
      setTimeout(() => setMsg(''), 4000)
    } catch (e) {
      setMsg(`❌ 比對失敗：${e}`)
    } finally {
      setMatching(false)
    }
  }, [sourceRows])

  // ── ERP payload（每列本是一張請購單，LINE_NO 按同 APPLY_ID 塗縞遞増）──
  const payload = useMemo<Array<Record<string, string>>>(() => {
    const today = fmtDate(new Date())
    const lineCounters: Record<string, number> = {}
    return sourceRows.flatMap((row, i) => {
      if (row.mo_status === '無須轉請購') return []
      const e = lineEdits[i] ?? DEF_LINE
      const m = matchResults[i]
      const applyId = buildApplyId(row.order_number, m?.line_no ?? null)
      lineCounters[applyId] = (lineCounters[applyId] ?? 0) + 1
      const remark = [row.item_name, row.note].filter(Boolean).join(' ')
      const rec: Record<string, string> = {}
      rec['APPLY_ID']                   = applyId
      rec['APPLY_DATE']                 = today
      rec['SEG_SEGMENT_NO_DEPARTMENT']  = header.department.trim() || 'M1100'
      rec['HOLD_STATUS']                = header.hold_status
      if (remark) rec['REMARK']         = remark
      rec['LINE_NO']                    = String(lineCounters[applyId])
      rec['MBP_PART']                   = row.item_code
      rec['MBP_VER']                    = e.mbp_ver || '1'
      rec['UNIT_OF_MEASURE_ORU']        = e.uom || 'PCS'
      rec['ORDER_QTY_ORU']              = row.quantity
      rec['CURRENCY']                   = e.currency || 'TWD'
      rec['DUEDATE']                    = row.delivery_date
      return [rec]
    })
  }, [sourceRows, lineEdits, matchResults, header])

  // ── 匯入 ArgoERP ──
  const handleImport = useCallback(async () => {
    if (!header.interface_id.trim()) { alert('請填寫請購單介面 ID'); return }
    if (payload.length === 0) { alert('尚無明細資料'); return }
    if (!loadedDate) { alert('請先載入出單表'); return }
    setImporting(true); setMsg('')
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId: header.interface_id.trim(), data: payload }),
      })
      const json = await res.json().catch(() => ({}))
      if (json.status === 'success' || json.ok === true || res.ok) {
        setMsg(`✅ 成功匯入 ${payload.length} 筆請購單至 ArgoERP`)
        // 回寫出單表狀態
        await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheet_date: loadedDate,
            updates: sourceRows
              .filter(r => r.mo_status !== '無須轉請購')
              .map(r => ({ row_key: r.row_key, mo_status: '已匯入採單' }))
              .filter(u => u.row_key),
          }),
        })
      } else {
        setMsg(`❌ 匯入失敗：${json.error ?? json.message ?? '未知錯誤'}`)
      }
    } catch (e) {
      setMsg(`❌ 請求失敗：${e}`)
    } finally {
      setImporting(false)
    }
  }, [header.interface_id, payload, loadedDate, sourceRows])

  // ── 標記無須轉請購 ──
  const markSkip = useCallback((rowKey: string) => {
    if (!loadedDate || !rowKey) return
    setSourceRows(prev => prev.map(r => r.row_key === rowKey ? { ...r, mo_status: '無須轉請購' } : r))
    fetch('/api/argoerp/daily-order-sheet', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet_date: loadedDate, updates: [{ row_key: rowKey, mo_status: '無須轉請購' }] }),
    }).catch(() => {})
  }, [loadedDate])

  const markRestore = useCallback((rowKey: string) => {
    if (!loadedDate || !rowKey) return
    setSourceRows(prev => prev.map(r => r.row_key === rowKey ? { ...r, mo_status: '' } : r))
    fetch('/api/argoerp/daily-order-sheet', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet_date: loadedDate, updates: [{ row_key: rowKey, mo_status: '' }] }),
    }).catch(() => {})
  }, [loadedDate])

  // ─── UI ────────────────────────────────────────────────────────────────────────────
  const matchedCount = matchResults.filter(r => r.status === 'matched').length
  const pendingCount = sourceRows.filter(r => r.mo_status !== '無須轉請購').length
  const skipCount    = sourceRows.filter(r => r.mo_status === '無須轉請購').length

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      {/* 標題列 */}
      <div className="border-b border-slate-800/60 bg-slate-900/60 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-purple-300">出單表 ➜ 委外請購</h1>
          <p className="text-sm text-slate-400 mt-1">ArgoERP 請購單（{header.interface_id}）— 載入委外訂單 → 比對序號 → 匯入</p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/argoerp" className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm border border-slate-700">
            ← 返回發單作業區
          </Link>
        </div>
      </div>

      <div className="p-6 max-w-7xl space-y-5">

        {/* ── 表頭設定 ── */}
        <div className="rounded-xl border border-purple-700/40 bg-purple-950/20">
          <button
            className="w-full flex items-center justify-between px-5 py-3 text-left"
            onClick={() => setHeaderOpen(v => !v)}
          >
            <span className="font-semibold text-purple-200">⚙️ 請購單表頭設定</span>
            <span className="text-slate-400 text-sm">{headerOpen ? '▲ 收起' : '▼ 展開'}</span>
          </button>
          {headerOpen && (
            <div className="px-5 pb-5 grid grid-cols-2 md:grid-cols-4 gap-4 border-t border-purple-700/30">
              <div>
                <label className="block text-xs text-slate-400 mb-1">請購部門 <span className="text-red-400">*</span></label>
                <input
                  value={header.department}
                  onChange={e => setHeader(h => ({ ...h, department: e.target.value }))}
                  className="w-full px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-purple-500"
                  placeholder="M1100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">請購單狀態</label>
                <select
                  value={header.hold_status}
                  onChange={e => setHeader(h => ({ ...h, hold_status: e.target.value as PrHeader['hold_status'] }))}
                  className="w-full px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-purple-500"
                >
                  <option value="HOLD">HOLD</option>
                  <option value="CLOSE">CLOSE</option>
                  <option value="UNSIGNED">UNSIGNED</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">ERP 介面 ID <span className="text-red-400">*</span></label>
                <input
                  value={header.interface_id}
                  onChange={e => setHeader(h => ({ ...h, interface_id: e.target.value }))}
                  className="w-full px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-sm font-mono text-slate-200 focus:outline-none focus:border-purple-500"
                  placeholder="IFAF043"
                />
                <div className="text-[10px] text-slate-500 mt-0.5">請確認請購單介面 ID</div>
              </div>
              <div className="flex flex-col justify-end">
                <div className="text-xs text-slate-500">請購單號規則</div>
                <div className="font-mono text-purple-300 text-sm mt-0.5">MPO + SO數字 + 兩碼序號</div>
                <div className="text-[10px] text-slate-500 mt-0.5">序號取自 SO 比對結果</div>
              </div>
            </div>
          )}
        </div>

        {/* ── 載入出單表 ── */}
        <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-slate-300 font-medium">📋 載入出單表</span>
            {datesLoading ? (
              <span className="text-slate-500 text-sm">載入中…</span>
            ) : (
              <>
                <select
                  value={pickerDate}
                  onChange={e => setPickerDate(e.target.value)}
                  className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-sm text-slate-300 focus:outline-none focus:border-purple-500"
                >
                  <option value="">選擇出單日期…</option>
                  {availDates.map(s => (
                    <option key={s.sheet_date} value={s.sheet_date}>
                      {s.sheet_date}（{s.row_count} 筆）
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => loadSheet(pickerDate)}
                  disabled={!pickerDate}
                  className="px-4 py-1.5 rounded bg-purple-700 hover:bg-purple-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-colors"
                >
                  載入
                </button>
                {loadedDate && (
                  <span className="text-purple-300 text-xs px-2 py-1 bg-purple-900/30 rounded border border-purple-700/40">
                    已載入 {loadedDate}
                  </span>
                )}
              </>
            )}
            {sourceRows.length > 0 && (
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={runMatch}
                  disabled={matching}
                  className="px-3 py-1.5 rounded bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-sm transition-colors"
                >
                  {matching ? '比對中…' : matchResults.length > 0
                    ? `🔄 重新比對（${matchedCount}/${matchResults.length}）`
                    : '🔍 比對 SO 序號'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Tab 切換 ── */}
        {sourceRows.length > 0 && (
          <div className="flex gap-1 border-b border-slate-800">
            <button
              onClick={() => setActiveTab('pending')}
              className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === 'pending'
                  ? 'border-purple-400 text-purple-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              📋 待轉請購
              {pendingCount > 0 && <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-slate-700 text-slate-300">{pendingCount}</span>}
            </button>
            <button
              onClick={() => setActiveTab('skip')}
              className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === 'skip'
                  ? 'border-amber-400 text-amber-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              🚫 無須轉請購
              {skipCount > 0 && <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-amber-900/60 text-amber-300">{skipCount}</span>}
            </button>
          </div>
        )}

        {/* ── 明細表格（待轉請購 tab）── */}
        {sourceRows.length > 0 && activeTab === 'pending' && (
          <div className="rounded-xl border border-slate-700 bg-slate-900/40">
            <div className="px-4 py-3 border-b border-slate-700/60 bg-purple-900/20 flex items-center gap-3">
              <span className="font-semibold text-purple-200">委外請購明細</span>
              <span className="text-slate-400 text-sm">{pendingCount} 筆（待轉請購）</span>
              {matchResults.length > 0 && (
                <span className={`text-xs px-2 py-0.5 rounded border ${
                  matchedCount === sourceRows.length
                    ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40'
                    : 'bg-amber-900/40 text-amber-300 border-amber-700/40'
                }`}>
                  {matchedCount}/{sourceRows.length} 已比對
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-slate-900 text-slate-400 text-[11px] uppercase">
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">#</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap text-purple-300">請購單號 (APPLY_ID)</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">SO / 料號</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap min-w-[200px]">品名說明 (REMARK)</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">數量</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">版本</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">單位</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">幣別</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">預計交期</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">SO 比對</th>
                    <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceRows.map((row, i) => {
                    if (row.mo_status === '無須轉請購') return null
                    const m = matchResults[i]
                    const e = lineEdits[i] ?? DEF_LINE
                    const applyId = buildApplyId(row.order_number, m?.line_no ?? null)
                    const remark = [row.item_name, row.note].filter(Boolean).join(' ')
                    return (
                      <tr key={i} className="border-b border-slate-800/60 hover:bg-slate-900/40">
                        <td className="px-3 py-2 text-slate-500 text-xs">{i + 1}</td>
                        <td className="px-3 py-2 font-mono text-purple-300 text-xs whitespace-nowrap">
                          {applyId}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => setSoModalId(row.order_number)}
                            className="font-mono text-cyan-300 text-xs hover:underline block"
                          >
                            {row.order_number}
                          </button>
                          <div className="text-slate-400 text-[11px] font-mono">{row.item_code}</div>
                        </td>
                        <td className="px-3 py-2 text-slate-300 text-xs max-w-[250px]">
                          <div className="truncate" title={remark}>{remark || <span className="text-slate-600">—</span>}</div>
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-200 text-xs">{row.quantity}</td>
                        <td className="px-3 py-2">
                          <input
                            value={e.mbp_ver}
                            onChange={ev => setLineEdits(prev => {
                              const next = [...prev]; next[i] = { ...next[i], mbp_ver: ev.target.value }; return next
                            })}
                            className="w-12 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-slate-200 font-mono focus:outline-none focus:border-purple-500 text-center"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={e.uom}
                            onChange={ev => setLineEdits(prev => {
                              const next = [...prev]; next[i] = { ...next[i], uom: ev.target.value }; return next
                            })}
                            className="w-16 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-purple-500 text-center"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={e.currency}
                            onChange={ev => setLineEdits(prev => {
                              const next = [...prev]; next[i] = { ...next[i], currency: ev.target.value }; return next
                            })}
                            className="w-16 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-slate-200 font-mono focus:outline-none focus:border-purple-500 text-center"
                          />
                        </td>
                        <td className="px-3 py-2 font-mono text-amber-300 text-xs whitespace-nowrap">{row.delivery_date || '—'}</td>
                        <td className="px-3 py-2">
                          {!m ? (
                            <span className="text-slate-600 text-xs">—</span>
                          ) : m.status === 'matched' ? (
                            <span className="px-2 py-0.5 rounded border text-[10px] bg-emerald-900/40 text-emerald-300 border-emerald-700/40 font-mono">
                              seq {m.line_no}
                            </span>
                          ) : m.status === 'no_order' ? (
                            <span className="px-2 py-0.5 rounded border text-[10px] bg-red-900/30 text-red-300 border-red-800/40" title={m.reason}>
                              無 SO
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded border text-[10px] bg-amber-900/30 text-amber-300 border-amber-700/40" title={m.reason}>
                              數量不符
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => markSkip(row.row_key ?? '')}
                            disabled={!row.row_key}
                            title="標記為無須轉請購（不會列入匯入作業）"
                            className="px-1.5 py-0.5 rounded text-[11px] bg-slate-800 hover:bg-amber-900/60 text-slate-500 hover:text-amber-300 border border-slate-700 hover:border-amber-700 transition-colors disabled:opacity-40"
                          >
                            🚫
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── 無須轉請購 tab ── */}
        {activeTab === 'skip' && (
          <div className="rounded-xl border border-amber-700/40 bg-amber-950/10">
            <div className="px-4 py-3 border-b border-amber-800/40 bg-amber-950/20 flex items-center gap-3">
              <span className="font-semibold text-amber-200">🚫 無須轉請購</span>
              <span className="text-slate-400 text-sm">{skipCount} 筆</span>
              <span className="text-xs text-slate-500">以下訂單已標記為無須轉請購，不會列入匯入作業</span>
            </div>
            {skipCount === 0 ? (
              <div className="py-10 text-center text-slate-600 text-sm">尚無標記紀錄</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-900 text-slate-400 text-[11px] uppercase">
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">#</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">SO 工單號</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">料號</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap min-w-[180px]">品名說明</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">數量</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">預計交期</th>
                      <th className="px-3 py-2 border-b border-slate-800 text-left whitespace-nowrap">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sourceRows.map((row, i) => {
                      if (row.mo_status !== '無須轉請購') return null
                      const remark = [row.item_name, row.note].filter(Boolean).join(' ')
                      return (
                        <tr key={i} className="border-b border-slate-800/60 hover:bg-amber-950/20">
                          <td className="px-3 py-2 text-slate-500 text-xs">{i + 1}</td>
                          <td className="px-3 py-2">
                            <button onClick={() => setSoModalId(row.order_number)} className="font-mono text-cyan-300 text-xs hover:underline">
                              {row.order_number}
                            </button>
                          </td>
                          <td className="px-3 py-2 font-mono text-slate-400 text-xs">{row.item_code}</td>
                          <td className="px-3 py-2 text-slate-300 text-xs max-w-[250px]">
                            <div className="truncate" title={remark}>{remark || <span className="text-slate-600">—</span>}</div>
                          </td>
                          <td className="px-3 py-2 font-mono text-slate-200 text-xs">{row.quantity}</td>
                          <td className="px-3 py-2 font-mono text-amber-300 text-xs">{row.delivery_date || '—'}</td>
                          <td className="px-3 py-2">
                            <button
                              onClick={() => markRestore(row.row_key ?? '')}
                              disabled={!row.row_key}
                              className="px-2 py-1 rounded text-xs bg-slate-700 hover:bg-teal-700 text-slate-300 hover:text-white transition-colors disabled:opacity-50"
                            >
                              恢復待轉請購
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── 批次套用 ── */}
        {activeTab === 'pending' && sourceRows.length > 1 && (
          <div className="rounded-xl border border-slate-700 bg-slate-900/30 p-4">
            <div className="text-xs text-slate-400 mb-2">批次套用（套用至所有列）</div>
            <div className="flex flex-wrap gap-3 items-end">
              {(['currency', 'mbp_ver'] as (keyof LineEdit)[]).map(field => {
                const labels: Record<keyof LineEdit, string> = { uom: '單位', currency: '幣別', mbp_ver: '版本' }
                const placeholders: Record<keyof LineEdit, string> = { uom: 'PCS', currency: 'TWD', mbp_ver: '1' }
                return (
                  <div key={field} className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400">{labels[field]}</span>
                    <input
                      id={`bulk_${field}`}
                      placeholder={placeholders[field]}
                      className="w-20 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-purple-500"
                    />
                    <button
                      onClick={() => {
                        const val = (document.getElementById(`bulk_${field}`) as HTMLInputElement)?.value
                        if (!val?.trim()) return
                        setLineEdits(prev => prev.map(e => ({ ...e, [field]: val.trim() })))
                      }}
                      className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs text-slate-300"
                    >
                      套用
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── 操作列 ── */}
        {activeTab === 'pending' && sourceRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleImport}
              disabled={importing || payload.length === 0}
              className="px-5 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
            >
              {importing ? '匯入中…' : `🚀 匯入 ArgoERP（${payload.length} 筆）`}
            </button>
            {msg && (
              <span className={`text-sm px-3 py-1.5 rounded border ${
                msg.startsWith('✅') ? 'text-emerald-300 bg-emerald-900/30 border-emerald-700/40'
                  : msg.startsWith('❌') ? 'text-red-300 bg-red-900/30 border-red-700/40'
                  : 'text-amber-300 bg-amber-900/30 border-amber-700/40'
              }`}>
                {msg}
              </span>
            )}
          </div>
        )}

        {/* ── ERP 欄位預覽 ── */}
        {activeTab === 'pending' && payload.length > 0 && (
          <details className="rounded-xl border border-slate-700 bg-slate-900/30">
            <summary className="px-4 py-3 cursor-pointer text-sm text-slate-400 hover:text-slate-200 select-none">
              📄 ERP 欄位預覽（前 {Math.min(payload.length, 3)} 筆）
            </summary>
            <div className="px-4 pb-4 overflow-x-auto">
              <table className="text-xs font-mono border-collapse">
                <thead>
                  <tr className="text-slate-500">
                    {ERP_KEYS.map(k => <th key={k} className="px-3 py-1.5 border border-slate-800 text-left whitespace-nowrap">{k}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {payload.slice(0, 3).map((r, i) => (
                    <tr key={i} className="hover:bg-slate-800/50">
                      {ERP_KEYS.map(k => (
                        <td key={k} className="px-3 py-1.5 border border-slate-800 text-slate-300 whitespace-nowrap">
                          {r[k] || <span className="text-slate-600">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {/* ── 空白狀態 ── */}
        {sourceRows.length === 0 && (
          <div className="text-center py-20 text-slate-600">
            <div className="text-5xl mb-4">📦</div>
            <div className="text-lg">請先載入出單表</div>
            <div className="text-sm mt-1">選擇日期後點擊「載入」，篩選委外廠（O）訂單</div>
          </div>
        )}
      </div>

      {soModalId && (
        <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />
      )}
    </main>
  )
}

/* ── 以下為舊版 wrapper（已停用）── */
function _LegacyWrapper() {
  return (
    <FactoryOrderExportPage
      factory="O"
      title="出單表➜委外請購"
      subtitle="ArgoERP — 載入出單表（委外訂單）→ 比對序號 → 匯入 IFAF044 採購單"
      storageKey="argoerp_order_batch_o_v1"
      failedKey="argoerp_order_batch_o_failed_v1"
      theme={{
        accent:       'text-purple-300',
        accentBg:     'bg-purple-900/40',
        accentBorder: 'border-purple-700/50',
        btn:          'bg-purple-700 hover:bg-purple-600',
        headerBg:     'bg-purple-900/30',
      }}
      hideImport
    />
  )
}
