// 包裝專區 P1 — 工作台組裝（純函式，規格 §3.6；D7／D21／D22／D26／D50／D51／D52）
//
// 輸入：P0 待排池（buildPackagingPool 的輸出，本檔只讀不改它的邏輯）＋擺放列＋產能列。
// 輸出：日期欄、待排區、視窗之後的統計、扣掉已排量的待排池。
// 所有「推導」都在這裡做（D50 順延、D7 修剪、剩餘量），GET 不寫 DB（唯讀者也在呼叫，規格 §〇 硬限制 4）。
//
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum；sha1 用純 JS 實作，前端也能 import 本檔。

import type {
  BoardCard,
  BoardDay,
  BoardResponse,
  BoardSkipped,
  DailyCapacity,
  LineAllocation,
  LineSupply,
  Placement,
  PlacementAllocation,
  PlacementFlag,
  PoolCardMeta,
  YMD,
} from './scheduleTypes'
import { MIN_CARD_MINUTES } from './scheduleTypes'
import type { PackagingCard, PoolBlock, PoolResponse } from './types'
import { boardWindow, dayLabel, delayWorkdays, displayDateOf, openSaturdaysOf, rollTarget, shortDate, weekdayOf } from './scheduleCalendar'
import { dayLoad, resolveCapacity } from './scheduleCapacity'
import { allocateLine, isPlaceableBlock, lineSupply, minutesForQty, r3 } from './scheduleAllocate'

type PoolOk = Extract<PoolResponse, { success: true }>
export type BoardBody = Omit<Extract<BoardResponse, { success: true; unchanged?: false }>, 'lock' | 'me' | 'serverTime' | 'revision'>

/** 工作台頁尾追加的註腳（P1 規則說明） */
export const SCHEDULE_NOTES: string[] = [
  '排定日已過仍未勾完成的卡，自動顯示在今天（今天是週末／假日則為下一個工作日）並標「延誤 N 天」（D50）；資料庫的排定日不變，天數會逐日累加。拖到任何一天即清除延誤。',
  '待排池數量減少（多半是塔台已報包裝完工，D45）時，從最早排定的卡開始扣；扣到 0 的卡顯示「已由待排池扣完」，可按移除。',
  '預排卡（虛線）只能排在預估可包日當天或之後；到期仍未就緒亮橘燈提醒挪移（D22）。「常平未寄出且緊張」與「委外出貨待確認」只提醒、不能排。',
  '已勾完成的卡留在當天欄並變灰、計入當天已排工時；勾完成不回寫塔台（D24）。',
  '每張子卡最少 10 分鐘，拆越多張、工時合計越偏高。',
]

const round1 = (x: number): number => Math.round(x * 10) / 10
const EPS = 1e-9
const tsOf = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0 }

/** 規格 §3.6 步驟 6 欄內固定排序：延誤天數多 → pre_due → 打樣類 → 交期 → 建立時間（D5 不排時段，欄內順序沒有意義，不存） */
function compareBoardCards(a: BoardCard, b: BoardCard, createdAt: ReadonlyMap<string, string>): number {
  if (a.delayWorkdays !== b.delayWorkdays) return b.delayWorkdays - a.delayWorkdays
  const pd = (c: BoardCard) => (c.flags.some((f) => f.code === 'pre_due') ? 0 : 1)
  if (pd(a) !== pd(b)) return pd(a) - pd(b)
  const sm = (c: BoardCard) => (c.card.sample.isSample ? 0 : 1)
  if (sm(a) !== sm(b)) return sm(a) - sm(b)
  const da = a.card.dueDate, db = b.card.dueDate
  if (da !== db) {
    if (da == null) return 1
    if (db == null) return -1
    return da < db ? -1 : 1
  }
  const t = tsOf(createdAt.get(a.placementId) ?? '') - tsOf(createdAt.get(b.placementId) ?? '')
  if (t !== 0) return t
  return a.placementId < b.placementId ? -1 : a.placementId > b.placementId ? 1 : 0
}

/** 以底卡為範本，只換數值（元件與樣式沿用 P0 PackagingCard，延後細節：卡片樣式不動） */
function cardWithQty(base: PackagingCard, qty: number, readyQty: number, minutes: number | null, split: PackagingCard['split']): PackagingCard {
  const perUnit = base.work.perUnit
  return {
    ...base,
    qtyCard: qty,
    qtyReady: readyQty,
    split,
    work: {
      ...base.work,
      qtyBasis: qty,
      minutes,
      minApplied: perUnit != null && qty > 0 && perUnit * qty < MIN_CARD_MINUTES && minutes === MIN_CARD_MINUTES,
    },
  }
}

export function assembleBoard(input: {
  pool: PoolOk
  placements: readonly Placement[]
  capacityRows: readonly DailyCapacity[]
  today: YMD
  from: YMD
  workdays: number
}): BoardBody {
  const { pool, today } = input
  const from = input.from < today ? today : input.from
  const capRows = [...input.capacityRows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const openSats = openSaturdaysOf(capRows)
  const rt = rollTarget(today, openSats)
  const windowDays = boardWindow(from, input.workdays, openSats)
  const windowSet = new Set(windowDays)
  const windowEnd = windowDays[windowDays.length - 1] ?? from

  // 1. 待排池卡依 SO 行分組
  const cardsByLine = new Map<string, PackagingCard[]>()
  const cardById = new Map<string, PackagingCard>()
  for (const b of pool.blocks) for (const c of b.cards) {
    cardById.set(c.cardId, c)
    let arr = cardsByLine.get(c.soLineKey)
    if (!arr) { arr = []; cardsByLine.set(c.soLineKey, arr) }
    arr.push(c)
  }
  const plByLine = new Map<string, Placement[]>()
  const createdAt = new Map<string, string>()
  for (const p of input.placements) {
    createdAt.set(p.id, p.createdAt)
    let arr = plByLine.get(p.soLineKey)
    if (!arr) { arr = []; plByLine.set(p.soLineKey, arr) }
    arr.push(p)
  }

  const skipped: BoardSkipped = { lineGoneOpen: 0, lineGoneCompleted: 0, consumedPast: 0 }
  const allocs = new Map<string, LineAllocation>()
  const supplies = new Map<string, LineSupply>()

  type Visible = { card: BoardCard; display: YMD | null; completed: boolean }
  const visibleByLine = new Map<string, Visible[]>()

  for (const [key, pls] of plByLine) {
    const lineCards = cardsByLine.get(key)
    // 2. 行已不在待排池（D43 塔台結案、D45 包裝報完工、SO 結案…）：不刪資料，讀取時略過
    if (!lineCards || lineCards.length === 0) {
      for (const p of pls) { if (p.completed) skipped.lineGoneCompleted++; else skipped.lineGoneOpen++ }
      continue
    }
    // 3. 供給與分配
    const supply = lineSupply(key, lineCards)
    const a = allocateLine({ supply, placements: pls, today, openSats })
    supplies.set(key, supply)
    allocs.set(key, a)
    const byPid = new Map<string, PlacementAllocation>()
    for (const x of a.placements) byPid.set(x.placementId, x)

    const vis: Visible[] = []
    for (const p of pls) {
      const al = byPid.get(p.id)!
      const dd = displayDateOf(p, today, openSats)
      // pool_consumed 且原排定日已過：不顯示（D50「effectiveQty = 0 的卡不順延」）
      if (!p.completed && al.effectiveQty <= EPS && p.planDate != null && p.planDate < today) { skipped.consumedPast++; continue }
      const base = cardById.get(al.baseCardId ?? '') ?? (p.originCardId ? cardById.get(p.originCardId) : undefined) ?? lineCards[0]
      const qty = p.completed ? p.qty : al.effectiveQty
      const minutes = minutesForQty(supply.perUnit, qty)
      const delay = !p.completed && dd.rolled && p.planDate ? delayWorkdays(p.planDate, today) : 0

      // 旗標（規格 §3.3 表）
      const flags: PlacementFlag[] = []
      if (!p.completed) {
        if (delay > 0) flags.push({ code: 'delayed', label: `延誤 ${delay} 天`, level: 'warn' })
        if (dd.offBoard && p.planDate) flags.push({ code: 'off_board_day', label: `原排 ${shortDate(p.planDate)} 已非工作日`, level: 'info' })
        if (al.effectiveQty > EPS) {
          if (al.readiness !== 'ready' && dd.date != null && dd.date <= today) {
            flags.push({ code: 'pre_due', label: '到期仍未就緒（未入庫／前站未完工），請挪移', level: 'warn' })
          }
          if (al.readiness === 'pre' && al.preReadyDate && dd.date != null && dd.date < al.preReadyDate) {
            flags.push({ code: 'before_est_ready', label: `排在預估可包日 ${shortDate(al.preReadyDate)} 之前`, level: 'warn' })
          }
          if (al.trimmedQty > EPS) {
            flags.push({ code: 'trimmed', label: `待排池減少 ${al.trimmedQty}（可能塔台已報包裝完工或訂單／採購量變更）`, level: 'info' })
          }
        } else if (supply.total <= EPS && supply.nonPlaceableQty > 0) {
          flags.push({ code: 'not_placeable_now', label: '目前只剩未寄出／待確認的量，不能排', level: 'warn' })
        } else {
          flags.push({ code: 'pool_consumed', label: '已由待排池扣完（多半是塔台已報包裝完工）', level: 'info' })
        }
        const eta = base.flags.find((f) => f.code === 'eta_passed')
        if (eta) flags.push({ code: 'line_eta_passed', label: eta.label, level: 'warn' })
      }

      const bc: BoardCard = {
        placementId: p.id,
        version: p.version,
        soLineKey: p.soLineKey,
        qty: p.qty,
        effectiveQty: qty,
        planDate: p.planDate,
        displayDate: dd.date,
        originalDate: p.originalDate,
        delayWorkdays: delay,
        readiness: p.completed ? 'ready' : al.readiness,
        readyQty: p.completed ? p.qty : al.readyQty,
        preReadyDate: p.completed ? null : al.preReadyDate,
        minutes,
        split: null, // 步驟 8 再填
        completed: p.completed,
        source: p.source,
        flags,
        card: cardWithQty(base, qty, p.completed ? p.qty : al.readyQty, minutes, null),
      }
      vis.push({ card: bc, display: dd.date, completed: !!p.completed })
    }
    visibleByLine.set(key, vis)
  }

  // 7. 待排池：扣掉已排量、重算合計
  const cardMeta: Record<string, PoolCardMeta> = {}
  const remainingOf = (c: PackagingCard): number => {
    if (!isPlaceableBlock(c.block)) return c.qtyCard
    const a = allocs.get(c.soLineKey)
    if (!a) return c.qtyCard
    return a.remainingByCard[c.cardId] ?? 0
  }
  const poolCardsByLine = new Map<string, PackagingCard[]>()
  const blocks: PoolBlock[] = pool.blocks.map((b) => {
    const list: PackagingCard[] = []
    for (const c of b.cards) {
      const remaining = r3(Math.max(0, remainingOf(c)))
      cardMeta[c.cardId] = {
        originalQty: c.qtyCard,
        placedQty: r3(Math.max(0, c.qtyCard - remaining)),
        remainingQty: remaining,
        placeable: isPlaceableBlock(c.block),
      }
      if (remaining <= EPS) continue
      // 有擺放的行一律複製（下面步驟 8 會改 split）；絕不可改到 P0 快取裡的原物件（多個請求共用）
      let out = c
      if (allocs.has(c.soLineKey)) {
        if (Math.abs(remaining - c.qtyCard) <= EPS) out = { ...c }
        else {
          // 每張卡先扣自己的可包片、再扣未就緒片（分配順序保證），所以剩餘的可包量＝剩餘 − 未就緒量
          const pendingOwn = Math.max(0, c.qtyCard - c.qtyReady)
          const readyLeft = r3(Math.max(0, remaining - pendingOwn))
          out = cardWithQty(c, remaining, readyLeft, minutesForQty(c.work.perUnit, remaining), c.split)
        }
      }
      list.push(out)
      let arr = poolCardsByLine.get(c.soLineKey)
      if (!arr) { arr = []; poolCardsByLine.set(c.soLineKey, arr) }
      arr.push(out)
    }
    return {
      ...b,
      cards: list,
      cardCount: list.length,
      totalMinutes: round1(list.reduce((s, c) => s + (c.work.minutes ?? 0), 0)),
      unknownMinutesCards: list.filter((c) => c.work.minutes == null).length,
      overdueCount: list.filter((c) => !!c.dueDate && c.dueDate < today).length,
      sampleCount: list.filter((c) => c.sample.isSample).length,
    }
  })

  // 8. D7 子卡序：同一行顯示中的擺放依（顯示日、待排區最後、建立時間）編號 1..k，剩餘的待排池卡接在後面
  for (const [key, vis] of visibleByLine) {
    const shown = vis.filter((v) => !v.completed || (v.display != null && v.display >= from))
    const ordered = [...shown].sort((a, b) => {
      if (a.display !== b.display) {
        if (a.display == null) return 1
        if (b.display == null) return -1
        return a.display < b.display ? -1 : 1
      }
      const t = tsOf(createdAt.get(a.card.placementId) ?? '') - tsOf(createdAt.get(b.card.placementId) ?? '')
      if (t !== 0) return t
      return a.card.placementId < b.card.placementId ? -1 : 1
    })
    const rest = poolCardsByLine.get(key) ?? []
    const total = ordered.length + rest.length
    if (ordered.length === 0) continue
    ordered.forEach((v, i) => {
      const split = total >= 2 ? { index: i + 1, total } : null
      v.card.split = split
      v.card.card = { ...v.card.card, split }
    })
    rest.forEach((c, j) => { c.split = total >= 2 ? { index: ordered.length + j + 1, total } : null })
  }

  // 5／6. 放進日期欄／待排區／視窗之後
  const dayCards = new Map<YMD, BoardCard[]>()
  for (const d of windowDays) dayCards.set(d, [])
  const holding: BoardCard[] = []
  const later = { count: 0, minutes: 0, firstDate: null as YMD | null }
  for (const vis of visibleByLine.values()) {
    for (const v of vis) {
      if (v.display == null) { holding.push(v.card); continue }
      if (windowSet.has(v.display)) { dayCards.get(v.display)!.push(v.card); continue }
      if (v.display > windowEnd) {
        later.count++
        later.minutes = round1(later.minutes + (v.card.minutes ?? 0))
        if (later.firstDate == null || v.display < later.firstDate) later.firstDate = v.display
      }
      // 早於 from（往右載入的視窗、或過去的完成卡）不在這次回應
    }
  }
  const cmp = (a: BoardCard, b: BoardCard) => compareBoardCards(a, b, createdAt)
  holding.sort(cmp)

  const days: BoardDay[] = windowDays.map((d) => {
    const cards = dayCards.get(d)!.sort(cmp)
    const capacity = resolveCapacity(d, capRows)
    const usedMinutes = round1(cards.reduce((s, c) => s + (c.minutes ?? 0), 0))
    const openMinutes = round1(cards.reduce((s, c) => s + (c.completed ? 0 : c.minutes ?? 0), 0))
    const wd = weekdayOf(d)
    return {
      date: d,
      weekday: wd,
      kind: wd === 6 ? 'saturday_ot' : 'workday',
      isToday: d === today,
      label: dayLabel(d),
      capacity,
      cards,
      usedMinutes,
      openMinutes,
      unknownMinutesCards: cards.filter((c) => c.minutes == null).length,
      load: dayLoad(usedMinutes, capacity),
      rolledInCount: cards.filter((c) => c.delayWorkdays > 0).length,
    }
  })

  return {
    success: true,
    today,
    rollTarget: rt,
    window: { from, to: windowEnd, workdays: input.workdays },
    days,
    holding,
    later,
    pool: { blocks, cardMeta, generatedAt: pool.generatedAt, cached: pool.cached },
    skipped,
    freshness: pool.freshness,
    excluded: pool.excluded,
    notes: [...pool.notes, ...SCHEDULE_NOTES],
    staleUnsyncedCount: pool.staleUnsynced?.count ?? 0,
  }
}

// ── revision（D52 輪詢指紋）──

/** 同一份待排池物件只算一次摘要（poolCache 回傳的 { ...cache.data } 每次是新物件，但 blocks 陣列是同一個參考） */
const poolDigestMemo = new WeakMap<object, string>()

/**
 * 待排池「內容」摘要：blocks（卡片數量、可包量、預估可包日、旗標…）＋ freshness／excluded／notes／staleUnsynced 張數＋today。
 * 刻意不含 generatedAt／cached：讀取快取每 120 秒重算一次，內容沒變時指紋也不該變，
 * 否則每隔一次 60 秒輪詢就會回傳完整工作台，D52 的 unchanged 省流量對唯讀使用者約一半時間失效。
 * 代價：內容沒變時，畫面上的「待排池生成時間」不會跟著更新（要等內容或排程有變）。
 */
export function poolDigest(pool: Pick<PoolOk, 'blocks' | 'freshness' | 'excluded' | 'notes' | 'staleUnsynced' | 'today'>): string {
  const hit = poolDigestMemo.get(pool.blocks)
  if (hit) return hit
  const s = JSON.stringify([pool.today, pool.blocks, pool.freshness, pool.excluded, pool.notes, pool.staleUnsynced?.count ?? 0])
  const d = sha1Hex(s).slice(0, 16)
  poolDigestMemo.set(pool.blocks, d)
  return d
}

/**
 * sha1(poolDigest | opLogMaxId | placementsMaxUpdatedAt | placementCount | today | window) 前 16 碼。
 * - placementsMaxUpdatedAt／placementCount：整張擺放表的最大 updated_at 與列數（GET board 先用一個便宜查詢取得，
 *   指紋相同就不必讀全部擺放）；刪除會讓列數變、寫入會讓 op_log 最大 id 變。
 * - window：from＋workdays；前端換顯示天數時沿用舊 rev 也不會誤回 unchanged。
 * 不含鎖：心跳每 30 秒改 last_action_at，含進去就永遠不會 unchanged（鎖狀態在 unchanged 回應裡另外帶）。
 */
export function boardRevision(parts: {
  poolDigest: string
  opLogMaxId: number
  placementsMaxUpdatedAt: string | null
  placementCount: number
  today: YMD
  window?: string
}): string {
  const s = [parts.poolDigest, parts.opLogMaxId, parts.placementsMaxUpdatedAt ?? '', parts.placementCount, parts.today, parts.window ?? ''].join('|')
  return sha1Hex(s).slice(0, 16)
}

/** 純 JS SHA-1（UTF-8）。不用 node:crypto，前端 bundle 也能用；只拿來做指紋，不做安全用途 */
export function sha1Hex(str: string): string {
  const bytes = new TextEncoder().encode(str)
  const bitLen = bytes.length * 8
  const withPad = ((bytes.length + 9 + 63) >> 6) << 6
  const buf = new Uint8Array(withPad)
  buf.set(bytes)
  buf[bytes.length] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(withPad - 8, Math.floor(bitLen / 0x100000000))
  dv.setUint32(withPad - 4, bitLen >>> 0)
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31) }
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let i = 0; i < 80; i++) {
      let f: number, k: number
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
      else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('')
}
