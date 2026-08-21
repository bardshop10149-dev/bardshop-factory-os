import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { taipeiYesterdayStr } from '@/lib/dailyMachineOutput'

// 每天 05:30（台北時區）排程：讀 05:00 排程算好的快照 + 收件人清單，寄出通知信。
// 收件人清單管理：/api/production/daily-machine-output-recipients
//
// 寄信服務：Resend（https://resend.com）。需要在環境變數設定：
//   RESEND_API_KEY            — Resend 帳號的 API Key
//   DAILY_MACHINE_OUTPUT_FROM — 寄件人（例：通知 <notify@yourdomain.com>；
//                                未驗證網域前可先用 Resend 提供的 onboarding@resend.dev 測試網域）
// 這兩個都還沒設定前，這支會回傳明確錯誤，不會靜默失敗。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const RECIPIENTS_KEY = 'daily_machine_output_recipients'

interface SnapshotRow {
  machine: string
  actualQty: number
  moCount: number
  pendingMoCount: number
  products: Array<{ code: string; qty: number; name: string | null }>
}
interface SnapshotProduct {
  code: string
  qty: number
  name: string | null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildHtml(date: string, rows: SnapshotRow[], packingList: SnapshotProduct[], unassignedMoCount: number): string {
  const machineRows = rows.map(r => {
    const products = r.products.map(p =>
      `${escapeHtml(p.code)}${p.name ? ` · ${escapeHtml(p.name)}` : ''} (${p.qty.toLocaleString()})`,
    ).join('<br>')
    const pending = r.pendingMoCount > 0
      ? `<div style="color:#b45309;font-size:12px;margin-top:2px;">⚠️ ${r.pendingMoCount} 張製令有異動但尚未繳庫</div>`
      : ''
    return `
      <tr>
        <td style="padding:6px 10px;border:1px solid #ddd;font-weight:600;">${escapeHtml(r.machine)}${pending}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${r.actualQty.toLocaleString()}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${r.moCount}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;font-size:13px;">${products || '—'}</td>
      </tr>`
  }).join('')

  const packingRows = packingList.map(p => `
      <tr>
        <td style="padding:6px 10px;border:1px solid #ddd;">${escapeHtml(p.code)}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${p.name ? escapeHtml(p.name) : '—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${p.qty.toLocaleString()}</td>
      </tr>`).join('')

  return `
    <div style="font-family:Arial,'Microsoft JhengHei',sans-serif;color:#111;">
      <h2 style="margin:0 0 4px;">各機台每日產出（${escapeHtml(date)}）</h2>
      <p style="color:#666;font-size:13px;margin:0 0 16px;">
        資料來源：ARGO 製令實際繳庫量，交叉比對機台分配。繳庫日期可能落後實際生產日期幾天，
        「尚未繳庫」的製令數不代表機台沒有動工。${unassignedMoCount > 0 ? `另有 ${unassignedMoCount} 張製令沒有機台分配紀錄，未計入下表。` : ''}
      </p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-bottom:24px;">
        <thead>
          <tr style="background:#f2f2f2;">
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">機台</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:right;">實際繳庫量</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:right;">製令數</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">品號（品名／數量）</th>
          </tr>
        </thead>
        <tbody>${machineRows || '<tr><td colspan="4" style="padding:10px;text-align:center;color:#999;">當天沒有可歸屬到機台的繳庫紀錄</td></tr>'}</tbody>
      </table>

      <h3 style="margin:0 0 4px;">📦 包裝部清單</h3>
      <p style="color:#666;font-size:13px;margin:0 0 8px;">當天所有繳庫製令的品號加總，不分機台</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr style="background:#f2f2f2;">
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">品號</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">品名</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:right;">數量</th>
          </tr>
        </thead>
        <tbody>${packingRows || '<tr><td colspan="3" style="padding:10px;text-align:center;color:#999;">無資料</td></tr>'}</tbody>
      </table>
    </div>`
}

export async function GET(request: NextRequest) {
  return run(request)
}
export async function POST(request: NextRequest) {
  return run(request)
}

async function run(request: NextRequest) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  const authorized = !!bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))
  if (!authorized) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const resendKey = process.env.RESEND_API_KEY
    const from = process.env.DAILY_MACHINE_OUTPUT_FROM
    if (!resendKey || !from) {
      return NextResponse.json({
        success: false,
        error: '未設定寄信服務：需要 RESEND_API_KEY 與 DAILY_MACHINE_OUTPUT_FROM 環境變數',
      }, { status: 500 })
    }

    const dateParam = request.nextUrl.searchParams.get('date')
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : taipeiYesterdayStr()

    const sb = getSupabaseAdminClient()

    const [{ data: snapshot, error: snapshotErr }, { data: settingsRow }] = await Promise.all([
      sb.from('argoerp_daily_machine_output_snapshots').select('*').eq('date', date).maybeSingle(),
      sb.from('app_settings').select('value').eq('key', RECIPIENTS_KEY).maybeSingle(),
    ])
    if (snapshotErr) throw snapshotErr
    if (!snapshot) {
      return NextResponse.json({ success: false, error: `找不到 ${date} 的快照，05:00 的排程可能還沒跑或失敗了` }, { status: 404 })
    }

    const recipients: string[] = Array.isArray(settingsRow?.value) ? (settingsRow!.value as string[]) : []
    if (recipients.length === 0) {
      return NextResponse.json({ success: false, error: '收件人清單是空的，未寄送' }, { status: 200 })
    }

    const html = buildHtml(
      date,
      (snapshot.rows ?? []) as SnapshotRow[],
      (snapshot.packing_list ?? []) as SnapshotProduct[],
      snapshot.unassigned_mo_count ?? 0,
    )

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from,
        to: recipients,
        subject: `各機台每日產出通知 - ${date}`,
        html,
      }),
    })
    const resendJson = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(`Resend 寄送失敗 HTTP ${res.status}: ${JSON.stringify(resendJson).slice(0, 300)}`)
    }

    return NextResponse.json({ success: true, date, recipientCount: recipients.length, resendId: resendJson.id ?? null })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    console.error('[cron/daily-machine-output-email] failed:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
