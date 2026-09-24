import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { argoConfigured, argoQuery } from '@/lib/argoQuery'
import { pushLineTextToGroups } from '@/lib/lineNotify'

// 傳簽守門員（每天 17:50 台北時間）
//
// 背景：ARGO 的請購單開出來是 UNSIGNED，要人進 ARGO 桌面程式按「傳簽」才會變 SIGNING、
// 進入簽核流程。2026-09-24 向 ARGO 廠商確認過三件事，答案都是不行：
//   ① IFAF105 不支援更新既有請購單的 HOLD_STATUS
//   ② 沒有專門的「傳簽」介面
//   ③ 傳簽文號／傳簽類別不能由 API 帶入
// 也就是傳簽這一步沒有 API 可走，只能在本機用 UI 自動化按，或人工按。
//
// 既然只能靠 UI 自動化，最大的風險就變成「以為按了、其實沒按」——桌面自動化最常見的
// 失敗是靜默的：視窗沒開、欄位沒對焦、按鈕位置跑掉，腳本照樣「執行成功」。
// 這支就是那道防線：開完單之後直接向 ARGO 求證今天的請購單到底是不是 SIGNING，
// 還卡在 UNSIGNED 就發 LINE 點名單號。一切正常時不發訊息，避免每天固定噪音。
//
// 為什麼直接查 ARGO 而不是查 erp_pj_sync：後者是每小時同步的鏡像，17:50 時 17:10
// 開的單很可能還沒同步進來，會誤報。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** 需要盯的狀態：這兩個都代表還沒送進簽核流程 */
const PENDING_STATUSES = new Set(['UNSIGNED', 'HOLD'])

function taipeiTodayStr(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export async function GET(request: NextRequest) { return run(request) }
export async function POST(request: NextRequest) { return run(request) }

async function run(request: NextRequest) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  if (!bearer || !((cronSecret && bearer === cronSecret) || (webhookSecret && bearer === webhookSecret))) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const dateParam = request.nextUrl.searchParams.get('date')
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : taipeiTodayStr()
    const dry = request.nextUrl.searchParams.get('dry') === '1'

    // 今天自動轉單實際開出來的單號（argoerp_auto_doc_runs 是唯一可靠的來源——
    // 它記的是「ARGO 真的建成功並回寫」的單號）
    const sb = getSupabaseAdminClient()
    const { data: runs } = await sb
      .from('argoerp_auto_doc_runs')
      .select('run_type, doc_no, status')
      .eq('sheet_date', date)
      .not('doc_no', 'is', null)

    const docs = [...new Set(
      (runs ?? [])
        .filter(r => r.status === 'written_back' || r.status === 'imported')
        .map(r => String(r.doc_no ?? '').trim())
        .filter(Boolean)
    )]

    if (docs.length === 0) {
      return NextResponse.json({ success: true, date, checked: 0, note: '今天沒有自動開出任何單，不需檢查' })
    }
    if (!argoConfigured()) {
      return NextResponse.json({ success: false, date, error: '未設定 ARGO 連線環境變數' }, { status: 500 })
    }

    // 逐張向 ARGO 求證目前狀態
    const pending: Array<{ doc: string; status: string }> = []
    const checked: Array<{ doc: string; status: string }> = []
    for (const doc of docs) {
      const rows = await argoQuery('PJ_PROJECT', { PROJECT_ID: `= '${doc}'` })
      const status = String(rows?.[0]?.HOLD_STATUS ?? '').trim().toUpperCase() || '(查無此單)'
      checked.push({ doc, status })
      if (PENDING_STATUSES.has(status) || status === '(查無此單)') pending.push({ doc, status })
    }

    const summary = { date, checked: checked.length, pending: pending.length, detail: checked }
    if (pending.length === 0) {
      return NextResponse.json({ success: true, ...summary, note: '今天開的單都已進入簽核流程，未發送通知' })
    }

    const text = [
      `⚠️ 請購/採購單傳簽檢查（${date}）`,
      '',
      `🔴 有 ${pending.length} 張單還沒傳簽，簽核流程不會啟動：`,
      ...pending.map(p => `・${p.doc}　目前狀態：${p.status}`),
      '',
      '請進 ARGO →「原物料請購作業」找到單號後按「傳簽」。',
      '（傳簽沒有 API 可以代勞，這步只能在 ARGO 裡按）',
    ].join('\n')

    if (dry) return NextResponse.json({ success: true, ...summary, dry: true, message: text })

    const groupIds = (process.env.LINE_GROUP_ID || '').split(',').map(s => s.trim()).filter(Boolean)
    if (groupIds.length === 0) {
      return NextResponse.json({ success: false, ...summary, error: '未設定 LINE_GROUP_ID', message: text }, { status: 500 })
    }
    const results = await pushLineTextToGroups(groupIds, text)
    const failed = results.filter(r => !r.ok)
    return NextResponse.json({
      success: failed.length === 0, ...summary, notified: true, groups: results,
      ...(failed.length > 0 ? { error: `部分群組推播失敗（${failed.length}/${results.length}）` } : {}),
    }, { status: failed.length === 0 ? 200 : 502 })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
