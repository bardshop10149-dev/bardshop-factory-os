import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { argoConfigured, argoQuery } from '@/lib/argoQuery'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// 待傳簽清單／單張狀態查詢——給本機的傳簽自動化腳本用。
//
// 背景：ARGO 的請購單開出來是 UNSIGNED，要人進 ARGO 桌面程式按「傳簽」才會進入
// 簽核流程。2026-09-24 向廠商確認過，傳簽沒有 API：IFAF105 不能更新 HOLD_STATUS、
// 沒有專門的傳簽介面、傳簽文號也不能由 API 帶入。實際查 PJ_APPLYPROJECT 也印證了
// 傳簽會另外產生一張 PFM 簽核文件（PFM_DOCUMENT_NO），不是改幾個欄位就算數。
//
// 所以傳簽只能在本機用 UI 自動化按。這支負責兩件腳本自己做不到的事：
//   ① 告訴腳本「今天該按哪幾張單」——不用在 ARGO 裡用日期搜尋，直接給單號
//   ② 按完之後回頭向 ARGO 求證狀態有沒有真的變成 SIGNING
//
// ② 是這整套的關鍵。桌面自動化的失敗幾乎都是靜默的：視窗沒開、欄位沒對焦、
// 按鈕位置跑掉，腳本照樣回報成功。每按一張就驗一張，錯了立刻停，不要繼續空按。
//
// 認證：本機腳本用 Bearer WEBHOOK_SECRET（與 cron 同一把）；瀏覽器開則走登入。
//
// GET /api/argoerp/pending-sign              今天待傳簽的單號
// GET /api/argoerp/pending-sign?date=...     指定日期
// GET /api/argoerp/pending-sign?verify=單號  只查這一張現在的狀態
// ─────────────────────────────────────────────────────────────────────────────

/** 這些狀態代表還沒送進簽核流程 */
const PENDING_STATUSES = new Set(['UNSIGNED', 'HOLD'])

function taipeiTodayStr(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 查 ARGO 這張單目前的狀態（請購走 PJ_APPLYPROJECT，採購走 PJ_PROJECT） */
async function statusOf(docNo: string): Promise<{ status: string; signFlag: string | null; flowDoc: string | null }> {
  // 請購單（MPO/MP/PR 開頭）與採購單（POC/PO）表不同，先試請購再試採購
  for (const [table, idField] of [['PJ_APPLYPROJECT', 'APPLY_ID'], ['PJ_PROJECT', 'PROJECT_ID']] as const) {
    const rows = await argoQuery(table, { [idField]: `= '${docNo}'` }, { showNull: 'Y' })
    const row = rows?.[0]
    if (row) {
      return {
        status: String(row.HOLD_STATUS ?? '').trim().toUpperCase() || '(無狀態)',
        signFlag: row.SIGN_FLAG == null ? null : String(row.SIGN_FLAG),
        flowDoc: row.PFM_DOCUMENT_NO == null ? null : String(row.PFM_DOCUMENT_NO),
      }
    }
  }
  return { status: '(查無此單)', signFlag: null, flowDoc: null }
}

export async function GET(request: NextRequest) {
  // 本機腳本走 secret；人用瀏覽器開則要求登入
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  const cronSecret = process.env.CRON_SECRET ?? ''
  const bySecret = !!bearer && ((webhookSecret && bearer === webhookSecret) || (cronSecret && bearer === cronSecret))
  if (!bySecret) {
    const guard = await guardAuth()
    if (!guard.ok) return guard.res
  }

  try {
    if (!argoConfigured()) {
      return NextResponse.json({ success: false, error: '未設定 ARGO 連線環境變數' }, { status: 500 })
    }

    // ── 單張查詢（腳本按完傳簽後用這個驗證）──
    const verify = (request.nextUrl.searchParams.get('verify') ?? '').trim()
    if (verify) {
      const st = await statusOf(verify)
      return NextResponse.json({
        success: true,
        doc_no: verify,
        ...st,
        signed: !PENDING_STATUSES.has(st.status) && st.status !== '(查無此單)',
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // ── 待傳簽清單 ──
    const dateParam = request.nextUrl.searchParams.get('date')
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : taipeiTodayStr()

    const sb = getSupabaseAdminClient()
    const { data: runs } = await sb
      .from('argoerp_auto_doc_runs')
      .select('run_type, doc_no, status')
      .eq('sheet_date', date)
      .not('doc_no', 'is', null)

    const docs = [...new Set(
      (runs ?? [])
        .filter(r => r.status === 'written_back' || r.status === 'imported')
        .map(r => ({ doc: String(r.doc_no ?? '').trim(), type: String(r.run_type ?? '') }))
        .filter(x => x.doc)
        .map(x => JSON.stringify(x))
    )].map(x => JSON.parse(x) as { doc: string; type: string })

    const checked: Array<{ doc_no: string; run_type: string; status: string; pending: boolean }> = []
    for (const d of docs) {
      const st = await statusOf(d.doc)
      checked.push({
        doc_no: d.doc,
        run_type: d.type,
        status: st.status,
        pending: PENDING_STATUSES.has(st.status),
      })
    }

    return NextResponse.json({
      success: true,
      date,
      // 腳本只要讀這個陣列，逐張處理
      pending: checked.filter(c => c.pending).map(c => c.doc_no),
      all: checked,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
