// 包裝專區 P1 — 擺放操作的模擬、驗證與反向操作（純函式，規格 §3.8；D7／D22／D24／D33／D50）
//
// applyOps 逐一模擬（後一個操作看得到前一個的結果），任何一步失敗整批不寫。
// 前端用同一個函式做樂觀更新（拖曳手感即時），伺服器再用它做權威驗證，兩邊規則不會分岔。
// 成功時回傳 inserts／updates／deletes（伺服器照「先減後增」寫入）與 inverse（前端推進 Undo 堆疊）。
//
// 不 import supabase、不讀時鐘（today／nowIso 由參數傳入）；相對路徑 import、不用 enum。

import {
  MAX_OPS_PER_REQUEST,
  type ApplyErrorCode,
  type LineSupply,
  type Placement,
  type PlacementOp,
  type PlacementSnapshotRow,
  type YMD,
} from './scheduleTypes'
import type { PackagingCard } from './types'
import { displayDateOf, isBoardDay, isValidYmd, rollTarget, shortDate } from './scheduleCalendar'
import { allocateLine, isPlaceableBlock, r3 } from './scheduleAllocate'
import { toSnapshotRow } from './scheduleSnapshot'

export interface OpsState {
  /** 至少包含 ops 觸及的 SO 行的「全部」擺放（含已完成），守恆檢查才算得準 */
  byId: ReadonlyMap<string, Placement>
}

export interface OpsContext {
  today: YMD
  nowIso: string
  actor: { email: string; name: string | null }
  openSats: ReadonlySet<YMD>
  /** 由待排池算出的該行可排供給；null＝行不在池內 */
  supplyOf(soLineKey: string): LineSupply | null
  /** cardId → 待排池卡（驗 originCardId 用） */
  cards: ReadonlyMap<string, PackagingCard>
  /** today + 120 日曆天 */
  maxDate: YMD
}

export type ApplyOk = {
  ok: true
  next: Map<string, Placement>
  inserts: Placement[]
  updates: { before: Placement; after: Placement }[]
  deletes: Placement[]
  inverse: PlacementOp[]
}
export type ApplyFail = { ok: false; code: ApplyErrorCode; opIndex: number; message: string; current?: Placement | null }
export type ApplyResult = ApplyOk | ApplyFail

/** 一次 split 最多拆出幾張新卡（原卡＋9＝10 張，對應拆卡對話框上限） */
export const MAX_SPLIT_PARTS = 9
export const MAX_MERGE_SOURCES = 20
/**
 * 一個 SO 行最多幾張未完成子卡（擋「拆到 0.001、一直重複送」把表灌爆；30＝工作台最長 30 個工作日各一張）。
 * 已經超過的行（歷史資料）只擋「再變多」，不擋挪動／合併。
 */
export const MAX_OPEN_PER_LINE = 30
/** originCardId 長度上限（實測待排池 cardId 最長 16 字；同 migration 的 check） */
export const ORIGIN_CARD_ID_MAX = 64
/** 允許「移回過去日期」的下限（只給 Undo 用，見 move 說明） */
const PAST_MOVE_LIMIT_DAYS = 400

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EPS = 1e-9

export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)
/** 數量：> 0、最多 3 位小數、不超過 numeric(14,3) */
export const isQty = (q: unknown): q is number =>
  typeof q === 'number' && Number.isFinite(q) && q > 0 && q < 1e11 && Math.abs(Math.round(q * 1000) - q * 1000) < 1e-6

const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1
const isDateOrNull = (d: unknown): d is YMD | null => d === null || isValidYmd(d)
/**
 * so_line_key 白名單：`${SO}-${項次}`（D6，實測 306 行全是「英數-數字」），另容許 classify.ts 缺項次時的
 * `${SO}-?${單號}` 後備格式。擋掉 , ( ) " 空白等 PostgREST 保留字元——loadPlacementsByLines 的 in() 只加外層引號、
 * 不轉義字串內的引號，不擋的話客戶端可改寫 in 清單內容。
 */
const LINE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9?\-_./]{2,79}$/
export const isLineKey = (s: unknown): s is string => typeof s === 'string' && LINE_KEY_RE.test(s)
const isOriginCardId = (s: unknown): boolean => s == null || (typeof s === 'string' && s.length <= ORIGIN_CARD_ID_MAX)

/**
 * 請求 JSON → PlacementOp[] 的形狀檢查（不看資料庫狀態；語意驗證在 applyOps）。
 * allowed：這支 API 收哪些 op（/cards/complete 只收 complete／uncomplete／place）。
 */
export function parseOps(
  raw: unknown,
  allowed?: ReadonlySet<PlacementOp['op']>,
): { ok: true; ops: PlacementOp[] } | { ok: false; code: 'bad_request' | 'too_many_ops'; opIndex?: number; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, code: 'bad_request', message: 'ops 必須是非空陣列' }
  if (raw.length > MAX_OPS_PER_REQUEST) return { ok: false, code: 'too_many_ops', message: `一次最多 ${MAX_OPS_PER_REQUEST} 個操作` }
  const out: PlacementOp[] = []
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i] as Record<string, unknown> | null
    const bad = (m: string) => ({ ok: false as const, code: 'bad_request' as const, opIndex: i, message: `第 ${i + 1} 個操作：${m}` })
    if (!o || typeof o !== 'object' || typeof o.op !== 'string') return bad('格式錯誤')
    const op = o.op as PlacementOp['op']
    if (allowed && !allowed.has(op)) return bad(`這支 API 不接受 ${String(o.op)}`)
    switch (op) {
      case 'place':
        if (!isUuid(o.id) || !isLineKey(o.soLineKey) || typeof o.qty !== 'number' || !isDateOrNull(o.toDate ?? null)) return bad('place 欄位不完整')
        if (!isOriginCardId(o.originCardId)) return bad(`originCardId 須為 ${ORIGIN_CARD_ID_MAX} 字以內的字串`)
        out.push({ op, id: o.id, soLineKey: o.soLineKey, qty: o.qty, toDate: (o.toDate as YMD | null | undefined) ?? null, originCardId: (o.originCardId as string | null | undefined) ?? null })
        break
      case 'move':
        if (!isUuid(o.id) || !isVersion(o.version) || !isDateOrNull(o.toDate ?? null)) return bad('move 欄位不完整')
        out.push({ op, id: o.id, version: o.version, toDate: (o.toDate as YMD | null | undefined) ?? null })
        break
      case 'split': {
        if (!isUuid(o.id) || !isVersion(o.version) || typeof o.keepQty !== 'number' || !Array.isArray(o.parts)) return bad('split 欄位不完整')
        const parts: { id: string; qty: number; toDate?: YMD | null }[] = []
        for (const p of o.parts as unknown[]) {
          const q = p as Record<string, unknown> | null
          if (!q || !isUuid(q.id) || typeof q.qty !== 'number') return bad('split.parts 格式錯誤')
          if (q.toDate !== undefined && !isDateOrNull(q.toDate)) return bad('split.parts.toDate 格式錯誤')
          parts.push(q.toDate === undefined ? { id: q.id, qty: q.qty } : { id: q.id, qty: q.qty, toDate: q.toDate as YMD | null })
        }
        out.push({ op, id: o.id, version: o.version, keepQty: o.keepQty, parts })
        break
      }
      case 'merge': {
        if (!isUuid(o.targetId) || !isVersion(o.targetVersion) || !Array.isArray(o.sources)) return bad('merge 欄位不完整')
        const sources: { id: string; version: number }[] = []
        for (const s of o.sources as unknown[]) {
          const q = s as Record<string, unknown> | null
          if (!q || !isUuid(q.id) || !isVersion(q.version)) return bad('merge.sources 格式錯誤')
          sources.push({ id: q.id, version: q.version })
        }
        out.push({ op, targetId: o.targetId, targetVersion: o.targetVersion, sources })
        break
      }
      case 'unplace':
      case 'complete':
        if (!isUuid(o.id) || !isVersion(o.version)) return bad(`${op} 欄位不完整`)
        out.push({ op, id: o.id, version: o.version })
        break
      case 'setQty':
        if (!isUuid(o.id) || !isVersion(o.version) || typeof o.qty !== 'number') return bad('setQty 欄位不完整')
        out.push({ op, id: o.id, version: o.version, qty: o.qty })
        break
      case 'restore': {
        const r = o.row as Record<string, unknown> | null
        if (!r || !isUuid(r.id) || !isLineKey(r.soLineKey) || typeof r.qty !== 'number') return bad('restore.row 欄位不完整')
        if (!isDateOrNull(r.planDate ?? null) || !isDateOrNull(r.originalDate ?? null)) return bad('restore.row 日期格式錯誤')
        if (r.source !== 'manual' && r.source !== 'ai') return bad('restore.row.source 錯誤')
        if (!isOriginCardId(r.originCardId)) return bad(`restore.row.originCardId 須為 ${ORIGIN_CARD_ID_MAX} 字以內的字串`)
        out.push({
          op, row: {
            id: r.id, soLineKey: r.soLineKey, qty: r.qty,
            planDate: (r.planDate as YMD | null | undefined) ?? null,
            originalDate: (r.originalDate as YMD | null | undefined) ?? null,
            source: r.source, originCardId: (r.originCardId as string | null | undefined) ?? null,
          },
        })
        break
      }
      case 'uncomplete': {
        if (!isUuid(o.id) || !isVersion(o.version)) return bad('uncomplete 欄位不完整')
        if (o.prevPlanDate !== undefined && !isDateOrNull(o.prevPlanDate)) return bad('prevPlanDate 格式錯誤')
        if (o.prevQty !== undefined && typeof o.prevQty !== 'number') return bad('prevQty 須為數字')
        const u: Extract<PlacementOp, { op: 'uncomplete' }> = { op, id: o.id, version: o.version }
        if (o.prevPlanDate !== undefined) u.prevPlanDate = o.prevPlanDate as YMD | null
        if (o.prevQty !== undefined) u.prevQty = o.prevQty as number
        out.push(u)
        break
      }
      default:
        return bad(`不認得的操作 ${String(o.op)}`)
    }
  }
  return { ok: true, ops: out }
}

/** 本批 ops 直接或間接（以 id）觸及的 SO 行／id，API 據此讀「這些行的全部擺放」 */
export function touchedKeys(ops: readonly PlacementOp[]): { lineKeys: Set<string>; ids: Set<string> } {
  const lineKeys = new Set<string>()
  const ids = new Set<string>()
  for (const o of ops) {
    switch (o.op) {
      case 'place': lineKeys.add(o.soLineKey); break
      case 'restore': lineKeys.add(o.row.soLineKey); break
      case 'merge': ids.add(o.targetId); for (const s of o.sources) ids.add(s.id); break
      default: ids.add(o.id)
    }
  }
  return { lineKeys, ids }
}

/**
 * 反向操作的版本號校正：inverse 是「依序送出」的，每一步都會讓 version +1。
 * 各 op 的反向操作是對「該 op 剛做完時」的狀態寫的，版本號要依實際送出順序重算，否則第二步就會 version_conflict。
 */
export function rebaseVersions(ops: readonly PlacementOp[], byId: ReadonlyMap<string, Placement>): PlacementOp[] {
  const ver = new Map<string, number>()
  for (const [id, p] of byId) ver.set(id, p.version)
  const cur = (id: string, fallback: number) => ver.get(id) ?? fallback
  return ops.map((o): PlacementOp => {
    switch (o.op) {
      case 'place': ver.set(o.id, 1); return o
      case 'restore': ver.set(o.row.id, 1); return o
      case 'unplace': { const v = cur(o.id, o.version); ver.delete(o.id); return { ...o, version: v } }
      case 'merge': {
        const tv = cur(o.targetId, o.targetVersion)
        ver.set(o.targetId, tv + 1)
        const sources = o.sources.map((s) => { const v = cur(s.id, s.version); ver.delete(s.id); return { id: s.id, version: v } })
        return { ...o, targetVersion: tv, sources }
      }
      case 'split': {
        const v = cur(o.id, o.version)
        ver.set(o.id, v + 1)
        for (const p of o.parts) ver.set(p.id, 1)
        return { ...o, version: v }
      }
      default: { // move / setQty / complete / uncomplete
        const v = cur(o.id, o.version)
        ver.set(o.id, v + 1)
        return { ...o, version: v }
      }
    }
  })
}

/**
 * 規格 §3.8 applyOps。
 *
 * toDate 規則（place／move／split part）：null（待排區）一律允許；否則 today ≤ toDate ≤ maxDate、且為工作台日期（D48）；
 *   D22：以操作後狀態重跑 allocateLine，本卡 readiness＝pre 且顯示日 < 預估可包日 → before_est_ready（pre_unknown 允許）。
 * 例外（本實作的解讀，規格 §9.2 第 8、9 條，待 Snow 確認）：
 *   - move／restore／uncomplete 的 prevPlanDate 允許「過去日期」（today − 400 天內）：給 Undo 把延誤卡移回原排定日用；
 *     畫面沒有過去欄位。過去日期讀取時一樣依 D50 順延到今天並標延誤，不會出現在過去欄。
 *     伺服器分不出「真的是 Undo」，持鎖主管手動送也會被接受（只影響「延誤 N 天」顯示，不影響數量）。
 *   - split 的 part 日期省略或等於原卡日期＝沿用原卡（延誤卡拆開後兩張都還是延誤），不驗日期。
 * 守恆（D7）：會讓該行 Σ未完成 qty 增加的操作（place、setQty 增加、restore、uncomplete），
 *   行必須還在待排池（否則 line_not_in_pool：行已離開待排池就不能 Undo／加量，避免寫出讀取時會被略過的幽靈列），
 *   且操作後 Σ ≤ max(E, 本批開始時的 Σ)（E＝S−U）。取 max 是為了讓「同批先放回再排出」與 Undo 在已被修剪的行也能運作，
 *   但絕不會讓已超排的行更超排。move／split／merge 不改總量，不檢查。
 *   uncomplete 帶 prevQty（Undo 勾完成被修剪的卡）超過上限時，只還原到上限（見 uncomplete 分支）。
 * 張數上限：place／split／restore／uncomplete 後，該行未完成張數 ≤ max(MAX_OPEN_PER_LINE, 本批開始時的張數)。
 */
export function applyOps(state: OpsState, ops: readonly PlacementOp[], ctx: OpsContext): ApplyResult {
  const orig = state.byId
  const next = new Map<string, Placement>(orig)
  const invGroups: PlacementOp[][] = []
  const { today, openSats } = ctx

  const fail = (code: ApplyErrorCode, opIndex: number, message: string, current?: Placement | null): ApplyFail =>
    current === undefined ? { ok: false, code, opIndex, message } : { ok: false, code, opIndex, message, current }

  const lineRows = (key: string, map: ReadonlyMap<string, Placement>) => {
    const out: Placement[] = []
    for (const p of map.values()) if (p.soLineKey === key) out.push(p)
    return out
  }
  const openSum = (key: string, map: ReadonlyMap<string, Placement>) =>
    r3(lineRows(key, map).reduce((s, p) => s + (p.completed ? 0 : p.qty), 0))
  const alloc = (key: string) => {
    const supply = ctx.supplyOf(key)
    return supply ? allocateLine({ supply, placements: lineRows(key, next), today, openSats }) : null
  }
  const stamp = (p: Placement, patch: Partial<Placement>): Placement => ({
    ...p, ...patch,
    version: p.version + 1, updatedAt: ctx.nowIso, updatedBy: ctx.actor.email, updatedByName: ctx.actor.name,
  })
  const fresh = (r: PlacementSnapshotRow): Placement => ({
    id: r.id, soLineKey: r.soLineKey, qty: r.qty, planDate: r.planDate, originalDate: r.originalDate,
    source: r.source, originCardId: r.originCardId, completed: null, version: 1,
    createdAt: ctx.nowIso, createdBy: ctx.actor.email, createdByName: ctx.actor.name,
    updatedAt: ctx.nowIso, updatedBy: ctx.actor.email, updatedByName: ctx.actor.name,
  })
  const pastLimit = (() => {
    const t = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) - PAST_MOVE_LIMIT_DAYS * 86_400_000
    return new Date(t).toISOString().slice(0, 10)
  })()

  /** 取列並驗版本；失敗附目前的列（前端據以更新） */
  const getRow = (i: number, id: string, version: number): Placement | ApplyFail => {
    const row = next.get(id)
    if (!row) return fail('not_found', i, '這張卡已不存在（可能已被移除或還原）', null)
    if (row.version !== version) return fail('version_conflict', i, '這張卡已被其他操作更新，請重新整理', row)
    return row
  }
  const isFail = (x: unknown): x is ApplyFail => !!x && typeof x === 'object' && (x as ApplyFail).ok === false

  const checkDate = (i: number, d: YMD | null, allowPast: boolean): ApplyFail | null => {
    if (d == null) return null
    if (!isValidYmd(d)) return fail('date_invalid', i, `日期格式錯誤：${String(d)}`)
    if (d > ctx.maxDate) return fail('date_invalid', i, `最遠只能排到 ${shortDate(ctx.maxDate)}`)
    if (d < today) {
      if (allowPast && d >= pastLimit) return null
      return fail('date_past', i, `${shortDate(d)} 已經過去，不能排`)
    }
    // D48：只能排在台灣工作日或已開加班的週六
    if (!isBoardDay(d, openSats)) return fail('date_not_board_day', i, `${shortDate(d)} 不是工作日（週六需先開加班）`)
    return null
  }

  /** D22：被操作的那張卡若是預排（pre），顯示日不可早於預估可包日 */
  const checkPre = (i: number, id: string): ApplyFail | null => {
    const p = next.get(id)
    if (!p || p.planDate == null || p.completed) return null
    const a = alloc(p.soLineKey)
    if (!a) return null
    const pa = a.placements.find((x) => x.placementId === id)
    const disp = displayDateOf(p, today, openSats).date
    if (pa && pa.readiness === 'pre' && pa.preReadyDate && disp && disp < pa.preReadyDate) {
      return fail('before_est_ready', i, `${shortDate(disp)} 早於預估可包日 ${shortDate(pa.preReadyDate)}（D22：預排卡只能排在預估可包日當天或之後）`)
    }
    return null
  }

  /** D7 守恆：行必須在池內；Σ未完成 ≤ max(E, 本批開始時的 Σ) */
  const checkConserve = (i: number, key: string): ApplyFail | null => {
    const a = alloc(key)
    if (!a) return fail('line_not_in_pool', i, '這個品項已不在待排池（可能已完成或結案），無法復原或增加數量')
    const total = openSum(key, next)
    const limit = Math.max(a.effectiveSupply, openSum(key, orig))
    if (total > limit + EPS) {
      const before = r3(total - limit)
      return fail('qty_exceeds_remaining', i, `超過待排池可排量 ${before}（該行可排 ${a.effectiveSupply}，已排 ${total}）`)
    }
    return null
  }

  const openCount = (key: string, map: ReadonlyMap<string, Placement>) => {
    let n = 0
    for (const p of map.values()) if (p.soLineKey === key && !p.completed) n++
    return n
  }
  /** 一行未完成張數 ≤ max(MAX_OPEN_PER_LINE, 本批開始時的張數) */
  const checkLineCount = (i: number, key: string): ApplyFail | null => {
    const n = openCount(key, next)
    if (n > Math.max(MAX_OPEN_PER_LINE, openCount(key, orig))) {
      return fail('bad_request', i, `同一個品項最多 ${MAX_OPEN_PER_LINE} 張未完成的子卡，請先合併再拆`)
    }
    return null
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    switch (op.op) {
      case 'place': {
        if (!isUuid(op.id)) return fail('bad_request', i, 'id 必須是 uuid')
        if (next.has(op.id) || orig.has(op.id)) return fail('id_exists', i, '卡片 id 重複，請重新整理')
        if (!isQty(op.qty)) return fail('qty_invalid', i, '數量須大於 0、最多 3 位小數')
        const supply = ctx.supplyOf(op.soLineKey)
        if (!supply) return fail('line_not_in_pool', i, '這個品項已不在待排池（可能已完成或結案）')
        if (op.originCardId) {
          // cardId 不穩定（到貨後 #1 → #2），找不到時不擋，只以行為單位驗證（規格 §2.1）
          const card = ctx.cards.get(op.originCardId)
          if (card && card.soLineKey !== op.soLineKey) return fail('bad_request', i, 'originCardId 與 soLineKey 不符')
          if (card && !isPlaceableBlock(card.block)) return fail('not_placeable', i, `「${card.statusLabel}」的卡不能排（D22：未寄出且緊張／出貨待確認只提醒）`)
        }
        if (supply.total <= EPS && supply.nonPlaceableQty > 0) return fail('not_placeable', i, '這個品項目前只剩未寄出／出貨待確認的量，不能排（D22）')
        const dErr = checkDate(i, op.toDate, false)
        if (dErr) return dErr
        next.set(op.id, fresh({
          id: op.id, soLineKey: op.soLineKey, qty: r3(op.qty), planDate: op.toDate, originalDate: op.toDate,
          source: 'manual', originCardId: op.originCardId ?? null,
        }))
        const cErr = checkConserve(i, op.soLineKey) ?? checkLineCount(i, op.soLineKey) ?? checkPre(i, op.id)
        if (cErr) return cErr
        invGroups.push([{ op: 'unplace', id: op.id, version: 1 }])
        break
      }

      case 'move': {
        const row = getRow(i, op.id, op.version)
        if (isFail(row)) return row
        if (row.completed) return fail('completed_locked', i, '已完成的卡不能移動，請先取消完成', row)
        const dErr = checkDate(i, op.toDate, true)
        if (dErr) return dErr
        // D50：主管手動挪過的卡以主管安排為準 → source 變 manual；original_date 只在第一次排上日期時補
        next.set(op.id, stamp(row, {
          planDate: op.toDate,
          originalDate: row.originalDate ?? op.toDate,
          source: 'manual',
        }))
        const pErr = checkPre(i, op.id)
        if (pErr) return pErr
        invGroups.push([{ op: 'move', id: op.id, version: row.version + 1, toDate: row.planDate }])
        break
      }

      case 'split': {
        const row = getRow(i, op.id, op.version)
        if (isFail(row)) return row
        if (row.completed) return fail('completed_locked', i, '已完成的卡不能拆，請先取消完成', row)
        if (!isQty(op.keepQty)) return fail('qty_invalid', i, '原卡保留數量須大於 0、最多 3 位小數')
        if (!Array.isArray(op.parts) || op.parts.length < 1 || op.parts.length > MAX_SPLIT_PARTS) {
          return fail('bad_request', i, `一次最多拆出 ${MAX_SPLIT_PARTS} 張`)
        }
        const seen = new Set<string>([op.id])
        for (const p of op.parts) {
          if (!isUuid(p.id)) return fail('bad_request', i, '子卡 id 必須是 uuid')
          if (seen.has(p.id)) return fail('bad_request', i, '子卡 id 重複')
          seen.add(p.id)
          if (next.has(p.id) || orig.has(p.id)) return fail('id_exists', i, '子卡 id 重複，請重新整理')
          if (!isQty(p.qty)) return fail('qty_invalid', i, '子卡數量須大於 0、最多 3 位小數')
        }
        // D7：加總必須等於原數量
        const sum = r3(op.keepQty + op.parts.reduce((s, p) => s + p.qty, 0))
        if (Math.abs(sum - row.qty) > EPS) return fail('split_sum_mismatch', i, `拆分合計 ${sum} 不等於原數量 ${row.qty}`)
        next.set(op.id, stamp(row, { qty: r3(op.keepQty) }))
        for (const p of op.parts) {
          const d = p.toDate === undefined ? row.planDate : p.toDate
          if (d !== row.planDate) {
            const dErr = checkDate(i, d, false)
            if (dErr) return dErr
          }
          next.set(p.id, fresh({
            id: p.id, soLineKey: row.soLineKey, qty: r3(p.qty), planDate: d,
            originalDate: row.originalDate ?? d, source: row.source, originCardId: row.originCardId,
          }))
        }
        const nErr = checkLineCount(i, row.soLineKey)
        if (nErr) return nErr
        for (const p of op.parts) {
          const d = p.toDate === undefined ? row.planDate : p.toDate
          if (d !== row.planDate) { const pErr = checkPre(i, p.id); if (pErr) return pErr }
        }
        invGroups.push([{ op: 'merge', targetId: op.id, targetVersion: row.version + 1, sources: op.parts.map((p) => ({ id: p.id, version: 1 })) }])
        break
      }

      case 'merge': {
        const target = getRow(i, op.targetId, op.targetVersion)
        if (isFail(target)) return target
        if (target.completed) return fail('completed_locked', i, '已完成的卡不能合併，請先取消完成', target)
        if (!Array.isArray(op.sources) || op.sources.length < 1 || op.sources.length > MAX_MERGE_SOURCES) {
          return fail('bad_request', i, `一次合併 1～${MAX_MERGE_SOURCES} 張`)
        }
        const seen = new Set<string>([op.targetId])
        const srcRows: Placement[] = []
        for (const s of op.sources) {
          if (seen.has(s.id)) return fail('merge_mismatch', i, '合併來源重複或包含目標卡本身')
          seen.add(s.id)
          const r = getRow(i, s.id, s.version)
          if (isFail(r)) return r
          if (r.completed) return fail('completed_locked', i, '已完成的卡不能合併，請先取消完成', r)
          // D7：只能合併同單號同品項（同一 SO 行）
          if (r.soLineKey !== target.soLineKey) return fail('merge_mismatch', i, '只能合併同一個 SO 品項行的子卡', r)
          srcRows.push(r)
        }
        next.set(target.id, stamp(target, { qty: r3(target.qty + srcRows.reduce((s, r) => s + r.qty, 0)) }))
        for (const r of srcRows) next.delete(r.id)
        invGroups.push([
          { op: 'setQty', id: target.id, version: target.version + 1, qty: target.qty },
          ...srcRows.map((r): PlacementOp => ({ op: 'restore', row: toSnapshotRow(r) })),
        ])
        break
      }

      case 'unplace': {
        const row = getRow(i, op.id, op.version)
        if (isFail(row)) return row
        if (row.completed) return fail('completed_locked', i, '已完成的卡不能放回待排池，請先取消完成', row)
        next.delete(op.id)
        invGroups.push([{ op: 'restore', row: toSnapshotRow(row) }])
        break
      }

      case 'setQty': {
        const row = getRow(i, op.id, op.version)
        if (isFail(row)) return row
        if (row.completed) return fail('completed_locked', i, '已完成的卡不能改數量，請先取消完成', row)
        if (!isQty(op.qty)) return fail('qty_invalid', i, '數量須大於 0、最多 3 位小數')
        next.set(op.id, stamp(row, { qty: r3(op.qty) }))
        if (op.qty > row.qty) { const cErr = checkConserve(i, row.soLineKey); if (cErr) return cErr }
        invGroups.push([{ op: 'setQty', id: op.id, version: row.version + 1, qty: row.qty }])
        break
      }

      case 'restore': {
        const r = op.row
        if (!r || !isUuid(r.id)) return fail('bad_request', i, 'restore.row.id 必須是 uuid')
        if (next.has(r.id) || orig.has(r.id)) return fail('id_exists', i, '這張卡已存在，無法復原')
        if (!isQty(r.qty)) return fail('qty_invalid', i, '數量須大於 0、最多 3 位小數')
        if (!isLineKey(r.soLineKey)) return fail('bad_request', i, 'soLineKey 格式錯誤')
        if (!isDateOrNull(r.planDate) || !isDateOrNull(r.originalDate)) return fail('date_invalid', i, '日期格式錯誤')
        if (!isOriginCardId(r.originCardId)) return fail('bad_request', i, `originCardId 須為 ${ORIGIN_CARD_ID_MAX} 字以內`)
        // Undo 用：日期同 move（允許 400 天內的過去日期、不可超過 maxDate、未來須為工作台日期）；原排定日只是紀錄，只擋超過 maxDate
        const dErr = checkDate(i, r.planDate, true)
        if (dErr) return dErr
        if (r.originalDate != null && r.originalDate > ctx.maxDate) return fail('date_invalid', i, `原排定日不可晚於 ${shortDate(ctx.maxDate)}`)
        next.set(r.id, fresh({ ...r, qty: r3(r.qty), source: r.source === 'ai' ? 'ai' : 'manual', originCardId: r.originCardId ?? null }))
        const cErr = checkConserve(i, r.soLineKey) ?? checkLineCount(i, r.soLineKey)
        if (cErr) return cErr
        invGroups.push([{ op: 'unplace', id: r.id, version: 1 }])
        break
      }

      case 'complete': {
        const row = getRow(i, op.id, op.version)
        if (isFail(row)) return row
        if (row.completed) return fail('completed_locked', i, '這張卡已經勾完成了', row)
        const supply = ctx.supplyOf(row.soLineKey)
        const a = alloc(row.soLineKey)
        if (!supply || !a) return fail('line_not_in_pool', i, '這個品項已不在待排池（可能已完成或結案），不需勾完成', row)
        const eff = a.placements.find((x) => x.placementId === row.id)?.effectiveQty ?? 0
        if (eff <= EPS) return fail('qty_invalid', i, '這張卡已由待排池扣完，不需勾完成，請用「移除」', row)
        // D24／規格 §3.4：延誤卡或待排區卡勾完成＝「實際在今天完成」→ 日期改 rollTarget；被修剪過 → qty 改成有效量
        const planDate = row.planDate == null || row.planDate < today ? rollTarget(today, openSats) : row.planDate
        const qty = eff < row.qty ? r3(eff) : row.qty
        next.set(row.id, stamp(row, {
          planDate, qty,
          completed: { at: ctx.nowIso, by: ctx.actor.email, byName: ctx.actor.name, poolQtyAt: supply.total },
        }))
        const inv: Extract<PlacementOp, { op: 'uncomplete' }> = { op: 'uncomplete', id: row.id, version: row.version + 1 }
        if (planDate !== row.planDate) inv.prevPlanDate = row.planDate
        if (qty !== row.qty) inv.prevQty = row.qty
        invGroups.push([inv])
        break
      }

      case 'uncomplete': {
        const row = getRow(i, op.id, op.version)
        if (isFail(row)) return row
        if (!row.completed) return fail('bad_request', i, '這張卡尚未勾完成', row)
        if (op.prevPlanDate !== undefined && !isDateOrNull(op.prevPlanDate)) return fail('date_invalid', i, 'prevPlanDate 格式錯誤')
        if (op.prevQty !== undefined && !isQty(op.prevQty)) return fail('qty_invalid', i, 'prevQty 須大於 0、最多 3 位小數')
        if (op.prevPlanDate !== undefined) { const dErr = checkDate(i, op.prevPlanDate, true); if (dErr) return dErr }
        const reopen = (qty: number) => next.set(row.id, stamp(row, {
          completed: null,
          planDate: op.prevPlanDate !== undefined ? op.prevPlanDate : row.planDate,
          qty,
        }))
        const want = op.prevQty !== undefined ? r3(op.prevQty) : row.qty
        reopen(want)
        let cErr = checkConserve(i, row.soLineKey)
        // Undo「勾完成被修剪的卡」：complete 把 qty 改成有效量、inverse 帶 prevQty＝修剪前的量。
        // 本批開始時這張卡是已完成，Σorig 不含它，prevQty 原量還原必然超過 max(E, Σorig) → 這種 Undo 原本一定失敗。
        // 超出的部分讀取時本來就會被修剪（畫面上沒有意義），所以只還原到可排上限（不低於目前 qty）；仍超過才照常擋。
        if (cErr && cErr.code === 'qty_exceeds_remaining' && want > row.qty) {
          const a = alloc(row.soLineKey)
          if (a) {
            const excess = openSum(row.soLineKey, next) - Math.max(a.effectiveSupply, openSum(row.soLineKey, orig))
            reopen(r3(Math.max(row.qty, want - excess)))
            cErr = checkConserve(i, row.soLineKey)
          }
        }
        cErr = cErr ?? checkLineCount(i, row.soLineKey)
        if (cErr) return cErr
        invGroups.push([{ op: 'complete', id: row.id, version: row.version + 1 }])
        break
      }

      default:
        return fail('bad_request', i, '不認得的操作')
    }
  }

  const inserts: Placement[] = []
  const updates: { before: Placement; after: Placement }[] = []
  const deletes: Placement[] = []
  for (const [id, p] of next) {
    const o = orig.get(id)
    if (!o) inserts.push(p)
    else if (o !== p) updates.push({ before: o, after: p })
  }
  for (const [id, o] of orig) if (!next.has(id)) deletes.push(o)

  const inverse = rebaseVersions(invGroups.reverse().flat(), next)
  return { ok: true, next, inserts, updates, deletes, inverse }
}

/** 「先減後增」分類用：一列對「該行未完成總量」的貢獻（已完成＝0） */
export function openContribution(p: Placement): number {
  return p.completed ? 0 : p.qty
}
