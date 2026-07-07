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
// 並把每筆變動寫進 erp_change_log、整次摘要寫進 erp_sync_logs（成功失敗都記）。
//
// 重要前提（與整批覆蓋等價、不改變按鈕行為）：
//   * 呼叫端傳進來的 rows 必須是「這次該表完整的 ARGO 結果」（全量拉，不是增量查詢）。
//     如此「現有鍵不在 rows」才能正確代表「已刪除」，最終表內容與整批覆蓋逐列相同。
//   * 防呆刪除護欄：
//       - ABORT-ON-EMPTY：rows 為空時完全不刪除，避免 ARGO 短暫失敗把活資料洗光。
//       - 刪除比例門檻：單次要刪的列超過現有列的 maxDeleteRatio（預設 30%）且超過 50 列
//         → 跳過刪除並記 log（防 ARGO 回傳「可解析但不完整」時誤刪一大片）。
//   * upsert 需要 onConflict 對應的 unique index 存在（migration 先行）。
//   * log 寫入全程 try/catch，永不阻斷主流程（沿用 saraSync 慣例）；
//     log 表尚未建立時，同步照常運作、只是沒有 log。
// ─────────────────────────────────────────────────────────────────────────────

type AdminClient = ReturnType<typeof getSupabaseAdminClient>
type Row = Record<string, unknown>

export interface ReconcileOptions {
  /** 目標 Supabase 表名 */
  table: string
  /** 自然鍵欄位（組成唯一鍵，用於比對與刪除）。鍵欄位盡量避免 null（null 以 IS NULL 比對刪除） */
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
  /** 刪除比例門檻（0~1，預設 0.3）：要刪列數 > 現有列數×門檻 且 >50 列時跳過刪除 */
  maxDeleteRatio?: number
}

export interface ReconcileResult {
  total: number
  inserted: number
  updated: number
  deleted: number
  unchanged: number
  duplicates: number
  /** 觸發刪除護欄而被跳過的刪除列數（0=未觸發） */
  deletesSkipped: number
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

// 複合鍵：以控制字元 \u001f 分隔，避免 ('A1','2') 與 ('A','12') 相撞；
// null 以 \u0000 標記，與空字串區分。
function keyOf(row: Row, cols: string[]): string {
  return cols.map((c) => (row[c] == null ? '\u0000' : String(row[c]))).join('\u001f')
}

export async function reconcileTable(
  supabase: AdminClient,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const start = Date.now()
  try {
    return await runReconcile(supabase, opts, start)
  } catch (err) {
    // 失敗也要留一筆 log（ok=false），否則失敗的同步在 erp_sync_logs 完全無痕
    await logFailure(supabase, opts.action, Date.now() - start, err).catch(() => { /* 不阻斷 */ })
    throw err
  }
}

async function runReconcile(
  supabase: AdminClient,
  opts: ReconcileOptions,
  start: number,
): Promise<ReconcileResult> {
  const { table, keyCols, compareCols, rows, scope, action } = opts
  const onConflict = opts.onConflict ?? keyCols.join(',')
  const docNoCol = opts.docNoCol ?? keyCols[0]
  const subNoCol = opts.subNoCol
  const maxDeleteRatio = opts.maxDeleteRatio ?? 0.3

  // 1) 去重新列（同鍵保留第一筆；呼叫端多半已自行去重，這裡是安全網）
  const newMap = new Map<string, Row>()
  let duplicates = 0
  for (const r of rows) {
    const k = keyOf(r, keyCols)
    if (newMap.has(k)) { duplicates++; continue }
    newMap.set(k, r)
  }

  // 2) 讀既有列（只取 key + compare 欄），依鍵欄+id 排序分頁，頁界穩定不漏讀
  const selectCols = Array.from(new Set([...keyCols, ...compareCols])).join(',')
  const existingMap = new Map<string, Row>()
  for (let from = 0; ; from += READ_PAGE) {
    let q = supabase.from(table).select(selectCols).range(from, from + READ_PAGE - 1)
    if (scope) q = q.eq(scope.col, scope.value)
    for (const c of keyCols) q = q.order(c, { ascending: true })
    q = q.order('id', { ascending: true })
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

  // 5) 刪除消失列（兩道護欄：空拉不刪；比例超標不刪）
  let deleted = 0
  let deletesSkipped = 0
  const ratioTripped =
    toDelete.length > 50 &&
    existingMap.size > 0 &&
    toDelete.length / existingMap.size > maxDeleteRatio
  if (rows.length === 0 || ratioTripped) {
    deletesSkipped = toDelete.length
  } else if (toDelete.length > 0) {
    deleted = await deleteRows(supabase, table, keyCols, toDelete, scope)
  }

  const result: ReconcileResult = {
    total: rows.length,
    inserted: inserts.length,
    updated: updates.length,
    deleted,
    unchanged,
    duplicates,
    deletesSkipped,
  }

  // 6) Log（永不阻斷主流程）
  await writeLogs(supabase, {
    action, table, docNoCol, subNoCol,
    elapsedMs: Date.now() - start,
    result, inserts, updates,
    deletedRows: deletesSkipped > 0 ? [] : toDelete,
  }).catch(() => { /* logging 失敗不影響同步 */ })

  return result
}

// 刪除：單一鍵用 .in() 批次；複合鍵逐列刪（null 鍵值用 IS NULL 比對）。
// 皆以 .select() 回傳實際被刪的列來計數，不以「嘗試數」充當。
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
    const nonNull = rowsToDelete.map((r) => r[col]).filter((v) => v != null)
    for (let i = 0; i < nonNull.length; i += DELETE_BATCH) {
      let q = supabase.from(table).delete().in(col, nonNull.slice(i, i + DELETE_BATCH) as unknown[])
      if (scope) q = q.eq(scope.col, scope.value)
      const { data, error } = await q.select(col)
      if (error) throw error
      deleted += (data ?? []).length
    }
    const hasNull = rowsToDelete.some((r) => r[col] == null)
    if (hasNull) {
      let q = supabase.from(table).delete().is(col, null)
      if (scope) q = q.eq(scope.col, scope.value)
      const { data, error } = await q.select(col)
      if (error) throw error
      deleted += (data ?? []).length
    }
    return deleted
  }
  // 複合鍵：逐列，null 值以 .is() 比對（.match 的 eq.null 對 SQL NULL 永遠不中）
  for (const r of rowsToDelete) {
    let q = supabase.from(table).delete()
    for (const c of keyCols) {
      const v = r[c]
      q = v == null ? q.is(c, null) : q.eq(c, v as string | number)
    }
    if (scope) q = q.eq(scope.col, scope.value)
    const { data, error } = await q.select(keyCols[0])
    if (error) throw error
    deleted += (data ?? []).length
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
  deletedRows: Row[]
}

async function logFailure(
  supabase: AdminClient,
  action: string,
  elapsedMs: number,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  await supabase.from('erp_sync_logs').insert({
    action,
    mode: 'incremental',
    ok: false,
    count: null,
    elapsed_ms: elapsedMs,
    message: message.slice(0, 500),
  })
}

async function writeLogs(supabase: AdminClient, ctx: LogContext): Promise<void> {
  const { action, table, docNoCol, subNoCol, elapsedMs, result } = ctx

  const notes: string[] = []
  if (result.duplicates > 0) notes.push(`dup=${result.duplicates}`)
  if (result.deletesSkipped > 0) notes.push(`deletes_skipped=${result.deletesSkipped}(護欄觸發，未刪除)`)

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
      message: notes.length > 0 ? notes.join(' ') : null,
      payload: { duplicates: result.duplicates, deletes_skipped: result.deletesSkipped },
    })
    .select('id')
    .single()
  if (runErr) throw runErr
  const runId = (runRow as { id?: number } | null)?.id ?? null

  const docNo = (r: Row) => String(r[docNoCol] ?? '')
  const subNo = (r: Row) => (subNoCol ? String(r[subNoCol] ?? '') : null)

  // 順序：delete 最關鍵（稽核用）→ update → insert；超過上限時先丟 insert
  const detail: Row[] = []
  for (const r of ctx.deletedRows) {
    detail.push({ run_id: runId, action, target_table: table, doc_no: docNo(r), sub_no: subNo(r), change_type: 'delete', detected_via: 'content', changed_fields: null, before: r, after: null })
  }
  for (const u of ctx.updates) {
    detail.push({ run_id: runId, action, target_table: table, doc_no: docNo(u.after), sub_no: subNo(u.after), change_type: 'update', detected_via: 'content', changed_fields: u.changed.length ? u.changed : null, before: u.before, after: u.after })
  }
  for (const r of ctx.inserts) {
    detail.push({ run_id: runId, action, target_table: table, doc_no: docNo(r), sub_no: subNo(r), change_type: 'insert', detected_via: 'content', changed_fields: null, before: null, after: r })
  }

  const dropped = Math.max(0, detail.length - CHANGE_LOG_CAP)
  const capped = detail.slice(0, CHANGE_LOG_CAP)
  for (let i = 0; i < capped.length; i += UPSERT_BATCH) {
    const { error } = await supabase.from('erp_change_log').insert(capped.slice(i, i + UPSERT_BATCH))
    if (error) throw error
  }
  if (dropped > 0 && runId != null) {
    await supabase
      .from('erp_sync_logs')
      .update({ payload: { duplicates: result.duplicates, deletes_skipped: result.deletesSkipped, change_log_dropped: dropped } })
      .eq('id', runId)
  }
}
