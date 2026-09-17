/**
 * 報價計算機 — 資料層（quote_* 五張表 ⇄ 引擎輸入）。
 *
 * 角色分工：
 *   - 引擎（engines/acrylic.ts）是純函式，只吃「已解析成數字」的 AcrylicInput。
 *   - 這裡負責把 quote_products.config（品項允許什麼）＋ quote_price_items（多少錢）
 *     ＋ quote_settings（全域常數）＋ 業務的 CalcRequest 組成 AcrylicInput，
 *     並把「用到哪些價格」記成 priceSnapshot 給 log 追溯。
 *
 * DEV seed fallback：
 *   - `QUOTE_DEV_SEED=1`，或（非 production）查表時 Supabase 回「relation does not exist /
 *     could not find the table / schema cache」→ 改用 lib/quote/seed/*.json，回 devSeed=true。
 *   - production 沒有 QUOTE_DEV_SEED 而表不存在 → 丟 QuoteTableMissingError（code 'TABLE_MISSING'），
 *     route 用 quoteErrorResponse() 轉成 503 並提示跑 sql/20260913_quote_system.sql。
 *   - devSeed 模式一律不寫 DB。
 */
import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { calcAcrylic } from './engines/acrylic'
import { deepMerge, resolveGoldenCase, type GoldenFile } from './golden'
import settingsSeedJson from './seed/settings.json'
import productsSeedJson from './seed/products.json'
import goldenSeedJson from './seed/golden.json'
import type {
  AcrylicInput,
  AcrylicSettings,
  BoardLine,
  LaminateLine,
  PackingLine,
  PetLine,
  Plant,
  PriceItem,
  PrintMethod,
  PrintSpec,
  ProductConfig,
  ProductPacking,
  ProductStatus,
  Sides,
} from './types'
import type {
  AdminPriceRow,
  AdminProductRow,
  CalcRequest,
  CalcResponse,
  CalcSizeRequest,
  CalcSizeResult,
  GoldenRow,
  QuoteSettingsMap,
  VerifyCaseResult,
  VerifyResponse,
 QuoteMode,} from './api'

/* ---------------------------------------------------------------- 錯誤與回應 */

export const TABLE_MISSING_MESSAGE =
  '報價系統資料表尚未建立，請通知管理員執行 sql/20260913_quote_system.sql'

export class QuoteTableMissingError extends Error {
  readonly code = 'TABLE_MISSING'
  constructor() {
    super(TABLE_MISSING_MESSAGE)
    this.name = 'QuoteTableMissingError'
  }
}

type PgErr = { message: string; code?: string | null; details?: string | null; hint?: string | null }

/** PostgREST 對「表不存在」有兩種講法：Postgres 42P01，或 schema cache 找不到（PGRST205） */
export function isTableMissingError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const o = e as PgErr
  const code = String(o.code ?? '')
  if (code === '42P01' || code === 'PGRST205') return true
  const m = String(o.message ?? '').toLowerCase()
  return (
    (m.includes('relation') && m.includes('does not exist')) ||
    m.includes('could not find the table') ||
    m.includes('schema cache')
  )
}

/** route 的 catch 統一走這裡：表不存在 → 503；其餘 → 500 */
export function quoteErrorResponse(e: unknown): NextResponse {
  const code = e && typeof e === 'object' ? (e as { code?: string }).code : undefined
  if (e instanceof QuoteTableMissingError || code === 'TABLE_MISSING') {
    return NextResponse.json({ success: false, error: TABLE_MISSING_MESSAGE, code: 'TABLE_MISSING' }, { status: 503 })
  }
  return NextResponse.json({ success: false, error: describeError(e) }, { status: 500 })
}

/* ---------------------------------------------------------------- Context */

export interface QuoteCtx {
  supabase: SupabaseClient | null
  /** 一旦為 true，之後所有讀取都走 seed，寫入一律跳過 */
  devSeed: boolean
  /** 查到表不存在時可否退回 seed（開發環境或 QUOTE_DEV_SEED=1） */
  allowSeedFallback: boolean
}

export function createQuoteCtx(): QuoteCtx {
  const forced = process.env.QUOTE_DEV_SEED === '1'
  const allowSeedFallback = forced || process.env.NODE_ENV !== 'production'
  if (forced) return { supabase: null, devSeed: true, allowSeedFallback }
  return { supabase: getSupabaseAdminClient(), devSeed: false, allowSeedFallback }
}

/** 需要 Supabase client 的寫入操作用這個；devSeed 模式回 null 讓呼叫端跳過 */
export function writableClient(ctx: QuoteCtx): SupabaseClient | null {
  if (ctx.devSeed || !ctx.supabase) return null
  return ctx.supabase
}

type QueryResult<T> = { data: T | null; error: PgErr | null }

/**
 * 跑一次查表；表不存在時依 ctx 決定退回 seed 或丟 TABLE_MISSING。
 * 回傳 null 只在「查表成功但 data 為 null」（maybeSingle 沒找到）的情況。
 */
async function withTable<T>(
  ctx: QuoteCtx,
  run: (sb: SupabaseClient) => PromiseLike<QueryResult<T>>,
  seed: () => T,
): Promise<T | null> {
  if (ctx.devSeed || !ctx.supabase) {
    ctx.devSeed = true
    return seed()
  }
  const { data, error } = await run(ctx.supabase)
  if (error) {
    if (isTableMissingError(error)) {
      if (ctx.allowSeedFallback) {
        ctx.devSeed = true
        return seed()
      }
      throw new QuoteTableMissingError()
    }
    throw new Error(describeError(error))
  }
  return data
}

/* ---------------------------------------------------------------- Seed 讀取 */

type SeedProduct = {
  id: string
  family: 'acrylic'
  category: string
  name: string
  plant: Plant
  status: ProductStatus
  sort_order: number
  config: ProductConfig
}

type SeedPriceItem = Partial<AdminPriceRow> & { name: string; price: number; group: string }

const settingsSeed = settingsSeedJson as unknown as QuoteSettingsMap
const productsSeed = productsSeedJson as unknown as SeedProduct[]
const goldenSeed = goldenSeedJson as unknown as GoldenFile

let priceSeedCache: SeedPriceItem[] | null = null

/** priceItems.json 由 seed-sql 代理產生，可能還不存在 → 當空陣列（所以用 fs 而不是 import） */
function loadPriceSeed(): SeedPriceItem[] {
  if (priceSeedCache) return priceSeedCache
  try {
    const file = path.join(process.cwd(), 'lib', 'quote', 'seed', 'priceItems.json')
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    priceSeedCache = Array.isArray(parsed) ? (parsed as SeedPriceItem[]) : []
  } catch {
    priceSeedCache = []
  }
  return priceSeedCache
}

const SEED_TS = '2026-09-13T00:00:00.000Z'

function seedProductRow(p: SeedProduct): AdminProductRow {
  return {
    id: p.id,
    family: 'acrylic',
    category: p.category,
    name: p.name,
    plant: p.plant,
    status: p.status,
    version: 1,
    config: p.config,
    sort_order: p.sort_order,
    updated_by: null,
    updated_at: SEED_TS,
    published_at: p.status === 'published' ? SEED_TS : null,
  }
}

function seedPriceRow(s: SeedPriceItem, idx: number): AdminPriceRow {
  return {
    id: s.id ?? `seed-${idx}`,
    group: s.group,
    name: s.name,
    display_name: s.display_name ?? null,
    unit: s.unit ?? '',
    price: Number(s.price),
    currency: s.currency ?? 'RMB',
    plant: (s.plant ?? 'changping') as Plant,
    attrs: s.attrs ?? null,
    effective_from: s.effective_from ?? null,
    source_file: s.source_file ?? null,
    argo_part_code: s.argo_part_code ?? null,
    erp_suggested_price: null,
    erp_suggested_currency: null,
    erp_suggested_at: null,
    updated_by: null,
    updated_at: SEED_TS,
    note: s.note ?? null,
  }
}

function seedGoldenRows(productId: string): GoldenRow[] {
  const rows: GoldenRow[] = []
  for (const c of goldenSeed.cases) {
    if (c.product !== productId) continue
    try {
      const { input, settings } = resolveGoldenCase(goldenSeed, c)
      rows.push({
        id: c.key,
        product_id: productId,
        name: c.name,
        status: 'proposed',
        template_version: c.template_version,
        source_file: c.source_file,
        source_sheet: c.source_sheet,
        audit_note: c.audit_note ?? null,
        input,
        settings_snapshot: settings,
        expected_cost: c.expected.cost,
        expected_price: c.expected.price,
        tolerance: 0.01,
        last_result: null,
        last_diff: null,
        last_run_at: null,
        approved_by: null,
        approved_at: null,
      })
    } catch {
      // seed 檔壞掉不該讓整個 route 掛掉；跳過那一筆
    }
  }
  return rows
}

/* ---------------------------------------------------------------- 讀取：settings */

const SETTINGS_KEYS: (keyof QuoteSettingsMap)[] = [
  'acrylic_settings',
  'fx_rmb_twd',
  'markup_bardshop_pct',
  'quote_validity_days',
  'rate_version',
]

/** quote_settings → QuoteSettingsMap；缺的 key 用 seed 補，acrylic_settings 缺的子鍵也用 seed 補 */
export async function loadSettings(ctx: QuoteCtx): Promise<QuoteSettingsMap> {
  const rows = await withTable<{ key: string; value: unknown }[]>(
    ctx,
    (sb) => sb.from('quote_settings').select('key, value'),
    () => [],
  )
  const base: QuoteSettingsMap = JSON.parse(JSON.stringify(settingsSeed))
  for (const r of rows ?? []) {
    switch (r.key as keyof QuoteSettingsMap) {
      case 'acrylic_settings':
        base.acrylic_settings = deepMerge<AcrylicSettings>(base.acrylic_settings, r.value)
        break
      case 'fx_rmb_twd': {
        const v = r.value as { rate?: unknown; as_of?: unknown } | null
        const rate = Number(v?.rate)
        base.fx_rmb_twd = v && Number.isFinite(rate) && rate > 0 ? { rate, as_of: String(v.as_of ?? '') } : null
        break
      }
      case 'markup_bardshop_pct': {
        const n = Number(r.value)
        if (Number.isFinite(n)) base.markup_bardshop_pct = n
        break
      }
      case 'quote_validity_days': {
        const n = Number(r.value)
        if (Number.isFinite(n) && n > 0) base.quote_validity_days = n
        break
      }
      case 'rate_version':
        if (typeof r.value === 'string' && r.value) base.rate_version = r.value
        break
      default:
        break
    }
  }
  return base
}

export { SETTINGS_KEYS }

/* ---------------------------------------------------------------- 讀取：價格表 */

const PRICE_SELECT =
  'id, group, name, display_name, unit, price, currency, plant, attrs, effective_from, source_file, argo_part_code, erp_suggested_price, erp_suggested_currency, erp_suggested_at, updated_by, updated_at, note'

type PriceDbRow = {
  id: string; group: string; name: string; display_name: string | null; unit: string | null
  price: number | string | null; currency: string | null; plant: string | null
  attrs: Record<string, unknown> | null; effective_from: string | null; source_file: string | null
  argo_part_code: string | null; erp_suggested_price: number | string | null
  erp_suggested_currency: string | null; erp_suggested_at: string | null
  updated_by: string | null; updated_at: string | null; note: string | null
}

function mapPriceRow(r: PriceDbRow): AdminPriceRow {
  const sug = r.erp_suggested_price == null ? null : Number(r.erp_suggested_price)
  return {
    id: r.id,
    group: r.group,
    name: r.name,
    display_name: r.display_name,
    unit: r.unit ?? '',
    price: Number(r.price ?? 0),
    currency: r.currency ?? 'RMB',
    plant: (r.plant ?? 'changping') as Plant,
    attrs: r.attrs,
    effective_from: r.effective_from,
    source_file: r.source_file,
    argo_part_code: r.argo_part_code,
    erp_suggested_price: sug != null && Number.isFinite(sug) ? sug : null,
    erp_suggested_currency: r.erp_suggested_currency,
    erp_suggested_at: r.erp_suggested_at,
    updated_by: r.updated_by,
    updated_at: r.updated_at ?? SEED_TS,
    note: r.note,
  }
}

/** 後台用：整張價格表（可依廠別） */
export async function loadPriceRows(ctx: QuoteCtx, plant?: Plant): Promise<AdminPriceRow[]> {
  const rows = await withTable<PriceDbRow[]>(
    ctx,
    (sb) => {
      let q = sb.from('quote_price_items').select(PRICE_SELECT)
      if (plant) q = q.eq('plant', plant)
      return q.order('group').order('name')
    },
    () => [],
  )
  if (ctx.devSeed) {
    return loadPriceSeed()
      .map(seedPriceRow)
      .filter((r) => !plant || r.plant === plant)
      .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
  }
  return (rows ?? []).map(mapPriceRow)
}

/** 引擎組裝用：name → PriceItem（同名多列時取 effective_from 最新的那一列） */
export async function loadPriceMap(ctx: QuoteCtx, plant: Plant): Promise<Map<string, PriceItem>> {
  const rows = await loadPriceRows(ctx, plant)
  const map = new Map<string, PriceItem>()
  for (const r of rows) {
    const prev = map.get(r.name)
    if (prev && (prev.effective_from ?? '') > (r.effective_from ?? '')) continue
    map.set(r.name, {
      id: r.id,
      group: r.group,
      name: r.name,
      display_name: r.display_name,
      unit: r.unit,
      price: r.price,
      currency: r.currency,
      plant: r.plant,
      attrs: r.attrs,
      effective_from: r.effective_from,
      argo_part_code: r.argo_part_code,
      erp_suggested_price: r.erp_suggested_price,
      erp_suggested_currency: r.erp_suggested_currency,
      erp_suggested_at: r.erp_suggested_at,
      note: r.note,
    })
  }
  return map
}

/* ---------------------------------------------------------------- 讀取：品項 */

const PRODUCT_SELECT =
  'id, family, category, name, plant, status, version, config, sort_order, updated_by, updated_at, published_at'

type ProductDbRow = {
  id: string; family: string; category: string; name: string; plant: string; status: string
  version: number | null; config: unknown; sort_order: number | null
  updated_by: string | null; updated_at: string | null; published_at: string | null
}

function mapProductRow(r: ProductDbRow): AdminProductRow {
  return {
    id: r.id,
    family: 'acrylic',
    category: r.category,
    name: r.name,
    plant: (r.plant ?? 'changping') as Plant,
    status: (r.status ?? 'draft') as ProductStatus,
    version: Number(r.version ?? 1),
    config: r.config as ProductConfig,
    sort_order: Number(r.sort_order ?? 0),
    updated_by: r.updated_by,
    updated_at: r.updated_at ?? SEED_TS,
    published_at: r.published_at,
  }
}

/** quote_products.id 是 text slug（'keyring'）或 DB 預設產的 uuid 字串；只擋空值與離譜長度，不假設格式 */
const PRODUCT_ID_MAX_LEN = 64
const isValidProductId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= PRODUCT_ID_MAX_LEN

/**
 * 品項清單。devSeed 模式刻意不套 publishedOnly（seed 的鑰匙圈是 draft，
 * 套了前台就一個品項都沒有，開發時無法試算）。
 */
export async function loadProducts(ctx: QuoteCtx, opts: { publishedOnly: boolean }): Promise<AdminProductRow[]> {
  const rows = await withTable<ProductDbRow[]>(
    ctx,
    (sb) => {
      let q = sb.from('quote_products').select(PRODUCT_SELECT)
      if (opts.publishedOnly) q = q.eq('status', 'published')
      return q.order('sort_order').order('name')
    },
    () => [],
  )
  if (ctx.devSeed) return productsSeed.map(seedProductRow)
  return (rows ?? []).map(mapProductRow)
}

export async function getProduct(ctx: QuoteCtx, id: string): Promise<AdminProductRow | null> {
  if (!isValidProductId(id)) return null
  const row = await withTable<ProductDbRow | null>(
    ctx,
    (sb) => sb.from('quote_products').select(PRODUCT_SELECT).eq('id', id).maybeSingle(),
    () => null,
  )
  if (ctx.devSeed) {
    const p = productsSeed.find((x) => x.id === id)
    return p ? seedProductRow(p) : null
  }
  return row ? mapProductRow(row) : null
}

/* ---------------------------------------------------------------- 讀取：golden */

const GOLDEN_SELECT =
  'id, product_id, name, status, template_version, source_file, source_sheet, audit_note, input, settings_snapshot, expected_cost, expected_price, tolerance, last_result, last_diff, last_run_at, approved_by, approved_at'

type GoldenDbRow = {
  id: string; product_id: string; name: string; status: string
  template_version: string | null; source_file: string | null; source_sheet: string | null
  audit_note?: string | null
  input: unknown; settings_snapshot: unknown
  expected_cost: number | string; expected_price: number | string; tolerance: number | string | null
  last_result: string | null; last_diff: unknown; last_run_at: string | null
  approved_by: string | null; approved_at: string | null
}

function mapGoldenRow(r: GoldenDbRow): GoldenRow {
  const status = r.status === 'approved' || r.status === 'rejected' ? r.status : 'proposed'
  const tol = Number(r.tolerance)
  return {
    id: r.id,
    product_id: r.product_id,
    name: r.name,
    status,
    template_version: r.template_version,
    source_file: r.source_file,
    source_sheet: r.source_sheet,
    audit_note: r.audit_note ?? null,
    input: r.input,
    settings_snapshot: r.settings_snapshot,
    expected_cost: Number(r.expected_cost),
    expected_price: Number(r.expected_price),
    tolerance: Number.isFinite(tol) && tol > 0 ? tol : 0.01,
    last_result: r.last_result === 'pass' || r.last_result === 'fail' ? r.last_result : null,
    last_diff: r.last_diff,
    last_run_at: r.last_run_at,
    approved_by: r.approved_by,
    approved_at: r.approved_at,
  }
}

/** 某品項（或全部品項，productId 省略）的 golden 案例 */
export async function loadGoldenCases(ctx: QuoteCtx, productId?: string): Promise<GoldenRow[]> {
  const rows = await withTable<GoldenDbRow[]>(
    ctx,
    (sb) => {
      let q = sb.from('quote_golden_cases').select(GOLDEN_SELECT)
      if (productId) q = q.eq('product_id', isValidProductId(productId) ? productId : '')
      return q.order('name')
    },
    () => [],
  )
  if (ctx.devSeed) {
    const ids = productId ? [productId] : productsSeed.map((p) => p.id)
    return ids.flatMap(seedGoldenRows)
  }
  return (rows ?? []).map(mapGoldenRow)
}

/* ---------------------------------------------------------------- 價格表名稱慣例 */

/** 工序類價格在 quote_price_items 的自然鍵（Excel 价格表原名） */
export const PRICE_NAMES = {
  print7151: '印刷/7151/单面',
  printJingutian: '印刷/金谷田/单面',
  print7151Double: '印刷/7151/双面',
  printJingutianDouble: '印刷/金谷田/双面',
  printKoshi: '印刷/柯氏/单面',
  printKoshiExtra: '印刷/柯氏/加印额外费用',
  laminateSingle: '贴合/单面',
  laminateDouble: '贴合/双面',
  wash: '清洗',
} as const

function laminateName(item: string, sides: Sides): string {
  if (item.includes('/')) return item
  return `${item}/${sides === 2 ? '双面' : '单面'}`
}

/** 這個品項設定會查到哪些價格名稱（catalog 只回這些，避免把整張表丟給前台） */
export function collectPriceNames(config: ProductConfig): Set<string> {
  const names = new Set<string>()
  for (const o of config.boards?.options ?? []) {
    names.add(o.item)
    if (o.pairItem) names.add(o.pairItem)
  }
  for (const b of config.extraBoards ?? []) if (b.item) names.add(b.item)
  for (const m of config.printMethods ?? []) {
    const pet = config.petByMethod?.[m]
    if (pet) names.add(pet)
    if (m === '7151') {
      names.add(PRICE_NAMES.print7151)
      names.add(PRICE_NAMES.print7151Double)
    }
    if (m === 'jingutian') {
      names.add(PRICE_NAMES.printJingutian)
      names.add(PRICE_NAMES.printJingutianDouble)
    }
    if (m === 'koshi') {
      names.add(PRICE_NAMES.printKoshi)
      names.add(PRICE_NAMES.printKoshiExtra)
    }
  }
  for (const l of config.laminate ?? []) {
    names.add(laminateName(l.item, 1))
    names.add(laminateName(l.item, 2))
  }
  if (config.wash?.item) names.add(config.wash.item)
  for (const a of config.accessories ?? []) names.add(a.item)
  for (const p of config.packing ?? []) names.add(p.item)
  return names
}

/* ---------------------------------------------------------------- 組引擎輸入 */

export type CalcError = CalcResponse['errors'][number]
export type CalcWarning = CalcResponse['warnings'][number]

export interface BuildResult {
  input: AcrylicInput | null
  errors: CalcError[]
  warnings: CalcWarning[]
}

const numOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * 依設計書 §5／§6 把品項設定 + 價格表 + 業務輸入組成 AcrylicInput。
 * 查不到價格的項目一律進 errors（不默默當 0）；用到的價格寫進 snapshot。
 */
export function buildAcrylicInput(
  product: { config: ProductConfig },
  priceMap: Map<string, PriceItem>,
  settings: QuoteSettingsMap,
  req: CalcRequest,
  size: CalcSizeRequest,
  snapshot: Record<string, number> = {},
): BuildResult {
  const cfg = product.config
  const errors: CalcError[] = []
  const warnings: CalcWarning[] = []
  const sides: Sides = req.print?.sides === 2 ? 2 : 1
  const method: PrintMethod = req.print?.method

  /** 查價；找不到就記錯誤並回 null */
  const price = (name: string, field: string, label?: string): number | null => {
    const it = priceMap.get(name)
    if (!it) {
      errors.push({ code: 'PRICE_MISSING', field, message: `※ 價格表找不到「${label ?? name}」，請通知管理員補上` })
      return null
    }
    snapshot[name] = it.price
    return it.price
  }

  /* ---- 主板 ---- */
  const boardOpt = (cfg.boards?.options ?? []).find((o) => (o.key ?? o.item) === req.boardItem)
  if (!boardOpt) {
    errors.push({ code: 'BOARD_NOT_ALLOWED', field: 'boardItem', message: '※ 此板材不在品項允許的選項內' })
  }
  const boards: BoardLine[] = []
  if (boardOpt) {
    const p = price(boardOpt.item, 'boardItem', boardOpt.label)
    const it = priceMap.get(boardOpt.item)
    const layoutW = numOf(it?.attrs?.layout_w_cm)
    const layoutH = numOf(it?.attrs?.layout_h_cm)
    if (it && (!layoutW || !layoutH)) {
      errors.push({ code: 'BOARD_LAYOUT_MISSING', field: 'boardItem', message: `※ 板材「${boardOpt.label ?? boardOpt.item}」缺少套版尺寸（attrs.layout_w_cm／layout_h_cm），請通知管理員` })
    }
    boards.push({
      key: 'main',
      item: boardOpt.item,
      unitPrice: p ?? 0,
      layoutWcm: layoutW ?? undefined,
      layoutHcm: layoutH ?? undefined,
      roundup: true,
      sides: cfg.boards?.sides === 2 ? 2 : 1,
      printed: true,
      laminated: true,
      cut: true,
    })
  }
  for (const eb of cfg.extraBoards ?? []) {
    // 貼合款：第二板跟著板材選項走（2貼2 → 1.8+1.8、3貼1 → 2.8+0.8）
    let item = eb.item
    if (eb.fromBoardOption) {
      if (!boardOpt) continue
      if (!boardOpt.pairItem) {
        errors.push({ code: 'PAIR_BOARD_MISSING', field: 'boardItem', message: `※ 板材選項「${boardOpt.label ?? boardOpt.item}」缺少貼合第二板設定，請通知管理員` })
        continue
      }
      item = boardOpt.pairItem
    }
    const p = price(item, 'extraBoards')
    boards.push({
      key: eb.key,
      item,
      unitPrice: p ?? 0,
      // 不填＝跟主板每盤數（引擎對非 main 板：nPerSheet 缺就用 nUsed）
      nPerSheet: eb.nPerSheet && eb.nPerSheet > 0 ? eb.nPerSheet : undefined,
      roundup: eb.roundup,
      sides: eb.sides === 2 ? 2 : 1,
      printed: eb.printed,
      laminated: eb.laminated,
      cut: eb.cut,
    })
  }

  /* ---- 印刷方式 ---- */
  if (!(cfg.printMethods ?? []).includes(method)) {
    errors.push({ code: 'PRINT_METHOD_NOT_ALLOWED', field: 'print.method', message: '※ 此印刷方式不在品項允許的選項內' })
  }

  /* ---- PET ----
   * PET 面數（Excel L9）預設跟印刷面數：單板雙面 = 兩面各一張 PET，PET ×2。
   * 貼合款在 config.petSides 固定 1：一張 PET 兩面印、夾在兩片板中間，雙面不增加 PET。 */
  const petSides: Sides = cfg.petSides === 1 || cfg.petSides === 2 ? cfg.petSides : sides
  let pet: PetLine = { item: '', unitPrice: 0, mode: 'none', sides: petSides, kPet: cfg.kPet ?? 1 }
  if (method && method !== 'none') {
    const petItem = cfg.petByMethod?.[method]
    if (!petItem) {
      errors.push({ code: 'PET_NOT_CONFIGURED', field: 'print.method', message: '※ 品項設定缺少此印刷方式對應的 PET，請通知管理員' })
    } else {
      const p = price(petItem, 'print.method')
      pet = {
        item: petItem,
        unitPrice: p ?? 0,
        mode: method === 'koshi' ? 'koshi_sheet' : 'roundup_plates',
        sides: petSides,
        kPet: cfg.kPet > 0 ? cfg.kPet : 1,
      }
    }
  }

  /* ---- 印刷單價（7151／百川）：引擎的印刷盤數 = PET 張數（Excel C17 = C11），所以單價要看「每張 PET 印幾面」——
   *      PET 跟著雙面加倍（單板雙面）→ 每張 PET 只印一面，用單面價 7 × 286 張；
   *      PET 不加倍（貼合款）→ 一張 PET 兩面印，用雙面價 14 × 143 張。兩者對 Excel 都是 2002。
   *      柯式用單面每版價、引擎再 × sides（B17=3520 是雙面每版價，兩者等值） ---- */
  const print: PrintSpec = { method, sides, unitPrice: 0 }
  const doubleOnOnePet = sides === 2 && petSides === 1
  if (method === '7151') print.unitPrice = price(doubleOnOnePet ? PRICE_NAMES.print7151Double : PRICE_NAMES.print7151, 'print.method') ?? 0
  else if (method === 'jingutian') print.unitPrice = price(doubleOnOnePet ? PRICE_NAMES.printJingutianDouble : PRICE_NAMES.printJingutian, 'print.method') ?? 0
  else if (method === 'koshi') {
    print.unitPrice = price(PRICE_NAMES.printKoshi, 'print.method') ?? 0
    const v = numOf(req.print?.versions)
    print.versions = v && v >= 1 ? Math.floor(v) : 1
    const extra = priceMap.get(PRICE_NAMES.printKoshiExtra)
    if (extra) {
      print.extraUnitPrice = extra.price
      snapshot[PRICE_NAMES.printKoshiExtra] = extra.price
    } else {
      // 引擎有 settings.koshi.extraUnitPrice 後備，不算查不到價格；提醒即可
      warnings.push({ code: 'KOSHI_EXTRA_FALLBACK', sizeId: size.id, message: `※ 價格表沒有「${PRICE_NAMES.printKoshiExtra}」，加印費改用全域參數` })
    }
  }

  /* ---- 貼合：無印刷時跳過（F 款 C17/C18 空白）；清洗照算（F 款 C21 仍 =C9，照抄 Excel） ---- */
  const laminate: LaminateLine[] = []
  if (method && method !== 'none') {
    for (const l of cfg.laminate ?? []) {
      const name = laminateName(l.item, sides)
      const p = price(name, 'laminate')
      laminate.push({ item: name, unitPrice: p ?? 0, platesFrom: l.platesFrom ?? ['main'] })
    }
  }
  let wash: AcrylicInput['wash'] = { unitPrice: 0, platesFrom: 'main' }
  if (cfg.wash?.item) {
    const p = price(cfg.wash.item, 'wash')
    wash = { unitPrice: p ?? 0, platesFrom: cfg.wash.platesFrom ?? 'main', multiplier: cfg.wash.multiplier }
  }

  /* ---- 切割／報廢／成本率／包裝產能：品項預設 + 覆寫 ---- */
  const ov = req.overrides ?? {}
  const pick = (v: unknown, dflt: number, allowZero = false): number => {
    const n = numOf(v)
    if (n == null) return dflt
    if (n < 0) return dflt
    if (!allowZero && n === 0) return dflt
    return n
  }
  const cut = {
    t1: pick(ov.t1, cfg.cut?.t1 ?? 12, true),
    t2: pick(ov.t2, cfg.cut?.t2 ?? 0, true),
    t3: pick(ov.t3, cfg.cut?.t3 ?? 0, true),
  }
  const scrapPct = pick(ov.scrapPct, cfg.scrapPct ?? 10, true)
  const costRatio = pick(ov.costRatio, cfg.costRatio ?? 0.72)
  const packCapacityPerHour = pick(ov.packCapacityPerHour, cfg.packCapacityPerHour ?? 100)
  if (!(costRatio > 0 && costRatio <= 1)) {
    errors.push({ code: 'COST_RATIO_INVALID', field: 'overrides.costRatio', message: '※ 成本率須介於 0 與 1 之間' })
  }

  /* ---- 配件 ---- */
  const packing: PackingLine[] = []
  for (const a of req.accessories ?? []) {
    const acc = (cfg.accessories ?? []).find((x) => x.item === a.item)
    if (!acc) {
      errors.push({ code: 'ACCESSORY_NOT_ALLOWED', field: 'accessories', message: `※ 配件「${a.item}」不在品項設定內` })
      continue
    }
    const k = numOf(a.k)
    if (k == null || k <= 0) {
      errors.push({ code: 'ACCESSORY_K_INVALID', field: 'accessories', message: `※ 配件「${a.item}」每件用量須大於 0` })
      continue
    }
    let unitPrice: number | null
    const custom = numOf(a.unitPrice)
    if (acc.tierPrices && custom != null && custom > 0) {
      unitPrice = custom
      snapshot[a.item] = custom
    } else {
      unitPrice = price(a.item, 'accessories')
    }
    packing.push({ item: a.item, unitPrice: unitPrice ?? 0, mode: 'per_unit', k, group: 'accessory' })
  }

  /* ---- 包裝 ---- */
  const packLines: { line: PackingLine; cfgPk: ProductPacking; explicitN: boolean }[] = []
  for (const pk of req.packing ?? []) {
    const cfgPk = (cfg.packing ?? []).find((x) => x.item === pk.item)
    if (!cfgPk) {
      errors.push({ code: 'PACKING_NOT_ALLOWED', field: 'packing', message: `※ 包裝「${pk.item}」不在品項設定內` })
      continue
    }
    const n = numOf(pk.n)
    const line: PackingLine = {
      item: pk.item,
      unitPrice: price(pk.item, 'packing') ?? 0,
      mode: cfgPk.mode,
      group: 'packing',
    }
    if (cfgPk.k != null) line.k = cfgPk.k
    const explicitN = n != null && n > 0
    const effN = explicitN ? Math.floor(n) : cfgPk.n
    if (effN != null) line.n = effN
    packLines.push({ line, cfgPk, explicitN })
  }
  // per_box（出貨平卡）跟紙箱列連動（Excel C71 = C70*2）：業務改了紙箱「每箱件數」，平卡張數要跟著變。
  // 沒送 n 的 per_box 列一律改用同一請求裡紙箱列的有效 n（含覆寫）；找不到紙箱列才退回品項設定的 n。
  const cartonN = (() => {
    const box = packLines.find((x) => x.line.mode === 'per_n_units' && /纸箱|紙箱/.test(x.line.item))
    return box?.line.n && box.line.n > 0 ? box.line.n : null
  })()
  for (const { line, cfgPk, explicitN } of packLines) {
    if (line.mode === 'per_box' && !explicitN && cartonN != null) line.n = cartonN
    if ((cfgPk.mode === 'per_n_units' || cfgPk.mode === 'per_box') && !(line.n && line.n > 0)) {
      errors.push({ code: 'PACKING_N_INVALID', field: 'packing', message: `※ 包裝「${line.item}」的每箱／每袋件數須大於 0` })
    }
    packing.push(line)
  }

  if (errors.length > 0) return { input: null, errors, warnings }

  const nOverrideRaw = numOf(size.nOverride?.value)
  const input: AcrylicInput = {
    qty: Math.floor(size.qty),
    partWcm: size.w,
    partHcm: size.h,
    nOverride: nOverrideRaw && nOverrideRaw > 0 ? Math.floor(nOverrideRaw) : null,
    boards,
    pet,
    print,
    laminate,
    wash,
    cut,
    scrapPct,
    costRatio,
    packCapacityPerHour,
    packing,
  }
  return { input, errors, warnings }
}

/* ---------------------------------------------------------------- TWD 換算 */

/** RMB 報價 → TWD 整數元：round(quote × 匯率 × (1 + 啟盛加成%))；沒設匯率回 null */
export function computeTwd(quoteUnit: number, settings: QuoteSettingsMap): number | null {
  const fx = settings.fx_rmb_twd
  if (!fx || !(fx.rate > 0) || !Number.isFinite(quoteUnit)) return null
  const markup = Number.isFinite(settings.markup_bardshop_pct) ? settings.markup_bardshop_pct : 0
  return Math.round(quoteUnit * fx.rate * (1 + markup / 100))
}

export function fxInfoOf(settings: QuoteSettingsMap): { rate: number; asOf: string } | null {
  const fx = settings.fx_rmb_twd
  return fx && fx.rate > 0 ? { rate: fx.rate, asOf: fx.as_of } : null
}

/* ---------------------------------------------------------------- 整段試算（calc route 與 log route 共用） */

const MAX_SIZES = 5
const MAX_LIST_ITEMS = 20
const MAX_REQUEST_BYTES = 64 * 1024

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export interface RunCalcResult {
  res: CalcResponse
  /** 驗證後正規化的請求；輸入有錯（res.errors 非空）時為 null */
  req: CalcRequest | null
  product: AdminProductRow | null
}

/**
 * 驗證 CalcRequest → 查品項／價格／參數 → 逐款跑引擎 → 組 CalcResponse。
 * 輸入問題一律進 res.errors（呼叫端決定 HTTP 狀態）；表不存在／系統錯誤才 throw。
 * log route 也走這裡：報價紀錄的單價、快照、匯率一律用伺服器算出的結果，不信前端送來的 response。
 */
export async function runCalc(
  ctx: QuoteCtx,
  body: unknown,
  member: { isAdmin: boolean; permissions: string[] },
  /** audit：計算規則照 mode 走（sales 仍用預設包裝），但回傳不剝除成本——只給 log 落庫用，絕不能直接回給前端 */
  opts: { audit?: boolean } = {},
): Promise<RunCalcResult> {
  const settings = await loadSettings(ctx)
  // 模式是伺服器決定的：要 engineer 得有 quote_admin，否則一律降級成 sales。
  // 前端傳什麼都只是「請求」，真正的閘門在這裡（DevTools 改不了）。
  const canEngineer = member.isAdmin || member.permissions.includes('quote_admin')
  const requested = (body as Partial<CalcRequest> | null)?.mode
  const mode: QuoteMode = requested === 'engineer' && canEngineer ? 'engineer' : 'sales'
  const res: CalcResponse = {
    mode,
    rateVersion: settings.rate_version,
    fx: fxInfoOf(settings),
    validityDays: settings.quote_validity_days,
    productVersion: 0,
    sizes: [],
    warnings: [],
    errors: [],
    priceSnapshot: {},
  }
  const fail = (code: string, message: string, field?: string): RunCalcResult => {
    res.errors.push({ code, field, message })
    return { res, req: null, product: null }
  }

  /* ---- 基本輸入驗證（先擋掉不用查表就知道錯的） ---- */
  if (!body || typeof body !== 'object') return fail('REQUEST_INVALID', '※ 請求格式錯誤')
  if (JSON.stringify(body).length > MAX_REQUEST_BYTES) return fail('REQUEST_TOO_LARGE', '※ 請求內容過大')
  const b = body as Partial<CalcRequest>
  const productId = typeof b.productId === 'string' ? b.productId.trim() : ''
  if (!productId) return fail('PRODUCT_REQUIRED', '※ 請選擇品項', 'productId')
  if (!Array.isArray(b.sizes) || b.sizes.length === 0) return fail('SIZES_REQUIRED', '※ 請輸入尺寸與數量', 'sizes')
  if (b.sizes.length > MAX_SIZES) return fail('SIZES_TOO_MANY', `※ 一次最多 ${MAX_SIZES} 款尺寸`, 'sizes')
  for (const s of b.sizes) {
    if (!s || typeof s.id !== 'string') return fail('SIZE_ID_REQUIRED', '※ 尺寸資料格式錯誤', 'sizes')
    if (!isNum(s.w) || s.w <= 0 || !isNum(s.h) || s.h <= 0) return fail('SIZE_INVALID', '※ 請輸入 0.1 以上的寬與高', `sizes.${s.id}`)
    if (!isNum(s.qty) || s.qty <= 0) return fail('QTY_INVALID', '※ 請輸入 1 以上的數量', `sizes.${s.id}`)
    if (s.nOverride != null && (!isNum(s.nOverride.value) || s.nOverride.value <= 0)) {
      return fail('N_OVERRIDE_INVALID', '※ 每盤數量須大於 0', `sizes.${s.id}`)
    }
  }
  if (typeof b.boardItem !== 'string' || !b.boardItem) return fail('BOARD_REQUIRED', '※ 請選擇板材', 'boardItem')
  if (!b.print || !PRINT_METHODS.includes(b.print.method)) return fail('PRINT_METHOD_INVALID', '※ 請選擇印刷方式', 'print.method')
  if (b.print.sides !== 1 && b.print.sides !== 2) return fail('PRINT_SIDES_INVALID', '※ 請選擇單面或雙面', 'print.sides')
  if (b.print.method === 'koshi' && b.print.versions != null && (!isNum(b.print.versions) || b.print.versions < 1)) {
    return fail('VERSIONS_INVALID', '※ 版數須為 1 以上的整數', 'print.versions')
  }
  if (b.accessories != null && !Array.isArray(b.accessories)) return fail('ACCESSORIES_INVALID', '※ 配件資料格式錯誤', 'accessories')
  if (b.packing != null && !Array.isArray(b.packing)) return fail('PACKING_INVALID', '※ 包裝資料格式錯誤', 'packing')
  if ((b.accessories?.length ?? 0) > MAX_LIST_ITEMS) return fail('ACCESSORIES_TOO_MANY', `※ 配件最多 ${MAX_LIST_ITEMS} 項`, 'accessories')
  if ((b.packing?.length ?? 0) > MAX_LIST_ITEMS) return fail('PACKING_TOO_MANY', `※ 包裝最多 ${MAX_LIST_ITEMS} 項`, 'packing')

  /* ---- 品項 ---- */
  const product = await getProduct(ctx, productId)
  if (!product) return fail('PRODUCT_NOT_FOUND', '※ 找不到此品項', 'productId')
  const canTestUnpublished = ctx.devSeed || member.isAdmin || member.permissions.includes('quote_admin')
  if (product.status !== 'published' && !canTestUnpublished) {
    return fail('PRODUCT_NOT_PUBLISHED', '※ 此品項尚未發布，無法報價', 'productId')
  }
  res.productVersion = product.version
  if (product.status !== 'published') {
    res.warnings.push({ code: 'PRODUCT_NOT_PUBLISHED', message: '※ 此品項尚未發布，試算結果僅供測試' })
  }

  /* ---- 逐款跑引擎 ---- */
  const priceMap = await loadPriceMap(ctx, product.plant)
  // sales 模式：包裝照品項預設「幫他抓好」，每盤覆寫與切割／報廢／產能覆寫一律不收——
  // 這些都是工程判斷，業務只要選品項、尺寸、數量、印刷、配件就好。
  // 唯一放行的是 costRatio（前台的「毛利率」欄）：Snow 2026-09-16 決定業務也可以調毛利率。
  const salesOverrides: CalcRequest['overrides'] =
    typeof b.overrides?.costRatio === 'number' ? { costRatio: b.overrides.costRatio } : {}
  const defaultPacking = product.config.packing.filter((pk) => pk.defaultOn !== false).map((pk) => ({ item: pk.item }))
  const req: CalcRequest = {
    mode,
    productId,
    sizes: mode === 'engineer' ? b.sizes : b.sizes.map((sz) => ({ id: sz.id, w: sz.w, h: sz.h, qty: sz.qty })),
    boardItem: b.boardItem,
    print: { method: b.print.method, sides: b.print.sides, versions: b.print.versions },
    accessories: b.accessories ?? [],
    packing: mode === 'engineer' ? (b.packing ?? []) : defaultPacking,
    overrides: mode === 'engineer' ? (b.overrides ?? {}) : salesOverrides,
  }
  for (const size of req.sizes) {
    const built = buildAcrylicInput(product, priceMap, settings, req, size, res.priceSnapshot)
    res.warnings.push(...built.warnings)
    if (!built.input) {
      // 同一組設定的錯誤每款都一樣，只收第一款的，避免同一句重複 5 次
      for (const e of built.errors) if (!res.errors.some((x) => x.code === e.code && x.field === e.field)) res.errors.push(e)
      continue
    }
    const r = calcAcrylic(built.input, settings.acrylic_settings)
    for (const w of r.warnings) res.warnings.push({ code: 'ENGINE', sizeId: size.id, message: `※ ${w}` })
    if (!(r.nPerSheetUsed > 0)) {
      res.warnings.push({ code: 'NO_NEST', sizeId: size.id, message: '※ 尺寸超過板材可用範圍，無法拼板' })
    }
    const twdUnit = r.quoteUnit > 0 ? computeTwd(r.quoteUnit, settings) : null
    // 非 engineer：只放報價相關欄位，成本、五段、拼板全部不進回應（不是設 0，是根本沒有這個 key）
    const out: CalcSizeResult =
      mode === 'engineer' || opts.audit
        ? { ...r, id: size.id, twdUnit }
        : { id: size.id, quoteUnit: r.quoteUnit, total: r.total, twdUnit, warnings: r.warnings }
    res.sizes.push(out)
  }
  if (mode !== 'engineer' && !opts.audit) {
    // 價格快照是成本資料；引擎警告裡的「自動計算 24」也會洩漏拼板結果
    delete res.priceSnapshot
    res.warnings = res.warnings.filter((w) => w.code !== 'ENGINE')
  }
  if (res.errors.length > 0) {
    res.sizes = []
    return { res, req: null, product }
  }
  return { res, req, product }
}

/* ---------------------------------------------------------------- 報價編號 */

/** 台灣時區的今天，YYYY-MM-DD（Vercel 機器是 UTC，直接 new Date() 會在 08:00 前差一天） */
export function taipeiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** Q-YYYYMMDD-NN：NN = 當日已有筆數 + 1，兩位補零（超過 99 就自然三位） */
export async function nextQuoteNo(supabase: SupabaseClient): Promise<string> {
  const ymd = taipeiToday().replace(/-/g, '')
  const prefix = `Q-${ymd}-`
  const { count, error } = await supabase
    .from('quote_calc_logs')
    .select('quote_no', { count: 'exact', head: true })
    .like('quote_no', `${prefix}%`)
  if (error) {
    if (isTableMissingError(error)) throw new QuoteTableMissingError()
    throw new Error(describeError(error))
  }
  const n = (count ?? 0) + 1
  return `${prefix}${String(n).padStart(2, '0')}`
}

/* ---------------------------------------------------------------- 摘要 */

const METHOD_LABEL: Record<PrintMethod, string> = {
  '7151': '仿柯7151',
  jingutian: '仿柯百川',
  koshi: '柯式',
  none: '無印刷',
}

const fmtQty = (n: number) => Math.round(n).toLocaleString('zh-TW')
const fmtSize = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** 一行摘要：品項 · 尺寸 · 板材 · 印刷 · 數量 · 單價（多款用「／」串起） */
export function summarize(
  req: CalcRequest,
  res: CalcResponse,
  product: { name: string; config: ProductConfig },
): string {
  const board = product.config.boards?.options?.find((o) => (o.key ?? o.item) === req.boardItem)
  const boardLabel = board?.label ?? req.boardItem
  const sidesLabel = req.print?.sides === 2 ? '雙面' : '單面'
  const method = req.print?.method
  let printLabel = method === 'none' ? METHOD_LABEL.none : `${sidesLabel} ${METHOD_LABEL[method] ?? method}`
  if (method === 'koshi') printLabel += ` ${req.print?.versions ?? 1} 版`
  const sizeText = (req.sizes ?? []).map((s) => `${fmtSize(s.w)} × ${fmtSize(s.h)} cm`).join('／')
  const qtyText = (req.sizes ?? []).map((s) => `${fmtQty(s.qty)} pcs`).join('／')
  const unitText = (res.sizes ?? [])
    .map((s) => (s.quoteUnit > 0 ? `RMB ${s.quoteUnit.toFixed(2)}` : '—'))
    .join('／')
  return [product.name, sizeText, boardLabel, printLabel, qtyText, unitText].filter(Boolean).join(' · ')
}

/* ---------------------------------------------------------------- Golden 驗證 */

/**
 * 每筆 golden：input 直接餵引擎；settings = 現行 acrylic_settings 深合併 settings_snapshot
 * （快照可以是完整常數或只有差異的那幾個鍵）。誤差以相對值計，門檻 tolerance（預設 1%）。
 */
export function runGoldenCases(
  cases: GoldenRow[],
  currentSettings: QuoteSettingsMap,
): VerifyCaseResult[] {
  const out: VerifyCaseResult[] = []
  for (const c of cases) {
    const base: VerifyCaseResult = {
      goldenId: c.id,
      name: c.name,
      status: c.status,
      pass: false,
      gotCost: 0,
      gotPrice: 0,
      expectedCost: c.expected_cost,
      expectedPrice: c.expected_price,
      errCost: 0,
      errPrice: 0,
      segments: [],
    }
    try {
      if (!c.input || typeof c.input !== 'object') throw new Error('案例缺少 input')
      const settings = deepMerge<AcrylicSettings>(
        JSON.parse(JSON.stringify(currentSettings.acrylic_settings)),
        c.settings_snapshot ?? {},
      )
      const r = calcAcrylic(c.input as AcrylicInput, settings)
      const relErr = (got: number, exp: number) => (exp !== 0 ? Math.abs(got - exp) / Math.abs(exp) : Math.abs(got))
      const errCost = relErr(r.costUnit, c.expected_cost)
      const errPrice = relErr(r.quoteUnit, c.expected_price)
      out.push({
        ...base,
        pass: errCost <= c.tolerance && errPrice <= c.tolerance,
        gotCost: r.costUnit,
        gotPrice: r.quoteUnit,
        errCost,
        errPrice,
        segments: r.segments.map((s) => ({ key: s.key, amount: s.amount })),
      })
    } catch (e) {
      out.push({ ...base, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

/** 閘門只看 approved 案例 */
export function gateOf(results: VerifyCaseResult[]): VerifyResponse['gate'] {
  const approved = results.filter((r) => r.status === 'approved')
  if (approved.length === 0) return 'no-approved-cases'
  return approved.every((r) => r.pass) ? 'pass' : 'fail'
}

/** 寫回 last_result / last_diff / last_run_at（devSeed 不寫） */
export async function persistVerifyResults(ctx: QuoteCtx, results: VerifyCaseResult[]): Promise<void> {
  const sb = writableClient(ctx)
  if (!sb) return
  const now = new Date().toISOString()
  for (const r of results) {
    const diff = {
      cost: { expected: r.expectedCost, got: r.gotCost, errPct: r.errCost * 100 },
      price: { expected: r.expectedPrice, got: r.gotPrice, errPct: r.errPrice * 100 },
      segments: r.segments,
      error: r.error ?? null,
    }
    const { error } = await sb
      .from('quote_golden_cases')
      .update({ last_result: r.pass ? 'pass' : 'fail', last_diff: diff, last_run_at: now })
      .eq('id', r.goldenId)
    if (error) throw new Error(describeError(error))
  }
}

/** 跑某品項的驗證（approved 為主；includeProposed 時把 proposed 一起跑、rejected 永遠不跑） */
export async function verifyProduct(
  ctx: QuoteCtx,
  productId: string,
  opts: { includeProposed?: boolean; persist?: boolean } = {},
): Promise<VerifyResponse> {
  const settings = await loadSettings(ctx)
  const all = await loadGoldenCases(ctx, productId)
  const cases = all.filter((c) => c.status === 'approved' || (opts.includeProposed && c.status === 'proposed'))
  const results = runGoldenCases(cases, settings)
  if (opts.persist !== false) await persistVerifyResults(ctx, results)
  return { productId, gate: gateOf(results), results }
}

/* ---------------------------------------------------------------- 小工具給 route 用 */

export async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

export function badRequest(message: string, code?: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status: 400 })
}

export const PRODUCT_STATUSES: ProductStatus[] = ['draft', 'testing', 'published']
export const PLANTS: Plant[] = ['changping', 'taiwan']
export const PRINT_METHODS: PrintMethod[] = ['7151', 'jingutian', 'koshi', 'none']

/** 品項 config 最小結構檢查（不做深度驗證，只擋明顯壞掉的 payload） */
export function validateProductConfig(cfg: unknown): string | null {
  if (!cfg || typeof cfg !== 'object') return 'config 必須是物件'
  const c = cfg as Partial<ProductConfig>
  if (!c.boards || !Array.isArray(c.boards.options) || c.boards.options.length === 0) return 'config.boards.options 至少要有一個板材'
  if (!c.boards.options.every((o) => o && typeof o.item === 'string' && o.item)) return 'config.boards.options 每項都要有 item'
  if (typeof c.boards.defaultItem !== 'string' || !c.boards.options.some((o) => o.item === c.boards!.defaultItem)) return 'config.boards.defaultItem 必須是 options 之一'
  if (c.boards.sides !== 1 && c.boards.sides !== 2) return 'config.boards.sides 必須是 1 或 2'
  if (!Array.isArray(c.printMethods) || c.printMethods.length === 0) return 'config.printMethods 至少要有一種印刷方式'
  if (!c.printMethods.every((m) => PRINT_METHODS.includes(m))) return `config.printMethods 只能是 ${PRINT_METHODS.join('/')}`
  if (!c.printMethods.includes(c.defaultPrintMethod as PrintMethod)) return 'config.defaultPrintMethod 必須在 printMethods 內'
  for (const m of c.printMethods) {
    if (m !== 'none' && !c.petByMethod?.[m]) return `config.petByMethod 缺少 ${m} 對應的 PET`
  }
  if (!Array.isArray(c.extraBoards)) return 'config.extraBoards 必須是陣列'
  if (!Array.isArray(c.laminate)) return 'config.laminate 必須是陣列'
  if (!Array.isArray(c.accessories)) return 'config.accessories 必須是陣列'
  if (!Array.isArray(c.packing)) return 'config.packing 必須是陣列'
  if (!c.cut || numOf(c.cut.t1) == null || numOf(c.cut.t2) == null || numOf(c.cut.t3) == null) return 'config.cut 需要 t1/t2/t3'
  if (numOf(c.scrapPct) == null || (c.scrapPct as number) < 0) return 'config.scrapPct 必須是 ≥ 0 的數字'
  const r = numOf(c.costRatio)
  if (r == null || r <= 0 || r > 1) return 'config.costRatio 必須介於 0 與 1'
  const p = numOf(c.packCapacityPerHour)
  if (p == null || p <= 0) return 'config.packCapacityPerHour 必須大於 0'
  return null
}
