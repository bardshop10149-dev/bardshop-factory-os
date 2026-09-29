import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { describeError, formatSupabaseAdminError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { isYmd } from '@/lib/packaging/closures'
import { CLOSURES_MIGRATION_FILE, listClosures } from '@/lib/packaging/closuresDb'
import {
  CLOSURE_EMAIL_RECIPIENTS_KEY,
  buildClosureEmailHtml,
  buildClosureEmailModel,
  buildClosureEmailSheets,
  closureEmailAttachmentName,
  closureEmailSentLabel,
  closureEmailSubject,
  monthStartOf,
  parseRecipients,
} from '@/lib/packaging/closureEmail'
import { loadSalesForSos, SALES_SYNC_TABLE } from '@/lib/packaging/salesSync'
import { TBL, insertOpLog, isMissingSchema } from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'

// 包裝專區 D105：結案每日通知信。規格 docs/design/2026-09-27-packaging-lines.md 第十四章
//
// 每天台北 18:00（vercel.json：`0 10 * * *` UTC）：取「台北當日」新結案列（含當日又復原的）→ 沒有就 skipped 不寄；
// 有 → ① 當日新結案明細 ② 本月累計與原區塊分布 ③ 本月未復原結案 × erp_so_sales「結案後 ARGO 仍未銷貨」對照，
// 附 Excel（兩個分頁），Resend 寄出，op_log（kind 'closure'、label「結案通知信已寄 <日期>」）記一筆當「當日已寄」標記，
// 同一天再觸發回 skipped: already_sent（Vercel cron 偶爾重跑、手動再打都不會重寄）。
//
// 驗證方式同 daily-machine-output-email：GET／POST 都收，Authorization: Bearer <CRON_SECRET 或 WEBHOOK_SECRET>。
// 寄信：Resend。環境變數（Vercel 正式站要設，未設回明確錯誤、不靜默）：
//   RESEND_API_KEY            — Resend API Key
//   DAILY_MACHINE_OUTPUT_FROM — 寄件人（沿用機台產出通知信同一個變數；專案裡只有這一個寄件人變數，不另設）
// 收件人：app_settings key 'packaging_closure_email_recipients'（JSON 陣列或逗號分隔字串）；沒有 → Snow@bardshoptw.com。
//
// 參數（query 或 POST JSON body）：
//   dry=1 / { dry: true }  — 組好內容回傳 HTML、筆數、收件人，不寄、不寫 op_log、不檢查寄信環境變數（本機驗證用）
//   date=YYYY-MM-DD        — 指定台北日（預設今天；補寄或驗證用）
// 只寫 packaging_op_log（寄出後一筆）；其餘一律唯讀。不查 ARGO。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** 一天最多幾筆結案（listClosures 的 limit；超過就是異常） */
const DAY_LIMIT = 2000
const MONTH_LIMIT = 10000
const CRON_ACTOR = { email: 'cron@packaging-closure-email', name: '系統排程（結案通知信）' }

export async function GET(request: NextRequest) {
  return run(request)
}
export async function POST(request: NextRequest) {
  return run(request)
}

function authorized(request: NextRequest): boolean {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  return !!bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))
}

async function readParams(request: NextRequest): Promise<{ dry: boolean; date: string | null }> {
  const sp = request.nextUrl.searchParams
  let dry = sp.get('dry') === '1' || sp.get('dry') === 'true'
  let date: string | null = sp.get('date')
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null) as { dry?: unknown; date?: unknown } | null
    if (body && typeof body === 'object') {
      if (body.dry === true || body.dry === 1 || body.dry === '1') dry = true
      if (typeof body.date === 'string') date = body.date
    }
  }
  return { dry, date }
}

/** Excel：兩個分頁 → base64（Resend attachments 的 content 格式） */
function sheetsToXlsxBase64(sheets: ReturnType<typeof buildClosureEmailSheets>): string {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows)
    // 欄寬：依表頭與內容長度粗估（中文算 2 格），讓 Snow 打開不用逐欄拉
    ws['!cols'] = s.rows[0].map((_, ci) => {
      const w = s.rows.reduce((m, r) => {
        const v = r[ci]
        const len = v == null ? 0 : [...String(v)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)
        return Math.max(m, len)
      }, 0)
      return { wch: Math.min(48, Math.max(8, w + 2)) }
    })
    XLSX.utils.book_append_sheet(wb, ws, s.name)
  }
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string
}

async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { dry, date: dateParam } = await readParams(request)
    const date = isYmd(dateParam) ? dateParam : todayTaipei()
    if (dateParam && !isYmd(dateParam)) {
      return NextResponse.json({ success: false, error: 'date 格式錯誤（YYYY-MM-DD）' }, { status: 400 })
    }

    // 正式寄送前先確認寄信設定：缺了就明確報錯（不要等到有結案那天才發現沒設）
    const resendKey = process.env.RESEND_API_KEY
    const from = process.env.DAILY_MACHINE_OUTPUT_FROM
    const mailConfigured = !!resendKey && !!from
    if (!dry && !mailConfigured) {
      return NextResponse.json({
        success: false,
        error: '未設定寄信服務：需要 RESEND_API_KEY 與 DAILY_MACHINE_OUTPUT_FROM 環境變數（Vercel 正式站）',
      }, { status: 500 })
    }

    const sb = getSupabaseAdminClient()

    // ① 當日新結案（含當日又復原的）；表未建 → 明確回 migration_required
    let dayClosures
    try {
      dayClosures = await listClosures(sb, date, date, DAY_LIMIT)
    } catch (e) {
      if (isMissingSchema(e)) {
        return NextResponse.json({
          success: false, code: 'migration_required',
          error: `找不到結案資料表（結案功能尚未啟用），請先套用 ${CLOSURES_MIGRATION_FILE}`,
        }, { status: 409 })
      }
      throw e
    }
    if (dayClosures.length === 0) {
      return NextResponse.json({ success: true, skipped: true, reason: 'no_closures', date, dry })
    }

    // 同一天已寄過 → 不重寄（dry 不看這個，方便重複驗證）
    const sentLabel = closureEmailSentLabel(date)
    if (!dry) {
      const { data: sent, error: sentErr } = await sb.from(TBL.opLog).select('id')
        .eq('kind', 'closure').eq('label', sentLabel).order('id', { ascending: false }).limit(1)
      if (sentErr) throw sentErr
      const prev = (sent ?? [])[0] as { id: number | string } | undefined
      if (prev) {
        return NextResponse.json({ success: true, skipped: true, reason: 'already_sent', date, opLogId: Number(prev.id) })
      }
    }

    // ②③ 本月（1 日～當日）結案、銷貨鏡像（只查本月未復原結案的 SO）、同步時間、收件人
    const monthClosures = await listClosures(sb, monthStartOf(date), date, MONTH_LIMIT)
    const monthSos = [...new Set(monthClosures.filter((c) => !c.restoredAt).map((c) => c.so))]
    const [sales, syncRow, settingsRow] = await Promise.all([
      loadSalesForSos(sb, monthSos),
      sb.from(SALES_SYNC_TABLE).select('last_ok_at').eq('id', 1).maybeSingle()
        .then((r) => (r.error ? null : (r.data as { last_ok_at: string | null } | null))),
      sb.from('app_settings').select('value').eq('key', CLOSURE_EMAIL_RECIPIENTS_KEY).maybeSingle()
        .then((r) => (r.error ? null : (r.data as { value: unknown } | null))),
    ])
    const recipients = parseRecipients(settingsRow?.value)

    const model = buildClosureEmailModel({
      date, dayClosures, monthClosures, sales,
      salesSyncedAt: syncRow?.last_ok_at ?? null,
    })
    const subject = closureEmailSubject(model)
    const html = buildClosureEmailHtml(model)
    const sheets = buildClosureEmailSheets(model)
    const counts = {
      day: model.day.length,
      dayRestored: model.dayRestoredCount,
      month: model.monthCount,
      unsold: model.unsold ? model.unsold.length : null,
      unsoldSkippedNoItem: model.unsoldSkippedNoItem,
    }

    if (dry) {
      return NextResponse.json({
        success: true, dry: true, date, mailConfigured, recipients, subject, counts,
        salesSyncedAt: model.salesSyncedAt,
        attachment: { filename: closureEmailAttachmentName(date), sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length - 1 })) },
        html,
      })
    }

    const attachmentBase64 = sheetsToXlsxBase64(sheets)
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from,
        to: recipients,
        subject,
        html,
        attachments: [{ filename: closureEmailAttachmentName(date), content: attachmentBase64 }],
      }),
    })
    const resendJson = await res.json().catch(() => ({})) as { id?: string }
    if (!res.ok) {
      throw new Error(`Resend 寄送失敗 HTTP ${res.status}: ${JSON.stringify(resendJson).slice(0, 300)}`)
    }

    // 「當日已寄」標記（insertOpLog 失敗只 log 不丟：信已寄出；代價是同日再觸發會再寄一次）
    const opLogId = await insertOpLog(sb, {
      actorEmail: CRON_ACTOR.email, actorName: CRON_ACTOR.name, kind: 'closure', label: sentLabel,
      ops: [{ action: 'email_sent', date, recipients, counts, resendId: resendJson.id ?? null }],
    })
    if (opLogId == null) console.error(`[cron/packaging-closure-email] ${date} 已寄出但 op_log 未記（同日再觸發會重寄）`)

    return NextResponse.json({ success: true, date, recipients, counts, resendId: resendJson.id ?? null, opLogId })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : describeError(e)
    console.error('[cron/packaging-closure-email] failed:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
