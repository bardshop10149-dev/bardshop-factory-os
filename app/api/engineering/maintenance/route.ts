import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// 工程維護/維修表（見 sql/20260916_engineering_maintenance.sql）
//
// GET    ?status=&type=&machine=&keyword=&limit=   列表
// POST   建立單（單號由伺服器產生，前端不傳）
// PATCH  { id, ...欄位 } 更新；{ id, action: 'close' } 結案、'reopen' 取消結案
// DELETE ?id=  刪除（開錯單才會用到）

const TABLE = 'engineering_maintenance_records'
const PERMISSION = 'engineering'

const TYPES = ['機台維修', '其他類型']

const asText = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}
/** date input 傳來的 '' 要存成 null，否則 Postgres 的 date 欄位會噴格式錯誤 */
const asDate = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/** 單號：EM + 台北日期 + 三碼流水（查當日最大號 +1） */
async function nextRecordNo(supabase: ReturnType<typeof getSupabaseAdminClient>): Promise<string> {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  const prefix = `EM${ymd}`
  const { data } = await supabase
    .from(TABLE).select('record_no').like('record_no', `${prefix}%`)
    .order('record_no', { ascending: false }).limit(1)
  const last = data?.[0]?.record_no as string | undefined
  const seq = last ? Number(last.slice(prefix.length)) + 1 : 1
  return `${prefix}${String(Number.isFinite(seq) ? seq : 1).padStart(3, '0')}`
}

/**
 * 類型連動欄位的一致性：
 *   機台維修 → 留機台、清掉其他類型的說明
 *   其他類型 → 留手填種類/原因、清掉機台
 * 不這樣清的話，改過類型的單會同時留著兩邊的殘值，列表顯示會對不起來。
 * 同理，「無須請購」時不保留請購單號。
 */
function normalizeByType(patch: Record<string, unknown>, type: string | null, needsPurchase: boolean | null) {
  if (type === '機台維修') patch.type_other = null
  if (type === '其他類型') patch.machine = null
  if (needsPurchase === false) patch.pr_number = null
}

export async function GET(request: NextRequest) {
  const guard = await guardPermission(PERMISSION)
  if (!guard.ok) return guard.res
  try {
    const sp = request.nextUrl.searchParams
    const supabase = getSupabaseAdminClient()
    let q = supabase.from(TABLE).select('*').order('created_at', { ascending: false })

    const status = sp.get('status')
    if (status && status !== 'all') q = q.eq('status', status)
    const type = sp.get('type')
    if (type && type !== 'all') q = q.eq('type', type)
    const machine = sp.get('machine')
    if (machine) q = q.eq('machine', machine)
    const keyword = sp.get('keyword')?.trim()
    if (keyword) {
      const esc = keyword.replace(/[%,]/g, ' ')
      q = q.or([
        `title.ilike.%${esc}%`, `description.ilike.%${esc}%`, `machine.ilike.%${esc}%`,
        `type_other.ilike.%${esc}%`, `record_no.ilike.%${esc}%`, `pr_number.ilike.%${esc}%`,
        `progress.ilike.%${esc}%`,
      ].join(','))
    }
    q = q.limit(Math.min(Number(sp.get('limit') ?? 500) || 500, 2000))

    const { data, error } = await q
    if (error) throw error
    return NextResponse.json({ success: true, records: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const guard = await guardPermission(PERMISSION)
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as Record<string, unknown>
    const title = asText(body.title)
    if (!title) return NextResponse.json({ success: false, error: '請填寫維護／維修項目' }, { status: 400 })

    const type = TYPES.includes(String(body.type)) ? String(body.type) : '機台維修'
    if (type === '機台維修' && !asText(body.machine)) {
      return NextResponse.json({ success: false, error: '機台維修請填寫機台名稱' }, { status: 400 })
    }
    if (type === '其他類型' && !asText(body.type_other)) {
      return NextResponse.json({ success: false, error: '其他類型請填寫種類／原因' }, { status: 400 })
    }
    const needsPurchase = body.needs_purchase === true || body.needs_purchase === 'true'
    if (needsPurchase && !asText(body.pr_number)) {
      return NextResponse.json({ success: false, error: '須請購請填寫請購單號' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const row: Record<string, unknown> = {
      record_no: await nextRecordNo(supabase),
      type,
      type_other: asText(body.type_other),
      machine: asText(body.machine),
      title,
      description: asText(body.description),
      start_date: asDate(body.start_date),
      expected_end_date: asDate(body.expected_end_date),
      needs_purchase: needsPurchase,
      pr_number: asText(body.pr_number),
      progress: asText(body.progress),
      status: '進行中',
      // 開單人一律以登入者為準，不吃前端傳的值
      created_by: guard.member.email,
      created_by_name: guard.member.realName ?? guard.member.email,
      updated_by: guard.member.email,
    }
    normalizeByType(row, type, needsPurchase)

    const { data, error } = await supabase.from(TABLE).insert(row).select('*').single()
    if (error) throw error
    return NextResponse.json({ success: true, record: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const guard = await guardPermission(PERMISSION)
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as Record<string, unknown>
    const id = Number(body.id)
    if (!Number.isFinite(id)) return NextResponse.json({ success: false, error: '缺少 id' }, { status: 400 })

    const supabase = getSupabaseAdminClient()
    const now = new Date().toISOString()
    const patch: Record<string, unknown> = { updated_at: now, updated_by: guard.member.email }

    // 結案／取消結案（頁面上的結案按鈕走這條）
    const action = asText(body.action)
    if (action === 'close') {
      patch.status = '已結案'
      patch.closed_at = now
      patch.closed_by = guard.member.email
    } else if (action === 'reopen') {
      patch.status = '進行中'
      patch.closed_at = null
      patch.closed_by = null
    } else {
      if ('title' in body) {
        const t = asText(body.title)
        if (!t) return NextResponse.json({ success: false, error: '維護／維修項目不可清空' }, { status: 400 })
        patch.title = t
      }
      let type: string | null = null
      if ('type' in body) {
        type = TYPES.includes(String(body.type)) ? String(body.type) : null
        if (!type) return NextResponse.json({ success: false, error: '類型不正確' }, { status: 400 })
        patch.type = type
      }
      for (const k of ['type_other', 'machine', 'description', 'pr_number', 'progress'] as const) {
        if (k in body) patch[k] = asText(body[k])
      }
      for (const k of ['start_date', 'expected_end_date'] as const) {
        if (k in body) patch[k] = asDate(body[k])
      }
      let needsPurchase: boolean | null = null
      if ('needs_purchase' in body) {
        needsPurchase = body.needs_purchase === true || body.needs_purchase === 'true'
        patch.needs_purchase = needsPurchase
      }
      normalizeByType(patch, type, needsPurchase)

      // 類型必填欄位：只有在這次真的會動到該欄位時才檢查，
      // 避免「只改進度」的局部更新被無關的必填擋下來
      if (type === '機台維修' && 'machine' in body && !patch.machine) {
        return NextResponse.json({ success: false, error: '機台維修請填寫機台名稱' }, { status: 400 })
      }
      if (type === '其他類型' && 'type_other' in body && !patch.type_other) {
        return NextResponse.json({ success: false, error: '其他類型請填寫種類／原因' }, { status: 400 })
      }
      if (needsPurchase === true && 'pr_number' in body && !patch.pr_number) {
        return NextResponse.json({ success: false, error: '須請購請填寫請購單號' }, { status: 400 })
      }
    }

    const { data, error } = await supabase.from(TABLE).update(patch).eq('id', id).select('*').single()
    if (error) throw error
    return NextResponse.json({ success: true, record: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await guardPermission(PERMISSION)
  if (!guard.ok) return guard.res
  try {
    const id = Number(request.nextUrl.searchParams.get('id'))
    if (!Number.isFinite(id)) return NextResponse.json({ success: false, error: '缺少 id' }, { status: 400 })
    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).delete().eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
