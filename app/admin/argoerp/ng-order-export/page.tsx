'use client'

/**
 * 瑕疵補印 → 製令工單
 *
 * 輸入銷售單號，直接向 ARGO 查詢該單所有項次（權威資料，非比對猜測），
 * 選擇要補印的項次、填入本次補印數量後建立製令。
 *
 * 寫入邏輯與「出單表→製令工單」相同（同一組 ARGO IFAF028 欄位對應、同一套製令總表寫入流程），
 * 差別只在製令單號：沿用完全相同的基礎編碼公式（MOT + 來源銷售單號日期 + 兩碼SO行號），
 * 但尾端加上 NG+流水號（NG1、NG2...），並在送出前用製令總表的 mo_number 唯一鍵當作
 * 「取號鎖」：先嘗試 insert 該候選單號，insert 成功才代表真的搶到這個編號、才送 ARGO；
 * 若被別人搶先（唯一鍵衝突）就重新取下一號重試，避免兩人同時補印同一張製令時撞號。
 */

import { useCallback, useState } from 'react'

const INTERFACE_ID = 'IFAF028'

interface SoLine {
  line_no: number | null
  description: string | null
  mbp_part: string | null
  duedate: string | null
  order_qty_oru: number | null
  unit_of_measure_oru: string | null
  remark: string | null
  packing: string | null
  remark2: string | null
  grade: string | null
  hold_status: string | null
}

interface SoMeta {
  project_id: string
  begin_date: string | null
  sales_name: string | null
  partner_name: string | null
  hold_status: string | null
  customer_remark: string | null
}

type RowResult = { mo_number: string; ok: boolean; message: string }

// ── 與「出單表→製令工單」完全相同的 IFAF028 欄位代碼對應 ──
const ERP_FIELD_CODE_MAP: Record<string, string> = {
  mo_number: 'PROJECT_ID',
  planned_start_date: 'BEGIN_DATE',
  planned_end_date: 'END_DATE',
  mo_status: 'HOLD_STATUS',
  department: 'SEG_SEGMENT_NO_DEPARTMENT',
  cost_department: 'PJT_SEG_SEGMENT_NO',
  seq_number: 'LINE_NO',
  product_code: 'MBP_PART',
  version: 'MBP_VER',
  lot_number: 'MBP_LOT_NO',
  planned_qty: 'ORDER_QTY',
  bom_level: 'BOM_LEVELS',
  product_cost_ratio: 'EQUIVALENT_RATIO',
  material_cost_ratio: 'EQUIVALENT_RATIO_M',
  source_order: 'PJT_PROJECT_ID_MO_SO',
  source_order_line: 'LINE_NO_MO_SO',
  mo_note: 'REMARK_LINE',
  create_date: 'MO_BEGIN_DATE',
  auto_material: 'AUTO_PREPARE',
}

function toErpPayload(row: Record<string, string>): Record<string, string> {
  const erp: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    const code = ERP_FIELD_CODE_MAP[key]
    if (!code) continue
    const v = (value ?? '').trim()
    if (!v) continue
    erp[code] = v
  }
  return erp
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function getNextBusinessDay(from: Date): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

// 與「出單表→製令工單」parseSoDateDigits 完全相同：英文前綴 + YYMMDD(+後綴)
function parseSoDateDigits(orderNumber: string): string | null {
  const m = orderNumber.match(/^[A-Za-z]+(.+)/)
  if (!m) return null
  return m[1]
}

function truncateByByteLength(text: string, maxBytes: number): string {
  if (!text) return ''
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
  return decoder.decode(bytes.slice(0, cut))
}

// 製令基礎單號：與「出單表→製令工單」mapAllToExport 相同公式
// MOT + 來源銷售單號日期(YYYYMMDD，無法解析則 fallback 今日) + 兩碼序號(SO行號)
function buildBaseMoNumber(projectId: string, lineNo: number): string {
  const today = new Date()
  const todayDateDigits = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  const soDateDigits = parseSoDateDigits(projectId) ?? todayDateDigits
  const seqStr = String(lineNo).padStart(2, '0')
  return `MOT${soDateDigits}${seqStr}`
}

async function fetchAllMoNumbers(): Promise<string[]> {
  const res = await fetch('/api/argoerp/mo-summary', { cache: 'no-store' })
  if (!res.ok) return []
  const j = await res.json().catch(() => null)
  const records: Array<{ mo_number?: string }> = j?.records ?? []
  return records.map(r => String(r.mo_number ?? '')).filter(Boolean)
}

// 找出「baseMo + NG + 數字」中已使用的最大流水號 + 1
function nextNgSeq(baseMo: string, existing: string[]): number {
  const re = new RegExp(`^${baseMo}NG(\\d+)$`)
  let max = 0
  for (const mo of existing) {
    const m = mo.match(re)
    if (!m) continue
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

export default function NgOrderExportPage() {
  const [soInput, setSoInput] = useState('')
  const [querying, setQuerying] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [meta, setMeta] = useState<SoMeta | null>(null)
  const [lines, setLines] = useState<SoLine[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [qtyByLine, setQtyByLine] = useState<Record<number, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<Record<number, RowResult>>({})
  const [msg, setMsg] = useState('')

  const handleQuery = useCallback(async () => {
    const projectId = soInput.trim().toUpperCase()
    if (!projectId) return
    setQuerying(true)
    setQueryError(null)
    setMeta(null)
    setLines([])
    setSelected(new Set())
    setQtyByLine({})
    setResults({})
    setMsg('')
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'query_so_detail', projectId }),
      })
      const j = await res.json()
      if (!res.ok || !j?.success) {
        setQueryError(j?.error || `查詢失敗（HTTP ${res.status}）`)
        return
      }
      const soLines: SoLine[] = Array.isArray(j.lines) ? j.lines : []
      if (soLines.length === 0) {
        setQueryError('查無明細資料')
        return
      }
      setMeta(j.meta)
      setLines(soLines)
      // 補印數量預設留空，強制使用者確認實際要補印的數量，不自動帶入原始訂單全數量
      const initQty: Record<number, string> = {}
      for (const l of soLines) {
        if (l.line_no != null) initQty[l.line_no] = ''
      }
      setQtyByLine(initQty)
    } catch (e) {
      setQueryError(e instanceof Error ? e.message : String(e))
    } finally {
      setQuerying(false)
    }
  }, [soInput])

  const toggleLine = useCallback((lineNo: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(lineNo)) next.delete(lineNo)
      else next.add(lineNo)
      return next
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!meta || selected.size === 0) return

    const invalid: number[] = []
    for (const lineNo of selected) {
      const qty = (qtyByLine[lineNo] ?? '').trim()
      if (!qty || isNaN(Number(qty)) || Number(qty) <= 0) invalid.push(lineNo)
    }
    if (invalid.length > 0) {
      alert(`請先填寫項次 ${invalid.join('、')} 的「本次補印數量」（需為正數）`)
      return
    }

    setSubmitting(true)
    setMsg('')
    const todayStr = formatDate(new Date())
    const nextBizDay = formatDate(getNextBusinessDay(new Date()))
    const newResults: Record<number, RowResult> = { ...results }
    const selectedLines = [...selected]

    for (const lineNo of selectedLines) {
      const line = lines.find(l => l.line_no === lineNo)
      if (!line) continue
      const qty = qtyByLine[lineNo].trim()
      const baseMo = buildBaseMoNumber(meta.project_id, lineNo)
      const noteText = `瑕疵補印(原製令 ${baseMo})：${[line.description, line.remark].filter(Boolean).join(' ')}`.slice(0, 500)

      // ── 取號鎖：以製令總表 mo_number 唯一鍵搶號，insert 成功才代表真的搶到 ──
      let claimedMo = ''
      let claimError = ''
      for (let attempt = 0; attempt < 8 && !claimedMo; attempt++) {
        const existing = await fetchAllMoNumbers()
        const seq = nextNgSeq(baseMo, existing)
        const candidateMo = `${baseMo}NG${seq}`
        const record = {
          mo_number: candidateMo,
          factory: 'T',
          planned_start_date: nextBizDay,
          planned_end_date: line.duedate || '',
          mo_status: 'OPEN',
          department: 'M1100',
          product_code: line.mbp_part || '',
          lot_number: truncateByByteLength(meta.project_id, 30),
          planned_qty: qty,
          source_order: meta.project_id,
          mo_note: noteText,
          create_date: todayStr,
          saved_at: new Date().toLocaleString('zh-TW'),
        }
        const saveRes = await fetch('/api/argoerp/mo-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: [record] }),
        })
        const saveJson = await saveRes.json().catch(() => ({}))
        if (saveRes.ok && saveJson.success) {
          claimedMo = candidateMo
          break
        }
        if (saveJson.duplicate) continue // 被搶先，重新取下一號
        claimError = saveJson.error || `寫入製令總表失敗（HTTP ${saveRes.status}）`
        break
      }

      if (!claimedMo) {
        newResults[lineNo] = { mo_number: '', ok: false, message: claimError || '多次嘗試取號失敗，請稍後再試' }
        setResults({ ...newResults })
        continue
      }

      // ── 取號成功 → 送出 ARGO IFAF028 ──
      const exportRow: Record<string, string> = {
        mo_number: claimedMo,
        planned_start_date: nextBizDay,
        planned_end_date: line.duedate || '',
        mo_status: 'OPEN',
        department: 'M1100',
        cost_department: 'M1000',
        seq_number: String(lineNo),
        product_code: line.mbp_part || '',
        version: '1',
        lot_number: truncateByByteLength(meta.project_id, 30),
        planned_qty: qty,
        bom_level: '99',
        product_cost_ratio: '1',
        material_cost_ratio: '1',
        source_order: meta.project_id,
        source_order_line: String(lineNo),
        mo_note: noteText,
        create_date: todayStr,
        auto_material: 'N',
      }
      const payload = [toErpPayload(exportRow)]

      try {
        const res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'import', interfaceId: INTERFACE_ID, data: payload }),
        })
        const j = await res.json()
        const isSuccess = res.ok && j?.success === true
        if (isSuccess) {
          newResults[lineNo] = { mo_number: claimedMo, ok: true, message: '已建立' }
          fetch('/api/argoerp/mo-upload-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rows: [{
                mo_number: claimedMo, factory: 'T', product_code: exportRow.product_code,
                planned_qty: qty, source_order: meta.project_id, lot_number: exportRow.lot_number,
                mo_note: exportRow.mo_note, planned_start_date: nextBizDay, planned_end_date: exportRow.planned_end_date,
                create_date: todayStr, interface_id: INTERFACE_ID,
              }],
            }),
          }).catch(() => {})
        } else {
          // ARGO 匯入失敗 → 釋放剛才搶到的 NG 編號，避免流水號被白白浪費
          await fetch('/api/argoerp/mo-summary', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mo_numbers: [claimedMo] }),
          }).catch(() => {})
          const errMsg = j?.error || j?.message || `ARGO 匯入失敗（HTTP ${res.status}）`
          newResults[lineNo] = { mo_number: '', ok: false, message: String(errMsg) }
        }
      } catch (e) {
        await fetch('/api/argoerp/mo-summary', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mo_numbers: [claimedMo] }),
        }).catch(() => {})
        newResults[lineNo] = { mo_number: '', ok: false, message: e instanceof Error ? e.message : String(e) }
      }
      setResults({ ...newResults })
    }

    const okCount = selectedLines.filter(ln => newResults[ln]?.ok).length
    setMsg(`完成：✅ 成功 ${okCount} 筆 / ❌ 失敗 ${selectedLines.length - okCount} 筆`)
    setSubmitting(false)

    if (okCount > 0) {
      // 背景同步製令資料，不阻塞畫面
      fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_mo', incrementalMinutes: 10 }),
      }).catch(() => {})
    }
  }, [meta, selected, qtyByLine, lines, results])

  const selectedCount = selected.size

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1400px] mx-auto">
        {/* ── Page Header ── */}
        <div className="mb-6 border-b border-slate-800 pb-4">
          <h1 className="text-3xl font-bold tracking-tight">瑕疵補印 → 製令工單</h1>
          <p className="text-slate-400 mt-1 text-sm">
            ArgoERP IFAF028｜輸入銷售單號查出全部項次，選擇要補印的項次並填入本次補印數量後建立製令。
            單號規則與「出單表→製令工單」相同，末端自動加上 NG+流水號（NG1、NG2…）。
          </p>
        </div>

        {/* ── 查詢列 ── */}
        <div className="flex items-center gap-3 mb-4">
          <input
            type="text"
            value={soInput}
            onChange={e => setSoInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !querying) handleQuery() }}
            placeholder="輸入銷售單號，例如 RO26050101"
            className="w-72 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white font-mono focus:outline-none focus:border-cyan-500"
          />
          <button
            onClick={handleQuery}
            disabled={querying || !soInput.trim()}
            className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors"
          >
            {querying ? '查詢中…' : '🔍 查詢'}
          </button>
        </div>

        {queryError && (
          <div className="mb-4 px-4 py-3 rounded-lg text-sm bg-red-900/30 border border-red-700 text-red-300">
            ⚠ {queryError}
          </div>
        )}

        {msg && (
          <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${msg.includes('失敗 0') ? 'bg-emerald-900/30 border border-emerald-700 text-emerald-300' : 'bg-amber-900/30 border border-amber-700 text-amber-300'}`}>
            {msg}
          </div>
        )}

        {/* ── SO 表頭資訊 ── */}
        {meta && (
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 rounded-lg bg-slate-900 border border-slate-800">
            <span className="text-lg font-bold font-mono text-cyan-300">{meta.project_id}</span>
            {meta.partner_name && <span className="text-slate-200 text-sm">{meta.partner_name}</span>}
            {meta.sales_name && <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs">業務：{meta.sales_name}</span>}
            {meta.begin_date && <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs">開立：{meta.begin_date}</span>}
            {meta.hold_status && (
              <span className="px-2 py-0.5 rounded bg-red-900/60 text-red-300 border border-red-700/50 text-xs">⛔ {meta.hold_status}</span>
            )}
            <span className="text-slate-600 text-xs">共 {lines.length} 項次</span>
          </div>
        )}

        {/* ── 項次列表 ── */}
        {lines.length > 0 && (
          <div className="rounded-lg border border-slate-800 overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-slate-400 text-xs">
                <tr>
                  <th className="px-3 py-2 w-10"></th>
                  <th className="px-3 py-2 text-left w-14">項次</th>
                  <th className="px-3 py-2 text-left">品名/規格</th>
                  <th className="px-3 py-2 text-left w-32">料號</th>
                  <th className="px-3 py-2 text-left w-28">原數量</th>
                  <th className="px-3 py-2 text-left w-40">本次補印數量</th>
                  <th className="px-3 py-2 text-left w-28">交貨日</th>
                  <th className="px-3 py-2 text-left w-48">結果</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => {
                  const lineNo = line.line_no ?? -1
                  const isChecked = selected.has(lineNo)
                  const result = results[lineNo]
                  const qty = qtyByLine[lineNo] ?? ''
                  const qtyExceeds = qty && line.order_qty_oru != null && Number(qty) > line.order_qty_oru
                  return (
                    <tr key={lineNo} className={`border-t border-slate-800 ${i % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/10'} ${line.hold_status ? 'bg-red-950/10' : ''}`}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={lineNo < 0 || submitting || result?.ok}
                          onChange={() => toggleLine(lineNo)}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-400">{line.line_no ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-200">
                        {line.description || <span className="text-slate-600 italic">（無品項名稱）</span>}
                        {line.hold_status && (
                          <span className="ml-2 px-1.5 py-0.5 rounded text-xs bg-red-900/60 text-red-300 border border-red-700/50">⛔ {line.hold_status}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-400">{line.mbp_part || '—'}</td>
                      <td className="px-3 py-2 font-mono text-slate-300">
                        {line.order_qty_oru != null ? line.order_qty_oru.toLocaleString() : '—'}
                        {line.unit_of_measure_oru && <span className="text-slate-500 text-xs ml-1">{line.unit_of_measure_oru}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="1"
                          value={qty}
                          disabled={submitting || result?.ok}
                          onChange={e => setQtyByLine(prev => ({ ...prev, [lineNo]: e.target.value }))}
                          placeholder="必填"
                          className={`w-24 px-2 py-1 rounded bg-slate-800 border text-white text-sm focus:outline-none ${qtyExceeds ? 'border-amber-500' : 'border-slate-600 focus:border-cyan-500'}`}
                        />
                        {qtyExceeds && <div className="text-amber-400 text-xs mt-0.5">⚠ 超過原數量</div>}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-400">{line.duedate || '—'}</td>
                      <td className="px-3 py-2">
                        {result?.ok && <span className="text-emerald-400 font-mono text-xs">✅ {result.mo_number}</span>}
                        {result && !result.ok && <span className="text-red-400 text-xs">❌ {result.message}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {lines.length > 0 && (
          <div className="flex items-center gap-3">
            <button
              onClick={handleSubmit}
              disabled={submitting || selectedCount === 0}
              className="px-5 py-2.5 rounded-lg bg-orange-700 hover:bg-orange-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold transition-colors"
            >
              {submitting ? '送出中…' : `🚀 送出瑕疵補印製令（已選 ${selectedCount} 筆）`}
            </button>
            <span className="text-slate-500 text-xs">送出後會依序為每個項次建立獨立的 NG 補印製令，請耐心等候完成</span>
          </div>
        )}
      </div>
    </div>
  )
}
