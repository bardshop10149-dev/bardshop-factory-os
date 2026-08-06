import { NextRequest, NextResponse } from 'next/server'

// ─────────────────────────────────────────────────────────────────────────────
// ARGO → Supabase 同步排程入口（給 cron-job.org 打，一個網址三種模式）
//
//   POST /api/cron/sync?mode=incremental   每 5 分鐘（上班時段）：只拉近期異動，絕不刪除
//   POST /api/cron/sync?mode=heavy         每 30 分鐘：庫存/批備料/BOM（無法增量者，全量）
//   POST /api/cron/sync?mode=full          每天 4 次：全部全量對帳（含刪除偵測）
//
// 驗證：Header `Authorization: Bearer <WEBHOOK_SECRET>`（與 /api/webhook/sync 同一組密鑰）
//
// 設計要點：
//  * 增量窗口刻意設為間隔的數倍（LOOKBACK_MINUTES），本身即為重疊緩衝：
//    某輪失敗或部署重啟，下一輪的窗口仍涵蓋得到，不需要存浮水印、也無時鐘誤差問題。
//  * 增量模式一律不刪除；「單被刪除/結案」由每天 4 次的 full 對帳負責。
//  * 各 action 併發但限流，避免同時對 ARGO 開太多連線。
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 增量回看窗口（分鐘）。排程每 5 分鐘跑一次，取 20 分鐘＝4 倍重疊緩衝。
const LOOKBACK_MINUTES = 20
// 併發上限（同時打 ARGO 的 action 數）
const CONCURRENCY = 3

type Job = { label: string; body: Record<string, unknown> }

// 庫存同步需要的查詢參數（與 ERP 同步區「倉庫庫存」按鈕送出的內容一致）
const INVENTORY_BODY = {
  action: 'sync_inventory',
  table: 'MM_BOM_BOH_V',
  customColumn: 'PART,PART_DESC,BOH,PO_ON_ROAD',
  filters: { ROWNUM: '<= 10000' },
  mapping: {
    itemCodeField: 'PART',
    itemNameField: 'PART_DESC',
    bookCountField: 'BOH',
    warehouseTotalField: 'PO_ON_ROAD',
  },
}

// 支援增量的單別（其餘只能全量）
const INCREMENTAL_ACTIONS = ['sync_so', 'sync_mo', 'sync_po', 'sync_pr', 'sync_customer'] as const
// 無法增量者：庫存(view 無 UPDATE_DATE)、批備料(無自然鍵、整批覆蓋)、BOM(量小且為 upsert)
const HEAVY_JOBS: Job[] = [
  { label: 'sync_inventory', body: INVENTORY_BODY },
  { label: 'sync_material_prep', body: { action: 'sync_material_prep' } },
  { label: 'sync_bom_units', body: { action: 'sync_bom_units' } },
  { label: 'sync_bom_structure', body: { action: 'sync_bom_structure' } },
]

function buildJobs(mode: string, group: string | null): Job[] {
  if (mode === 'incremental') {
    return INCREMENTAL_ACTIONS.map((a) => ({
      label: a,
      body: { action: a, incrementalMinutes: LOOKBACK_MINUTES },
    }))
  }
  if (mode === 'heavy') return HEAVY_JOBS

  // full：全部單別全量（含刪除偵測）。
  // 若正式站接近 Vercel 函式時間上限，可用 group 拆成兩批分開排程，不必改程式：
  //   ?mode=full&group=orders  → 訂單類（SO/MO/PO/PR）
  //   ?mode=full&group=master  → 主檔類（客戶/庫存/批備料/BOM）
  const orderJobs = INCREMENTAL_ACTIONS.map((a) => ({ label: a, body: { action: a } as Record<string, unknown> }))
  if (group === 'orders') return orderJobs
  if (group === 'master') return HEAVY_JOBS
  return [...orderJobs, ...HEAVY_JOBS]
}

interface StepResult {
  step: string
  ok: boolean
  ms: number
  syncedCount?: number
  inserted?: number
  updated?: number
  deleted?: number
  unchanged?: number
  note?: string
  error?: string
}

export async function POST(request: NextRequest) {
  const secret = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const expected = process.env.WEBHOOK_SECRET ?? ''
  if (!expected || secret !== expected) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const mode = (request.nextUrl.searchParams.get('mode') ?? 'incremental').toLowerCase()
  if (!['incremental', 'heavy', 'full'].includes(mode)) {
    return NextResponse.json({ success: false, error: 'mode 必須是 incremental | heavy | full' }, { status: 400 })
  }

  const group = request.nextUrl.searchParams.get('group')
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? request.nextUrl.origin
  const jobs = buildJobs(mode, group)
  const started = Date.now()

  async function runJob(job: Job): Promise<StepResult> {
    const t = Date.now()
    try {
      const res = await fetch(`${baseUrl}/api/argoerp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': expected },
        body: JSON.stringify(job.body),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || json.status !== 'ok') {
        return { step: job.label, ok: false, ms: Date.now() - t, error: String(json.error ?? `HTTP ${res.status}`).slice(0, 300) }
      }
      return {
        step: job.label,
        ok: true,
        ms: Date.now() - t,
        syncedCount: json.syncedCount as number | undefined,
        inserted: json.inserted as number | undefined,
        updated: json.updated as number | undefined,
        deleted: json.deleted as number | undefined,
        unchanged: json.unchanged as number | undefined,
        note: json.note as string | undefined,
      }
    } catch (e) {
      return { step: job.label, ok: false, ms: Date.now() - t, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // 限流併發：同時最多 CONCURRENCY 個 action 在打 ARGO
  const steps: StepResult[] = []
  const queue = [...jobs]
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const job = queue.shift()
        if (!job) return
        steps.push(await runJob(job))
      }
    }),
  )

  const failed = steps.filter((s) => !s.ok)
  return NextResponse.json(
    {
      success: failed.length === 0,
      mode,
      lookbackMinutes: mode === 'incremental' ? LOOKBACK_MINUTES : undefined,
      totalMs: Date.now() - started,
      changed: steps.reduce((n, s) => n + (s.inserted ?? 0) + (s.updated ?? 0) + (s.deleted ?? 0), 0),
      steps,
    },
    { status: failed.length === 0 ? 200 : 500 },
  )
}
