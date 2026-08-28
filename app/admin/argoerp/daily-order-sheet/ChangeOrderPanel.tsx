'use client'

// 改單專區：引導式改單精靈。
// 流程：輸入銷售單號 → 查詢帶出 erp_so_lines + 所有出單表日期上的相關列 → 選定序號 →
// 顯示所有相關單據（完整欄位）→ 多選改單類型（日期/數量/品項編碼/生產廠區）→ 預覽 → 套用
// → （若牽涉廠區切換）重新轉單 → 同步至 SARA 交換區。每次套用都會寫入 order_change_log。

import { useCallback, useState } from 'react'
import {
  getImportConfig,
  toErpPayload,
  mapMoExportRowsT,
  mapPoExportRowsCO,
  type SoMatchResult,
} from '../../../../lib/argoerp/moExportShared'
import { buildSaraRow, type SaraRow } from '../../../../lib/sara/buildSaraRow'

// ── 型別 ──────────────────────────────────────────────────────────────────

interface SoLine {
  project_id: string
  begin_date: string | null
  sales_name: string | null
  partner_name: string | null
  customer_remark: string | null
  line_no: number | string | null
  description: string | null
  mbp_part: string | null
  duedate: string | null
  order_qty_oru: number | string | null
  unit_of_measure_oru: string | null
  remark: string | null
  packing: string | null
  remark2: string | null
  hold_status: string | null
}

interface SheetRowRec {
  order_number?: string
  line_no_input?: string
  doc_type?: string
  factory?: 'T' | 'C' | 'O'
  item_code?: string
  item_name?: string
  note?: string
  quantity?: string
  delivery_date?: string
  row_key?: string
  mo_status?: string | null
  mo_number?: string
  po_number?: string | null
  po_sub_no?: string | null
  po_status?: string | null
  pr_number?: string | null
  pr_sub_no?: string | null
  pr_status?: string | null
  match_line_no?: string | null
  material_prep_status?: string | null
  argo_slip_no?: string | null
  machine?: string
  [k: string]: unknown
}

interface SheetRowHit {
  sheet_date: string
  row: SheetRowRec
}

interface ChangeNotice {
  id: string
  changed_fields: string[]
  old_values: Record<string, unknown>
  new_values: Record<string, unknown>
  detected_at: string
}

type ChangeType = 'date' | 'quantity' | 'item_code' | 'factory'

const CHANGE_TYPE_LABELS: Record<ChangeType, string> = {
  date: '交期',
  quantity: '數量',
  item_code: '品項編碼',
  factory: '生產廠區',
}

const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外' }

function fmtQty(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

// ── 元件 ──────────────────────────────────────────────────────────────────

interface Props {
  // 套用更正成功後通知外層（daily-order-sheet 主頁），讓「每日出單表」分頁若剛好開在
  // 受影響的日期，能立即重新載入該日資料，不用手動切換日期或整頁重新整理才看得到最新結果
  // （2026-08-26 使用者回報：改單專區改了廠區，切回出單表分頁卻沒有變，根源是這裡完全
  // 沒有通知主頁刷新，主頁的 sheetRows 還停在套用前查到的舊狀態）
  onApplied?: (affectedSheetDates: string[]) => void
}

export default function ChangeOrderPanel({ onApplied }: Props) {
  // 查詢
  const [orderNumberInput, setOrderNumberInput] = useState('')
  const [queriedOrderNumber, setQueriedOrderNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [soLines, setSoLines] = useState<SoLine[]>([])
  const [sheetRowsByLine, setSheetRowsByLine] = useState<Record<string, SheetRowHit[]>>({})
  const [moSummary, setMoSummary] = useState<Record<string, unknown>[]>([])
  const [changeNotices, setChangeNotices] = useState<ChangeNotice[]>([])

  // 選定序號
  const [selectedLineNo, setSelectedLineNo] = useState<string | null>(null)

  // 改單類型 + 新值
  const [changeTypes, setChangeTypes] = useState<Set<ChangeType>>(new Set())
  const [newDate, setNewDate] = useState('')
  const [newQuantity, setNewQuantity] = useState('')
  const [newItemCode, setNewItemCode] = useState('')
  const [newFactory, setNewFactory] = useState<'T' | 'C' | 'O'>('T')

  // 套用
  const [applying, setApplying] = useState(false)
  const [applyMsg, setApplyMsg] = useState('')
  const [needsRedocument, setNeedsRedocument] = useState(false)
  const [lastLogId, setLastLogId] = useState<number | null>(null)
  const [lastUpdatedRows, setLastUpdatedRows] = useState<Array<Record<string, unknown>>>([])

  // 重新轉單 / SARA 同步
  const [redocumenting, setRedocumenting] = useState(false)
  const [redocumentMsg, setRedocumentMsg] = useState('')
  const [saraSyncing, setSaraSyncing] = useState(false)
  const [saraSyncMsg, setSaraSyncMsg] = useState('')

  const resetSelection = () => {
    setSelectedLineNo(null)
    setChangeTypes(new Set())
    setNewDate(''); setNewQuantity(''); setNewItemCode(''); setNewFactory('T')
    setApplyMsg(''); setNeedsRedocument(false); setLastLogId(null); setLastUpdatedRows([])
    setRedocumentMsg(''); setSaraSyncMsg('')
  }

  const handleQuery = useCallback(async () => {
    const orderNumber = orderNumberInput.trim()
    if (!orderNumber) return
    setLoading(true)
    setLoadError('')
    setSoLines([]); setSheetRowsByLine({}); setMoSummary([]); setChangeNotices([])
    resetSelection()
    try {
      const res = await fetch(`/api/argoerp/change-order?order_number=${encodeURIComponent(orderNumber)}`, { cache: 'no-store' })
      const json = await res.json() as {
        success: boolean; error?: string
        so_lines?: SoLine[]; sheet_rows_by_line?: Record<string, SheetRowHit[]>
        mo_summary?: Record<string, unknown>[]; change_notices?: ChangeNotice[]
      }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      if (!json.so_lines?.length && !Object.keys(json.sheet_rows_by_line ?? {}).length) {
        setLoadError(`查無銷售單號「${orderNumber}」的資料（ERP 同步表與出單表皆無）`)
        return
      }
      setSoLines(json.so_lines ?? [])
      setSheetRowsByLine(json.sheet_rows_by_line ?? {})
      setMoSummary(json.mo_summary ?? [])
      setChangeNotices(json.change_notices ?? [])
      setQueriedOrderNumber(orderNumber)
    } catch (e) {
      setLoadError(`查詢失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [orderNumberInput])

  // 所有出現過的序號（合併 erp_so_lines 的序號 + 出單表已知序號，確保集單等未同步到 erp_so_lines 的單也選得到）
  const allLineNos = (() => {
    const set = new Set<string>()
    soLines.forEach(l => { if (l.line_no !== null && l.line_no !== undefined) set.add(String(l.line_no)) })
    Object.keys(sheetRowsByLine).forEach(k => set.add(k))
    return [...set].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
  })()

  const selectLine = (lineNo: string) => {
    resetSelection()
    setSelectedLineNo(lineNo)
    const hits = sheetRowsByLine[lineNo] ?? []
    const latest = hits[0]?.row
    if (latest) {
      setNewDate(latest.delivery_date ?? '')
      setNewQuantity(latest.quantity ?? '')
      setNewItemCode(latest.item_code ?? '')
      setNewFactory((latest.factory as 'T' | 'C' | 'O') ?? 'T')
    }
  }

  const toggleChangeType = (t: ChangeType) => {
    setChangeTypes(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
  }

  const selectedSoLine = soLines.find(l => String(l.line_no) === selectedLineNo)
  const selectedHits = selectedLineNo ? (sheetRowsByLine[selectedLineNo] ?? []) : []
  const latestRow = selectedHits[0]?.row

  const handleApply = useCallback(async () => {
    if (!selectedLineNo || changeTypes.size === 0) return
    setApplying(true)
    setApplyMsg('')
    try {
      const changes: Record<string, string> = {}
      if (changeTypes.has('date')) changes.delivery_date = newDate
      if (changeTypes.has('quantity')) changes.quantity = newQuantity
      if (changeTypes.has('item_code')) changes.item_code = newItemCode
      if (changeTypes.has('factory')) changes.factory = newFactory

      const res = await fetch('/api/argoerp/change-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_number: queriedOrderNumber, line_no: selectedLineNo, changes }),
      })
      const json = await res.json() as {
        success: boolean; error?: string; log_id?: number
        affected_sheet_dates?: string[]; updated_rows?: Array<Record<string, unknown>>
        needs_redocument?: boolean
      }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setApplyMsg(`✅ 已更正 ${json.affected_sheet_dates?.length ?? 0} 個日期的資料`)
      setNeedsRedocument(!!json.needs_redocument)
      setLastLogId(json.log_id ?? null)
      setLastUpdatedRows(json.updated_rows ?? [])
      // 重新查詢，讓下方表格反映最新狀態
      await handleQuery()
      setSelectedLineNo(selectedLineNo)
      onApplied?.(json.affected_sheet_dates ?? [])
    } catch (e) {
      setApplyMsg(`❌ 套用失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplying(false)
    }
  }, [selectedLineNo, changeTypes, newDate, newQuantity, newItemCode, newFactory, queriedOrderNumber, handleQuery, onApplied])

  // ── 重新轉單：依更正後最新資料，用共用匯出函式建立正確的製令/採購/請購單 ──
  const handleRedocument = useCallback(async () => {
    if (!selectedLineNo || lastUpdatedRows.length === 0) return
    setRedocumenting(true)
    setRedocumentMsg('')
    try {
      // updated_rows 依 sheet_date 由新到舊排序（沿用查詢時的排序），取第一筆＝最新日期的資料
      const src = lastUpdatedRows[0] as SheetRowRec
      const factory = (src.factory as 'T' | 'C' | 'O') ?? 'T'
      const matchResults: SoMatchResult[] = [{ line_no: selectedLineNo, pdl_seq: null, status: 'matched', reason: '改單專區人工改單' }]
      const exportSrc = {
        order_number: queriedOrderNumber,
        factory,
        item_code: src.item_code ?? '',
        item_name: src.item_name ?? '',
        note: src.note ?? '',
        quantity: src.quantity ?? '',
        delivery_date: src.delivery_date ?? '',
        line_no_input: selectedLineNo,
      }
      const rows = factory === 'T'
        ? mapMoExportRowsT([exportSrc], matchResults)
        : mapPoExportRowsCO([exportSrc], matchResults)
      const payload = toErpPayload(rows)
      const { interfaceId, targetLabel } = getImportConfig(factory)

      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId, data: payload }),
      })
      const json = await res.json() as { success: boolean; error?: string }
      if (!json.success) throw new Error(json.error || '匯入失敗')

      const generatedNumber = rows[0].mo_number
      const docUpdate: Record<string, unknown> = {}
      if (factory === 'T') { docUpdate.mo_number = generatedNumber; docUpdate.mo_status = '已匯入製令' }
      else if (factory === 'C') { docUpdate.po_number = generatedNumber }
      else { docUpdate.pr_number = generatedNumber }

      // 把新單號寫回每個受影響日期的那一列
      const sheetDates = [...new Set(lastUpdatedRows.map(r => String((r as { sheet_date?: string }).sheet_date ?? '')))].filter(Boolean)
      for (const sheetDate of sheetDates) {
        const rowKey = (lastUpdatedRows.find(r => (r as { sheet_date?: string }).sheet_date === sheetDate) as { row_key?: string } | undefined)?.row_key
        if (!rowKey) continue
        await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet_date: sheetDate, updates: [{ row_key: rowKey, ...docUpdate }] }),
        })
      }

      if (lastLogId) {
        await fetch('/api/argoerp/change-order', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ log_id: lastLogId, redocumented: true }),
        })
      }

      setRedocumentMsg(`✅ 已建立新的${targetLabel}：${generatedNumber}`)
      await handleQuery()
      setSelectedLineNo(selectedLineNo)
    } catch (e) {
      setRedocumentMsg(`❌ 重新轉單失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRedocumenting(false)
    }
  }, [selectedLineNo, lastUpdatedRows, queriedOrderNumber, lastLogId, handleQuery])

  // ── 同步至 SARA：移除交換區裡「這張訂單＋這個序號」的舊列，加入更正後的新列
  //    （途程留空，需至 process-gen 補；其他序號、其他訂單的既有列不受影響）──
  const handleSaraSync = useCallback(async () => {
    if (!selectedLineNo) return
    const src = (lastUpdatedRows[0] ?? latestRow) as SheetRowRec | undefined
    if (!src) return
    setSaraSyncing(true)
    setSaraSyncMsg('')
    try {
      const getRes = await fetch('/api/sara/exchange-csv', { cache: 'no-store' })
      const getJson = await getRes.json() as { success: boolean; rows?: string[][]; error?: string }
      if (!getJson.success) throw new Error(getJson.error || '讀取交換區失敗')
      const existing = getJson.rows ?? []
      // 只移除「這張銷售單號 + 這個序號」的舊列（第 0 欄 Order Number + 第 4 欄 Lot Number），
      // 不能只比對單號——同一張單可能有好幾個序號，只改了其中一個，其他序號已同步的列不該被清掉。
      const kept = existing.filter(r => !(r[0] === queriedOrderNumber && r[4] === selectedLineNo))

      // 常平/委外的採購/請購單是整張單共用、不分行，同一張單同一品項可能開多筆銷售單序號；
      // 若原樣送裸單號給 SARA，Manufacturing Order Number + Product Name 會跟同單其他序號
      // 完全相同，SARA 只會留下最後一筆。一律加上「-行號」（po_sub_no/pr_sub_no）唯一識別。
      const coRefNumber = src.factory === 'C'
        ? (src.po_number ? `${src.po_number}${src.po_sub_no ? `-${src.po_sub_no}` : ''}` : undefined)
        : src.factory === 'O'
          ? (src.pr_number ? `${src.pr_number}${src.pr_sub_no ? `-${src.pr_sub_no}` : ''}` : undefined)
          : undefined
      const saraRow: SaraRow = {
        order_number: queriedOrderNumber,
        mfg_order_number: src.mo_number || coRefNumber || queriedOrderNumber,
        product_name: src.item_code ?? '',
        product_desc: src.item_name ?? '',
        lot_number: selectedLineNo,
        prod_qty: Number(String(src.quantity ?? '0').replace(/,/g, '')) || 0,
        due: src.delivery_date ?? '',
        priority: '',
        earliest_start: '',
        job_seq: '',
        workcenter: '',
        job_name: '',
        job_qty: Number(String(src.quantity ?? '0').replace(/,/g, '')) || 0,
        outsourcing: '',
        est_time: 0,
        time_unit: '分鐘',
        bom: '',
        mat_req_qty: '',
        customer: selectedSoLine?.partner_name ?? undefined,
        assigned_machine: src.machine ?? undefined,
        factory: src.factory,
      }
      const newRow = buildSaraRow(saraRow)

      const postRes = await fetch('/api/sara/exchange-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: [...kept, newRow], append: false }),
      })
      const postJson = await postRes.json() as { success: boolean; count?: number; error?: string }
      if (!postJson.success) throw new Error(postJson.error || '寫入交換區失敗')

      if (lastLogId) {
        await fetch('/api/argoerp/change-order', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ log_id: lastLogId, sara_synced: true }),
        })
      }
      setSaraSyncMsg(`✅ 已同步至 SARA 交換區（累積 ${postJson.count} 列；途程/站點留空，請至「SARA 工序格式產生器」補上並下載匯入塔台）`)
    } catch (e) {
      setSaraSyncMsg(`❌ 同步失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaraSyncing(false)
    }
  }, [selectedLineNo, lastUpdatedRows, latestRow, queriedOrderNumber, selectedSoLine, lastLogId])

  // ── 渲染 ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <div className="bg-amber-950/20 border border-amber-800/40 rounded-xl px-4 py-3 text-xs text-amber-200/90">
        引導式改單窗口：輸入銷售單號查詢 → 選定序號 → 勾選要更正的項目 → 套用（會自動更正出單表原始資料，
        若切換廠區會清除舊廠區的製令/採購/請購單並提示重新轉單）→ 需要的話「重新轉單」、「同步至 SARA」。
        每次更正都會記錄在改單紀錄裡。
      </div>

      {/* 查詢 */}
      <div className="flex flex-wrap items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
        <label className="text-xs text-slate-400 whitespace-nowrap">銷售單號</label>
        <input
          value={orderNumberInput}
          onChange={e => setOrderNumberInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleQuery() }}
          placeholder="例：SOA260101-001"
          className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-amber-500 w-64"
        />
        <button
          onClick={() => void handleQuery()}
          disabled={loading || !orderNumberInput.trim()}
          className="px-4 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {loading ? '⏳ 查詢中…' : '查詢'}
        </button>
        {loadError && <span className="text-red-400 text-sm">{loadError}</span>}
      </div>

      {queriedOrderNumber && (
        <>
          {/* 單頭資訊 */}
          {soLines[0] && (
            <div className="flex flex-wrap gap-4 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-300">
              <span>客戶：<span className="text-slate-100">{soLines[0].partner_name ?? '—'}</span></span>
              <span>業務：<span className="text-slate-100">{soLines[0].sales_name ?? '—'}</span></span>
              <span>下單日：<span className="text-slate-100">{soLines[0].begin_date ?? '—'}</span></span>
              {soLines[0].customer_remark && <span>客戶備註：<span className="text-slate-100">{soLines[0].customer_remark}</span></span>}
            </div>
          )}

          {/* 改單偵測警示 */}
          {changeNotices.length > 0 && (
            <div className="px-4 py-3 bg-red-600/20 border-2 border-red-500/70 rounded-lg text-xs text-red-100 space-y-1">
              <div className="font-bold">⚠️ ARGO 端偵測到這張訂單有未確認的改單，請一併確認：</div>
              {changeNotices.map(n => (
                <div key={n.id}>・{n.changed_fields.join('、')}（{new Date(n.detected_at).toLocaleString('zh-TW')}）</div>
              ))}
            </div>
          )}

          {/* 序號選擇 */}
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs text-slate-400">序號</span>
            {allLineNos.map(ln => (
              <button
                key={ln}
                onClick={() => selectLine(ln)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  selectedLineNo === ln
                    ? 'bg-amber-700 border-amber-500 text-white'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-amber-600'
                }`}
              >
                #{ln}
                {!sheetRowsByLine[ln]?.length && <span className="ml-1 text-slate-500">（未出單）</span>}
              </button>
            ))}
            {allLineNos.length === 0 && <span className="text-xs text-slate-500">查無序號資料</span>}
          </div>

          {selectedLineNo && (
            <div className="space-y-4">
              {/* ERP 銷售訂單明細 */}
              {selectedSoLine && (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                  <div className="text-xs font-bold text-slate-300 mb-2">ERP 銷售訂單明細（序號 #{selectedLineNo}）</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div>料號：<span className="text-slate-100">{selectedSoLine.mbp_part ?? '—'}</span></div>
                    <div>品名規格：<span className="text-slate-100">{selectedSoLine.description ?? '—'}</span></div>
                    <div>數量：<span className="text-slate-100">{fmtQty(selectedSoLine.order_qty_oru)} {selectedSoLine.unit_of_measure_oru ?? ''}</span></div>
                    <div>交期：<span className="text-slate-100">{selectedSoLine.duedate ?? '—'}</span></div>
                    <div>包裝：<span className="text-slate-100">{selectedSoLine.packing ?? '—'}</span></div>
                    <div>狀態：<span className="text-slate-100">{selectedSoLine.hold_status ?? '—'}</span></div>
                    <div className="col-span-2">備註：<span className="text-slate-100">{selectedSoLine.remark ?? selectedSoLine.remark2 ?? '—'}</span></div>
                  </div>
                </div>
              )}

              {/* 出單表相關列（跨所有日期） */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 overflow-x-auto">
                <div className="text-xs font-bold text-slate-300 mb-2">出單表相關列（共 {selectedHits.length} 筆，跨所有日期）</div>
                {selectedHits.length === 0 ? (
                  <div className="text-xs text-slate-500">這個序號尚未出現在任何出單表裡</div>
                ) : (
                  <table className="w-full text-xs text-left border-collapse min-w-max">
                    <thead>
                      <tr className="text-slate-400 border-b border-slate-800">
                        <th className="px-2 py-1.5">日期</th>
                        <th className="px-2 py-1.5">廠區</th>
                        <th className="px-2 py-1.5">品號</th>
                        <th className="px-2 py-1.5">數量</th>
                        <th className="px-2 py-1.5">交期</th>
                        <th className="px-2 py-1.5">製令</th>
                        <th className="px-2 py-1.5">採購單</th>
                        <th className="px-2 py-1.5">請購單</th>
                        <th className="px-2 py-1.5">備料狀態</th>
                        <th className="px-2 py-1.5">機台</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedHits.map(({ sheet_date, row }) => (
                        <tr key={sheet_date} className="border-b border-slate-800/50">
                          <td className="px-2 py-1.5 text-slate-300">{sheet_date}</td>
                          <td className="px-2 py-1.5">{row.factory ? FACTORY_LABEL[row.factory] : '—'}</td>
                          <td className="px-2 py-1.5">{row.item_code ?? '—'}</td>
                          <td className="px-2 py-1.5">{row.quantity ?? '—'}</td>
                          <td className="px-2 py-1.5">{row.delivery_date ?? '—'}</td>
                          <td className="px-2 py-1.5">{row.mo_number ?? '—'}</td>
                          <td className="px-2 py-1.5">{row.po_number ?? '—'}</td>
                          <td className="px-2 py-1.5">{row.pr_number ?? '—'}</td>
                          <td className="px-2 py-1.5">{row.material_prep_status ?? '—'}</td>
                          <td className="px-2 py-1.5">{row.machine ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* argoerp_mo_summary 對應列 */}
              {moSummary.some(m => m.mo_number === latestRow?.mo_number) && (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs">
                  <div className="font-bold text-slate-300 mb-2">ARGO 製令總表（argoerp_mo_summary）</div>
                  {moSummary.filter(m => m.mo_number === latestRow?.mo_number).map((m, i) => (
                    <pre key={i} className="text-slate-300 whitespace-pre-wrap break-all">{JSON.stringify(m, null, 2)}</pre>
                  ))}
                </div>
              )}

              {/* 改單類型多選 */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="text-xs font-bold text-slate-300">要更正的項目（可複選）</div>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(CHANGE_TYPE_LABELS) as ChangeType[]).map(t => (
                    <button
                      key={t}
                      onClick={() => toggleChangeType(t)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        changeTypes.has(t)
                          ? 'bg-amber-700 border-amber-500 text-white'
                          : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-amber-600'
                      }`}
                    >
                      {changeTypes.has(t) ? '✓ ' : ''}{CHANGE_TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>

                {changeTypes.size > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-800">
                    {changeTypes.has('date') && (
                      <label className="text-xs text-slate-400 flex flex-col gap-1">
                        新交期
                        <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                          className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-amber-500" />
                      </label>
                    )}
                    {changeTypes.has('quantity') && (
                      <label className="text-xs text-slate-400 flex flex-col gap-1">
                        新數量
                        <input value={newQuantity} onChange={e => setNewQuantity(e.target.value)}
                          className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-amber-500" />
                      </label>
                    )}
                    {changeTypes.has('item_code') && (
                      <label className="text-xs text-slate-400 flex flex-col gap-1">
                        新品項編碼
                        <input value={newItemCode} onChange={e => setNewItemCode(e.target.value)}
                          className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-amber-500" />
                      </label>
                    )}
                    {changeTypes.has('factory') && (
                      <label className="text-xs text-slate-400 flex flex-col gap-1">
                        新生產廠區
                        <select value={newFactory} onChange={e => setNewFactory(e.target.value as 'T' | 'C' | 'O')}
                          className="bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-amber-500">
                          <option value="T">台北</option>
                          <option value="C">常平</option>
                          <option value="O">委外</option>
                        </select>
                      </label>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={() => void handleApply()}
                    disabled={applying || changeTypes.size === 0}
                    className="px-5 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-sm font-semibold"
                  >
                    {applying ? '⏳ 套用中…' : '✓ 套用更正'}
                  </button>
                  {applyMsg && <span className={`text-xs ${applyMsg.startsWith('❌') ? 'text-red-400' : 'text-emerald-400'}`}>{applyMsg}</span>}
                </div>
              </div>

              {/* 重新轉單 / SARA 同步 */}
              {lastLogId && (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
                  <div className="text-xs font-bold text-slate-300">後續動作</div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={() => void handleRedocument()}
                      disabled={redocumenting}
                      className={`px-4 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-50 ${needsRedocument ? 'bg-red-700 hover:bg-red-600' : 'bg-slate-700 hover:bg-slate-600'}`}
                    >
                      {redocumenting ? '⏳ 轉單中…' : needsRedocument ? '⚠ 重新轉單（廠區已變更，單據已失效）' : '重新轉單'}
                    </button>
                    <button
                      onClick={() => void handleSaraSync()}
                      disabled={saraSyncing}
                      className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold"
                    >
                      {saraSyncing ? '⏳ 同步中…' : '➕ 同步至 SARA 交換區'}
                    </button>
                  </div>
                  {redocumentMsg && <div className={`text-xs ${redocumentMsg.startsWith('❌') ? 'text-red-400' : 'text-emerald-400'}`}>{redocumentMsg}</div>}
                  {saraSyncMsg && <div className={`text-xs ${saraSyncMsg.startsWith('❌') ? 'text-red-400' : 'text-emerald-400'}`}>{saraSyncMsg}</div>}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
