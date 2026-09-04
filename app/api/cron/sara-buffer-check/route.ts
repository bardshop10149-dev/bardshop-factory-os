import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { pushLineTextToGroups } from '@/lib/lineNotify'

// 塔台交換區送達檢查（每天 17:45 台北時間，塔台 18:00 來拉之前的最後一道防線）
//
// 為什麼需要這支：塔台每天固定 18:00 主動來拉交換區，我方無法推送——只要當天的工序沒有
// 在 18:00 前寫進交換區，現場隔天就會看到「塔臺無資料」而無法作業，且目前只能靠現場的人
// 回報才會發現。2026-09-02 就發生過一次（排程時間變更當天兩邊都沒觸發，整日工序未送達，
// 隔天多個站點回報無資料）。這支在 18:00 前做最後確認，有問題直接發 LINE 通知。
//
// 檢查兩件事：
//   1. 當日出單表上「已轉單」的品項，是否都已經在交換區裡（比對方式與 autoProcessGen 一致：
//      鍵＝訂單號||工單號，工單號依廠別取製令號／採購單號-行號／請購單號-行號）
//   2. 塔台是否正常來拉（超過 26 小時沒拉取 = 對方那端可能停了，我方資料再正確也送不出去）
//
// 一切正常時不發訊息（避免每天固定噪音，讓警示出現時真的代表有事）。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PULL_STALE_HOURS = 26

function taipeiTodayStr(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function parseQtyNum(v: unknown): number {
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
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
    const sb = getSupabaseAdminClient()

    const [sheetRes, bufRes, pullRes, pendRes] = await Promise.all([
      sb.from('daily_order_sheets').select('rows').eq('sheet_date', date).maybeSingle(),
      sb.from('app_settings').select('value').eq('key', 'sara_csv_buffer').maybeSingle(),
      sb.from('app_settings').select('value').eq('key', 'sara_csv_last_pulled_at').maybeSingle(),
      sb.from('app_settings').select('value').eq('key', 'sara_process_gen_pending').maybeSingle(),
    ])

    const rows = Array.isArray(sheetRes.data?.rows) ? sheetRes.data!.rows as Record<string, unknown>[] : []
    const bufferRows = Array.isArray(bufRes.data?.value) ? bufRes.data!.value as string[][] : []
    const inBuffer = new Set(bufferRows.map(r => `${r[0] ?? ''}||${r[1] ?? ''}`))
    const pendingList = Array.isArray(pendRes.data?.value) ? pendRes.data!.value as Record<string, unknown>[] : []
    // 已列入待處理的品項屬於「已知且已通報」，不重複算成漏送
    const pendingKeys = new Set(pendingList.map(p => `${p.order_number}||${p.item_code}||${p.line_seq ?? ''}`))

    // 找出當日應該進交換區、但實際不在的品項（比對規則與 autoProcessGen 完全一致）
    const missing: { order: string; ref: string; item: string }[] = []
    let transacted = 0
    for (const r of rows) {
      const order = String(r.order_number ?? '').trim()
      const item = String(r.item_code ?? '').trim()
      if (!order || !item) continue
      if (parseQtyNum(r.quantity) <= 0) continue
      const factory = String(r.factory ?? '')
      const poNo = String(r.po_number ?? '').trim()
      const prNo = String(r.pr_number ?? '').trim()
      const poSub = String(r.po_sub_no ?? '').trim()
      const prSub = String(r.pr_sub_no ?? '').trim()
      const ref =
        factory === 'C' ? (poNo ? `${poNo}${poSub ? `-${poSub}` : ''}` : '') :
        factory === 'O' ? (prNo ? `${prNo}${prSub ? `-${prSub}` : ''}` : '') :
                          String(r.mo_number ?? '').trim()
      if (!ref) continue   // 尚未轉單——不算漏送（另有待處理清單追蹤）
      transacted++
      const lineSeq = String(r.match_line_no ?? '').trim() || String(r.line_no_input ?? '').trim() || ''
      if (inBuffer.has(`${order}||${ref}`)) continue
      if (pendingKeys.has(`${order}||${item}||${lineSeq}`)) continue
      missing.push({ order, ref, item })
    }

    // 塔台是否正常來拉
    const lastPulled = typeof pullRes.data?.value === 'string' ? pullRes.data.value : null
    const hoursSincePull = lastPulled ? (Date.now() - Date.parse(lastPulled)) / 3600000 : Infinity
    const pullStale = hoursSincePull > PULL_STALE_HOURS

    const problems: string[] = []
    if (missing.length > 0) {
      const sample = missing.slice(0, 8).map(m => `・${m.order} ${m.ref}（${m.item}）`).join('\n')
      problems.push(`🔴 有 ${missing.length} 筆已轉單品項還沒進交換區，塔台 18:00 來拉會拿不到：\n${sample}${missing.length > 8 ? `\n…等共 ${missing.length} 筆` : ''}`)
    }
    if (pullStale) {
      problems.push(`🔴 塔台已經 ${hoursSincePull === Infinity ? '從未' : `${hoursSincePull.toFixed(1)} 小時沒有`}來拉取交換區（最後一次：${lastPulled ? new Date(lastPulled).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '無紀錄'}），資料備妥也送不出去，請聯繫塔台廠商。`)
    }

    const summary = {
      date,
      sheet_rows: rows.length,
      transacted,
      missing: missing.length,
      pending: pendingList.length,
      buffer_rows: bufferRows.length,
      last_pulled_at: lastPulled,
      hours_since_pull: hoursSincePull === Infinity ? null : Number(hoursSincePull.toFixed(1)),
      alert: problems.length > 0,
    }

    if (problems.length === 0) {
      return NextResponse.json({ success: true, ...summary, note: '一切正常，未發送通知' })
    }

    const text = [
      `⚠️ 塔台交換區送達檢查（${date}）`,
      '',
      ...problems,
      '',
      `當日已轉單 ${transacted} 筆・交換區 ${bufferRows.length} 列・待處理 ${pendingList.length} 筆`,
      '（塔台每天 18:00 來拉，請於此之前處理）',
    ].join('\n')

    if (dry) return NextResponse.json({ success: true, ...summary, dry: true, message: text })

    const groupIds = (process.env.LINE_GROUP_ID || '').split(',').map(s => s.trim()).filter(Boolean)
    if (groupIds.length === 0) {
      return NextResponse.json({ success: false, ...summary, error: '未設定 LINE_GROUP_ID，無法發送警示', message: text }, { status: 500 })
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
