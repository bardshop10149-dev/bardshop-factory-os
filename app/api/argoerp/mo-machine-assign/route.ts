import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, describeError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

const TABLE = 'argoerp_mo_machine_assign'

// GET: 回傳所有機台分配（或以 ?mo_numbers=MO1,MO2 過濾）
export async function GET(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()
    const { searchParams } = new URL(request.url)
    const moParam = searchParams.get('mo_numbers')

    let query = supabase
      .from(TABLE)
      .select('mo_number, machine, updated_at')
      .order('updated_at', { ascending: false })

    if (moParam) {
      const moNumbers = moParam.split(',').map(s => s.trim()).filter(Boolean)
      if (moNumbers.length > 0) query = query.in('mo_number', moNumbers)
    }

    const { data, error } = await query
    if (error) throw error
    return NextResponse.json({ success: true, assignments: data ?? [] })
  } catch (e) {
    const msg = describeError(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST: upsert 一批機台分配 { assignments: [{ mo_number, machine }] }
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { assignments?: { mo_number: string; machine: string }[] }
    const assignments = body.assignments
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return NextResponse.json({ success: false, error: 'assignments 陣列不可為空' }, { status: 400 })
    }

    // 依 mo_number 去重：委外的 MPO 請購單號一張會掛在多列上，出單表整批送來時同一單號
    // 會重複出現，同一批 upsert 內重複的 conflict key 會被 Postgres 以
    // 「ON CONFLICT DO UPDATE cannot affect row a second time」(21000) 拒絕。
    // 同單號的機台值本就相同（前端以單號為 key），保留最後一筆即可。
    const dedup = new Map<string, string>()
    for (const a of assignments) {
      const mo = a.mo_number?.trim()
      if (mo) dedup.set(mo, a.machine ?? '')
    }
    const rows = [...dedup.entries()].map(([mo_number, machine]) => ({
      mo_number,
      machine,
      updated_at: new Date().toISOString(),
    }))

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'mo_number 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    const { error } = await supabase
      .from(TABLE)
      .upsert(rows, { onConflict: 'mo_number' })

    if (error) throw error
    return NextResponse.json({ success: true, upserted: rows.length })
  } catch (e) {
    const msg = describeError(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
