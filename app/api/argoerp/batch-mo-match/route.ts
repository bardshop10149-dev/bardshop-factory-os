import { NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Server-side batch MO matching for the last N days of daily_order_sheets.
// Called internally by /api/webhook/sync (action: run_mo_match).

interface SheetRow {
  order_number: string
  item_code: string
  quantity: string
  factory: string
  row_key: string
  mo_status: '已匯入製令' | '暫緩區' | null
  mo_number?: string
  material_prep_status?: string | null
  match_line_no?: string | null
  machine?: string
  [key: string]: unknown
}

interface DailySheet {
  sheet_date: string
  raw_text: string | null
  rows: SheetRow[]
}

export async function POST() {
  const supabase = getSupabaseAdminClient()

  // 取得最近 14 天有資料的出單表
  const today = new Date()
  const fromDateObj = new Date(today)
  fromDateObj.setDate(today.getDate() - 14)
  const fromDate = fromDateObj.toISOString().slice(0, 10)

  const { data: sheets, error: sheetsErr } = await supabase
    .from('daily_order_sheets')
    .select('sheet_date, raw_text, rows')
    .gte('sheet_date', fromDate)
    .order('sheet_date', { ascending: false })

  if (sheetsErr) {
    return NextResponse.json({ success: false, error: sheetsErr.message }, { status: 500 })
  }

  const results: { date: string; updated: number; error?: string }[] = []

  for (const sheet of (sheets ?? []) as DailySheet[]) {
    try {
      const updated = await matchSheet(supabase, sheet)
      results.push({ date: sheet.sheet_date, updated })
    } catch (e) {
      results.push({ date: sheet.sheet_date, updated: 0, error: String(e) })
    }
  }

  return NextResponse.json({ success: true, results })
}

// 製令單號格式驗證
// 有效格式：
//   一般格式：MO[TCO] + 日期後綴(≥8碼數字) + 序號(2碼) = 共≥3後至10碼 = 整高13碼
//   SOA 格式：MO[TCO] + YYMMDD-HHMMSS-NNN + 2碼序號 = 含連字號且後綴≥7碼
// 不符合的四不像製令號（如 MOT26070601）一律排除
function isValidMoFormat(mo: string): boolean {
  if (!/^MO[TCO]/.test(mo)) return false
  const suffix = mo.slice(3)
  if (suffix.includes('-')) {
    // SOA 格式：YYMMDD-XXXXXX-NNNss（連字號後至少 15 碼）
    return suffix.length >= 15 && /^\d{6}-/.test(suffix)
  }
  // 一般格式：日期後綴(>=8碼) + 序號(>=2碼) = >=10碼純數字
  return /^\d{10,}$/.test(suffix)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function matchSheet(supabase: any, sheet: DailySheet): Promise<number> {
  const sheetRows: SheetRow[] = Array.isArray(sheet.rows) ? sheet.rows : []
  if (sheetRows.length === 0) return 0

  const orderNumbers = [...new Set(sheetRows.map(r => r.order_number).filter(Boolean))]
  const noNone = orderNumbers.length > 0 ? orderNumbers : ['__none__']

  // 1. 查 argoerp_mo_upload_log
  const { data: moLogs } = await supabase
    .from('argoerp_mo_upload_log')
    .select('mo_number, source_order, product_code, planned_qty, uploaded_at')
    .in('source_order', noNone)
    .order('uploaded_at', { ascending: false })

  // 過濾已從 argoerp_mo_summary 刪除的製令
  const rawLogMoNumbers = [...new Set(
    ((moLogs ?? []) as { mo_number: string }[]).map(l => l.mo_number).filter((n: string) => n?.startsWith('MO'))
  )] as string[]

  let activeMoNumbers = new Set(rawLogMoNumbers)
  if (rawLogMoNumbers.length > 0) {
    const { data: summaryRows } = await supabase
      .from('argoerp_mo_summary')
      .select('mo_number')
      .in('mo_number', rawLogMoNumbers)
    const stillExists = new Set(((summaryRows ?? []) as { mo_number: string }[]).map(r => r.mo_number))
    activeMoNumbers = stillExists
  }

  const moMap = new Map<string, { mo_number: string }>()
  for (const log of (moLogs ?? []) as { mo_number: string; source_order: string; product_code: string; planned_qty: unknown }[]) {
    if (!log.mo_number?.startsWith('MO')) continue
    if (!activeMoNumbers.has(log.mo_number)) continue
    const qty = String(log.planned_qty ?? '').trim()
    const k1 = `${log.source_order}|${log.product_code}|${qty}`
    const k2 = `${log.source_order}|${log.product_code}`
    if (!moMap.has(k1)) moMap.set(k1, { mo_number: log.mo_number })
    if (!moMap.has(k2)) moMap.set(k2, { mo_number: log.mo_number })
  }

  // 2. 查 erp_mo_lines
  const { data: erp_mo } = await supabase
    .from('erp_mo_lines')
    .select('project_id, source_order, mbp_part, order_qty, line_no')
    .in('source_order', noNone)

  const erpMoMap = new Map<string, string>()
  const erpMoBaseMap = new Map<string, string[]>()
  const erpMoBySourceOrder = new Map<string, Set<string>>()

  for (const mo of (erp_mo ?? []) as { project_id: string; source_order: string; mbp_part: string; order_qty: number; line_no: unknown }[]) {
    if (!mo.source_order || !mo.mbp_part || !mo.project_id) continue
    if (!mo.project_id.startsWith('MO')) continue
    if (mo.line_no != null) {
      const lineNoStr = String(parseInt(String(mo.line_no), 10)).padStart(2, '0')
      const seqKey = `${mo.source_order}|${mo.mbp_part}|${lineNoStr}`
      if (!erpMoMap.has(seqKey)) erpMoMap.set(seqKey, mo.project_id)
    }
    const baseKey = `${mo.source_order}|${mo.mbp_part}`
    const arr = erpMoBaseMap.get(baseKey) ?? []
    if (!arr.includes(mo.project_id)) erpMoBaseMap.set(baseKey, [...arr, mo.project_id])
    const moSet = erpMoBySourceOrder.get(mo.source_order) ?? new Set<string>()
    moSet.add(mo.project_id)
    erpMoBySourceOrder.set(mo.source_order, moSet)
  }

  // 3. 比對每列
  const rawLogMoSet = new Set(rawLogMoNumbers)
  const next: SheetRow[] = sheetRows.map(r => {
    const matchSeq = r.match_line_no != null
      ? String(parseInt(r.match_line_no, 10)).padStart(2, '0')
      : null

    if (r.mo_number?.startsWith('MO')) {
      // 格式驗證：不符合有效製令號編碼的對象一律清除
      if (!isValidMoFormat(r.mo_number)) {
        return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
      }
      // 本系統有此 MO 的上傳紀錄，但已從 argoerp_mo_summary 刪除（使用者主動刪除）
      // 以本系統為準，即使 erp_mo_lines 仍有此記錄也清除
      if (rawLogMoSet.has(r.mo_number) && !activeMoNumbers.has(r.mo_number)) {
        return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
      }
      const erpMosForOrder = erpMoBySourceOrder.get(r.order_number)
      if (erpMosForOrder && !erpMosForOrder.has(r.mo_number)) {
        return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
      }
      // ERP 無此訂單製令紀錄，且製令已從 argoerp_mo_summary 刪除 → 清除殘留値
      if (!erpMosForOrder && !activeMoNumbers.has(r.mo_number)) {
        return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
      }
      if (!matchSeq) return r
      const erpConfirm = erpMoMap.get(`${r.order_number}|${r.item_code}|${matchSeq}`)
      if (!erpConfirm) return r
      if (erpConfirm === r.mo_number) return r
      return { ...r, mo_number: erpConfirm, mo_status: '已匯入製令' as const }
    }

    const qty = String(r.quantity).trim()

    if (matchSeq) {
      const erpHit = erpMoMap.get(`${r.order_number}|${r.item_code}|${matchSeq}`)
      if (erpHit) return { ...r, mo_number: erpHit, mo_status: '已匯入製令' as const }
    }

    const logHit = moMap.get(`${r.order_number}|${r.item_code}|${qty}`) ?? moMap.get(`${r.order_number}|${r.item_code}`)
    if (logHit) {
      const erpMosForOrder = erpMoBySourceOrder.get(r.order_number)
      const stillInArgo = !erpMosForOrder || erpMosForOrder.has(logHit.mo_number)
      if (stillInArgo && (!matchSeq || logHit.mo_number.slice(-2) === matchSeq)) {
        return { ...r, mo_number: logHit.mo_number, mo_status: '已匯入製令' as const }
      }
    }

    const baseHits = erpMoBaseMap.get(`${r.order_number}|${r.item_code}`) ?? []
    if (baseHits.length === 1) return { ...r, mo_number: baseHits[0], mo_status: '已匯入製令' as const }

    if (r.mo_number && !r.mo_number.startsWith('MO')) {
      return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
    }
    return r
  })

  // 4. 查批備料狀態
  const moNumbers = [...new Set(next.map(r => r.mo_number).filter((v): v is string => !!v))]
  if (moNumbers.length > 0) {
    const { data: prepLogs } = await supabase
      .from('argoerp_material_prep_log')
      .select('mo_number, status, logged_at')
      .in('mo_number', moNumbers)
      .order('logged_at', { ascending: false })

    const prepMap = new Map<string, string>()
    for (const log of (prepLogs ?? []) as { mo_number: string; status: string }[]) {
      if (!prepMap.has(log.mo_number)) prepMap.set(log.mo_number, log.status)
    }

    const { data: erpPrepLines } = await supabase
      .from('erp_material_prep_lines')
      .select('mo_number')
      .in('mo_number', moNumbers)

    const erpPrepSet = new Set<string>(
      ((erpPrepLines ?? []) as { mo_number: string }[]).map(l => l.mo_number).filter(Boolean)
    )

    for (let i = 0; i < next.length; i++) {
      const moNo = next[i].mo_number
      if (!moNo) continue
      if (erpPrepSet.has(moNo)) {
        next[i] = { ...next[i], material_prep_status: '已批備料' }
      } else if (prepMap.has(moNo)) {
        next[i] = { ...next[i], material_prep_status: prepMap.get(moNo)! }
      }
    }
  }

  // 5. 計算有更新的筆數
  const updatedCount = next.filter((r, i) => {
    const orig = sheetRows[i]
    return r.mo_number !== orig.mo_number || r.mo_status !== orig.mo_status || r.material_prep_status !== orig.material_prep_status
  }).length

  // 6. 寫回 DB
  await supabase
    .from('daily_order_sheets')
    .update({ rows: next, updated_at: new Date().toISOString() })
    .eq('sheet_date', sheet.sheet_date)

  return updatedCount
}
