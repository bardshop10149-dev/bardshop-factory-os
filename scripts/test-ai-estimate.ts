// 包裝專區 AI 排程：預估／預算純函式（lib/packaging/ai/estimate.ts）＋常數一致性＋前端進度文字（components/packaging/ai/simText.ts）
// 執行：npm run test:ai（node --experimental-strip-types --import ./scripts/ai-test-resolve.mjs --test …）
// 不連 DB、不呼叫 Anthropic、不讀金鑰。對照表用常數算出來印在測試輸出，回報時直接抄，不手抄數字。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { budgetForEstimate, estimateRunMs, estimateZone, type EstimateZone } from '@/lib/packaging/ai/estimate'
import {
  AI_BUDGET_FACTOR,
  AI_CANCEL_POLL_MS,
  AI_EST_FIXED_MS,
  AI_EST_LONG_HORIZON_FACTOR,
  AI_EST_PER_CARD_MS,
  AI_EST_WARN_RATIO,
  AI_MAX_CANDIDATES,
  AI_ROUTE_MAX_DURATION_MS,
  AI_RUN_BUDGET_MAX_MINUTES,
  AI_RUN_BUDGET_MIN_MS,
  AI_RUN_BUDGET_MS,
  AI_RUN_STALE_MS,
  aiDurationText,
  type AiHorizon,
} from '@/lib/packaging/ai/types'
import { AI_TIMEOUT_MS } from '@/lib/packaging/ai/claude'
import { RUN_ERROR_LABEL, durationText, isCancelledRun, runProgressPct, runStatusView } from '@/components/packaging/ai/simText'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('常數：route maxDuration 字面值 = AI_ROUTE_MAX_DURATION_MS；預算／SDK timeout／stale 都由它推導', () => {
  const src = readFileSync(resolve(ROOT, 'app/api/packaging/ai/session/run/route.ts'), 'utf8')
  const m = src.match(/^export const maxDuration = (\d+)\s*$/m)
  assert.ok(m, 'route.ts 必須有 export const maxDuration = <整數>')
  assert.equal(Number(m[1]) * 1000, AI_ROUTE_MAX_DURATION_MS, 'route.ts 的 maxDuration 字面值必須 = AI_ROUTE_MAX_DURATION_MS／1000（兩處要一起改）')
  assert.equal(AI_RUN_BUDGET_MS, AI_ROUTE_MAX_DURATION_MS - 30_000, 'runner 硬上限 = cap − 30 秒')
  assert.equal(AI_TIMEOUT_MS, AI_ROUTE_MAX_DURATION_MS - 20_000, 'SDK timeout = cap − 20 秒')
  assert.ok(AI_RUN_BUDGET_MS < AI_TIMEOUT_MS && AI_TIMEOUT_MS < AI_ROUTE_MAX_DURATION_MS, 'runner 預算先於 SDK timeout 先於 route 上限')
  assert.ok(AI_RUN_STALE_MS > AI_RUN_BUDGET_MS, 'stale 門檻必須 > runner 硬上限，否則預算內正常跑的 run 會被判成 stale')
  assert.equal(AI_RUN_STALE_MS, AI_ROUTE_MAX_DURATION_MS + 60_000)
  assert.equal(AI_RUN_BUDGET_MIN_MS, 120_000)
  assert.equal(AI_CANCEL_POLL_MS, 5_000)
  assert.equal(AI_RUN_BUDGET_MAX_MINUTES, Math.ceil(AI_RUN_BUDGET_MS / 60_000))
  assert.equal(aiDurationText(45_000), '45 秒')
  assert.equal(aiDurationText(6 * 60_000), '6 分鐘')
  assert.equal(aiDurationText(860_000), '14 分 20 秒')
  if ((AI_ROUTE_MAX_DURATION_MS as number) === 300_000) assert.equal(aiDurationText(AI_RUN_STALE_MS), '6 分鐘')
  console.log(`  cap=${AI_ROUTE_MAX_DURATION_MS / 1000}s budget=${AI_RUN_BUDGET_MS / 1000}s sdkTimeout=${AI_TIMEOUT_MS / 1000}s stale=${AI_RUN_STALE_MS / 1000}s（${aiDurationText(AI_RUN_STALE_MS)}）`)
})

test('estimateRunMs：214 張 4 天 222_600；0 張 30_000；214 張 6 天 244_860；負數／NaN 當 0', () => {
  assert.equal(AI_EST_FIXED_MS, 30_000)
  assert.equal(AI_EST_PER_CARD_MS, 900)
  assert.equal(AI_EST_LONG_HORIZON_FACTOR, 1.1)
  assert.equal(estimateRunMs(214, 4), 222_600)
  assert.equal(estimateRunMs(0, 4), 30_000)
  assert.equal(estimateRunMs(214, 6), 244_860)
  assert.equal(estimateRunMs(-5, 2), 30_000)
  assert.equal(estimateRunMs(Number.NaN, 4), 30_000)
})

test('budgetForEstimate：預估 × 1.5，clamp 到 [120 秒, AI_RUN_BUDGET_MS]', () => {
  assert.equal(AI_BUDGET_FACTOR, 1.5)
  assert.equal(budgetForEstimate(estimateRunMs(100, 4)), 180_000)
  assert.equal(budgetForEstimate(estimateRunMs(150, 4)), 247_500)
  // 214 張 raw＝333_900、500 張 raw＝720_000；cap 300（AI_RUN_BUDGET_MS 270_000）時都被 clamp 到上限，cap 800 時 214 張不會
  assert.equal(budgetForEstimate(estimateRunMs(214, 4)), Math.min(333_900, AI_RUN_BUDGET_MS))
  assert.equal(budgetForEstimate(estimateRunMs(500, 4)), Math.min(720_000, AI_RUN_BUDGET_MS))
  // raw 公式本身（注入夠大的 cap 不被 clamp）
  assert.equal(budgetForEstimate(estimateRunMs(214, 4), 1_000_000), 333_900)
  assert.equal(budgetForEstimate(estimateRunMs(500, 4), 1_000_000), 720_000)
  // 預估 × 1.5 ≥ 上限後恆為上限：卡再多預算不會再變大
  const nClamp = Math.ceil((AI_RUN_BUDGET_MS / AI_BUDGET_FACTOR - AI_EST_FIXED_MS) / AI_EST_PER_CARD_MS)
  for (const n of [nClamp, nClamp + 100, 900]) assert.equal(budgetForEstimate(estimateRunMs(n, 4)), AI_RUN_BUDGET_MS, `${n} 張`)
  assert.ok(budgetForEstimate(estimateRunMs(nClamp - 2, 4)) < AI_RUN_BUDGET_MS)
  // 下限：小預估 clamp 到 120 秒
  assert.equal(budgetForEstimate(60_000), AI_RUN_BUDGET_MIN_MS)
  // 注入較小的 cap（測試用）：clamp 到 cap（cap 比下限還小時以 cap 為準）
  assert.equal(budgetForEstimate(estimateRunMs(214, 4), 100_000), 100_000)
})

test('estimateZone：ok → warn → over 單調，邊界由常數算（不手抄張數）；實測 214 張／4 天必為 ok；cap 300 時 400 張內就會到 warn／over', () => {
  const z = (n: number, h: AiHorizon = 4): EstimateZone => {
    const estimateMs = estimateRunMs(n, h)
    return estimateZone({ estimateMs, budgetMs: budgetForEstimate(estimateMs), capMs: AI_RUN_BUDGET_MS })
  }
  let firstWarn = -1
  let firstOver = -1
  for (let n = 0; n <= 5000; n++) {
    const zone = z(n)
    if (firstWarn < 0 && zone === 'warn') firstWarn = n
    if (firstOver < 0 && zone === 'over') firstOver = n
    if (firstOver >= 0) break
  }
  assert.ok(firstWarn > 0 && firstOver > firstWarn, `warn 起點 ${firstWarn}、over 起點 ${firstOver}`)
  assert.equal(z(firstWarn - 1), 'ok')
  assert.equal(z(firstOver - 1), 'warn')
  // 區界定義：over＝預估 > cap；warn＝cap／預估 < AI_EST_WARN_RATIO
  assert.ok(estimateRunMs(firstOver, 4) > AI_RUN_BUDGET_MS && estimateRunMs(firstOver - 1, 4) <= AI_RUN_BUDGET_MS)
  assert.ok(AI_RUN_BUDGET_MS / estimateRunMs(firstWarn, 4) < AI_EST_WARN_RATIO && AI_RUN_BUDGET_MS / estimateRunMs(firstWarn - 1, 4) >= AI_EST_WARN_RATIO)
  assert.equal(z(100), 'ok')
  assert.equal(z(214), 'ok')
  // cap 300（AI_RUN_BUDGET_MS 270_000）：warn／over 起點都落在 AI_MAX_CANDIDATES（400）之內 → AiRunPanel 的 warn／over 文案是會出現的；
  // cap 改 800 後（AI_RUN_BUDGET_MS 770_000）400 張內到不了 warn。兩種 cap 都用同一條斷言（不手抄張數）。
  if ((AI_RUN_BUDGET_MS as number) <= 300_000) {
    assert.ok(firstOver <= AI_MAX_CANDIDATES, `cap 300 時 over 起點 ${firstOver} 應在候選上限 ${AI_MAX_CANDIDATES} 內`)
    assert.equal(z(AI_MAX_CANDIDATES, 4), 'over')
    assert.equal(z(AI_MAX_CANDIDATES, 6), 'over')
  } else {
    assert.equal(z(AI_MAX_CANDIDATES, 4), 'ok')
    assert.equal(z(AI_MAX_CANDIDATES, 6), 'ok')
  }
  const nClamp = Math.ceil((AI_RUN_BUDGET_MS / AI_BUDGET_FACTOR - AI_EST_FIXED_MS) / AI_EST_PER_CARD_MS)
  console.log(`  對照表（4 天；cap ${AI_RUN_BUDGET_MS / 1000}s）：預算自 ${nClamp} 張起恆為上限；warn 自 ${firstWarn} 張；over 自 ${firstOver} 張；候選上限 AI_MAX_CANDIDATES=${AI_MAX_CANDIDATES}`)
  for (const n of [50, 100, 150, 200, 214, 300, 400, 500, nClamp, firstWarn, firstOver]) {
    const e = estimateRunMs(n, 4)
    console.log(`    ${String(n).padStart(4)} 張：預估 ${durationText(e)}（${e / 1000}s）／預算 ${durationText(budgetForEstimate(e))}（${budgetForEstimate(e) / 1000}s）／${z(n)}`)
  }
  for (const n of [214, 400]) {
    const e = estimateRunMs(n, 6)
    console.log(`    ${String(n).padStart(4)} 張（6 天）：預估 ${durationText(e)}／預算 ${durationText(budgetForEstimate(e))}／${z(n, 6)}`)
  }
})

test('runProgressPct：preparing 2→8；thinking 依 elapsed/estimate 線性、封頂 95；沒預估退回舊曲線也封頂 95；validating 95；done 100', () => {
  assert.equal(runProgressPct('preparing', 0, null), 2)
  assert.equal(runProgressPct('preparing', 60_000, null), 8)
  const e = { estimateMs: 200_000 }
  assert.equal(runProgressPct('thinking', 0, e), 8)
  assert.equal(runProgressPct('thinking', 100_000, e), Math.round(8 + 87 * 0.5))
  assert.equal(runProgressPct('thinking', 200_000, e), 95)
  assert.equal(runProgressPct('thinking', 900_000, e), 95)
  assert.equal(runProgressPct('thinking', 900_000, null), 88)
  assert.ok(runProgressPct('thinking', 30_000, null) < 95)
  assert.equal(runProgressPct('validating', 1, e), 95)
  assert.equal(runProgressPct('done', 1, e), 100)
  assert.equal(runProgressPct('failed', 1, null), 100)
  // 負的 elapsed（時鐘偏差）不會算出負數
  assert.equal(runProgressPct('thinking', -5_000, e), 8)
})

test('runStatusView／isCancelledRun／RUN_ERROR_LABEL：failed+ai_cancelled → 已取消（琥珀）；其他 failed 仍是失敗（紅）；文案由常數推導', () => {
  const c = runStatusView({ status: 'failed', errorCode: 'ai_cancelled' })
  assert.equal(c.label, '已取消')
  assert.match(c.cls, /amber/)
  assert.equal(isCancelledRun({ status: 'failed', errorCode: 'ai_cancelled' }), true)
  assert.equal(isCancelledRun({ status: 'done', errorCode: null }), false)
  assert.match(runStatusView({ status: 'failed', errorCode: 'ai_timeout' }).cls, /rose/)
  assert.equal(runStatusView({ status: 'done', errorCode: null }).label, '完成')
  assert.equal(runStatusView({ status: 'running', errorCode: null }).label, '執行中')
  assert.ok(RUN_ERROR_LABEL.ai_cancelled.includes('計費'))
  assert.ok(RUN_ERROR_LABEL.ai_timeout.includes(durationText(AI_RUN_BUDGET_MS)), 'ai_timeout 文案帶硬上限')
  assert.ok(RUN_ERROR_LABEL.ai_stale.includes(durationText(AI_RUN_STALE_MS)), 'ai_stale 文案帶 stale 門檻')
  assert.ok(!/270|4\.5 分鐘|6 分鐘/.test(RUN_ERROR_LABEL.ai_timeout + RUN_ERROR_LABEL.ai_stale), '不得殘留寫死的秒數')
})
