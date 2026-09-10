import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TABLE = 'item_code_requests'

/** 大類：ARGO PRODUCT_CATEGORY，同時也是料號第一碼 */
const CATEGORIES = ['M', 'W', 'P', 'C', 'S', 'A', 'O'] as const
const STATUSES = ['pending', 'created', 'rejected'] as const

/** 只有這些欄位允許由前端寫入；申請人、單號、狀態一律由後端決定 */
const INPUT_FIELDS = [
  'template_part',
  'part_name', 'part_desc', 'unit_of_measure', 'product_category', 'product_category_2',
  'source_type', 'inventory_type', 'cost_category', 'leadtime_flag',
  'bom_warehouse_id', 'lot_no_flag', 'expense_flag',
  'level_code_inv', 'account_no_inv', 'validdate',
  'suggested_part', 'note', 'reference_url',
] as const

const REQUIRED_FIELDS: { key: string; label: string }[] = [
  { key: 'part_name', label: '品項名稱' },
  { key: 'unit_of_measure', label: '單位' },
  { key: 'product_category', label: '產品大類' },
  { key: 'product_category_2', label: '產品次類別' },
  { key: 'note', label: '用途說明' },
]

const str = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s ? s : null
}

/**
 * 資料庫錯誤轉人話。
 * 最常見的一種是「資料表還沒建」——上線時漏跑 SQL 就會撞到，
 * 直接把 PostgREST 的英文訊息丟給商開看，他們只會來問「這是什麼」。
 */
function dbError(message: string): string {
  if (/could not find the table|schema cache|does not exist/i.test(message)) {
    return '申請單資料表尚未建立，請通知管理員執行 sql/20260910_item_code_requests.sql'
  }
  return formatSupabaseAdminError(message)
}

/** 申請單號 IR + yyMMdd + 3 碼流水（台灣時間） */
function todayStampTW(): string {
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return tw.toISOString().slice(2, 10).replace(/-/g, '')
}

async function nextRequestNo(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
): Promise<string> {
  const prefix = 'IR' + todayStampTW()
  const { data, error } = await supabase
    .from(TABLE)
    .select('request_no')
    .like('request_no', prefix + '%')
    .order('request_no', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  const last = data?.[0]?.request_no as string | undefined
  const seq = last ? Number(last.slice(prefix.length)) + 1 : 1
  return prefix + String(seq).padStart(3, '0')
}

/** GET：申請清單。?status=pending 篩狀態、?mine=1 只看自己送出的 */
export async function GET(request: NextRequest) {
  const guard = await guardPermission('product_dev')
  if (!guard.ok) return guard.res

  const { searchParams } = new URL(request.url)
  const status = (searchParams.get('status') ?? '').trim()
  const mine = searchParams.get('mine') === '1'

  const supabase = getSupabaseAdminClient()
  let query = supabase
    .from(TABLE)
    .select('*')
    .order('requested_at', { ascending: false })
    .limit(300)

  if (STATUSES.includes(status as (typeof STATUSES)[number])) query = query.eq('status', status)
  if (mine) query = query.eq('requester_email', guard.member.email)

  const { data, error } = await query
  if (error) {
    return NextResponse.json(
      { success: false, error: dbError(error.message) },
      { status: 500 },
    )
  }
  return NextResponse.json({ success: true, rows: data ?? [], me: guard.member.email })
}

/** POST：送出新品項編碼申請 */
export async function POST(request: NextRequest) {
  const guard = await guardPermission('product_dev')
  if (!guard.ok) return guard.res

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: '請求格式錯誤' }, { status: 400 })
  }

  const row: Record<string, unknown> = {}
  for (const key of INPUT_FIELDS) row[key] = str(body[key])

  for (const f of REQUIRED_FIELDS) {
    if (!row[f.key]) {
      return NextResponse.json({ success: false, error: '「' + f.label + '」為必填' }, { status: 400 })
    }
  }

  const category = String(row.product_category).toUpperCase()
  if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    return NextResponse.json(
      { success: false, error: '產品大類只能是 ' + CATEGORIES.join(' / ') },
      { status: 400 },
    )
  }
  row.product_category = category
  row.product_category_2 = String(row.product_category_2).toUpperCase()
  if (row.suggested_part) row.suggested_part = String(row.suggested_part).toUpperCase()

  // 安全庫存：允許留空；填了就必須是 0 以上的數字
  const safetyRaw = str(body.safety_qty)
  if (safetyRaw !== null) {
    const n = Number(safetyRaw)
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ success: false, error: '安全庫存必須是 0 以上的數字' }, { status: 400 })
    }
    row.safety_qty = n
  }

  row.requester_email = guard.member.email
  row.requester_name = guard.member.realName ?? null
  row.status = 'pending'

  const supabase = getSupabaseAdminClient()

  // 兩人同時送出會撞到同一個流水號 → unique 擋下後重取，最多 3 次
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      row.request_no = await nextRequestNo(supabase)
    } catch (err) {
      const message = err instanceof Error ? err.message : '單號產生失敗'
      return NextResponse.json({ success: false, error: dbError(message) }, { status: 500 })
    }
    const { data, error } = await supabase.from(TABLE).insert(row).select().single()
    if (!error) return NextResponse.json({ success: true, row: data })
    if (!/duplicate key|unique/i.test(error.message) || attempt === 2) {
      return NextResponse.json(
        { success: false, error: dbError(error.message) },
        { status: 500 },
      )
    }
  }
  return NextResponse.json({ success: false, error: '申請單號產生失敗，請重試' }, { status: 500 })
}

/** PATCH：處理申請 —— 回填已建立的品項編碼結案、退回、或救回誤按 */
export async function PATCH(request: NextRequest) {
  const guard = await guardPermission('product_dev')
  if (!guard.ok) return guard.res

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: '請求格式錯誤' }, { status: 400 })
  }

  const id = Number(body.id)
  const action = String(body.action ?? '')
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: '缺少申請單 id' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = {
    handled_by: guard.member.email,
    handled_at: now,
    updated_at: now,
  }

  if (action === 'created') {
    const assigned = str(body.assigned_part)
    if (!assigned) {
      return NextResponse.json({ success: false, error: '請填寫實際建立的品項編碼' }, { status: 400 })
    }
    patch.status = 'created'
    patch.assigned_part = assigned.toUpperCase()
    patch.reject_reason = null
  } else if (action === 'rejected') {
    const reason = str(body.reject_reason)
    if (!reason) {
      return NextResponse.json({ success: false, error: '請填寫退回原因' }, { status: 400 })
    }
    patch.status = 'rejected'
    patch.reject_reason = reason
    patch.assigned_part = null
  } else if (action === 'reopen') {
    // 誤按結案／退回後要救回待建檔
    patch.status = 'pending'
    patch.assigned_part = null
    patch.reject_reason = null
    patch.handled_by = null
    patch.handled_at = null
  } else {
    return NextResponse.json({ success: false, error: '不支援的操作' }, { status: 400 })
  }

  const supabase = getSupabaseAdminClient()
  const { data, error } = await supabase.from(TABLE).update(patch).eq('id', id).select().single()
  if (error) {
    return NextResponse.json(
      { success: false, error: dbError(error.message) },
      { status: 500 },
    )
  }
  return NextResponse.json({ success: true, row: data })
}
