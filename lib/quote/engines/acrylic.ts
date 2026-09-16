/**
 * 壓克力工序成本引擎（設計書 §5，逆向自常平廠 报价模板 v1.5.x）。
 *
 * 純函式：同樣的 (input, settings) 永遠得到同樣的結果，沒有 I/O、沒有查表、
 * 沒有 runtime import（只有 `import type`），所以 golden 測試可以用
 * `node --experimental-strip-types scripts/quote-golden.mjs` 直接跑，不需要 tsx。
 *
 * 鐵則（§5.0）：
 *   1. 照抄 Excel 行為，包含已知瑕疵；每個瑕疵是 settings.flags 的一個旗標。
 *   2. 常數全部從參數來，這裡一個數字都不寫死。
 *   3. 分母永遠是訂單數 Q；報廢率在每段最後一步乘（G = F × (1 + s/100)）。
 *
 * 每段回傳 lines[]（名稱 / 算式 / 金額），算式字串用真實數字組成，
 * 前台五段明細展開後業務看得到「這個價怎麼來的」。
 */
import type {
  AcrylicInput,
  AcrylicResult,
  AcrylicSettings,
  BoardLine,
  CalcLine,
  CalcSegment,
} from '../types'

/* ---------------------------------------------------------------- 拼板 §5.2 */

export interface NestResult {
  count: number
  cols: number
  rows: number
  rotated: boolean
}

/** 浮點保護：29.4 / 5.4 這種除法在 IEEE754 下可能差 1e-15，先加 epsilon 再 floor */
function floorSafe(x: number): number {
  return Math.floor(x + 1e-9)
}

/**
 * 每盤可放幾件。對應 计算器!I5:I9：
 *   W_eff = 套版寬 − 2×邊距；fit(w,h) = INT((W_eff+g)/(w+g)) × INT((H_eff+g)/(h+g))
 *   N = MAX(fit(a,b), fit(b,a))
 */
export function nestingCount(
  partWcm: number,
  partHcm: number,
  layoutWcm: number,
  layoutHcm: number,
  gapCm: number,
  marginCm: number,
): NestResult {
  const W = layoutWcm - 2 * marginCm
  const H = layoutHcm - 2 * marginCm
  const fit = (w: number, h: number) => {
    if (w <= 0 || h <= 0) return { cols: 0, rows: 0 }
    const cols = Math.max(0, floorSafe((W + gapCm) / (w + gapCm)))
    const rows = Math.max(0, floorSafe((H + gapCm) / (h + gapCm)))
    return { cols, rows }
  }
  const a = fit(partWcm, partHcm)
  const b = fit(partHcm, partWcm)
  const na = a.cols * a.rows
  const nb = b.cols * b.rows
  if (nb > na) return { count: nb, cols: b.cols, rows: b.rows, rotated: true }
  return { count: na, cols: a.cols, rows: a.rows, rotated: false }
}

/* ---------------------------------------------------------------- helpers */

const fmt = (n: number, d = 2): string =>
  Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: d })

function segment(
  key: CalcSegment['key'],
  name: string,
  lines: CalcLine[],
  qty: number,
  scrapPct: number,
): CalcSegment {
  const amount = lines.reduce((s, l) => s + l.amount, 0)
  const perUnit = qty > 0 ? amount / qty : 0
  return { key, name, amount, perUnit, perUnitWithScrap: perUnit * (1 + scrapPct / 100), lines }
}

function ceilSafe(x: number): number {
  return Math.ceil(x - 1e-9)
}

/* ---------------------------------------------------------------- 引擎 */

export function calcAcrylic(input: AcrylicInput, settings: AcrylicSettings): AcrylicResult {
  const warnings: string[] = []
  const Q = input.qty
  const s = input.scrapPct
  const scrapMul = 1 + s / 100

  const main = input.boards.find((b) => b.key === 'main') ?? input.boards[0]
  if (!main) throw new Error('缺少主板材')

  /* ---- 拼板 ---- */
  let nest = { count: 0, cols: 0, rows: 0, rotated: false }
  if (main.layoutWcm && main.layoutHcm) {
    nest = nestingCount(
      input.partWcm,
      input.partHcm,
      main.layoutWcm,
      main.layoutHcm,
      settings.nesting.gapCm,
      settings.nesting.marginCm,
    )
  } else if (main.nPerSheet) {
    nest = { count: main.nPerSheet, cols: 0, rows: 0, rotated: false }
  }
  const nAuto = nest.count
  const nUsed = input.nOverride && input.nOverride > 0 ? input.nOverride : nAuto
  if (!(nUsed > 0) || !(Q > 0)) {
    return {
      nPerSheetAuto: nAuto,
      nPerSheetUsed: 0,
      nest,
      plates: 0,
      petPlates: 0,
      segments: [],
      costUnit: 0,
      costRatio: input.costRatio,
      quoteUnit: 0,
      marginPct: 0,
      total: 0,
      warnings: [Q > 0 ? '尺寸超過板材可用範圍，無法拼板' : '請輸入數量'],
    }
  }
  if (input.nOverride && nAuto > 0 && input.nOverride > nAuto) {
    warnings.push(`每盤數量 ${input.nOverride} 高於自動計算 ${nAuto}，請確認排版可行`)
  }

  /* ---- 各板盤數 ---- */
  const platesOf = new Map<string, number>()
  for (const b of input.boards) {
    let n: number
    if (b.key === main.key) n = nUsed
    else if (b.nPerSheet && b.nPerSheet > 0) n = b.nPerSheet
    else n = nUsed
    const plates = b.roundup ? ceilSafe(Q / n) * b.sides : (Q / n) * b.sides
    platesOf.set(b.key, plates)
  }
  const C9 = platesOf.get(main.key) ?? 0
  const boardPlates = (pred: (b: BoardLine) => boolean) =>
    input.boards.filter(pred).reduce((sum, b) => sum + (platesOf.get(b.key) ?? 0), 0)

  /* ---- ① 材料 ---- */
  const materialLines: CalcLine[] = []
  for (const b of input.boards) {
    const p = platesOf.get(b.key) ?? 0
    materialLines.push({
      name: b.item,
      formula: `¥${fmt(b.unitPrice)} × ${fmt(p, 4)} 盤`,
      amount: b.unitPrice * p,
    })
  }
  let petPlates = 0
  if (input.pet.mode === 'koshi_sheet') {
    const k = input.pet.kPet > 0 ? input.pet.kPet : 1
    const allowance = 1 + settings.koshi.allowancePct / 100
    petPlates = (C9 / k) * allowance + settings.koshi.trialSheets
    materialLines.push({
      name: input.pet.item,
      formula: `¥${fmt(input.pet.unitPrice)} × (${fmt(C9)} ÷ ${k} × ${fmt(allowance)} + ${settings.koshi.trialSheets} 試機) = ${fmt(petPlates, 1)} 張`,
      amount: input.pet.unitPrice * petPlates,
    })
  } else if (input.pet.mode === 'roundup_plates') {
    petPlates = ceilSafe(Q / nUsed) * input.pet.sides
    materialLines.push({
      name: input.pet.item,
      formula: `¥${fmt(input.pet.unitPrice)} × ${fmt(petPlates)} 張${input.pet.sides === 2 ? '（雙面 ×2）' : ''}`,
      amount: input.pet.unitPrice * petPlates,
    })
  }
  const segMaterial = segment('material', '材料', materialLines, Q, s)

  /* ---- ② 印刷／貼合／清洗 ---- */
  const printLines: CalcLine[] = []
  if (input.print.method === 'koshi') {
    const V = input.print.versions && input.print.versions > 0 ? input.print.versions : 1
    printLines.push({
      name: `印刷／柯式／${input.print.sides === 2 ? '雙面' : '單面'}`,
      formula: `¥${fmt(input.print.unitPrice)} × ${V} 版${input.print.sides === 2 ? ' × 2 面' : ''}`,
      amount: input.print.unitPrice * V * input.print.sides,
    })
    const free = input.print.extraFreeSheets ?? settings.koshi.extraFreeSheets
    const extraUnit = input.print.extraUnitPrice ?? settings.koshi.extraUnitPrice
    const extraSheets = Math.max(0, petPlates - free)
    printLines.push({
      name: '印刷／柯式／加印額外費用',
      formula: `¥${fmt(extraUnit)} × MAX(0, ${fmt(petPlates, 1)} − ${free}) = ${fmt(extraSheets, 1)} 張`,
      amount: extraUnit * extraSheets,
    })
  } else if (input.print.method !== 'none') {
    // 印刷盤數 = PET 盤數 + 要印刷的第二板盤數（模板 C17=C11；登山沟 C17=C11+C10）
    const extraPrinted = boardPlates((b) => b.key !== main.key && b.printed)
    const printPlates = petPlates + extraPrinted
    const label = input.print.method === '7151' ? '7151' : '百川'
    printLines.push({
      // 雙面兩種做法：兩張 PET 各印一面（單面價 × 2 倍張數）／彩白彩單張 PET（雙面價 × 1 倍張數），名稱標清楚
      name: `印刷／${label}／${input.print.sides === 2 ? (input.pet.sides === 2 ? '雙面（兩張 PET 各印一面）' : '雙面（彩白彩單張 PET）') : '單面'}`,
      formula: `¥${fmt(input.print.unitPrice)} × ${fmt(printPlates, 4)} 盤${extraPrinted > 0 ? `（PET ${fmt(petPlates)} + 配件板 ${fmt(extraPrinted, 4)}）` : ''}`,
      amount: input.print.unitPrice * printPlates,
    })
  }
  let laminatePlatesTotal = 0
  for (const lam of input.laminate) {
    const plates = lam.platesFrom.reduce((sum, key) => sum + (platesOf.get(key) ?? 0), 0)
    laminatePlatesTotal += plates
    printLines.push({
      name: lam.item,
      formula: `¥${fmt(lam.unitPrice)} × ${fmt(plates, 4)} 盤`,
      amount: lam.unitPrice * plates,
    })
  }
  if (input.wash.unitPrice > 0) {
    let washPlates: number
    if (input.wash.platesFrom === 'main') washPlates = C9
    else if (input.wash.platesFrom === 'laminate') washPlates = laminatePlatesTotal
    else washPlates = input.wash.platesFrom.reduce((sum, key) => sum + (platesOf.get(key) ?? 0), 0)
    washPlates *= input.wash.multiplier ?? 1
    printLines.push({
      name: '清洗',
      formula: `¥${fmt(input.wash.unitPrice, 4)} × ${fmt(washPlates, 4)} 盤`,
      amount: input.wash.unitPrice * washPlates,
    })
  }
  const segPrint = segment('print', '印刷貼合清洗', printLines, Q, s)

  /* ---- ③ 切割 ×3 ---- */
  const cutLines: CalcLine[] = []
  const cs = settings.cut
  const cutPlates = settings.flags.secondBoardExcludedFromCut ? C9 : boardPlates((b) => b.cut)
  const cutStation = (label: string, minutes: number, knifeMonthly: number, isOutline: boolean) => {
    if (!(minutes > 0)) return
    const factor = isOutline && settings.flags.outlineScrapFactorFixed ? cs.outlineTimeFactor : scrapMul
    const millMin = minutes * factor
    const capacity = ((cs.hoursPerDay * 60) / millMin) * cs.machines * cs.shiftFactor * cs.efficiency
    const days = cutPlates / capacity
    const fixedMonthly = [
      ...cs.machinesMonthly,
      { name: `人工（${fmt(cs.laborMonthly)}元/${cs.workDays}天）`, monthly: cs.laborMonthly },
      { name: '刀費', monthly: knifeMonthly },
    ]
    for (const f of fixedMonthly) {
      cutLines.push({
        name: `${label}／${f.name}`,
        formula: `¥${fmt(f.monthly)} ÷ ${cs.workDays} 天 × ${fmt(days, 4)} 天（${fmt(cutPlates)} 盤 ÷ 產能 ${fmt(capacity, 1)} 盤/天，銑時間 ${fmt(millMin, 2)} 分）`,
        amount: (f.monthly / cs.workDays) * days,
      })
    }
  }
  cutStation('外形', input.cut.t1, cs.knifeOutlineMonthly, true)
  cutStation('銑槽', input.cut.t2, cs.knifeGrooveMonthly, false)
  cutStation('蓋板', input.cut.t3, cs.knifeCoverMonthly, false)
  const segCut = segment('cut', '切割', cutLines, Q, s)

  /* ---- ④ 包裝人工 ---- */
  const packLines: CalcLine[] = []
  const P = input.packCapacityPerHour > 0 ? input.packCapacityPerHour : 1
  const hours = Q / P
  for (const st of settings.packLabor.staff) {
    const rate =
      st.hourly != null
        ? st.hourly
        : (st.monthly ?? 0) / settings.packLabor.workDays / settings.packLabor.hoursPerDay
    packLines.push({
      name: st.name,
      formula: `¥${fmt(rate, 2)}/時 × ${fmt(hours, 2)} 時 × ${fmt(st.share * 100)}%`,
      amount: rate * hours * st.share,
    })
  }
  const segPackLabor = segment('packLabor', '包裝人工', packLines, Q, s)

  /* ---- ⑤ 包裝材料 + 五金 ---- */
  const matLines: CalcLine[] = []
  const boxN = (() => {
    const box = input.packing.find((p) => p.mode === 'per_n_units' && /纸箱|紙箱/.test(p.item))
    return box?.n ?? input.packing.find((p) => p.mode === 'per_n_units')?.n ?? 0
  })()
  let fixedFeeAmount = 0
  for (const p of input.packing) {
    let count = 0
    let formula = ''
    switch (p.mode) {
      case 'per_unit': {
        const k = p.k ?? 1
        count = Q * k
        formula = `¥${fmt(p.unitPrice, 4)} × ${fmt(Q)}${k !== 1 ? ` × ${k}` : ''}`
        break
      }
      case 'per_n_units': {
        const n = p.n && p.n > 0 ? p.n : 1
        count = ceilSafe(Q / n)
        formula = `¥${fmt(p.unitPrice, 4)} × ROUNDUP(${fmt(Q)} ÷ ${n}) = ${fmt(count)}`
        break
      }
      case 'per_box': {
        const n = p.n && p.n > 0 ? p.n : boxN
        const k = p.k ?? 1
        const boxes = n > 0 ? ceilSafe(Q / n) : 0
        count = boxes * k
        formula = `¥${fmt(p.unitPrice, 4)} × ${fmt(boxes)} 箱 × ${k}`
        break
      }
      case 'fixed': {
        count = p.n ?? 1
        formula = `¥${fmt(p.unitPrice, 4)} × ${count} 次`
        fixedFeeAmount += p.unitPrice * count
        break
      }
    }
    matLines.push({ name: p.item, formula, amount: p.unitPrice * count })
  }
  const segPackMaterial = segment('packMaterial', '包材配件', matLines, Q, s)
  if (!settings.flags.fixedFeeScrapApplied && fixedFeeAmount > 0) {
    // 旗標關閉：一次性外發費不乘報廢率（Excel 現況是會乘，預設 true）
    segPackMaterial.perUnitWithScrap =
      ((segPackMaterial.amount - fixedFeeAmount) / Q) * scrapMul + fixedFeeAmount / Q
  }

  /* ---- 彙總 ---- */
  const segments = [segMaterial, segPrint, segCut, segPackLabor, segPackMaterial]
  const costUnit = segments.reduce((sum, g) => sum + g.perUnitWithScrap, 0)
  const r = input.costRatio > 0 ? input.costRatio : 1
  const quoteUnit = costUnit / r
  return {
    nPerSheetAuto: nAuto,
    nPerSheetUsed: nUsed,
    nest,
    plates: C9,
    petPlates,
    segments,
    costUnit,
    costRatio: r,
    quoteUnit,
    marginPct: quoteUnit > 0 ? (1 - costUnit / quoteUnit) * 100 : 0,
    total: quoteUnit * Q,
    warnings,
  }
}
