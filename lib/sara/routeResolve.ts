// 出單表列 → 實際採用的途程，以及「這一列需不需要填盤數」。
//
// 為什麼要抽出來共用：盤數異常的判定必須跟「產生工序時真正會擋下哪些列」用同一套
// 規則，否則出單總表上標的異常會跟實際被擋的列對不上——那種清單比沒有更糟，
// 因為生管會照著補，補完發現還是轉不出去。
//
// 途程解析原本只在 lib/sara/autoProcessGen.ts 裡（routeForRow），現在它與
// 出單總表的盤數異常共用這一份。

import type { SupabaseClient } from '@supabase/supabase-js'
import { isPackagingStation, isTransitStation, normalizeQtyMode } from './estTime'

export const CP_ROUTE = '常平一般壓克力製程'
export const FAKE_KO_ROUTE = '2mm+1mm壓克力貼合/V90單面印刷'
export const O_ROUTES = new Set(['委外/7天回', '委外/9天回', '委外/11天回'])

export interface RouteRowInput {
  item_code: string
  item_spec: string
  factory?: string | null
}

export interface RouteResolution {
  routeId: string | null
  autoRule: 'cp' | 'ko' | null
  anomaly: string | null
}

/**
 * 決定這一列實際要走哪條途程。
 *
 * 規則（與 process-gen 頁面的異常規則 4/5/6 一致）：先做廠區與途程的相符性判定，
 * 不符者視同無途程；接著對無途程／異常的列套用三種自動情境（常平、仿柯/貼合、無）。
 */
export function resolveRoute(row: RouteRowInput, irMap: Map<string, string>): RouteResolution {
  const existing = irMap.get(row.item_code)
  const factory = String(row.factory ?? '')
  const spec = String(row.item_spec ?? '')
  const anomaly =
    (factory === 'C' && existing && existing !== CP_ROUTE) ? `廠區常平但途程非「${CP_ROUTE}」（原：${existing}）`
    : (factory === 'T' && spec.includes('仿柯')) ? '廠區台北但品名含「仿柯」'
    : (factory === 'O' && existing && !O_ROUTES.has(existing)) ? `廠區委外但途程非標準委外途程（原：${existing}）`
    : null
  if (existing && !anomaly) return { routeId: existing, autoRule: null, anomaly: null }
  if (factory === 'C') return { routeId: CP_ROUTE, autoRule: 'cp', anomaly }
  if (factory === 'T' && (spec.includes('仿柯') || spec.includes('貼合'))) {
    return { routeId: FAKE_KO_ROUTE, autoRule: 'ko', anomaly }
  }
  return { routeId: null, autoRule: null, anomaly }
}

export interface PlateRuleMeta {
  /** 品號 → 途程（item_routes） */
  irMap: Map<string, string>
  /** 途程 → 需要盤數的工序名稱（已排除包裝站／轉運站） */
  panOpsByRoute: Map<string, string[]>
  /** 工序名稱 → 站點，拿來講清楚是哪一站要盤數 */
  stationOf: Map<string, string>
}

/**
 * 載入判定盤數用的主檔。
 *
 * 「需要盤數」的定義刻意跟 resolveEffQty 對齊：途程裡有任何一道工序的
 * qty_mode 是「盤數」，而且那一站不是包裝站或轉運站（那兩站一律用個數／固定 1，
 * 不看 qty_mode——見 lib/sara/estTime.ts）。
 *
 * 注意這裡不是用「品號看起來像不像壓克力」來判定。理由是：
 *   ① 有壓克力品號掛在「委外/11天回」這種只有轉運＋包裝的途程上，那種列不需要盤數，
 *      用品號判會誤報。
 *   ② 反過來也有非壓克力品號（密迪板、木製相框）掛在壓克力途程上，那些列真的會被擋，
 *      用品號判會漏報。
 * 以途程設定為準，標出來的異常才等於實際會被擋下的列。
 */
export async function loadPlateRuleMeta(sb: SupabaseClient): Promise<PlateRuleMeta> {
  const [{ data: irData }, { data: roData }, { data: otData }] = await Promise.all([
    sb.from('item_routes').select('item_code, route_id'),
    sb.from('route_operations').select('route_id, op_name, qty_mode'),
    sb.from('operation_times').select('op_name, station'),
  ])
  const stationOf = new Map<string, string>(
    ((otData ?? []) as Array<{ op_name: string; station: string | null }>)
      .map(r => [r.op_name, String(r.station ?? '')])
  )
  const panOpsByRoute = new Map<string, string[]>()
  for (const r of ((roData ?? []) as Array<{ route_id: string; op_name: string; qty_mode: string | null }>)) {
    if (normalizeQtyMode(r.qty_mode) !== '盤數') continue
    const station = stationOf.get(r.op_name) ?? ''
    if (isPackagingStation(station) || isTransitStation(station)) continue
    const arr = panOpsByRoute.get(r.route_id) ?? []
    if (!arr.includes(r.op_name)) arr.push(r.op_name)
    panOpsByRoute.set(r.route_id, arr)
  }
  const irMap = new Map<string, string>(
    ((irData ?? []) as Array<{ item_code: string; route_id: string }>)
      .map(r => [String(r.item_code ?? '').trim(), r.route_id])
  )
  return { irMap, panOpsByRoute, stationOf }
}

export interface PlateIssue {
  /** 這一列實際走的途程 */
  routeId: string
  /** 哪幾道工序要盤數（含站點），用來在畫面上講清楚為什麼 */
  ops: string[]
}

/**
 * 判定這一列是不是「該填盤數卻沒填」。回傳 null 代表沒問題。
 *
 * 數量為 0 或空白的列不判：那是「改單/示意圖」之類的註記列，本來就不會產生工序。
 */
export function plateCountIssue(
  row: RouteRowInput & { plate_count?: unknown; quantity?: unknown },
  meta: PlateRuleMeta,
): PlateIssue | null {
  const qty = Number(String(row.quantity ?? '').replace(/,/g, ''))
  if (!Number.isFinite(qty) || qty <= 0) return null
  const plate = Number(String(row.plate_count ?? '').replace(/,/g, ''))
  if (Number.isFinite(plate) && plate > 0) return null

  const { routeId } = resolveRoute(row, meta.irMap)
  if (!routeId) return null
  const ops = meta.panOpsByRoute.get(routeId)
  if (!ops || ops.length === 0) return null
  return {
    routeId,
    ops: ops.map(op => {
      const st = meta.stationOf.get(op) ?? ''
      return st ? `${op}（${st}）` : op
    }),
  }
}
