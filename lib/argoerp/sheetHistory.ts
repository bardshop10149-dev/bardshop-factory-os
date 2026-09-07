// 每日出單表修改歷程（審計紀錄）
//
// daily_order_sheets 只有一個 updated_by，每次寫入都被覆蓋；2026-09-02 SO260828004 被重新
// 貼上出單表改成常平、台北端已先開製令，事後追不到是誰改的（中間又被自動轉單排程蓋掉一次，
// Supabase 免費方案 log 只留 1 天）。所有寫入出單表的路徑（人工儲存/重貼、局部修改、改單
// 專區、排程回寫）都呼叫 recordSheetHistory，比對寫入前後的列，把「誰、何時、哪種操作、
// 新增/刪除幾列、哪幾列的廠區/數量/交期/單據類型從什麼改成什麼」寫進
// daily_order_sheet_history。寫入失敗只記 console，不影響主流程。

import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>

export interface SheetHistoryActor {
  email?: string | null
  name?: string | null
}

export interface RowRef {
  order_number: string
  line: string
  item_code: string
  factory?: string
}

export interface FieldChange extends RowRef {
  field: 'factory' | 'quantity' | 'delivery_date' | 'doc_type' | 'item_code'
  from: string
  to: string
}

export interface SheetHistoryChanges {
  added: RowRef[]
  removed: RowRef[]
  field_changes: FieldChange[]
}

const TRACKED_FIELDS: FieldChange['field'][] = ['factory', 'quantity', 'delivery_date', 'doc_type']

const s = (v: unknown) => (v == null ? '' : String(v).trim())

function lineOf(r: Row): string {
  return s(r.line_no_input) || s(r.match_line_no)
}

function refOf(r: Row): RowRef {
  return { order_number: s(r.order_number), line: lineOf(r), item_code: s(r.item_code), factory: s(r.factory) || undefined }
}

// 列身分：訂單號 + 序號 + 品號。重貼整張表時 row_key 會因廠區/內容變動而改變，
// 不能拿 row_key 當身分，否則「改廠區」會被看成「刪一列 + 新增一列」。
// 同一訂單同序號同品號若出現多列（少見），再以數量區分。
function identityKeys(rows: Row[]): Map<string, Row> {
  const base = new Map<string, Row[]>()
  for (const r of rows) {
    const ref = refOf(r)
    if (!ref.order_number) continue
    const k = `${ref.order_number}||${ref.line}||${ref.item_code}`
    const arr = base.get(k) ?? []
    arr.push(r)
    base.set(k, arr)
  }
  const out = new Map<string, Row>()
  for (const [k, arr] of base) {
    if (arr.length === 1) { out.set(k, arr[0]); continue }
    for (const r of arr) out.set(`${k}||q=${s(r.quantity)}`, r)
  }
  return out
}

/** 純函式：比對寫入前後的列，算出新增/刪除/欄位變更 */
export function diffSheetRows(before: Row[], after: Row[]): SheetHistoryChanges {
  const b = identityKeys(before)
  const a = identityKeys(after)
  const added: RowRef[] = []
  const removed: RowRef[] = []
  const field_changes: FieldChange[] = []
  for (const [k, row] of a) {
    const prev = b.get(k)
    if (!prev) { added.push(refOf(row)); continue }
    for (const f of TRACKED_FIELDS) {
      const from = s(prev[f])
      const to = s(row[f])
      if (from !== to) field_changes.push({ ...refOf(row), field: f, from, to })
    }
  }
  for (const [k, row] of b) {
    if (!a.has(k)) removed.push(refOf(row))
  }
  return { added, removed, field_changes }
}

export interface RecordSheetHistoryInput {
  sheet_date: string
  action: string
  actor: SheetHistoryActor
  before: Row[]
  after: Row[]
  raw_text_changed?: boolean
  note?: string
  /** 只有在有列被新增/刪除/欄位變更時才寫（排程回寫這類高頻、通常無實質變動的路徑用） */
  onlyIfChanged?: boolean
}

/** 寫一筆修改歷程；失敗不丟錯，避免拖垮主流程 */
export async function recordSheetHistory(sb: SupabaseClient, input: RecordSheetHistoryInput): Promise<void> {
  try {
    const changes = diffSheetRows(input.before, input.after)
    const hasChange = changes.added.length > 0 || changes.removed.length > 0 || changes.field_changes.length > 0
    if (input.onlyIfChanged && !hasChange && !input.raw_text_changed) return
    const { error } = await sb.from('daily_order_sheet_history').insert({
      sheet_date: input.sheet_date,
      action: input.action,
      changed_by: input.actor.email ?? null,
      changed_by_name: input.actor.name ?? input.actor.email ?? null,
      row_count_before: input.before.length,
      row_count_after: input.after.length,
      added_count: changes.added.length,
      removed_count: changes.removed.length,
      factory_change_count: changes.field_changes.filter(c => c.field === 'factory').length,
      raw_text_changed: !!input.raw_text_changed,
      changes,
      note: input.note ?? null,
    })
    if (error) console.error('[sheetHistory] 寫入失敗：', error.message)
  } catch (e) {
    console.error('[sheetHistory] 寫入失敗：', e)
  }
}
