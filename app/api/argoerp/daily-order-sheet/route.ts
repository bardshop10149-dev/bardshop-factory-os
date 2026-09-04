import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, describeError } from '@/lib/supabaseAdmin'
import { guardAuth, guardPermission } from '@/lib/requireAuth'
import { computeSheetCounts, mergeIncomingRowsWithExisting } from '@/lib/argoerp/dailyOrderSheetShared'

export const dynamic = 'force-dynamic'

const TABLE = 'daily_order_sheets'

// GET:
//   無 date 參數 → 回傳所有已儲存日期 ([{sheet_date, row_count, updated_at}])
//   有 date=YYYY-MM-DD → 回傳該日出單表（含 rows）
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    const supabase = getSupabaseAdminClient()

    const search = searchParams.get('search')

    // ?dup_index=1 — 回傳所有日期裡「訂單號+序號」的輕量索引（只有這兩個欄位+日期，不含
    // 完整 rows），供貼上解析資料時偵測「這筆訂單+序號是否已經在其他日期的出單表出現過」
    // （重複發單警示）。跟下面 !date 的列表查詢一樣要整包掃 rows，但只在使用者貼上資料
    // 這種低頻操作才會呼叫，不像列表查詢是每次進頁面就打一次，可以接受這個成本。
    if (searchParams.get('dup_index') === '1') {
      const { data, error } = await supabase.from(TABLE).select('sheet_date, rows')
      if (error) throw error
      const index: { order_number: string; line: string; sheet_date: string }[] = []
      for (const sheet of (data ?? []) as { sheet_date: string; rows: unknown }[]) {
        const rowsArr = Array.isArray(sheet.rows) ? sheet.rows as Array<Record<string, unknown>> : []
        for (const row of rowsArr) {
          const orderNo = typeof row.order_number === 'string' ? row.order_number : ''
          const line = typeof row.line_no_input === 'string' && row.line_no_input
            ? row.line_no_input
            : (typeof row.match_line_no === 'string' ? row.match_line_no : '')
          if (!orderNo || !line) continue
          index.push({ order_number: orderNo, line, sheet_date: sheet.sheet_date })
        }
      }
      return NextResponse.json({ success: true, index }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // ?search=<query> — 跨日期單號搜尋（不需 date 參數）
    if (!date && search) {
      const q = search.trim().toLowerCase()
      const { data, error } = await supabase
        .from(TABLE)
        .select('sheet_date, rows')
        .order('sheet_date', { ascending: false })
      if (error) throw error
      const results: { sheet_date: string; rows: Record<string, unknown>[] }[] = []
      for (const sheet of (data ?? [])) {
        const rowsArr = Array.isArray(sheet.rows) ? (sheet.rows as Array<Record<string, unknown>>) : []
        const matched = rowsArr.filter(r => {
          const on = typeof r.order_number === 'string' ? r.order_number.toLowerCase() : ''
          const mo = typeof r.mo_number === 'string' ? r.mo_number.toLowerCase() : ''
          return on.includes(q) || mo.includes(q)
        })
        if (matched.length > 0) results.push({ sheet_date: sheet.sheet_date, rows: matched })
      }
      return NextResponse.json({ success: true, results }, { headers: { 'Cache-Control': 'no-store' } })
    }

    if (!date) {
      // 只選預先算好的計數欄位，不選 rows——實測 rows 整包抓下來（86 天）約 5.8MB、
      // 讓這支列表查詢多花 100ms 以上，只為了算幾個小數字，划不來
      const { data, error } = await supabase
        .from(TABLE)
        .select('sheet_date, row_count, pending_count, pending_pr_count, pending_c_count, updated_at')
        .order('sheet_date', { ascending: false })
      if (error) throw error
      return NextResponse.json({ success: true, sheets: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // ?date=X&meta=1 — 只回傳 updated_at，供前端輪詢偵測「其他人是否更新過」用，
    // 不用每次輪詢都把整份 rows（可能很大）都抓回來
    if (searchParams.get('meta') === '1') {
      const { data: metaData, error: metaError } = await supabase
        .from(TABLE)
        .select('sheet_date, updated_at, updated_by_name')
        .eq('sheet_date', date)
        .maybeSingle()
      if (metaError) throw metaError
      return NextResponse.json({ success: true, sheet: metaData }, { headers: { 'Cache-Control': 'no-store' } })
    }

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('sheet_date', date)
      .single()
    if (error && error.code === 'PGRST116') {
      // not found
      return NextResponse.json({ success: true, sheet: null }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (error) throw error
    return NextResponse.json({ success: true, sheet: data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = describeError(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST: 新增或完整取代一天的出單表
// Body: { sheet_date: 'YYYY-MM-DD', raw_text: string, rows: SheetRow[] }
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as {
      sheet_date?: string
      raw_text?: string
      rows?: unknown[]
    }
    const { sheet_date, raw_text = '', rows = [] } = body
    if (!sheet_date || !/^\d{4}-\d{2}-\d{2}$/.test(sheet_date)) {
      return NextResponse.json({ success: false, error: '請提供有效的 sheet_date (YYYY-MM-DD)' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    // 讀取現有 rows，以保留由外部 PATCH（如集單同步）寫入但本次 POST 未帶上的 mo_number / mo_status
    const { data: existing } = await supabase
      .from(TABLE)
      .select('rows')
      .eq('sheet_date', sheet_date)
      .maybeSingle()
    const existingRows = Array.isArray(existing?.rows) ? (existing!.rows as Record<string, unknown>[]) : []
    const mergedRows = mergeIncomingRowsWithExisting(existingRows, rows as Record<string, unknown>[])

    const { data, error } = await supabase
      .from(TABLE)
      .upsert({
        sheet_date,
        raw_text,
        rows: mergedRows,
        ...computeSheetCounts(mergedRows),
        updated_at: new Date().toISOString(),
        updated_by: guard.member.email,
        updated_by_name: guard.member.realName ?? guard.member.email,
        last_action: 'save',
      }, { onConflict: 'sheet_date' })
      .select()
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, sheet: data })
  } catch (e) {
    const msg = describeError(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// PATCH: 更新特定列的狀態（mo_status / mo_number / 序號比對 / 批備料）
// Body: { sheet_date: 'YYYY-MM-DD', updates: [{ row_key, mo_status?, mo_number?, match_status?, match_line_no?, match_pdl_seq?, match_reason?, material_prep_status? }] }
export async function PATCH(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as {
      sheet_date?: string
      // 依 row_key 局部更新欄位（原有用法，其他頁面如批備料仍在用）
      updates?: Array<Record<string, unknown> & { row_key: string }>
      // 整列取代：用於「更正後 row_key 會變」的情境（改單專區、廠區轉換）
      replace?: Array<{ match_row_key: string; row: Record<string, unknown> }>
      // 新增列（貼上新資料、美編出單表轉入）
      add?: Array<Record<string, unknown>>
      // 刪除列（退單、刪除單列）
      remove?: string[]
      // 整份取代（僅供「首次貼上建立整張表」等真正需要覆蓋全表的情境明確指定）
      replace_all?: Array<Record<string, unknown>>
      raw_text?: string
    }
    const { sheet_date, updates, replace, add, remove, replace_all, raw_text } = body
    if (!sheet_date) {
      return NextResponse.json({ success: false, error: '請提供 sheet_date' }, { status: 400 })
    }
    const hasWork = (updates?.length ?? 0) > 0 || (replace?.length ?? 0) > 0
      || (add?.length ?? 0) > 0 || (remove?.length ?? 0) > 0 || Array.isArray(replace_all)
    if (!hasWork) {
      return NextResponse.json({ success: false, error: '請提供 updates / replace / add / remove / replace_all 其中至少一項' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    // ── 併發安全：read-modify-write 用 updated_at 做 compare-and-swap ──
    // rows 是單一 JSONB 欄位，兩個同時進來的請求若各自「讀→改→寫」，後寫的會把先寫的
    // 蓋掉（實測：同時改不同兩列，其中一列的改動會消失）。這裡在 UPDATE 的 WHERE 條件
    // 帶上「讀取當下的 updated_at」，只有值沒被別人改過才寫得進去；若 0 筆命中代表期間
    // 有人搶先寫入，就重新讀取最新內容、把本次 delta 重新套用一次再試。
    // delta 語意（依 row_key 定位）本身可重放，重試不會產生重複或錯亂。
    const MAX_ATTEMPTS = 10
    let rows: Record<string, unknown>[] = []
    let committed = false
    let lastConflictError: string | null = null

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !committed; attempt++) {
      const { data: existing, error: fetchError } = await supabase
        .from(TABLE)
        .select('rows, updated_at')
        .eq('sheet_date', sheet_date)
        .single()
      if (fetchError && fetchError.code === 'PGRST116') {
        return NextResponse.json({ success: false, error: '找不到指定日期的出單表' }, { status: 404 })
      }
      if (fetchError) throw fetchError

      const readUpdatedAt = existing.updated_at as string
      rows = Array.isArray(existing.rows) ? existing.rows as Record<string, unknown>[] : []
      rows = applyDelta(rows, { updates, replace, add, remove, replace_all })

      const { data: written, error: updateError } = await supabase
        .from(TABLE)
        .update({
          rows,
          ...computeSheetCounts(rows),
          ...(typeof raw_text === 'string' ? { raw_text } : {}),
          updated_at: new Date().toISOString(),
          updated_by: guard.member.email,
          updated_by_name: guard.member.realName ?? guard.member.email,
          last_action: 'patch',
        })
        .eq('sheet_date', sheet_date)
        .eq('updated_at', readUpdatedAt)   // CAS：只有沒被別人改過才寫得進去
        .select('sheet_date')
      if (updateError) throw updateError

      if ((written ?? []).length > 0) {
        committed = true
      } else {
        lastConflictError = '出單表在寫入期間被其他人更新'
        // 指數退避＋隨機抖動：多個請求同時碰撞時，若用固定間隔會一起重試、一起再撞，
        // 抖動讓它們錯開，實測 8 個併發請求可全數成功（無抖動時會有一筆耗盡重試）
        const backoff = Math.min(30 * 2 ** attempt, 400) + Math.random() * 60
        await new Promise(r => setTimeout(r, backoff))
      }
    }

    if (!committed) {
      return NextResponse.json(
        { success: false, error: `${lastConflictError ?? '寫入衝突'}，已重試 ${MAX_ATTEMPTS} 次仍未成功，請稍後再試` },
        { status: 409 }
      )
    }

    return NextResponse.json({
      success: true,
      updated: updates?.length ?? 0,
      replaced: replace?.length ?? 0,
      added: add?.length ?? 0,
      removed: remove?.length ?? 0,
      total_rows: rows.length,
      rows,
    })
  } catch (e) {
    const msg = describeError(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

/** 把 delta 套用到一份 rows 上，回傳新的 rows（純函式，供 CAS 重試時重新套用） */
function applyDelta(
  input: Record<string, unknown>[],
  delta: {
    updates?: Array<Record<string, unknown> & { row_key: string }>
    replace?: Array<{ match_row_key: string; row: Record<string, unknown> }>
    add?: Array<Record<string, unknown>>
    remove?: string[]
    replace_all?: Array<Record<string, unknown>>
  },
): Record<string, unknown>[] {
  const { updates, replace, add, remove, replace_all } = delta
  let rows = input

  // 0) replace_all：明確指定要覆蓋整份（走既有的狀態保留合併，維持原 POST 語意）
  if (Array.isArray(replace_all)) {
    rows = mergeIncomingRowsWithExisting(rows, replace_all)
  }

  // 1) updates：依 row_key 局部更新欄位（row_key 本身不可被 updates 改動，
  //    要改 row_key 請用 replace，避免局部更新意外造出重複/孤兒列）
  if (updates && updates.length > 0) {
    const updateMap = new Map(updates.map(u => [u.row_key, u]))
    rows = rows.map(row => {
      const upd = updateMap.get(row.row_key as string)
      if (!upd) return row
      const merged = { ...row }
      for (const [k, v] of Object.entries(upd)) {
        if (k === 'row_key') continue
        if (v !== undefined) merged[k] = v
      }
      return merged
    })
  }

  // 2) replace：整列取代（可同時換掉 row_key）
  if (replace && replace.length > 0) {
    const replaceMap = new Map(replace.map(r => [r.match_row_key, r.row]))
    rows = rows.map(row => replaceMap.get(row.row_key as string) ?? row)
  }

  // 3) remove：刪除指定 row_key 的列
  if (remove && remove.length > 0) {
    const removeSet = new Set(remove)
    rows = rows.filter(row => !removeSet.has(row.row_key as string))
  }

  // 4) add：附加新列（同 row_key 已存在者略過，避免重複附加）
  if (add && add.length > 0) {
    const existingKeys = new Set(rows.map(r => r.row_key as string))
    const appended = [...rows]
    for (const r of add) {
      if (existingKeys.has(r.row_key as string)) continue
      appended.push(r)
      existingKeys.add(r.row_key as string)
    }
    rows = appended
  }

  return rows
}

// DELETE: 刪除指定日期的出單表
// Query: ?date=YYYY-MM-DD
export async function DELETE(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    if (!date) return NextResponse.json({ success: false, error: '請提供 date 參數' }, { status: 400 })

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).delete().eq('sheet_date', date)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = describeError(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
