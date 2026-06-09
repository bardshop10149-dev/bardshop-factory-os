import { NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAdmin } from '@/lib/requireAuth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SARA_TABLES = [
  'sara_workcenters',
  'sara_jobs',
  'sara_orders',
  'sara_reports',
  'sara_resources',
  'sara_resource_jobs',
  'sara_resource_events',
  'sara_lot_routes',
  'sara_sync_logs',
] as const

function inferType(val: unknown): string {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'boolean') return 'boolean'
  if (typeof val === 'number') return 'number'
  if (typeof val === 'object') return 'jsonb'
  const s = String(val)
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) || /^\d{4}-\d{2}-\d{2} /.test(s)) return 'timestamptz'
  if (/^\d+$/.test(s)) return 'integer'
  return 'text'
}

export async function GET() {
  try {
    const guard = await guardAdmin()
    if (!guard.ok) return guard.res
    const sb = getSupabaseAdminClient()
    const results = await Promise.all(
      SARA_TABLES.map(async (table) => {
        const [{ count }, { data: sample }] = await Promise.all([
          sb.from(table).select('*', { count: 'exact', head: true }),
          sb.from(table).select('*').limit(1),
        ])
        const row = sample?.[0] ?? null
        const columns = row
          ? Object.entries(row).map(([name, val]) => ({
              name,
              type: inferType(val),
              sample: typeof val === 'object' && val !== null
                ? (Array.isArray(val) ? `[Array ${(val as unknown[]).length}]` : '{...}')
                : val === null ? 'NULL'
                : String(val).slice(0, 60),
            }))
          : []
        return { table, count: count ?? 0, columns, hasData: !!row }
      }),
    )
    return NextResponse.json({ ok: true, tables: results })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
