/**
 * 报价模板 v1.5.x Excel 匯入解析（設計書 §5、§8-④）。
 *
 * 兩件事：
 *   1. `价格表` 分頁 → 價格項目清單 → 跟現有 quote_price_items 比對成差異（new/up/down/same/invalid）
 *   2. 每個「成本分頁」（主产品、5万、2.1万、5000、主产品 (2)…）→ 一筆 golden `proposed`：
 *      input = AcrylicInput（已解析成數字的引擎輸入）、settings_snapshot = 只放跟 seed 不同的常數、
 *      warnings = 讀不到 / 手改的儲存格。
 *
 * 確定性解析，不用 AI：模板結構固定（儲存格座標見設計書 §5），這裡照座標讀。
 * 每格同時看「快取值 v」和「公式 f」：值拿 v（Excel 存檔時算好的），公式只用來判斷
 * 「這格是模板公式、還是被人手打成常數」——手打就進 warnings，讓 Snow 核可時看得到。
 *
 * 依賴限制：只 `import type` 自家型別 + `import * as XLSX from 'xlsx'`，
 * 所以 `node --experimental-strip-types scripts/quote-import-test.mjs` 可以直接載入自我驗證。
 */
import * as XLSX from 'xlsx'
import type { ImportGoldenProposal, ImportPreviewResponse, ImportPriceDiff } from './api'
import type {
  AcrylicInput,
  AcrylicSettings,
  BoardLine,
  LaminateLine,
  PackingLine,
  PetLine,
  PrintMethod,
  PrintSpec,
  Sides,
  WashSpec,
} from './types'

/* ---------------------------------------------------------------- 對外型別 */

export interface ImportPriceItemRaw {
  name: string
  group: string
  /** 轉不成數字（例如 '0,07'）時 null */
  price: number | null
  /** 原始儲存格內容，invalid 時給人看 */
  raw: string
  cell: string
  note?: string
}

export interface ParsedQuoteWorkbook {
  fileName: string
  templateVersion: string
  priceItems: ImportPriceItemRaw[]
  goldenProposals: ImportGoldenProposal[]
  notes: string[]
}

/** 跟 seed/settings.json 一樣的深層部分型別（settings_snapshot 只放差異） */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/* ---------------------------------------------------------------- 儲存格工具 */

type Cell = { t?: string; v?: unknown; f?: string }
type Sheet = Record<string, unknown>

const NON_COST_SHEETS = new Set(['价格表', '计算器', '报价表', '版本信息'])

function cellOf(ws: Sheet | undefined, addr: string): Cell | undefined {
  if (!ws) return undefined
  const c = ws[addr]
  return c && typeof c === 'object' ? (c as Cell) : undefined
}

/** 快取數值；字串是純數字也接受（'12'），其他一律 null */
function num(ws: Sheet | undefined, addr: string): number | null {
  const c = cellOf(ws, addr)
  if (!c || c.v == null) return null
  if (typeof c.v === 'number') return Number.isFinite(c.v) ? c.v : null
  if (typeof c.v === 'boolean') return c.v ? 1 : 0
  const s = String(c.v).trim()
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null
}

function str(ws: Sheet | undefined, addr: string): string {
  const c = cellOf(ws, addr)
  if (!c || c.v == null) return ''
  return String(c.v).trim()
}

/** 公式正規化：去空白、去 $、去開頭 +、大寫；沒有公式回 null（= 這格是常數或空白） */
function formula(ws: Sheet | undefined, addr: string): string | null {
  const c = cellOf(ws, addr)
  if (!c || typeof c.f !== 'string' || c.f === '') return null
  return c.f.replace(/\s+/g, '').replace(/\$/g, '').replace(/^\+/, '').replace(/_XLFN\./gi, '').toUpperCase()
}

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0]?.trim() ?? ''
}

function approxEq(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/* ---------------------------------------------------------------- 拼板（跟 engines/acrylic.ts 同一條公式，複製一份避免 runtime import） */

function nestCount(w: number, h: number, W: number, H: number, gap: number, margin: number): number {
  const We = W - 2 * margin
  const He = H - 2 * margin
  const fit = (a: number, b: number) => {
    if (a <= 0 || b <= 0) return 0
    return Math.max(0, Math.floor((We + gap) / (a + gap) + 1e-9)) * Math.max(0, Math.floor((He + gap) / (b + gap) + 1e-9))
  }
  return Math.max(fit(w, h), fit(h, w))
}

/* ---------------------------------------------------------------- 版本判定 */

interface VersionInfo {
  l2: string
  a1Header: string
  a1Version: 'v1.5.6+' | '舊版' | '未知'
  changelogLast: string
  templateVersion: string
  notes: string[]
}

function detectVersion(wb: XLSX.WorkBook, costSheets: string[]): VersionInfo {
  const notes: string[] = []
  const first = costSheets[0] ? (wb.Sheets[costSheets[0]] as Sheet) : undefined
  const l2 = first ? str(first, 'L2') : ''
  const a1Header = first ? str(first, 'A1') : ''
  const a1Version: VersionInfo['a1Version'] =
    a1Header === '报价单号' ? 'v1.5.6+' : a1Header === '来样/单日期' ? '舊版' : '未知'

  // 各成本分頁 L2 不一致也記下來
  for (const name of costSheets.slice(1)) {
    const v = str(wb.Sheets[name] as Sheet, 'L2')
    if (v && v !== l2) notes.push(`分頁「${name}」L2 模板版本 ${v} 與「${costSheets[0]}」的 ${l2} 不一致`)
  }

  // 版本信息 分頁：A 欄最後一個 vX.Y.Z
  let changelogLast = ''
  const ver = wb.Sheets['版本信息'] as Sheet | undefined
  if (ver) {
    for (let r = 1; r <= 200; r++) {
      const v = str(ver, `A${r}`)
      if (/^v\d+\.\d+\.\d+$/i.test(v)) changelogLast = v
    }
  } else {
    notes.push('找不到「版本信息」分頁，無法交叉比對版本')
  }

  const templateVersion = l2 || changelogLast || (a1Version === '舊版' ? 'v1.5.x（舊版表頭）' : '未知')
  if (!l2) notes.push('成本分頁 L2 沒有模板版本，改用版本信息／表頭推斷')
  if (l2 && a1Version === '舊版' && compareVersion(l2, 'v1.5.6') >= 0) {
    notes.push(`L2 標 ${l2} 但 A1 表頭仍是舊版「来样/单日期」（v1.5.6 起應為「报价单号」）`)
  }
  if (l2 && a1Version === 'v1.5.6+' && compareVersion(l2, 'v1.5.6') < 0) {
    notes.push(`L2 標 ${l2} 但 A1 表頭已是「报价单号」（v1.5.6 才有），版本標示可能未更新`)
  }
  if (a1Version === '未知' && a1Header) notes.push(`A1 表頭「${a1Header}」不是已知模板表頭，請確認是否為 报价模板`)
  if (l2 && changelogLast && l2 !== changelogLast) {
    notes.push(`L2 模板版本 ${l2} 與「版本信息」最末版本 ${changelogLast} 不一致（柯氏分支模板常見；以 L2 為準）`)
  }
  return { l2, a1Header, a1Version, changelogLast, templateVersion, notes }
}

function compareVersion(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map(Number)
  const pb = b.replace(/^v/i, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/* ---------------------------------------------------------------- 价格表 */

const HEADER_GROUP: Record<string, string> = {
  印刷: '印刷',
  贴合: '工序',
  亚克力板: '板材',
  PET: 'PET',
  五金配件: '五金',
  包装袋: '包材',
  其他品项: '其他',
  不常用品项: '其他',
}

/** 舊版 价格表 沒有 PET 標頭（PET 列夾在板材段後面），用名稱補判 */
function groupByName(name: string, headerGroup: string): string {
  if (/PET|炫彩膜/i.test(name)) return 'PET'
  if (/亚克力板|软磁|海棠花/.test(name)) return '板材'
  if (/^印刷\//.test(name)) return '印刷'
  if (/^贴合|^注沙$|^清洗$|^放晶片$|^压克力贴压克力$/.test(name)) return '工序'
  return headerGroup
}

function parsePriceSheet(ws: Sheet | undefined, notes: string[]): ImportPriceItemRaw[] {
  const items: ImportPriceItemRaw[] = []
  if (!ws) {
    notes.push('找不到「价格表」分頁，略過價格差異')
    return items
  }
  const ref = typeof ws['!ref'] === 'string' ? (ws['!ref'] as string) : 'A1:F200'
  const lastRow = Number(ref.split(':')[1]?.replace(/[A-Z]/gi, '') ?? 200) || 200

  const readCol = (nameCol: string, priceCol: string, defaultGroup: string, startRow: number) => {
    let group = defaultGroup
    for (let r = startRow; r <= lastRow; r++) {
      const name = str(ws, `${nameCol}${r}`)
      const priceCell = cellOf(ws, `${priceCol}${r}`)
      const hasPrice = !!priceCell && priceCell.v != null && String(priceCell.v).trim() !== ''
      if (!name) continue
      if (!hasPrice) {
        // 只有名稱沒單價 = 段落標頭（印刷／贴合／亚克力板…）
        if (HEADER_GROUP[name]) group = HEADER_GROUP[name]
        else if (nameCol === 'A') notes.push(`价格表!${nameCol}${r}「${name}」沒有單價，當作段落標頭略過`)
        continue
      }
      const raw = String(priceCell.v).trim()
      const price = num(ws, `${priceCol}${r}`)
      items.push({
        name,
        group: groupByName(name, group),
        price,
        raw,
        cell: `价格表!${priceCol}${r}`,
        note: price == null ? `單價「${raw}」不是數字` : undefined,
      })
    }
  }
  readCol('A', 'B', '其他', 2)
  readCol('E', 'F', '其他', 2)

  // 同名兩價（A39/A40 260×300×4.8 6.7 / 7.2）：第二筆標 invalid，讓人決定
  const seen = new Map<string, ImportPriceItemRaw>()
  for (const it of items) {
    const prev = seen.get(it.name)
    if (prev) {
      if (it.price != null && prev.price != null && !approxEq(it.price, prev.price)) {
        it.note = `同名重複：${prev.cell}=${prev.raw}、${it.cell}=${it.raw}，請人工決定`
        it.price = null
        notes.push(`价格表 同名兩價「${it.name}」：${prev.raw} / ${it.raw}（${prev.cell} / ${it.cell}）`)
      } else {
        it.note = `與 ${prev.cell} 重複（同價），略過`
        it.price = null
      }
    } else {
      seen.set(it.name, it)
    }
  }
  return items
}

/** 跟現有價格表比對（currentPrices：name → price；表不存在時給空 Map，全部會是 new） */
export function diffPrices(items: ImportPriceItemRaw[], currentPrices: Map<string, number>): ImportPriceDiff[] {
  return items.map((it) => {
    if (it.price == null) {
      return { name: it.name, group: it.group, current: currentPrices.get(it.name) ?? null, incoming: 0, status: 'invalid', note: it.note }
    }
    const cur = currentPrices.get(it.name)
    if (cur == null) return { name: it.name, group: it.group, current: null, incoming: it.price, status: 'new', note: it.note }
    if (approxEq(cur, it.price, 1e-9)) return { name: it.name, group: it.group, current: cur, incoming: it.price, status: 'same', note: it.note }
    return { name: it.name, group: it.group, current: cur, incoming: it.price, status: it.price > cur ? 'up' : 'down', note: it.note }
  })
}

/* ---------------------------------------------------------------- 成本分頁 → AcrylicInput */

interface CalcSheetInfo {
  layoutWcm: number | null
  layoutHcm: number | null
  gapCm: number | null
  marginCm: number | null
  partWcm: number | null
  partHcm: number | null
}

function readCalculator(wb: XLSX.WorkBook): CalcSheetInfo {
  const ws = wb.Sheets['计算器'] as Sheet | undefined
  const gapMm = num(ws, 'B7')
  const marginMm = num(ws, 'B8')
  return {
    layoutWcm: num(ws, 'B5'),
    layoutHcm: num(ws, 'B6'),
    gapCm: gapMm == null ? null : gapMm / 10,
    marginCm: marginMm == null ? null : marginMm / 10,
    partWcm: num(ws, 'B11'),
    partHcm: num(ws, 'B12'),
  }
}

function sidesOf(text: string): Sides {
  return /双面|雙面/.test(text) ? 2 : 1
}

function isCostSheet(ws: Sheet | undefined): boolean {
  if (!ws) return false
  const b5 = num(ws, 'B5')
  const l3 = num(ws, 'L3')
  return b5 != null && l3 != null && l3 > 0
}

interface ParsedSheet {
  input: AcrylicInput
  /** 從該檔實際讀到的常數（以 base 為底覆蓋），之後跟 base 做 diff 成 snapshot */
  fileSettings: AcrylicSettings
  warnings: string[]
  expectedCost: number
  expectedPrice: number
  orderNo: string
  productName: string
}

/** 包材列 C 欄公式 → 數量模式 */
function parsePackingQty(
  f: string | null,
  constant: number | null,
  rowModes: Map<number, PackingLine>,
): { mode: PackingLine['mode']; k?: number; n?: number } | { error: string } {
  if (f == null) {
    if (constant == null) return { error: '數量空白' }
    return { mode: 'fixed', n: constant }
  }
  let m: RegExpMatchArray | null
  if (/^E9$/.test(f)) return { mode: 'per_unit', k: 1 }
  if ((m = f.match(/^E9\*(\d+(?:\.\d+)?)$/)) || (m = f.match(/^(\d+(?:\.\d+)?)\*E9$/))) return { mode: 'per_unit', k: Number(m[1]) }
  if ((m = f.match(/ROUNDUP\(E9\/(\d+(?:\.\d+)?),0\)/))) return { mode: 'per_n_units', n: Number(m[1]) }
  if ((m = f.match(/^C(\d+)(?:\*(\d+(?:\.\d+)?))?$/))) {
    const refRow = Number(m[1])
    const k = m[2] ? Number(m[2]) : 1
    const ref = rowModes.get(refRow)
    if (ref && ref.mode === 'per_n_units' && ref.n) return { mode: 'per_box', k, n: ref.n }
    return { error: `引用 C${refRow} 但該列不是「每 n 件一箱」` }
  }
  return { error: `數量公式「=${f}」無法辨識` }
}

function packingGroup(name: string): PackingLine['group'] {
  if (/开版|開版|费用|費用|烫金|燙金|纳米|外发|外發/.test(name)) return 'outsourced'
  if (/OPP|袋|纸箱|紙箱|平卡|气泡|氣泡|箱/.test(name)) return 'packing'
  return 'accessory'
}

function parseCostSheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  calc: CalcSheetInfo,
  base: AcrylicSettings,
): ParsedSheet {
  const ws = wb.Sheets[sheetName] as Sheet
  const w: string[] = []
  const warn = (cell: string, msg: string) => w.push(`${sheetName}!${cell}：${msg}`)
  const fs: AcrylicSettings = JSON.parse(JSON.stringify(base))

  /* ---- 快速輸入區 ---- */
  const qty = num(ws, 'L3') ?? 0
  const scrapPct = num(ws, 'L5')
  if (scrapPct == null) warn('L5', '報廢率空白，改用 10')
  const nSheet = num(ws, 'L6')
  if (nSheet == null || nSheet <= 0) warn('L6', '每盤數量讀不到')
  const packCap = num(ws, 'L7')
  if (packCap == null || packCap <= 0) warn('L7', '包裝產能空白，改用 100')
  const sidesA = sidesOf(str(ws, 'L8'))
  const sidesP = sidesOf(str(ws, 'L9'))
  const t1 = num(ws, 'L10') ?? 0
  const t2 = num(ws, 'L11') ?? 0
  const t3 = num(ws, 'L12') ?? 0
  if (num(ws, 'L10') == null) warn('L10', '外形切割時間空白，當 0')

  // 成本率 C5：模板 =1-(L4/100)；C款手打常數
  const c5 = num(ws, 'C5')
  const c5f = formula(ws, 'C5')
  let costRatio = c5 ?? 0
  if (c5f == null) {
    if (c5 == null) warn('C5', '成本率空白')
    else warn('C5', `成本率為手打常數 ${c5}（模板公式 =1-L4/100）`)
  } else if (!/^1-\(?L4\/100\)?$/.test(c5f)) {
    warn('C5', `成本率公式「=${c5f}」不是模板公式`)
  } else if (c5 == null) {
    const l4 = num(ws, 'L4')
    costRatio = l4 == null ? 0 : 1 - l4 / 100
  }

  /* ---- 拼板：計算器 + L6 交叉驗證 ---- */
  let nOverride: number | null = null
  if (calc.gapCm != null) fs.nesting.gapCm = calc.gapCm
  if (calc.marginCm != null) fs.nesting.marginCm = calc.marginCm
  const partWcm = calc.partWcm ?? 0
  const partHcm = calc.partHcm ?? 0
  if (calc.partWcm == null || calc.partHcm == null) warn('计算器!B11:B12', '單件尺寸讀不到，input.partWcm/partHcm 為 0，請人工補')
  const hasLayout = calc.layoutWcm != null && calc.layoutHcm != null
  if (hasLayout && nSheet != null && partWcm > 0 && partHcm > 0) {
    const auto = nestCount(partWcm, partHcm, calc.layoutWcm as number, calc.layoutHcm as number, fs.nesting.gapCm, fs.nesting.marginCm)
    if (auto !== nSheet) {
      nOverride = nSheet
      warn('L6', `每盤數量 ${nSheet} 與計算器套版 ${calc.layoutWcm}×${calc.layoutHcm} 算出的 ${auto} 不同（可能是圓形模式或手改），以 L6 為準寫入 nOverride`)
    }
  } else if (nSheet != null && !hasLayout) {
    warn('计算器!B5:B6', '套版尺寸讀不到，主板改以 nPerSheet 直接給每盤數')
  }

  /* ---- ① 材料 ---- */
  const boards: BoardLine[] = []
  const mainItem = str(ws, 'A9')
  if (!mainItem) warn('A9', '主板材名稱空白')
  const c9f = formula(ws, 'C9')
  if (c9f == null) warn('C9', `主板盤數為手打常數 ${num(ws, 'C9')}（模板公式 ROUNDUP(E9/H9,0)×單雙面）`)
  else if (!/ROUNDUP\(E9\/H9,0\)/.test(c9f)) warn('C9', `主板盤數公式「=${c9f}」不是模板公式`)
  boards.push({
    key: 'main',
    item: mainItem || '（未填）',
    unitPrice: num(ws, 'B9') ?? 0,
    layoutWcm: hasLayout ? (calc.layoutWcm as number) : undefined,
    layoutHcm: hasLayout ? (calc.layoutHcm as number) : undefined,
    nPerSheet: hasLayout ? undefined : (nSheet ?? undefined),
    roundup: true,
    sides: sidesA,
    printed: true,
    laminated: true,
    cut: true,
  })
  if (num(ws, 'B9') == null) warn('B9', '主板單價讀不到')

  const c17f = formula(ws, 'C17')
  const c18f = formula(ws, 'C18')
  const accItem = str(ws, 'A10')
  let hasAcc = false
  if (accItem) {
    hasAcc = true
    const c10f = formula(ws, 'C10')
    const c10v = num(ws, 'C10')
    let nPerSheet: number | undefined
    let roundup = true
    let m: RegExpMatchArray | null
    if (c10f == null) {
      if (c10v != null && c10v > 0 && qty > 0) {
        nPerSheet = qty / c10v
        roundup = false
        warn('C10', `第二板盤數為手打常數 ${c10v}，換算成每盤 ${nPerSheet.toFixed(4)} 件（不進位）`)
      } else warn('C10', '第二板盤數空白')
    } else if (/ROUNDUP\(E9\/H9,0\)/.test(c10f)) {
      roundup = true
    } else if ((m = c10f.match(/^E9\/(\d+(?:\.\d+)?)$/))) {
      nPerSheet = Number(m[1])
      roundup = false
      warn('C10', `第二板盤數 =E9/${m[1]} 手打每盤數（不進位），照抄`)
    } else if (/^E9$/.test(c10f)) {
      nPerSheet = 1
      roundup = false
    } else {
      warn('C10', `第二板盤數公式「=${c10f}」無法辨識，改用主板每盤數進位`)
    }
    boards.push({
      key: 'acc',
      item: accItem,
      unitPrice: num(ws, 'B10') ?? 0,
      nPerSheet,
      roundup,
      sides: c10f != null && /L8/.test(c10f) ? sidesA : 1,
      printed: !!c17f && /C10/.test(c17f),
      laminated: !!c18f && /C10/.test(c18f),
      cut: false,
    })
  }
  if (str(ws, 'A12') && (num(ws, 'B12') ?? 0) > 0) {
    warn('A12', `第二膜／軟磁「${str(ws, 'A12')}」引擎尚未支援，這段成本（D12）未計入`)
  }

  // PET
  const petItem = str(ws, 'A11')
  const c11f = formula(ws, 'C11')
  const petPrice = num(ws, 'B11') ?? 0
  let pet: PetLine
  let m: RegExpMatchArray | null
  if (!petItem || (c11f == null && (num(ws, 'C11') ?? 0) === 0)) {
    pet = { item: petItem || '無', unitPrice: petPrice, mode: 'none', sides: sidesP, kPet: 2 }
    if (!petItem && c11f != null) warn('A11', 'PET 名稱空白但 C11 有公式，視為無 PET')
  } else if (c11f != null && /\+\d+/.test(c11f) && /C9/.test(c11f)) {
    // 柯氏：C9/k*1.1+600
    const k = (m = c11f.match(/C9\/(\d+(?:\.\d+)?)/)) ? Number(m[1]) : 1
    const allow = (m = c11f.match(/\*(\d+(?:\.\d+)?)/)) ? Number(m[1]) : 1
    const trial = (m = c11f.match(/\+(\d+(?:\.\d+)?)/)) ? Number(m[1]) : 0
    fs.koshi.allowancePct = Math.round((allow - 1) * 10000) / 100
    fs.koshi.trialSheets = trial
    pet = { item: petItem, unitPrice: petPrice, mode: 'koshi_sheet', sides: sidesP, kPet: k }
  } else if (c11f != null && /ROUNDUP/.test(c11f)) {
    pet = { item: petItem, unitPrice: petPrice, mode: 'roundup_plates', sides: sidesP, kPet: 2 }
  } else if (c11f == null) {
    warn('C11', `PET 盤數為手打常數 ${num(ws, 'C11')}，改用 ROUNDUP(Q/N) 口徑，成本可能對不上`)
    pet = { item: petItem, unitPrice: petPrice, mode: 'roundup_plates', sides: sidesP, kPet: 2 }
  } else {
    warn('C11', `PET 盤數公式「=${c11f}」無法辨識，改用 ROUNDUP(Q/N) 口徑`)
    pet = { item: petItem, unitPrice: petPrice, mode: 'roundup_plates', sides: sidesP, kPet: 2 }
  }

  /* ---- ② 印刷／貼合／清洗 ---- */
  const a17 = str(ws, 'A17')
  let method: PrintMethod = 'none'
  if (/柯氏|柯式/.test(a17)) method = 'koshi'
  else if (/7151/.test(a17)) method = '7151'
  else if (/金谷田|百川/.test(a17)) method = 'jingutian'
  else if (a17) warn('A17', `印刷方式「${a17}」無法辨識（7151／百川(原金谷田)／柯氏），視為無印刷`)
  const printSides = sidesOf(a17)
  const b17 = num(ws, 'B17') ?? 0
  if (a17 && formula(ws, 'B17') == null) warn('B17', `印刷單價為手打常數 ${b17}（模板由价格表 XLOOKUP 帶入）`)
  // F 款（無印刷）的 A17 仍寫「印刷/柯氏/单面」但 C17／C11 都空白，Excel D17 = B17×C17 = 0：
  // 這種要視為無印刷，不能預設 1 版（會多算一版製版費 1760）
  if (method === 'koshi' && (num(ws, 'C17') ?? 0) <= 0 && (num(ws, 'C11') ?? 0) <= 0 && pet.mode === 'none') {
    warn('A17', `A17 標「${a17}」但 C17／C11 都空白，視為無印刷（F 款）`)
    method = 'none'
  }
  const print: PrintSpec = { method, sides: printSides, unitPrice: method === 'none' ? 0 : b17 }
  if (method === 'koshi') {
    // Excel 的 B17 已是「雙面每版價」（3520）；引擎 PrintSpec.unitPrice 是單面每版價再 ×sides
    print.unitPrice = printSides === 2 ? b17 / 2 : b17
    const v = num(ws, 'C17')
    const c17fk = formula(ws, 'C17')
    if (c17fk != null) warn('C17', `柯氏版數應為手填常數，卻是公式「=${c17fk}」，取快取值 ${v}`)
    print.versions = v != null && v > 0 ? v : 1
    if (v == null || v <= 0) warn('C17', '柯氏版數空白，當 1 版')
    // 加印（A19 / B19 / C19 = MAX(0, C11-600-1000)）
    if (/加印/.test(str(ws, 'A19'))) {
      print.extraUnitPrice = num(ws, 'B19') ?? 0
      const c19f = formula(ws, 'C19')
      if (c19f != null && /C11/.test(c19f)) {
        const subs = [...c19f.matchAll(/-(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]))
        print.extraFreeSheets = subs.reduce((s, x) => s + x, 0)
      } else {
        print.extraFreeSheets = base.koshi.extraFreeSheets
        warn('C19', `加印張數公式「${c19f ?? '常數'}」不是 MAX(0,C11-600-1000)，免費張數改用 ${base.koshi.extraFreeSheets}`)
      }
    } else {
      print.extraUnitPrice = 0
      print.extraFreeSheets = base.koshi.extraFreeSheets
      warn('A19', '柯氏印刷但沒有「加印额外费用」列，加印費以 0 計')
    }
  } else if (method !== 'none') {
    if (c17f == null) warn('C17', `印刷盤數為手打常數 ${num(ws, 'C17')}（模板 =C11）`)
    else if (!/^C11(\+C10)?$/.test(c17f) && !/^C10\+C11$/.test(c17f)) warn('C17', `印刷盤數公式「=${c17f}」不是 C11 或 C11+C10`)
  }

  const laminate: LaminateLine[] = []
  const platesFromFormula = (f: string | null, cell: string, fallback: string[]): string[] => {
    if (f == null) {
      warn(cell, `盤數為手打常數 ${num(ws, cell.replace(/^.*!/, ''))}，改用 ${fallback.join('+')}`)
      return fallback
    }
    const keys: string[] = []
    if (/C9/.test(f)) keys.push('main')
    if (/C10/.test(f)) {
      if (hasAcc) keys.push('acc')
      else warn(cell, '公式引用第二板 C10 但 A10 沒有第二板材')
    }
    if (keys.length === 0) {
      warn(cell, `盤數公式「=${f}」無法辨識，改用 ${fallback.join('+')}`)
      return fallback
    }
    return keys
  }
  for (const r of [18, 20]) {
    const item = str(ws, `A${r}`)
    if (!item) continue
    if (r === 20 && !/贴合|貼合|注沙|放晶片/.test(item)) {
      warn(`A${r}`, `工序列「${item}」引擎尚未支援，未計入`)
      continue
    }
    if (formula(ws, `C${r}`) == null && (num(ws, `C${r}`) ?? 0) <= 0) {
      // F 款：A18 仍寫「贴合/单面」但 C18 空白，Excel D18 = B18×C18 = 0 → 不進貼合段
      warn(`C${r}`, `「${item}」盤數空白，視為不貼合（D${r} = 0）`)
      continue
    }
    laminate.push({ item, unitPrice: num(ws, `B${r}`) ?? 0, platesFrom: platesFromFormula(formula(ws, `C${r}`), `C${r}`, ['main']) })
    if (num(ws, `B${r}`) == null) warn(`B${r}`, `「${item}」單價讀不到`)
  }
  if (method !== 'koshi') {
    const a19 = str(ws, 'A19')
    if (a19 && (num(ws, 'B19') ?? 0) > 0) warn('A19', `工序列「${a19}」引擎尚未支援，未計入`)
  }

  const washPrice = num(ws, 'B21') ?? 0
  const c21f = formula(ws, 'C21')
  const wash: WashSpec = { unitPrice: washPrice, platesFrom: 'main' }
  if (str(ws, 'A21') && !/清洗/.test(str(ws, 'A21'))) warn('A21', `第 21 列不是清洗而是「${str(ws, 'A21')}」，仍照清洗口徑計`)
  if (c21f == null) {
    if (washPrice > 0) warn('C21', `清洗盤數為手打常數 ${num(ws, 'C21')}，改用主板盤數`)
  } else if (/^C18$/.test(c21f) || /^C20$/.test(c21f)) {
    wash.platesFrom = 'laminate'
  } else {
    const mul = (m = c21f.match(/\*(\d+(?:\.\d+)?)$/)) ? Number(m[1]) : 1
    const core = c21f.replace(/\*\d+(?:\.\d+)?$/, '')
    if (/^C9$/.test(core)) wash.platesFrom = 'main'
    else if (/^C9\+C10$/.test(core) || /^C10\+C9$/.test(core)) wash.platesFrom = hasAcc ? ['main', 'acc'] : 'main'
    else warn('C21', `清洗盤數公式「=${c21f}」無法辨識，改用主板盤數`)
    if (mul !== 1) wash.multiplier = mul
  }

  /* ---- ③ 切割常數 ---- */
  const h26f = formula(ws, 'H26')
  if (h26f != null) {
    if ((m = h26f.match(/^L10\*(\d+(?:\.\d+)?)$/))) {
      fs.cut.outlineTimeFactor = Number(m[1])
      fs.flags.outlineScrapFactorFixed = true
    } else if (/L10\*\(1\+L5\/100\)/.test(h26f)) {
      fs.flags.outlineScrapFactorFixed = false
    } else warn('H26', `外形銑時間公式「=${h26f}」無法辨識，沿用 seed 係數`)
  } else warn('H26', `外形銑時間為手打常數 ${num(ws, 'H26')}，沿用 seed 係數`)

  const e26f = formula(ws, 'E26')
  if (e26f != null && (m = e26f.match(/^(\d+(?:\.\d+)?)\*60\/H26\*(\d+(?:\.\d+)?)\*(\d+(?:\.\d+)?)\*(\d+(?:\.\d+)?)$/))) {
    fs.cut.hoursPerDay = Number(m[1])
    fs.cut.machines = Number(m[2])
    fs.cut.shiftFactor = Number(m[3])
    fs.cut.efficiency = Number(m[4])
  } else if (e26f != null) warn('E26', `產能公式「=${e26f}」無法辨識，沿用 seed`)

  const machines: AcrylicSettings['cut']['machinesMonthly'] = []
  for (const r of [26, 27, 28]) {
    const monthly = num(ws, `C${r}`)
    const name = str(ws, `A${r}`) || `設備 ${r - 25}`
    if (monthly == null) {
      warn(`C${r}`, `「${name}」月折舊讀不到`)
      continue
    }
    machines.push({ name: base.cut.machinesMonthly[r - 26]?.name ?? name, monthly })
  }
  if (machines.length === base.cut.machinesMonthly.length) {
    const same = machines.every((x, i) => approxEq(x.monthly, base.cut.machinesMonthly[i].monthly, 1e-9))
    if (!same) fs.cut.machinesMonthly = machines
  } else if (machines.length > 0) {
    fs.cut.machinesMonthly = machines
  }

  const d29f = formula(ws, 'D29')
  if (d29f != null && (m = d29f.match(/^(\d+(?:\.\d+)?)\/(\d+)\/E26\*C9$/))) {
    fs.cut.laborMonthly = Number(m[1])
    fs.cut.workDays = Number(m[2])
  } else warn('D29', `切割人工公式「${d29f == null ? '常數 ' + num(ws, 'D29') : '=' + d29f}」無法辨識，沿用 seed 14500/26`)
  if (d29f != null && !/E26\*C9$/.test(d29f)) warn('D29', '切割人工沒有只乘主板 C9（第二板可能進了切割段）')

  const knife = (cell: string, label: string): number | null => {
    const v = num(ws, cell)
    if (v == null) warn(cell, `${label}刀費讀不到，沿用 seed`)
    else if (formula(ws, cell) == null) warn(cell, `${label}刀費為手打常數 ${v}（模板 =(5*2)*3*單價*26）`)
    return v
  }
  const k30 = knife('C30', '外形')
  const k39 = knife('C39', '銑槽')
  const k48 = knife('C48', '蓋板')
  if (k30 != null) fs.cut.knifeOutlineMonthly = k30
  if (k39 != null) fs.cut.knifeGrooveMonthly = k39
  if (k48 != null) fs.cut.knifeCoverMonthly = k48

  /* ---- ④ 包裝人工 ---- */
  const staff: AcrylicSettings['packLabor']['staff'] = []
  let packHours: number | null = null
  let packDays: number | null = null
  for (const r of [54, 55, 56, 57]) {
    const name = str(ws, `A${r}`)
    if (!name) continue
    const bf = formula(ws, `B${r}`)
    const cf = formula(ws, `C${r}`)
    const df = formula(ws, `D${r}`)
    const share = cf && (m = cf.match(/^C53\*(\d+(?:\.\d+)?)$/)) ? Number(m[1]) : null
    if (share == null) {
      warn(`C${r}`, `「${name}」分攤比公式「${cf ?? '常數'}」無法辨識，沿用 seed`)
      continue
    }
    const shortName = name.replace(/人工/g, '').replace(/[（(].*$/, '').trim() || name
    if (bf && (m = bf.match(/^(\d+(?:\.\d+)?)\/(\d+)$/))) {
      packDays = Number(m[2])
      if (df && (m = df.match(/^B\d+\/(\d+)\*C\d+$/))) packHours = Number(m[1])
      staff.push({ name: shortName, monthly: Number(bf.match(/^(\d+(?:\.\d+)?)\//)![1]), share })
    } else {
      const hourly = num(ws, `B${r}`)
      if (hourly == null) {
        warn(`B${r}`, `「${name}」時薪讀不到`)
        continue
      }
      staff.push({ name: shortName, hourly, share })
    }
  }
  if (staff.length === base.packLabor.staff.length) {
    const same = staff.every((x, i) => {
      const b = base.packLabor.staff[i]
      return approxEq(x.share, b.share) && (x.monthly ?? -1) === (b.monthly ?? -1) && (x.hourly ?? -1) === (b.hourly ?? -1)
    })
    if (!same) fs.packLabor.staff = staff
  } else if (staff.length > 0) {
    fs.packLabor.staff = staff
  }
  if (packHours != null) fs.packLabor.hoursPerDay = packHours
  if (packDays != null) fs.packLabor.workDays = packDays

  /* ---- ⑤ 包材／五金／手填列 A68:C78 ---- */
  const packing: PackingLine[] = []
  const rowModes = new Map<number, PackingLine>()
  for (let r = 68; r <= 78; r++) {
    // 模板 A70 是「纸箱40 * 28 * 23cm *」（結尾孤立的 *），去掉不影響比對
    const name = str(ws, `A${r}`).replace(/\s*\*$/, '')
    if (!name) continue
    const unitPrice = num(ws, `B${r}`)
    if (unitPrice == null) {
      warn(`B${r}`, `「${name}」單價「${str(ws, `B${r}`) || '空白'}」讀不到，未計入`)
      continue
    }
    const q = parsePackingQty(formula(ws, `C${r}`), num(ws, `C${r}`), rowModes)
    if ('error' in q) {
      warn(`C${r}`, `「${name}」${q.error}，未計入`)
      continue
    }
    const line: PackingLine = { item: name, unitPrice, mode: q.mode, group: packingGroup(name) }
    if (q.k != null) line.k = q.k
    if (q.n != null) line.n = q.n
    packing.push(line)
    rowModes.set(r, line)
  }
  if (packing.length === 0) warn('A68:C78', '沒有任何包材／配件列')

  const input: AcrylicInput = {
    qty,
    partWcm,
    partHcm,
    nOverride,
    boards,
    pet,
    print,
    laminate,
    wash,
    cut: { t1, t2, t3 },
    scrapPct: scrapPct ?? 10,
    costRatio,
    packCapacityPerHour: packCap != null && packCap > 0 ? packCap : 100,
    packing,
  }

  return {
    input,
    fileSettings: fs,
    warnings: w,
    expectedCost: num(ws, 'B5') ?? 0,
    expectedPrice: num(ws, 'D5') ?? 0,
    orderNo: str(ws, 'A1') === '报价单号' ? firstLine(str(ws, 'A2')) : '',
    productName: firstLine(str(ws, 'B2')),
  }
}

/* ---------------------------------------------------------------- settings 差異（deepPartial） */

/** 回傳 file 跟 base 不同的葉子；陣列整個比較、整個取代（跟 golden.ts deepMerge 的規則一致） */
export function diffSettings<T>(base: T, file: T): DeepPartial<T> | undefined {
  if (Array.isArray(base) || Array.isArray(file)) {
    return JSON.stringify(base) === JSON.stringify(file) ? undefined : (file as unknown as DeepPartial<T>)
  }
  if (isPlainObject(base) && isPlainObject(file)) {
    const out: Record<string, unknown> = {}
    for (const k of new Set([...Object.keys(base), ...Object.keys(file)])) {
      const d = diffSettings(base[k], file[k])
      if (d !== undefined) out[k] = d
    }
    return Object.keys(out).length > 0 ? (out as DeepPartial<T>) : undefined
  }
  if (typeof base === 'number' && typeof file === 'number') return approxEq(base, file, 1e-9) ? undefined : (file as DeepPartial<T>)
  return base === file ? undefined : (file as DeepPartial<T>)
}

/* ---------------------------------------------------------------- 主入口 */

/**
 * 解析整本工作簿。baseSettings 給 seed/settings.json 的 acrylic_settings（或線上 quote_settings），
 * 只當「讀不到的格子沿用哪個值」的底；settings_snapshot 存該檔實際讀到的完整常數（設計書 §8-④），
 * 之後後台改了全域參數（例如刀費），已核可的 golden 仍用自己的快照驗邏輯，不會假失敗。
 */
export function parseQuoteWorkbook(wb: XLSX.WorkBook, fileName: string, baseSettings: AcrylicSettings): ParsedQuoteWorkbook {
  const notes: string[] = []
  const costSheets = wb.SheetNames.filter((n) => !NON_COST_SHEETS.has(n) && isCostSheet(wb.Sheets[n] as Sheet))
  if (costSheets.length === 0) notes.push('找不到成本分頁（B5 有成本單價且 L3 有訂單數量的分頁），沒有 golden 提案')

  const version = detectVersion(wb, costSheets)
  notes.push(...version.notes)
  if (version.a1Version === '舊版') notes.push(`表頭為舊版「来样/单日期」（${version.l2 || '無 L2'}）；柯氏分支 v1.5.2 的價格表沒有 7151／金谷田 列`)

  const priceItems = parsePriceSheet(wb.Sheets['价格表'] as Sheet | undefined, notes)
  const invalid = priceItems.filter((p) => p.price == null)
  if (invalid.length > 0) notes.push(`价格表 有 ${invalid.length} 筆單價無法使用：${invalid.map((p) => `${p.name}（${p.raw}）`).join('、')}`)

  const calc = readCalculator(wb)
  if (!wb.Sheets['计算器']) notes.push('找不到「计算器」分頁，套版尺寸／單件尺寸／間距讀不到')

  const fileStem = fileName.replace(/\.xlsx?$/i, '')
  const goldenProposals: ImportGoldenProposal[] = costSheets.map((sheet) => {
    const p = parseCostSheet(wb, sheet, calc, baseSettings)
    const snapshot = p.fileSettings
    const knifeNote = p.fileSettings.cut.knifeOutlineMonthly !== baseSettings.cut.knifeOutlineMonthly
      ? `；外形刀月費 ${p.fileSettings.cut.knifeOutlineMonthly}`
      : ''
    const head = [p.orderNo || fileStem, p.productName].filter(Boolean).join(' ')
    return {
      name: `${head}｜${sheet}｜${p.input.qty.toLocaleString('en-US')} pcs`,
      sheet,
      template_version: `${version.templateVersion}${version.a1Version === '舊版' ? '（舊版表頭）' : ''}${knifeNote}`,
      qty: p.input.qty,
      expected_cost: p.expectedCost,
      expected_price: p.expectedPrice,
      input: p.input,
      settings_snapshot: snapshot,
      warnings: p.warnings,
    }
  })

  return { fileName, templateVersion: version.templateVersion, priceItems, goldenProposals, notes }
}

/** route 用：Buffer → 預覽回應 */
export function buildImportPreview(
  data: Uint8Array,
  fileName: string,
  baseSettings: AcrylicSettings,
  currentPrices: Map<string, number>,
  extraNotes: string[] = [],
): ImportPreviewResponse {
  // Node ESM 載入 CJS 的 xlsx 時 named export 由 cjs-module-lexer 偵測；保險起見 fallback 到 default
  const lib = ((XLSX as unknown as { default?: typeof XLSX }).default ?? XLSX) as typeof XLSX
  const wb = lib.read(data, { type: 'buffer', cellFormula: true, cellNF: false })
  const parsed = parseQuoteWorkbook(wb, fileName, baseSettings)
  return {
    fileName,
    templateVersion: parsed.templateVersion,
    priceDiff: diffPrices(parsed.priceItems, currentPrices),
    goldenProposals: parsed.goldenProposals,
    notes: [...extraNotes, ...parsed.notes],
  }
}
