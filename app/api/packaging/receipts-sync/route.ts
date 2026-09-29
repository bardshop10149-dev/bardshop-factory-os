import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackaging, noStore } from '@/lib/packaging/guard'
import { RECEIPT_SYNC_DEFAULT_DAYS, RECEIPT_SYNC_MAX_DAYS, type ReceiptSyncMode, type ReceiptSyncResponse } from '@/lib/packaging/receipts'
import { ReceiptSyncError, runReceiptSync } from '@/lib/packaging/receiptSync'

// 包裝專區 D111：ARGO 採購入庫同步（ARGO 唯讀 → Supabase erp_po_receipts／erp_po_receipts_sync）
//
// GET /api/packaging/receipts-sync?mode=incremental&days=3      近 N 天有入庫的採購單重算覆蓋（預設）
// GET /api/packaging/receipts-sync?mode=full[&shard=0&shards=2] 範圍內全部採購單重算覆蓋（一次跑不完可分片）
// GET …&dry=1                                                    只查 ARGO、不寫 Supabase、不碰新表（回彙總筆數與前 50 列預覽）
//
// 驗證與行為完全比照 /api/packaging/sales-sync（D73）：
//   (a) Authorization: Bearer <CRON_SECRET>（Vercel Cron 自動帶）或 <WEBHOOK_SECRET>（手動／外部排程）；
//       比對用 timingSafeEqual（兩邊先 sha256 成等長），避免以回應時間猜密鑰。
//   (b) 已登入且具 packaging_admin（手動觸發；不需編輯鎖——只更新 ARGO 鏡像，不動排程）。
//       手動觸發同一實例 60 秒內只接受一次；同一實例同時只跑一個同步（兩次全量同時跑只會加倍打 ARGO）。
// 為什麼 GET 會寫入：Vercel Cron 只會發 GET；寫入的是「ARGO 的鏡像」，重跑結果相同（冪等），被跨站觸發也只是多同步一次。
// 排程（vercel.json）：增量 10,40 0-14 * * *（UTC）、全量 50 18 * * *（UTC＝台北 02:50）。

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
  if (auth === 'bad') return noStore<ReceiptSyncResponse>({ success: false, code: 'unauthorized', error: 'Unauthorized' }, 401)
  if (auth === 'none') {
    const g = await guardPackaging('write')
    if (!g.ok) return g.res
  }

  const sp = request.nextUrl.searchParams
  const modeRaw = sp.get('mode') ?? 'incremental'
  if (modeRaw !== 'full' && modeRaw !== 'incremental') {
    return noStore<ReceiptSyncResponse>({ success: false, code: 'bad_request', error: 'mode 只能是 full 或 incremental' }, 400)
  }
  const mode: ReceiptSyncMode = modeRaw
  const days = intParam(sp.get('days'), RECEIPT_SYNC_DEFAULT_DAYS)
  const shards = intParam(sp.get('shards'), 1)
  const shard = intParam(sp.get('shard'), 0)
  if (days == null || days < 1 || days > RECEIPT_SYNC_MAX_DAYS) {
    return noStore<ReceiptSyncResponse>({ success: false, code: 'bad_request', error: `days 須為 1～${RECEIPT_SYNC_MAX_DAYS}` }, 400)
  }
  if (shards == null || shard == null || shards < 1 || shards > 12 || shard >= shards) {
    return noStore<ReceiptSyncResponse>({ success: false, code: 'bad_request', error: 'shard／shards 格式錯誤（0 ≤ shard < shards ≤ 12）' }, 400)
  }
  const dryRun = sp.get('dry') === '1'

  if (running) return noStore<ReceiptSyncResponse>({ success: false, code: 'busy', error: '入庫同步正在執行中，請稍後再試' }, 409)
  if (auth === 'none') {
    const now = Date.now()
    if (now - lastManualAt < MANUAL_MIN_INTERVAL_MS) {
      return noStore<ReceiptSyncResponse>({ success: false, code: 'busy', error: '手動同步 1 分鐘內只能觸發一次' }, 429)
    }
    lastManualAt = now
  }

  running = true
  try {
    const sb = getSupabaseAdminClient()
    const r = await runReceiptSync(sb, { mode, days, shard, shards, budgetMs: BUDGET_MS, dryRun })
    const body = { success: true as const, partial: r.partial, errors: r.errors.slice(0, 20), ...r.stats }
    return noStore<ReceiptSyncResponse & { preview?: unknown }>(
      dryRun ? { ...body, preview: (r.preview ?? []).slice(0, PREVIEW_LIMIT) } : body,
      // 部分失敗仍回 200（已寫入的批次有效）；呼叫端看 partial／errors
    )
  } catch (e) {
    if (e instanceof ReceiptSyncError) {
      const status = e.code === 'migration_required' ? 409 : e.code === 'argo_unconfigured' ? 503 : e.code === 'argo_error' ? 502 : 500
      console.error('[packaging/receipts-sync]', e.code, e.message)
      return noStore<ReceiptSyncResponse>({ success: false, code: e.code, error: e.message }, status)
    }
    console.error('[packaging/receipts-sync]', describeError(e))
    return noStore<ReceiptSyncResponse>({ success: false, code: 'db_error', error: '入庫同步失敗，請稍後再試' }, 500)
  } finally {
    running = false
  }
}
