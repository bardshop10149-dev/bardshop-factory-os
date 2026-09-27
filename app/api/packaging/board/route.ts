import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { BOARD_DEFAULT_WORKDAYS, BOARD_MAX_WORKDAYS, type BoardResponse, type Placement } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore } from '@/lib/packaging/guard'
import { getPool, POOL_READ_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { addDays, isValidYmd } from '@/lib/packaging/scheduleCalendar'
import { assembleBoard, boardRevision, poolDigest } from '@/lib/packaging/scheduleBoard'
import { evaluateLock } from '@/lib/packaging/scheduleLock'
import { getManualMergedPool } from '@/lib/packaging/manualCache'
import {
  getOpLogMaxId,
  getPlacementsFingerprint,
  isMissingSchema,
  linesMigrationMessage,
  loadCapacityRows,
  loadCompletedSince,
  loadLineCapacityRows,
  loadLines,
  loadOpenPlacements,
  loadPlacementsByLines,
  publicDbError,
  readLockRow,
} from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P1：排程工作台（讀）。規格 docs/design/2026-09-27-packaging-schedule-p1.md §四.1
//
// GET ?from=YYYY-MM-DD&workdays=10&rev=<上次 revision>&fresh=1
//   標頭 x-packaging-lock: <token>（選用；編輯者帶上才算得出 lock.isMine）
//   → BoardResponse；rev 與目前指紋相同時只回 { unchanged: true, revision, lock }（D52 每 60 秒輪詢省流量）
// 權限：packaging 或 packaging_admin（admin 自動通過，D30）。
// ⚠ GET 不寫入：D50 自動順延、D7 數量修剪都是讀取時推導（唯讀使用者也會呼叫）。
//
// 讀取分兩段，讓「沒變」的輪詢幾乎不花資料庫：
//   1. 便宜指紋：待排池（快取，已併入 D66 手動區塊）＋擺放表列數／最大 updated_at（1 個請求）＋op_log 最大 id＋鎖列 → revision
//   2. revision 與 rev 不同才讀全部擺放、產能（400 天，daily＋各線）、線別、池內各行的已完成列，組裝完整工作台
// 分線輪（lines.md §4.1）：多回 lines、defaultLineId、days[].lanes（只帶彙總）、BoardCard.lineId／laneId／minutesStd／
//   minutesOverride／manual。線別、各線產能、手動加入的寫入都會寫 op_log（'lines'／'capacity'／'manual'）→ revision 會變。
//   新表不存在（migration 未套用）→ 明確提示先套 sql/20260927b_packaging_p1_extend.sql，不做降級。

/** 產能沿用要看「較早的平日列」，讀近 400 天就夠（規格 §3.6） */
const CAPACITY_LOOKBACK_DAYS = 400
/**
 * fresh=1（待排池略過快取重算，3～9 秒、對 ERP／SARA 大表數十個查詢）同一個實例內最多每 30 秒一次；
 * 期間內的 fresh 視同一般讀取（回 120 秒內的快取）。唯讀使用者也能按，所以一定要節流。
 */
const FRESH_MIN_INTERVAL_MS = 30_000
let lastFreshAt = 0

export async function GET(request: NextRequest) {
  const g = await guardPackaging('read')
  if (!g.ok) return g.res

  const sp = request.nextUrl.searchParams
  const nowMs = Date.now()
  const today = todayTaipei(new Date(nowMs))
  const fromRaw = sp.get('from')
  // from 早於今天一律當今天（過去不在工作台上，D50 延誤卡會順延到今天）
  const from = isValidYmd(fromRaw) && fromRaw > today ? (fromRaw <= addDays(today, 180) ? fromRaw : addDays(today, 180)) : today
  const wdRaw = Number(sp.get('workdays'))
  const workdays = Number.isInteger(wdRaw) && wdRaw >= 1 && wdRaw <= BOARD_MAX_WORKDAYS ? wdRaw : BOARD_DEFAULT_WORKDAYS
  const rev = sp.get('rev')
  let fresh = false
  if (sp.get('fresh') === '1' && nowMs - lastFreshAt >= FRESH_MIN_INTERVAL_MS) {
    fresh = true
    lastFreshAt = nowMs
  }
  const lockToken = request.headers.get('x-packaging-lock')?.trim() || null
  const caller = { email: g.member.email, token: lockToken }

  let sb
  try {
    sb = getSupabaseAdminClient()
  } catch (e) {
    console.error('[packaging/board]', describeError(e))
    return noStore({ success: false, error: publicDbError(e), code: 'db_error' }, 500)
  }

  let poolFailed: unknown = null
  const poolP = getPool({ fresh, maxAgeMs: POOL_READ_MAX_AGE_MS }).catch((e: unknown) => { poolFailed = e; return null })
  try {
    // 1. 便宜指紋
    const [basePool, fp, lockRow, opLogMaxId] = await Promise.all([
      poolP,
      getPlacementsFingerprint(sb),
      readLockRow(sb),
      getOpLogMaxId(sb),
    ])
    if (!basePool) {
      console.error('[packaging/board] 待排池組裝失敗:', describeError(poolFailed))
      return noStore({ success: false, error: '待排池暫時無法組裝，請稍後再試', code: 'pool_unavailable' }, 500)
    }
    // D66：手動區塊併進待排池（內容不變時是同一個 blocks 參考，poolDigest 不必重算）
    const manual = await getManualMergedPool(sb, basePool)
    const pool = manual.pool
    const revision = boardRevision({
      poolDigest: poolDigest(pool),
      opLogMaxId,
      placementsMaxUpdatedAt: fp.maxUpdatedAt,
      placementCount: fp.count,
      today,
      window: `${from}/${workdays}`,
    })
    const lock = evaluateLock(lockRow, nowMs, caller)
    const serverTime = new Date(nowMs).toISOString()
    if (rev && rev === revision) {
      return noStore<BoardResponse>({ success: true, unchanged: true, serverTime, revision, lock })
    }

    // 2. 完整讀取
    const poolLines = new Set<string>()
    for (const b of pool.blocks) for (const c of b.cards) poolLines.add(c.soLineKey)
    const [open, completedFrom, capacityRows, completedInPool, lines, lineRows] = await Promise.all([
      loadOpenPlacements(sb),
      loadCompletedSince(sb, from),
      loadCapacityRows(sb, addDays(today, -CAPACITY_LOOKBACK_DAYS)),
      // 已完成的卡：池內各行全部（算「未反映完成量 U」要看最早一筆完成，規格 §3.4）＋ plan_date ≥ from
      loadPlacementsByLines(sb, [...poolLines], { completedOnly: true }),
      loadLines(sb),
      // D49 各線各自沿用最近一次較早平日值：同樣往前看 400 天
      loadLineCapacityRows(sb, addDays(today, -CAPACITY_LOOKBACK_DAYS)),
    ])

    const byId = new Map<string, Placement>()
    for (const p of [...open, ...completedFrom, ...completedInPool]) byId.set(p.id, p)
    const placements = [...byId.values()]

    const body = assembleBoard({
      pool, placements, capacityRows, lines, lineRows, today, from, workdays,
      manual: { meta: manual.meta, backInPoolKeys: manual.backInPoolKeys, skipped: manual.skipped },
    })
    return noStore<BoardResponse>({
      ...body,
      serverTime,
      revision,
      lock,
      me: { email: g.member.email, name: g.member.realName, canEdit: g.canEdit },
    })
  } catch (e) {
    console.error('[packaging/board]', describeError(e))
    // 分線輪 migration 未套用：明確提示（保留「找不到資料表」字樣，前端據以顯示套用提示）
    if (isMissingSchema(e)) return noStore({ success: false, error: linesMigrationMessage(e), code: 'migration_required' }, 409)
    return noStore({ success: false, error: publicDbError(e), code: 'db_error' }, 500)
  }
}
