// 包裝專區 P1 分線輪 — D66 手動加入查詢：某 SO 各品項行「為什麼不在待排池」（純函式，lines.md §六.1～§六.2）
//
// 判定只為了「讓主管看懂」，不影響加入後的行為（加入後一律進 'mn'）。資料一律取自 EIP 鏡像（不查 ARGO）。
// 重用 classify.ts 的 isNonPhysicalLine／normDate／NOT_ON_SARA_WINDOW_DAYS／CHANGPING_VENDOR／buildLotRoutes／routePackaging，
// saraKeys.ts 的 isNonScheduleDocType／decodeSaraMo／soLineDigitsKey，避免規則分岔。
// ⚠ 廠商代碼只在這裡用來推測途程類型，輸出（ManualLookupLine）不含任何廠商欄位。
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum。

import type { ManualAbsenceReason, ManualInclusionMeta, ManualLookupLine, ManualRouteType, YMD } from './scheduleTypes'
import { POOL_BLOCK_META, type PackagingCard, type PoolBlockId } from './types'
import {
  CHANGPING_VENDOR,
  NOT_ON_SARA_WINDOW_DAYS,
  buildLotRoutes,
  isNonPhysicalLine,
  normDate,
  routeKeyOf,
  routePackaging,
  type RawLot,
  type RawRecord,
  type RawSchedule,
  type RawSheetRow,
  type RawSoLine,
} from './classify'
import { decodeSaraMo, isNonScheduleDocType, soLineDigitsKey } from './saraKeys'
import { manualBlockedReason, soLineNoStr } from './manualPool'
import type { LineSold } from './salesAlloc'

/** 採購行（伺服器端只取判斷需要的欄位；vendor 不外流） */
export interface ManualLookupPurchase {
  docNo: string
  subNo: string
  itemCode: string | null
  vendor: string | null
  /** POC：＝SO 項次（同 classify.ts RawPoLine.tpn_part_no） */
  soLineHint: string | null
}

export interface ManualLookupInput {
  so: string
  today: YMD
  /** erp_so_lines 中這張 SO 的全部行（查不到＝ERP 已結案或單號錯） */
  soLines: readonly RawSoLine[]
  /** 待排池「正常區塊」（不含 'mn'）中屬於這張 SO 的卡 */
  poolCards: readonly PackagingCard[]
  /** 有效（未移出）的手動加入：soLineKey → meta */
  manual: ReadonlyMap<string, ManualInclusionMeta>
  /** 有效手動加入中「已全數完成」的行（manualRecordEnded＝'done'；省略＝沒有） */
  manualDone?: ReadonlySet<string>
  /** 出單表中這張 SO 的列（近 365 天） */
  sheetRows: readonly RawSheetRow[]
  /** 塔台未結案批（sara_lot_progress，doc_nbr＝這張 SO） */
  lots: readonly RawLot[]
  /** 這些批的排程（sara_wip_schedule） */
  schedule: readonly RawSchedule[]
  /** 報工紀錄（sara_wip_records：這些批的 mo＋MOT／MOS 解碼得到這張 SO 的製令＋舊式製令號＝SO 本身） */
  records: readonly RawRecord[]
  /** 採購（erp_pj_sync 採購單，來源單＝這張 SO） */
  purchases: readonly ManualLookupPurchase[]
  /** 製令（erp_mo_lines，source_order＝這張 SO）的品號 */
  moItemCodes: readonly string[]
  /** D73：這張 SO 各行的已銷貨分配（allocateSoldToLines）；null／省略＝銷貨同步未啟用 */
  sold?: ReadonlyMap<string, LineSold> | null
  /**
   * D103：各行已勾完成的擺放合計（soLineKey → 量；不分何時完成）。手動加入的數量是總量（含已完成），
   * 加入前就有的完成量也會算進去 → 查詢結果帶出來給加入對話框提示。省略＝不帶（與 D103 前相同）。
   */
  completedByKey?: ReadonlyMap<string, number>
  /**
   * D104：這張 SO 各行「未復原」的結案（soLineKey → 誰／何時／備註）。有 → 原因 closed、不可勾選
   * （加入後也會被待排池排除；要拉回請到「已結案清單」復原）。省略＝沒有（或結案表未建）。
   */
  closed?: ReadonlyMap<string, { closedByName: string | null; closedAt: string; note: string | null }>
}

const up = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase()
const addCalendarDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const mdOf = (ymd: string) => `${+ymd.slice(5, 7)}/${+ymd.slice(8, 10)}`

/** 單一 SO 行的塔台狀態：有沒有未結案批、上過塔台的證據（已結案批的製令號）、包裝站是否已報完工 */
function towerStateOf(so: string, line: string, qty: number, input: ManualLookupInput): {
  openLots: RawLot[]
  closedEvidence: string | null
  packagedDone: boolean
} {
  const soU = up(so)
  const key = soLineDigitsKey(soU, line)
  const lotMatches = (l: { mo_nbr: string; doc_nbr?: string | null; lot_nbr: string | null; so_line_no?: string | null }) => {
    // 製令／舊式：批號＝項次；MOT／MOS：另有 so_line_no；也可由製令號解碼（D47）
    if (up(l.doc_nbr) === soU && (soLineNoStr(l.lot_nbr) === line || (/^(MOT|MOS)/i.test(l.mo_nbr) && soLineNoStr(l.so_line_no) === line))) return true
    const d = decodeSaraMo(l.mo_nbr, l.lot_nbr)
    return !!d && !!key && soLineDigitsKey(d.soDigits, d.line) === key
  }
  const openLots = input.lots.filter((l) => lotMatches(l))
  const openMos = new Set(openLots.map((l) => up(l.mo_nbr)))
  // 上過塔台的證據：報工紀錄解碼到這一行，或舊式製令號（＝SO 號本身、lot＝項次）
  let closedEvidence: string | null = null
  for (const r of input.records) {
    if (openMos.has(up(r.mo_nbr))) continue
    const d = decodeSaraMo(r.mo_nbr, r.lot_nbr)
    if (d && key && soLineDigitsKey(d.soDigits, d.line) === key) { closedEvidence = r.mo_nbr; break }
  }
  let packagedDone = false
  if (openLots.length > 0) {
    const routes = buildLotRoutes([...input.schedule], [...input.records])
    const mine = openLots
      .map((l) => routes.get(routeKeyOf(l.mo_nbr, l.product_name, l.lot_nbr)))
      .filter((r): r is NonNullable<typeof r> => !!r)
    if (mine.length > 0) packagedDone = routePackaging(mine, qty).allFinished
  }
  return { openLots, closedEvidence, packagedDone }
}

/** 建議途程類型：有常平採購（C01510）＝常平、其他廠商採購＝委外、否則自製（D41；廠商代碼不外露） */
function suggestRoute(purchases: readonly ManualLookupPurchase[]): ManualRouteType {
  if (purchases.some((p) => up(p.vendor) === CHANGPING_VENDOR)) return '常平'
  if (purchases.length > 0) return '委外'
  return '自製'
}

/**
 * lines.md §六.2 原因判定（依序檢查，可多個）：
 * 1 in_pool、2 manual_active（都不可勾選；有這兩個就不再往下判）；3 non_physical、4 zero_qty（不可勾選）；
 * 5 non_schedule_doc（出單表上這行只出現在素材單／包裝單，D46）；6 tower_closed（有上過塔台的證據但沒有未結案批，D43／D47）；
 * 7 packaged_done（未結案批的包裝站工序已人工報完工，D45）；8 sheet_stale（出單日超過 30 天且塔台查無，D44）；
 * 9 waiting_source（有採購或製令來源，但 5～8 都不是）；10 unknown（以上皆非）。
 * D73：sold_out（ARGO 已全數銷貨）排在 4 之後、不可勾選（加入後也會被待排池排除）。
 * D104：closed（主管已結案、未復原）排在 sold_out 之後、不可勾選（加入後也會被待排池排除；要拉回請先復原）。
 * 解讀：塔台未結案批、但前站未開工的行歸在 waiting_source（P0 只列前站已開工）。
 */
export function explainManualLines(input: ManualLookupInput): ManualLookupLine[] {
  const soU = up(input.so)
  const poolByLine = new Map<string, PackagingCard[]>()
  for (const c of input.poolCards) {
    let arr = poolByLine.get(c.soLineKey)
    if (!arr) { arr = []; poolByLine.set(c.soLineKey, arr) }
    arr.push(c)
  }
  const staleBefore = addCalendarDays(input.today, -(NOT_ON_SARA_WINDOW_DAYS - 1))
  const moItems = new Set(input.moItemCodes.map(up).filter(Boolean))

  const lines = [...input.soLines].sort((a, b) => Number(soLineNoStr(a.line_no) ?? 0) - Number(soLineNoStr(b.line_no) ?? 0))
  const out: ManualLookupLine[] = []
  for (const sl of lines) {
    const lineNo = soLineNoStr(sl.line_no)
    if (!lineNo) continue
    const soLineKey = `${soU}-${lineNo}`
    const orderQty = Number(sl.order_qty_oru) || 0
    const itemCode = (sl.mbp_part ?? '').trim() || null
    const reasons: ManualAbsenceReason[] = []

    // 1. 已在待排池（列出所在區塊與數量）
    const inPoolCards = poolByLine.get(soLineKey) ?? []
    const blockQty = new Map<PoolBlockId, number>()
    for (const c of inPoolCards) blockQty.set(c.block, (blockQty.get(c.block) ?? 0) + c.qtyCard)
    const inPoolBlocks = [...blockQty].map(([block, qty]) => ({ block, title: POOL_BLOCK_META[block].title, qty: Math.round(qty * 1000) / 1000 }))
    if (inPoolBlocks.length > 0) reasons.push({ code: 'in_pool', label: `已在待排池：${inPoolBlocks.map((b) => b.title).join('、')}` })
    // 2. 已手動加入
    const manual = input.manual.get(soLineKey) ?? null
    const manualDone = !!manual && !!input.manualDone?.has(soLineKey)
    if (manual) {
      const who = `${manual.addedByName ?? manual.addedBy}・${manual.addedAt.slice(5, 10).replace('-', '/')}`
      reasons.push({ code: 'manual_active', label: manualDone ? `已手動加入且已全數完成（${who}），待排池已無此卡` : `已手動加入（${who}）` })
    }

    // 3／4. 不可勾選
    if (isNonPhysicalLine(sl.mbp_part, sl.description)) reasons.push({ code: 'non_physical', label: '費用行（運費、設計費等），不需包裝' })
    if (!(orderQty > 0)) reasons.push({ code: 'zero_qty', label: '訂單量為 0' })
    // D73：ARGO 已全數銷貨（同品號多行依項次分配後，本行未出貨量 ≤ 0）
    const sold = input.sold?.get(soLineKey) ?? null
    const soldOut = !!sold && orderQty > 0 && sold.unshippedQty <= 1e-9
    if (soldOut) {
      reasons.push({ code: 'sold_out', label: `ARGO 已全數銷貨（${Math.min(sold.soldQty, orderQty)}/${orderQty}${sold.lastSaleDate ? `，最後 ${mdOf(sold.lastSaleDate)}` : ''}）` })
    }
    // D104：主管已結案（未復原）
    const closed = input.closed?.get(soLineKey) ?? null
    if (closed) {
      const who = `${closed.closedByName ?? '主管'}・${closed.closedAt.slice(5, 10).replace('-', '/')}`
      reasons.push({ code: 'closed', label: `主管已結案（${who}${closed.note ? `，${closed.note}` : ''}）` })
    }
    const blocked = manualBlockedReason(sl)
      ?? (soldOut ? 'ARGO 已全數銷貨（出貨），不需包裝；加入後也會被待排池排除' : null)
      ?? (closed ? '主管已結案，加入後也會被待排池排除；要拉回請先到「已結案清單」復原' : null)

    // 採購來源：POC 項次＝本行、或品號相同；出單表記的採購單號-行對到本行也算
    const sheetForLine = input.sheetRows.filter((r) => up(r.order_number) === soU && soLineNoStr(r.line_no) === lineNo)
    const sheetPo = new Set(sheetForLine.filter((r) => r.po_number && r.po_sub_no).map((r) => `${up(r.po_number)}|${String(r.po_sub_no).trim()}`))
    const purchases = input.purchases.filter((p) =>
      soLineNoStr(p.soLineHint) === lineNo
      || (!!itemCode && up(p.itemCode) === up(itemCode))
      || sheetPo.has(`${up(p.docNo)}|${String(p.subNo).trim()}`))
    const suggestedRouteType = suggestRoute(purchases)

    // 費用行／訂單量 0 本來就不能加入，不再往下判（其他原因只會是雜訊）
    if (inPoolBlocks.length === 0 && !manual && !blocked) {
      const detail: ManualAbsenceReason[] = []
      // 5. D46：出單表上這行只出現在素材單／包裝單
      if (sheetForLine.length > 0 && sheetForLine.every((r) => isNonScheduleDocType(r.doc_type))) {
        detail.push({ code: 'non_schedule_doc', label: '出單表上只有「素材單／包裝單」（不上塔台）' })
      }
      const tower = towerStateOf(soU, lineNo, orderQty, input)
      // 6. D43／D47：上過塔台、但沒有未結案批
      if (tower.openLots.length === 0 && tower.closedEvidence) {
        detail.push({ code: 'tower_closed', label: `塔台批已結案（${tower.closedEvidence}）` })
      }
      // 7. D45：未結案批的包裝站已人工報完工
      if (tower.packagedDone) detail.push({ code: 'packaged_done', label: '塔台包裝站已報完工' })
      // 8. D44：出單日超過 30 天且塔台查無
      const normalSheets = sheetForLine.filter((r) => !isNonScheduleDocType(r.doc_type))
      const latestSheet = normalSheets.map((r) => normDate(r.sheet_date)).filter((d): d is string => !!d).sort().pop() ?? null
      if (latestSheet && latestSheet < staleBefore && tower.openLots.length === 0 && !tower.closedEvidence) {
        detail.push({ code: 'sheet_stale', label: `出單 ${mdOf(latestSheet)} 已超過 ${NOT_ON_SARA_WINDOW_DAYS} 天，塔台查無` })
      }
      reasons.push(...detail)
      if (detail.length === 0) {
        const hasSource = purchases.length > 0 || tower.openLots.length > 0 || (!!itemCode && moItems.has(up(itemCode)))
        if (hasSource) reasons.push({ code: 'waiting_source', label: '有採購或製令來源，但尚未達進池條件（未寄出／未到貨／前站未開工等）' })
        else reasons.push({ code: 'unknown', label: '查無來源（可能尚未發單或資料未同步）' })
      }
    }

    // D103：已完成量（> 0 才帶鍵，其他行的輸出形狀與 D103 前相同）
    const completedQty = Math.round((input.completedByKey?.get(soLineKey) ?? 0) * 1000) / 1000
    const state: ManualLookupLine['state'] = inPoolBlocks.length > 0 ? 'in_pool' : manual ? 'manual' : 'absent'
    const blockedReason = state === 'in_pool'
      ? `已在待排池（${inPoolBlocks.map((b) => b.title).join('、')}），不需手動加入`
      : state === 'manual'
        ? '已手動加入，請改用「改數量」'
        : blocked
    out.push({
      soLineKey,
      lineNo,
      itemCode,
      itemName: (sl.description ?? '').trim() || null,
      packing: (() => { const p = (sl.packing ?? '').trim(); return p && p !== '.' ? p : null })(),
      unit: sl.unit_of_measure_oru ?? null,
      orderQty,
      dueDate: normDate(sl.duedate),
      state,
      inPoolBlocks,
      manual,
      manualDone,
      reasons,
      selectable: state === 'absent' && blocked == null,
      blockedReason,
      suggestedRouteType,
      suggestedQty: orderQty > 0 ? orderQty : 0,
      ...(completedQty > 1e-9 ? { completedQty } : {}),
    })
  }
  return out
}
