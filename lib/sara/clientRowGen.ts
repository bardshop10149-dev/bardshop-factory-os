// 瀏覽器端的「出單表列 → SARA 工序列」產生邏輯。
//
// 這套規則原本內嵌在 app/admin/sara/exchange/SingleOrderConvert.tsx 裡，2026-09-21
// 新增「改單」面板時要用同一套，抽出來共用避免變成第三份複製（伺服器端的排程版本
// 在 lib/sara/autoProcessGen.ts，兩者的工時/盤數/機台規則必須一致）。
//
// 為什麼不直接呼叫伺服器版：autoProcessGen 是「整天份、寫進交換區」的流程，
// 這裡要的是「單一品項、先預覽再決定」，兩者的邊界不同。共用的是計算規則本身。

import { supabase } from '../supabaseClient'
import { type SaraRow } from './buildSaraRow'
import { computePriorityFromDue, type PriorityRule } from './priorityRules'

export interface SheetHitRow {
  sheet_date: string
  order_number: string
  item_code: string
  item_name: string
  quantity: number
  due: string
  pan_count: number
  /** 依廠區選擇的製令/採購/請購單號（＝ SARA 的 Manufacturing Order Number） */
  ref_number?: string
  line_seq?: string
  customer?: string
  factory?: 'T' | 'C' | 'O'
  assigned_machine?: string
}

// 工時計算規則——與 process-gen / autoProcessGen 一致：
// 轉運站固定 qty=1；包裝站用生產數量；其他站點盤數優先；不足 10 分鐘補至 10 分鐘
export const isPackagingStation = (s: string) => s.includes('包裝站')
export const isTransitStation = (s: string) => s.includes('轉運')
export const isPrintStation2F6F = (s: string) => s === '印刷站2F' || s === '印刷站6F'

export function calcEst(std: number, qty: number, panCount: number, station: string): number {
  if (std === 0) return 0
  const isPacking = isPackagingStation(station)
  const isTransit = isTransitStation(station)
  const effQty = isTransit ? 1 : (panCount > 0 && !isPacking) ? panCount : qty
  return Math.max(10, Math.round(std * effQty * 10) / 10)
}

export function fmtToday(): string {
  const d = new Date()
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外' }

/**
 * 把出單表跨日期搜尋的結果解析成可產生工序的列。
 * 同一列（訂單號+序號+品號）可能出現在多個日期，只留最新日期那筆。
 */
export function parseSheetHits(
  results: Array<{ sheet_date: string; rows: Record<string, unknown>[] }>,
): SheetHitRow[] {
  const seen = new Set<string>()
  const parsed: SheetHitRow[] = []
  const sorted = [...results].sort((a, b) => b.sheet_date.localeCompare(a.sheet_date))
  for (const sheet of sorted) {
    for (const r of sheet.rows) {
      const orderNo = String(r.order_number ?? '').trim()
      const itemCode = String(r.item_code ?? '').trim()
      if (!orderNo || !itemCode) continue
      const lineSeq = String(r.line_no_input ?? '').trim() || String(r.match_line_no ?? '').trim()
      const dedupeKey = `${orderNo}|${lineSeq}|${itemCode}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const qty = parseFloat(String(r.quantity ?? '').replace(/,/g, '')) || 0
      if (qty <= 0) continue
      const factory = ['T', 'C', 'O'].includes(String(r.factory ?? '')) ? String(r.factory) as 'T' | 'C' | 'O' : undefined
      // 依廠區選擇對應單號：台北=製令 / 常平=採購單 / 委外=請購單（與 process-gen 一致）。
      // 常平/委外一律加上「-行號」：採購/請購單整張單共用、不分行，裸單號送給 SARA 會讓
      // Manufacturing Order Number + Product Name 完全相同、只留下最後一筆。
      const poSubNo = String(r.po_sub_no ?? '').trim()
      const prSubNo = String(r.pr_sub_no ?? '').trim()
      const poNumber = String(r.po_number ?? '').trim()
      const prNumber = String(r.pr_number ?? '').trim()
      const refNumber =
        factory === 'C' ? (poNumber ? `${poNumber}${poSubNo ? `-${poSubNo}` : ''}` : undefined) :
        factory === 'O' ? (prNumber ? `${prNumber}${prSubNo ? `-${prSubNo}` : ''}` : undefined) :
                          String(r.mo_number ?? '').trim() || undefined
      parsed.push({
        sheet_date: sheet.sheet_date,
        order_number: orderNo,
        item_code: itemCode,
        item_name: String(r.item_name ?? r.note ?? '').trim(),
        quantity: qty,
        due: String(r.delivery_date ?? '').trim(),
        pan_count: parseFloat(String(r.plate_count ?? '').replace(/,/g, '')) || 0,
        ref_number: refNumber,
        line_seq: lineSeq || undefined,
        customer: String(r.customer ?? '').trim() || undefined,
        factory,
        assigned_machine: String(r.machine ?? r.assigned_machine ?? '').trim() || undefined,
      })
    }
  }
  return parsed
}

/** 台北廠製令的機台以 argoerp_mo_machine_assign 為準（與 process-gen 一致），就地補進 rows */
export async function applyMachineAssignments(rows: SheetHitRow[]): Promise<void> {
  const tMoNums = [...new Set(rows.filter(r => r.factory === 'T' && r.ref_number).map(r => r.ref_number!))]
  if (tMoNums.length === 0) return
  const { data } = await supabase
    .from('argoerp_mo_machine_assign')
    .select('mo_number, machine')
    .in('mo_number', tMoNums)
  const map = new Map((data ?? []).filter(m => m.machine).map(m => [m.mo_number, m.machine as string]))
  for (const r of rows) {
    if (r.factory === 'T' && r.ref_number) {
      const fromTable = map.get(r.ref_number)
      if (fromTable) r.assigned_machine = fromTable
    }
  }
}

/** 品項的預設途程（item_routes）＋ 全部途程清單（供更換工序的下拉） */
export async function loadRouteMeta(itemCodes: string[]): Promise<{
  defaultRoutes: Record<string, string>
  routeOptions: string[]
}> {
  const [{ data: irData }, { data: roData }] = await Promise.all([
    itemCodes.length
      ? supabase.from('item_routes').select('item_code, route_id').in('item_code', itemCodes)
      : Promise.resolve({ data: [] as Array<{ item_code: string; route_id: string }> }),
    supabase.from('route_operations').select('route_id'),
  ])
  const defaultRoutes: Record<string, string> = {}
  for (const r of (irData ?? []) as Array<{ item_code: string; route_id: string }>) defaultRoutes[r.item_code] = r.route_id
  const routeOptions = [...new Set(((roData ?? []) as Array<{ route_id: string }>).map(r => r.route_id))].sort()
  return { defaultRoutes, routeOptions }
}

/**
 * 依指定途程把出單表列展開成 SARA 工序列。
 * routeOf 回傳空字串代表這一列沒有途程，會被跳過並記進 warns。
 */
export async function generateSaraRows(
  rows: SheetHitRow[],
  routeOf: (row: SheetHitRow, index: number) => string,
  priorityRules: PriorityRule[],
): Promise<{ rows: SaraRow[]; warns: string[] }> {
  const warns: string[] = []
  const today = fmtToday()

  const routeIds = [...new Set(rows.map((r, i) => routeOf(r, i)).filter(Boolean))]
  const missing = rows.filter((r, i) => !routeOf(r, i))
  if (missing.length > 0) {
    warns.push(`${missing.length} 列沒有途程（item_routes 無對應且未手動指定），已跳過：${[...new Set(missing.map(r => r.item_code))].slice(0, 4).join('、')}`)
  }

  type RoRow = { route_id: string; sequence: number; op_name: string }
  const { data: roData } = routeIds.length
    ? await supabase.from('route_operations').select('route_id,sequence,op_name').in('route_id', routeIds).order('sequence')
    : { data: [] as RoRow[] }
  const roMap = new Map<string, { sequence: number; op_name: string }[]>()
  for (const r of (roData ?? []) as RoRow[]) {
    const arr = roMap.get(r.route_id) ?? []
    arr.push({ sequence: r.sequence, op_name: r.op_name })
    roMap.set(r.route_id, arr)
  }

  const uniqueOps = [...new Set(((roData ?? []) as RoRow[]).map(r => r.op_name))]
  type OtRow = { op_name: string; station: string; std_time_min: number }
  const { data: otData } = uniqueOps.length
    ? await supabase.from('operation_times').select('op_name,station,std_time_min').in('op_name', uniqueOps)
    : { data: [] as OtRow[] }
  const otMap = new Map<string, { station: string; std_time_min: number }>(
    ((otData ?? []) as OtRow[]).map(r => [r.op_name, { station: r.station ?? '', std_time_min: Number(r.std_time_min ?? 0) }])
  )

  const out: SaraRow[] = []
  rows.forEach((row, idx) => {
    const routeId = routeOf(row, idx)
    if (!routeId) return
    const ops = roMap.get(routeId) ?? []
    if (ops.length === 0) {
      warns.push(`途程「${routeId}」在 route_operations 沒有工序資料（${row.item_code}），已跳過`)
      return
    }
    for (const op of ops) {
      const ot = otMap.get(op.op_name)
      const station = ot?.station ?? ''
      const std = ot?.std_time_min ?? 0
      const jobQty = (row.pan_count > 0 && !isPackagingStation(station)) ? row.pan_count : row.quantity
      out.push({
        order_number: row.order_number,
        mfg_order_number: row.ref_number || row.order_number,
        product_name: row.item_code,
        product_desc: row.item_name,
        lot_number: row.line_seq || row.order_number,
        prod_qty: row.quantity,
        due: row.due,
        priority: computePriorityFromDue(row.due, priorityRules),
        earliest_start: today,
        job_seq: op.sequence,
        workcenter: station,
        job_name: op.op_name,
        job_qty: jobQty,
        outsourcing: '',
        est_time: calcEst(std, row.quantity, row.pan_count, station),
        time_unit: '分鐘',
        bom: '',
        mat_req_qty: '',
        customer: row.customer,
        assigned_machine: (row.factory === 'T' && isPrintStation2F6F(station) && row.assigned_machine) ? row.assigned_machine : '',
        factory: row.factory,
      })
    }
  })
  return { rows: out, warns }
}
