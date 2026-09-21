import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import { readBufferRows } from '@/lib/sara/exchangeCsv'

export const dynamic = 'force-dynamic'

/**
 * 依銷售單號（＋序號）查出該品項目前在交換區的工序，供異常回報前台自動帶出。
 *
 * 為什麼另開這支而不是讓前台直接打 /api/sara/exchange-csv：
 *   那支會回整包 buffer（目前 11,000 多列、約 7MB）。現場只要看一個品項，
 *   在產線的平板上拉整包又慢又耗流量，所以在伺服器端過濾完只回需要的幾列。
 *
 * GET ?order_no=SO260901015&line_seq=2
 *   line_seq 可省略；給了但比對不到時會退回「整張單的所有品項」讓現場自己挑，
 *   不要因為序號寫法不一致（01 / 1 / 空白）就讓現場查不到東西。
 */

/** 工單號前綴 → 廠區標籤（CSV 裡沒有廠區欄，只能從單號推） */
function factoryOf(mfgNo: string): string {
  if (mfgNo.startsWith('MOT')) return 'T'
  if (mfgNo.startsWith('POC')) return 'C'
  if (mfgNo.startsWith('MPO')) return 'O'
  if (mfgNo.startsWith('MOS')) return 'S'
  return ''
}

export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const sp = request.nextUrl.searchParams
    const orderNo = String(sp.get('order_no') ?? '').trim()
    const lineSeq = String(sp.get('line_seq') ?? '').trim()
    if (!orderNo) {
      return NextResponse.json({ success: false, error: '請輸入銷售單號' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const buffer = await readBufferRows(supabase)

    // 同一個品項的所有工序列＝訂單號+工單號+品號相同（與改單 API 用同一組鍵）
    const groups = new Map<string, {
      order_number: string
      mfg_order_number: string
      product_name: string
      product_desc: string
      lot_number: string
      factory: string
      qty: string
      due: string
      ops: Array<{ seq: string; workcenter: string; job_name: string; job_qty: string; est_time: string }>
    }>()

    const needle = orderNo.toLowerCase()
    for (const r of buffer) {
      const on = String(r[0] ?? '').trim()
      if (!on.toLowerCase().includes(needle)) continue
      const mfg = String(r[1] ?? '').trim()
      const prod = String(r[2] ?? '').trim()
      const k = `${on}||${mfg}||${prod}`
      let g = groups.get(k)
      if (!g) {
        g = {
          order_number: on,
          mfg_order_number: mfg,
          product_name: prod,
          product_desc: String(r[3] ?? '').trim(),
          lot_number: String(r[4] ?? '').trim(),
          factory: factoryOf(mfg),
          qty: String(r[5] ?? '').trim(),
          due: String(r[6] ?? '').trim(),
          ops: [],
        }
        groups.set(k, g)
      }
      g.ops.push({
        seq: String(r[9] ?? ''), workcenter: String(r[10] ?? ''), job_name: String(r[11] ?? ''),
        job_qty: String(r[12] ?? ''), est_time: String(r[14] ?? ''),
      })
    }

    const all = [...groups.values()]
    for (const g of all) g.ops.sort((a, b) => Number(a.seq) - Number(b.seq))

    // 序號比對：批號（生產批號欄）優先，其次看製令號末兩碼——
    // 兩種寫法都容忍前導 0（現場填 1、系統存 01 是常態）
    let matched = all
    if (lineSeq) {
      const n = Number(lineSeq)
      const norm = Number.isFinite(n) ? String(n) : lineSeq
      const padded = Number.isFinite(n) ? String(n).padStart(2, '0') : lineSeq
      const bySeq = all.filter(g => {
        const lot = g.lot_number
        if (lot && (lot === lineSeq || String(Number(lot)) === norm)) return true
        if (g.mfg_order_number.startsWith('MOT') && g.mfg_order_number.endsWith(padded)) return true
        return false
      })
      if (bySeq.length > 0) matched = bySeq
    }

    return NextResponse.json({
      success: true,
      items: matched,
      // 有給序號但比對不到時告訴前端「這是整張單的結果」，畫面上好提示
      seq_matched: !lineSeq ? null : matched.length !== all.length,
      total_in_order: all.length,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
