// 包裝專區 D113（排程區單號搜尋）— 純函式：查詢正規化、單號／製令比對、在工作台資料裡找卡、隱藏原因、跳轉目標推導
//
// Snow（2026-10-01）：「從待排池拉出來之後，右邊由於訂單過多會找不到，需要有一個搜尋的地方讓我們知道他被排在哪裡了」
//   「希望輸入單號之後可以拉動畫面到那個地方，並且卡片邊框發光」。
// ⚠ 需求決策紀錄裡有兩列都編 D113（AI 費用上限、排程區單號搜尋）；本檔一律指「D113 排程區單號搜尋」。
//
// 為什麼抽成純函式、前後端共用：
//   - 正式工作台的畫面只有「目前日期窗」的卡，要找全部已排的卡得由伺服器（GET /api/packaging/search）重組一次工作台再找；
//     AI 模擬區的資料在前端就是全部模擬天數。兩邊用「同一套」比對與排序（D100 兩邊一致），結果才不會一邊找得到、一邊找不到。
//   - 「線內第幾張」「延誤卡顯示在哪天」「線不存在時歸第一條線」這些規則必須和畫面（DayLanesView／MultiDayView）完全一致，
//     放在一起才測得到。
// 規範同 scheduleBoard.ts：不 import supabase、不讀時鐘（today 由呼叫端傳入）、只用相對路徑 import、不用 enum。

import type { BoardCard, YMD } from './scheduleTypes'
import type { PackagingCard } from './types'
import { placementState } from './boardView'
import { dayLabel, shortDate } from './scheduleCalendar'
import { workdaysBetween } from './workdays'

// ─────────────────────────────────────────────────────────────────────
// 查詢正規化
// ─────────────────────────────────────────────────────────────────────

export interface SearchQuery {
  /** 正規化後的查詢（大寫、無空白、只剩 A-Z 0-9 -） */
  q: string
  /** 開頭是 SO／SOB／SOA／RO／ASO 前綴時，去掉前綴的部分（前綴打錯也找得到；長度 ≥ 3 才有值） */
  core: string | null
  /** 查詢以「-數字」結尾＝指定了項次：917005-1 不可命中 -10、-11 */
  lineBoundary: boolean
}

export const SEARCH_MIN_LEN = 3
export const SEARCH_MAX_LEN = 40
/** 一次最多列幾筆（再多請使用者打更完整的單號） */
export const SEARCH_MAX_HITS = 50
export const SEARCH_QUERY_HINT = '請輸入至少 3 碼單號或製令號（英數字與 -）'

/**
 * NFKC 不會轉的各種破折號：U+2010～2015（‐ ‑ ‒ – — ―）、U+2212（−）、U+30FC（ー，注音／日文輸入法常打出來）、
 * U+FF70（半形ｰ）、U+FE58／FE63（小寫破折號）。全形「－」NFKC 會轉成 '-'，不必列。
 */
const DASHES = /[‐-―−ーｰ﹘﹣]/g
/** 單號前綴（SOA 本身含連字號：SOA260924-095321-313；前綴後面一定接數字，才不會把 SOB 的 B 當成單號本體） */
const PREFIX_RE = /^(SOB|SOA|SO|RO|ASO)(?=\d)/
const QUERY_RE = new RegExp(`^[A-Z0-9-]{${SEARCH_MIN_LEN},${SEARCH_MAX_LEN}}$`)

/** 全形→半形（NFKC）、轉大寫、各種破折號→'-'、去掉所有空白、去掉頭尾的 '-' */
export function normalizeSearchText(raw: string | null | undefined): string {
  return String(raw ?? '').normalize('NFKC').toUpperCase().replace(DASHES, '-').replace(/\s+/g, '').replace(/^-+|-+$/g, '')
}

/**
 * 使用者輸入 → 查詢；不合格（太短、太長、含英數字與 - 以外的字）回 null。
 * 白名單同時是安全邊界：伺服器把 q 放進 ilike('%q%')，擋掉 % 與 _ 就不會變成萬用字元；放進 RegExp 也不必跳脫。
 */
export function parseSearchQuery(raw: string | null | undefined): SearchQuery | null {
  const q = normalizeSearchText(raw)
  if (!QUERY_RE.test(q)) return null
  const m = q.match(PREFIX_RE)
  const rest = m ? q.slice(m[0].length) : ''
  return { q, core: m && rest.length >= SEARCH_MIN_LEN ? rest : null, lineBoundary: /-\d+$/.test(q) }
}

// ─────────────────────────────────────────────────────────────────────
// 比對
// ─────────────────────────────────────────────────────────────────────

export type SearchMatchField = 'so' | 'mo' | 'src'

/** rank：0 完全相同（整個 SO 或 SO-項次）→ 1 開頭／結尾 → 2 包含 → 3 只有去前綴後命中 → 4 製令 → 5 其他來源單 */
export interface SearchMatch {
  field: SearchMatchField
  /** 命中的那個號碼（清單上顯示，讓使用者看得出為什麼列出這張） */
  text: string
  rank: number
}

type Compiled = { starts: RegExp; contains: RegExp; core: RegExp | null }
/** 同一個查詢物件只編譯一次（每次搜尋要比對上千張卡） */
const compiledMemo = new WeakMap<SearchQuery, Compiled>()
function compiled(sq: SearchQuery): Compiled {
  const hit = compiledMemo.get(sq)
  if (hit) return hit
  // 白名單已保證 q／core 只有 [A-Z0-9-]，'-' 在字元類別外不是特殊字元 → 不必跳脫
  const tail = sq.lineBoundary ? '(?!\\d)' : ''
  const c: Compiled = {
    starts: new RegExp(`^${sq.q}${tail}`),
    contains: new RegExp(`${sq.q}${tail}`),
    core: sq.core ? new RegExp(`${sq.core}${tail}`) : null,
  }
  compiledMemo.set(sq, c)
  return c
}

const upperKey = (s: string): string => s.toUpperCase().replace(/\s+/g, '')

/** SO 行鍵（`${so}-${line}`）的命中等級；沒命中 null */
export function matchKey(soLineKey: string, sq: SearchQuery): number | null {
  const k = upperKey(soLineKey)
  const c = compiled(sq)
  const so = k.replace(/-\d{1,4}$/, '')
  if (k === sq.q || so === sq.q) return 0
  if (c.starts.test(k) || k.endsWith(sq.q)) return 1
  if (c.contains.test(k)) return 2
  if (c.core && c.core.test(k)) return 3
  return null
}

type MatchableCard = Pick<PackagingCard, 'soLineKey' | 'so' | 'soLine' | 'preStation' | 'sources'>

const labelOf = (c: { so: string; soLine: string | null }): string => `${c.so}${c.soLine ? `-${c.soLine}` : ''}`

/**
 * 一張待排池卡（或排定卡的底卡 bc.card）是否符合：先比 SO-項次，再比製令（前站製令、同行其他製令、自製來源單、塔台製令），
 * 最後比其他來源單（PO／POC／MPO；卡片「製令」欄沒有製令時顯示的就是它）。製令只存在待排池卡上（D113 追查 §5）。
 */
export function matchPackagingCard(card: MatchableCard, sq: SearchQuery): SearchMatch | null {
  const r = matchKey(card.soLineKey, sq)
  if (r != null) return { field: 'so', text: labelOf(card), rank: r }
  const mos: (string | null | undefined)[] = [
    card.preStation?.moNbr,
    ...(card.preStation?.otherMos ?? []),
    ...card.sources.filter((s) => s.kind === 'inhouse').map((s) => s.docNo),
    ...card.sources.map((s) => s.saraMo),
  ]
  for (const m of mos) if (m && upperKey(m).includes(sq.q)) return { field: 'mo', text: m, rank: 4 }
  for (const s of card.sources) {
    const t = s.lineNo ? `${s.docNo}-${s.lineNo}` : s.docNo
    if (t && upperKey(t).includes(sq.q)) return { field: 'src', text: `${s.docType} ${t}`, rank: 5 }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────────────────────

/**
 * day＝排在某天某線（可跳）；holding＝待排區（可跳）；pool＝仍在待排池（可跳）；
 * hidden＝有擺放但工作台不顯示（不可跳，寫原因）；closed＝已結案／結案處理中（不可跳，可開結案池）
 */
export type SearchHitKind = 'day' | 'holding' | 'pool' | 'hidden' | 'closed'

/**
 * closed＝已結案（D104）；closing＝本機剛按結案、背景還在送（D110 記號）；line_gone＝行已不在待排池（塔台結案、報完工、全數銷貨…）；
 * done_past＝已完成且日期已過（工作台只從今天起）；beyond＝排得太遠（超出工作台能顯示的範圍時不可跳）；
 * consumed_past＝過去日期、已由待排池扣完（D50 不順延）；
 * moved＝伺服器說在某天、畫面已載入那天卻沒有這張（剛被移動／合併／放回，伺服器結果比畫面舊；前端合併時才會出現）
 */
export type SearchHiddenReason = 'closed' | 'closing' | 'line_gone' | 'done_past' | 'beyond' | 'consumed_past' | 'moved'

/** 線內位置（1 起算）；open＝不算已完成的卡（「隱藏已完成」時畫面上看到的順序） */
export interface LanePos {
  index: number
  total: number
  /** 已完成的卡本身沒有 open 位置 */
  openIndex: number | null
  openTotal: number
}

export interface SearchHit {
  kind: SearchHitKind
  /** 清單內唯一：擺放 `pl:${placementId}`、待排池 `pool:${cardId}`、彙總 `x:${KEY}:${reason}` */
  key: string
  placementId: string | null
  cardId: string | null
  soLineKey: string
  /** SO-項次 */
  label: string
  itemName: string | null
  customer: string | null
  /** 顯示數量（排定卡＝有效數量；待排池＝剩餘量；彙總＝合計） */
  qty: number | null
  unit: string | null
  match: SearchMatch
  /** 畫面上在哪一天（延誤卡＝順延目標日 D50；排在非工作台日的卡＝下一個工作台日） */
  displayDate: YMD | null
  planDate: YMD | null
  delayWorkdays: number
  laneId: number | null
  laneName: string | null
  /** 線在當天的順序（排序用）；沒有 null */
  laneSort: number | null
  lanePos: LanePos | null
  completed: boolean
  completedAt: string | null
  completedByName: string | null
  consumed: boolean
  pre: boolean
  split: { index: number; total: number } | null
  blockId: string | null
  blockTitle: string | null
  placeable: boolean | null
  reason: SearchHiddenReason | null
  /** 彙總列：幾張擺放 */
  count: number | null
  /** 能不能跳過去（捲動＋發光） */
  navigable: boolean
  /** 產生順序（同等級、同種類時的穩定排序） */
  seq: number
}

export type BoardSearchResponse =
  | { success: true; q: string; today: YMD; hits: SearchHit[]; truncated: number }
  | { success: false; error: string; code: 'bad_request' | 'forbidden' | 'pool_unavailable' | 'migration_required' | 'db_error' }

/** 搜尋需要的最小工作台形狀：正式工作台 BoardOk、BoardBody、模擬區 board 都符合 */
export interface SearchableBoard {
  days: readonly {
    date: YMD
    cards: readonly BoardCard[]
    lanes?: readonly { lineId: number; name: string }[]
  }[]
  holding: readonly BoardCard[]
  pool: {
    blocks: readonly { id: string; title: string; cards: readonly PackagingCard[] }[]
    cardMeta: Readonly<Record<string, { remainingQty: number; placeable: boolean } | undefined>>
  }
}

function placementHit(
  kind: 'day' | 'holding',
  bc: BoardCard,
  match: SearchMatch,
  at: { laneId: number | null; laneName: string | null; laneSort: number | null; lanePos: LanePos | null },
  seq: number,
): SearchHit {
  const s = placementState(bc)
  return {
    kind,
    key: `pl:${bc.placementId}`,
    placementId: bc.placementId,
    cardId: null,
    soLineKey: bc.soLineKey,
    label: labelOf(bc.card),
    itemName: bc.card.itemName ?? null,
    customer: bc.card.customer ?? null,
    qty: bc.effectiveQty,
    unit: bc.card.unit ?? null,
    match,
    displayDate: bc.displayDate,
    planDate: bc.planDate,
    delayWorkdays: bc.delayWorkdays,
    laneId: at.laneId,
    laneName: at.laneName,
    laneSort: at.laneSort,
    lanePos: at.lanePos,
    completed: s.done,
    completedAt: bc.completed?.at ?? null,
    completedByName: bc.completed ? (bc.completed.byName ?? bc.completed.by) : null,
    consumed: s.consumed,
    pre: s.pre && !s.done,
    split: bc.split,
    blockId: null,
    blockTitle: null,
    placeable: null,
    reason: null,
    count: null,
    navigable: true,
    seq,
  }
}

function positions<T extends { completed?: unknown }>(list: readonly T[]): Map<T, LanePos> {
  const open = list.filter((c) => !c.completed)
  const out = new Map<T, LanePos>()
  list.forEach((c, i) => {
    out.set(c, { index: i + 1, total: list.length, openIndex: c.completed ? null : open.indexOf(c) + 1, openTotal: open.length })
  })
  return out
}

/**
 * 在一份工作台資料裡找符合的卡：日期欄（每天每線，線內位置）＋待排區＋待排池（剩餘量 > 0）。
 * 線的歸屬與畫面一致：laneId 不在當天 lanes 裡的卡歸第一條線（DayLanesView.buildLaneModels／MultiDayView.DayCol 同規則），
 * 順序＝day.cards 的順序（伺服器已依 compareLaneOrder 排好）。
 */
export function searchBoardBody(board: SearchableBoard, sq: SearchQuery): SearchHit[] {
  const out: SearchHit[] = []
  let seq = 0
  for (const day of board.days) {
    const lanes = day.lanes ?? []
    const laneIdx = new Map(lanes.map((l, i) => [l.lineId, i]))
    const byLane = new Map<number | null, BoardCard[]>()
    for (const c of day.cards) {
      const eff = c.laneId != null && laneIdx.has(c.laneId) ? c.laneId : (lanes[0]?.lineId ?? null)
      let arr = byLane.get(eff)
      if (!arr) { arr = []; byLane.set(eff, arr) }
      arr.push(c)
    }
    for (const [laneId, list] of byLane) {
      const hits = list.map((bc) => [bc, matchPackagingCard(bc.card, sq)] as const).filter((x) => x[1] != null)
      if (hits.length === 0) continue
      const pos = positions(list)
      const li = laneId != null ? laneIdx.get(laneId) : undefined
      for (const [bc, m] of hits) {
        out.push(placementHit('day', bc, m!, {
          laneId,
          laneName: li != null ? lanes[li].name : null,
          laneSort: li ?? null,
          lanePos: pos.get(bc) ?? null,
        }, seq++))
      }
    }
  }
  const holdPos = positions(board.holding)
  for (const bc of board.holding) {
    const m = matchPackagingCard(bc.card, sq)
    if (m) out.push(placementHit('holding', bc, m, { laneId: null, laneName: null, laneSort: null, lanePos: holdPos.get(bc) ?? null }, seq++))
  }
  for (const b of board.pool.blocks) {
    for (const c of b.cards) {
      const meta = board.pool.cardMeta[c.cardId]
      const remaining = meta?.remainingQty ?? c.qtyCard
      if (!(remaining > 0)) continue
      const m = matchPackagingCard(c, sq)
      if (!m) continue
      out.push({
        kind: 'pool',
        key: `pool:${c.cardId}`,
        placementId: null,
        cardId: c.cardId,
        soLineKey: c.soLineKey,
        label: labelOf(c),
        itemName: c.itemName ?? null,
        customer: c.customer ?? null,
        qty: remaining,
        unit: c.unit ?? null,
        match: m,
        displayDate: null,
        planDate: null,
        delayWorkdays: 0,
        laneId: null,
        laneName: null,
        laneSort: null,
        lanePos: null,
        completed: false,
        completedAt: null,
        completedByName: null,
        consumed: false,
        pre: c.qtyReady < remaining,
        split: c.split ?? null,
        blockId: b.id,
        blockTitle: b.title,
        placeable: meta?.placeable ?? null,
        reason: null,
        count: null,
        navigable: true,
        seq: seq++,
      })
    }
  }
  return sortHits(out)
}

const KIND_ORDER: Record<SearchHitKind, number> = { day: 0, holding: 1, pool: 2, hidden: 3, closed: 4 }

/** 排序：命中等級 → 種類（排定 → 待排區 → 待排池 → 隱藏 → 結案）→ 日期 → 線 → 線內位置 → 產生順序 */
export function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.match.rank !== b.match.rank) return a.match.rank - b.match.rank
  const ka = KIND_ORDER[a.kind], kb = KIND_ORDER[b.kind]
  if (ka !== kb) return ka - kb
  if (a.kind === 'day') {
    const da = a.displayDate ?? '', db = b.displayDate ?? ''
    if (da !== db) return da < db ? -1 : 1
    const la = a.laneSort ?? 1e9, lb = b.laneSort ?? 1e9
    if (la !== lb) return la - lb
  }
  const pa = a.lanePos?.index ?? 1e9, pb = b.lanePos?.index ?? 1e9
  if (pa !== pb) return pa - pb
  if (a.seq !== b.seq) return a.seq - b.seq
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export function sortHits(hits: readonly SearchHit[]): SearchHit[] {
  return [...hits].sort(compareHits)
}

export function capHits(hits: readonly SearchHit[], max = SEARCH_MAX_HITS): { hits: SearchHit[]; truncated: number } {
  return { hits: hits.slice(0, max), truncated: Math.max(0, hits.length - max) }
}

// ─────────────────────────────────────────────────────────────────────
// 伺服器端：隱藏的擺放、搜尋視窗
// ─────────────────────────────────────────────────────────────────────

/** 一筆擺放（伺服器端 hiddenSummaries 的輸入；displayDate 由呼叫端用 displayDateOf 算好） */
export interface SearchRow {
  id: string
  soLineKey: string
  qty: number
  planDate: YMD | null
  displayDate: YMD | null
  completed: boolean
  lineId: number | null
}

/**
 * 命中但沒出現在組裝結果裡的擺放 → 依（SO 行、原因）合併成一列、不可跳；原因判斷順序：
 * 結案 → 行已不在待排池 → 已完成且日期已過 → 超出視窗 → 已扣完（過去日期）。
 * 超出視窗（beyond）的例外：每張各自一列，日期在 navigableUntil 以內仍可跳（到了那天再由前端依畫面算位置）。
 * closedMatches：命中的結案行（大寫）；沒有任何擺放的也列一行（使用者要知道「它結案了」）。
 */
export function hiddenSummaries(input: {
  rows: readonly SearchRow[]
  visibleIds: ReadonlySet<string>
  poolLineKeys: ReadonlySet<string>
  /** 未復原的結案行（大寫） */
  closedKeys: ReadonlySet<string>
  closedMatches?: readonly string[]
  today: YMD
  windowEnd: YMD
  navigableUntil: YMD
  matchOf: (soLineKey: string) => SearchMatch | null
  infoOf?: (soLineKey: string) => { label: string; itemName: string | null; customer: string | null; unit: string | null } | null
  lineNameOf?: (lineId: number) => string | null
}): SearchHit[] {
  const out: SearchHit[] = []
  const groups = new Map<string, SearchHit>()
  let seq = 0
  const base = (soLineKey: string, match: SearchMatch): Omit<SearchHit, 'kind' | 'key' | 'reason' | 'navigable' | 'count' | 'qty' | 'seq'> => {
    const info = input.infoOf?.(soLineKey) ?? null
    return {
      placementId: null, cardId: null, soLineKey,
      label: info?.label ?? soLineKey, itemName: info?.itemName ?? null, customer: info?.customer ?? null, unit: info?.unit ?? null,
      match, displayDate: null, planDate: null, delayWorkdays: 0,
      laneId: null, laneName: null, laneSort: null, lanePos: null,
      completed: false, completedAt: null, completedByName: null, consumed: false, pre: false, split: null,
      blockId: null, blockTitle: null, placeable: null,
    }
  }
  const seen = new Set<string>()
  for (const r of input.rows) {
    if (seen.has(r.id) || input.visibleIds.has(r.id)) continue
    seen.add(r.id)
    const match = input.matchOf(r.soLineKey)
    if (!match) continue
    const KEY = r.soLineKey.toUpperCase()
    const reason: SearchHiddenReason = input.closedKeys.has(KEY) ? 'closed'
      : !input.poolLineKeys.has(r.soLineKey) ? 'line_gone'
        : r.completed && r.displayDate != null && r.displayDate < input.today ? 'done_past'
          : r.displayDate != null && r.displayDate > input.windowEnd ? 'beyond'
            : r.completed ? 'done_past' : 'consumed_past'
    if (reason === 'beyond') {
      const b = base(r.soLineKey, match)
      out.push({
        ...b, kind: 'day', key: `pl:${r.id}`, placementId: r.id, qty: r.qty,
        displayDate: r.displayDate, planDate: r.planDate, completed: r.completed,
        laneId: r.lineId, laneName: r.lineId != null ? (input.lineNameOf?.(r.lineId) ?? null) : null,
        reason, count: null, navigable: r.displayDate != null && r.displayDate <= input.navigableUntil, seq: seq++,
      })
      continue
    }
    const gk = `x:${KEY}:${reason}`
    const g = groups.get(gk)
    if (g) {
      g.count = (g.count ?? 0) + 1
      g.qty = (g.qty ?? 0) + r.qty
      if (r.planDate && (!g.planDate || r.planDate > g.planDate)) g.planDate = r.planDate
      continue
    }
    groups.set(gk, {
      ...base(r.soLineKey, match), kind: reason === 'closed' ? 'closed' : 'hidden', key: gk,
      qty: r.qty, planDate: r.planDate, completed: reason === 'done_past', reason, count: 1, navigable: false, seq: seq++,
    })
  }
  for (const KEY of input.closedMatches ?? []) {
    const gk = `x:${KEY}:closed`
    if (groups.has(gk)) continue
    const match = input.matchOf(KEY)
    if (!match) continue
    groups.set(gk, { ...base(KEY, match), kind: 'closed', key: gk, qty: null, reason: 'closed', count: 0, navigable: false, seq: seq++ })
  }
  return [...out, ...groups.values()]
}

/** 伺服器搜尋要組裝幾個工作日：到最遠那張卡＋2（排在非工作台日會順延到下一個工作台日）；夾在 [1, 62]（boardWindow 最多 90 個日曆天） */
export function searchWindowWorkdays(today: YMD, maxDate: YMD | null): number {
  if (!maxDate || maxDate <= today) return 1
  return Math.min(62, Math.max(1, workdaysBetween(today, maxDate) + 2))
}

// ─────────────────────────────────────────────────────────────────────
// 前端：合併伺服器與畫面上的結果
// ─────────────────────────────────────────────────────────────────────

/**
 * 正式工作台：伺服器結果（全部日期，可能比畫面舊）＋畫面上的結果（目前日期窗＋待排區＋待排池，含樂觀更新）。
 * - 同一張卡（同 key）以畫面為準：使用者剛拖過、還沒存完的卡，伺服器還是舊日期。
 * - 待排池、待排區不分日期窗，畫面上就是完整的 → 只用畫面的。
 * - 伺服器說在某天、但畫面已載入那天卻沒有這張 → 剛被移走／合併／放回（伺服器結果比畫面舊）：不丟掉，改成不可跳的
 *   「位置剛變更」一列（reason 'moved'）——直接丟掉的話，卡片剛移到畫面外的日期時清單會變成「找不到符合的卡」；
 *   OrderSearch 看到這一列會強制重搜一次（staleRemote），拿到新位置。
 * - 本機結案處理中（D110 記號）的行 → 合併成一列「結案處理中」，不可跳。
 */
export function mergeBoardHits(
  remote: readonly SearchHit[],
  local: readonly SearchHit[],
  ctx: { localPlacementIds: ReadonlySet<string>; localDates: ReadonlySet<YMD> | null; isClosing: (soLineKey: string) => boolean },
): SearchHit[] {
  const out = new Map<string, SearchHit>()
  for (const h of local) out.set(h.key, h)
  for (const h of remote) {
    if (out.has(h.key)) continue
    if (h.kind === 'pool' || h.kind === 'holding') continue
    if (ctx.isClosing(h.soLineKey)) {
      const k = `x:${h.soLineKey.toUpperCase()}:closing`
      const prev = out.get(k)
      if (prev) out.set(k, { ...prev, count: (prev.count ?? 0) + (h.count ?? 1) })
      else out.set(k, { ...h, kind: 'closed', key: k, placementId: null, reason: 'closing', count: h.count ?? 1, navigable: false, lanePos: null })
      continue
    }
    if (h.placementId && ctx.localPlacementIds.has(h.placementId)) continue
    if (h.kind === 'day' && h.displayDate && ctx.localDates?.has(h.displayDate)) {
      out.set(h.key, { ...h, kind: 'hidden', reason: 'moved', navigable: false, lanePos: null, count: null })
      continue
    }
    out.set(h.key, h)
  }
  return sortHits([...out.values()])
}

/** 合併結果裡有「伺服器結果比畫面舊」的列（mergeBoardHits 標成 moved）→ 該重搜伺服器 */
export function hasStaleRemote(hits: readonly SearchHit[]): boolean {
  return hits.some((h) => h.reason === 'moved')
}

// ─────────────────────────────────────────────────────────────────────
// 多筆切換（Enter＝下一筆、Shift+Enter＝上一筆）
// ─────────────────────────────────────────────────────────────────────

/** 可跳的卡裡，從 fromKey 往 dir 走一步（循環）；fromKey 不在清單＝第一筆（往回＝最後一筆） */
export function stepNavigable(hits: readonly SearchHit[], fromKey: string | null, dir: 1 | -1): string | null {
  const nav = hits.filter((h) => h.navigable)
  if (nav.length === 0) return null
  const i = fromKey == null ? -1 : nav.findIndex((h) => h.key === fromKey)
  if (i < 0) return dir === 1 ? nav[0].key : nav[nav.length - 1].key
  return nav[(i + dir + nav.length) % nav.length].key
}

/**
 * 按 Enter 要跳哪一筆：使用者用 ↑↓ 選了一筆「還沒跳過」的可跳卡 → 跳那筆；否則從上次跳的那筆往下（第一次＝第一筆）。
 * back（Shift+Enter／▲）一律往上一筆。
 */
export function enterTargetKey(hits: readonly SearchHit[], activeKey: string | null, jumpedKey: string | null, back = false): string | null {
  if (!back && activeKey != null && activeKey !== jumpedKey && hits.some((h) => h.key === activeKey && h.navigable)) return activeKey
  return stepNavigable(hits, jumpedKey, back ? -1 : 1)
}

/** 目前跳到第幾筆（可跳的卡裡，1 起算）；還沒跳＝0 */
export function navPosition(hits: readonly SearchHit[], jumpedKey: string | null): { pos: number; total: number } {
  const nav = hits.filter((h) => h.navigable)
  const i = jumpedKey == null ? -1 : nav.findIndex((h) => h.key === jumpedKey)
  return { pos: i + 1, total: nav.length }
}

// ─────────────────────────────────────────────────────────────────────
// 跳轉目標推導（結果 → 要切到哪個檢視／日期、捲到哪個元素、要先揭露什麼）
// ─────────────────────────────────────────────────────────────────────

/** 卡片 DOM 上的定位屬性：排定卡（LaneCard／PlacementCard 根元素）、待排池卡（SimplePoolCard 根元素） */
export interface JumpTarget {
  attr: 'data-placement-id' | 'data-pool-card-id'
  id: string
}

export type JumpPlan =
  | { ok: false; reason: string }
  | {
      ok: true
      target: JumpTarget
      place: 'day' | 'holding' | 'pool'
      /** 目標日（排定卡） */
      date: YMD | null
      /** 正式工作台：要換的起點（null＝今天）；不必換＝null */
      navigate: { anchor: YMD | null } | null
      /** 模擬區：日檢視要切到的日期；不必切＝null */
      pickDate: YMD | null
      /** 要先打開左欄（待排池收起時） */
      revealPool: boolean
      /** 待排池卡：左欄要展開區塊／清掉過濾／多畫幾頁 */
      poolCardId: string | null
      /** 已完成卡而「隱藏已完成」開著：要暫時顯示已完成 */
      showDone: boolean
    }

/** 不可跳的原因（清單、toast 共用） */
export function hiddenReasonText(hit: Pick<SearchHit, 'reason' | 'planDate' | 'displayDate'>): string {
  switch (hit.reason) {
    case 'closed': return '已結案（可在結案池復原）'
    case 'closing': return '結案處理中（已從畫面移除）'
    case 'line_gone': return '訂單已完成或結案，不在待排池（卡片隱藏、資料保留）'
    case 'done_past': return `已完成${hit.planDate ? `（${shortDate(hit.planDate)}）` : ''}，過去日期不在工作台上`
    case 'beyond': return `排在 ${hit.displayDate ? shortDate(hit.displayDate) : '很久以後'}，超出工作台可顯示的範圍`
    case 'consumed_past': return '過去日期的卡已由待排池扣完，不顯示'
    case 'moved': return `原排 ${hit.displayDate ? shortDate(hit.displayDate) : '—'}，剛被移動、合併或放回（重新搜尋中；存檔完成後會更新）`
    default: return '目前畫面無法顯示這張卡'
  }
}

/**
 * 正式工作台：結果 → 跳轉計畫。local＝依 placementId 在畫面資料找到的同一張卡（以它為準：樂觀更新比伺服器新）。
 * 檢視模式保留使用者目前的（日／週／兩週），只換起點；目標日已在畫面上就不換（D98：換起點會放行等合併的批，能不換就不換）。
 */
export function planBoardJump(input: {
  hit: SearchHit
  local: { displayDate: YMD | null; completed: boolean } | null
  view: 'day' | 'week' | 'twoWeek'
  rollTarget: YMD
  windowMatches: boolean
  loadedDates: readonly YMD[]
  /** 日檢視目前顯示哪天 */
  shownDay: YMD | null
  hideDone: boolean
}): JumpPlan {
  const { hit } = input
  if (!hit.navigable) return { ok: false, reason: `${hit.label}：${hiddenReasonText(hit)}` }
  if (hit.kind === 'pool') {
    if (!hit.cardId) return { ok: false, reason: `${hit.label}：找不到卡片` }
    return { ok: true, target: { attr: 'data-pool-card-id', id: hit.cardId }, place: 'pool', date: null, navigate: null, pickDate: null, revealPool: true, poolCardId: hit.cardId, showDone: false }
  }
  if (!hit.placementId) return { ok: false, reason: `${hit.label}：找不到卡片` }
  const target: JumpTarget = { attr: 'data-placement-id', id: hit.placementId }
  const date = input.local ? input.local.displayDate : hit.kind === 'holding' ? null : hit.displayDate
  const completed = input.local ? input.local.completed : hit.completed
  const showDone = completed && input.hideDone
  if (date == null) {
    return { ok: true, target, place: 'holding', date: null, navigate: null, pickDate: null, revealPool: true, poolCardId: null, showDone }
  }
  const inView = input.windowMatches && input.loadedDates.includes(date) && (input.view !== 'day' || input.shownDay === date)
  return {
    ok: true, target, place: 'day', date,
    navigate: inView ? null : { anchor: date <= input.rollTarget ? null : date },
    pickDate: null, revealPool: false, poolCardId: null, showDone,
  }
}

/**
 * 跳轉前提（cardJump 的 gate）：ready＝畫面已是要的那一段，可以找卡；wait＝新資料還沒套用（D98 佇列沒清空、還在載入）；
 * gone＝使用者已換到別段（放棄，不報錯）；missing＝資料已套用、裡面卻沒有這張卡（不必等 15 秒）
 */
export type JumpGateState = 'ready' | 'wait' | 'gone' | 'missing'

type WindowReq = { from: YMD | null; workdays: number }

/**
 * 正式工作台跳轉的 gate 判斷（純函式；BoardLayout 在計時器／DOM 變動回呼裡用最新的 ref 呼叫）。
 * want＝這次跳轉要的那一段（換日期＝剛 go() 的那段；不換＝當時的那段；待排區卡＝null：不看日期）；
 * nav＝最後一次要求的那一段（使用者自己按 ◀ ▶／換檢視就會變）；data＝目前畫面上的資料（commit 後才更新）。
 * 「已套用」的比法和 BoardLayout 的 windowMatches 相同：起點 null 或早於今天＝今天。
 * 為什麼要等「已套用」：週檢視的舊視窗常常也含目標日，舊 DOM 上就找得到這張卡；在舊畫面上捲，新資料套用後欄位重排，卡片會落到畫面外。
 */
export function boardJumpGateState(input: {
  want: WindowReq | null
  nav: WindowReq
  data: {
    today: YMD
    window: { from: YMD; workdays: number }
    days: readonly { cards: readonly { placementId: string }[] }[]
    holding: readonly { placementId: string }[]
  } | null
  placementId: string
}): JumpGateState {
  const { want, nav, data } = input
  if (want && (nav.from !== want.from || nav.workdays !== want.workdays)) return 'gone'
  if (!data) return 'wait'
  if (want) {
    const from = want.from == null || want.from < data.today ? data.today : want.from
    if (data.window.workdays !== want.workdays || data.window.from !== from) return 'wait'
  }
  const pid = input.placementId
  const has = data.holding.some((c) => c.placementId === pid) || data.days.some((d) => d.cards.some((c) => c.placementId === pid))
  return has ? 'ready' : 'missing'
}

/** AI 模擬區：所有模擬天數都在前端；日檢視切日期、全部天數檢視直接捲。待排區在預設關閉的 <details> 裡（由跳轉程序展開） */
export function planSimJump(input: { hit: SearchHit; view: 'day' | 'all'; shownDate: YMD | null; dates: readonly YMD[] }): JumpPlan {
  const { hit } = input
  if (!hit.navigable) return { ok: false, reason: `${hit.label}：${hiddenReasonText(hit)}` }
  if (hit.kind === 'pool') {
    if (!hit.cardId) return { ok: false, reason: `${hit.label}：找不到卡片` }
    return { ok: true, target: { attr: 'data-pool-card-id', id: hit.cardId }, place: 'pool', date: null, navigate: null, pickDate: null, revealPool: true, poolCardId: hit.cardId, showDone: false }
  }
  if (!hit.placementId) return { ok: false, reason: `${hit.label}：找不到卡片` }
  const target: JumpTarget = { attr: 'data-placement-id', id: hit.placementId }
  if (hit.kind === 'holding' || hit.displayDate == null) {
    return { ok: true, target, place: 'holding', date: null, navigate: null, pickDate: null, revealPool: true, poolCardId: null, showDone: false }
  }
  const date = hit.displayDate
  if (!input.dates.includes(date)) return { ok: false, reason: `${hit.label}：${shortDate(date)} 不在模擬範圍` }
  return {
    ok: true, target, place: 'day', date, navigate: null,
    pickDate: input.view === 'day' && input.shownDate !== date ? date : null,
    revealPool: false, poolCardId: null, showDone: false,
  }
}

// ─────────────────────────────────────────────────────────────────────
// 顯示文字
// ─────────────────────────────────────────────────────────────────────

/** 位置：「10/2（四）・A 線 第 3／8 張」「待排區 第 2／5 張」「待排池・常平已入庫・剩 120」；不可跳的寫原因 */
export function hitPlaceText(hit: SearchHit, hideCompleted: boolean, fmtQty: (n: number) => string = String): string {
  if (hit.kind === 'pool') return `待排池${hit.blockTitle ? `・${hit.blockTitle}` : ''}・剩 ${hit.qty != null ? fmtQty(hit.qty) : '—'}`
  if (hit.kind === 'hidden' || hit.kind === 'closed') {
    return `${hiddenReasonText(hit)}${hit.count && hit.count > 1 ? `（${hit.count} 張）` : ''}`
  }
  const pos = hit.lanePos
  const nth = pos
    ? hideCompleted
      ? hit.completed ? '（已完成，目前隱藏中）' : ` 第 ${pos.openIndex}／${pos.openTotal} 張`
      : ` 第 ${pos.index}／${pos.total} 張`
    : ''
  if (hit.kind === 'holding') return `待排區${nth}`
  const date = hit.displayDate ? dayLabel(hit.displayDate) : '—'
  if (hit.reason === 'beyond') return `${date}${hit.laneName ? `・${hit.laneName}` : ''}${hit.navigable ? '（跳過去後定位）' : `・${hiddenReasonText(hit)}`}`
  return `${date}・${hit.laneName ?? '（未分線）'}${nth}`
}

/** 附註小標：延誤、預排、已完成、已扣完、拆卡、命中欄位 */
export function hitNotes(hit: SearchHit): string[] {
  const n: string[] = []
  if (hit.delayWorkdays > 0 && hit.planDate && hit.displayDate) n.push(`延誤 ${hit.delayWorkdays} 天（原 ${shortDate(hit.planDate)}）→ 顯示 ${shortDate(hit.displayDate)}`)
  if (hit.completed && hit.kind !== 'hidden') n.push(`✓ 已完成${hit.completedByName ? `（${hit.completedByName}）` : ''}`)
  if (hit.consumed) n.push('已扣完')
  if (hit.pre) n.push('預排')
  if (hit.split) n.push(`拆 ${hit.split.index}/${hit.split.total}`)
  if (hit.match.field === 'mo') n.push(`製令 ${hit.match.text}`)
  if (hit.match.field === 'src') n.push(`來源單 ${hit.match.text}`)
  if (hit.match.rank === 3) n.push('前綴不同')
  return n
}

/** 報讀器／狀態列：「已跳到 SO260917005-1：10/2（四）・A 線 第 3／8 張（2/5）」 */
export function jumpAnnounce(hit: SearchHit, hideCompleted: boolean, pos: { pos: number; total: number }): string {
  return `已跳到 ${hit.label}：${hitPlaceText(hit, hideCompleted)}${pos.total > 1 ? `（${pos.pos}/${pos.total}）` : ''}`
}
