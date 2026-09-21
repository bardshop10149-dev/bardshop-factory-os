import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import { BUFFER_KEY, readBufferRows } from '@/lib/sara/exchangeCsv'

export const dynamic = 'force-dynamic'

/**
 * 改單：把交換區裡某個品項的舊工序整組換成新的一組（2026-09-21）
 *
 * 原本改單要人工做三步：① 在交換區用訂單號查出舊列逐一刪除 ② 到工序產生器重新產生
 * ③ 再追加回交換區。三步之間只要漏一步或順序錯，塔台就會同時看到新舊兩套工序、
 * 或整個品項消失。這支把三步併成一次伺服器端操作：
 *
 *   讀出 buffer → 濾掉這個品項的舊列 → 接上新列 → 一次寫回
 *
 * 為什麼要放在伺服器端做，而不是前端讀完自己算好再整包寫回：
 *   交換區是共用的單一 app_settings 列，前端「讀→改→寫」中間若有排程（17:30/17:40
 *   的工序產生、或別人的改單）寫入，整包覆蓋會把那些寫入吃掉。放在這裡雖然還是
 *   read-modify-write，但視窗從「使用者操作的數十秒」縮到「單一請求內的數十毫秒」。
 *
 * 比對鍵＝訂單號 + 工單號 + 品號（CSV 的第 0、1、2 欄）。
 *
 * 為什麼不是只用「訂單號+工單號」（autoProcessGen 判斷已送出用的那組鍵）：
 *   實測現有交換區 11,435 列，只用兩段鍵有 120 組是「同一個工單號底下掛了多個品號」——
 *   多半是早期採購/請購單號沒帶行號時留下的資料。只比兩段會把同組其他品項一起刪掉。
 *   加上品號後這類衝突歸零（3,387 組全部單一品號）。
 *
 * 為什麼不再加上批號（第 4 欄）：舊資料的批號是空的、新產生的會帶銷售序號，
 *   把它納入比對會match 不到舊列，結果是舊工序沒刪掉、新工序又寫進去，
 *   塔台同時看到兩套——正是這支要消滅的狀況。
 *
 * POST body: { order_number, mfg_order_number, product_name, rows: string[][] }
 *   rows 可為空陣列＝只刪不加（等同把這個品項從交換區撤掉）
 */
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as {
      order_number?: string
      mfg_order_number?: string
      product_name?: string
      rows?: string[][]
    }
    const orderNo = String(body.order_number ?? '').trim()
    const mfgNo = String(body.mfg_order_number ?? '').trim()
    const productNo = String(body.product_name ?? '').trim()
    const newRows = Array.isArray(body.rows) ? body.rows : []

    if (!orderNo || !mfgNo || !productNo) {
      return NextResponse.json({ success: false, error: '訂單號、工單號、品號都不可為空' }, { status: 400 })
    }
    if (newRows.some(r => !Array.isArray(r))) {
      return NextResponse.json({ success: false, error: 'rows 格式不正確' }, { status: 400 })
    }
    // 防呆：送進來的新列必須都屬於同一個品項，否則會把別人的列摻進來
    const stray = newRows.find(r =>
      String(r[0] ?? '').trim() !== orderNo ||
      String(r[1] ?? '').trim() !== mfgNo ||
      String(r[2] ?? '').trim() !== productNo
    )
    if (stray) {
      return NextResponse.json(
        { success: false, error: `新工序列裡混到了別的品項（${stray[0]} / ${stray[1]} / ${stray[2]}）` },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdminClient()
    const buffer = await readBufferRows(supabase)

    const keep: string[][] = []
    let removed = 0
    for (const r of buffer) {
      if (
        String(r[0] ?? '').trim() === orderNo &&
        String(r[1] ?? '').trim() === mfgNo &&
        String(r[2] ?? '').trim() === productNo
      ) { removed++; continue }
      keep.push(r)
    }

    if (removed === 0 && newRows.length === 0) {
      return NextResponse.json(
        { success: false, error: '交換區裡找不到這個品項的工序，也沒有要寫入的新工序' },
        { status: 404 }
      )
    }

    const finalRows = [...keep, ...newRows]
    const { error } = await supabase.from('app_settings').upsert(
      { key: BUFFER_KEY, value: finalRows, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
    if (error) throw error

    return NextResponse.json({
      success: true,
      removed,
      added: newRows.length,
      count: finalRows.length,
      changed_by: guard.member.email,
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
