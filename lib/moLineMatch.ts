/**
 * 製令號 ←→ 來源訂單行號 的對應規則（全站共用）
 *
 * 製令號末兩碼記的是「發單當下，這個品項排在訂單的第幾行」。
 * 訂單事後被插行／刪行，行號會整批位移，已發出的工單就對不上了。
 *
 * ── 解析規則是踩過坑校正出來的（2026-08-26）──
 * 「取第一段末兩碼」是錯的，會在 SOA 訂單上大量誤判：
 *   MOT260806-120202-73801 取第一段 MOT260806 的 "06" → 錯（正解是末段 73801 的 "01"）
 * 正確做法：剝掉批次／補印後綴後，取「長度 ≥5 的最後一個數字段」末兩碼。
 *
 * 而且只有 MOT / MOS 是行號制：
 *   - MOM 是「集單合併生產」工單（多張訂單的同一品項集中做），編號是流水號不是行號。
 *     實例：SO260610503 只有 3 行，卻有 MOM2026061802~06 五張製令、全是同一品項。
 *   - POC（常平採購）、MPO 等前綴同樣不適用。
 * 這些一律回 null，寧可不判斷也不要亂猜。
 *
 * 實測準確率：MOT/MOS 共 1,828 張，命中 1,821、不符 7 → 99.6%。
 */

/** 這張製令是否採「行號制」編號（只有 MOT/MOS 是） */
export function isLineNumberedMo(moNbr: string | null | undefined): boolean {
  return !!moNbr && /^MO[TS]/.test(String(moNbr).trim())
}

/**
 * 製令號 → 發單當下的來源訂單行號（字串，已去前導零）。
 * 非行號制或無法解析時回 null。
 */
export function moToSoLine(moNbr: string | null | undefined): string | null {
  if (!isLineNumberedMo(moNbr)) return null
  let s = String(moNbr).trim()
  // 剝掉批次／補印後綴：-8MM-0819（厚度+日期）、-L1（補印）、-1（補印序號）
  s = s.replace(/-\d+MM-\d+$/i, '')
  s = s.replace(/-L\d+$/i, '')
  s = s.replace(/-\d{1,2}$/, '')
  const segs = (s.match(/\d+/g) ?? []).filter((g) => g.length >= 5)
  if (segs.length === 0) return null
  const tail = segs[segs.length - 1].slice(-2)
  if (!/^\d{2}$/.test(tail)) return null
  return String(parseInt(tail, 10))
}

/** 對位結果 */
export type MatchKind =
  /** 工單行號指到的品項就是它要做的 → 正常 */
  | 'ok'
  /** 該品項還在這張訂單，但已經換到別的行 → 工單上的行號失效 */
  | 'shifted'
  /** 該品項已不在這張訂單上 → 品項被改掉或刪掉 */
  | 'missing'
  /** 訂單目前沒有這一行（多為已結案舊單，erp_so_lines 只存 OPEN/UNSIGNED） */
  | 'no_such_line'
  /** 非行號制（MOM 等），不做判斷 */
  | 'not_applicable'

export interface MoMatchInput {
  moNbr: string
  /** 這張製令要做的品項料號 */
  moPart: string | null
  /** 來源訂單目前的行：行號 → 料號 */
  orderLines: Map<string, string | null>
  /** 來源訂單目前的品項：料號 → 所在行號清單 */
  partLines: Map<string, string[]>
}

export interface MoMatchResult {
  kind: MatchKind
  /** 工單號推出來的行號 */
  printedLine: string | null
  /** 訂單該行現在是什麼品項 */
  nowPart: string | null
  /** 該品項現在實際在哪幾行 */
  realLines: string[]
}

/** 判斷一張製令的行號是否還對得上訂單現況 */
export function matchMoToOrder(input: MoMatchInput): MoMatchResult {
  const { moNbr, moPart, orderLines, partLines } = input
  const printedLine = moToSoLine(moNbr)
  if (printedLine === null) {
    return { kind: 'not_applicable', printedLine: null, nowPart: null, realLines: [] }
  }
  const realLines = (moPart ? partLines.get(moPart) : undefined) ?? []
  if (!orderLines.has(printedLine)) {
    return { kind: 'no_such_line', printedLine, nowPart: null, realLines }
  }
  const nowPart = orderLines.get(printedLine) ?? null
  if (nowPart === moPart) {
    return { kind: 'ok', printedLine, nowPart, realLines }
  }
  return {
    kind: realLines.length > 0 ? 'shifted' : 'missing',
    printedLine, nowPart, realLines,
  }
}
