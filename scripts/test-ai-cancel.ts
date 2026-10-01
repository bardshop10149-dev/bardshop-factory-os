// 包裝專區 AI 排程「取消」：取消 API 純邏輯（app/api/packaging/ai/_lib/cancelFlow.ts）＋ db helpers（mock Supabase builder）
//   ＋ runner 協作式取消與依卡片數預算（lib/packaging/ai/runner.ts executeRun，全 mock deps）。
// 執行：npm run test:ai。不連 DB、不呼叫 Anthropic、不讀金鑰（callClaude 全部 mock；AiError 只拿來造錯誤形狀）。
/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cancelRunFlow, decideCancel, type CancelDeps } from '@/app/api/packaging/ai/_lib/cancelFlow'
import { aiErrorStatus } from '@/app/api/packaging/ai/_lib/aiRoute'
import {
  CANCELLED_BUT_APPLIED_NOTE,
  cancelAiRun,
  cancelMessage,
  getAiRunLite,
  getAiRunSummary,
  noteCancelledButApplied,
  toRunStatusInfo,
  updateAiRunIfRunning,
} from '@/lib/packaging/ai/db'
import { executeRun, type RunnerDeps } from '@/lib/packaging/ai/runner'
import { budgetForEstimate, estimateRunMs } from '@/lib/packaging/ai/estimate'
import { AI_RUN_BUDGET_MS, type AiRunPatch, type AiRunSummary } from '@/lib/packaging/ai/types'
import { AiError } from '@/lib/packaging/ai/claude'

const SB: any = {}
const ME = { email: 'me@x.tw', name: '乙' }
const NOW = Date.parse('2026-10-01T00:10:00.000Z')
const baseRun = (over: Partial<AiRunSummary> = {}): AiRunSummary => ({
  id: 9, sessionId: 4, ownerEmail: 'me@x.tw', ownerName: '乙', status: 'running', phase: 'thinking', errorCode: null, errorMessage: null,
  horizon: 4, mode: 'copy', windowDates: ['2026-10-01'], rulesId: null, summary: null, model: null, usage: null, durationMs: null,
  startedAt: '2026-10-01T00:08:30.000Z', finishedAt: null, applied: null, resultCount: null,
  locks: { placementIds: [], soNumbers: [], lineIds: [] }, baseVersion: 1, thresholds: [], validation: null, estimate: null, ...over,
})

// ── 取消 API 純邏輯 ──

test('decideCancel：不存在 not_found；已 done → run_not_running 且 extra.runStatus；本人／主管允許；非本人且不能編輯 → not_owner', () => {
  assert.equal((decideCancel(null, ME, true, 9) as any).code, 'not_found')
  const d: any = decideCancel(baseRun({ status: 'done' }), ME, true, 9)
  assert.equal(d.ok, false); assert.equal(d.code, 'run_not_running'); assert.equal(d.extra.runStatus, 'done')
  const f: any = decideCancel(baseRun({ status: 'failed', errorCode: 'ai_timeout' }), ME, true, 9)
  assert.equal(f.code, 'run_not_running'); assert.equal(f.extra.runErrorCode, 'ai_timeout')
  assert.deepEqual(decideCancel(baseRun(), ME, false, 9), { ok: true, byOwner: true })
  assert.deepEqual(decideCancel(baseRun({ ownerEmail: 'Other@x.tw' }), ME, true, 9), { ok: true, byOwner: false })
  assert.equal((decideCancel(baseRun({ ownerEmail: 'other@x.tw' }), ME, false, 9) as any).code, 'not_owner')
  // email 不分大小寫
  assert.equal(decideCancel(baseRun({ ownerEmail: 'ME@X.TW' }), ME, false, 9).ok, true)
  assert.equal(aiErrorStatus('run_not_running'), 409)
})

function flowDeps(o: { reads?: (AiRunSummary | null)[]; cancelled?: boolean } = {}) {
  const calls = { cancel: [] as any[], clear: [] as any[], log: [] as any[], reads: 0 }
  const seq = o.reads ?? [baseRun(), baseRun({ status: 'failed', errorCode: 'ai_cancelled', errorMessage: '已由 乙 取消（已消耗的 AI 用量仍會計費）' })]
  const deps: CancelDeps = {
    getAiRunSummary: async () => seq[Math.min(calls.reads++, seq.length - 1)],
    cancelAiRun: async (_sb, id, by, nowMs, startedAt) => { calls.cancel.push({ id, by, nowMs, startedAt }); return o.cancelled ?? true },
    clearRunningRun: async (_sb, sessionId, runId) => { calls.clear.push({ sessionId, runId }) },
    logAi: (async (_sb: any, me: any, kind: any, label: any, ops: any) => { calls.log.push({ me, kind, label, ops }) }) as any,
  }
  return { calls, deps }
}

test('cancelRunFlow 本人取消：cancelAiRun 帶姓名與 startedAt、clearRunningRun 與 logAi(kind ai_run, ops[0].action cancel, byOwner true) 各一次、回已取消的 run', async () => {
  const { deps, calls } = flowDeps()
  const out: any = await cancelRunFlow(SB, { id: 9, me: ME, canEdit: true, nowMs: NOW }, deps)
  assert.equal(out.ok, true)
  assert.equal(out.run.errorCode, 'ai_cancelled')
  assert.equal(calls.cancel.length, 1)
  assert.deepEqual(calls.cancel[0], { id: 9, by: { name: '乙', email: 'me@x.tw' }, nowMs: NOW, startedAt: '2026-10-01T00:08:30.000Z' })
  assert.deepEqual(calls.clear, [{ sessionId: 4, runId: 9 }])
  assert.equal(calls.log.length, 1)
  assert.equal(calls.log[0].kind, 'ai_run')
  assert.equal(calls.log[0].ops[0].action, 'cancel')
  assert.equal(calls.log[0].ops[0].byOwner, true)
  assert.equal(calls.log[0].ops[0].elapsedMs, 90_000)
  assert.equal(calls.log[0].ops[0].ownerEmail, 'me@x.tw')
})

test('cancelRunFlow 非本人但 packaging_admin：允許、ops.byOwner false、ownerEmail 是對方', async () => {
  const { deps, calls } = flowDeps({ reads: [baseRun({ ownerEmail: 'other@x.tw' }), baseRun({ ownerEmail: 'other@x.tw', status: 'failed', errorCode: 'ai_cancelled' })] })
  const out: any = await cancelRunFlow(SB, { id: 9, me: ME, canEdit: true, nowMs: NOW }, deps)
  assert.equal(out.ok, true)
  assert.equal(out.byOwner, false)
  assert.equal(calls.log[0].ops[0].byOwner, false)
  assert.equal(calls.log[0].ops[0].ownerEmail, 'other@x.tw')
})

test('cancelRunFlow 已 done → run_not_running，不呼叫 cancelAiRun／clear／log', async () => {
  const { deps, calls } = flowDeps({ reads: [baseRun({ status: 'done' })] })
  const out: any = await cancelRunFlow(SB, { id: 9, me: ME, canEdit: true, nowMs: NOW }, deps)
  assert.equal(out.ok, false); assert.equal(out.code, 'run_not_running'); assert.equal(out.extra.runStatus, 'done')
  assert.equal(calls.cancel.length, 0); assert.equal(calls.clear.length, 0); assert.equal(calls.log.length, 0)
})

test('cancelRunFlow 競態（cancelAiRun 回 false）→ 重讀最終狀態回 run_not_running，不 clear／不 log', async () => {
  const { deps, calls } = flowDeps({ cancelled: false, reads: [baseRun(), baseRun({ status: 'done' })] })
  const out: any = await cancelRunFlow(SB, { id: 9, me: ME, canEdit: true, nowMs: NOW }, deps)
  assert.equal(out.ok, false); assert.equal(out.code, 'run_not_running'); assert.equal(out.extra.runStatus, 'done')
  assert.equal(calls.clear.length, 0); assert.equal(calls.log.length, 0)
})

test('cancelRunFlow 不存在 → not_found', async () => {
  const { deps } = flowDeps({ reads: [null] })
  const out: any = await cancelRunFlow(SB, { id: 9, me: ME, canEdit: true, nowMs: NOW }, deps)
  assert.equal(out.code, 'not_found')
})

// ── db helpers：mock Supabase builder（記錄 update／select／eq 鏈；不連 DB） ──

type MockOp = { table: string; eq: [string, unknown][]; update?: any; select?: string; maybeSingle?: boolean }
function mockSb(script: (op: MockOp) => { data: unknown; error: unknown }) {
  const ops: MockOp[] = []
  const mk = (op: MockOp) => {
    const chain: any = {
      update(row: unknown) { op.update = row; return chain },
      select(cols: string) { op.select = cols; return chain },
      eq(k: string, v: unknown) { op.eq.push([k, v]); return chain },
      maybeSingle() { op.maybeSingle = true; return chain },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve().then(() => script(op)).then(res, rej) },
    }
    return chain
  }
  const sb: any = { ops, from(table: string) { const op: MockOp = { table, eq: [] }; ops.push(op); return mk(op) } }
  return sb as { ops: MockOp[] } & any
}

test('cancelAiRun：條件更新（eq id、eq status running、select id）、error_message 格式、finished_at、duration_ms', async () => {
  const sb = mockSb(() => ({ data: [{ id: 9 }], error: null }))
  const ok = await cancelAiRun(sb, 9, { name: '乙', email: 'me@x.tw' }, NOW, '2026-10-01T00:08:30.000Z')
  assert.equal(ok, true)
  const op = sb.ops[0]
  assert.equal(op.table, 'packaging_ai_runs')
  assert.deepEqual(op.eq, [['id', 9], ['status', 'running']])
  assert.equal(op.select, 'id')
  assert.equal(op.update.status, 'failed')
  assert.equal(op.update.phase, 'failed')
  assert.equal(op.update.error_code, 'ai_cancelled')
  assert.equal(op.update.error_message, '已由 乙 取消（已消耗的 AI 用量仍會計費）')
  assert.ok(op.update.error_message.length <= 500)
  assert.equal(op.update.finished_at, new Date(NOW).toISOString())
  assert.equal(op.update.duration_ms, 90_000)
  assert.equal('validation' in op.update, false, '不動 validation（保留暫存預估）')
  // 名字空白 → 用 email；超長名字截到 500 內
  assert.equal(cancelMessage({ name: '  ', email: 'me@x.tw' }), '已由 me@x.tw 取消（已消耗的 AI 用量仍會計費）')
  assert.ok(cancelMessage({ name: '王'.repeat(600), email: 'me@x.tw' }).length <= 500)
  // 沒改到（已結束）→ false
  const sb2 = mockSb(() => ({ data: [], error: null }))
  assert.equal(await cancelAiRun(sb2, 9, { name: null, email: 'me@x.tw' }, NOW, '2026-10-01T00:08:30.000Z'), false)
})

test('updateAiRunIfRunning：同 updateAiRun 欄位對照，多了 eq status running；0 列 → false；空 patch → true 不打 DB', async () => {
  const sb = mockSb(() => ({ data: [{ id: 9 }], error: null }))
  const interim = { interim: true as const, candidateCount: 3, sentCount: 2, estimateMs: 31_800, budgetMs: 120_000, capMs: AI_RUN_BUDGET_MS }
  assert.equal(await updateAiRunIfRunning(sb, 9, { phase: 'thinking', validation: interim, errorMessage: 'x'.repeat(600) }), true)
  const op = sb.ops[0]
  assert.deepEqual(op.eq, [['id', 9], ['status', 'running']])
  assert.equal(op.update.phase, 'thinking')
  assert.deepEqual(op.update.validation, interim)
  assert.equal(op.update.error_message.length, 500)
  const sb2 = mockSb(() => ({ data: [], error: null }))
  assert.equal(await updateAiRunIfRunning(sb2, 9, { phase: 'validating' }), false)
  const sb3 = mockSb(() => { throw new Error('should not hit DB') })
  assert.equal(await updateAiRunIfRunning(sb3, 9, {}), true)
  assert.equal(sb3.ops.length, 0)
})

test('getAiRunLite：只選 id, status, error_code；不存在 → null', async () => {
  const sb = mockSb(() => ({ data: { id: '9', status: 'failed', error_code: 'ai_cancelled' }, error: null }))
  assert.deepEqual(await getAiRunLite(sb, 9), { id: 9, status: 'failed', errorCode: 'ai_cancelled' })
  assert.equal(sb.ops[0].select, 'id, status, error_code')
  assert.equal(sb.ops[0].maybeSingle, true)
  const sb2 = mockSb(() => ({ data: null, error: null }))
  assert.equal(await getAiRunLite(sb2, 9), null)
})

test('noteCancelledButApplied：只改 error_code=ai_cancelled 的列、補註一次不重複、≤500 字', async () => {
  let msg = '已由 乙 取消（已消耗的 AI 用量仍會計費）'
  const sb = mockSb((op) => op.select ? { data: { error_message: msg }, error: null } : ((msg = op.update.error_message), { data: null, error: null }))
  await noteCancelledButApplied(sb, 9)
  assert.deepEqual(sb.ops[0].eq, [['id', 9], ['error_code', 'ai_cancelled']])
  assert.deepEqual(sb.ops[1].eq, [['id', 9], ['error_code', 'ai_cancelled']])
  assert.ok(msg.endsWith(CANCELLED_BUT_APPLIED_NOTE))
  assert.ok(msg.length <= 500)
  // 再呼叫一次：已含補註 → 不再 update
  const before = sb.ops.length
  await noteCancelledButApplied(sb, 9)
  assert.equal(sb.ops.length, before + 1, '只有 select，沒有第二次 update')
  // 不是取消列（select 回 null）→ 不 update
  const sb2 = mockSb(() => ({ data: null, error: null }))
  await noteCancelledButApplied(sb2, 9)
  assert.equal(sb2.ops.length, 1)
})

test('getAiRunSummary／toRunStatusInfo：validation 是暫存預估 → validation null、estimate 有值；完整報告 → estimate null', async () => {
  const row = {
    id: 9, session_id: 4, owner_email: 'me@x.tw', owner_name: '乙', status: 'running', phase: 'thinking', error_code: null, error_message: null,
    horizon: 4, mode: 'copy', window_dates: ['2026-10-01'], rules_id: null, summary: null, model: null, usage: null, duration_ms: null,
    started_at: '2026-10-01T00:08:30.000Z', finished_at: null, locks: { placementIds: [], soNumbers: [], lineIds: [] }, base_version: 1, thresholds: [],
    validation: { interim: true, candidateCount: 217, sentCount: 214, estimateMs: 222_600, budgetMs: 333_900, capMs: AI_RUN_BUDGET_MS },
  }
  const sb = mockSb(() => ({ data: row, error: null }))
  const s = (await getAiRunSummary(sb, 9))!
  assert.equal(s.validation, null)
  assert.deepEqual(s.estimate, { candidateCount: 217, sentCount: 214, estimateMs: 222_600, budgetMs: 333_900, capMs: AI_RUN_BUDGET_MS })
  assert.equal(s.applied, null)
  const st = toRunStatusInfo(s, NOW)
  assert.equal(st.elapsedMs, 90_000)
  assert.deepEqual(st.estimate, s.estimate)
  const sb2 = mockSb(() => ({ data: { ...row, status: 'done', phase: 'done', finished_at: '2026-10-01T00:11:00.000Z', duration_ms: 150_000, validation: { applied: true, resultCount: 5, accepted: 1 } }, error: null }))
  const s2 = (await getAiRunSummary(sb2, 9))!
  assert.equal(s2.estimate, null)
  assert.equal(s2.validation!.applied, true)
  assert.equal(s2.applied, true)
  assert.equal(toRunStatusInfo(s2, NOW).estimate, null)
})

// ── runner 協作式取消（executeRun 全 mock deps；nowMs 可控時鐘；計時器注入、不真的等） ──

const RUN_ID = 7
const SESSION_ID = 3
const WINDOW = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']
type FakeTimer = { fn: () => void; ms: number; cleared: boolean }

/** 可控時鐘＋假計時器：fireTimeouts() 觸發所有未清的 timeout（模擬預算用完）；tickIntervals() 跑一次 interval（模擬 5 秒到） */
function fakeTimers() {
  const timeouts: FakeTimer[] = []
  const intervals: FakeTimer[] = []
  const timers: RunnerDeps['timers'] = {
    setTimeout: (fn, ms) => { const h: FakeTimer = { fn, ms, cleared: false }; timeouts.push(h); return h },
    clearTimeout: (h) => { if (h) (h as FakeTimer).cleared = true },
    setInterval: (fn, ms) => { const h: FakeTimer = { fn, ms, cleared: false }; intervals.push(h); return h },
    clearInterval: (h) => { if (h) (h as FakeTimer).cleared = true },
  }
  return {
    timers, timeouts, intervals,
    fireTimeouts() { for (const t of timeouts) if (!t.cleared) t.fn() },
    tickIntervals() { for (const i of intervals) if (!i.cleared) i.fn() },
    liveIntervals() { return intervals.filter(i => !i.cleared).length },
  }
}

type RunnerOpts = {
  sentCount?: number
  prepMs?: number
  callClaude?: (signal: AbortSignal) => Promise<unknown>
  updateIfRunning?: (patch: AiRunPatch, n: number) => boolean
  lite?: (n: number) => { id: number; status: 'running' | 'done' | 'failed'; errorCode: any } | null
  casFail?: boolean
}

const AI_OK = { output: { assignments: [], summary: 'ok' }, model: 'm', usage: null }

/** 一組「一切正常」的 deps；每個測試覆寫需要的部分。calls 記錄每個 mock 的呼叫 */
function makeDeps(o: RunnerOpts = {}) {
  let now = 1_000_000
  const ft = fakeTimers()
  const calls = { updateIfRunning: [] as AiRunPatch[], lite: 0, cas: 0, clear: 0, note: 0, callClaude: 0 }
  const sentCount = o.sentCount ?? 214
  const run: any = {
    id: RUN_ID, sessionId: SESSION_ID, ownerEmail: 'a@x.tw', ownerName: '甲', status: 'running', phase: 'preparing', errorCode: null, errorMessage: null,
    horizon: 4, mode: 'copy', windowDates: WINDOW, rulesId: null, summary: null, model: null, usage: null, durationMs: null,
    startedAt: new Date(now).toISOString(), finishedAt: null, applied: null, resultCount: null,
    locks: { placementIds: [], soNumbers: [], lineIds: [] }, baseVersion: 5, thresholds: [], payload: null, basePlacements: [],
    resultPlacements: null, aiOutput: null, validation: null, estimate: null, simCapacity: null,
  }
  const session: any = {
    id: SESSION_ID, ownerEmail: 'a@x.tw', ownerName: '甲', horizon: 4, mode: 'copy', windowDates: WINDOW, lineIds: [1], locks: run.locks,
    placements: [], undo: [], version: 5, runningRunId: RUN_ID, simCapacity: null, createdAt: '', updatedAt: new Date(now).toISOString(),
  }
  const world: any = { pool: [], lines: [], capacityRows: [], lineRows: [], placements: [] }
  let pendingResolve: ((v: unknown) => void) | null = null
  const deps: any = {
    getClient: () => ({}),
    getAiRun: async () => run,
    getSimSessionById: async () => session,
    loadSimWorld: async () => { now += o.prepMs ?? 12_000; return world },
    getLatestRules: async () => null,
    listThresholds: async () => [],
    assembleSimBoard: () => ({ lanes: [] }),
    buildAiPayload: () => ({
      payload: { cards: Array.from({ length: sentCount }, (_, i) => ({ k: `C${i}` })) },
      keyMap: {},
      meta: { candidateCount: sentCount + 3, sentCount, notSent: 0, notSentKeys: [], unknownMinutes: { count: 0, categories: [] }, noThresholdCategories: [] },
    }),
    scanPayloadLeaks: () => [],
    isAiConfigured: () => true,
    callClaude: async (_payload: unknown, { signal }: { signal: AbortSignal }) => {
      calls.callClaude++
      if (o.callClaude) return o.callClaude(signal)
      // 預設：掛著等 signal（測試決定何時 abort）。真正的 callClaude 會把 SDK 的 APIUserAbortError 經 classifyAiError 包成 AiError('ai_timeout')；mock 照樣回這個形狀
      return new Promise((resolve, reject) => {
        pendingResolve = resolve
        signal.addEventListener('abort', () => reject(new AiError('ai_timeout', 'AI 思考太久、超過時間上限，這次沒有結果')))
      })
    },
    validateAiResult: () => ({ placements: [{ id: 'p1' }], report: { applied: true, accepted: 1, adjusted: [], dropped: [], capacityTrimmed: [], overtimeUsed: [], unknownMinutes: { count: 0, categories: [] }, noThresholdCategories: [], notSent: 0, keptCopy: 0, lockedKept: 0, resultCount: 1, aiUnplaced: [], aiWarnings: [], aiOvertime: [], ruleSuggestions: [] } }),
    decodeAiText: (s: string) => s,
    pushUndo: (u: unknown) => u,
    snapshotForUndo: () => ({}),
    isRowLocked: () => false,
    newId: () => 'id',
    nowMs: () => now,
    budgetMs: AI_RUN_BUDGET_MS,
    cancelPollMs: 5_000,
    aiEffort: () => 'high',
    timers: ft.timers,
    updateAiRunIfRunning: async (_sb: unknown, _id: number, patch: AiRunPatch) => { calls.updateIfRunning.push(patch); return o.updateIfRunning ? o.updateIfRunning(patch, calls.updateIfRunning.length) : true },
    getAiRunLite: async () => { calls.lite++; if (o.lite) return o.lite(calls.lite); return { id: RUN_ID, status: 'running', errorCode: null } },
    noteCancelledButApplied: async () => { calls.note++ },
    updateSimSessionCas: async () => { calls.cas++; return o.casFail ? null : { ...session, version: 6 } },
    clearRunningRun: async () => { calls.clear++ },
  }
  return { deps: deps as Partial<RunnerDeps>, calls, ft, resolveAi: () => pendingResolve?.(AI_OK) }
}

/** 收 console 輸出（runner 會 log；順便斷言 log 不帶內容） */
const quiet = async (fn: () => Promise<void>) => {
  const { log, error } = console
  const logs: string[] = []
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')) }
  try { await fn(); return { logs } } finally { console.log = log; console.error = error }
}
const flush = () => new Promise<void>(r => setImmediate(r))
const untilAiCalled = async (calls: { callClaude: number }) => { for (let i = 0; i < 20 && calls.callClaude === 0; i++) await flush() }

test('4. preparing 期間取消：thinking 條件更新回 false → 不呼叫 AI、不寫模擬區、釋放執行位一次、不再寫 run 列', async () => {
  const { deps, calls } = makeDeps({ updateIfRunning: (p) => p.phase !== 'thinking' })
  const { logs } = await quiet(() => executeRun(RUN_ID, deps))
  assert.equal(calls.callClaude, 0)
  assert.equal(calls.cas, 0)
  assert.equal(calls.clear, 1)
  assert.equal(calls.updateIfRunning.length, 1, '只有 thinking 那次寫入；沒有失敗寫入')
  assert.ok(logs.some(l => /cancelled at preparing/.test(l)))
  // log 不帶內容
  assert.ok(!logs.some(l => /C0|cards/.test(l)))
})

test('5. thinking 期間取消：getAiRunLite 回 failed → signal abort、callClaude reject、不寫任何 run 列、interval 已清', async () => {
  const { deps, calls, ft } = makeDeps({ lite: (n) => (n >= 2 ? { id: RUN_ID, status: 'failed', errorCode: 'ai_cancelled' } : { id: RUN_ID, status: 'running', errorCode: null }) })
  const p = quiet(() => executeRun(RUN_ID, deps))
  await untilAiCalled(calls)
  assert.equal(calls.callClaude, 1)
  assert.equal(ft.liveIntervals(), 1, 'callClaude 期間有一個輪詢 interval')
  ft.tickIntervals(); await flush()   // 第 1 次：running
  ft.tickIntervals(); await flush()   // 第 2 次：failed → abort
  const { logs } = await p
  assert.equal(calls.lite, 2)
  assert.equal(ft.liveIntervals(), 0, 'abort 後 interval 已清')
  assert.equal(calls.cas, 0)
  assert.equal(calls.updateIfRunning.length, 1, '只有 thinking 那次；catch 裡沒有失敗寫入（run 列終態由取消 route 寫）')
  assert.equal(calls.clear, 1)
  assert.ok(logs.some(l => /cancelled at thinking/.test(l)))
  assert.ok(!logs.some(l => /ai_timeout/.test(l)), '取消不能被寫成逾時')
})

test('6. 預算用完（非取消）：timeout 觸發 abort → 失敗寫入 errorCode ai_timeout（走條件更新）', async () => {
  const { deps, calls, ft } = makeDeps()
  const p = quiet(() => executeRun(RUN_ID, deps))
  await untilAiCalled(calls)
  ft.fireTimeouts()
  const { logs } = await p
  const fail = calls.updateIfRunning.find(x => x.status === 'failed')
  assert.ok(fail, '有失敗寫入')
  assert.equal(fail.errorCode, 'ai_timeout')
  assert.ok(fail.finishedAt)
  assert.ok(logs.some(l => /ai_timeout/.test(l)))
  assert.equal(calls.cas, 0)
})

test('7. 寫回前取消（檢查點 4）：AI 正常回、驗算正常、getAiRunLite 回 failed → 不寫模擬區、無 done 寫入', async () => {
  const { deps, calls } = makeDeps({
    callClaude: async () => AI_OK,
    lite: () => ({ id: RUN_ID, status: 'failed', errorCode: 'ai_cancelled' }),
  })
  const { logs } = await quiet(() => executeRun(RUN_ID, deps))
  assert.equal(calls.cas, 0)
  assert.ok(!calls.updateIfRunning.some(x => x.status === 'done'))
  assert.ok(calls.updateIfRunning.some(x => x.phase === 'validating'), 'validating 條件更新有走')
  assert.ok(logs.some(l => /cancelled at validating/.test(l)))
  assert.equal(calls.clear, 1)
})

test('8. 毫秒級競態：檢查點 4 仍 running、CAS 成功、done 條件更新回 false、run 已是 ai_cancelled → noteCancelledButApplied 一次', async () => {
  let doneAttempted = false
  const { deps, calls } = makeDeps({
    callClaude: async () => AI_OK,
    updateIfRunning: (p) => { if (p.status === 'done') { doneAttempted = true; return false } return true },
    lite: () => doneAttempted ? { id: RUN_ID, status: 'failed', errorCode: 'ai_cancelled' } : { id: RUN_ID, status: 'running', errorCode: null },
  })
  const { logs } = await quiet(() => executeRun(RUN_ID, deps))
  assert.equal(calls.cas, 1)
  assert.equal(calls.note, 1)
  assert.equal(calls.clear, 1)
  assert.ok(!logs.some(l => /done-update skipped/.test(l)))
})

test('8c. 同競態但 run 不是取消列（例如被標成 ai_stale）→ 不補註，LOG 留一行 done-update skipped（只有代號）', async () => {
  let doneAttempted = false
  const { deps, calls } = makeDeps({
    callClaude: async () => AI_OK,
    updateIfRunning: (p) => { if (p.status === 'done') { doneAttempted = true; return false } return true },
    lite: () => doneAttempted ? { id: RUN_ID, status: 'failed', errorCode: 'ai_stale' } : { id: RUN_ID, status: 'running', errorCode: null },
  })
  const { logs } = await quiet(() => executeRun(RUN_ID, deps))
  assert.equal(calls.cas, 1)
  assert.equal(calls.note, 0)
  assert.equal(calls.clear, 1)
  assert.ok(logs.some(l => /done-update skipped \(status=failed error_code=ai_stale\) but session written/.test(l)), logs.join(' | '))
  assert.ok(!logs.some(l => /C0|cards/.test(l)))
})

test('8d. 同競態但補註前 getAiRunLite 拋錯 → 吞掉記 error、不炸、仍釋放執行位', async () => {
  let doneAttempted = false
  const { deps, calls } = makeDeps({
    callClaude: async () => AI_OK,
    updateIfRunning: (p) => { if (p.status === 'done') { doneAttempted = true; return false } return true },
    lite: () => { if (doneAttempted) throw new Error('db down'); return { id: RUN_ID, status: 'running', errorCode: null } },
  })
  const { logs } = await quiet(() => executeRun(RUN_ID, deps))
  assert.equal(calls.note, 0)
  assert.equal(calls.clear, 1)
  assert.ok(logs.some(l => /無法補註取消訊息/.test(l)))
})

test('8b. 同競態但 CAS 失敗（模擬區被動過）→ 不補註', async () => {
  const { deps, calls } = makeDeps({ callClaude: async () => AI_OK, updateIfRunning: (p) => p.status !== 'done', casFail: true })
  await quiet(() => executeRun(RUN_ID, deps))
  assert.equal(calls.note, 0)
})

test('9. 預算只縮不放：100 張 → 第二個 timeout ＝ 依卡片數預算 − prep；預估 × 1.5 已達上限的張數 → 不重排（仍是硬上限一個）', async () => {
  {
    const { deps, ft } = makeDeps({ sentCount: 100, prepMs: 12_000, callClaude: async () => AI_OK })
    await quiet(() => executeRun(RUN_ID, deps))
    assert.equal(ft.timeouts.length, 2)
    assert.equal(ft.timeouts[0].ms, AI_RUN_BUDGET_MS)
    assert.equal(ft.timeouts[0].cleared, true, '硬上限那個被清掉')
    assert.equal(ft.timeouts[1].ms, budgetForEstimate(estimateRunMs(100, 4)) - 12_000)
    assert.equal(ft.timeouts[1].cleared, true, 'finally 清計時器')
  }
  {
    const many = 900
    assert.equal(budgetForEstimate(estimateRunMs(many, 4)), AI_RUN_BUDGET_MS, '前提：這個張數的預算已是上限')
    const { deps, ft } = makeDeps({ sentCount: many, callClaude: async () => AI_OK })
    await quiet(() => executeRun(RUN_ID, deps))
    assert.equal(ft.timeouts.length, 1, '預算已是上限 → 不重排')
    assert.equal(ft.timeouts[0].ms, AI_RUN_BUDGET_MS)
  }
})

test('10. thinking 寫入含 validation.interim 與正確 sentCount/estimateMs/budgetMs/capMs；done 報告含 sentCount/effort', async () => {
  const { deps, calls } = makeDeps({ sentCount: 214, callClaude: async () => AI_OK })
  await quiet(() => executeRun(RUN_ID, deps))
  const th = calls.updateIfRunning.find(x => x.phase === 'thinking')!
  assert.deepEqual(th.validation, { interim: true, candidateCount: 217, sentCount: 214, estimateMs: 222_600, budgetMs: budgetForEstimate(222_600), capMs: AI_RUN_BUDGET_MS })
  const done: any = calls.updateIfRunning.find(x => x.status === 'done')
  assert.equal(done.validation.sentCount, 214)
  assert.equal(done.validation.effort, 'high')
  assert.equal(done.validation.applied, true)
  assert.equal(calls.cas, 1)
})

test('10b. 0 張：不呼叫 AI、仍走條件更新寫 done、interim 也寫了', async () => {
  const { deps, calls } = makeDeps({ sentCount: 0 })
  await quiet(() => executeRun(RUN_ID, deps))
  assert.equal(calls.callClaude, 0)
  assert.equal(calls.updateIfRunning.length, 2)
  assert.equal((calls.updateIfRunning[0].validation as any).interim, true)
  assert.equal(calls.updateIfRunning[1].status, 'done')
  assert.equal((calls.updateIfRunning[1].validation as any).sentCount, 0)
})

test('11. 輪詢 getAiRunLite 拋錯（DB 抖動）→ 吞掉、AI 呼叫繼續、最終 done', async () => {
  const { deps, calls, ft, resolveAi } = makeDeps({ lite: (n) => { if (n <= 2) throw new Error('db hiccup'); return { id: RUN_ID, status: 'running', errorCode: null } } })
  const p = quiet(() => executeRun(RUN_ID, deps))
  await untilAiCalled(calls)
  ft.tickIntervals(); await flush()
  ft.tickIntervals(); await flush()
  resolveAi()
  await p
  assert.ok(calls.updateIfRunning.some(x => x.status === 'done'))
  assert.equal(calls.lite, 3, '兩次輪詢拋錯＋檢查點 4 一次')
})

test('12. 取消後不再寫 run 列：catch 裡的失敗寫入回 false 只 log「略過」', async () => {
  const { deps, calls } = makeDeps({
    callClaude: async () => { throw Object.assign(new Error('boom'), { name: 'TypeError' }) },
    updateIfRunning: (p) => p.status !== 'failed',
  })
  const { logs } = await quiet(() => executeRun(RUN_ID, deps))
  assert.ok(logs.some(l => /已被取消，略過失敗寫入/.test(l)))
  assert.equal(calls.clear, 1)
})
