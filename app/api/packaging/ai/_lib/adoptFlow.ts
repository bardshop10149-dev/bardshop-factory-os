// 包裝專區 P3 AI 模擬排程 — 採用（§6.1）與退回（§6.2）共用的「算差異 → 逐筆模擬套用」流程
//
// 採用與退回是同一件事的兩個方向（D86／D87）：讓正式區「範圍內（window_dates × 線）、未完成」的列變成某個目標——
//   採用：目標＝模擬區未鎖定線上的模擬列；退回：目標＝採用前 auto_before_ai 快照中落在同一範圍的列。
//   範圍外、待排區、已完成、鎖定的線一律不動（與採用對稱）。
// 為什麼不用 applyOps 整批：它全有或全無，一張卡在採用前剛被勾完成／銷貨就整批失敗；改用 applyOpsLenient 一筆一筆套，
//   失敗的自動略過並列入報告（D86 系統事實），其餘照寫。
// 本檔不寫 DB：只把 world（已讀好的正式區）與目標算成 ApplyOk，route 再決定要不要 writeApplied。

import type { Placement, PlacementOp, YMD } from '@/lib/packaging/scheduleTypes'
import type { ApplyOk } from '@/lib/packaging/scheduleOps'
import { applyOpsLenient, planAdoption } from '@/lib/packaging/ai/adopt'
import { buildSimOpsContext, isInSimScope } from '@/lib/packaging/ai/simState'
import type {
  AdoptionCounts,
  AdoptionEnv,
  AdoptionPlan,
  AdoptionSkip,
  AdoptionTargetRow,
  LenientSkip,
  LockedLineConflict,
  SimScope,
  SimSession,
  SimWorld,
} from '@/lib/packaging/ai/types'

export interface AdoptionRun {
  plan: AdoptionPlan
  /** 逐筆模擬套用的結果（applied＝成功的 op；inserts／updates／deletes 給 writeApplied） */
  res: ApplyOk & { applied: PlacementOp[]; skipped: LenientSkip[] }
  /** 扣掉套用失敗後的張數（skipped＝事前略過＋套用失敗） */
  counts: AdoptionCounts
  skipped: AdoptionSkip[]
  /** 自組 op 超過上限（planAdoption 回空 ops 並在 skipped 放 too_many_ops）→ route 回 400 */
  tooManyOps: boolean
}

export const sameDates = (a: readonly YMD[], b: readonly YMD[]): boolean =>
  a.length === b.length && a.every((d, i) => d === b[i])

/** 採用範圍（D87）：window_dates × 模擬區的線扣掉鎖定的線 */
export function adoptScopeOf(session: Pick<SimSession, 'windowDates' | 'lineIds' | 'locks'>): { scope: SimScope; lockedLineIds: number[] } {
  const locked = new Set(session.locks.lineIds)
  return {
    scope: { windowDates: session.windowDates, lineIds: session.lineIds.filter((id) => !locked.has(id)) },
    lockedLineIds: session.lineIds.filter((id) => locked.has(id)),
  }
}

/**
 * 採用的目標列：模擬區中落在採用範圍內的列。
 * source：AI 排的 → 'ai'；主管在模擬區手動放／挪的 → 'manual'；copy 未動的 → 沿用原正式列的 source（查不到用模擬列上複製來的值）。
 * pairId＝livePlacementId：配對時優先對回原正式列 → 用 move 保留原 id（原排定日、覆寫工時、學習紀錄的連結都還在）。
 */
export function adoptionTargetOf(session: Pick<SimSession, 'placements'>, scope: SimScope, live: readonly Placement[]): AdoptionTargetRow[] {
  const dates = new Set(scope.windowDates)
  const lines = new Set(scope.lineIds)
  const liveById = new Map(live.map((p) => [p.id, p]))
  return session.placements
    .filter((p) => dates.has(p.planDate) && lines.has(p.lineId))
    .map((p) => ({
      soLineKey: p.soLineKey,
      qty: p.qty,
      planDate: p.planDate,
      lineId: p.lineId,
      sortIndex: p.sortIndex,
      estMinutesOverride: p.estMinutesOverride,
      source: p.simSource === 'ai' ? 'ai' : p.simSource === 'manual'
        ? 'manual'
        : ((p.livePlacementId ? liveById.get(p.livePlacementId)?.source : undefined) ?? p.source ?? 'manual'),
      pairId: p.livePlacementId,
      originCardId: p.originCardId,
    }))
}

/** op 牽涉的 SO 行與列 id（略過清單顯示用） */
function opSubject(op: PlacementOp, liveById: ReadonlyMap<string, Placement>): { soLineKey: string; placementId: string | null } {
  switch (op.op) {
    case 'place': return { soLineKey: op.soLineKey, placementId: op.id }
    case 'restore': return { soLineKey: op.row.soLineKey, placementId: op.row.id }
    case 'merge': return { soLineKey: liveById.get(op.targetId)?.soLineKey ?? '', placementId: op.targetId }
    default: return { soLineKey: liveById.get(op.id)?.soLineKey ?? '', placementId: op.id }
  }
}

const COUNT_KEY: Partial<Record<PlacementOp['op'], keyof AdoptionCounts>> = {
  move: 'moved', restore: 'added', place: 'added', unplace: 'returned', setQty: 'qtyChanged', reorder: 'reordered', setMinutes: 'minutesChanged',
}

/**
 * 算差異並逐筆模擬套用（純計算，不寫 DB）。world 要用「寫入用」讀法（擺放即時、待排池 10 分鐘快取），跟正式區寫入 API 一致。
 * ctx 與模擬區操作同一套（simState.buildSimOpsContext：today、openWeekends、supplyOf、線、maxDate…），actor＝world.actor（採用者）。
 */
export function planAndApply(world: SimWorld, target: readonly AdoptionTargetRow[], scope: SimScope): AdoptionRun {
  const ctx = buildSimOpsContext(world)
  const activeLines = new Set(world.lines.filter((l) => l.active).map((l) => l.id))
  const env: AdoptionEnv = {
    today: world.today,
    openWeekends: ctx.openWeekends,
    supplyOf: (k) => ctx.supplyOf(k),
    newId: () => crypto.randomUUID(),
    // 模擬區建立後才停用的線：新卡不能 restore 進去（見 adopt.planAdoption）
    isLineActive: (id) => activeLines.has(id),
  }
  const plan = planAdoption(world.live, target, scope, env)
  const tooManyOps = plan.skipped.some((s) => s.code === 'too_many_ops')
  const liveById = new Map(world.live.map((p) => [p.id, p]))
  const res = applyOpsLenient({ byId: liveById }, tooManyOps ? [] : plan.ops, ctx)

  const counts: AdoptionCounts = { ...plan.counts }
  for (const s of res.skipped) {
    const k = COUNT_KEY[s.op.op]
    if (k) counts[k] = Math.max(0, counts[k] - 1)
  }
  const lenientSkips: AdoptionSkip[] = res.skipped.map((s) => ({ ...opSubject(s.op, liveById), code: s.code, message: s.message }))
  const skipped = [...plan.skipped, ...lenientSkips]
  counts.skipped = skipped.length
  return { plan, res, counts, skipped, tooManyOps }
}

/** 本批會讓正式區未完成張數淨增加多少（同 scheduleWrite 的總量上限檢查） */
export function openDeltaOf(res: Pick<ApplyOk, 'inserts' | 'deletes' | 'updates'>): number {
  const openOf = (list: readonly { completed: unknown }[]) => list.filter((p) => !p.completed).length
  return openOf(res.inserts) - openOf(res.deletes)
    + res.updates.reduce((n, u) => n + (u.before.completed && !u.after.completed ? 1 : !u.before.completed && u.after.completed ? -1 : 0), 0)
}

// ─────────────────────────────────────────────────────────────────────
// 範圍外的不一致（審查驗證 r1：鎖定線上的模擬內容與正式區不同 → 採用後卡片消失或重複）
// ─────────────────────────────────────────────────────────────────────

/** 會改變「有沒有這張卡／在哪天哪線／多少量」的 op；只改線內順序（reorder）或覆寫工時（setMinutes）不算不一致 */
const STRUCTURAL_OPS: ReadonlySet<PlacementOp['op']> = new Set<PlacementOp['op']>(['place', 'restore', 'move', 'unplace', 'setQty', 'split', 'merge'])

const mdOf = (d: YMD | null | undefined): string => {
  if (!d) return '待排區'
  const [, m, day] = d.split('-')
  return `${Number(m)}/${Number(day)}`
}

/** 一次 planAndApply「真的會套用成功」的結構性 op 牽涉的 SO 行 */
function structuralKeys(run: AdoptionRun, liveById: ReadonlyMap<string, Placement>): Set<string> {
  const out = new Set<string>()
  for (const op of run.res.applied) {
    if (!STRUCTURAL_OPS.has(op.op)) continue
    const k = opSubject(op, liveById).soLineKey
    if (k) out.add(k)
  }
  return out
}

/**
 * 範圍外（採用：鎖定的線；退回：該次採用範圍以外的線）× 同一個窗內，目標與正式區是否一致——
 * 用同一套 planAndApply 對那一塊算差異，「真的會套用成功」的結構性 op（新增／移動／移回待排池／改數量）＝不一致。
 * 為什麼要擋：採用／退回只覆蓋範圍內，同一個 SO 行若在範圍外也有不同的列，結果會「一半照目標、一半照正式區」：
 *   模擬區把卡從 A 線換到鎖定的 B 線 → 採用只看到 A 線少了這張 → unplace，卡片從排程消失；反過來則重複排（驗證 r1 情境 A～C）。
 * 什麼算衝突（其餘範圍外的差異照 D87「範圍外完全不動」放行，不擋）：
 *   (1) 這個 SO 行在範圍內也會被改（inScopeRun 有它的結構性 op）→ 兩邊一起算才對得上量，只改一邊必定消失或重複；
 *   (2) 採用：範圍外那一塊是模擬區自己改過的（editedKeys：鎖定線上有 AI／手動列）→ 主管在畫面上看到的版本不會被採用。
 *   只有正式區在範圍外被別人改過、且這個 SO 行不在範圍內變動的 → 不擋（鎖定＝那條線不動，別人在正式區的修改照樣保留）。
 * 範圍外已完成的卡：模擬區複製後正式區才勾完成的列（pairId 指向已完成列）不算——那是正式區的事實，不是不一致（守恆也會擋下重排）。
 * 純計算，不寫 DB。
 */
export function outsideScopeConflicts(p: {
  world: SimWorld
  /** 範圍外那一塊（同一個窗 × 範圍外的線） */
  scope: SimScope
  /** 目標（模擬列／採用前快照列）中落在 scope 內的 */
  target: readonly AdoptionTargetRow[]
  /** 範圍內這一次的差異結果（它會動到哪些 SO 行） */
  inScopeRun: AdoptionRun
  /** 採用：模擬區在範圍外改過的 SO 行（非 copy 的模擬列）；退回不用 */
  editedKeys?: ReadonlySet<string>
  /** 訊息裡「目標」的稱呼（採用：模擬區；退回：採用前） */
  targetLabel?: string
}): LockedLineConflict[] {
  const { scope } = p
  if (scope.lineIds.length === 0 || scope.windowDates.length === 0) return []
  // 以「範圍內這一次套用之後」的正式區來算範圍外：範圍內的變動不會碰到範圍外的列（op 只動範圍內的列），
  //   但會改變守恆（例：模擬區把卡從 A 線換到鎖定的 B 線 → 範圍內 unplace 之後，B 線那張才「放得進去」、才看得出不一致）
  const world: SimWorld = { ...p.world, live: [...p.inScopeRun.res.next.values()] }
  const liveById = new Map(world.live.map((x) => [x.id, x]))
  const target = p.target.filter((t) => isInSimScope(t, scope) && !(t.pairId && liveById.get(t.pairId)?.completed))
  const outside = planAndApply(world, target, scope)
  const diffs = outside.res.applied.filter((op) => STRUCTURAL_OPS.has(op.op))
  if (diffs.length === 0) return []
  // 範圍內的 op 引用的是「套用前」的列（unplace 掉的列在套用後已不存在）→ 用原本的正式區對回 SO 行
  const inKeys = structuralKeys(p.inScopeRun, new Map(p.world.live.map((x) => [x.id, x])))
  const tl = p.targetLabel ?? '目標'
  const edited = p.editedKeys ?? new Set<string>()
  const lineName = (id: number | null | undefined): string =>
    id == null ? '' : world.lines.find((l) => l.id === id)?.name ?? `#${id}`
  const out: LockedLineConflict[] = []
  for (const op of diffs) {
    const key = opSubject(op, liveById).soLineKey
    if (!key || !(inKeys.has(key) || edited.has(key))) continue
    const why = inKeys.has(key) ? '（同一品項在範圍內也要改，只改一邊會讓卡片消失或重複）' : '（模擬區改過這條鎖定線，採用不會套用）'
    if (op.op === 'restore') {
      const r = op.row
      out.push({ soLineKey: key, placementId: null, lineId: r.lineId ?? null, planDate: r.planDate ?? null,
        message: `${lineName(r.lineId)} ${mdOf(r.planDate)}：${tl}有 ${r.qty}，正式排程沒有${why}` })
      continue
    }
    const id = op.op === 'merge' ? op.targetId : op.op === 'place' ? '' : op.id
    const l = liveById.get(id)
    const at = l ? `${lineName(l.lineId)} ${mdOf(l.planDate)}` : ''
    let msg: string
    if (op.op === 'move') msg = `正式排程在 ${at}，${tl}在 ${lineName(op.lineId ?? l?.lineId)} ${mdOf(op.toDate)}`
    else if (op.op === 'unplace') msg = `${at}：正式排程有 ${l?.qty ?? '?'}，${tl}沒有`
    else if (op.op === 'setQty') msg = `${at}：正式排程 ${l?.qty ?? '?'}、${tl} ${op.qty}`
    else msg = `${at}：正式排程與${tl}不同`
    out.push({ soLineKey: key, placementId: l?.id ?? null, lineId: l?.lineId ?? null, planDate: l?.planDate ?? null, message: msg + why })
  }
  return out
}

/**
 * 採用前的檢查（§6.1 第 2 點「鎖定線完全不動」的前提）：鎖定線上的模擬內容與正式區不一致、會讓採用結果和模擬區不同的項目。
 * 非空 → 採用 route 回 409 locked_line_diverged（預覽列出來、採用鈕停用），請主管解除那條線的鎖定（以模擬版為準一起覆蓋）或重設模擬區。
 */
export function lockedLineConflicts(
  world: SimWorld,
  session: Pick<SimSession, 'windowDates' | 'lineIds' | 'locks' | 'placements'>,
  adopted: AdoptionRun,
): LockedLineConflict[] {
  const { lockedLineIds } = adoptScopeOf(session)
  if (lockedLineIds.length === 0) return []
  const scope: SimScope = { windowDates: session.windowDates, lineIds: lockedLineIds }
  const editedKeys = new Set(session.placements.filter((x) => isInSimScope(x, scope) && x.simSource !== 'copy').map((x) => x.soLineKey))
  return outsideScopeConflicts({ world, scope, target: adoptionTargetOf(session, scope, world.live), inScopeRun: adopted, editedKeys, targetLabel: '模擬區' })
}

/** 409 locked_line_diverged 的訊息（採用） */
export function lockedConflictMessage(n: number): string {
  return `鎖定的線上有 ${n} 項和正式排程不一致；採用只會覆蓋未鎖定的線，照這樣採用會讓卡片消失或重複排。`
    + '請解除這些線的鎖定（採用時以模擬版為準一起覆蓋），或重設模擬區後再採用'
}
