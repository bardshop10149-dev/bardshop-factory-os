import { getSupabaseAdminClient } from './supabaseAdmin'
import { argoQuery } from './argoQuery'

// 各機台每日產出——直接以 ARGO 製令繳庫（PJ_PROJECTDETAIL.ACTUAL_QTY）為準，
// 交叉比對本系統既有的機台分配（argoerp_mo_machine_assign），不依賴 SARA。
//
// 為什麼不用 SARA：SARA 官方報工匯出端點目前找不到可用路徑（皆 404），塔台網頁版
// API 需要另外的登入帳密（未設定），且塔台 lot_detail 的 status/finished 代表的是
// 「排程規劃已確認」而非「實際生產完成」，沒有真正的完工時間欄位。相對地，ARGO
// 繳庫（ACTUAL_QTY + UPDATE_DATE）是唯一可靠的「實際做了多少、什麼時候做的」來源，
// 而機台分配我們自己就有在維護（每日出單表的「儲存機台分配」）。
//
// 重要限制：繳庫日期是「東西入庫的時間」，不是「機台實際生產的時間」，兩者可能差
// 好幾天——機台當天有在動工，但東西還沒驗收入庫，繳庫量就會是 0。這種情況會另外
// 統計成 pendingMoCount（有異動但尚未繳庫的製令數），不會讓機台看起來像完全沒動。
//
// 這支函式被兩處呼叫：/api/argoerp/daily-machine-output（即時查詢，供頁面手動指定
// 日期用）與 /api/cron/daily-machine-output（每天 05:00 排程，算「昨天」存成快照）。

// 同一組實體機台合併顯示（例如同一台機器的不同編號/站別）
const MACHINE_GROUPS: Array<{ label: string; members: string[] }> = [
  { label: '7151 (#3/#6/#11)', members: ['7151#3', '7151#6', '7151#11'] },
  { label: '7151 (#7/#8/#9/#10)', members: ['7151#7', '7151#8', '7151#9', '7151#10'] },
]
const machineToGroupLabel = new Map<string, string>()
for (const g of MACHINE_GROUPS) {
  for (const member of g.members) machineToGroupLabel.set(member, g.label)
}
function resolveDisplayName(machine: string): string {
  return machineToGroupLabel.get(machine) ?? machine
}

export interface ProductQty {
  code: string
  qty: number
  name: string | null
}

export interface MachineOutputRow {
  machine: string
  actualQty: number
  rejectQty: number
  moCount: number
  pendingMoCount: number
  moNumbers: string[]
  products: ProductQty[]
}

export interface DailyMachineOutputResult {
  date: string
  rows: MachineOutputRow[]
  packingList: ProductQty[]
  totalMoCount: number
  unassignedMoCount: number
  unassignedMoNumbers: string[]
}

/** 台北時區「昨天」的日曆日字串（YYYY-MM-DD），供 05:00 排程算快照用 */
export function taipeiYesterdayStr(): string {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(yesterday)
  const y = parts.find(p => p.type === 'year')!.value
  const m = parts.find(p => p.type === 'month')!.value
  const d = parts.find(p => p.type === 'day')!.value
  return `${y}-${m}-${d}`
}

export async function computeDailyMachineOutput(date: string): Promise<DailyMachineOutputResult> {
  // 算「date 的隔天」純日曆字串——不能用 setDate()/getDate()（依伺服器執行環境的
  // 本地時區解讀，會出錯）、也不能先轉成帶 +08:00 offset 的 UTC 實際時刻再切字串
  // （TO_DATE('YYYY-MM-DD') 是給 ARGO 當純日曆日期用，不是 UTC 時刻，兩者概念不同，
  // 混用會直接對錯一天）。用 Date.UTC 純算日曆數字，跟任何時區都無關。
  const [y, m, d] = date.split('-').map(Number)
  const nextDateStr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)

  // 只抓製令（MO 開頭），常平/委外的採購/請購單不牽涉「機台」，排除掉
  const rows = await argoQuery('PJ_PROJECTDETAIL', {
    UPDATE_DATE: `BETWEEN TO_DATE('${date}','YYYY-MM-DD') AND TO_DATE('${nextDateStr}','YYYY-MM-DD') - INTERVAL '1' SECOND`,
    PJT_PROJECT_ID: "LIKE 'MO%'",
  })

  const moNumbers = [...new Set(rows.map(r => String(r.PJT_PROJECT_ID ?? '').trim()).filter(Boolean))]

  const sb = getSupabaseAdminClient()

  let assignMap = new Map<string, string>()
  if (moNumbers.length > 0) {
    const { data: assigns, error } = await sb
      .from('argoerp_mo_machine_assign')
      .select('mo_number, machine')
      .in('mo_number', moNumbers)
    if (error) throw error
    assignMap = new Map((assigns ?? []).filter(a => a.machine).map(a => [a.mo_number, a.machine as string]))
  }

  const byGroup = new Map<string, MachineOutputRow>()
  const productQtyByGroup = new Map<string, Map<string, number>>()
  const unassignedMoNumbers = new Set<string>()
  for (const r of rows) {
    const mo = String(r.PJT_PROJECT_ID ?? '').trim()
    if (!mo) continue
    const machine = assignMap.get(mo)
    if (!machine) { unassignedMoNumbers.add(mo); continue }
    const groupLabel = resolveDisplayName(machine)
    const actualQty = Number(r.ACTUAL_QTY) || 0
    const rejectQty = Number(r.REJECT_QTY) || 0
    const part = String(r.MBP_PART ?? '').trim()
    const row = byGroup.get(groupLabel) ?? { machine: groupLabel, actualQty: 0, rejectQty: 0, moCount: 0, pendingMoCount: 0, moNumbers: [], products: [] }
    row.actualQty += actualQty
    row.rejectQty += rejectQty
    if (!row.moNumbers.includes(mo)) {
      row.moNumbers.push(mo)
      if (actualQty > 0) row.moCount += 1
      else row.pendingMoCount += 1
    }
    byGroup.set(groupLabel, row)

    if (part && actualQty > 0) {
      const productMap = productQtyByGroup.get(groupLabel) ?? new Map<string, number>()
      productMap.set(part, (productMap.get(part) ?? 0) + actualQty)
      productQtyByGroup.set(groupLabel, productMap)
    }
  }

  // 品號中文品名：借用 erp_so_lines 既有同步資料的 description（客製品每張單的細節描述
  // 略有不同，這裡只取任一筆當代表名稱，方便閱讀，不是正式品名主檔）
  const allPartCodes = [...new Set(rows.map(r => String(r.MBP_PART ?? '').trim()).filter(Boolean))]
  const nameMap = new Map<string, string>()
  if (allPartCodes.length > 0) {
    const { data: soLines } = await sb
      .from('erp_so_lines')
      .select('mbp_part, description')
      .in('mbp_part', allPartCodes)
    for (const l of soLines ?? []) {
      if (l.mbp_part && l.description && !nameMap.has(l.mbp_part)) nameMap.set(l.mbp_part, l.description)
    }
  }

  for (const [groupLabel, row] of byGroup) {
    const productMap = productQtyByGroup.get(groupLabel) ?? new Map<string, number>()
    row.products = [...productMap.entries()]
      .map(([code, qty]) => ({ code, qty, name: nameMap.get(code) ?? null }))
      .sort((a, b) => b.qty - a.qty)
  }

  const outputRows = [...byGroup.values()].sort((a, b) => b.actualQty - a.actualQty)

  // 包裝部清單：包裝是繳庫前的最後一道工序，當天所有有繳庫的製令（不分機台，
  // 含沒有機台分配紀錄的那些）品號+數量加總，就等於包裝部當天處理的量。
  const packingProductQty = new Map<string, number>()
  for (const r of rows) {
    const part = String(r.MBP_PART ?? '').trim()
    if (!part) continue
    const actualQty = Number(r.ACTUAL_QTY) || 0
    if (actualQty <= 0) continue
    packingProductQty.set(part, (packingProductQty.get(part) ?? 0) + actualQty)
  }
  const packingList = [...packingProductQty.entries()]
    .map(([code, qty]) => ({ code, qty, name: nameMap.get(code) ?? null }))
    .sort((a, b) => b.qty - a.qty)

  return {
    date,
    rows: outputRows,
    packingList,
    totalMoCount: moNumbers.length,
    unassignedMoCount: unassignedMoNumbers.size,
    unassignedMoNumbers: [...unassignedMoNumbers],
  }
}
