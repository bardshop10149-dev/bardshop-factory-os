import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const DONE_STATUSES = new Set(['已備料', '無需備料', '已批備料'])

// GET /api/argoerp/pending-prep
// 掃描所有每日出單表，回傳所有「已匯入製令」但尚未完成批備料的列
// 同時 enrichment：
//   - argoerp_mo_summary.prep_status
//   - argoerp_material_prep_log 最新 argo_slip_no
//   - erp_material_prep_lines 的 slip_no（ARGO 批備料單）
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res

  // 允許客戶端傳 ?include_done=1 讓已備料列也一起回傳（預設不含）
  const { searchParams } = new URL(request.url)
  const includeDone = searchParams.get('include_done') === '1'

  try {
    const supabase = getSupabaseAdminClient()

    // ── 1. 掃描所有出單表 ─────────────────────────────────────────
    const { data: sheets, error: sheetsError } = await supabase
      .from('daily_order_sheets')
      .select('sheet_date, rows')
      .order('sheet_date', { ascending: false })
    if (sheetsError) throw sheetsError

    type PendingRow = Record<string, unknown> & { sheet_date: string }
    const pendingRows: PendingRow[] = []
    const moNumberSet = new Set<string>()

    for (const sheet of (sheets ?? [])) {
      const rows = Array.isArray(sheet.rows) ? (sheet.rows as Record<string, unknown>[]) : []
      for (const row of rows) {
        if (row.mo_status !== '已匯入製令') continue
        if (!row.mo_number) continue
        const prepStatus = row.material_prep_status as string | null
        const isDone = prepStatus && DONE_STATUSES.has(prepStatus)
        if (!includeDone && isDone) continue
        pendingRows.push({ ...row, sheet_date: sheet.sheet_date })
        moNumberSet.add(row.mo_number as string)
      }
    }

    if (pendingRows.length === 0) {
      return NextResponse.json({ success: true, rows: [], total: 0 })
    }

    const moNumbers = [...moNumberSet]

    // ── 2. argoerp_mo_summary → prep_status ──────────────────────
    const summaryMap: Record<string, string> = {}
    {
      // Supabase .in() has a 1000-item limit; chunk if needed
      const CHUNK = 500
      for (let i = 0; i < moNumbers.length; i += CHUNK) {
        const chunk = moNumbers.slice(i, i + CHUNK)
        const { data } = await supabase
          .from('argoerp_mo_summary')
          .select('mo_number, prep_status')
          .in('mo_number', chunk)
        for (const r of (data ?? []) as { mo_number: string; prep_status: string | null }[]) {
          summaryMap[r.mo_number] = r.prep_status ?? '未備料'
        }
      }
    }

    // ── 3. argoerp_material_prep_log → 最新 argo_slip_no ─────────
    const logSlipMap: Record<string, string> = {}
    {
      const CHUNK = 500
      for (let i = 0; i < moNumbers.length; i += CHUNK) {
        const chunk = moNumbers.slice(i, i + CHUNK)
        const { data } = await supabase
          .from('argoerp_material_prep_log')
          .select('mo_number, argo_slip_no, logged_at')
          .in('mo_number', chunk)
          .not('argo_slip_no', 'is', null)
          .order('logged_at', { ascending: false })
        for (const r of (data ?? []) as { mo_number: string; argo_slip_no: string | null }[]) {
          if (r.argo_slip_no && !logSlipMap[r.mo_number]) {
            logSlipMap[r.mo_number] = r.argo_slip_no
          }
        }
      }
    }

    // ── 4. erp_material_prep_lines → ARGO 批備料單號 ─────────────
    const erpSlipMap: Record<string, string> = {}
    {
      const CHUNK = 500
      for (let i = 0; i < moNumbers.length; i += CHUNK) {
        const chunk = moNumbers.slice(i, i + CHUNK)
        const { data } = await supabase
          .from('erp_material_prep_lines')
          .select('mo_number, slip_no')
          .in('mo_number', chunk)
          .not('slip_no', 'is', null)
        for (const r of (data ?? []) as { mo_number: string | null; slip_no: string | null }[]) {
          if (r.mo_number && r.slip_no && !erpSlipMap[r.mo_number]) {
            erpSlipMap[r.mo_number] = r.slip_no
          }
        }
      }
    }

    // ── 5. 組裝最終結果 ────────────────────────────────────────────
    const enriched = pendingRows.map(r => {
      const mo = r.mo_number as string
      const slip = (r.argo_slip_no as string | null) ?? logSlipMap[mo] ?? erpSlipMap[mo] ?? null
      const summaryPrep = summaryMap[mo] ?? null
      // 若 ARGO 同步或 log 已有批備料單號，標記為事實上已備料
      const isArgoPrepped = !!(erpSlipMap[mo])
      return {
        ...r,
        argo_slip_no: slip,
        summary_prep_status: summaryPrep,
        is_argo_prepped: isArgoPrepped,
      }
    })

    // 排序：交期 ASC → 出單日 ASC
    const enrichedRaw = enriched as Array<Record<string, unknown>>
    enrichedRaw.sort((a, b) => {
      const normD = (d: unknown) => {
        const s = String(d ?? '').split(/[ T]/)[0].replace(/\//g, '-').split('-')
        if (s.length !== 3) return ''
        return `${s[0]}-${s[1].padStart(2, '0')}-${s[2].padStart(2, '0')}`
      }
      const da = normD(a['delivery_date']), db = normD(b['delivery_date'])
      if (da !== db) return da.localeCompare(db)
      return String(a['sheet_date']).localeCompare(String(b['sheet_date']))
    })

    return NextResponse.json({ success: true, rows: enriched, total: enriched.length })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
