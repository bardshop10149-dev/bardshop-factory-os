import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackaging, noStore } from '@/lib/packaging/guard'
import { SALES_SYNC_DEFAULT_DAYS, SALES_SYNC_MAX_DAYS, type SalesSyncMode, type SalesSyncResponse } from '@/lib/packaging/scheduleTypes'
import { SalesSyncError, runSalesSync } from '@/lib/packaging/salesSync'

// 包裝專區 D73：ARGO 銷貨同步（ARGO 唯讀 → Supabase erp_so_sales／erp_so_sales_sync）
//
// GET /api/packaging/sales-sync?mode=incremental&days=3      近 N 天有銷貨的 SO 重算覆蓋（預設）
// GET /api/packaging/sales-sync?mode=full[&shard=0&shards=2] 全部未結案 SO 重算覆蓋（一次跑不完可分片）
// GET …&dry=1                                                 只查 ARGO、不寫 Supabase（回彙總筆數與前 50 列預覽）
//
// 驗證（二擇一）：
//   (a) Authorization: Bearer <CRON_SECRET>（Vercel Cron 自動帶）或 <WEBHOOK_SECRET>（手動／外部排程）——比照 app/api/cron/*；
//       比對用 timingSafeEqual（兩邊先 sha256 成等長），避免以回應時間猜密鑰。
//   (b) 已登入且具 packaging_admin（手動觸發；不需編輯鎖——只更新 ARGO 鏡像，不動排程）。
//       手動觸發同一實例 60 秒內只接受一次；同一實例同時只跑一個同步（兩次全量同時跑只會加倍打 ARGO）。
// 為什麼 GET 會寫入：Vercel Cron 只會發 GET；寫入的是「ARGO 的鏡像」，重跑結果相同（冪等），被跨站觸發也只是多同步一次。
// 排程（vercel.json，時間為 UTC）：
//   增量 `5,35 0-14 * * *`＝台北每天 08:05～22:35 每 30 分鐘（刻意錯開整點／半點的 ERP 與塔台同步，避免同時打 ARGO）
//   全量 `40 18 * * *`＝台北每天 02:40（補增量漏掉的：作廢銷貨、超過 3 天才補登的銷貨；避開 ARGO 半夜 00:05～00:39 曾不回應的時段）

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** 時間預算：maxDuration 300 秒扣掉寫狀態與回應的餘裕 */
const BUDGET_MS = 250_000
const MANUAL_MIN_INTERVAL_MS = 60_000
const PREVIEW_LIMIT = 50

let running = false
let lastManualAt = 0

const sha = (s: string) => createHash('sha256').update(s).digest()
function secretMatches(given: string, expected: string): boolean {
  if (!given || !expected) return false
  return timingSafeEqual(sha(given), sha(expected))
}

/** 'ok'＝排程密鑰正確；'bad'＝帶了 Bearer 但不對；'none'＝沒帶（改走登入驗證） */
function bearerState(request: NextRequest): 'ok' | 'bad' | 'none' {
  const h = request.headers.get('Authorization')
  if (!h) return 'none'
  const bearer = h.replace(/^Bearer\s+/i, '').trim()
  const secrets = [process.env.CRON_SECRET ?? '', process.env.WEBHOOK_SECRET ?? ''].filter(Boolean)
  return secrets.some((s) => secretMatches(bearer, s)) ? 'ok' : 'bad'
}

const intParam = (v: string | null, def: number): number | null => {
  if (v == null || v === '') return def
  return /^\d{1,3}$/.test(v) ? Number(v) : null
}

export async function GET(request: NextRequest) {
  const auth = bearerState(request)
  if (auth === 'bad') return noStore<SalesSyncResponse>({ success: false, code: 'unauthorized', error: 'Unauthorized' }, 401)
  if (auth === 'none') {
    const g = await guardPackaging('write')
    if (!g.ok) return g.res
  }

  const sp = request.nextUrl.searchParams
  const modeRaw = sp.get('mode') ?? 'incremental'
  if (modeRaw !== 'full' && modeRaw !== 'incremental') {
    return noStore<SalesSyncResponse>({ success: false, code: 'bad_request', error: 'mode 只能是 full 或 incremental' }, 400)
  }
  const mode: SalesSyncMode = modeRaw
  const days = intParam(sp.get('days'), SALES_SYNC_DEFAULT_DAYS)
  const shards = intParam(sp.get('shards'), 1)
  const shard = intParam(sp.get('shard'), 0)
  if (days == null || days < 1 || days > SALES_SYNC_MAX_DAYS) {
    return noStore<SalesSyncResponse>({ success: false, code: 'bad_request', error: `days 須為 1～${SALES_SYNC_MAX_DAYS}` }, 400)
  }
  if (shards == null || shard == null || shards < 1 || shards > 12 || shard >= shards) {
    return noStore<SalesSyncResponse>({ success: false, code: 'bad_request', error: 'shard／shards 格式錯誤（0 ≤ shard < shards ≤ 12）' }, 400)
  }
  const dryRun = sp.get('dry') === '1'

  if (running) return noStore<SalesSyncResponse>({ success: false, code: 'busy', error: '銷貨同步正在執行中，請稍後再試' }, 409)
  if (auth === 'none') {
    const now = Date.now()
    if (now - lastManualAt < MANUAL_MIN_INTERVAL_MS) {
      return noStore<SalesSyncResponse>({ success: false, code: 'busy', error: '手動同步 1 分鐘內只能觸發一次' }, 429)
    }
    lastManualAt = now
  }

  running = true
  try {
    const sb = getSupabaseAdminClient()
    const r = await runSalesSync(sb, { mode, days, shard, shards, budgetMs: BUDGET_MS, dryRun })
    const body = { success: true as const, partial: r.partial, errors: r.errors.slice(0, 20), ...r.stats }
    return noStore<SalesSyncResponse & { preview?: unknown }>(
      dryRun ? { ...body, preview: (r.preview ?? []).slice(0, PREVIEW_LIMIT) } : body,
      // 部分失敗仍回 200（已寫入的批次有效）；呼叫端看 partial／errors
    )
  } catch (e) {
    if (e instanceof SalesSyncError) {
      const status = e.code === 'migration_required' ? 409 : e.code === 'argo_unconfigured' ? 503 : e.code === 'argo_error' ? 502 : 500
      console.error('[packaging/sales-sync]', e.code, e.message)
      return noStore<SalesSyncResponse>({ success: false, code: e.code, error: e.message }, status)
    }
    console.error('[packaging/sales-sync]', describeError(e))
    return noStore<SalesSyncResponse>({ success: false, code: 'db_error', error: '銷貨同步失敗，請稍後再試' }, 500)
  } finally {
    running = false
  }
}
