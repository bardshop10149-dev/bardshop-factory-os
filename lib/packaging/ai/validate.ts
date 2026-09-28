// 包裝專區 P3 AI 模擬排程 — AI 輸出的驗算與修正（純函式，規格 §五；D85 產能／鎖定由程式驗算、預設第 4 點「程式修正、不整份作廢」）
//
// 為什麼「驗算」而不是相信 AI：AI 只給建議（D29），硬規則由既有純函式保證——守恆／日期／線／D22／不可排區塊走 applyOps（與正式區同一套），
//   產能（applyOps 不檢查）用 assembleBoard 算出的各線 usedMinutes 對照 regular＋overtime。
// 為什麼逐筆 place、而不是整批 applyOps：applyOps 全有或全無，AI 只要一筆超量整份就作廢；逐筆套用＋依錯誤碼修正，
//   才做得到「超出的部分退回待排池、其餘照用」（預設第 4 點）。代價是後面的筆看得到前面的結果（先到先得），
//   所以先依 AI 的 (day, line, order) 排序——AI 心中的先後就是守恆不夠時誰先拿到量。
//
// 硬規則：不 import supabase、不讀時鐘（today／nowIso 在 input.world）、相對路徑 import、不用 enum；既有純函式只呼叫不修改。

import {
  MIN_CARD_MINUTES,
  MINUTES_OVERRIDE_MAX,
  MINUTES_OVERRIDE_MIN,
  type ApplyErrorCode,
  type EffectiveLineCapacity,
  type PackagingLine,
  type Placement,
  type PlacementOp,
  type YMD,
} from '../scheduleTypes'
import { applyOps, type ApplyResult } from '../scheduleOps'
import { allocateLine, minutesForQty, r3 } from '../scheduleAllocate'
import { resolveDayCapacity } from '../scheduleCapacity'
import { displayDateOf } from '../scheduleCalendar'
import { laneStopped } from '../scheduleLines'
import { round4 } from '../laneOrder'
import {
  assembleSimBoard,
  buildSimOpsContext,
  compareSimRows,
  composeSimState,
  isOrderLocked,
  isRowLocked,
  placementToSim,
} from './simState'
import { decodeAiText } from './payload'
import {
  AI_REASON_MAX,
  type AiAssignment,
  type CapacityTrim,
  type SimPlacement,
  type SimSource,
  type ValidateAiInput,
  type ValidateAiResult,
  type ValidationAdjust,
  type ValidationDrop,
  type ValidationReport,
} from './types'

const EPS = 1e-9
const round1 = (x: number): number => Math.round(x * 10) / 10
/** AI 文字（unplaced／warnings／建議）存進驗算報告的字數與筆數上限（防呆；正常遠小於此） */
const AI_TEXT_MAX = 500
const AI_LIST_MAX = 500
/** 產能削減最多重算幾輪（捨入差可能要第二輪；正常一輪就收斂） */
const TRIM_PASSES = 5

const cutChars = (s: string, max: number): string => {
  const chars = Array.from(s ?? '')
  return chars.length > max ? chars.slice(0, max).join('') : (s ?? '')
}
const normCode = (s: unknown): string => String(s ?? '').trim().toUpperCase()
/** AI 給整數件數時，修正後的數量也取整數（無條件捨去）；給小數時保留到 3 位 */
const floorLike = (x: number, like: number): number => (Number.isInteger(like) ? Math.floor(x + 1e-9) : Math.floor(x * 1000 + 1e-6) / 1000)
const clampOverride = (m: number): number => Math.min(MINUTES_OVERRIDE_MAX, Math.max(MINUTES_OVERRIDE_MIN, round1(m)))

/** 通過第 1 步的一筆 assignment */
interface ValidAssignment {
  idx: number
  a: AiAssignment
  key: string
  day: number
  date: YMD
  line: PackagingLine
  qty: number
  reason: string
}

/** 本次 AI 放下（或 copy 模式沿用）的模擬列 */
interface AiRowInfo {
  order: number
  idx: number
  aiReason: string | null
  simSource: SimSource
  /** 沿用的原模擬列（新列 null） */
  prev: SimPlacement | null
  /** 這一筆記在 report.accepted（true）還是 report.adjusted（adjusts）——D22 回頭檢查再修正／丟棄時要改帳 */
  accepted: boolean
  adjusts: ValidationAdjust[]
}

/**
 * 步驟（§五）：
 * 1. 丟棄 AI 動不了的東西 → report.dropped（附原因碼 ValidationIssueCode 與繁中訊息）：
 *    k 對不回（keyMap.cardToLine）→ unknown_card；day 不在 1..windowDates.length → day_out_of_window；
 *    line 代碼不是 session.lineIds 中的啟用線 → line_invalid；線被鎖 → line_locked；所屬訂單被鎖 → order_locked；
 *    qty 非有限數字或 ≤ 0 → qty_invalid；該 SO 行已無可排區塊（isPlaceableBlock）→ not_placeable；
 *    同一天同一線同一 k 多筆 → 只取第一筆，其餘 duplicate。工時一律以既有 minutesForQty（含 10 分鐘下限）計。
 * 2. 從 session.placements 移除「未鎖定、且所屬訂單未鎖定、且該行有送給 AI」的列（量回可動池）；
 *    鎖定列原樣保留（report.lockedKept）。沒送給 AI 的行（工時未知、超過 400 張上限）的模擬列也原樣保留——
 *    AI 沒看到它們，清掉等於默默把主管排好的卡退回待排池（payload 的 fixedMin 也把它們算成固定佔用，兩邊一致）。
 * 3. 依 AI (day, line, order) 排序，逐筆轉 place op（id＝newId()、soLineKey、qty、toDate＝windowDates[day-1]、lineId、
 *    originCardId＝該 SO 行可排卡中「剩餘量最多」的 cardId）→ 對組合狀態逐筆跑既有 applyOps（一次一筆；ctx＝simState.buildSimOpsContext(world)）。
 *    失敗依錯誤碼修正後重試（每種修正最多一次）：
 *      qty_exceeds_remaining → qty 夾到剩餘可動量（adjusted: qty_clamped；夾到 0 → dropped apply_failed）；
 *      before_est_ready（D22）→ 移到該行預估可包日（窗內第一個 ≥ 它、且該線當天有產能的日子；adjusted: moved_to_ready_day），否則 dropped before_est_ready；
 *      line_invalid／line_required → dropped line_invalid；其他 → dropped apply_failed（附 applyCode；not_placeable 用 not_placeable）。
 *    copy 模式：AI 給的位置等於原模擬列位置（同 SO 行、同日、同線）時**沿用原模擬列**（保留 id、livePlacementId、source、simSource；
 *    estMinutesOverride 依數量等比換算；qty 用 AI 的量、sortIndex 依 AI order 重算）→ report.keptCopy；
 *    其餘新列 simSource 'ai'、aiReason＝AI reason（截 AI_REASON_MAX 字後把代號換回）。
 * 3b. D22 回頭檢查：applyOps 的 place 只檢查剛放下的那一筆，而 allocateLine 依日期先後分配可包片——
 *    後面同 SO 行放在較早日期的筆會搶走可包片，讓前面已通過（或已移到可包日）的 AI 列又落在預估可包日之前（審查驗證 r3）。
 *    → 對每個有 AI 列的 SO 行重跑 allocateLine：違規（pre 且顯示日 < 預估可包日）的 AI 列移到窗內預估可包日
 *    （同線、比原日晚、該天有產能；adjusted: moved_to_ready_day），移不了就整筆丟棄（dropped before_est_ready），重複到沒有違規。
 *    產能削減（第 4 步）之後再檢查一次（削減只會減量，理論上不會產生新違規；保險起見有就丟棄，不再移動以免又超產能）。
 *    鎖定列、保留列不動（不是 AI 放的；正式工作台對「放一張卡讓別張變早」也是同樣只檢查被操作的卡）。
 * 3c. D100 工時覆寫額度：被重排的列若有覆寫工時（主管在模擬區改的、或從正式區複製來的），AI 新放的列依 AI 順序分到覆寫
 *    （每個 SO 行的額度＝被重排列中有覆寫的量與分鐘；沿用列帶走的先扣；跨過額度的那張混算標準工時；額度用完＝標準）。
 *    AI 看到的 min（payload）與結果一致，採用時也不會把正式區原有的覆寫清成標準值。
 * 4. 產能：以 assembleBoard 重算（simState.assembleSimBoard）每線每日 usedMinutes；
 *    超過 regular + overtime（over_overtime，紅）→ 從該線當天 AI order 最後的卡開始移除（整筆或減量，減量後仍守 10 分鐘下限）直到不超，
 *    移除量回待排池 → report.capacityTrimmed；超過 regular（橘或紅）→ 記 report.overtimeUsed（D94）。
 *    只削 AI 本次新放／沿用的列；鎖定列、正式區唯讀列造成的超載不削（那不是 AI 造成的），但也不再往上加。
 * 5. 線內順序：同日同線依 AI order 轉 sortIndex：該 lane 其他列（鎖定列、保留列、已完成的正式列）最大 sortIndex 的整數部分 + 1、+2…
 *    （沒有其他列時就是 1、2、3…）→ AI 列排在保留列後面，保留列的值不動。
 *    例外：copy 沿用的列彼此先後與原本相同、且新列都在它們之後 → 沿用列保留原 sortIndex、只有新列接在最後
 *    （順序沒變就不改值，採用時才不會對每張正式卡送 reorder）。
 * 6. report：accepted（第一次就成功的筆數，含沿用）、adjusted、dropped、capacityTrimmed、overtimeUsed、unknownMinutes／noThresholdCategories／notSent（取自 meta）、
 *    keptCopy、lockedKept、resultCount、aiUnplaced／aiWarnings（k → soLineKey；對不回 null；文字用 payload.decodeAiText 換回代號）、
 *    aiOvertime（day → date；對不回 null）、ruleSuggestions（decodeAiText）。applied 先填 true（runner 寫回失敗改 false）。
 * 回傳 { placements（新 session.placements，固定排序）, report }。
 */
export function validateAiResult(input: ValidateAiInput): ValidateAiResult {
  const { world, session, keyMap, meta, output, newId } = input
  const windowDates = [...session.windowDates]
  const locks = session.locks
  const ctx = buildSimOpsContext(world)
  const lockedLines = new Set(locks.lineIds)
  const sessionLines = new Set(session.lineIds)
  const lineByCode = new Map<string, PackagingLine>()
  for (const l of world.lines) if (sessionLines.has(l.id)) lineByCode.set(normCode(l.code), l)

  const report: ValidationReport = {
    applied: true,
    accepted: 0,
    adjusted: [],
    dropped: [],
    capacityTrimmed: [],
    overtimeUsed: [],
    unknownMinutes: { count: meta.unknownMinutes.count, categories: meta.unknownMinutes.categories.map((x) => ({ ...x })) },
    noThresholdCategories: [...meta.noThresholdCategories],
    notSent: meta.notSent,
    keptCopy: 0,
    lockedKept: 0,
    resultCount: 0,
    aiUnplaced: [],
    aiWarnings: [],
    aiOvertime: [],
    ruleSuggestions: [],
  }

  // 產能查表（與 assembleBoard 同一套 resolveDayCapacity；產能不隨擺放改變，一天算一次）
  const daily = [...world.capacityRows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const capByDate = new Map<YMD, EffectiveLineCapacity[]>()
  const laneCap = (date: YMD, lineId: number): EffectiveLineCapacity | null => {
    let list = capByDate.get(date)
    if (!list) {
      list = resolveDayCapacity(date, { daily, lineRows: world.lineRows, lines: world.lines }).lines ?? []
      capByDate.set(date, list)
    }
    return list.find((c) => c.lineId === lineId) ?? null
  }
  const laneUsable = (date: YMD, lineId: number): boolean => {
    const c = laneCap(date, lineId)
    return !!c && c.regularMinutes != null && !laneStopped(c)
  }

  // ── 1. 丟棄 AI 動不了的東西 ──
  const drop = (code: ValidationDrop['code'], a: AiAssignment, soLineKey: string | null, message: string, applyCode?: ApplyErrorCode) => {
    const d: ValidationDrop = {
      code, k: String(a.k ?? ''), soLineKey,
      day: Number.isFinite(a.day) ? a.day : 0,
      line: String(a.line ?? ''),
      qty: Number.isFinite(a.qty) ? a.qty : 0,
      message,
    }
    if (applyCode) d.applyCode = applyCode
    report.dropped.push(d)
  }
  const valid: ValidAssignment[] = []
  const seen = new Set<string>()
  output.assignments.forEach((a, idx) => {
    const k = normCode(a.k)
    const key = keyMap.cardToLine.get(k) ?? null
    if (!key) return drop('unknown_card', a, null, `${String(a.k)} 不是這次送出的卡，已略過`)
    if (!Number.isInteger(a.day) || a.day < 1 || a.day > windowDates.length) {
      return drop('day_out_of_window', a, key, `第 ${String(a.day)} 天不在模擬範圍（1～${windowDates.length}）內`)
    }
    const line = lineByCode.get(normCode(a.line))
    if (!line || !line.active) return drop('line_invalid', a, key, `${String(a.line)} 不是可用的產線`)
    if (lockedLines.has(line.id)) return drop('line_locked', a, key, `${line.name}已鎖定，不能放入新卡`)
    if (isOrderLocked(key, locks)) return drop('order_locked', a, key, '這張訂單已鎖定，不能新排')
    const qty = typeof a.qty === 'number' && Number.isFinite(a.qty) ? r3(a.qty) : NaN
    if (!(qty > 0)) return drop('qty_invalid', a, key, `數量 ${String(a.qty)} 不合法`)
    const supply = ctx.supplyOf(key)
    if (!supply || supply.total <= EPS) return drop('not_placeable', a, key, '這個品項目前沒有可排的量（不在待排池或只剩不可排區塊）')
    const dup = `${key}|${a.day}|${line.id}`
    if (seen.has(dup)) return drop('duplicate', a, key, '同一天同一線同一張卡重複，只取第一筆')
    seen.add(dup)
    valid.push({ idx, a, key, day: a.day, date: windowDates[a.day - 1], line, qty, reason: typeof a.reason === 'string' ? a.reason : '' })
  })

  // ── 2. 保留列與要重排的列 ──
  const sentKeys = new Set(keyMap.lineToCard.keys())
  const kept: SimPlacement[] = []
  const reusable = new Map<string, SimPlacement[]>()
  const reuseKey = (key: string, date: YMD, lineId: number) => `${key}|${date}|${lineId}`
  for (const s of session.placements) {
    const locked = isRowLocked(s, locks)
    if (locked || !sentKeys.has(s.soLineKey)) {
      kept.push(s)
      if (locked) report.lockedKept++
      continue
    }
    if (session.mode === 'copy') {
      const rk = reuseKey(s.soLineKey, s.planDate, s.lineId)
      let arr = reusable.get(rk)
      if (!arr) { arr = []; reusable.set(rk, arr) }
      arr.push(s)
    }
  }
  for (const arr of reusable.values()) arr.sort(compareSimRows)
  const takeReuse = (key: string, date: YMD, lineId: number): SimPlacement | null => reusable.get(reuseKey(key, date, lineId))?.shift() ?? null
  const releaseReuse = (s: SimPlacement | null) => {
    if (!s) return
    const rk = reuseKey(s.soLineKey, s.planDate, s.lineId)
    const arr = reusable.get(rk) ?? []
    arr.unshift(s)
    reusable.set(rk, arr)
  }

  // 原模擬區每張卡在自己那條線的上下位置（步驟 5 判斷「AI 是否照原順序留下」；只有 copy 模式會沿用原列）
  const origLanePos = new Map<string, number>()
  if (session.mode === 'copy' && session.placements.length > 0) {
    const b0 = assembleSimBoard(world, pickSession(session))
    for (const d of b0.days) {
      const n = new Map<number | null, number>()
      for (const c of d.cards) {
        const lane = c.laneId ?? null
        const i = n.get(lane) ?? 0
        n.set(lane, i + 1)
        origLanePos.set(c.placementId, i)
      }
    }
  }

  const keptById = new Map(kept.map((s) => [s.id, s]))
  const composed = composeSimState(world.live, { ...pickSession(session), placements: kept })
  let state = new Map<string, Placement>(composed.placements.map((p) => [p.id, p]))
  const aiRows = new Map<string, AiRowInfo>()

  const lineRowsOf = (key: string): Placement[] => {
    const out: Placement[] = []
    for (const p of state.values()) if (p.soLineKey === key) out.push(p)
    return out
  }
  const allocOf = (key: string, extra?: Placement) => {
    const supply = ctx.supplyOf(key)
    if (!supply) return null
    const rows = lineRowsOf(key)
    if (extra) rows.push(extra)
    return allocateLine({ supply, placements: rows, today: world.today, openWeekends: ctx.openWeekends })
  }
  /** 目前狀態下該行還能再排多少（守恆：Σ未完成 ≤ max(E, 目前 Σ)） */
  const roomFor = (key: string): number => {
    const a = allocOf(key)
    if (!a) return 0
    const open = lineRowsOf(key).reduce((s, p) => s + (p.completed ? 0 : p.qty), 0)
    return r3(a.effectiveSupply - open)
  }
  /** 顯示用的底卡：該行可排卡中剩餘量最多的（平手 cardId 小） */
  const originCardOf = (key: string): string | null => {
    const a = allocOf(key)
    if (!a) return null
    let best: string | null = null
    let bestQty = -1
    for (const [cid, q] of Object.entries(a.remainingByCard)) {
      if (q > bestQty + EPS || (Math.abs(q - bestQty) <= EPS && best != null && cid < best)) { best = cid; bestQty = q }
    }
    return best ?? a.supply.segments[0]?.cardId ?? null
  }
  /** D22：假設把這筆放在 date，它分到的未就緒片中最晚的預估可包日（不是 pre 回 null） */
  const readyDateFor = (key: string, id: string, date: YMD, lineId: number, qty: number): YMD | null => {
    const tmp: Placement = {
      id, soLineKey: key, qty, planDate: date, originalDate: date, source: 'ai', originCardId: null, completed: null, version: 1,
      createdAt: world.nowIso, createdBy: world.actor.email, createdByName: world.actor.name,
      updatedAt: world.nowIso, updatedBy: world.actor.email, updatedByName: world.actor.name,
      lineId, minutesOverride: null, sortIndex: null,
    }
    const a = allocOf(key, tmp)
    const pa = a?.placements.find((x) => x.placementId === id)
    return pa && pa.readiness === 'pre' ? pa.preReadyDate : null
  }
  const tryPlace = (id: string, key: string, date: YMD, lineId: number, qty: number): ApplyResult => {
    const op: PlacementOp = { op: 'place', id, soLineKey: key, qty, toDate: date, originCardId: originCardOf(key), lineId }
    return applyOps({ byId: state }, [op], ctx)
  }
  const aiReasonOf = (v: ValidAssignment): string => decodeAiText(cutChars(v.reason.trim(), AI_REASON_MAX), keyMap)
  const slot = (day: number, date: YMD, line: PackagingLine, qty: number) => ({ day, date, line: line.code, qty })

  // ── 3. 依 (day, line, order) 逐筆放 ──
  const ordered = [...valid].sort((x, y) =>
    x.day - y.day
    || x.line.sortOrder - y.line.sortOrder || x.line.id - y.line.id
    || x.a.order - y.a.order
    || x.idx - y.idx)
  for (const v of ordered) {
    let reuse = takeReuse(v.key, v.date, v.line.id)
    let id = reuse ? reuse.id : newId()
    let date = v.date
    let day = v.day
    let qty = v.qty
    const adjusts: ValidationAdjust[] = []
    const fixed = new Set<string>()
    let res = tryPlace(id, v.key, date, v.line.id, qty)
    let dropped = false
    // 依錯誤碼修正後重試；每種修正最多一次（夾量 → 可能再遇到 D22 → 移日），其他錯誤直接丟棄
    while (!res.ok) {
      const code = res.code
      if (code === 'qty_exceeds_remaining' && !fixed.has(code)) {
        fixed.add(code)
        const q2 = floorLike(Math.min(roomFor(v.key), qty), v.qty)
        if (!(q2 > EPS)) {
          drop('apply_failed', v.a, v.key, '該品項已沒有可排量（前面的安排已用完待排池），已略過', 'qty_exceeds_remaining')
          dropped = true
          break
        }
        adjusts.push({
          code: 'qty_clamped', k: String(v.a.k), soLineKey: v.key,
          from: slot(day, date, v.line, qty), to: slot(day, date, v.line, q2),
          message: `數量超過可排量，由 ${qty} 改為 ${q2}`,
        })
        qty = q2
      } else if (code === 'before_est_ready' && !fixed.has(code)) {
        fixed.add(code)
        const readyOn = readyDateFor(v.key, id, date, v.line.id, qty)
        const target = readyOn ? windowDates.find((d) => d >= readyOn && d > date && laneUsable(d, v.line.id)) : undefined
        if (!target) {
          drop('before_est_ready', v.a, v.key, readyOn
            ? `預估可包日 ${readyOn} 不在模擬範圍內（D22 預排卡只能排在可包日當天或之後），已略過`
            : '排在預估可包日之前（D22），已略過')
          dropped = true
          break
        }
        // 換了日子就不再是「原位置」→ 不沿用原模擬列
        if (reuse) { releaseReuse(reuse); reuse = null; id = newId() }
        const toDay = windowDates.indexOf(target) + 1
        adjusts.push({
          code: 'moved_to_ready_day', k: String(v.a.k), soLineKey: v.key,
          from: slot(day, date, v.line, qty), to: slot(toDay, target, v.line, qty),
          message: `第 ${day} 天早於預估可包日 ${readyOn}，移到第 ${toDay} 天`,
        })
        date = target
        day = toDay
      } else {
        if (code === 'line_invalid' || code === 'line_required') drop('line_invalid', v.a, v.key, res.message)
        else if (code === 'before_est_ready') drop('before_est_ready', v.a, v.key, res.message)
        else if (code === 'not_placeable') drop('not_placeable', v.a, v.key, res.message)
        else drop('apply_failed', v.a, v.key, res.message, code)
        dropped = true
        break
      }
      res = tryPlace(id, v.key, date, v.line.id, qty)
    }
    if (dropped || !res.ok) {
      releaseReuse(reuse)
      continue
    }
    state = res.next
    if (reuse) {
      // 沿用原模擬列：保留 id、正式列來源與原排定日；覆寫工時「以本列 qty 為準」→ 數量變了就等比換算
      const placed = state.get(id)!
      const ov = reuse.estMinutesOverride == null
        ? null
        : Math.abs(qty - reuse.qty) <= EPS ? reuse.estMinutesOverride : clampOverride((reuse.estMinutesOverride * qty) / reuse.qty)
      state.set(id, {
        ...placed,
        source: reuse.source,
        originalDate: reuse.originalDate ?? placed.originalDate,
        minutesOverride: ov == null ? null : { minutes: ov, by: session.ownerEmail, byName: session.ownerName, at: session.updatedAt },
      })
      report.keptCopy++
    }
    aiRows.set(id, {
      order: v.a.order,
      idx: v.idx,
      aiReason: reuse ? (reuse.simSource === 'ai' ? aiReasonOf(v) : reuse.aiReason ?? null) : aiReasonOf(v),
      simSource: reuse ? reuse.simSource : 'ai',
      prev: reuse,
      accepted: adjusts.length === 0,
      adjusts,
    })
    if (adjusts.length > 0) report.adjusted.push(...adjusts)
    else report.accepted++
  }

  // ── 3b. D22 回頭檢查（見函式說明）──
  /** 目前狀態下違反 D22 的 AI 列（日期早的在前） */
  const d22Violations = (): { id: string; ready: YMD }[] => {
    const keys = new Set<string>()
    for (const id of aiRows.keys()) {
      const p = state.get(id)
      if (p) keys.add(p.soLineKey)
    }
    const out: { id: string; date: YMD; ready: YMD }[] = []
    for (const key of keys) {
      const supply = ctx.supplyOf(key)
      if (!supply) continue
      const a = allocateLine({ supply, placements: lineRowsOf(key), today: world.today, openWeekends: ctx.openWeekends })
      for (const pa of a.placements) {
        if (!aiRows.has(pa.placementId) || pa.readiness !== 'pre' || !pa.preReadyDate) continue
        const p = state.get(pa.placementId)
        if (!p || p.completed || p.planDate == null) continue
        const disp = displayDateOf(p, world.today, ctx.openWeekends).date
        if (disp && disp < pa.preReadyDate) out.push({ id: p.id, date: p.planDate, ready: pa.preReadyDate })
      }
    }
    return out.sort((x, y) => (x.date !== y.date ? (x.date < y.date ? -1 : 1) : x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  }
  const lineById = new Map(world.lines.map((l) => [l.id, l]))
  const fixD22 = (allowMove: boolean) => {
    // 每一輪至少移走（日期只會往後）或丟掉一筆 → 有上限；防呆再加一層
    const maxRounds = (aiRows.size + 1) * (windowDates.length + 1)
    for (let round = 0; round < maxRounds; round++) {
      const bad = d22Violations()
      if (bad.length === 0) return
      const { id, ready } = bad[0]
      const row = state.get(id)!
      const info = aiRows.get(id)!
      const a = output.assignments[info.idx]
      const lineId = row.lineId as number
      const line = lineById.get(lineId)
      const fromDate = row.planDate as YMD
      const fromDay = windowDates.indexOf(fromDate) + 1
      const target = allowMove && line
        ? windowDates.find((d) => d >= ready && d > fromDate && laneUsable(d, lineId))
        : undefined
      if (info.prev) report.keptCopy-- // 換日或丟掉都不再是「沿用原位置」
      if (target && line) {
        const toDay = windowDates.indexOf(target) + 1
        // 換了日子＝AI 新排的一段（不再沿用原模擬列：原排定日跟著新日子、simSource 'ai'）
        state.set(id, { ...row, planDate: target, originalDate: target })
        const adj: ValidationAdjust = {
          code: 'moved_to_ready_day', k: String(a?.k ?? ''), soLineKey: row.soLineKey,
          from: slot(fromDay, fromDate, line, row.qty), to: slot(toDay, target, line, row.qty),
          message: `第 ${fromDay} 天早於預估可包日 ${ready}（同品項其他段先用掉了可包量），移到第 ${toDay} 天`,
        }
        report.adjusted.push(adj)
        if (info.accepted) { report.accepted--; info.accepted = false }
        info.adjusts.push(adj)
        if (info.prev) { info.prev = null; info.simSource = 'ai' }
      } else {
        state.delete(id)
        aiRows.delete(id)
        // 這一筆之前的修正紀錄一併撤掉（最後結果是丟棄，不要同時出現在「修正後採用」）
        if (info.adjusts.length > 0) report.adjusted = report.adjusted.filter((x) => !info.adjusts.includes(x))
        if (info.accepted) report.accepted--
        if (a) {
          drop('before_est_ready', a, row.soLineKey, allowMove
            ? `預估可包日 ${ready} 沒有可排的日子（同品項其他段先用掉了可包量；D22 預排卡只能排在可包日當天或之後），已略過`
            : `排在預估可包日 ${ready} 之前（D22），已略過`)
        }
      }
    }
  }
  fixD22(true)

  // 目前狀態 → 模擬列（保留列原樣輸出；AI 列轉回 SimPlacement）
  const currentSims = (): SimPlacement[] => {
    const out: SimPlacement[] = []
    for (const p of state.values()) {
      const keptRow = keptById.get(p.id)
      if (keptRow) { out.push({ ...keptRow }); continue }
      const ai = aiRows.get(p.id)
      if (!ai || p.planDate == null || p.lineId == null) continue
      const s = placementToSim(p, ai.prev, ai.simSource)
      s.aiReason = ai.aiReason
      if (!ai.prev) s.source = 'ai'
      out.push(s)
    }
    return out.sort(compareSimRows)
  }
  const perUnitOf = (key: string): number | null => ctx.supplyOf(key)?.perUnit ?? null
  const minutesOf = (p: Placement, q: number): number => {
    const ov = p.minutesOverride?.minutes
    if (ov != null) return p.qty > 0 ? round1((ov * q) / p.qty) : 0
    return minutesForQty(perUnitOf(p.soLineKey), q) ?? 0
  }

  // ── 3c. D100 工時覆寫額度（見函式說明第 3c 點）──
  // 為什麼：payload 給 AI 的 min 已經是覆寫後工時（主管在模擬區改的、或從正式區複製來的），但 AI 新放的列覆寫一律 null
  //   （只有 copy 模式同日同線沿用的列會保留）→ 卡片回到標準工時、線負荷和 AI 規劃時對不上；採用時還會對原正式列送
  //   setMinutes(null)，把組長改過的工時清掉並記一筆「採用 AI 模擬」（D69 學習資料被污染）。
  // 規則：每個 SO 行把「被重排的列」裡有覆寫的量與分鐘加總成額度（以本列 qty 為準），先扣掉已帶著覆寫的列（沿用列等比換算的值），
  //   其餘依 AI 順序分給新列：整張在額度內＝額度的每件分鐘 × 件數；跨過額度的那張＝剩下的額度＋其餘件數的標準工時；額度用完＝null（標準）。
  //   在產能削減（第 4 步）之前做：削減要用和 AI 規劃時同一套工時算。
  const budget = new Map<string, { qty: number; min: number }>()
  for (const s of session.placements) {
    if (keptById.has(s.id) || s.estMinutesOverride == null || !(s.qty > EPS)) continue
    const b = budget.get(s.soLineKey) ?? { qty: 0, min: 0 }
    b.qty += s.qty
    b.min += s.estMinutesOverride
    budget.set(s.soLineKey, b)
  }
  if (budget.size > 0) {
    const rankOf = new Map(ordered.map((v, i) => [v.idx, i]))
    const rows: { id: string; rank: number; p: Placement }[] = []
    for (const [id, info] of aiRows) {
      const p = state.get(id)
      if (p && budget.has(p.soLineKey)) rows.push({ id, rank: rankOf.get(info.idx) ?? Number.MAX_SAFE_INTEGER, p })
    }
    rows.sort((x, y) => x.rank - y.rank || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    // 已帶覆寫的列（copy 沿用、或沿用後被 D22 移日的列）先扣，額度不重複分給別張
    for (const { p } of rows) {
      const ov = p.minutesOverride?.minutes
      if (ov == null) continue
      const b = budget.get(p.soLineKey)!
      b.qty = Math.max(0, b.qty - p.qty)
      b.min = Math.max(0, b.min - ov)
    }
    for (const { id, p } of rows) {
      if (p.minutesOverride != null) continue
      const b = budget.get(p.soLineKey)!
      if (b.qty <= EPS || b.min <= EPS) continue
      let ov: number
      if (b.qty >= p.qty - EPS) {
        ov = (b.min * p.qty) / b.qty
        b.min = Math.max(0, b.min - ov)
        b.qty = Math.max(0, b.qty - p.qty)
      } else {
        const pu = perUnitOf(p.soLineKey)
        ov = b.min + (pu != null ? pu * (p.qty - b.qty) : 0)
        b.qty = 0
        b.min = 0
      }
      state.set(id, { ...p, minutesOverride: { minutes: clampOverride(ov), by: session.ownerEmail, byName: session.ownerName, at: session.updatedAt } })
    }
  }

  // ── 4. 產能 ──
  let board = assembleSimBoard(world, { ...pickSession(session), placements: currentSims() })
  for (let pass = 0; pass < TRIM_PASSES; pass++) {
    let changed = false
    for (const bd of board.days) {
      const dayIdx = windowDates.indexOf(bd.date)
      if (dayIdx < 0) continue
      for (const lane of bd.lanes ?? []) {
        if (!sessionLines.has(lane.lineId)) continue
        const limit = (lane.capacity.regularMinutes ?? 0) + lane.capacity.overtimeMinutes
        let excess = round1(lane.usedMinutes - limit)
        if (excess <= 1e-6) continue
        const cands = bd.cards
          .filter((c) => c.laneId === lane.lineId && !c.completed && aiRows.has(c.placementId))
          .sort((x, y) => {
            const ax = aiRows.get(x.placementId)!, ay = aiRows.get(y.placementId)!
            return ay.order - ax.order || ay.idx - ax.idx
          })
        for (const c of cands) {
          if (excess <= 1e-6) break
          const row = state.get(c.placementId)
          const m = c.minutes ?? 0
          if (!row || m <= EPS) continue
          // 待排池減少造成有效量 < 列上數量時，比例換算不準 → 整筆移除
          const exact = Math.abs(c.effectiveQty - row.qty) <= EPS
          const target = m - excess
          let newQty = 0
          if (exact && target >= MIN_CARD_MINUTES - EPS) {
            const ov = row.minutesOverride?.minutes
            const pu = perUnitOf(row.soLineKey)
            newQty = ov != null ? floorLike((row.qty * target) / ov, row.qty) : pu ? floorLike(target / pu, row.qty) : 0
            const step = Number.isInteger(row.qty) ? 1 : 0.001
            while (newQty > EPS && minutesOf(row, newQty) > target + 1e-6) newQty = r3(newQty - step)
            if (newQty >= row.qty - EPS) newQty = 0
          }
          const trim: CapacityTrim = {
            day: dayIdx + 1, date: bd.date, line: lane.code, soLineKey: row.soLineKey, qty: row.qty, minutes: round1(m),
          }
          if (newQty <= EPS) {
            state.delete(row.id)
            aiRows.delete(row.id)
            excess = round1(excess - m)
          } else {
            const newMin = minutesOf(row, newQty)
            const ov = row.minutesOverride
            state.set(row.id, {
              ...row,
              qty: newQty,
              minutesOverride: ov ? { ...ov, minutes: clampOverride((ov.minutes * newQty) / row.qty) } : null,
            })
            trim.qty = r3(row.qty - newQty)
            trim.minutes = round1(m - newMin)
            excess = round1(excess - (m - newMin))
          }
          report.capacityTrimmed.push(trim)
          changed = true
        }
      }
    }
    if (!changed) break
    board = assembleSimBoard(world, { ...pickSession(session), placements: currentSims() })
  }
  // 削減後再檢查一次 D22（只丟不移，避免又超產能）；有丟才重算工作台（加班統計要用最新的）
  const beforeFix = aiRows.size
  fixD22(false)
  if (aiRows.size !== beforeFix) board = assembleSimBoard(world, { ...pickSession(session), placements: currentSims() })
  // D94：用到加班（超過正常工時）的線與日——以不加班為主，列出供摘要
  for (const bd of board.days) {
    const dayIdx = windowDates.indexOf(bd.date)
    if (dayIdx < 0) continue
    for (const lane of bd.lanes ?? []) {
      if (!sessionLines.has(lane.lineId)) continue
      const regular = lane.capacity.regularMinutes ?? 0
      if (lane.usedMinutes > regular + 1e-6) {
        report.overtimeUsed.push({ day: dayIdx + 1, date: bd.date, line: lane.code, minutes: round1(lane.usedMinutes - regular) })
      }
    }
  }

  // ── 5. 線內順序 ──
  const laneIds = new Map<string, string[]>()
  for (const [id] of aiRows) {
    const p = state.get(id)
    if (!p || p.planDate == null || p.lineId == null) continue
    const lk = `${p.planDate}|${p.lineId}`
    let arr = laneIds.get(lk)
    if (!arr) { arr = []; laneIds.set(lk, arr) }
    arr.push(id)
  }
  for (const [lk, ids] of laneIds) {
    const [date, lineStr] = lk.split('|')
    const lineId = Number(lineStr)
    let base = 0
    for (const p of state.values()) {
      if (aiRows.has(p.id) || p.planDate !== date || (p.lineId ?? null) !== lineId || p.sortIndex == null) continue
      base = Math.max(base, Math.floor(p.sortIndex))
    }
    ids.sort((x, y) => {
      const ax = aiRows.get(x)!, ay = aiRows.get(y)!
      return ax.order - ay.order || ax.idx - ay.idx
    })
    // copy 沿用的列若「彼此先後跟原本一樣、新列都排在它們後面」→ 沿用列保留原 sortIndex，新列接在最後。
    // 為什麼：AI 照原樣留下的卡若改成 1、2、3…，畫面順序沒變，採用時卻會對每張正式卡送 reorder（版本 +1、算成「被 AI 動過」）。
    const reused = ids.filter((id) => aiRows.get(id)!.prev)
    const firstNew = ids.findIndex((id) => !aiRows.get(id)!.prev)
    const newAfterReused = firstNew < 0 || ids.slice(firstNew).every((id) => !aiRows.get(id)!.prev)
    const pos = reused.map((id) => origLanePos.get(id) ?? -1)
    const sameOrder = reused.length > 0 && pos.every((x, i) => x >= 0 && (i === 0 || x > pos[i - 1]))
    if (newAfterReused && sameOrder) {
      for (const id of reused) {
        const prevSort = aiRows.get(id)!.prev!.sortIndex ?? null
        state.set(id, { ...state.get(id)!, sortIndex: prevSort })
        if (prevSort != null) base = Math.max(base, Math.floor(prevSort))
      }
      ids.filter((id) => !aiRows.get(id)!.prev).forEach((id, i) => { state.set(id, { ...state.get(id)!, sortIndex: round4(base + i + 1) }) })
    } else {
      ids.forEach((id, i) => { state.set(id, { ...state.get(id)!, sortIndex: round4(base + i + 1) }) })
    }
  }

  // ── 6. 報告 ──
  const placements = currentSims()
  report.resultCount = placements.length
  const lineKeyOf = (k: unknown): string | null => {
    const code = normCode(k)
    return code ? keyMap.cardToLine.get(code) ?? null : null
  }
  const text = (s: unknown): string => cutChars(decodeAiText(typeof s === 'string' ? s : '', keyMap), AI_TEXT_MAX)
  report.aiUnplaced = output.unplaced.slice(0, AI_LIST_MAX).map((u) => ({ soLineKey: lineKeyOf(u.k), reason: text(u.reason) }))
  report.aiWarnings = output.warnings.slice(0, AI_LIST_MAX).map((w) => ({ soLineKey: lineKeyOf(w.k), message: text(w.message) }))
  report.aiOvertime = output.overtime.slice(0, AI_LIST_MAX).map((o) => ({
    day: o.day,
    date: Number.isInteger(o.day) && o.day >= 1 && o.day <= windowDates.length ? windowDates[o.day - 1] : null,
    line: cutChars(String(o.line ?? '').trim(), 10),
    hours: o.hours,
    reason: text(o.reason),
  }))
  report.ruleSuggestions = output.ruleSuggestions.slice(0, AI_LIST_MAX).map((s) => text(s))
  return { placements, report }
}

/** composeSimState／assembleSimBoard 需要的 session 欄位（不帶 undo 等大欄位） */
function pickSession(s: ValidateAiInput['session']) {
  return {
    windowDates: s.windowDates,
    lineIds: s.lineIds,
    placements: s.placements,
    horizon: s.horizon,
    ownerEmail: s.ownerEmail,
    ownerName: s.ownerName,
    updatedAt: s.updatedAt,
  }
}
