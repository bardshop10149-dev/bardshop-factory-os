import { getSupabaseAdminClient } from './supabaseAdmin'

// ─────────────────────────────────────────────────────────────────────────────
// ARGO → Supabase 增量比對引擎
//
// 取代各同步 action「先 delete 整表、再 insert 全部」的整批覆蓋寫法。
// 改為：把這次從 ARGO 拉回的列，逐列跟 Supabase 現有列做「內容比對」，
//   - 新鍵         → insert
//   - 同鍵但內容不同 → upsert（更新）
//   - 同鍵且內容相同 → 略過（不寫，synced_at 不變動）
//   - 現有鍵不在這次拉回結果 → delete（消失列）
// 並把每筆變動寫進 erp_change_log、整次摘要寫進 erp_sync_logs。
//
// 重要前提（與整批覆蓋等價、不改變按鈕行為）：
//   * 呼叫端傳進來的 rows 必須是「這次該表完整的 ARGO 結果」（全量拉，不是增量查詢）。
//     如此「現有鍵不在 rows」才能正確代表「已刪除」，最終表內容與整批覆蓋逐列相同。
//   * ABORT-ON-EMPTY：rows 為空時完全不刪除，避免 ARGO 短暫失敗把活資料洗光。
//   * upsert 需要 onConflict 對應的 unique index 存在（呼叫端負責確認/建立）。
//   * log 寫入全程 try/catch，永不阻斷主同步流程（沿用 saraSync 慣例）；
//     log 表尚未建立時，同步照常運作、只是沒有 log。
// ─────────────────────────────────────────────────────────────────────────────

type AdminClient = ReturnType<typeof getSupabaseAdminClient>
type Row = Record<string, unknown>

export interface ReconcileOptions {
  /** 目標 Supabase 表名 */
  table: string
  /** 自然鍵欄位（組成唯一鍵，用於比對與刪除） */
  keyCols: string[]
  /** upsert 的 onConflict 字串（預設 = keyCols.join(',')） */
  onConflict?: string
  /** 參與「內容比對」的欄位（不含 id / synced_at 等易變欄；jsonb 欄會做 canonical 排序） */
  compareCols: string[]
  /** 本次從 ARGO 拉回、已正規化的完整新列（含 synced_at） */
  rows: Row[]
  /** 共用表的範圍限制（如 erp_pj_sync 依 doc_type），用於讀既有列與刪除 */
  scope?: { col: string; value: string }
  /** log 用的 action 名稱（如 sync_customer） */
  action: string
  /** change_log 的 doc_no 來源欄位（預設 keyCols[0]） */
  docNoCol?: string
  /** change_log 的 sub_no 來源欄位（可選，如 line_no / sub_no） */
  subNoCol?: string
}

export interface ReconcileResult {
  total: number
  inserted: number
  updated: number
  deleted: number
  unchanged: number
  duplicates: number
}

const UPSERT_BATCH = 500
const DELETE_BATCH = 200
const READ_PAGE = 1000
const CHANGE_LOG_CAP = 2000 // 單次最多記這麼多筆明細，避免首輪大量變動灌爆 change_log

// canonical：物件鍵排序，讓 jsonb 欄位重排不會被誤判為變動
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    const o = v as Row
    const out: Row = {}
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k])
    return out
  }
  return v
}

function normValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return canonical(v)
  return v
}

function fingerprint(row: Row, cols: string[]): string {
  return JSON.stringify(cols.map((c) => normValue(row[c])))
}

function keyOf(row: Row, cols: string[]): string {
  return cols.map((c) => String(row[c] ?? '')).join('')
}

function pick(row: Row, cols: string[]): Row {
  const out: Row = {}
  for (const c of cols) out[c] = row[c]
  return out
}

export async function reconcileTable(
  supabase: AdminClient,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const start = Date.now()
  const { table, keyCols, compareCols, rows, scope, action } = opts
  const onConflict = opts.onConflict ?? keyCols.join(',')
  const docNoCol = opts.docNoCol ?? keyCols[0]
  const subNoCol = opts.subNoCol

  // 1) 去重新列（同鍵保留第一筆，與既有 first-write-wins 行為一致）
  const newMap = new Map<string, Row>()
  let duplicates = 0
  for (const r of rows) {
    const k = keyOf(r, keyCols)
    if (newMap.has(k)) { duplicates++; continue }
    newMap.set(k, r)
  }

  // 2) 讀既有列（只取 key + compare 欄），分頁
  const selectCols = Array.from(new Set([...keyCols, ...compareCols])).join(',')
  const existingMap = new Map<string, Row>()
  for (let from = 0; ; from += READ_PAGE) {
    let q = supabase.from(table).select(selectCols).range(from, from + READ_PAGE - 1)
    if (scope) q = q.eq(scope.col, scope.value)
    const { data, error } = await q
    if (error) throw error
    const batch = (data ?? []) as unknown as Row[]
    for (const r of batch) existingMap.set(keyOf(r, keyCols), r)
    if (batch.length < READ_PAGE) break
  }

  // 3) diff
  const toUpsert: Row[] = []
  const inserts: Row[] = []
  const updates: Array<{ before: Row; after: Row; changed: string[] }> = []
  let unchanged = 0
  for (const [k, r] of newMap) {
    const ex = existingMap.get(k)
    if (!ex) {
      inserts.push(r)
      toUpsert.push(r)
    } else if (fingerprint(ex, compareCols) !== fingerprint(r, compareCols)) {
      const changed = compareCols.filter((c) => fingerprint(ex, [c]) !== fingerprint(r, [c]))
      updates.push({ before: ex, after: r, changed })
      toUpsert.push(r)
    } else {
      unchanged++
    }
  }
  const toDelete: Row[] = []
  for (const [k, ex] of existingMap) {
    if (!newMap.has(k)) toDelete.push(ex)
  }

  // 4) upsert 變動列（新增 + 更新）
  for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH) {
    const { error } = await supabase
      .from(table)
      .upsert(toUpsert.slice(i, i + UPSERT_BATCH), { onConflict })
    if (error) throw error
  }

  // 5) 刪除消失列（ABORT-ON-EMPTY：rows 為空時不刪，避免洗光活資料）
  let deleted = 0
  if (rows.length > 0 && toDelete.length > 0) {
    deleted = await deleteRows(supabase, table, keyCols, toDelete, scope)
  }

  const result: ReconcileResult = {
    total: rows.length,
    inserted: inserts.length,
    updated: updates.length,
    deleted,
    unchanged,
    duplicates,
  }

  // 6) Log（永不阻斷主流程）
  await writeLogs(supabase, {
    action, table, docNoCol, subNoCol,
    elapsedMs: Date.now() - start,
    result, inserts, updates, toDelete,
  }).catch(() => { /* logging 失敗不影響同步 */ })

  return result
}

// 刪除：單一鍵用 .in() 批次；複合鍵逐列 .match()（刪除屬少數，正確優先）
async function deleteRows(
  supabase: AdminClient,
  table: string,
  keyCols: string[],
  rowsToDelete: Row[],
  scope?: { col: string; value: string },
): Promise<number> {
  let deleted = 0
  if (keyCols.length === 1) {
    const col = keyCols[0]
    const values = rowsToDelete.map((r) => r[col])
    for (let i = 0; i < values.length; i += DELETE_BATCH) {
      let q = supabase.from(table).delete().in(col, values.slice(i, i + DELETE_BATCH) as unknown[])
      if (scope) q = q.eq(scope.col, scope.value)
      const { error } = await q
      if (error) throw error
      deleted += Math.min(DELETE_BATCH, values.length - i)
    }
    return deleted
  }
  // 複合鍵
  for (const r of rowsToDelete) {
    const match = pick(r, keyCols)
    if (scope) match[scope.col] = scope.value
    const { error } = await supabase.from(table).delete().match(match)
    if (error) throw error
    deleted += 1
  }
  return deleted
}

interface LogContext {
  action: string
  table: string
  docNoCol: string
  subNoCol?: string
  elapsedMs: number
  result: ReconcileResult
  inserts: Row[]
  updates: Array<{ before: Row; after: Row; changed: string[] }>
  toDelete: Row[]
}

async function writeLogs(supabase: AdminClient, ctx: LogContext): Promise<void> {
  const { action, table, docNoCol, subNoCol, elapsedMs, result } = ctx

  const { data: runRow, error: runErr } = await supabase
    .from('erp_sync_logs')
    .insert({
      action,
      mode: 'incremental',
      ok: true,
      count: result.total,
      inserted: result.inserted,
      updated: result.updated,
      deleted: result.deleted,
      unchanged: result.unchanged,
      elapsed_ms: elapsedMs,
      message: result.duplicates > 0 ? `dup=${result.duplicates}` : null,
      payload: { duplicates: result.duplicates },
    })
    .select('id')
    .single()
  if (runErr) throw runErr
  const runId = (runRow as { id?: number } | null)?.id ?? null

  const docNo = (r: Row) => String(r[docNoCol] ?? '')
  const subNo = (r: Row) => (subNoCol ? String(r[subNoCol] ?? '') : null)

  const detail: Row[] = []
  for (const r of ctx.inserts) {
    detail.push({ run_id: runId, action, target_table: table, doc_no: docNo(r), sub_no: subNo(r), change_type: 'insert', detected_via: 'content', changed_fields: null, before: null, after: r })
  }
  for (const u of ctx.updates) {
    detail.push({ run_id: runId, action, target_table: table, doc_no: docNo(u.after), sub_no: subNo(u.after), change_type: 'update', detected_via: 'content', changed_fields: u.changed.length ? u.changed : null, before: u.before, after: u.after })
  }
  for (const r of ctx.toDelete) {
    detail.push({ run_id: runId, action, target_table: table, doc_no: docNo(r), sub_no: subNo(r), change_type: 'delete', detected_via: 'content', changed_fields: null, before: r, after: null })
  }

  const capped = detail.slice(0, CHANGE_LOG_CAP)
  for (let i = 0; i < capped.length; i += UPSERT_BATCH) {
    const { error } = await supabase.from('erp_change_log').insert(capped.slice(i, i + UPSERT_BATCH))
    if (error) throw error
  }
}
