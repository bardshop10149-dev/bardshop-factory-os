import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// 與前端 MoRecord 介面對齊
interface MoRecord {
  mo_number: string
  factory: string
  planned_start_date?: string
  planned_end_date?: string
  mo_status?: string
  department?: string
  product_code?: string
  lot_number?: string
  planned_qty?: string
  source_order?: string
  mo_note?: string
  create_date?: string
  saved_at?: string
  prep_status?: '未備料' | '已備料' | '無需備料'
}

const TABLE = 'argoerp_mo_summary'

// 允許寫入的欄位白名單（避免前端塞奇怪欄位）
const ALLOWED_FIELDS = [
  'mo_number', 'factory',
  'planned_start_date', 'planned_end_date', 'mo_status',
  'department', 'product_code', 'lot_number', 'planned_qty',
  'source_order', 'mo_note', 'create_date', 'saved_at',
  'prep_status', 'plate_count', 'machine',
] as const

function pickAllowed(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ALLOWED_FIELDS) {
    if (rec[k] !== undefined) out[k] = rec[k]
  }
  return out
}

// ============================================================
// GET：列出所有製令；可用 ?date=YYYYMMDD&factory=T 篩選
// ============================================================
export async function GET(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const url = new URL(request.url)
    const date = url.searchParams.get('date')        // 例: 20260422
    const factory = url.searchParams.get('factory')  // 例: T / C / O
    const prepStatus = url.searchParams.get('prep_status')  // 未備料 / 已備料 / 無需備料

    const supabase = getSupabaseAdminClient()
    let query = supabase.from(TABLE).select('*').order('created_at', { ascending: false })

    if (factory) query = query.eq('factory', factory)
    if (date) query = query.eq('create_date', date)
    if (prepStatus) query = query.eq('prep_status', prepStatus)

    const { data, error } = await query

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, records: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// POST：批次寫入製令
// body: { records: MoRecord[] }
// ?mode=upsert  → 衝突時覆蓋（直接轉入總表用）
// 預設（無參數）→ INSERT，mo_number 已存在則報錯（不覆蓋）
// ============================================================
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const url = new URL(request.url)
    const isUpsert = url.searchParams.get('mode') === 'upsert'

    const body = await request.json()
    const records: MoRecord[] = Array.isArray(body?.records) ? body.records : []

    if (records.length === 0) {
      return NextResponse.json({ success: false, error: 'records 不可為空' }, { status: 400 })
    }

    // 驗證每筆都有必要欄位
    for (const r of records) {
      if (!r?.mo_number || !r?.factory) {
        return NextResponse.json(
          { success: false, error: `記錄缺少 mo_number 或 factory: ${JSON.stringify(r)}` },
          { status: 400 }
        )
      }
    }

    const cleaned = records.map(r => pickAllowed(r as unknown as Record<string, unknown>))

    const supabase = getSupabaseAdminClient()

    if (isUpsert) {
      // 直接轉入模式：已存在則覆蓋（跳過 ARGO 重新上傳）
      const { data, error } = await supabase
        .from(TABLE)
        .upsert(cleaned, { onConflict: 'mo_number', ignoreDuplicates: false })
        .select('mo_number')

      if (error) {
        return NextResponse.json(
          { success: false, error: formatSupabaseAdminError(error.message) },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, upserted: data?.length ?? 0 })
    }

    const { data, error } = await supabase
      .from(TABLE)
      .insert(cleaned)
      .select('mo_number')

    if (error) {
      // 23505 = unique_violation：表示有重複的 mo_number
      const isDup = error.code === '23505' || /duplicate key|already exists/i.test(error.message)
      return NextResponse.json(
        {
          success: false,
          error: isDup
            ? `製令單號重複，可能有人同時操作或本地流水號未同步：${error.message}`
            : formatSupabaseAdminError(error.message),
          duplicate: isDup,
        },
        { status: isDup ? 409 : 500 }
      )
    }

    return NextResponse.json({ success: true, inserted: data?.length ?? 0 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// DELETE：依 mo_number 列表批次刪除
// body: { mo_numbers: string[] }
// ============================================================
export async function DELETE(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const moNumbers: string[] = Array.isArray(body?.mo_numbers) ? body.mo_numbers : []

    if (moNumbers.length === 0) {
      return NextResponse.json({ success: false, error: 'mo_numbers 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error, count } = await supabase
      .from(TABLE)
      .delete({ count: 'exact' })
      .in('mo_number', moNumbers)

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, deleted: count ?? 0 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// PATCH：批次更新製令的 prep_status
// body: {
//   mo_numbers: string[],
//   prep_status: '未備料' | '已備料' | '無需備料',
//   expected_prep_status?: '未備料' | '已備料' | '無需備料',  // 選填：CAS 條件
// }
//
// expected_prep_status（樂觀鎖 / compare-and-swap）：
//   若提供，僅對「目前 prep_status 等於 expected_prep_status」的列生效，
//   其餘列會被跳過（不更新）。用於避免多人/多分頁同時處理同一批製令時，
//   兩邊的「檢查狀態→送出 ARGO→標記已備料」都各自通過，
//   導致同一張製令被重複送去 ARGO 匯入、實際發料數量加倍（TOCTOU race）。
//   呼叫端應在送出 ARGO 之前就先用這個 CAS 嘗試鎖定（例如把 未備料 CAS 成 已備料），
//   鎖定成功才送 ARGO，鎖定失敗（已被別人搶先）就整批跳過該 mo_number。
//   注意：prep_status 尚未設定過的製令在資料庫中是 NULL，語意上等同「未備料」，
//   所以 expected_prep_status = '未備料' 時，條件會同時涵蓋 NULL。
// ============================================================
const VALID_PREP_STATUS = new Set(['未備料', '已備料', '無需備料'])

export async function PATCH(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const moNumbers: string[] = Array.isArray(body?.mo_numbers) ? body.mo_numbers : []
    const prepStatus: string = body?.prep_status
    const expectedPrepStatus: string | undefined = body?.expected_prep_status

    if (moNumbers.length === 0) {
      return NextResponse.json({ success: false, error: 'mo_numbers 不可為空' }, { status: 400 })
    }
    if (!VALID_PREP_STATUS.has(prepStatus)) {
      return NextResponse.json(
        { success: false, error: `prep_status 必須是 未備料 / 已備料 / 無需備料 之一，實際收到：${prepStatus}` },
        { status: 400 }
      )
    }
    if (expectedPrepStatus !== undefined && !VALID_PREP_STATUS.has(expectedPrepStatus)) {
      return NextResponse.json(
        { success: false, error: `expected_prep_status 必須是 未備料 / 已備料 / 無需備料 之一，實際收到：${expectedPrepStatus}` },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdminClient()

    // create_if_missing：CAS 之外，對「本表尚無此製令」的情況直接建立一筆並視為鎖定成功。
    //
    // 為什麼一定要在伺服器端判斷（2026-09-02 事故）：argoerp_mo_summary 有 RLS，
    // 瀏覽器端（anon/authenticated）讀這張表一律回 0 筆。先前把「哪些製令沒有紀錄」
    // 交給前端預飛查詢判斷，結果永遠誤判成「全部都是新製令」，於是對已存在的列送 INSERT
    // 撞上唯一鍵，整批被擋下並顯示「剛被其他人建立備料紀錄」——但那些製令其實都是未備料、
    // 完全可以正常備料。改為在這裡用 service role 判斷，才看得到真實狀態。
    const createIfMissing = body?.create_if_missing === true
    const insertSeed: Record<string, { factory?: string; product_code?: string; planned_qty?: string }> =
      (body?.insert_seed && typeof body.insert_seed === 'object') ? body.insert_seed : {}

    let query = supabase
      .from(TABLE)
      .update({ prep_status: prepStatus })
      .in('mo_number', moNumbers)

    if (expectedPrepStatus !== undefined) {
      // CAS 條件：只更新目前狀態符合 expected_prep_status 的列。
      // '未備料' 需同時涵蓋 NULL（尚未設定過 prep_status 的製令）。
      query = expectedPrepStatus === '未備料'
        ? query.or('prep_status.eq.未備料,prep_status.is.null')
        : query.eq('prep_status', expectedPrepStatus)
    }

    // 用 select 取回實際被更新的 mo_number，藉此知道「哪些鎖定成功、哪些被跳過」，
    // 而不只是一個籠統的受影響列數。
    const { data, error } = await query.select('mo_number')

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    const updatedMoNumbers = (data ?? []).map(r => r.mo_number as string)
    const updatedSet = new Set(updatedMoNumbers)
    // 只有在使用 CAS（expected_prep_status）時才有意義去算「被跳過」的清單；
    // 一般無條件更新如果請求的 mo_number 在表裡不存在也不算「被搶先」，維持舊行為不回報。
    let skippedMoNumbers = expectedPrepStatus !== undefined
      ? moNumbers.filter(mo => !updatedSet.has(mo))
      : []
    let createdMoNumbers: string[] = []

    // 沒被 CAS 更新到的，可能是「已被別人搶先」也可能是「本表根本沒有這筆」——
    // 用 service role 查出真正不存在的那些，補建立一筆並視為鎖定成功。
    if (createIfMissing && skippedMoNumbers.length > 0) {
      const { data: existingRows, error: existErr } = await supabase
        .from(TABLE).select('mo_number').in('mo_number', skippedMoNumbers)
      if (existErr) {
        return NextResponse.json({ success: false, error: formatSupabaseAdminError(existErr.message) }, { status: 500 })
      }
      const existingSet = new Set((existingRows ?? []).map(r => r.mo_number as string))
      const missing = skippedMoNumbers.filter(mo => !existingSet.has(mo))

      if (missing.length > 0) {
        const rows = missing.map(mo => ({
          mo_number: mo,
          factory: insertSeed[mo]?.factory || 'T',
          product_code: insertSeed[mo]?.product_code ?? null,
          planned_qty: insertSeed[mo]?.planned_qty ?? null,
          prep_status: prepStatus,
        }))
        // ignoreDuplicates：若同一瞬間有別人也建立了同一筆，讓對方的先成立、
        // 本次不覆蓋也不報錯；下方再以實際存在與否決定要不要算進鎖定成功。
        const { error: insErr } = await supabase.from(TABLE).upsert(rows, { onConflict: 'mo_number', ignoreDuplicates: true })
        if (insErr) {
          return NextResponse.json({ success: false, error: formatSupabaseAdminError(insErr.message) }, { status: 500 })
        }
        createdMoNumbers = missing
        const createdSet = new Set(missing)
        skippedMoNumbers = skippedMoNumbers.filter(mo => !createdSet.has(mo))
      }
    }

    return NextResponse.json({
      success: true,
      updated: updatedMoNumbers.length,
      updated_mo_numbers: [...updatedMoNumbers, ...createdMoNumbers],
      created_mo_numbers: createdMoNumbers,
      skipped_mo_numbers: skippedMoNumbers,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// PUT：更新單筆製令的可編輯欄位
// body: { mo_number: string, fields: Partial<MoRecord> }
// ============================================================
export async function PUT(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const moNumber: string = body?.mo_number
    const fields: Record<string, unknown> = body?.fields ?? {}

    if (!moNumber) {
      return NextResponse.json({ success: false, error: 'mo_number 不可為空' }, { status: 400 })
    }

    const cleaned = pickAllowed(fields)
    // mo_number 不允許被更新
    delete cleaned.mo_number

    if (Object.keys(cleaned).length === 0) {
      return NextResponse.json({ success: false, error: '沒有可更新的欄位' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase
      .from(TABLE)
      .update(cleaned)
      .eq('mo_number', moNumber)

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
