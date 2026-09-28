// 包裝專區 P3 AI 模擬排程 — 採用與退回的差異計算（純函式，規格 §六；D82／D86／D87）
//
// 採用（§6.1）與退回（§6.2）共用同一個 planAdoption：
//   採用：target＝session.placements 中未鎖定線的列（AdoptionTargetRow；source：simSource ai→'ai'、manual→'manual'、copy→原正式列 source）
//   退回：target＝該次採用的 auto_before_ai 快照中、落在同一範圍（window_dates × line_ids）的列（pairId＝快照列 id，source＝快照值）
//   → 讓正式區「範圍內、未完成」的列變成 target；範圍外、待排區、已完成、鎖定線一律不動（D87，與採用對稱）。
// 為什麼不重跑 inverse：applyOps 全有或全無、rebaseVersions 串連版本號，任一張被改過就整批失敗；改用「對目前正式區重算差異、逐筆套用」。
// 為什麼配到的列用 move 而不是「刪掉重建」：move 保留 id → original_date（D50 延誤天數）、覆寫工時、D69 學習紀錄的 placement_id、
//   前端 Undo 堆疊都還連得上；代價是 move 會把 source 改成 manual（「AI 排過」改由 adoption.touched 的 {id, version} 判斷）。
//
// 硬規則：不 import supabase、不讀時鐘（today 在 env；nowIso 在 OpsContext）、相對路徑 import、不用 enum；既有 applyOps 只呼叫不修改。

import type { Placement, PlacementOp, YMD } from '../scheduleTypes'
import { applyOps, rebaseVersions, type ApplyOk, type MinuteEdit, type OpsContext, type OpsState } from '../scheduleOps'
import { allocateLine } from '../scheduleAllocate'
import { displayDateOf } from '../scheduleCalendar'
import { compareSimRows, isInSimScope } from './simState'
import {
  AI_ADOPT_MAX_OPS,
  type AdoptionCounts,
  type AdoptionEnv,
  type AdoptionPlan,
  type AdoptionSkip,
  type AdoptionTargetRow,
  type LenientSkip,
  type SimScope,
} from './types'

const EPS = 1e-9
/** 採用時同步覆寫工時的原因（寫進 setMinutes.reason；D69 學習紀錄可據此排除「不是主管親手改」的紀錄） */
export const ADOPT_MINUTES_REASON = '採用 AI 模擬'
/** D22 預檢用的暫時建立時間：排在同一天既有列之後（同 applyOps 新建列用 nowIso 的效果） */
const FAR_FUTURE_ISO = '9999-12-31T00:00:00.000Z'

const sameNum = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a == null || b == null ? a == null && b == null : Math.abs(a - b) <= 1e-6

/**
 * D100 覆寫的「每件分鐘」相同：把正式列的覆寫依數量等比換成 target 的量，四捨五入到 0.1 分後等於 target 的覆寫
 * （validate 3c／沿用列／拆卡都是等比換算再取 1 位小數，所以用 0.05 分的容差）。
 */
const sameRate = (sMin: number, sQty: number, lMin: number, lQty: number): boolean =>
  sQty > EPS && lQty > EPS && Math.abs(sMin - (lMin * sQty) / lQty) <= 0.05 + 1e-9

/**
 * D100 配對時的覆寫相容度：2＝都沒覆寫、或都有且每件分鐘相同；1＝都有覆寫但每件不同；0＝一邊有一邊沒有。
 * 為什麼要看：同一 SO 行有多張正式卡時，validate 3c 把組長的覆寫依 AI 順序分給新列，而配對原本只看日期／線／固定順序，
 *   兩邊沒對齊 → 覆寫落到另一張正式卡（L1 被寫上 90、L2 被清成標準），還多兩筆「採用 AI 模擬」學習紀錄（D100 驗證 F3）。
 *   同一輪配對條件下，優先配給覆寫相容的正式卡；相容度相同才照原本的固定順序。
 */
const overrideFit = (s: AdoptionTargetRow, l: Placement): number => {
  const a = s.estMinutesOverride
  const b = l.minutesOverride?.minutes ?? null
  if (a == null && b == null) return 2
  if (a == null || b == null) return 0
  return sameRate(a, s.qty, b, l.qty) ? 2 : 1
}

const cmpTarget = (a: AdoptionTargetRow, b: AdoptionTargetRow): number => {
  const c = compareSimRows(
    { planDate: a.planDate, lineId: a.lineId, sortIndex: a.sortIndex, id: a.pairId ?? '' },
    { planDate: b.planDate, lineId: b.lineId, sortIndex: b.sortIndex, id: b.pairId ?? '' },
  )
  return c || a.qty - b.qty || a.soLineKey.localeCompare(b.soLineKey)
}

/** target 列 → 模擬用 Placement（D22 預檢；不寫入） */
const targetAsPlacement = (id: string, s: AdoptionTargetRow): Placement => ({
  id, soLineKey: s.soLineKey, qty: s.qty, planDate: s.planDate, originalDate: s.planDate, source: s.source,
  originCardId: s.originCardId, completed: null, version: 1,
  createdAt: FAR_FUTURE_ISO, createdBy: '', createdByName: null, updatedAt: FAR_FUTURE_ISO, updatedBy: '', updatedByName: null,
  lineId: s.lineId,
  minutesOverride: s.estMinutesOverride != null ? { minutes: s.estMinutesOverride, by: '', byName: null, at: FAR_FUTURE_ISO } : null,
  sortIndex: s.sortIndex,
})

/**
 * 算出讓 live 範圍內變成 target 的 ops（§6.1 步驟 3、§6.3）。
 * live：正式區擺放（至少包含範圍內所有列、以及 target 涉及 SO 行的全部列）；scope：{ windowDates, lineIds（實際覆蓋的線＝未鎖定線）}；
 * target：呼叫端保證都在 scope 內；防呆：範圍外的 target 列直接忽略（不產生 op、不計數）。
 * 對每個 SO 行：L＝live 中 isInSimScope 且未完成的列，S＝target 同 SO 行的列。配對優先序：
 *   S.pairId === L.id → 同（日, 線）→ 同日 → 其餘（依日期、線、sortIndex、id 固定順序）。
 *   D100：每一輪裡優先配「覆寫相容」的 L（都沒覆寫、或每件分鐘相同；overrideFit），相同才照固定順序——覆寫才會回到原本那張正式卡。
 * - 配到的 (s, l)：日／線不同 → move（id＝l.id、version＝l.version、toDate、lineId、sortIndex＝s.sortIndex）；
 *   數量不同 → setQty（減量排在同 SO 行的增量之前，讓 applyOps 的守恆逐步檢查過得去）；
 *   沒有 move 而 sortIndex 不同 → reorder；s.estMinutesOverride 與 l.minutesOverride?.minutes 不同 → setMinutes（via 'dialog'、reason '採用 AI 模擬'）。
 *   D100：數量變了但每件分鐘沒變（兩邊都有覆寫、等比換算相同）→ 覆寫併進 setQty（minutesOverride，沿用原作者、不寫學習紀錄），不送 setMinutes。
 *   都相同 → counts.unchanged。
 * - S 多出來的 → restore（row＝{ id: env.newId(), soLineKey, qty, planDate, originalDate: planDate, source: s.source, originCardId,
 *   lineId, estMinutesOverride, sortIndex }）。restore 不檢查停用線、不可排區塊與 D22 → 這裡先檢查：
 *   目標線已停用（env.isLineActive 回 false）→ skipped line_invalid；該行供給（env.supplyOf）為 null → skipped no_supply；
 *   沒有可排區塊 → not_placeable；以「該行採用後的樣子」（範圍外列＋配對後的列＋要新建的列）跑 allocateLine，
 *   新建列是預排（pre）且日期早於分到的預估可包日 → before_est_ready（列入 skipped，不產生 op；移除後重算，直到沒有違規）。
 * - L 多出來（target 沒有）→ unplace（量回待排池）。
 * - 同一 SO 行內 op 順序：unplace → setQty 減量 → move → setQty 增量 → restore → reorder → setMinutes。
 *   同一列有多個 op 時版本號以 rebaseVersions 依序串起來（每個 op 都讓 version +1）。
 * - ops 總數 > AI_ADOPT_MAX_OPS → 不截斷，回傳空 ops 並把原因放進 skipped（code 'too_many_ops'），由 route 回 400。
 * counts：moved／added／returned／qtyChanged／reordered／minutesChanged／unchanged／skipped。
 * 採用前已完成／已銷貨／已不在池內的卡：live 已完成的不在 L；不在池內的 restore 會被上面的 no_supply 擋下；其餘交給 applyOpsLenient 擋並列入 skipped。
 */
export function planAdoption(
  live: readonly Placement[],
  target: readonly AdoptionTargetRow[],
  scope: SimScope,
  env: AdoptionEnv,
): AdoptionPlan {
  const counts: AdoptionCounts = { moved: 0, added: 0, returned: 0, qtyChanged: 0, reordered: 0, minutesChanged: 0, unchanged: 0, skipped: 0 }
  const skipped: AdoptionSkip[] = []
  const liveById = new Map(live.map((p) => [p.id, p]))
  const liveByKey = new Map<string, Placement[]>()
  const inScopeByKey = new Map<string, Placement[]>()
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    let arr = m.get(k)
    if (!arr) { arr = []; m.set(k, arr) }
    arr.push(v)
  }
  for (const p of live) {
    push(liveByKey, p.soLineKey, p)
    if (!p.completed && isInSimScope(p, scope)) push(inScopeByKey, p.soLineKey, p)
  }
  const targetByKey = new Map<string, AdoptionTargetRow[]>()
  for (const t of target) if (isInSimScope(t, scope)) push(targetByKey, t.soLineKey, t)

  const keys = [...new Set([...inScopeByKey.keys(), ...targetByKey.keys()])].sort()
  const ops: PlacementOp[] = []
  for (const key of keys) {
    const Ls = [...(inScopeByKey.get(key) ?? [])].sort(compareSimRows)
    const Ss = [...(targetByKey.get(key) ?? [])].sort(cmpTarget)

    // ── 配對 ──
    const freeL = new Set(Ls.map((l) => l.id))
    const pairs: { s: AdoptionTargetRow; l: Placement }[] = []
    let restS: AdoptionTargetRow[] = Ss
    const pairRound = (match: (s: AdoptionTargetRow, l: Placement) => boolean) => {
      const left: AdoptionTargetRow[] = []
      for (const s of restS) {
        // 同一輪符合條件的正式卡中，優先覆寫相容的（overrideFit 高的）；相同才取固定順序的第一張（D100）
        let l: Placement | undefined
        let best = -1
        for (const x of Ls) {
          if (!freeL.has(x.id) || !match(s, x)) continue
          const fit = overrideFit(s, x)
          if (fit > best) { l = x; best = fit }
          if (fit === 2) break
        }
        if (l) { freeL.delete(l.id); pairs.push({ s, l }) } else left.push(s)
      }
      restS = left
    }
    pairRound((s, l) => s.pairId != null && s.pairId === l.id)
    pairRound((s, l) => s.planDate === l.planDate && s.lineId === (l.lineId ?? null))
    pairRound((s, l) => s.planDate === l.planDate)
    pairRound(() => true)

    const unplaceOps: PlacementOp[] = []
    const decOps: PlacementOp[] = []
    const moveOps: PlacementOp[] = []
    const incOps: PlacementOp[] = []
    const restoreOps: PlacementOp[] = []
    const reorderOps: PlacementOp[] = []
    const minuteOps: PlacementOp[] = []

    for (const l of Ls) {
      if (!freeL.has(l.id)) continue
      unplaceOps.push({ op: 'unplace', id: l.id, version: l.version })
      counts.returned++
    }
    for (const { s, l } of pairs) {
      let touched = false
      const moved = s.planDate !== l.planDate || s.lineId !== (l.lineId ?? null)
      if (moved) {
        moveOps.push({ op: 'move', id: l.id, version: l.version, toDate: s.planDate, lineId: s.lineId, sortIndex: s.sortIndex })
        counts.moved++
        touched = true
      }
      const lOv = l.minutesOverride?.minutes ?? null
      const qtyChanged = Math.abs(s.qty - l.qty) > EPS
      // D100：只有數量變、每件分鐘沒變（組長的覆寫跟著數量等比換算）→ 覆寫放進 setQty 一起改：沿用原作者、不寫學習紀錄
      //   （同拆卡 D69 規則 2 的 overrideKeepMeta）。另送 setMinutes 會把組長的覆寫記成「採用 AI 模擬」改的，污染 D69 學習資料。
      const scaleWithQty = qtyChanged && s.estMinutesOverride != null && lOv != null && sameRate(s.estMinutesOverride, s.qty, lOv, l.qty)
      if (qtyChanged) {
        (s.qty < l.qty ? decOps : incOps).push({
          op: 'setQty', id: l.id, version: l.version, qty: s.qty, ...(scaleWithQty ? { minutesOverride: s.estMinutesOverride } : {}),
        })
        counts.qtyChanged++
        touched = true
      }
      if (!moved && !sameNum(s.sortIndex, l.sortIndex ?? null)) {
        reorderOps.push({ op: 'reorder', id: l.id, version: l.version, sortIndex: s.sortIndex })
        counts.reordered++
        touched = true
      }
      if (!scaleWithQty && !sameNum(s.estMinutesOverride, lOv)) {
        minuteOps.push({ op: 'setMinutes', id: l.id, version: l.version, minutes: s.estMinutesOverride, via: 'dialog', reason: ADOPT_MINUTES_REASON })
        counts.minutesChanged++
        touched = true
      }
      if (!touched) counts.unchanged++
    }

    // ── S 多出來的 → restore（先做 restore 不做的檢查）──
    // 停用線：既有 restore 為了 Undo 允許停用線（checkLine allowInactive），這裡不能沿用——
    //   模擬區建立後才停用的線上若有 AI／手動新卡，會被寫進停用線、繞過「停用線不能有未完成已排卡」（lines route 停用前的檢查）。
    //   配到既有列的 move 由 applyOps 擋（checkLine 不允許停用線），只有新建列要在這裡先略過。
    if (restS.length > 0 && env.isLineActive) {
      const isActive = env.isLineActive
      for (const s of restS) {
        if (!isActive(s.lineId)) {
          skipped.push({ soLineKey: key, placementId: null, code: 'line_invalid', message: `這條線已停用，不能新排卡（${s.planDate}，${s.qty}），略過` })
        }
      }
      restS = restS.filter((s) => isActive(s.lineId))
    }
    if (restS.length > 0) {
      const supply = env.supplyOf(key)
      const skipAll = (code: AdoptionSkip['code'], message: string) => {
        for (const s of restS) skipped.push({ soLineKey: key, placementId: null, code, message: `${message}（${s.planDate}，${s.qty}）` })
      }
      if (!supply) skipAll('no_supply', '這個品項已不在待排池（可能已完成、已銷貨或結案），略過')
      else if (supply.total <= EPS) skipAll('not_placeable', '這個品項目前只剩不可排區塊（未寄出／出貨待確認）的量，略過（D22）')
      else {
        // 該行「採用後」的樣子：範圍外／已完成／待排區的列照舊＋配對列換成 target 的位置與數量＋要新建的列
        const pairByL = new Map(pairs.map((x) => [x.l.id, x.s]))
        const base: Placement[] = []
        for (const p of liveByKey.get(key) ?? []) {
          if (!p.completed && isInSimScope(p, scope)) {
            const s = pairByL.get(p.id)
            if (s) base.push({ ...p, planDate: s.planDate, lineId: s.lineId, qty: s.qty, sortIndex: s.sortIndex })
            continue // 沒配到的會被 unplace
          }
          base.push(p)
        }
        let pending = restS.map((s, i) => ({ s, p: targetAsPlacement(`__adopt_tmp_${i}`, s) }))
        for (let guard = 0; guard <= restS.length; guard++) {
          const a = allocateLine({ supply, placements: [...base, ...pending.map((r) => r.p)], today: env.today, openWeekends: env.openWeekends })
          const bad = pending
            .map((r) => {
              const pa = a.placements.find((x) => x.placementId === r.p.id)
              const disp = displayDateOf(r.p, env.today, env.openWeekends).date
              return pa && pa.readiness === 'pre' && pa.preReadyDate && disp && disp < pa.preReadyDate ? { r, ready: pa.preReadyDate } : null
            })
            .filter((x): x is { r: (typeof pending)[number]; ready: YMD } => x !== null)
            .sort((x, y) => (x.r.s.planDate < y.r.s.planDate ? -1 : x.r.s.planDate > y.r.s.planDate ? 1 : 0))
          if (bad.length === 0) break
          const first = bad[0]
          skipped.push({
            soLineKey: key, placementId: null, code: 'before_est_ready',
            message: `${first.r.s.planDate} 早於預估可包日 ${first.ready}（D22 預排卡只能排在可包日當天或之後），略過`,
          })
          pending = pending.filter((x) => x !== first.r)
        }
        for (const { s } of pending) {
          restoreOps.push({
            op: 'restore',
            row: {
              id: env.newId(), soLineKey: s.soLineKey, qty: s.qty, planDate: s.planDate, originalDate: s.planDate,
              source: s.source, originCardId: s.originCardId, lineId: s.lineId,
              estMinutesOverride: s.estMinutesOverride, sortIndex: s.sortIndex,
            },
          })
          counts.added++
        }
      }
    }

    // move 先搬「往後挪」的：allocateLine 依日期先後分配可包量，先把要挪到後面的卡移走，
    // 要挪到前面的卡才分得到可包片（否則 applyOps 的 D22 會在過渡狀態誤擋，例如兩張卡互換日期）
    moveOps.sort((x, y) => {
      const dx = (x as Extract<PlacementOp, { op: 'move' }>).toDate ?? ''
      const dy = (y as Extract<PlacementOp, { op: 'move' }>).toDate ?? ''
      return dx !== dy ? (dx > dy ? -1 : 1) : 0
    })
    ops.push(...unplaceOps, ...decOps, ...moveOps, ...incOps, ...restoreOps, ...reorderOps, ...minuteOps)
  }

  if (ops.length > AI_ADOPT_MAX_OPS) {
    skipped.push({
      soLineKey: '', placementId: null, code: 'too_many_ops',
      message: `這次要改 ${ops.length} 張卡，超過單次採用上限 ${AI_ADOPT_MAX_OPS}，請縮小範圍（例如減少天數或鎖定部分線）`,
    })
    counts.skipped = skipped.length
    return { ops: [], skipped, counts }
  }
  counts.skipped = skipped.length
  return { ops: rebaseVersions(ops, liveById), skipped, counts }
}

/** 前面失敗（沒做成）的 op 原本會讓那張卡 version +1；之後同一張卡的 op 版本號要扣回來，才不會被連坐成 version_conflict */
function withLag(op: PlacementOp, lag: ReadonlyMap<string, number>): PlacementOp {
  const d = (id: string) => lag.get(id) ?? 0
  switch (op.op) {
    case 'place':
    case 'restore':
      return op
    case 'merge': {
      if (d(op.targetId) === 0 && op.sources.every((s) => d(s.id) === 0)) return op
      return { ...op, targetVersion: op.targetVersion - d(op.targetId), sources: op.sources.map((s) => ({ id: s.id, version: s.version - d(s.id) })) }
    }
    default:
      return d(op.id) === 0 ? op : { ...op, version: op.version - d(op.id) }
  }
}

function bumpLag(op: PlacementOp, lag: Map<string, number>): void {
  const inc = (id: string) => lag.set(id, (lag.get(id) ?? 0) + 1)
  switch (op.op) {
    case 'place':
    case 'restore':
    case 'unplace':
      return // 建立／刪除列：之後不會再以版本號引用它（失敗時後續 op 自然 not_found／id_exists）
    case 'merge':
      inc(op.targetId)
      return
    default:
      inc(op.id)
  }
}

/**
 * 逐筆套用（§6.3）：applyOps 全有或全無，這裡依序一次套一個 op（對上一步成功後的狀態），失敗的記入 skipped 並繼續。
 * 同一張卡前面的 op 失敗時，後面 op 預期的版本號扣回失敗的次數（真的被別人改過的卡仍會 version_conflict）。
 * 最後把「原始 state.byId」與「最終狀態」比對，算出合併的 inserts／updates／deletes（同 applyOps 的定義，給 writeApplied 先減後增寫入）；
 * inverse＝各成功步驟 inverse 依相反順序串起來再以最終狀態 rebaseVersions（scheduleOps 已 export）；minuteEdits 合併（opIndex 換成原 ops 的索引）。
 * 回傳 ApplyOk（ok: true，即使全部失敗也回 ok——呼叫端看 applied.length 決定要不要寫）＋ applied（成功的 op，版本號為實際套用值）＋ skipped。
 */
export function applyOpsLenient(
  state: OpsState,
  ops: readonly PlacementOp[],
  ctx: OpsContext,
): ApplyOk & { applied: PlacementOp[]; skipped: LenientSkip[] } {
  const orig = state.byId
  let cur: ReadonlyMap<string, Placement> = orig
  const applied: PlacementOp[] = []
  const skipped: LenientSkip[] = []
  const invSteps: PlacementOp[][] = []
  const minuteEdits: MinuteEdit[] = []
  const lag = new Map<string, number>()
  ops.forEach((op, i) => {
    const adj = withLag(op, lag)
    const res = applyOps({ byId: cur }, [adj], ctx)
    if (res.ok) {
      cur = res.next
      applied.push(adj)
      invSteps.push(res.inverse)
      for (const e of res.minuteEdits) minuteEdits.push({ ...e, opIndex: i })
    } else {
      skipped.push({ opIndex: i, op, code: res.code, message: res.message })
      bumpLag(op, lag)
    }
  })

  const next = new Map(cur)
  const inserts: Placement[] = []
  const updates: { before: Placement; after: Placement }[] = []
  const deletes: Placement[] = []
  for (const [id, p] of next) {
    const o = orig.get(id)
    if (!o) inserts.push(p)
    else if (o !== p) updates.push({ before: o, after: p })
  }
  for (const [id, o] of orig) if (!next.has(id)) deletes.push(o)
  const inverse = rebaseVersions(invSteps.reverse().flat(), next)
  return { ok: true, next, inserts, updates, deletes, inverse, minuteEdits, applied, skipped }
}
