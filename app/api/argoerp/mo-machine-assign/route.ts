import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
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
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
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

    const rows = assignments
      .filter(a => a.mo_number?.trim())
      .map(a => ({
        mo_number: a.mo_number.trim(),
        machine: a.machine ?? '',
        updated_at: new Date().toISOString(),
      }))

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'mo_number 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    // 衝突提示只在「這次同一批送出的指派」裡比對——機台是實體資源，每天都會重複使用，
    // 跟 argoerp_mo_machine_assign 全表歷史比對（不分日期）會把幾個月前早就做完的舊工單
    // 全部誤判成衝突。只有同一批（同一天的出單表）裡兩個不同工單被指到同一台機台，
    // 才是真正當天排程撞機。
    const byMachine = new Map<string, string[]>()
    for (const r of rows) {
      if (!r.machine) continue
      const list = byMachine.get(r.machine) ?? []
      if (!list.includes(r.mo_number)) list.push(r.mo_number)
      byMachine.set(r.machine, list)
    }
    const conflicts: { machine: string; mo_number: string; existing_mo_numbers: string[] }[] = []
    for (const [machine, moNumbers] of byMachine) {
      if (moNumbers.length <= 1) continue
      for (const mo of moNumbers) {
        conflicts.push({ machine, mo_number: mo, existing_mo_numbers: moNumbers.filter(m => m !== mo) })
      }
    }

    const { error } = await supabase
      .from(TABLE)
      .upsert(rows, { onConflict: 'mo_number' })

    if (error) throw error
    return NextResponse.json({ success: true, upserted: rows.length, conflicts })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
