'use client'

/**
 * 出單表➜委外請購
 * ArgoERP IFAF105 — 請購單（PR）介面
 *
 * 一張請購單（表頭）+ 多筆明細（表身）
 * 請購單號格式：MPO + YYYYMMDD + 2位流水（例：MPO2026060801）
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../../../lib/supabaseClient'
import PoOrderModal from '../../../../components/PoOrderModal'

interface SourceRow {
  row_key?: string
  order_number: string
  doc_type: string
  factory: 'T' | 'C' | 'O'
  mo_number?: string | null
  pr_number?: string | null
  customer: string
  item_code: string
  item_name: string
  note: string
  quantity: string
  delivery_date: string
  match_line_no?: string | null
  po_status?: string | null
  po_number?: string | null
}

interface PrHeader {
  apply_id: string
  apply_date: string
  department: string
  hold_status: 'OPEN' | 'HOLD' | 'CLOSE' | 'UNSIGNED'
  currency: string
  flow_type: string
  apply_user: string
}

interface LineEdit {
  mbp_ver: string
  uom: string
}

const HEADER_KEY = 'argoerp_pr_o_header_v1'
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
  'FLOW_TYPE',
  'APPLY_USER',
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
  if (!apply) return (deliveryDate ?? '').trim()
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
    flow_type: 'IVAR154-1',
    apply_user: '10149',
  }
}

function isMpoImportedRow(row: SourceRow): boolean {
  const moNo = String(row.mo_number ?? '').trim().toUpperCase()
  const prNo = String(row.pr_number ?? '').trim()
  // 任何非空的 pr_number 均表示已比對到請購單（無論格式，含舊格式 MP... 及新格式 MPO...）
  // 保留舊相容：mo_number 本身是 MPO 前綴（歷史遺留資料）
  return !!prNo || moNo.startsWith('MPO')
}

export default function PrBatchExportOPage() {
  const [unlocked, setUnlocked] = useState(false)
  const [pwInput, setPwInput]   = useState('')
  const [pwError, setPwError]   = useState(false)

  const [sourceRows, setSourceRows] = useState<SourceRow[]>([])
  const [importedMpoRows, setImportedMpoRows] = useState<SourceRow[]>([])
  const [lineEdits, setLineEdits] = useState<LineEdit[]>([])
  const [header, setHeader] = useState<PrHeader>(makeDefaultHeader)

  const [availDates, setAvailDates] = useState<{ sheet_date: string; row_count: number; pending_pr_count?: number }[]>([])
  const [pickerDate, setPickerDate] = useState('')
  const [loadedDate, setLoadedDate] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'pending' | 'imported'>('pending')
  const [datesLoading, setDatesLoading] = useState(false)

  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number; errors: string[] } | null>(null)
  const [msg, setMsg] = useState('')
  const [unitMap, setUnitMap] = useState<Record<string, string>>({})
  const [applyIdLoading, setApplyIdLoading] = useState(false)

  const [prSearchId, setPrSearchId] = useState('')
  const [prSearching, setPrSearching] = useState(false)
  const [prSyncRows, setPrSyncRows] = useState<Array<Record<string, unknown>> | null>(null)
  const [poModalId, setPoModalId] = useState<string | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HEADER_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        // 單號＝傳入時自動取號、開立日期＝一律帶當天，兩者都不還原 localStorage 舊值
        // （曾發生開立日期停在舊值 → ARGO 單 APPLY_DATE 錯置，例 MPO2026070901 開立日 6/25）
        setHeader({ ...makeDefaultHeader(), ...parsed, apply_id: '', apply_date: fmtDate(new Date()) })
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(HEADER_KEY, JSON.stringify(header))
  }, [header])

  useEffect(() => {
    setDatesLoading(true)
    fetch('/api/argoerp/daily-order-sheet')
      .then(r => r.json())
      .then(j => {
        if (j.success) {
          setAvailDates(j.sheets ?? [])
          if (j.sheets?.length && !pickerDate) setPickerDate(j.sheets[0].sheet_date)
        }
      })
      .catch(() => {})
      .finally(() => setDatesLoading(false))
  }, [pickerDate])

  const loadUnitMapForRows = useCallback(async (rows: SourceRow[]) => {
    const partCodes = Array.from(new Set(rows.map(r => r.item_code).filter(Boolean)))
    if (partCodes.length === 0) {
      const emptyMap: Record<string, string> = {}
      setUnitMap(emptyMap)
      return emptyMap
    }

    const { data, error } = await supabase
      .from('mm_bom_part_units')
      .select('part_code, unit_of_measure')
      .in('part_code', partCodes)

    if (error) throw error

    const nextMap: Record<string, string> = {}
    for (const item of (data ?? []) as Array<{ part_code: string; unit_of_measure: string | null }>) {
      if (item.part_code && item.unit_of_measure) {
        nextMap[item.part_code] = item.unit_of_measure
      }
    }
    setUnitMap(nextMap)
    return nextMap
  }, [])

  const generateApplyId = useCallback(async (applyDate: string, existingRows: SourceRow[] = []) => {
    const digits = applyDate.replace(/\D/g, '').slice(0, 8)
    if (digits.length !== 8) throw new Error('開立日期格式錯誤，請使用 YYYY/MM/DD')
    const prefix = `MPO${digits}`

    const candidates: string[] = []
    for (const row of existingRows) {
      const pr = String(row.pr_number ?? '').trim().toUpperCase()
      const mo = String(row.mo_number ?? '').trim().toUpperCase()
      if (pr.startsWith(prefix)) candidates.push(pr)
      if (mo.startsWith(prefix)) candidates.push(mo)
    }

    // 即時查 ARGO 請購主檔（PJ_APPLYPROJECT）取當天既有 MPO 單號，
    // 不依賴 erp_pj_sync（那份要手動跑同步才會新，取號會撞單）
    const res = await fetch('/api/argoerp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'query',
        table: 'PJ_APPLYPROJECT',
        filters: { APPLY_ID: `LIKE '${prefix}%'` },
        customColumn: 'APPLY_ID',
      }),
    })
    const j = await res.json()
    if (!res.ok || !j?.success) throw new Error(j?.error || `查詢 ARGO 請購單號失敗（HTTP ${res.status}）`)
    const apiResult = (j.apiResult ?? {}) as Record<string, unknown>
    const argoRows = Array.isArray(apiResult.RESULT) ? apiResult.RESULT as Array<Record<string, unknown>> : []
    for (const rec of argoRows) {
      const docNo = String(rec?.APPLY_ID ?? '').trim().toUpperCase()
      if (docNo.startsWith(prefix)) candidates.push(docNo)
    }

    let maxSeq = 0
    for (const no of candidates) {
      const suffix = no.slice(prefix.length)
      const seq = parseInt(suffix, 10)
      if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
    }

    return `${prefix}${String(maxSeq + 1).padStart(2, '0')}`
  }, [])

  const loadSheet = useCallback(async (date: string) => {
    if (!date) return
    try {
      const r = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`)
      const j = await r.json()
      if (!j.success || !j.sheet) {
        alert(`找不到 ${date} 的出單表`)
        return
      }

      const allORows = (j.sheet.rows ?? []).filter((x: SourceRow) => x.factory === 'O')
      const normalizedRows: SourceRow[] = allORows
        .filter((x: SourceRow) => x.po_status !== 'no_po')
        .map((x: SourceRow) => ({ ...x, match_line_no: x.match_line_no ?? null }))

      // 舊資料補償：早期已匯入請購但缺少 pr_number，若 mo_number 本身就是 MPO 則補寫。
      const legacyBackfillUpdates: Array<Record<string, unknown>> = []
      const normalizedWithBackfill = normalizedRows.map((row) => {
        const hasLegacyImportedMark =
          row.factory === 'O' &&
          row.po_status === 'matched' &&
          !!row.po_number &&
          row.mo_number === row.po_number &&
          !String(row.pr_number ?? '').trim()

        if (!hasLegacyImportedMark) return row

        const moNo = String(row.mo_number ?? '').trim().toUpperCase()
        const backfilledPrNo = moNo.startsWith('MPO') ? moNo : ''
        if (row.row_key && backfilledPrNo) {
          legacyBackfillUpdates.push({ row_key: row.row_key, pr_number: backfilledPrNo })
        }
        return { ...row, pr_number: backfilledPrNo || null }
      })

      if (legacyBackfillUpdates.length > 0) {
        fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet_date: date, updates: legacyBackfillUpdates }),
        }).catch(() => {})
      }

      const mpoImportedRows: SourceRow[] = normalizedWithBackfill
        .filter(isMpoImportedRow)
        .map((row) => {
          if (!String(row.pr_number ?? '').trim() && String(row.mo_number ?? '').trim().toUpperCase().startsWith('MPO')) {
            return { ...row, pr_number: row.mo_number ?? null }
          }
          return row
        })

      const rows: SourceRow[] = normalizedWithBackfill.filter(x => !isMpoImportedRow(x))

      if (allORows.length === 0) {
        alert(`${date} 出單表中沒有委外廠訂單`)
        return
      }
      if (rows.length === 0 && mpoImportedRows.length === 0) {
        alert(`${date} 委外廠訂單皆標記為無須採購，無可轉請購資料`)
        return
      }

      const fetchedUnitMap = await loadUnitMapForRows(normalizedWithBackfill)
      setSourceRows(rows)
      setImportedMpoRows(mpoImportedRows)
      setLineEdits(rows.map(row => ({
        mbp_ver: '1',
        uom: fetchedUnitMap[row.item_code] || 'PCS',
      })))
      setLoadedDate(date)
      setActiveTab('pending')
      const autoApplyId = await generateApplyId(header.apply_date, normalizedWithBackfill)
      setHeader(prev => ({ ...prev, apply_id: autoApplyId }))
      if (rows.length === 0 && mpoImportedRows.length > 0) {
        setMsg(`ℹ️ 此日期委外列皆已匹配 MPO（${mpoImportedRows.length} 筆），已移至「已匯入(MPO)」分頁`)
      } else {
        setMsg('')
      }
    } catch (e) {
      alert(`載入失敗：${e}`)
    }
  }, [loadUnitMapForRows, header.apply_date, generateApplyId])

  const payload = useMemo<Array<Record<string, string>>>(() => {
    return sourceRows.map((row, i) => {
      const edit = lineEdits[i] ?? { mbp_ver: '1', uom: 'PCS' }
      return {
        APPLY_ID: header.apply_id,
        APPLY_DATE: header.apply_date,
        SEG_SEGMENT_NO_DEPARTMENT: header.department,
        HOLD_STATUS: header.hold_status,
        LINE_NO: String(i + 1),
        MBP_PART: row.item_code,
        MBP_VER: edit.mbp_ver || '1',
        MBP_LOT_NO: row.order_number,
        UNIT_OF_MEASURE_ORU: edit.uom || 'PCS',
        ORDER_QTY_ORU: row.quantity,
        CURRENCY: header.currency,
        DUEDATE: clampDueDate(row.delivery_date, header.apply_date),
        FLOW_TYPE: header.flow_type.trim(),
        APPLY_USER: header.apply_user.trim(),
      }
    })
  }, [sourceRows, lineEdits, header])

  const doExport = useCallback((fmt: 'csv' | 'xlsx' = 'csv') => {
    if (payload.length === 0) return

    const now = new Date()
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const fileBase = `ArgoERP_委外請購單_${header.apply_id || 'MPO'}_${loadedDate ?? ts}_${ts}`
    const rows = payload.map(r => ERP_KEYS.map(k => r[k] ?? ''))

    if (fmt === 'xlsx') {
      const ws = XLSX.utils.aoa_to_sheet([[...ERP_KEYS], ...rows])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '委外請購批次')
      XLSX.writeFile(wb, `${fileBase}.xlsx`)
      return
    }

    const csvLines = [[...ERP_KEYS].join(','), ...rows.map(row => row.map(v => {
      if (v.includes(',') || v.includes('"') || v.includes('\n')) return `"${v.replace(/"/g, '""')}"`
      return v
    }).join(','))]
    const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileBase}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [payload, loadedDate, header.apply_id])

  const handleImport = useCallback(async () => {
    if (payload.length === 0) {
      alert('尚無可匯入資料')
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

    const unitMismatch = sourceRows
      .map((row, i) => {
        const erpUnit = unitMap[row.item_code]
        const currentUnit = lineEdits[i]?.uom?.trim() || ''
        if (!erpUnit) return null
        if (currentUnit === erpUnit) return null
        return `${row.item_code}：目前 ${currentUnit || '空白'}，ERP ${erpUnit}`
      })
      .filter((x): x is string => Boolean(x))

    if (unitMismatch.length > 0) {
      alert(`單位與 ERP 對應不一致，請先修正後再匯入：\n${unitMismatch.slice(0, 10).join('\n')}${unitMismatch.length > 10 ? `\n…（共 ${unitMismatch.length} 筆）` : ''}`)
      return
    }

    setImporting(true)
    setMsg('')

    // 按下傳入 ARGO 當下即時取號：抓當天最新 MPO 單號 +1，不使用畫面上可能過期的舊值
    let applyId = ''
    try {
      applyId = await generateApplyId(header.apply_date, [...sourceRows, ...importedMpoRows])
      setHeader(prev => ({ ...prev, apply_id: applyId }))
    } catch (e) {
      setImporting(false)
      const m = `❌ 取號失敗，未匯入：${e instanceof Error ? e.message : String(e)}`
      setMsg(m)
      alert(m)
      return
    }
    if (!confirm(`確認匯入請購單 ${applyId}（${payload.length} 筆明細）至 ArgoERP？`)) {
      setImporting(false)
      return
    }

    setImportProgress({ done: 0, total: 1, errors: [] })
    const errors: string[] = []
    const sheetUpdates: Array<Record<string, unknown>> = []
    const missingRowKey: string[] = []
    const importPayload = payload.map(r => ({ ...r, APPLY_ID: applyId }))

    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId: 'IFAF105', data: importPayload }),
      })
      const result = await res.json()
      if (!res.ok || !result?.success) {
        const raw = typeof result?.rawText === 'string'
          ? result.rawText.slice(0, 200)
          : JSON.stringify(result?.apiResult ?? '').slice(0, 200)
        errors.push(`${applyId}: ${result?.error || `HTTP ${res.status}`} — ${raw}`)
      } else {
        for (let i = 0; i < sourceRows.length; i++) {
          const src = sourceRows[i]
          if (!loadedDate) continue
          if (!src?.row_key) {
            // 缺 row_key 的列無法回寫，不能靜默跳過：這種列匯入後仍會顯示在
            // 待匯入清單，下次極易誤按重複匯入（2026-07-09 MPO2026070901 即此案例）
            missingRowKey.push(`${src?.order_number ?? '?'}/${src?.item_code ?? '?'}`)
            continue
          }
          const hasMatchedPo = src.po_status === 'matched' && !!src.po_number
          if (hasMatchedPo) {
            sheetUpdates.push({
              row_key: src.row_key,
              mo_number: src.po_number,
              pr_number: applyId,
              po_number: src.po_number,
              po_status: 'matched',
            })
          } else {
            sheetUpdates.push({
              row_key: src.row_key,
              mo_number: applyId,
              pr_number: applyId,
              po_status: null,
            })
          }
        }
      }
    } catch (e) {
      errors.push(`${applyId}: ${e instanceof Error ? e.message : String(e)}`)
    }
    setImportProgress({ done: 1, total: 1, errors: [...errors] })

    let sheetSyncMsg = ''
    if (loadedDate && sheetUpdates.length > 0) {
      try {
        const patchRes = await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheet_date: loadedDate,
            updates: sheetUpdates,
          }),
        })
        const patchJson = await patchRes.json()
        if (!patchRes.ok || !patchJson?.success) {
          throw new Error(patchJson?.error || `HTTP ${patchRes.status}`)
        }
        sheetSyncMsg = `，已回寫出單表 ${sheetUpdates.length} 筆`
      } catch (e) {
        sheetSyncMsg = `，但出單表回寫失敗：${e instanceof Error ? e.message : String(e)}\n⚠️ 請購單已在 ARGO 成立（${applyId}），這些列會持續顯示為待匯入——請勿再次匯入，先回報處理`
      }
    }
    if (errors.length === 0 && missingRowKey.length > 0) {
      sheetSyncMsg += `\n⚠️ ${missingRowKey.length} 筆缺 row_key 無法回寫（${missingRowKey.slice(0, 5).join('、')}${missingRowKey.length > 5 ? '…' : ''}）。這些列之後仍會出現在待匯入清單，請勿再次匯入`
    }

    if (errors.length === 0) {
      const m = `✅ 請購單 ${applyId} 已匯入 ERP（${payload.length} 筆明細）${sheetSyncMsg}`
      setMsg(m)
      alert(m)
      setSourceRows([])
      setLineEdits([])
      setLoadedDate(null)
    } else {
      const m = `⚠️ 匯入完成：請購單 ${applyId} 失敗${sheetSyncMsg}`
      setMsg(m)
      alert(`${m}\n\n失敗明細：\n${errors.slice(0, 10).join('\n')}${errors.length > 10 ? `\n…（共 ${errors.length} 筆）` : ''}`)
    }

    setImporting(false)
    setTimeout(() => setImportProgress(null), 12000)
  }, [payload, header.apply_date, header.department, header.hold_status, sourceRows, importedMpoRows, loadedDate, lineEdits, unitMap, generateApplyId])

  const setH = useCallback(<K extends keyof PrHeader>(k: K, v: PrHeader[K]) => {
    setHeader(prev => ({ ...prev, [k]: v }))
  }, [])

  const setLE = useCallback((i: number, k: keyof LineEdit, v: string) => {
    setLineEdits(prev => prev.map((e, idx) => idx === i ? { ...e, [k]: v } : e))
  }, [])

  const handleRegenerateApplyId = useCallback(async () => {
    setApplyIdLoading(true)
    try {
      const nextId = await generateApplyId(header.apply_date, [...sourceRows, ...importedMpoRows])
      setHeader(prev => ({ ...prev, apply_id: nextId }))
      setMsg(`✅ 已產生請購單號：${nextId}`)
    } catch (e) {
      setMsg(`❌ 產生請購單號失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplyIdLoading(false)
    }
  }, [generateApplyId, header.apply_date, sourceRows, importedMpoRows])

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
          <h2 className="text-white font-semibold text-lg">委外請購</h2>
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
            <h1 className="text-3xl font-bold tracking-tight">出單表➜委外請購</h1>
            <p className="text-slate-400 text-sm mt-1">ArgoERP IFAF105（PJBF084）｜一張請購單多筆明細｜單號 MPOYYYYMMDDNN，傳入時查 ARGO 當天最新號自動 +1</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={pickerDate}
              onChange={e => setPickerDate(e.target.value)}
              className="px-3 py-2 rounded bg-slate-900 border border-slate-700 text-sm"
            >
              <option value="">選擇日期</option>
              {availDates.map(d => (
                <option key={d.sheet_date} value={d.sheet_date}>
                  {d.sheet_date}（{d.pending_pr_count != null ? (d.pending_pr_count > 0 ? `待處理 ${d.pending_pr_count} 筆` : '已完成') : `${d.row_count} 筆`}）
                </option>
              ))}
            </select>
            <button
              onClick={() => void loadSheet(pickerDate)}
              disabled={!pickerDate || datesLoading}
              className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 disabled:bg-slate-800 disabled:text-slate-500 text-sm"
            >
              {datesLoading ? '讀取中…' : '載入委外列'}
            </button>
          </div>
        </div>

        <section className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="font-semibold mb-3">請購表頭（必填）</h2>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 text-sm">
            <label className="flex flex-col gap-1 md:col-span-2">請購單號（傳入 ARGO 時自動取號）
              <div className="flex gap-2">
                <input value={header.apply_id} readOnly placeholder="匯入時自動取號" className="px-2 py-1.5 rounded bg-slate-950 border border-slate-700 flex-1 min-w-0 font-mono text-slate-300 cursor-default" />
                <button
                  onClick={() => void handleRegenerateApplyId()}
                  disabled={applyIdLoading}
                  className="shrink-0 px-3 py-1.5 rounded bg-indigo-700 hover:bg-indigo-600 disabled:bg-slate-800 disabled:text-slate-500 text-xs whitespace-nowrap"
                >
                  {applyIdLoading ? '取號中…' : '抓最新單號'}
                </button>
              </div>
            </label>
            <label className="flex flex-col gap-1">開立日期
              <input value={header.apply_date} onChange={e => setH('apply_date', e.target.value)} className="px-2 py-1.5 rounded bg-slate-950 border border-slate-700" />
            </label>
            <label className="flex flex-col gap-1">請購部門
              <input value={header.department} onChange={e => setH('department', e.target.value)} className="px-2 py-1.5 rounded bg-slate-950 border border-slate-700" />
            </label>
            <label className="flex flex-col gap-1">請購單狀態
              <select value={header.hold_status} onChange={e => setH('hold_status', e.target.value as PrHeader['hold_status'])} className="px-2 py-1.5 rounded bg-slate-950 border border-slate-700">
                <option value="UNSIGNED">UNSIGNED（建議，待簽核）</option>
                <option value="HOLD">HOLD</option>
                <option value="CLOSE">CLOSE</option>
                <option value="OPEN">OPEN（已開啟傳簽功能時會被拒）</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">幣別
              <input value={header.currency} onChange={e => setH('currency', e.target.value)} className="px-2 py-1.5 rounded bg-slate-950 border border-slate-700" />
            </label>
            <label className="flex flex-col gap-1">傳簽類別 FLOW_TYPE
              <input value={header.flow_type} onChange={e => setH('flow_type', e.target.value)} placeholder="IVAR154-1" className="px-2 py-1.5 rounded bg-slate-950 border border-slate-700" />
            </label>
            <label className="flex flex-col gap-1">承辦人員 APPLY_USER
              <input value={header.apply_user} onChange={e => setH('apply_user', e.target.value)} placeholder="10149" className="px-2 py-1.5 rounded bg-slate-950 border border-slate-700" />
            </label>
          </div>
        </section>

        <section className="bg-slate-900 border border-slate-800 rounded p-4">
          <div className="mb-3 flex items-center gap-2 text-xs">
            <button
              onClick={() => setActiveTab('pending')}
              className={`px-3 py-1.5 rounded border transition-colors ${activeTab === 'pending' ? 'bg-cyan-900/40 border-cyan-700 text-cyan-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}`}
            >
              待匯入（{sourceRows.length}）
            </button>
            <button
              onClick={() => setActiveTab('imported')}
              className={`px-3 py-1.5 rounded border transition-colors ${activeTab === 'imported' ? 'bg-emerald-900/40 border-emerald-700 text-emerald-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}`}
            >
              已匯入(MPO)（{importedMpoRows.length}）
            </button>
          </div>

          {activeTab === 'pending' && (
            <>
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h2 className="font-semibold">明細（{sourceRows.length} 筆）</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => doExport('csv')} disabled={payload.length === 0} className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-sm">匯出 CSV</button>
              <button onClick={() => doExport('xlsx')} disabled={payload.length === 0} className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-sm">匯出 XLSX</button>
              <button onClick={() => void handleImport()} disabled={importing || payload.length === 0} className="px-4 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-500 text-sm">
                {importing ? '匯入中…' : `匯入 ERP（1 張/${payload.length} 筆）`}
              </button>
            </div>
          </div>

          {importProgress && (
            <div className="mb-3 text-xs text-slate-300">進度：{importProgress.done} / {importProgress.total}{importProgress.errors.length > 0 ? `｜失敗 ${importProgress.errors.length}` : ''}</div>
          )}

          {msg && <div className={`mb-3 text-sm ${msg.startsWith('❌') || msg.startsWith('⚠️') ? 'text-amber-300' : 'text-emerald-300'}`}>{msg}</div>}

          <div className="overflow-auto border border-slate-800 rounded">
            <table className="w-full text-xs">
              <thead className="bg-slate-950 text-slate-400">
                <tr>
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">請購單號 (APPLY_ID)</th>
                  <th className="px-2 py-2 text-left">LINE_NO</th>
                  <th className="px-2 py-2 text-left">來源單號</th>
                  <th className="px-2 py-2 text-left">單據種類</th>
                  <th className="px-2 py-2 text-left">料號</th>
                  <th className="px-2 py-2 text-left">品名</th>
                  <th className="px-2 py-2 text-left">數量</th>
                  <th className="px-2 py-2 text-left">交期</th>
                  <th className="px-2 py-2 text-left">來源序號</th>
                  <th className="px-2 py-2 text-left">版本</th>
                  <th className="px-2 py-2 text-left">批號</th>
                  <th className="px-2 py-2 text-left">ERP 對應單位</th>
                  <th className="px-2 py-2 text-left">單位</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.map((row, i) => (
                  <tr key={`${row.row_key || row.order_number}-${i}`} className="border-t border-slate-800/80">
                    <td className="px-2 py-1.5 text-slate-500">{i + 1}</td>
                    <td className="px-2 py-1.5 font-mono text-emerald-300">{header.apply_id || '—'}</td>
                    <td className="px-2 py-1.5 font-mono">{i + 1}</td>
                    <td className="px-2 py-1.5 text-cyan-300">{row.order_number}</td>
                    <td className="px-2 py-1.5">{row.doc_type}</td>
                    <td className="px-2 py-1.5 font-mono">{row.item_code}</td>
                    <td className="px-2 py-1.5">{row.item_name}</td>
                    <td className="px-2 py-1.5 font-mono">{row.quantity}</td>
                    <td className="px-2 py-1.5">{row.delivery_date}</td>
                    <td className="px-2 py-1.5 font-mono">{row.match_line_no || '1'}</td>
                    <td className="px-2 py-1.5">
                      <input value={lineEdits[i]?.mbp_ver ?? '1'} onChange={e => setLE(i, 'mbp_ver', e.target.value)} className="w-16 px-2 py-1 rounded bg-slate-950 border border-slate-700" />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-cyan-300">{row.order_number}</td>
                    <td className="px-2 py-1.5 font-mono">{unitMap[row.item_code] || '—'}</td>
                    <td className="px-2 py-1.5">
                      <input value={lineEdits[i]?.uom ?? 'PCS'} onChange={e => setLE(i, 'uom', e.target.value)} className={`w-20 px-2 py-1 rounded bg-slate-950 border ${unitMap[row.item_code] && lineEdits[i]?.uom !== unitMap[row.item_code] ? 'border-amber-500 text-amber-300' : 'border-slate-700'}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sourceRows.length === 0 && (
            <div className="text-slate-500 text-sm py-8 text-center">
              {loadedDate ? '此日期無待匯入委外請購資料' : '請先選擇日期並載入委外資料'}
            </div>
          )}
            </>
          )}

          {activeTab === 'imported' && (
            <>
              <div className="mb-3 text-sm text-emerald-300">以下為出單表已匹配 MPO 的列（重新載入時不會出現在待匯入）</div>
              <div className="overflow-auto border border-slate-800 rounded">
                <table className="w-full text-xs">
                  <thead className="bg-slate-950 text-slate-400">
                    <tr>
                      <th className="px-2 py-2 text-left">#</th>
                      <th className="px-2 py-2 text-left">MPO 單號</th>
                      <th className="px-2 py-2 text-left">來源單號</th>
                      <th className="px-2 py-2 text-left">單據種類</th>
                      <th className="px-2 py-2 text-left">料號</th>
                      <th className="px-2 py-2 text-left">品名</th>
                      <th className="px-2 py-2 text-left">數量</th>
                      <th className="px-2 py-2 text-left">交期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importedMpoRows.map((row, i) => (
                      <tr key={`${row.row_key || row.order_number}-imp-${i}`} className="border-t border-slate-800/80">
                        <td className="px-2 py-1.5 text-slate-500">{i + 1}</td>
                        <td className="px-2 py-1.5 font-mono text-emerald-300">
                          {row.pr_number || row.mo_number
                            ? <button
                                onClick={() => setPoModalId(row.pr_number || row.mo_number || null)}
                                className="hover:underline underline-offset-2 text-emerald-300 hover:text-emerald-100 transition-colors text-left"
                              >{row.pr_number || row.mo_number}</button>
                            : '—'}</td>
                        <td className="px-2 py-1.5 text-cyan-300">{row.order_number}</td>
                        <td className="px-2 py-1.5">{row.doc_type}</td>
                        <td className="px-2 py-1.5 font-mono">{row.item_code}</td>
                        <td className="px-2 py-1.5">{row.item_name}</td>
                        <td className="px-2 py-1.5 font-mono">{row.quantity}</td>
                        <td className="px-2 py-1.5">{row.delivery_date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {importedMpoRows.length === 0 && (
                <div className="text-slate-500 text-sm py-8 text-center">目前無已匯入 MPO 資料</div>
              )}
            </>
          )}
        </section>

        <section className="bg-slate-900 border border-slate-800 rounded p-4">
          <h2 className="font-semibold mb-2">ERP 同步確認（請購單號）</h2>
          <p className="text-xs text-slate-500 mb-3">查詢 erp_pj_sync（doc_type=請購單號）。先在 ERP 同步區執行請購單同步再查詢。</p>
          <div className="flex gap-2 flex-wrap mb-3">
            <input value={prSearchId} onChange={e => setPrSearchId(e.target.value)} placeholder="輸入請購單號前綴，如 MPO" className="px-3 py-2 rounded bg-slate-950 border border-slate-700 text-sm w-72" />
            <button onClick={() => void searchSyncedPr()} disabled={prSearching} className="px-3 py-2 rounded bg-slate-700 hover:bg-slate-600 text-sm">{prSearching ? '查詢中…' : '查詢'}</button>
          </div>

          {prSyncRows && (
            <div className="overflow-auto border border-slate-800 rounded max-h-80">
              <table className="w-full text-xs">
                <thead className="bg-slate-950 text-slate-400">
                  <tr>
                    <th className="px-2 py-2 text-left">請購單號</th>
                    <th className="px-2 py-2 text-left">序號</th>
                    <th className="px-2 py-2 text-left">料號</th>
                    <th className="px-2 py-2 text-left">數量</th>
                    <th className="px-2 py-2 text-left">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {prSyncRows.map((r, i) => (
                    <tr key={`pr-sync-${i}`} className="border-t border-slate-800/80">
                      <td className="px-2 py-1.5 font-mono text-cyan-300">{String(r.doc_no ?? '')}</td>
                      <td className="px-2 py-1.5 font-mono">{String(r.sub_no ?? '')}</td>
                      <td className="px-2 py-1.5 font-mono">{String(r.item_code ?? '')}</td>
                      <td className="px-2 py-1.5 font-mono">{String(r.qty ?? '')}</td>
                      <td className="px-2 py-1.5">{String(r.status ?? '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <PoOrderModal docNo={poModalId} onClose={() => setPoModalId(null)} />
    </main>
  )
}
