// 交換區 CSV buffer 的共用定義。
//
// 2026-09-15 起有兩支對外端口共用同一份 buffer：
//   /api/sara/exchange-csv    塔台（SARA）專用，可帶 mark_consumed=true 拉完清空
//   /api/sara/exchange-csv-2  第二家取用方，資料相同但唯讀，永遠不會清空 buffer
//
// 欄位定義、buffer 讀取、回傳物件格式一律走這裡，避免兩支端點各自複製一份造成漂移
// （同 lib/argoerp/moExportShared.ts 收拾複製貼上的前例）。

import type { SupabaseClient } from '@supabase/supabase-js'

export const BUFFER_KEY = 'sara_csv_buffer'

// 各取用方的「最後一次成功拉取時間」分開存，彼此不覆蓋——
// 17:45 的 sara-buffer-check 是用塔台那一格判斷「塔台是否還活著」，
// 若共用一格，第二家來拉就會把塔台斷線的警示蓋掉。
export const LAST_PULLED_KEY = 'sara_csv_last_pulled_at'
export const LAST_PULLED_KEY_2 = 'sara_csv_last_pulled_at_2'

export const CSV_H1 = 'Order Number,Manufacturing Order Number,Product Name,Product Description,Lot Number,Production Quantity,Due,Priority Level,Earliest Start Time,Job Sequence,Workcenter,Job Name,Job Quantity,Out Sourcing,Est. Time,Time Unit,BOM Components,Material Required Quantity,customer_id,assigned_machine,Rule,Parameter 1'
export const CSV_H2 = '訂單編號,(必填)工單編號,(必填)品號,規格,生產批號,(必填)生產需求數量,(必填)需求日,排程優先等級(1-99),最早可開始時間,(必填)工序,(必填)站點,(必填)製程名稱,製程數量,製程委外,(必填)預估工時,工時單位,BOM元件品號,物料需求數量,客戶名稱,分配機台,規則,參數1'

const CSV_COLUMNS = CSV_H1.split(',')

/** 讀出目前 buffer 的原始列（每列是一個字串陣列，欄序同 CSV_H1） */
export async function readBufferRows(supabase: SupabaseClient): Promise<string[][]> {
  const { data } = await supabase.from('app_settings').select('value').eq('key', BUFFER_KEY).maybeSingle()
  return Array.isArray(data?.value) ? (data!.value as string[][]) : []
}

/** 原始列 → 以英文欄名為 key 的物件（對外 JSON 回傳格式） */
export function rowsToObjects(rows: string[][]): Record<string, string>[] {
  return rows.map(row => {
    const obj: Record<string, string> = {}
    CSV_COLUMNS.forEach((h, i) => { obj[h] = row[i] ?? '' })
    return obj
  })
}

/** 記錄某一家取用方的最後拉取時間（跟 buffer 本身的 updated_at 分開存） */
export async function recordPull(
  supabase: SupabaseClient,
  key: typeof LAST_PULLED_KEY | typeof LAST_PULLED_KEY_2,
  fetchedAt: string,
): Promise<void> {
  await supabase.from('app_settings').upsert(
    { key, value: fetchedAt, updated_at: fetchedAt },
    { onConflict: 'key' }
  )
}

/**
 * 驗證對外 API Key。`allowed` 依序比對，任一相符即通過；
 * 未設定（空字串／undefined）的 key 一律不算數，避免沒設環境變數等於不設防。
 */
export function checkApiKeyAgainst(
  authHeader: string | null,
  queryKey: string | null,
  allowed: Array<string | undefined>,
): boolean {
  // 環境變數值在各家後台貼上時常帶到前後空白或換行，這裡一律 trim 後比對，
  // 避免「看起來一模一樣的 Key 卻被拒絕」這種很難查的狀況。
  const keys = allowed.map(k => (k ?? '').trim()).filter(k => k.length > 0)
  if (keys.length === 0) return false
  const auth = authHeader ?? ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
  const presented = bearer ?? queryKey
  if (!presented) return false
  return keys.includes(presented)
}
