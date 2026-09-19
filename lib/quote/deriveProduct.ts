/**
 * 從一份 报价模板 解析出來的引擎輸入（AcrylicInput）反推「品項設定」（ProductConfig）。
 *
 * 用途：後台 Excel 匯入 → 「用這份 Excel 建立新品項」。Snow 給一張新品項（例如 8mm 飯友）的常平報價表，
 * 系統把它用到的板材、第二板、印刷方式、PET、貼合、清洗、切割時間、耗損、成本率、包裝產能、配件、包裝
 * 全部抓出來變成一個 draft 品項；同一份檔的各數量分頁則變成 golden proposed。
 *
 * 純函式、不碰資料庫：價格表裡有沒有這些品名由呼叫端給（knownItems），這裡只負責列出「引用到哪些價格名稱」，
 * 缺的由匯入流程一併新增，否則前台一算就 PRICE_MISSING。
 */
import type { AcrylicInput, PackingMode, ProductConfig, ProductExtraBoard, Sides } from './types'

export interface ReferencedPrice {
  name: string
  group: string
  unit: string
  /** Excel 上的單價（缺的項目就用這個新增） */
  price: number
  attrs: Record<string, number> | null
  /** 價格表已有同名項目 */
  exists: boolean
}

export interface DerivedProduct {
  config: ProductConfig
  /** 這個品項會查到的所有價格名稱（含已存在的） */
  referencedPrices: ReferencedPrice[]
  notes: string[]
  /** 從檔名／品名猜的品項名稱，給表單當預設值 */
  suggestedName: string
}

export interface KnownItem {
  group: string
  attrs: Record<string, unknown> | null
}

/** 常平廠品項預設（Snow 2026-09-16 定）：新品項一律用這組，不抄 Excel 上那張單的耗損／成本率 */
export const CHANGPING_POLICY = { scrapPct: 15, costRatio: 0.73 }

const PET_DEFAULT_7151 = '0.188单面不加硬PET [0.188mm * 310mm * 420mm]'
const PET_DEFAULT_KOSHI = '0.188单面覆膜不加硬PET [0.188mm * 680mm * 460mm]'
const PRINT_NAMES: Record<string, string[]> = {
  '7151': ['印刷/7151/单面', '印刷/7151/双面'],
  jingutian: ['印刷/金谷田/单面', '印刷/金谷田/双面'],
  koshi: ['印刷/柯氏/单面', '印刷/柯氏/加印额外费用'],
}

/** 板材品名 `[300mm * 400mm * 2.8]` → 規格；套版尺寸優先抄同尺寸既有板材，否則 (mm−10)/10（300×400 → 29×39） */
export function deriveBoardAttrs(name: string, known: Map<string, KnownItem>): { attrs: Record<string, number> | null; note: string | null } {
  const m = /\[\s*(\d+(?:\.\d+)?)\s*mm?\s*\*\s*(\d+(?:\.\d+)?)\s*mm?\s*\*\s*(\d+(?:\.\d+)?)\s*\]/.exec(name)
  if (!m) return { attrs: null, note: `板材「${name}」品名讀不出規格，套版尺寸請到價格表補` }
  const w = Number(m[1])
  const h = Number(m[2])
  const t = Number(m[3])
  for (const it of known.values()) {
    const a = it.attrs
    if (!a) continue
    if (Number(a.sheet_w_mm) === w && Number(a.sheet_h_mm) === h && Number(a.layout_w_cm) > 0 && Number(a.layout_h_cm) > 0) {
      return { attrs: { sheet_w_mm: w, sheet_h_mm: h, thickness_mm: t, layout_w_cm: Number(a.layout_w_cm), layout_h_cm: Number(a.layout_h_cm) }, note: null }
    }
  }
  const lw = Math.round((w - 10) / 10 * 10) / 10
  const lh = Math.round((h - 10) / 10 * 10) / 10
  return {
    attrs: { sheet_w_mm: w, sheet_h_mm: h, thickness_mm: t, layout_w_cm: lw, layout_h_cm: lh },
    note: `板材「${name}」套版尺寸以 (板寬−10mm)／(板高−10mm) 推估為 ${lw} × ${lh} cm，請到價格表確認`,
  }
}

function packingGroupName(g: 'packing' | 'accessory' | 'outsourced' | undefined): string {
  if (g === 'accessory') return '五金'
  if (g === 'outsourced') return '其他'
  return '包材'
}

function laminateBase(item: string): string {
  return item.replace(/\/(单面|双面|單面|雙面)$/, '')
}

export function deriveProductFromInput(
  input: AcrylicInput,
  known: Map<string, KnownItem>,
  hint: { productName?: string; fileName?: string } = {},
): DerivedProduct {
  const notes: string[] = []
  const refs = new Map<string, ReferencedPrice>()
  const addRef = (name: string, group: string, unit: string, price: number, attrs: Record<string, number> | null = null) => {
    if (!name || refs.has(name)) return
    refs.set(name, { name, group, unit, price, attrs, exists: known.has(name) })
  }

  const main = input.boards.find((b) => b.key === 'main') ?? input.boards[0]
  if (!main) throw new Error('引擎輸入沒有主板材')

  /* ---- 板材 ---- */
  for (const b of input.boards) {
    const { attrs, note } = deriveBoardAttrs(b.item, known)
    if (note && !known.has(b.item)) notes.push(note)
    addRef(b.item, '板材', '片', b.unitPrice, attrs)
  }
  const extraBoards: ProductExtraBoard[] = input.boards
    .filter((b) => b.key !== main.key)
    .map((b) => ({
      key: b.key,
      item: b.item,
      nPerSheet: b.nPerSheet && b.nPerSheet > 0 ? b.nPerSheet : undefined,
      roundup: b.roundup,
      sides: b.sides,
      printed: b.printed,
      laminated: b.laminated,
      cut: b.cut,
    }))
  if (extraBoards.length) notes.push(`第二板材 ${extraBoards.map((b) => `${b.key}=${b.item}${b.nPerSheet ? `（每盤 ${b.nPerSheet}${b.roundup ? '' : '，不進位'}）` : '（每盤跟主板）'}`).join('、')}`)

  /* ---- 印刷／PET ---- */
  const method = input.print.method
  const petItem = input.pet.item && input.pet.mode !== 'none' ? input.pet.item : ''
  const petByMethod: ProductConfig['petByMethod'] = {
    '7151': method === '7151' || method === 'jingutian' ? petItem || PET_DEFAULT_7151 : PET_DEFAULT_7151,
    jingutian: method === '7151' || method === 'jingutian' ? petItem || PET_DEFAULT_7151 : PET_DEFAULT_7151,
    koshi: method === 'koshi' ? petItem || PET_DEFAULT_KOSHI : PET_DEFAULT_KOSHI,
  }
  for (const [m, name] of Object.entries(petByMethod)) {
    if (!name) continue
    addRef(name, 'PET', '張', name === petItem ? input.pet.unitPrice : 0)
    if (name !== petItem && !known.has(name)) notes.push(`${m} 的 PET「${name}」價格表沒有，先以 0 元新增，請補價`)
  }
  for (const names of Object.values(PRINT_NAMES)) {
    for (const n of names) {
      if (!known.has(n)) addRef(n, '印刷', '盤', 0)
    }
  }
  const printSides: Sides = input.print.sides === 2 ? 2 : 1
  // 雙面時 PET 有沒有跟著加倍：單板雙面 = 2（跟印刷面數，config 不填）；貼合款一張 PET 兩面印 = 1（config 固定 1）
  let petSides: Sides | undefined
  if (printSides === 2) {
    petSides = input.pet.sides === 2 ? undefined : 1
    notes.push(input.pet.sides === 2 ? '雙面印刷、PET ×2（兩面各一張）' : '雙面印刷但 PET 不加倍（彩白彩單張 PET，貼合款口徑）')
  }

  /* ---- 貼合／清洗 ---- */
  const laminate: ProductConfig['laminate'] = []
  const seenLam = new Set<string>()
  for (const l of input.laminate) {
    const base = laminateBase(l.item)
    if (seenLam.has(base)) continue
    seenLam.add(base)
    laminate.push({ item: base, platesFrom: l.platesFrom })
    for (const s of ['单面', '双面']) {
      const n = `${base}/${s}`
      addRef(n, '工序', '盤', n === l.item ? l.unitPrice : 0)
    }
  }
  if (laminate.length === 0 && method !== 'none') {
    laminate.push({ item: '贴合', platesFrom: ['main'] })
    addRef('贴合/单面', '工序', '盤', 0)
    addRef('贴合/双面', '工序', '盤', 0)
    notes.push('這份表沒有貼合列，品項仍預設「贴合」（主板盤數）——不要的話到品項維護刪掉')
  }
  const wash: ProductConfig['wash'] = { item: '清洗', platesFrom: input.wash.platesFrom ?? 'main', ...(input.wash.multiplier && input.wash.multiplier !== 1 ? { multiplier: input.wash.multiplier } : {}) }
  addRef('清洗', '工序', '盤', input.wash.unitPrice)

  /* ---- 配件／包裝（主产品 A68 起的每一列） ---- */
  const accessories: ProductConfig['accessories'] = []
  const packing: ProductConfig['packing'] = []
  for (const line of input.packing) {
    const g = line.group ?? 'packing'
    addRef(line.item, packingGroupName(g), g === 'accessory' ? '個' : g === 'outsourced' ? '次' : '個', line.unitPrice)
    if (g === 'accessory' && line.mode === 'per_unit') {
      accessories.push({ item: line.item, k: line.k && line.k > 0 ? line.k : 1, defaultOn: true })
    } else {
      const entry: ProductConfig['packing'][number] = { item: line.item, mode: line.mode as PackingMode, defaultOn: true }
      if (line.k != null) entry.k = line.k
      if (line.n != null) entry.n = line.n
      packing.push(entry)
    }
  }

  const config: ProductConfig = {
    boards: {
      options: [{ item: main.item, label: boardLabel(main.item) }],
      defaultItem: main.item,
      sides: main.sides,
    },
    defaultPrintSides: printSides,
    ...(petSides ? { petSides } : {}),
    extraBoards,
    printMethods: ['7151', 'jingutian', 'koshi', 'none'],
    defaultPrintMethod: method,
    petByMethod,
    kPet: input.pet.kPet > 0 ? input.pet.kPet : 2,
    laminate,
    wash,
    cut: { t1: input.cut.t1, t2: input.cut.t2, t3: input.cut.t3 },
    accessories,
    packing,
    scrapPct: CHANGPING_POLICY.scrapPct,
    costRatio: CHANGPING_POLICY.costRatio,
    packCapacityPerHour: input.packCapacityPerHour,
  }
  if (input.scrapPct !== CHANGPING_POLICY.scrapPct || Math.abs(input.costRatio - CHANGPING_POLICY.costRatio) > 1e-9) {
    notes.push(`耗損／成本率套常平廠預設 ${CHANGPING_POLICY.scrapPct}%／${CHANGPING_POLICY.costRatio}（毛利 ${Math.round((1 - CHANGPING_POLICY.costRatio) * 100)}%）；這份 Excel 是 ${input.scrapPct}%／${input.costRatio}，只留在 golden 快照裡`)
  }

  const missing = [...refs.values()].filter((r) => !r.exists)
  if (missing.length) notes.push(`價格表缺 ${missing.length} 個品名（${missing.map((r) => r.name).join('、')}），套用時會一併新增`)
  notes.push('板材選項只帶了這份表用的那一張；其他厚度到「品項維護」再加')

  const suggestedName = (hint.productName || hint.fileName?.replace(/\.xlsx?$/i, '').replace(/_?(报价模板|柯氏报价模板)_v[\d.]+$/i, '').replace(/^BA\d+\s*/i, '') || '新品項').trim()

  return { config, referencedPrices: [...refs.values()], notes, suggestedName }
}

function boardLabel(name: string): string {
  const m = /\[\s*(\d+(?:\.\d+)?)\s*mm?\s*\*\s*(\d+(?:\.\d+)?)\s*mm?\s*\*\s*(\d+(?:\.\d+)?)\s*\]/.exec(name)
  return m ? `${m[1]} × ${m[2]} × ${m[3]}` : name
}

/* ---------------------------------------------------------------- 合理性檢查 */

export interface AnomalyCheck {
  level: 'warn' | 'info'
  /** 哪一項（切割時間／包裝產能／印刷單價…） */
  field: string
  message: string
}

export interface ReferenceProduct {
  id: string
  name: string
  config: ProductConfig
}

export interface SimilarProduct {
  id: string
  name: string
  why: string
}

/** 兩數相差超過 pct（相對值） */
function differs(a: number, b: number, pct = 0.01): boolean {
  if (!(Number.isFinite(a) && Number.isFinite(b))) return false
  if (b === 0) return a !== 0
  return Math.abs(a - b) / Math.abs(b) > pct
}

function range(nums: number[]): { min: number; max: number } | null {
  const v = nums.filter((n) => Number.isFinite(n))
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null
}

/**
 * 新品項建立後的「找參考、核異常」：
 *   1. 從既有品項找類似的（同主板／同印刷方式／同第二板結構），當參考
 *   2. 切割時間、包裝產能、耗損、成本率 跟參考品項比，跑出範圍就標
 *   3. Excel 上的單價（板材／PET／印刷／貼合／清洗／配件）跟價格表現價比，手打不一致就標
 *   4. 解析時的警告（公式被改、手打常數）一併列出
 */
export function checkDerivedProduct(
  derived: DerivedProduct,
  input: AcrylicInput,
  parseWarnings: string[],
  references: ReferenceProduct[],
  knownPrices: Map<string, number>,
): { checks: AnomalyCheck[]; similar: SimilarProduct[] } {
  const checks: AnomalyCheck[] = []
  const cfg = derived.config
  const main = cfg.boards.defaultItem

  /* ---- 類似品項 ---- */
  const similar: SimilarProduct[] = []
  for (const r of references) {
    const why: string[] = []
    if (r.config.boards?.options?.some((o) => o.item === main)) why.push('同主板')
    if (r.config.defaultPrintMethod === cfg.defaultPrintMethod) why.push(`同印刷（${cfg.defaultPrintMethod}）`)
    if ((r.config.extraBoards?.length ?? 0) > 0 === cfg.extraBoards.length > 0) why.push(cfg.extraBoards.length ? '都有第二板' : '都是單板')
    if (why.length >= 2) similar.push({ id: r.id, name: r.name, why: why.join('、') })
  }
  const refs = similar.length ? references.filter((r) => similar.some((s) => s.id === r.id)) : references
  const refLabel = similar.length ? `類似品項（${similar.map((s) => s.name).join('、')}）` : '既有品項'

  /* ---- 切割時間 ---- */
  const t1s = refs.map((r) => r.config.cut?.t1).filter((n): n is number => typeof n === 'number' && n > 0)
  const t1r = range(t1s)
  if (!(cfg.cut.t1 > 0)) {
    checks.push({ level: 'warn', field: '切割時間', message: '外形切割時間 t1 = 0，切割段會是 0 元——這份表 L10 沒填？' })
  } else if (t1r && (cfg.cut.t1 < t1r.min * 0.5 || cfg.cut.t1 > t1r.max * 2)) {
    checks.push({ level: 'warn', field: '切割時間', message: `外形切割 ${cfg.cut.t1} 分／板，${refLabel}是 ${t1r.min}～${t1r.max}，差距超過一倍，請確認 L10` })
  } else if (t1r && (cfg.cut.t1 < t1r.min || cfg.cut.t1 > t1r.max)) {
    checks.push({ level: 'info', field: '切割時間', message: `外形切割 ${cfg.cut.t1} 分／板，${refLabel}是 ${t1r.min}～${t1r.max}` })
  }
  if (cfg.cut.t2 > 0 || cfg.cut.t3 > 0) {
    checks.push({ level: 'info', field: '切割時間', message: `有銑槽／蓋板時間（t2=${cfg.cut.t2}、t3=${cfg.cut.t3}），這兩段刀費固定用 12 元刀（Excel 現況）` })
  }

  /* ---- 包裝產能 ---- */
  const caps = refs.map((r) => r.config.packCapacityPerHour).filter((n): n is number => typeof n === 'number' && n > 0)
  const capR = range(caps)
  const cap = cfg.packCapacityPerHour
  if (!(cap > 0)) checks.push({ level: 'warn', field: '包裝產能', message: '包裝產能 L7 讀不到或為 0，包裝人工會除以 0' })
  else if (cap < 30 || cap > 400) checks.push({ level: 'warn', field: '包裝產能', message: `包裝產能 ${cap} 個／人時，超出常平實案範圍 60～200，請確認 L7` })
  else if (capR && (cap < capR.min || cap > capR.max)) checks.push({ level: 'info', field: '包裝產能', message: `包裝產能 ${cap} 個／人時，${refLabel}是 ${capR.min}～${capR.max}` })

  /* ---- 耗損／成本率 ---- */
  if (input.scrapPct !== cfg.scrapPct) checks.push({ level: 'info', field: '耗損率', message: `這份表耗損 ${input.scrapPct}%，新品項套常平廠預設 ${cfg.scrapPct}%` })
  if (input.costRatio < 0.6 || input.costRatio > 0.8) checks.push({ level: 'warn', field: '成本率', message: `這份表成本率 ${input.costRatio}（毛利 ${Math.round((1 - input.costRatio) * 100)}%）超出 0.6～0.8，請確認 C5／L4 是否手打；新品項仍套預設 ${cfg.costRatio}` })
  else if (Math.abs(input.costRatio - cfg.costRatio) > 1e-9) checks.push({ level: 'info', field: '成本率', message: `這份表成本率 ${input.costRatio}（毛利 ${Math.round((1 - input.costRatio) * 100)}%），新品項套常平廠預設 ${cfg.costRatio}（毛利 ${Math.round((1 - cfg.costRatio) * 100)}%）` })

  /* ---- Excel 單價 vs 價格表 ---- */
  const cmp = (field: string, name: string, excel: number) => {
    const cur = knownPrices.get(name)
    if (cur == null) return
    if (excel === 0) checks.push({ level: 'warn', field, message: `「${name}」Excel 這格讀不到或為 0（多半是公式指向外部檔），前台會用價格表現價 ${cur}` })
    else if (differs(excel, cur)) checks.push({ level: 'warn', field, message: `「${name}」Excel 用 ${excel}，價格表現價 ${cur}——這格可能是手打或舊價；前台一律用價格表` })
  }
  for (const b of input.boards) cmp('板材單價', b.item, b.unitPrice)
  if (input.pet.item && input.pet.mode !== 'none') cmp('PET 單價', input.pet.item, input.pet.unitPrice)
  for (const l of input.laminate) cmp('貼合單價', l.item, l.unitPrice)
  if (input.wash.unitPrice > 0) cmp('清洗單價', '清洗', input.wash.unitPrice)
  if (input.print.method === '7151' || input.print.method === 'jingutian') {
    const base = input.print.method === '7151' ? '印刷/7151' : '印刷/金谷田'
    // 單板雙面：PET ×2、Excel 用單面價；彩白彩單張：Excel 用雙面價
    const name = input.print.sides === 2 && input.pet.sides !== 2 ? `${base}/双面` : `${base}/单面`
    cmp('印刷單價', name, input.print.unitPrice)
  } else if (input.print.method === 'koshi') {
    cmp('印刷單價', '印刷/柯氏/单面', input.print.unitPrice)
  }
  for (const line of input.packing) cmp(line.group === 'accessory' ? '配件單價' : '包材單價', line.item, line.unitPrice)

  /* ---- 結構提醒 ---- */
  if (cfg.extraBoards.some((b) => !b.nPerSheet && !b.roundup)) checks.push({ level: 'info', field: '第二板', message: '第二板每盤數跟主板但不進位，請確認 C10 公式' })
  if (input.print.method === 'koshi' && (input.print.versions ?? 1) > 1) checks.push({ level: 'info', field: '柯式版數', message: `柯式版數 ${input.print.versions}，前台由業務填，這裡只影響 golden` })

  /* ---- 解析警告 ---- */
  for (const w of parseWarnings) checks.push({ level: 'info', field: '解析', message: w })

  return { checks, similar }
}
