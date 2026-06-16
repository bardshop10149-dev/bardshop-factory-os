'use client'

/**
 * 單獨開立➜請購單
 * ArgoERP IFAF105 — 請購單（PR）介面
 *
 * 與「出單表➜委外請購」相同的 ERP 介面，但不從每日出單表載入，
 * 而是手動輸入「銷售訂單號 + 序號」從 erp_so_lines 帶入明細，
 * 單獨開立一張請購單。
 *
 * 請購單號格式：MPO + YYYYMMDD + 2位流水（例：MPO2026061201）
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

interface PrHeader {
  apply_id: string
  apply_date: string
  department: string
  hold_status: 'OPEN' | 'HOLD' | 'CLOSE' | 'UNSIGNED'
  currency: string
}

// 一筆請購明細（帶入自 SO 或手動）
interface PrLine {
  uid: string                 // 前端唯一鍵
  so_project_id: string       // 來源銷售訂單號（→ MBP_LOT_NO）
  so_line_no: string          // 來源序號
  item_code: string           // 料號（MBP_PART）
  item_name: string           // 品名（顯示用）
  mbp_ver: string             // 版本（MBP_VER）
  uom: string                 // 單位（UNIT_OF_MEASURE_ORU）
  quantity: string            // 請購數量（ORDER_QTY_ORU）
  delivery_date: string       // 交期（DUEDATE）
}

const HEADER_KEY = 'argoerp_standalone_pr_header_v1'
const ERP_KEYS = [
  'APPLY_ID',
  'APPLY_DATE',
  'SEG_SEGMENT_NO_DEPARTMENT',
  'HOLD_STATUS',
  'LINE_NO',
  'MBP_PART',
  'MBP_VER',
  'MBP_LOT_NO',
  'UNIT_OF_MEASURE_ORU',
  'ORDER_QTY_ORU',
  'CURRENCY',
  'DUEDATE',
] as const

function fmtDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// 解析 YYYY/MM/DD、YYYY-MM-DD、YYYYMMDD 為 Date（本地時區），失敗回 null
function parseYmd(s: string): Date | null {
  const t = (s ?? '').trim()
  if (!t) return null
  let y: number, m: number, d: number
  if (/^\d{8}$/.test(t)) { y = +t.slice(0, 4); m = +t.slice(4, 6); d = +t.slice(6, 8) }
  else if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(t)) {
    const p = t.slice(0, 10).split(/[/-]/); y = +p[0]; m = +p[1]; d = +p[2]
  } else return null
  const dt = new Date(y, m - 1, d)
  return Number.isNaN(dt.getTime()) ? null : dt
}

// ARGO 規則：DUEDATE 必須晚於 APPLY_DATE。若交期為空或 <= 開立日，clamp 為開立日 + 1 天。
function clampDueDate(deliveryDate: string, applyDate: string): string {
  const apply = parseYmd(applyDate)
  if (!apply) return deliveryDate.trim()
  const minDue = new Date(apply.getTime())
  minDue.setDate(minDue.getDate() + 1)
  const due = parseYmd(deliveryDate)
  if (due && due.getTime() >= minDue.getTime()) return fmtDate(due)
  return fmtDate(minDue)
}

function makeDefaultHeader(): PrHeader {
  return {
    apply_id: '',
    apply_date: fmtDate(new Date()),
    department: 'M1100',
    hold_status: 'UNSIGNED',
    currency: 'CNY',
  }
}

function makeUid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function emptyLine(): PrLine {
  return {
    uid: makeUid(),
    so_project_id: '',
    so_line_no: '',
    item_code: '',
    item_name: '',
    mbp_ver: '1',
    uom: 'PCS',
    quantity: '',
    delivery_date: '',
  }
}

interface SoLineRecord {
  project_id: string
  line_no: string
  mbp_part: string | null
  mbp_ver: number | null
  description: string | null
  duedate: string | null
  order_qty_oru: number | null
  unit_of_measure_oru: string | null
}

export default function StandalonePrCreatePage() {
  const [unlocked, setUnlocked] = useState(false)
  const [pwInput, setPwInput] = useState('')
  const [pwError, setPwError] = useState(false)

  const [header, setHeader] = useState<PrHeader>(makeDefaultHeader)
  const [lines, setLines] = useState<PrLine[]>([emptyLine()])

  const [applyIdLoading, setApplyIdLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [msg, setMsg] = useState('')

  // 帶入區：輸入 SO 單號 + 序號
  const [soInput, setSoInput] = useState('')
  const [lineInput, setLineInput] = useState('')
  const [soLoading, setSoLoading] = useState(false)

  // 已開立請購單查詢
  const [prSearchId, setPrSearchId] = useState('')
  const [prSearching, setPrSearching] = useState(false)
  const [prSyncRows, setPrSyncRows] = useState<Array<Record<string, unknown>> | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HEADER_KEY)
      if (raw) setHeader({ ...makeDefaultHeader(), ...JSON.parse(raw) })
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(HEADER_KEY, JSON.stringify(header))
  }, [header])

  const setH = useCallback(<K extends keyof PrHeader>(k: K, v: PrHeader[K]) => {
    setHeader(prev => ({ ...prev, [k]: v }))
  }, [])

  const setLine = useCallback((uid: string, patch: Partial<PrLine>) => {
    setLines(prev => prev.map(l => (l.uid === uid ? { ...l, ...patch } : l)))
  }, [])

  const addLine = useCallback(() => {
    setLines(prev => [...prev, emptyLine()])
  }, [])

  const removeLine = useCallback((uid: string) => {
    setLines(prev => (prev.length <= 1 ? [emptyLine()] : prev.filter(l => l.uid !== uid)))
  }, [])

  // 產生請購單號（沿用委外請購規則 MPO+YYYYMMDD+NN）
  const generateApplyId = useCallback(async (applyDate: string) => {
    const digits = applyDate.replace(/\D/g, '').slice(0, 8)
    if (digits.length !== 8) throw new Error('開立日期格式錯誤，請使用 YYYY/MM/DD')
    const prefix = `MPO${digits}`

    const { data, error } = await supabase
      .from('erp_pj_sync')
      .select('doc_no')
      .eq('doc_type', '請購單號')
      .ilike('doc_no', `${prefix}%`)
    if (error) throw error

    let maxSeq = 0
    for (const rec of (data ?? []) as Array<{ doc_no?: string | null }>) {
      const docNo = String(rec.doc_no ?? '').trim().toUpperCase()
      if (!docNo.startsWith(prefix)) continue
      const seq = parseInt(docNo.slice(prefix.length), 10)
      if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
    }
    return `${prefix}${String(maxSeq + 1).padStart(2, '0')}`
  }, [])

  const handleRegenerateApplyId = useCallback(async () => {
    setApplyIdLoading(true)
    try {
      const nextId = await generateApplyId(header.apply_date)
      setHeader(prev => ({ ...prev, apply_id: nextId }))
      setMsg(`✅ 已產生請購單號：${nextId}`)
    } catch (e) {
      setMsg(`❌ 產生請購單號失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplyIdLoading(false)
    }
  }, [generateApplyId, header.apply_date])

  // 從 erp_so_lines 帶入指定銷售訂單 + 序號
  const importFromSo = useCallback(async () => {
    const so = soInput.trim()
    if (!so) {
      setMsg('❌ 請輸入銷售訂單號')
      return
    }
    setSoLoading(true)
    setMsg('')
    try {
      let q = supabase
        .from('erp_so_lines')
        .select('project_id, line_no, mbp_part, mbp_ver, description, duedate, order_qty_oru, unit_of_measure_oru')
        .eq('project_id', so)

      const lineNo = lineInput.trim()
      if (lineNo) q = q.eq('line_no', lineNo)

      const { data, error } = await q.order('line_no', { ascending: true })
      if (error) throw error

      const records = (data ?? []) as SoLineRecord[]
      if (records.length === 0) {
        setMsg(`❌ 查無銷售訂單 ${so}${lineNo ? ` 序號 ${lineNo}` : ''} 的明細`)
        return
      }

      const newLines: PrLine[] = records.map(r => ({
        uid: makeUid(),
        so_project_id: r.project_id,
        so_line_no: String(r.line_no ?? ''),
        item_code: r.mbp_part ?? '',
        item_name: r.description ?? '',
        mbp_ver: r.mbp_ver != null ? String(r.mbp_ver) : '1',
        uom: r.unit_of_measure_oru ?? 'PCS',
        quantity: r.order_qty_oru != null ? String(r.order_qty_oru) : '',
        delivery_date: r.duedate ?? '',
      }))

      // 若目前只有一筆空白列，直接取代；否則附加
      setLines(prev => {
        const onlyEmpty = prev.length === 1 && !prev[0].item_code && !prev[0].so_project_id
        return onlyEmpty ? newLines : [...prev, ...newLines]
      })
      setMsg(`✅ 已帶入 ${newLines.length} 筆明細（${so}${lineNo ? ` / 序號 ${lineNo}` : ''}）`)
    } catch (e) {
      setMsg(`❌ 帶入失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSoLoading(false)
    }
  }, [soInput, lineInput])

  // 組裝 ERP payload
  const payload = useMemo<Array<Record<string, string>>>(() => {
    return lines
      .filter(l => l.item_code.trim() && l.quantity.trim())
      .map((l, i) => ({
        APPLY_ID: header.apply_id,
        APPLY_DATE: header.apply_date,
        SEG_SEGMENT_NO_DEPARTMENT: header.department,
        HOLD_STATUS: header.hold_status,
        LINE_NO: String(i + 1),
        MBP_PART: l.item_code.trim(),
        MBP_VER: l.mbp_ver.trim() || '1',
        MBP_LOT_NO: l.so_project_id.trim(),
        UNIT_OF_MEASURE_ORU: l.uom.trim() || 'PCS',
        ORDER_QTY_ORU: l.quantity.trim(),
        CURRENCY: header.currency,
        DUEDATE: clampDueDate(l.delivery_date, header.apply_date),
      }))
  }, [lines, header])

  const handleImport = useCallback(async () => {
    if (payload.length === 0) {
      alert('尚無可匯入明細（每列需有料號與數量）')
      return
    }
    if (!header.apply_id.trim()) {
      alert('請先產生或填寫請購單號')
      return
    }
    if (!header.department.trim()) {
      alert('請填寫請購部門')
      return
    }
    // ARGO 已開啟傳簽功能：匯入狀態僅可為 UNSIGNED / HOLD / CLOSE，OPEN 會被退回
    if (header.hold_status === 'OPEN') {
      alert('單據狀態「OPEN」會被 ArgoERP 退回（已開啟傳簽功能）。請改為 UNSIGNED 後再匯入。')
      return
    }
    // MBP_LOT_NO（來源銷售訂單號）為委外請購必填
    const missingLot = payload.filter(p => !p.MBP_LOT_NO)
    if (missingLot.length > 0) {
      if (!confirm(`有 ${missingLot.length} 筆明細未帶入銷售訂單號（批號 MBP_LOT_NO 將為空），仍要匯入嗎？`)) return
    }
    if (!confirm(`確認匯入請購單 ${header.apply_id}（${payload.length} 筆明細）至 ArgoERP？`)) return

    setImporting(true)
    setMsg('')
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId: 'IFAF105', data: payload }),
      })
      const result = await res.json()
      if (!res.ok || !result?.success) {
        const raw = typeof result?.rawText === 'string'
          ? result.rawText.slice(0, 200)
          : JSON.stringify(result?.apiResult ?? '').slice(0, 200)
        setMsg(`❌ 匯入失敗：${result?.error || `HTTP ${res.status}`}${raw ? ` — ${raw}` : ''}`)
        return
      }
      setMsg(`✅ 請購單 ${header.apply_id} 已匯入 ERP（${payload.length} 筆明細）`)
    } catch (e) {
      setMsg(`❌ 匯入失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setImporting(false)
    }
  }, [payload, header.apply_id, header.apply_date, header.department, header.hold_status, header.currency])

  const searchSyncedPr = useCallback(async () => {
    const q = prSearchId.trim()
    if (!q) {
      setPrSyncRows(null)
      return
    }
    setPrSearching(true)
    setMsg('')
    try {
      const { data, error } = await supabase
        .from('erp_pj_sync')
        .select('*')
        .eq('doc_type', '請購單號')
        .ilike('doc_no', `%${q}%`)
        .order('doc_no', { ascending: true })
        .order('sub_no', { ascending: true })
      if (error) throw error
      setPrSyncRows(data ?? [])
    } catch (e) {
      setMsg(`❌ 查詢失敗：${e instanceof Error ? e.message : String(e)}`)
      setPrSyncRows(null)
    } finally {
      setPrSearching(false)
    }
  }, [prSearchId])

  if (!unlocked) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-8 w-80 flex flex-col items-center gap-4">
          <div className="text-2xl">🔒</div>
          <h2 className="text-white font-semibold text-lg">單獨開立請購單</h2>
          <p className="text-slate-400 text-sm">請輸入密碼以繼續</p>
          <input
            type="password"
            value={pwInput}
            onChange={e => { setPwInput(e.target.value); setPwError(false) }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (pwInput === '666') { setUnlocked(true) }
                else { setPwError(true); setPwInput('') }
              }
            }}
            placeholder="密碼"
            autoFocus
            className={`w-full px-4 py-2 rounded-lg bg-slate-800 border text-white text-center tracking-widest focus:outline-none ${
              pwError ? 'border-red-500' : 'border-slate-600 focus:border-cyan-500'
            }`}
          />
          {pwError && <p className="text-red-400 text-xs">密碼錯誤</p>}
          <button
            onClick={() => {
              if (pwInput === '666') { setUnlocked(true) }
              else { setPwError(true); setPwInput('') }
            }}
            className="w-full py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors"
          >
            進入
          </button>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-[1500px] mx-auto space-y-4">
        <div className="flex items-end justify-between gap-3 flex-wrap border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">單獨開立➜請購單</h1>
            <p className="text-slate-400 text-sm mt-1">ArgoERP IFAF105（PJBF084）｜帶入指定銷售訂單序號｜請購單號規則 MPOYYYYMMDDNN</p>
          </div>
        </div>

        {msg && (
          <div className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm">{msg}</div>
        )}

        {/* 表頭設定 */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <h2 className="text-white font-semibold mb-3">請購單表頭</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              請購單號
              <div className="flex gap-1">
                <input
                  value={header.apply_id}
                  onChange={e => setH('apply_id', e.target.value.toUpperCase())}
                  placeholder="MPOYYYYMMDDNN"
                  className="flex-1 px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-cyan-500"
                />
                <button
                  onClick={handleRegenerateApplyId}
                  disabled={applyIdLoading}
                  className="px-2 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs whitespace-nowrap disabled:opacity-50"
                  title="自動產生下一個請購單號"
                >
                  {applyIdLoading ? '…' : '產生'}
                </button>
              </div>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              開立日期
              <input
                value={header.apply_date}
                onChange={e => setH('apply_date', e.target.value)}
                placeholder="YYYY/MM/DD"
                className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-cyan-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              請購部門
              <input
                value={header.department}
                onChange={e => setH('department', e.target.value.toUpperCase())}
                placeholder="M1100"
                className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-cyan-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              單據狀態
              <select
                value={header.hold_status}
                onChange={e => setH('hold_status', e.target.value as PrHeader['hold_status'])}
                className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-cyan-500"
              >
                <option value="UNSIGNED">UNSIGNED（建議，待簽核）</option>
                <option value="HOLD">HOLD</option>
                <option value="CLOSE">CLOSE</option>
                <option value="OPEN">OPEN（已開啟傳簽功能時會被拒）</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              幣別
              <input
                value={header.currency}
                onChange={e => setH('currency', e.target.value.toUpperCase())}
                placeholder="CNY"
                className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-cyan-500"
              />
            </label>
          </div>
        </section>

        {/* 帶入銷售訂單 */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <h2 className="text-white font-semibold mb-3">帶入銷售訂單明細</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              銷售訂單號
              <input
                value={soInput}
                onChange={e => setSoInput(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && void importFromSo()}
                placeholder="SO..."
                className="w-48 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-cyan-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              序號（選填，空白=整張單）
              <input
                value={lineInput}
                onChange={e => setLineInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void importFromSo()}
                placeholder="例：1"
                className="w-32 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-cyan-500"
              />
            </label>
            <button
              onClick={() => void importFromSo()}
              disabled={soLoading}
              className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {soLoading ? '帶入中…' : '帶入明細'}
            </button>
            <p className="text-slate-500 text-xs">帶入的銷售訂單號會寫入請購批號（MBP_LOT_NO）。</p>
          </div>
        </section>

        {/* 明細表格 */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white font-semibold">請購明細（{payload.length} 筆有效）</h2>
            <button
              onClick={addLine}
              className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs"
            >
              ＋ 新增空白列
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700 text-xs">
                  <th className="text-left py-2 pr-2 w-10">#</th>
                  <th className="text-left py-2 pr-2">銷售訂單號（批號）</th>
                  <th className="text-left py-2 pr-2">序號</th>
                  <th className="text-left py-2 pr-2">料號 *</th>
                  <th className="text-left py-2 pr-2">品名</th>
                  <th className="text-left py-2 pr-2 w-16">版本</th>
                  <th className="text-left py-2 pr-2 w-20">單位</th>
                  <th className="text-right py-2 pr-2 w-24">數量 *</th>
                  <th className="text-left py-2 pr-2 w-32">交期</th>
                  <th className="py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.uid} className="border-b border-slate-800/60">
                    <td className="py-1.5 pr-2 text-slate-500">{i + 1}</td>
                    <td className="py-1.5 pr-2">
                      <input
                        value={l.so_project_id}
                        onChange={e => setLine(l.uid, { so_project_id: e.target.value.toUpperCase() })}
                        className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white text-xs font-mono focus:outline-none focus:border-cyan-500"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        value={l.so_line_no}
                        onChange={e => setLine(l.uid, { so_line_no: e.target.value })}
                        className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white text-xs focus:outline-none focus:border-cyan-500"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        value={l.item_code}
                        onChange={e => setLine(l.uid, { item_code: e.target.value })}
                        className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white text-xs font-mono focus:outline-none focus:border-cyan-500"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        value={l.item_name}
                        onChange={e => setLine(l.uid, { item_name: e.target.value })}
                        className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs focus:outline-none focus:border-cyan-500"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        value={l.mbp_ver}
                        onChange={e => setLine(l.uid, { mbp_ver: e.target.value })}
                        className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white text-xs focus:outline-none focus:border-cyan-500"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        value={l.uom}
                        onChange={e => setLine(l.uid, { uom: e.target.value })}
                        className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white text-xs focus:outline-none focus:border-cyan-500"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        value={l.quantity}
                        onChange={e => setLine(l.uid, { quantity: e.target.value })}
                        className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white text-xs text-right focus:outline-none focus:border-cyan-500"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        value={l.delivery_date}
                        onChange={e => setLine(l.uid, { delivery_date: e.target.value })}
                        placeholder="YYYY/MM/DD"
                        className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white text-xs focus:outline-none focus:border-cyan-500"
                      />
                    </td>
                    <td className="py-1.5 text-center">
                      <button
                        onClick={() => removeLine(l.uid)}
                        className="text-slate-500 hover:text-red-400 text-sm"
                        title="刪除此列"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-slate-500 text-xs mt-2">* 必填：料號、數量。批號（銷售訂單號）為委外請購必填，建議由「帶入明細」自動填入。</p>
        </section>

        {/* 匯入按鈕 */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => void handleImport()}
            disabled={importing || payload.length === 0}
            className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors disabled:opacity-50"
          >
            {importing ? '匯入中…' : `匯入 ERP（${payload.length} 筆）`}
          </button>
        </div>

        {/* 已開立請購單查詢 */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <h2 className="text-white font-semibold mb-3">查詢已同步請購單</h2>
          <div className="flex flex-wrap items-end gap-3 mb-3">
            <input
              value={prSearchId}
              onChange={e => setPrSearchId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void searchSyncedPr()}
              placeholder="輸入請購單號（部分比對）"
              className="w-64 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-cyan-500"
            />
            <button
              onClick={() => void searchSyncedPr()}
              disabled={prSearching}
              className="px-5 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm transition-colors disabled:opacity-50"
            >
              {prSearching ? '查詢中…' : '查詢'}
            </button>
          </div>
          {prSyncRows && (
            prSyncRows.length === 0 ? (
              <p className="text-slate-500 text-sm">查無資料</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-400 border-b border-slate-700">
                      <th className="text-left py-1.5 pr-3">單號</th>
                      <th className="text-left py-1.5 pr-3">項次</th>
                      <th className="text-left py-1.5 pr-3">料號</th>
                      <th className="text-left py-1.5 pr-3">品名</th>
                      <th className="text-right py-1.5 pr-3">數量</th>
                      <th className="text-left py-1.5 pr-3">批號</th>
                      <th className="text-left py-1.5 pr-3">申請日</th>
                      <th className="text-left py-1.5">狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prSyncRows.map((row, idx) => {
                      const extra = (row.extra ?? {}) as Record<string, unknown>
                      return (
                        <tr key={idx} className="border-b border-slate-800/60">
                          <td className="py-1.5 pr-3 text-white font-mono">{String(row.doc_no ?? '')}</td>
                          <td className="py-1.5 pr-3 text-slate-400">{String(row.sub_no ?? '')}</td>
                          <td className="py-1.5 pr-3 text-slate-300">{String(row.item_code ?? '')}</td>
                          <td className="py-1.5 pr-3 text-slate-400 max-w-[160px] truncate">{String(row.description ?? '')}</td>
                          <td className="py-1.5 pr-3 text-slate-300 text-right">{String(row.qty ?? '')}</td>
                          <td className="py-1.5 pr-3 text-slate-400 font-mono">{String(extra.MBP_LOT_NO ?? '')}</td>
                          <td className="py-1.5 pr-3 text-slate-400">{String(row.start_date ?? '')}</td>
                          <td className="py-1.5 text-slate-400">{String(row.status ?? '')}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </section>
      </div>
    </main>
  )
}
