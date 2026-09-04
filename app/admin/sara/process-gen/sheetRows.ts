// SARA 工序產生器共用：出單表 → 輸入列（InputRow）的載入與工時計算規則
//
// 原本內嵌在 page.tsx 的 handleLoadFromSheet 裡；待處理清單的「貼上製程」面板也需要
// 從指定日期的出單表把同一筆列（含製令/採購/請購單號、交期、盤數、機台）帶出來，
// 抽成共用函式避免第三份複製的解析邏輯漂移。

import { supabase } from '../../../../lib/supabaseClient'

export interface InputRow {
  order_number: string
  item_code: string
  item_spec: string
  quantity: number
  due: string
  pan_count: number
  mo_number?: string            // 製令單號（MOT...）/ 採購單號（POC...）/ 請購單號（POO...）
  line_seq?: string             // 銷售訂單序號（match_line_no）；C/O 廠 fallback 為採購單行號
  customer?: string             // 客戶名稱
  factory?: 'T' | 'C' | 'O'   // 廠區：T=台北 C=常平 O=委外（僅預覽，不匯出）
  assigned_machine?: string    // 分配機台（台北廠印刷站2F/6F 才填入）
}

export const isPackagingStation  = (s: string) => s.includes('包裝站')
export const isTransitStation    = (s: string) => s.includes('轉運')
// 只有這兩個站點需要填入分配機台（台北廠才有）
export const isPrintStation2F6F  = (s: string) => s === '印刷站2F' || s === '印刷站6F'

// 工時計算：轉運站固定qty=1；計算結果不足10分鐘時補至10分鐘（std_time有值時）
export function calcEst(std: number, qty: number, panCount: number, station: string): number {
  if (std === 0) return 0
  const isPacking = isPackagingStation(station)
  const isTransit = isTransitStation(station)
  const effQty    = isTransit ? 1 : (panCount > 0 && !isPacking) ? panCount : qty
  return Math.max(10, Math.round(std * effQty * 10) / 10)
}

export function fmtToday(): string {
  const d = new Date()
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 讀取指定日期的出單表並解析成 InputRow 清單（含台北廠機台、C/O 廠序號補查）。
 * 找不到出單表或無有效列時回傳空陣列，由呼叫端決定訊息。
 */
export async function loadSheetInputRows(sheetDate: string): Promise<InputRow[]> {
  const res = await fetch(`/api/argoerp/daily-order-sheet?date=${sheetDate}`, { cache: 'no-store' })
  const json = await res.json() as { success: boolean; sheet?: { rows?: Record<string, unknown>[] } }
  if (!json.success || !json.sheet?.rows?.length) return []

  const parsed: InputRow[] = []
  for (const r of json.sheet.rows) {
    const order = String(r.order_number ?? '').trim()
    const item  = String(r.item_code   ?? '').trim()
    if (!order || !item) continue
    const qty  = parseFloat(String(r.quantity   ?? '').replace(/,/g, '')) || 0
    if (qty <= 0) continue
    const pan  = parseFloat(String(r.plate_count ?? '').replace(/,/g, '')) || 0
    const factory = (['T', 'C', 'O'].includes(String(r.factory ?? ''))) ? String(r.factory) as 'T'|'C'|'O' : undefined
    // 依廠區選擇對應單號：台北=製令號MOT / 常平=採購單號POC / 委外=請購單號MPO
    // 常平/委外常見同一張採購/請購單裡集合多筆銷售單序號（同品項編碼也可能重複開在
    // 同一張單上），製令號本身天生就帶行號（如 MOT26082700201/202）能唯一識別到行，
    // 但採購/請購單號是整張單共用、不分行——若原樣送給 SARA，Manufacturing Order
    // Number 加 Product Name 會完全相同，SARA 那邊只會留下最後處理的一筆、其餘消失。
    // 因此常平/委外一律加上「-行號」（po_sub_no/pr_sub_no，ARGO 採購/請購單上的實際
    // 行號）組成唯一識別，格式跟製令號本身帶行號的精神一致。
    const poSubNo = String(r.po_sub_no ?? '').trim()
    const prSubNo = String(r.pr_sub_no ?? '').trim()
    const poNumber = String(r.po_number ?? '').trim()
    const prNumber = String(r.pr_number ?? '').trim()
    const refNumber =
      factory === 'C' ? (poNumber ? `${poNumber}${poSubNo ? `-${poSubNo}` : ''}` : undefined) :
      factory === 'O' ? (prNumber ? `${prNumber}${prSubNo ? `-${prSubNo}` : ''}` : undefined) :
                        String(r.mo_number ?? '').trim() || undefined
    parsed.push({
      order_number: order,
      item_code:    item,
      item_spec:    String(r.item_name ?? r.note ?? '').trim(),
      quantity:     qty,
      due:          String(r.delivery_date ?? '').trim(),
      pan_count:    pan,
      mo_number:    refNumber,
      // 銷售訂單序號（match_line_no = SO 項次，所有廠別通用）
      line_seq:     String(r.match_line_no ?? '').trim() || undefined,
      customer:     String(r.customer  ?? '').trim() || undefined,
      factory,
      // 分配機台：優先取 mo-machine-assign 結果（machine），其次為原始欄位（assigned_machine）
      assigned_machine: String(r.machine ?? r.assigned_machine ?? '').trim() || undefined,
    })
  }
  if (!parsed.length) return []

  // ── 從 argoerp_mo_machine_assign 補充台北廠製令機台（優先於 row.machine）────
  // row.machine 只有在每日出單表點「儲存機台分配」後才會寫入 JSON；
  // argoerp_mo_machine_assign 表才是最新且最準確的機台來源。
  const tMoNums = [...new Set(
    parsed.filter(r => r.factory === 'T' && r.mo_number).map(r => r.mo_number!)
  )]
  if (tMoNums.length > 0) {
    const { data: machineRows } = await supabase
      .from('argoerp_mo_machine_assign')
      .select('mo_number, machine')
      .in('mo_number', tMoNums)
    if (machineRows?.length) {
      const moMachineMap = new Map<string, string>(
        (machineRows as { mo_number: string; machine: string }[])
          .filter(m => m.machine)
          .map(m => [m.mo_number, m.machine])
      )
      for (const r of parsed) {
        if (r.factory === 'T' && r.mo_number) {
          const fromTable = moMachineMap.get(r.mo_number)
          if (fromTable) r.assigned_machine = fromTable
        }
      }
    }
  }

  // ── 從 erp_pj_sync 查詢 C/O 廠列的請購/採購單序號（lot_number 用）────
  // r.mo_number 現在是「單號-行號」的組合（見上方 refNumber），這裡查 erp_pj_sync
  // 要用不含行號的裸單號；行號本身只有一個 doc+item 對到多筆時才會不準，用
  // doc_no+item_code+sub_no 三者一起比對才能正確對回同一筆採購行，而不是隨便取第一筆。
  const bareDocNo = (mo: string) => mo.replace(/-\d+$/, '')
  const coRows = parsed.filter(r => (r.factory === 'C' || r.factory === 'O') && r.mo_number)
  if (coRows.length > 0) {
    const docNos = [...new Set(coRows.map(r => bareDocNo(r.mo_number!)))]
    const { data: syncRows } = await supabase
      .from('erp_pj_sync')
      .select('doc_no, sub_no, item_code')
      .in('doc_no', docNos)
      .in('doc_type', ['採購單號', '請購單號'])
    if (syncRows?.length) {
      // key = doc_no|item_code|sub_no（sub_no 本身就取自 mo_number 的行號，三者一起比對
      // 才能正確對回同一筆採購行，避免同一張單同一品項多行時互相覆蓋）
      const syncSet = new Set(syncRows.map(sr => `${sr.doc_no}|${sr.item_code ?? ''}|${sr.sub_no ?? ''}`))
      for (const r of parsed) {
        if ((r.factory === 'C' || r.factory === 'O') && r.mo_number && !r.line_seq) {
          // 僅在 match_line_no 未能提供序號時，才以採購單行號作為 fallback
          const doc = bareDocNo(r.mo_number)
          const subNo = r.mo_number.slice(doc.length + 1) // 去掉 "doc-" 前綴後剩下的行號
          if (subNo && syncSet.has(`${doc}|${r.item_code}|${subNo}`)) r.line_seq = subNo
        }
      }
    }
  }

  return parsed
}
