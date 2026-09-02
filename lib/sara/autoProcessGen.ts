// SARA 工序格式自動產生（伺服器端）
//
// 把 app/admin/sara/process-gen/page.tsx 的「出單表 → SARA 工序列」轉換邏輯搬到伺服器端，
// 供每日排程（/api/cron/sara-process-gen）自動執行：當天出單表已轉單的列自動展開途程工序、
// 寫入塔台拉取的 CSV 交換區（app_settings.sara_csv_buffer），不用再人工進頁面操作。
//
// 無途程品項的自動處理規則（2026-08-31 生管定義）：
//   先把「異常列」移到無途程區（視同沒有途程）——異常＝廠區與途程不符（同頁面的規則 4/5/6）：
//     ・廠區常平（C）但套用途程不是「常平一般壓克力製程」
//     ・廠區台北（T）但品名規格含「仿柯」
//     ・廠區委外（O）但途程非標準委外途程（委外/7天回、9天回、11天回）
//   然後對「無途程＋異常」的列套用三種情境：
//   1. 廠區常平（C）→ 直接套用「常平一般壓克力製程」（同頁面上的「常平」快捷鈕）
//   2. 廠區台北（T）且品名含「仿柯」或「貼合」→ 套用「2mm+1mm壓克力貼合/V90單面印刷」
//      （同頁面上的「仿柯(四川)」快捷鈕）
//   3. 其餘 → 跳過，記入待處理清單（app_settings.sara_process_gen_pending），
//      導覽列顯示未完成數量提醒（同產期詢問未讀的做法），人工至工序產生器頁面補處理
//
// 冪等性：塔台拉取交換區時會帶 mark_consumed=true 清空 buffer，所以「已送出過」不能只看
// buffer 內容——另存一份 sent ledger（app_settings.sara_auto_gen_sent，key=訂單號||工單號，
// 值為送出時間），重跑時跳過已送過的組合，並修剪 30 天前的舊記錄避免無限成長。

import { getSupabaseAdminClient } from '../supabaseAdmin'
import { buildSaraRow, type SaraRow } from './buildSaraRow'
import { DEFAULT_PRIORITY_RULES, PRIORITY_RULES_SETTINGS_KEY, computePriorityFromDue, normalizePriorityRules, taipeiTodayMs } from './priorityRules'

const BUFFER_KEY = 'sara_csv_buffer'
const SENT_LEDGER_KEY = 'sara_auto_gen_sent'
const PENDING_KEY = 'sara_process_gen_pending'

const CP_ROUTE = '常平一般壓克力製程'
const FAKE_KO_ROUTE = '2mm+1mm壓克力貼合/V90單面印刷'
const LEDGER_RETENTION_DAYS = 30

// ── 與 process-gen 頁面一致的計算規則 ──────────────────────────────
const isPackagingStation = (s: string) => s.includes('包裝站')
const isTransitStation = (s: string) => s.includes('轉運')
const isPrintStation2F6F = (s: string) => s === '印刷站2F' || s === '印刷站6F'

function calcEst(std: number, qty: number, panCount: number, station: string): number {
  if (std === 0) return 0
  const isPacking = isPackagingStation(station)
  const isTransit = isTransitStation(station)
  const effQty = isTransit ? 1 : (panCount > 0 && !isPacking) ? panCount : qty
  return Math.max(10, Math.round(std * effQty * 10) / 10)
}

function fmtTodayTaipei(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}

export function taipeiTodayDateStr(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

interface ParsedRow {
  order_number: string
  item_code: string
  item_spec: string
  quantity: number
  due: string
  pan_count: number
  mo_number?: string
  line_seq?: string
  customer?: string
  factory?: 'T' | 'C' | 'O'
  assigned_machine?: string
}

export interface PendingItem {
  sheet_date: string
  order_number: string
  item_code: string
  item_spec: string
  factory: string
  quantity: number
  line_seq: string
  reason: string
  created_at: string
}

export interface AutoGenResult {
  sheetDate: string
  totalRows: number
  generatedLines: number   // 寫入交換區的工序列數
  convertedItems: number   // 成功轉換的出單列數
  autoRoutedChangping: number
  autoRoutedFakeKo: number
  skippedAlreadySent: number
  pending: PendingItem[]
}

async function readSetting<T>(key: string): Promise<T | null> {
  const sb = getSupabaseAdminClient()
  const { data } = await sb.from('app_settings').select('value').eq('key', key).maybeSingle()
  return (data?.value as T | undefined) ?? null
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  const sb = getSupabaseAdminClient()
  const { error } = await sb.from('app_settings').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  )
  if (error) throw new Error(`寫入 app_settings.${key} 失敗：${error.message}`)
}

/** 讀取目前的待處理清單（供 API / 導覽列徽章使用） */
export async function readPendingList(): Promise<PendingItem[]> {
  const v = await readSetting<PendingItem[]>(PENDING_KEY)
  return Array.isArray(v) ? v : []
}

export async function writePendingList(items: PendingItem[]): Promise<void> {
  await writeSetting(PENDING_KEY, items)
}

const parseQtyNum = (s: unknown): number => parseFloat(String(s ?? '').replace(/,/g, '')) || 0

/** 主流程：把指定日期的出單表自動轉成 SARA 工序列並寫入交換區 */
export async function runAutoProcessGen(sheetDate: string): Promise<AutoGenResult> {
  const sb = getSupabaseAdminClient()

  // 1. 讀出單表
  const { data: sheet, error: sheetErr } = await sb
    .from('daily_order_sheets').select('rows').eq('sheet_date', sheetDate).maybeSingle()
  if (sheetErr) throw new Error(`讀取出單表失敗：${sheetErr.message}`)
  const rawRows = Array.isArray(sheet?.rows) ? (sheet!.rows as Record<string, unknown>[]) : []

  const result: AutoGenResult = {
    sheetDate, totalRows: rawRows.length, generatedLines: 0, convertedItems: 0,
    autoRoutedChangping: 0, autoRoutedFakeKo: 0, skippedAlreadySent: 0, pending: [],
  }
  const nowIso = new Date().toISOString()

  // 2. 解析（與 process-gen handleLoadFromSheet 同規則）
  const parsed: ParsedRow[] = []
  const noDocPending: PendingItem[] = []
  for (const r of rawRows) {
    const order = String(r.order_number ?? '').trim()
    const item = String(r.item_code ?? '').trim()
    if (!order || !item) continue
    const qty = parseQtyNum(r.quantity)
    if (qty <= 0) continue
    const factory = (['T', 'C', 'O'].includes(String(r.factory ?? ''))) ? String(r.factory) as 'T' | 'C' | 'O' : undefined
    const poSubNo = String(r.po_sub_no ?? '').trim()
    const prSubNo = String(r.pr_sub_no ?? '').trim()
    const poNumber = String(r.po_number ?? '').trim()
    const prNumber = String(r.pr_number ?? '').trim()
    const refNumber =
      factory === 'C' ? (poNumber ? `${poNumber}${poSubNo ? `-${poSubNo}` : ''}` : undefined) :
      factory === 'O' ? (prNumber ? `${prNumber}${prSubNo ? `-${prSubNo}` : ''}` : undefined) :
                        String(r.mo_number ?? '').trim() || undefined
    const lineSeq = String(r.match_line_no ?? '').trim() || String(r.line_no_input ?? '').trim() || undefined

    if (!refNumber) {
      // 尚未轉單（無製令/採購/請購單號）——自動流程不猜測工單號，記入待處理
      noDocPending.push({
        sheet_date: sheetDate, order_number: order, item_code: item,
        item_spec: String(r.item_name ?? r.note ?? '').trim(),
        factory: factory ?? '-', quantity: qty, line_seq: lineSeq ?? '',
        reason: '尚未轉單（無對應單號）', created_at: nowIso,
      })
      continue
    }

    parsed.push({
      order_number: order, item_code: item,
      item_spec: String(r.item_name ?? r.note ?? '').trim(),
      quantity: qty, due: String(r.delivery_date ?? '').trim(),
      pan_count: parseQtyNum(r.plate_count),
      mo_number: refNumber, line_seq: lineSeq,
      customer: String(r.customer ?? '').trim() || undefined,
      factory,
      assigned_machine: String(r.machine ?? r.assigned_machine ?? '').trim() || undefined,
    })
  }

  // 3. 台北廠製令機台補充（argoerp_mo_machine_assign 優先於 row.machine）
  const tMoNums = [...new Set(parsed.filter(p => p.factory === 'T' && p.mo_number).map(p => p.mo_number!))]
  if (tMoNums.length > 0) {
    const { data: machineRows } = await sb
      .from('argoerp_mo_machine_assign').select('mo_number, machine').in('mo_number', tMoNums)
    const moMachineMap = new Map<string, string>(
      ((machineRows ?? []) as { mo_number: string; machine: string }[])
        .filter(m => m.machine).map(m => [m.mo_number, m.machine])
    )
    for (const p of parsed) {
      if (p.factory === 'T' && p.mo_number) {
        const fromTable = moMachineMap.get(p.mo_number)
        if (fromTable) p.assigned_machine = fromTable
      }
    }
  }

  // 4. 途程資料
  const uniqueItems = [...new Set(parsed.map(p => p.item_code))]
  const { data: irData } = uniqueItems.length
    ? await sb.from('item_routes').select('item_code,route_id').in('item_code', uniqueItems)
    : { data: [] }
  const irMap = new Map<string, string>(
    ((irData ?? []) as { item_code: string; route_id: string }[]).map(r => [r.item_code, r.route_id])
  )

  // 每列實際採用的途程：先做異常判定（廠區與途程不符者視同無途程），
  // 再對無途程/異常列套用三種自動情境
  const O_ROUTES = new Set(['委外/7天回', '委外/9天回', '委外/11天回'])
  const routeForRow = (p: ParsedRow): { routeId: string | null; autoRule: 'cp' | 'ko' | null; anomaly: string | null } => {
    const existing = irMap.get(p.item_code)
    // 異常判定（同 process-gen 頁面的規則 4/5/6）
    const anomaly =
      (p.factory === 'C' && existing && existing !== CP_ROUTE) ? `廠區常平但途程非「${CP_ROUTE}」（原：${existing}）`
      : (p.factory === 'T' && p.item_spec.includes('仿柯')) ? '廠區台北但品名含「仿柯」'
      : (p.factory === 'O' && existing && !O_ROUTES.has(existing)) ? `廠區委外但途程非標準委外途程（原：${existing}）`
      : null
    // 有途程且無異常 → 直接用原途程
    if (existing && !anomaly) return { routeId: existing, autoRule: null, anomaly: null }
    // 無途程或異常 → 套三種情境
    if (p.factory === 'C') return { routeId: CP_ROUTE, autoRule: 'cp', anomaly }
    if (p.factory === 'T' && (p.item_spec.includes('仿柯') || p.item_spec.includes('貼合'))) {
      return { routeId: FAKE_KO_ROUTE, autoRule: 'ko', anomaly }
    }
    return { routeId: null, autoRule: null, anomaly }
  }

  const routesNeeded = [...new Set(parsed.map(p => routeForRow(p).routeId).filter((v): v is string => !!v))]
  const { data: roData } = routesNeeded.length
    ? await sb.from('route_operations').select('route_id,sequence,op_name').in('route_id', routesNeeded).order('sequence')
    : { data: [] }
  const roMap = new Map<string, { sequence: number; op_name: string }[]>()
  for (const r of (roData ?? []) as { route_id: string; sequence: number; op_name: string }[]) {
    const arr = roMap.get(r.route_id) ?? []
    arr.push({ sequence: r.sequence, op_name: r.op_name })
    roMap.set(r.route_id, arr)
  }

  const uniqueOps = [...new Set(((roData ?? []) as { op_name: string }[]).map(r => r.op_name))]
  const { data: otData } = uniqueOps.length
    ? await sb.from('operation_times').select('op_name,station,std_time_min').in('op_name', uniqueOps)
    : { data: [] }
  const otMap = new Map<string, { station: string; std_time_min: number }>(
    ((otData ?? []) as { op_name: string; station: string; std_time_min: number }[])
      .map(r => [r.op_name, { station: r.station ?? '', std_time_min: Number(r.std_time_min ?? 0) }])
  )

  // 5. 已送出 ledger（含修剪過期）＋目前 buffer 既有組合（防止跟人工在頁面 append 的重複）
  const ledgerRaw = await readSetting<Record<string, string>>(SENT_LEDGER_KEY)
  const cutoffMs = Date.now() - LEDGER_RETENTION_DAYS * 86400 * 1000
  const ledger: Record<string, string> = {}
  for (const [k, v] of Object.entries(ledgerRaw ?? {})) {
    if (Date.parse(v) >= cutoffMs) ledger[k] = v
  }
  const existingBuffer = await readSetting<string[][]>(BUFFER_KEY)
  const bufferRows = Array.isArray(existingBuffer) ? existingBuffer : []
  const inBufferKeys = new Set(bufferRows.map(r => `${r[0] ?? ''}||${r[1] ?? ''}`))

  // 6. 逐列產生（Priority Level 依交期規則自動判斷，規則可於工序產生器頁面編輯）
  const priorityRulesRaw = await readSetting<unknown>(PRIORITY_RULES_SETTINGS_KEY)
  const priorityRules = priorityRulesRaw != null ? normalizePriorityRules(priorityRulesRaw) : DEFAULT_PRIORITY_RULES
  const todayMs = taipeiTodayMs()
  const today = fmtTodayTaipei()
  const outRows: string[][] = []
  const pendingNoRoute: PendingItem[] = []

  for (const p of parsed) {
    const sentKey = `${p.order_number}||${p.mo_number}`
    if (ledger[sentKey] || inBufferKeys.has(sentKey)) { result.skippedAlreadySent++; continue }

    const { routeId, autoRule, anomaly } = routeForRow(p)
    if (!routeId) {
      pendingNoRoute.push({
        sheet_date: sheetDate, order_number: p.order_number, item_code: p.item_code,
        item_spec: p.item_spec, factory: p.factory ?? '-', quantity: p.quantity,
        line_seq: p.line_seq ?? '',
        reason: anomaly ?? '無途程（不符合常平/仿柯自動規則）',
        created_at: nowIso,
      })
      continue
    }
    const ops = roMap.get(routeId) ?? []
    if (ops.length === 0) {
      pendingNoRoute.push({
        sheet_date: sheetDate, order_number: p.order_number, item_code: p.item_code,
        item_spec: p.item_spec, factory: p.factory ?? '-', quantity: p.quantity,
        line_seq: p.line_seq ?? '', reason: `途程「${routeId}」無工序資料`, created_at: nowIso,
      })
      continue
    }

    for (const op of ops) {
      const ot = otMap.get(op.op_name)
      const station = ot?.station ?? ''
      const std = ot?.std_time_min ?? 0
      const jobQty = (p.pan_count > 0 && !isPackagingStation(station)) ? p.pan_count : p.quantity
      const saraRow: SaraRow = {
        order_number: p.order_number, mfg_order_number: p.mo_number || p.order_number,
        product_name: p.item_code, product_desc: p.item_spec,
        lot_number: p.line_seq || p.order_number,
        prod_qty: p.quantity, due: p.due,
        priority: computePriorityFromDue(p.due, priorityRules, todayMs), earliest_start: today,
        job_seq: op.sequence, workcenter: station, job_name: op.op_name,
        job_qty: jobQty, outsourcing: '', est_time: calcEst(std, p.quantity, p.pan_count, station),
        time_unit: '分鐘', bom: '', mat_req_qty: '',
        customer: p.customer,
        assigned_machine: (p.factory === 'T' && isPrintStation2F6F(station) && p.assigned_machine)
          ? p.assigned_machine : '',
      }
      outRows.push(buildSaraRow(saraRow))
    }
    ledger[sentKey] = nowIso
    result.convertedItems++
    if (autoRule === 'cp') result.autoRoutedChangping++
    if (autoRule === 'ko') result.autoRoutedFakeKo++
  }
  result.generatedLines = outRows.length

  // 7. 寫入交換區（append）＋ ledger
  if (outRows.length > 0) {
    const existing = await readSetting<string[][]>(BUFFER_KEY)
    const buffer = Array.isArray(existing) ? existing : []
    await writeSetting(BUFFER_KEY, [...buffer, ...outRows])
  }
  await writeSetting(SENT_LEDGER_KEY, ledger)

  // 8. 更新待處理清單：先移除本日期舊的（本輪重算就是最新狀態），再併入本輪新發現的，
  //    其他日期的既有項目保留（可能還沒被處理）
  const prevPending = await readPendingList()
  const kept = prevPending.filter(x => x.sheet_date !== sheetDate)
  const newPending = [...noDocPending, ...pendingNoRoute]
  result.pending = newPending
  await writePendingList([...kept, ...newPending])

  // 9. 同步記錄（沿用 sara_sync_logs，失敗不阻斷）
  try {
    await sb.from('sara_sync_logs').insert({
      action: 'auto_process_gen', ok: true, count: result.generatedLines, elapsed_ms: 0,
      message: `${sheetDate}：轉換 ${result.convertedItems} 列（常平自動 ${result.autoRoutedChangping}、仿柯自動 ${result.autoRoutedFakeKo}）、跳過已送 ${result.skippedAlreadySent}、待處理 ${newPending.length}`,
      payload: { ...result, pending: undefined },
    })
  } catch { /* log 失敗不影響主流程 */ }

  return result
}
