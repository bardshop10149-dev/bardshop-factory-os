import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { pushLineTextToGroups } from '@/lib/lineNotify'

// 「作廢卻已出貨、且查無重開單」掃描 → LINE 通知
//
// 情境（Snow 2026-09-11）：採購單在 ARGO 作廢（HOLD_STATUS=VOID），但 EIP 上已有出貨
// 紀錄。多數是「開錯 → 作廢 → 另開新單」的正常流程（實例 POC2026071601 的 31 行全部
// 都有重開單），帳是完整的；真正要盯的是**作廢後沒有重開**的——貨出去了，ERP 上卻沒有
// 一張有效的採購單對應，帳會缺一塊。首次全庫掃描 59 行 VOID 中只有 2 行屬於此類。
//
// 重開單如何判定：以「來源訂單（SO_PROJECT_ID，常平 PO 退用 MBP_LOT_NO）＋料號」比對，
// 在非 VOID 的採購行裡找下單日不早於原單者。不靠單號相似度——這樣才抓得到
// PO260513015 → PO260513015B（改名重開）與 POC2026071601 → 完全不同單號兩種情形。
// 已知盲點：若重開時**換了料號**（改規格）會誤判為「查無重開」，故訊息措辭是
// 「請確認」而非斷定缺單。
//
// 通知節流：每筆只通知一次，已通知過的記在 po_void_shipped_alerts；沒有新案件就不發送
// （省 LINE 免費額度）。若該行後來補了重開單或作廢被取消，下次掃描自然不再列入。
//
// 觸發與驗證：同其他 /api/cron/*——Vercel Cron 帶 CRON_SECRET，或 POST + WEBHOOK_SECRET
// 手動測試。?dry=1 只回傳訊息不發送、也不寫已通知紀錄。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const PAGE = 1000

interface PoRow {
  doc_no: string
  sub_no: string
  status: string | null
  item_code: string | null
  qty: number | null
  start_date: string | null
  extra: Record<string, unknown> | null
}
interface ShipRow {
  doc_no: string
  sub_no: string
  shipped_at: string | null
  updated_by: string | null
  note: string | null
}

/** 來源訂單：SO_PROJECT_ID 優先，常平 PO 以批號（MBP_LOT_NO）為準 */
function sourceOf(r: PoRow): string {
  const e = r.extra ?? {}
  const so = String(e.SO_PROJECT_ID ?? '').trim()
  if (so) return so.toUpperCase()
  return String(e.MBP_LOT_NO ?? '').trim().toUpperCase()
}

export async function GET(request: NextRequest) { return run(request) }
export async function POST(request: NextRequest) { return run(request) }

async function run(request: NextRequest) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  const authorized = !!bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))
  if (!authorized) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const dry = request.nextUrl.searchParams.get('dry') === '1'

  try {
    const supabase = getSupabaseAdminClient()

    // 單次查詢上限 1000 列，一律分頁讀到底——少讀到的會讓「有沒有重開單」判斷失真
    const poRows: PoRow[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('erp_pj_sync')
        .select('doc_no, sub_no, status, item_code, qty, start_date, extra')
        .eq('doc_type', '採購單號')
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`erp_pj_sync: ${error.message}`)
      const batch = (data ?? []) as unknown as PoRow[]
      poRows.push(...batch)
      if (batch.length < PAGE) break
    }

    const shipRows: ShipRow[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('po_line_tracking')
        .select('doc_no, sub_no, shipped_at, updated_by, note')
        .not('shipped_at', 'is', null)
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`po_line_tracking: ${error.message}`)
      const batch = (data ?? []) as unknown as ShipRow[]
      shipRows.push(...batch)
      if (batch.length < PAGE) break
    }

    const byKey = new Map(poRows.map((r) => [`${r.doc_no}|${r.sub_no}`, r]))

    // 非 VOID 的行，建「來源訂單＋料號」索引供比對重開單
    const reopenIdx = new Map<string, PoRow[]>()
    for (const r of poRows) {
      if ((r.status ?? '').toUpperCase() === 'VOID') continue
      const src = sourceOf(r)
      if (!src || !r.item_code) continue
      const k = `${src}|${r.item_code}`
      reopenIdx.set(k, [...(reopenIdx.get(k) ?? []), r])
    }

    // 找出「作廢 ＋ 有出貨 ＋ 查無重開」
    const orphans: Array<{ row: PoRow; ship: ShipRow; src: string }> = []
    for (const s of shipRows) {
      const r = byKey.get(`${s.doc_no}|${s.sub_no}`)
      if (!r || (r.status ?? '').toUpperCase() !== 'VOID') continue
      const src = sourceOf(r)
      const cands = reopenIdx.get(`${src}|${r.item_code}`) ?? []
      // 下單日不早於原單者才算重開（erp 日期是 YYYY/MM/DD 文字，可字典序比較）
      const reopened = cands.some((c) => String(c.start_date ?? '') >= String(r.start_date ?? ''))
      if (!reopened) orphans.push({ row: r, ship: s, src })
    }

    // 節流：已通知過的不重複發。
    // 刻意不讓「節流表還沒建」變成致命錯誤——那只會讓整支掃描 500 而完全不通知，
    // 比「可能重複通知」糟得多。改為記 tableMissing 回報，讓人知道要去跑 SQL。
    const alertedRows: Array<{ doc_no: string; sub_no: string }> = []
    let alertsTableMissing = false
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('po_void_shipped_alerts').select('doc_no, sub_no').range(from, from + PAGE - 1)
      if (error) {
        console.warn('[void-shipped-scan] 讀節流表失敗（請確認已執行 sql/20260911_po_void_shipped_alerts.sql）:', error.message)
        alertsTableMissing = true
        break
      }
      const batch = (data ?? []) as unknown as Array<{ doc_no: string; sub_no: string }>
      alertedRows.push(...batch)
      if (batch.length < PAGE) break
    }
    const alerted = new Set(alertedRows.map((a) => `${a.doc_no}|${a.sub_no}`))
    const fresh = orphans.filter((o) => !alerted.has(`${o.row.doc_no}|${o.row.sub_no}`))

    if (fresh.length === 0) {
      return NextResponse.json({
        success: true, scanned: shipRows.length, orphans: orphans.length, fresh: 0, alertsTableMissing,
        message: '沒有新的「作廢卻已出貨」案件，未發送通知',
      })
    }

    const lines = fresh
      .sort((a, b) => (b.ship.shipped_at ?? '').localeCompare(a.ship.shipped_at ?? ''))
      .map((o) => {
        const who = o.ship.updated_by ? `由 ${o.ship.updated_by} 標記` : ''
        return `• ${o.row.doc_no}#${o.row.sub_no}　${o.row.item_code ?? ''} 訂${o.row.qty ?? '?'}\n`
          + `　來源 ${o.src || '(無)'}｜出貨 ${String(o.ship.shipped_at ?? '').slice(0, 10)} ${who}`
      })
    const message = '⚠️ 【採購單作廢卻已出貨】\n\n'
      + `發現 ${fresh.length} 筆：採購單在 ARGO 已作廢，但 EIP 上有出貨紀錄，\n`
      + '且查不到對應的重開採購單——貨可能已出、帳上卻沒有有效採購單。\n\n'
      + lines.join('\n\n')
      + '\n\n請確認是否已另開採購單（若重開時換了料號，系統會比對不到，屬誤報）。'

    if (dry) {
      return NextResponse.json({ success: true, dry: true, orphans: orphans.length, fresh: fresh.length, alertsTableMissing, message })
    }

    const token = process.env.LINE_PURCHASING_CHANNEL_TOKEN || ''
    const groupIds = (process.env.LINE_PURCHASING_GROUP_ID || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!token || groupIds.length === 0) {
      return NextResponse.json({
        success: false, fresh: fresh.length, message,
        error: '未設定 LINE_PURCHASING_CHANNEL_TOKEN / LINE_PURCHASING_GROUP_ID',
      }, { status: 500 })
    }

    const results = await pushLineTextToGroups(groupIds, message, token)
    const sent = results.some((r) => r.ok)
    // 只有真的送出才記已通知，否則下次還要再試
    if (sent) {
      const { error } = await supabase.from('po_void_shipped_alerts').upsert(
        fresh.map((o) => ({
          doc_no: o.row.doc_no,
          sub_no: o.row.sub_no,
          item_code: o.row.item_code,
          source_order: o.src || null,
          shipped_at: o.ship.shipped_at,
          notified_at: new Date().toISOString(),
        })),
        { onConflict: 'doc_no,sub_no' },
      )
      if (error) console.error('[void-shipped-scan] 寫入已通知紀錄失敗:', error.message)
    }

    return NextResponse.json({ success: sent, scanned: shipRows.length, orphans: orphans.length, fresh: fresh.length, alertsTableMissing, results })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[void-shipped-scan]', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
