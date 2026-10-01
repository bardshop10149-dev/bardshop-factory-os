import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { Placement } from '@/lib/packaging/scheduleTypes'
import type { PackagingCard } from '@/lib/packaging/types'
import { guardPackaging, noStore } from '@/lib/packaging/guard'
import { getPool, POOL_READ_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { addDays, displayDateOf, openWeekendDaysOf } from '@/lib/packaging/scheduleCalendar'
import { assembleBoard } from '@/lib/packaging/scheduleBoard'
import { activeLinesOf, lineNameOf } from '@/lib/packaging/scheduleLines'
import { getManualMergedPool } from '@/lib/packaging/manualCache'
import {
  isMissingSchema,
  linesMigrationMessage,
  loadCapacityRows,
  loadCompletedSince,
  loadLineCapacityRows,
  loadLines,
  loadOpenPlacements,
  loadPlacementsByLines,
  publicDbError,
  searchPlacementsByKey,
} from '@/lib/packaging/scheduleDb'
import {
  SEARCH_MAX_HITS,
  SEARCH_QUERY_HINT,
  capHits,
  hiddenSummaries,
  matchKey,
  matchPackagingCard,
  parseSearchQuery,
  searchBoardBody,
  searchWindowWorkdays,
  sortHits,
  type BoardSearchResponse,
  type SearchMatch,
  type SearchRow,
} from '@/lib/packaging/boardSearch'
import { todayTaipei } from '@/lib/packaging/workdays'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 D113（排程區單號搜尋）：GET /api/packaging/search?q=
//
// Snow：「從待排池拉出來之後，右邊由於訂單過多會找不到，需要有一個搜尋的地方讓我們知道他被排在哪裡了」——
// 搜尋範圍是「全部已排的卡，不限畫面上的日期」。前端只有目前日期窗的卡，所以由伺服器重組一次工作台再找
// （「線內第幾張」「延誤卡顯示在哪天」「行已不在待排池就隱藏」都要靠 assembleBoard 才算得跟畫面一樣）。
//
// ⚠ 唯讀：只 select，不寫任何表（正式站、無自動備份）；權限同 GET board（guardPackaging('read')），回應一律 no-store。
// 成本控制（重讀一次工作台＝讀全部未完成擺放＋400 天產能，不便宜）：
//   1. 便宜階段：待排池（120 秒快取）比對 SO／製令＋擺放表 ilike（一個請求、最多 300 筆）＋結案行；
//      沒有任何「可能有擺放」的命中（ilike 沒撈到、待排池也沒有製令／來源單命中）→ 不重讀，只回結案行（待排池的卡前端畫面上就有）。
//   2. 重讀階段：同 GET board 的讀取（from＝今天），視窗只開到命中卡最遠那天（最多 62 個工作日），組裝後找卡；
//      只回排定在日期上的卡＋隱藏／結案原因（待排池、待排區前端畫面上是完整的）。
//   前端另有 debounce 350ms、至少 3 碼、取消舊請求、依查詢快取 30 秒。
// 暫不和 GET board 抽共用 helper：這次不動正式讀取路徑（board route），之後可以再重構。
// log：出錯時只寫錯誤本身（describeError），不寫使用者資料。

/** 同 GET board：產能沿用要看「較早的平日列」，讀近 400 天 */
const CAPACITY_LOOKBACK_DAYS = 400
/** GET board 的 from 上限（today+180）：再遠的卡工作台顯示不出來 → 不可跳 */
const NAV_MAX_DAYS = 180

export async function GET(request: NextRequest) {
  const g = await guardPackaging('read')
  if (!g.ok) return g.res

  const sq = parseSearchQuery(request.nextUrl.searchParams.get('q'))
  if (!sq) return noStore<BoardSearchResponse>({ success: false, error: SEARCH_QUERY_HINT, code: 'bad_request' }, 400)
  const today = todayTaipei(new Date())

  let sb
  try {
    sb = getSupabaseAdminClient()
  } catch (e) {
    console.error('[packaging/search]', describeError(e))
    return noStore<BoardSearchResponse>({ success: false, error: publicDbError(e), code: 'db_error' }, 500)
  }

  let basePool
  try {
    basePool = await getPool({ maxAgeMs: POOL_READ_MAX_AGE_MS })
  } catch (e) {
    console.error('[packaging/search] 待排池組裝失敗:', describeError(e))
    return noStore<BoardSearchResponse>({ success: false, error: '待排池暫時無法組裝，請稍後再試', code: 'pool_unavailable' }, 500)
  }

  try {
    // D66 手動區塊併入、D104 結案行已拿掉（closedKeys＝未復原的結案行，大寫）
    const manual = await getManualMergedPool(sb, basePool)
    const pool = manual.pool

    // ── 1. 便宜階段 ──
    const poolLineKeys = new Set<string>()
    const cardByLine = new Map<string, PackagingCard>()
    const poolMatched = new Map<string, SearchMatch>()
    for (const b of pool.blocks) {
      for (const c of b.cards) {
        poolLineKeys.add(c.soLineKey)
        if (!cardByLine.has(c.soLineKey)) cardByLine.set(c.soLineKey, c)
        const m = matchPackagingCard(c, sq)
        const prev = poolMatched.get(c.soLineKey)
        if (m && (!prev || m.rank < prev.rank)) poolMatched.set(c.soLineKey, m)
      }
    }
    // ilike 用去前綴的 core（SO／SOB 打錯也撈得到），回來再用 matchKey 精確篩（917005-1 不要 -10、-11）
    const keyRows = (await searchPlacementsByKey(sb, sq.core ?? sq.q)).filter((r) => matchKey(r.soLineKey, sq) != null)
    const closedMatches = [...manual.closedKeys].filter((k) => matchKey(k, sq) != null)

    /** 命中的 SO 行：SO-項次命中，或待排池卡的製令／來源單命中（製令只在待排池卡上） */
    const matchOf = (key: string): SearchMatch | null => {
      const pm = poolMatched.get(key)
      if (pm) return pm
      const r = matchKey(key, sq)
      return r == null ? null : { field: 'so', text: key, rank: r }
    }

    // 不必重讀工作台的情況：擺放表 ilike 沒命中（＝用單號找不到任何擺放），待排池也只有「單號」命中（同一個比對規則，
    // 有擺放的話 ilike 一定撈得到）→ 這些行都還沒排；待排池的卡前端畫面上就有。只剩結案行要告訴使用者。
    // 製令／來源單命中（field mo／src）不在擺放表的 so_line_key 上，一定要重讀才知道那幾行有沒有排。
    const needBoard = keyRows.length > 0 || [...poolMatched.values()].some((m) => m.field !== 'so')
    if (!needBoard) {
      const closedOnly = hiddenSummaries({
        rows: [], visibleIds: new Set(), poolLineKeys, closedKeys: manual.closedKeys, closedMatches,
        today, windowEnd: today, navigableUntil: today, matchOf,
      })
      const capped = capHits(sortHits(closedOnly), SEARCH_MAX_HITS)
      return noStore<BoardSearchResponse>({ success: true, q: sq.q, today, hits: capped.hits, truncated: capped.truncated })
    }

    // ── 2. 重讀階段（與 GET board 完整讀取相同，from＝今天） ──
    const [open, completedFrom, capacityRows, completedInPool, lines, lineRows] = await Promise.all([
      loadOpenPlacements(sb),
      loadCompletedSince(sb, today),
      loadCapacityRows(sb, addDays(today, -CAPACITY_LOOKBACK_DAYS)),
      loadPlacementsByLines(sb, [...poolLineKeys], { completedOnly: true }),
      loadLines(sb),
      loadLineCapacityRows(sb, addDays(today, -CAPACITY_LOOKBACK_DAYS)),
    ])
    const byId = new Map<string, Placement>()
    for (const p of [...open, ...completedFrom, ...completedInPool]) byId.set(p.id, p)
    const placements = [...byId.values()]

    // 視窗只開到命中卡最遠那天（延誤卡在今天、排在非工作台日的順延到下一個工作台日，都在這之內）
    let maxDate = today
    for (const p of placements) if (p.planDate && p.planDate > maxDate && matchOf(p.soLineKey)) maxDate = p.planDate
    for (const r of keyRows) if (r.planDate && r.planDate > maxDate) maxDate = r.planDate
    const workdays = searchWindowWorkdays(today, maxDate)

    const body = assembleBoard({
      pool, placements, capacityRows, lines, lineRows, today, from: today, workdays,
      manual: { meta: manual.meta, backInPoolKeys: manual.backInPoolKeys, skipped: manual.skipped },
    })
    // 只回排定在日期上的卡：待排池與待排區不分日期窗、前端畫面上本來就是完整的（而且含樂觀更新），
    // 前端合併時一律用畫面上的（mergeBoardHits）；伺服器再回一份只會佔掉 50 筆上限的名額
    const found = searchBoardBody(body, sq).filter((h) => h.kind === 'day')

    // 命中但工作台不顯示的擺放 → 告訴使用者原因（結案、行已不在待排池、已完成的過去日期、太遠…）
    const visibleIds = new Set<string>()
    for (const c of body.holding) visibleIds.add(c.placementId)
    for (const d of body.days) for (const c of d.cards) visibleIds.add(c.placementId)
    const sortedCap = [...capacityRows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const openWeekends = openWeekendDaysOf(sortedCap, lineRows, new Set(activeLinesOf(lines).map((l) => l.id)))
    const toRow = (id: string, soLineKey: string, qty: number, planDate: string | null, completedAt: string | null, lineId: number | null): SearchRow => ({
      id, soLineKey, qty, planDate, lineId, completed: completedAt != null,
      displayDate: displayDateOf({ planDate, completed: completedAt ? { at: completedAt, by: '', byName: null, poolQtyAt: null } : null }, today, openWeekends).date,
    })
    const rows: SearchRow[] = []
    for (const p of placements) {
      if (!visibleIds.has(p.id) && matchOf(p.soLineKey)) rows.push(toRow(p.id, p.soLineKey, p.qty, p.planDate, p.completed?.at ?? null, p.lineId ?? null))
    }
    for (const r of keyRows) {
      if (!visibleIds.has(r.id) && !byId.has(r.id)) rows.push(toRow(r.id, r.soLineKey, r.qty, r.planDate, r.completedAt, r.lineId))
    }
    const hidden = hiddenSummaries({
      rows,
      visibleIds,
      poolLineKeys,
      closedKeys: manual.closedKeys,
      closedMatches,
      today,
      windowEnd: body.window.to,
      navigableUntil: addDays(today, NAV_MAX_DAYS),
      matchOf,
      infoOf: (key) => {
        const c = cardByLine.get(key)
        return c ? { label: `${c.so}${c.soLine ? `-${c.soLine}` : ''}`, itemName: c.itemName, customer: c.customer, unit: c.unit } : null
      },
      lineNameOf: (id) => lineNameOf(lines, id) || null,
    })

    const capped = capHits(sortHits([...found, ...hidden]), SEARCH_MAX_HITS)
    return noStore<BoardSearchResponse>({ success: true, q: sq.q, today, hits: capped.hits, truncated: capped.truncated })
  } catch (e) {
    console.error('[packaging/search]', describeError(e))
    if (isMissingSchema(e)) return noStore<BoardSearchResponse>({ success: false, error: linesMigrationMessage(e), code: 'migration_required' }, 409)
    return noStore<BoardSearchResponse>({ success: false, error: publicDbError(e), code: 'db_error' }, 500)
  }
}
