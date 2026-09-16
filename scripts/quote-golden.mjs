// 報價引擎 golden 測試（設計書 §5.5 / §11-1）。
// 跑法（不需要 tsx，Node ≥ 22.6）：
//   node --experimental-strip-types scripts/quote-golden.mjs
// 每筆案例用「那張 Excel 當時的常數快照」餵引擎，驗的是邏輯不是現價。
import { readFileSync } from 'node:fs'
import { calcAcrylic } from '../lib/quote/engines/acrylic.ts'
import { resolveGoldenCase } from '../lib/quote/golden.ts'

const golden = JSON.parse(readFileSync(new URL('../lib/quote/seed/golden.json', import.meta.url), 'utf8'))
const TOL = 0.01

let failed = 0
for (const c of golden.cases) {
  const { input, settings } = resolveGoldenCase(golden, c)
  const r = calcAcrylic(input, settings)
  const seg = Object.fromEntries(r.segments.map((g) => [g.key, g.amount]))
  const checks = []
  const rel = (a, b) => (b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b))
  const push = (label, got, exp, tol = TOL) => {
    if (exp == null) return
    const err = rel(got, exp)
    checks.push({ label, got, exp, err, ok: err <= tol })
  }
  push('plates', r.plates, c.expected.plates, 1e-9)
  push('petPlates', r.petPlates, c.expected.petPlates, 1e-6)
  push('material', seg.material, c.expected.material, 1e-4)
  push('print', seg.print, c.expected.print, 1e-4)
  push('cut', seg.cut, c.expected.cut, 1e-4)
  push('packLabor', seg.packLabor, c.expected.packLabor, 1e-4)
  push('packMaterial', seg.packMaterial, c.expected.packMaterial, 1e-4)
  push('cost', r.costUnit, c.expected.cost)
  push('price', r.quoteUnit, c.expected.price)
  const ok = checks.every((k) => k.ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.key}  ${c.name}`)
  for (const k of checks) {
    const mark = k.ok ? '  ' : '!!'
    console.log(`   ${mark} ${k.label.padEnd(13)} got=${k.got.toFixed(6).padStart(16)}  exp=${String(k.exp).padStart(16)}  err=${(k.err * 100).toFixed(4)}%`)
  }
}
console.log(failed === 0 ? `\n全部 ${golden.cases.length} 筆通過（容差 ${TOL * 100}%）` : `\n${failed} 筆失敗`)
process.exit(failed === 0 ? 0 : 1)
