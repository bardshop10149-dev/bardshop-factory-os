// Excel 匯入解析自我驗證（設計書 §8-④）。
// 跑法（Node ≥ 22.6，不需要 tsx；node_modules 要有 xlsx）：
//   node --experimental-strip-types scripts/quote-import-test.mjs [Excel 目錄]
// 對 golden.json 已知的四份檔案跑 parseQuoteWorkbook，把每頁產出的 input 餵 calcAcrylic
// （settings = seed acrylic_settings 深合併 settings_snapshot），成本要對到該頁 B5（誤差 < 0.5%）。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { parseQuoteWorkbook, diffPrices } from '../lib/quote/excelImport.ts'
import { calcAcrylic } from '../lib/quote/engines/acrylic.ts'
import { deepMerge } from '../lib/quote/golden.ts'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')

const DIR = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'C:\\Users\\User\\AI報價工具+常平訂單整理\\常平報價表'
const FILES = [
  'BA26080503 澄鑫 C款_柯氏报价模板_v1.5.2.xlsx',
  'BA26082304 关关 登山沟_报价模板_v1.5.6.xlsx',
  'BA26090701 ANDY 烫金画板_报价模板_v1.5.6.xlsx',
  '_报价模板_v1.5.6.xlsx',
]
const TOL = 0.005
const VERBOSE = process.argv.includes('--verbose')

const seed = JSON.parse(readFileSync(new URL('../lib/quote/seed/settings.json', import.meta.url), 'utf8'))
const golden = JSON.parse(readFileSync(new URL('../lib/quote/seed/golden.json', import.meta.url), 'utf8'))
const base = seed.acrylic_settings

// 用 seed golden 的 v1.5.6 板價當「現有價格表」示範差異比對
const currentPrices = new Map()
for (const c of golden.cases) {
  for (const b of c.input?.boards ?? []) currentPrices.set(b.item, b.unitPrice)
}

let failed = 0
let total = 0
const available = new Set(readdirSync(DIR))
for (const f of FILES) {
  if (!available.has(f)) {
    console.log(`SKIP  ${f}（目錄裡沒有）`)
    continue
  }
  const buf = readFileSync(join(DIR, f))
  const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true })
  const parsed = parseQuoteWorkbook(wb, f, base)
  console.log(`\n=== ${f}`)
  console.log(`    版本：${parsed.templateVersion}；价格表 ${parsed.priceItems.length} 項；成本分頁 ${parsed.goldenProposals.length} 頁`)
  for (const n of parsed.notes) console.log(`    note: ${n}`)
  const diff = diffPrices(parsed.priceItems, currentPrices)
  const stat = {}
  for (const d of diff) stat[d.status] = (stat[d.status] ?? 0) + 1
  console.log(`    價格差異：${JSON.stringify(stat)}`)
  for (const d of diff.filter((x) => x.status === 'invalid' || x.status === 'up' || x.status === 'down')) {
    console.log(`      ${d.status.padEnd(7)} ${d.name}  ${d.current ?? '-'} → ${d.incoming}${d.note ? `  (${d.note})` : ''}`)
  }

  for (const p of parsed.goldenProposals) {
    total++
    const settings = deepMerge(JSON.parse(JSON.stringify(base)), p.settings_snapshot)
    let r
    try {
      r = calcAcrylic(p.input, settings)
    } catch (e) {
      failed++
      console.log(`FAIL  ${p.name}  引擎丟錯：${e instanceof Error ? e.message : e}`)
      continue
    }
    const errCost = p.expected_cost ? Math.abs(r.costUnit - p.expected_cost) / p.expected_cost : Math.abs(r.costUnit)
    const errPrice = p.expected_price ? Math.abs(r.quoteUnit - p.expected_price) / p.expected_price : Math.abs(r.quoteUnit)
    const ok = errCost <= TOL && errPrice <= TOL
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.name}`)
    console.log(`      cost  got=${r.costUnit.toFixed(6)}  exp=${p.expected_cost}  err=${(errCost * 100).toFixed(4)}%`)
    console.log(`      price got=${r.quoteUnit.toFixed(6)}  exp=${p.expected_price}  err=${(errPrice * 100).toFixed(4)}%`)
    console.log(`      snapshot=${JSON.stringify(p.settings_snapshot)}`)
    for (const w of p.warnings) console.log(`      warn: ${w}`)
    if (VERBOSE || !ok) {
      console.log(`      input=${JSON.stringify(p.input)}`)
      for (const g of r.segments) console.log(`      seg ${g.key.padEnd(12)} ${g.amount.toFixed(4)}`)
    }
  }
}
console.log(failed === 0 ? `\n全部 ${total} 頁通過（容差 ${TOL * 100}%）` : `\n${failed} / ${total} 頁失敗`)
process.exit(failed === 0 ? 0 : 1)
