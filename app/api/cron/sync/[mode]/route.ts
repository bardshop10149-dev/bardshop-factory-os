import { NextRequest, NextResponse } from 'next/server'

// ─────────────────────────────────────────────────────────────────────────────
// ARGO → Supabase 同步排程入口（Vercel Cron 觸發，模式放在網址路徑上）
//
//   /api/cron/sync/incremental   每 5 分鐘（台灣上班時段）：只拉近期異動，絕不刪除
//   /api/cron/sync/heavy         每 30 分鐘：庫存/批備料/BOM（無法增量者，全量）
//   /api/cron/sync/full          每天 4 次：全部全量對帳（含刪除偵測）
//   /api/cron/sync/full-orders   （備用）只跑訂單類全量，供拆批用
//   /api/cron/sync/full-master   （備用）只跑主檔類全量
//
// 為什麼模式放路徑而非 query string：Vercel Cron 的 path 設定以路徑為準，
// 官方建議用不同路徑或 x-vercel-cron-schedule 區分，避免 query string 相容性問題。
//
// 觸發方式與驗證：
//  * Vercel Cron 以 **GET** 呼叫，並自動帶 `Authorization: Bearer <CRON_SECRET>`
//    （需在 Vercel 專案設定新增 CRON_SECRET 環境變數，否則不會帶 header）。
//  * 也接受 POST 及 `WEBHOOK_SECRET`，方便手動測試或改回外部排程服務。
//
// 設計要點：
//  * 增量窗口刻意設為間隔的數倍（LOOKBACK_MINUTES），本身即為重疊緩衝：
//    某輪失敗或部署重啟，下一輪的窗口仍涵蓋得到，不需存浮水印、也無時鐘誤差問題。
//    （Vercel 官方明示 cron 遞送為 best-effort，可能漏跑或重複跑 → 本設計對兩者都安全：
//      漏跑由下一輪較長的窗口補上；重複跑因為 upsert 冪等，不會造成重複資料。）
//  * 增量模式一律不刪除；「單被刪除/結案」由每天 4 次的 full 對帳負責。
//  * 各 action 併發但限流，避免同時對 ARGO 開太多連線。
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Pro 方案可拉高上限；full 對帳實測約 50 秒，給足餘裕避免被砍在半途。
export const maxDuration = 120

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
// 無法增量者，需靠較高頻的全量拉：
//   庫存 = MM_BOM_BOH_V 是 view 沒有 UPDATE_DATE；批備料 = 無可靠自然鍵、寫入為整批覆蓋。
// 這兩張變動快、下游(缺料判斷/領料)敏感 → 放進 30 分鐘的 heavy。
const HEAVY_JOBS: Job[] = [
  { label: 'sync_inventory', body: INVENTORY_BODY },
  { label: 'sync_material_prep', body: { action: 'sync_material_prep' } },
]
// BOM 極少變動，但每輪全量約 1 萬筆並不便宜 → 只在每天 4 次的 full 對帳跑，
// 既解決 BOM 單位長期未更新的問題，又不會把總拉取量墊高。
const BOM_JOBS: Job[] = [
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
  const masterJobs = [...HEAVY_JOBS, ...BOM_JOBS]
  if (group === 'orders') return orderJobs
  if (group === 'master') return masterJobs
  return [...orderJobs, ...masterJobs]
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

const VALID_MODES = ['incremental', 'heavy', 'full', 'full-orders', 'full-master'] as const

export async function GET(request: NextRequest, ctx: { params: Promise<{ mode: string }> }) {
  return runSync(request, ctx)
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ mode: string }> }) {
  return runSync(request, ctx)
}

async function runSync(request: NextRequest, ctx: { params: Promise<{ mode: string }> }) {
  // Vercel Cron 帶 CRON_SECRET；手動/外部排程可用 WEBHOOK_SECRET。任一相符即放行。
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  const authorized = !!bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))
  if (!authorized) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const rawMode = ((await ctx.params).mode ?? '').toLowerCase()
  if (!(VALID_MODES as readonly string[]).includes(rawMode)) {
    return NextResponse.json({ success: false, error: `模式必須是 ${VALID_MODES.join(' | ')}` }, { status: 400 })
  }
  // full-orders / full-master 拆批
  const mode = rawMode.startsWith('full') ? 'full' : rawMode
  const group = rawMode === 'full-orders' ? 'orders' : rawMode === 'full-master' ? 'master' : null

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? request.nextUrl.origin
  const jobs = buildJobs(mode, group)
  const started = Date.now()

  async function runJob(job: Job): Promise<StepResult> {
    const t = Date.now()
    try {
      const res = await fetch(`${baseUrl}/api/argoerp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': process.env.WEBHOOK_SECRET ?? '' },
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
      mode: rawMode,
      lookbackMinutes: mode === 'incremental' ? LOOKBACK_MINUTES : undefined,
      totalMs: Date.now() - started,
      changed: steps.reduce((n, s) => n + (s.inserted ?? 0) + (s.updated ?? 0) + (s.deleted ?? 0), 0),
      steps,
    },
    { status: failed.length === 0 ? 200 : 500 },
  )
}
