/**
 * golden case 解析：把 seed/golden.json 裡的案例展開成引擎輸入 + 當時常數快照。
 *
 * 支援 `same_as`（沿用另一筆的 input）與兩種覆寫：
 *   - input_override：qty / costRatio / scrapPct / packing_price（依品名改包材單價）
 *   - settings_override：深合併進 settings_v156（例如舊刀價 knifeOutlineMonthly: 9360）
 *
 * 沒有 runtime import（只 import type），node --experimental-strip-types 可直接載入。
 */
import type { AcrylicInput, AcrylicSettings } from './types'

export interface GoldenExpected {
  plates?: number
  petPlates?: number
  material?: number
  print?: number
  cut?: number
  packLabor?: number
  packMaterial?: number
  cost: number
  price: number
}

export interface GoldenCase {
  key: string
  name: string
  product: string
  template_version: string
  source_file: string
  source_sheet: string
  same_as?: string
  /** 稽核備註：來源檔可信度、手改處、核可建議（後台核可時顯示） */
  audit_note?: string
  input?: AcrylicInput
  input_override?: {
    qty?: number
    costRatio?: number
    scrapPct?: number
    packing_price?: Record<string, number>
  }
  settings_override?: DeepPartial<AcrylicSettings>
  expected: GoldenExpected
}

export interface GoldenFile {
  settings_v156: AcrylicSettings
  cases: GoldenCase[]
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 深合併（陣列整個取代，不逐項合） */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (patch === undefined ? base : (patch as T))
  const out: Record<string, unknown> = isPlainObject(base) ? { ...(base as Record<string, unknown>) } : {}
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v
  }
  return out as T
}

export function resolveGoldenCase(
  file: GoldenFile,
  c: GoldenCase,
): { input: AcrylicInput; settings: AcrylicSettings } {
  let baseCase: GoldenCase = c
  const seen = new Set<string>()
  while (baseCase.same_as) {
    if (seen.has(baseCase.key)) throw new Error(`golden same_as 循環：${baseCase.key}`)
    seen.add(baseCase.key)
    const next = file.cases.find((x) => x.key === baseCase.same_as)
    if (!next) throw new Error(`golden same_as 找不到：${baseCase.same_as}`)
    baseCase = next
  }
  if (!baseCase.input) throw new Error(`golden 缺 input：${baseCase.key}`)

  // 結構複製，避免覆寫時動到原本的 seed 物件
  const input: AcrylicInput = JSON.parse(JSON.stringify(baseCase.input))
  const ov = c.input_override
  if (ov) {
    if (ov.qty != null) input.qty = ov.qty
    if (ov.costRatio != null) input.costRatio = ov.costRatio
    if (ov.scrapPct != null) input.scrapPct = ov.scrapPct
    if (ov.packing_price) {
      for (const line of input.packing) {
        const p = ov.packing_price[line.item]
        if (p != null) line.unitPrice = p
      }
    }
  }

  // settings：先套 base case 的覆寫（same_as 的來源），再套自己的
  let settings: AcrylicSettings = JSON.parse(JSON.stringify(file.settings_v156))
  if (baseCase !== c && baseCase.settings_override) settings = deepMerge(settings, baseCase.settings_override)
  if (c.settings_override) settings = deepMerge(settings, c.settings_override)
  return { input, settings }
}
