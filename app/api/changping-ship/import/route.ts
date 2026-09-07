import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { type ShipMethod } from '@/lib/purchasing/types'

export const dynamic = 'force-dynamic'
// 全量同步(數千列)要跑幾十個批次查詢/寫入;Vercel 預設 function 時限太短
export const maxDuration = 300

// POST:常平出貨標記匯入(本機排程 changping_ship_sync.py 07:00 呼叫)
// 驗證:Header `Authorization: Bearer <WEBHOOK_SECRET>`(同 /api/webhook/sync,不走 cookie)
//
// 做三件事:
//   1. 黃底列快照 upsert 到 changping_ship_marks(常平訂單資料區)
//   2. 對到 erp_pj_sync 採購行(doc_no+item_code)→ po_line_tracking.shipped_at 亮出貨燈
//   3. 常平出貨日附加到該行備註:只管理自己的「【常平出貨】…」行,絕不動使用者其他內容
//
// dry_run=true:完全不寫入,只回報「會做什麼」(可在建表前先驗證比對邏輯)
// only_po:只處理指定單號(單張測試);此時不做 still_marked=false 的下架掃描

interface MarkRow {
  mark_key: string
  sheet: string
  row_no?: number | null
  detail_id?: string | null
  po_no: string
  pr_no?: string | null
  so_no?: string | null
  vendor?: string | null
  item_code?: string | null
  item_name?: string | null
  qty?: number | null
  order_date?: string | null
  hope_date?: string | null
  transport?: string | null
  expected_ship?: string | null
  ship_date_text?: string | null
  ship_date?: string | null
  fill_color?: string | null
}

interface ImportBody {
  source?: string
  dry_run?: boolean
  only_po?: string[] | null
  sheets?: string[]
  rows?: MarkRow[]
  /** 增量模式(Snow 2026-08-30:只寫變量):rows 只含新增/變動列,
   *  removed_keys 明列要下架的標記;跳過「不在快照就下架」的全量掃描 */
  incremental?: boolean
  removed_keys?: string[]
}

const NOTE_MAX_LEN = 500
const NOTE_TAG = '【常平出貨】'
const IN_CHUNK = 200
const UPDATED_BY = '常平出貨同步'

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase()

/** 來源單欄原文(可能夾雜中文註記/斜線)→ 第一個 SO/SOB/RO 單號 token(大寫);抽不出回 null */
function extractSoToken(s: string | null | undefined): string | null {
  const m = String(s ?? '').toUpperCase().match(/(?:SOB|SO|RO)\d{6,}/)
  return m ? m[0] : null
}

/** 常平出貨日原文/運輸方式欄 → 採購專區貨運下拉的合法值(po_line_tracking CHECK 限定四種)。
 *  對不上的(貨拉拉/梁二哥/廠商寄送…)回 null——完整原文本來就會進備註,不硬塞。 */
function deriveShipMethod(...texts: (string | null | undefined)[]): ShipMethod | null {
  const s = texts.filter(Boolean).join(' ')
  if (!s) return null
  if (/順豐|顺丰|SF/i.test(s)) return '順豐'
  if (/海特快|海特|海快/.test(s)) return '海特快'      // 常平常只寫「海特」;要在通用「海運」之前判
  if (/空運|空运/.test(s)) return '空運'              // 含「貨代空運」
  if (/海運|海运|船運|船运|普船/.test(s)) return '一般海運'
  return null
}

/** 既有備註 + 出貨資訊 → 新備註。只增/換自己的 NOTE_TAG 行,保留其他內容;總長壓在 500 內。 */
function mergeNote(existing: string | null, shipInfo: string): { note: string; changed: boolean } {
  const keep = (existing ?? '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith(NOTE_TAG))
    .join('\n')
    .trimEnd()
  let tagLine = `${NOTE_TAG}${shipInfo}`
  const budget = NOTE_MAX_LEN - (keep ? keep.length + 1 : 0)
  if (tagLine.length > budget) tagLine = tagLine.slice(0, Math.max(budget, 0))
  const note = keep ? (tagLine ? `${keep}\n${tagLine}` : keep) : tagLine
  return { note, changed: note !== (existing ?? '') }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization') ?? ''
  const secret = authHeader.replace(/^Bearer\s+/i, '').trim()
  const expected = process.env.WEBHOOK_SECRET ?? ''
  if (!expected || secret !== expected) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  let body: ImportBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const dryRun = Boolean(body.dry_run)
  const incremental = Boolean(body.incremental)
  const onlyPo = Array.isArray(body.only_po) && body.only_po.length > 0
    ? new Set(body.only_po.map(norm))
    : null
  const sheets = Array.isArray(body.sheets) ? body.sheets.filter((s) => typeof s === 'string') : []
  const allRows = Array.isArray(body.rows) ? body.rows : []
  const bad = allRows.find((r) => !r || !r.mark_key || !r.po_no || !r.sheet)
  if (bad) {
    return NextResponse.json({ success: false, error: 'rows 內有缺 mark_key/po_no/sheet 的列' }, { status: 400 })
  }
  const rows = onlyPo ? allRows.filter((r) => onlyPo.has(norm(r.po_no))) : allRows

  const supabase = getSupabaseAdminClient()
  const now = new Date().toISOString()
  const actions: string[] = []
  const stats = { rows: rows.length, new_marks: 0, lamps_lit: 0, notes_updated: 0, methods_filled: 0, dates_filled: 0, already_applied: 0, unmatched: 0, unmarked: 0 }

  try {
    // ---- 0) 快照表存在性探測(非 dry-run 先確認,避免燈亮了快照卻寫不進的半套狀態) ----
    if (!dryRun) {
      const probe = await supabase.from('changping_ship_marks').select('mark_key').limit(1)
      if (probe.error) {
        return NextResponse.json({
          success: false,
          error: `changping_ship_marks 不可用(sql/20260828_changping_ship_marks.sql 跑了嗎?): ${probe.error.message}`,
        }, { status: 500 })
      }
    }

    // ---- 1) 對應採購行:erp_pj_sync (doc_no, item_code) → sub_no ----
    // 注意:PostgREST 單次查詢上限 1000 列,一個 chunk(200 張單)的行數常超過 →
    // 每個 chunk 內還要 range 分頁,否則靜默截斷、後面的單全誤判「對不到」(2026-08-29 踩過)
    const PAGE = 1000
    const poNos = [...new Set(rows.map((r) => r.po_no.trim()).filter(Boolean))]
    type PjLine = { doc_no: string; sub_no: string; item_code: string | null; so: string | null; vendor: string | null }
    const PJ_LINE_SELECT = 'doc_no, sub_no, item_code, so:extra->>SO_PROJECT_ID, vendor:customer_vendor'
    const pjLines: PjLine[] = []
    for (const part of chunk(poNos, IN_CHUNK)) {
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
          .from('erp_pj_sync')
          .select(PJ_LINE_SELECT)
          .eq('doc_type', '採購單號')
          .in('doc_no', part)
          .order('doc_no', { ascending: true })
          .order('sub_no', { ascending: true })
          .range(offset, offset + PAGE - 1)
        if (error) throw new Error(error.message)
        const page = (data ?? []) as unknown as PjLine[]
        pjLines.push(...page)
        if (page.length < PAGE) break
      }
    }
    const lineIndex = new Map<string, PjLine[]>()
    for (const l of pjLines) {
      const k = `${norm(l.doc_no)}|${norm(l.item_code)}`
      const list = lineIndex.get(k) ?? []
      list.push(l)
      lineIndex.set(k, list)
    }

    // 後備比對索引:(來源SO單號+品號) → 常平廠商(C01510)的採購行。
    // 工作表偶有整批列標錯採購單號(2026-08-29 實例:POC2026062501 區塊其實是 2502 的行,
    // 出貨日文字全填在標錯那批)——單號對不到時用來源單+品號對回,常平出貨資訊才不會斷。
    // 只收常平廠商行,避免同 SO 同品號跨廠商誤配。
    const CHANGPING_VENDOR = 'C01510'
    const soItemIndex = new Map<string, PjLine[]>()
    {
      const soTokens = [...new Set(rows.map((r) => extractSoToken(r.so_no)).filter(Boolean))] as string[]
      const wanted = new Set(soTokens)
      // 常平行的 SO 需另撈:標錯單號時行不在 poNos 撈回的集合裡 → 依 SO 直接查
      for (const part of chunk(soTokens, IN_CHUNK)) {
        for (let offset = 0; ; offset += PAGE) {
          const { data, error } = await supabase
            .from('erp_pj_sync')
            .select(PJ_LINE_SELECT)
            .eq('doc_type', '採購單號')
            .eq('customer_vendor', CHANGPING_VENDOR)
            .in('extra->>SO_PROJECT_ID', part)
            .order('doc_no', { ascending: true })
            .order('sub_no', { ascending: true })
            .range(offset, offset + PAGE - 1)
          if (error) throw new Error(error.message)
          const page = (data ?? []) as unknown as PjLine[]
          for (const l of page) {
            const so = norm(l.so)
            if (!so || !wanted.has(so)) continue
            const k = `${so}|${norm(l.item_code)}`
            const list = soItemIndex.get(k) ?? []
            if (!list.some((x) => x.doc_no === l.doc_no && x.sub_no === l.sub_no)) list.push(l)
            soItemIndex.set(k, list)
          }
          if (page.length < PAGE) break
        }
      }
    }

    type Matched = { row: MarkRow; lines: PjLine[]; status: string }
    const matched: Matched[] = rows.map((row) => {
      let lines = lineIndex.get(`${norm(row.po_no)}|${norm(row.item_code)}`) ?? []
      let via = ''
      if (lines.length === 0) {
        const so = extractSoToken(row.so_no)
        if (so) {
          lines = soItemIndex.get(`${so}|${norm(row.item_code)}`) ?? []
          if (lines.length > 0) via = '_by_so'
        }
      }
      const status = lines.length === 0 ? 'no_line' : (lines.length === 1 ? 'matched' : 'multi_line') + via
      if (status === 'no_line') {
        stats.unmatched++
        actions.push(`對不到採購行:${row.po_no} / ${row.item_code ?? '-'}(${row.sheet} r${row.row_no ?? '?'})`)
      }
      return { row, lines, status }
    })
    // 有出貨文字的列排後面(pendingLineWrites 後寫者勝):同一行同時被
    // 「標錯單號但有文字」與「單號正確但空白」的列對到時,真文字要蓋過「日期未填」
    matched.sort((a, b) => (a.row.ship_date_text ? 1 : 0) - (b.row.ship_date_text ? 1 : 0))

    // ---- 2) 讀既有 po_line_tracking,套出貨燈 + 備註 ----
    const lampDocs = [...new Set(matched.flatMap((m) => m.lines.map((l) => l.doc_no)))]
    type Tracking = {
      doc_no: string; sub_no: string; sent_at: string | null; shipped_at: string | null
      ship_method: string | null; expected_ship_date: string | null; note: string | null
    }
    const trackingMap = new Map<string, Tracking>()
    for (const part of chunk(lampDocs, IN_CHUNK)) {
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
          .from('po_line_tracking')
          .select('doc_no, sub_no, sent_at, shipped_at, ship_method, expected_ship_date, note')
          .in('doc_no', part)
          .order('doc_no', { ascending: true })
          .order('sub_no', { ascending: true })
          .range(offset, offset + PAGE - 1)
        if (error) throw new Error(error.message)
        const page = (data ?? []) as Tracking[]
        for (const t of page) trackingMap.set(`${t.doc_no}|${t.sub_no}`, t)
        if (page.length < PAGE) break
      }
    }

    const applyResults = new Map<string, { applied: boolean; note: string }>()
    // 逐筆 upsert 幾千行會逾時 → 先在記憶體算完(同行去重,後列覆蓋前列=與逐筆語意一致),最後批次寫
    const pendingLineWrites = new Map<string, Tracking & { updated_by: string; updated_at: string }>()
    // 原始快照:最後用「最終狀態 vs 原始」算真實統計＋略過無變化的行
    // (同一行分多批出貨時,逐列會 A→B 來回改寫,逐列統計會把「最終沒變」也算成更新)
    const originalTracking = new Map(trackingMap)
    for (const m of matched) {
      if (m.lines.length === 0) {
        applyResults.set(m.row.mark_key, { applied: false, note: '對不到採購行' })
        continue
      }
      // 出貨日原文可能含換行(多行批註)——備註的管理行必須是單行,
      // 否則下一輪換行後的內容會被誤當使用者文字保留、無限疊加(2026-08-29 踩過)
      const shipInfo = ((m.row.ship_date_text ?? '').trim() || '已出貨(工作表黃底,日期未填)')
        .replace(/\s*\r?\n\s*/g, ' / ')
      const shippedAtNew = m.row.ship_date ? `${m.row.ship_date}T04:00:00.000Z` : now
      // 常平出貨日文字優先(通常「8/25 順豐」同時帶日期+方式),沒有再退運輸方式欄
      const methodNew = deriveShipMethod(m.row.ship_date_text, m.row.transport)
      const shipDateNew = m.row.ship_date ?? null
      const parts: string[] = []
      let rowChanged = false
      for (const line of m.lines) {
        const key = `${line.doc_no}|${line.sub_no}`
        const t = trackingMap.get(key)
        const { note, changed: noteChanged } = mergeNote(t?.note ?? null, shipInfo)
        const lampChanged = !t?.shipped_at
        // 貨運/日期只在 EIP 欄位還空著時帶入(採購手動選過的一律不動)
        const methodChanged = !t?.ship_method && methodNew != null
        const dateChanged = !t?.expected_ship_date && shipDateNew != null
        if (!lampChanged && !noteChanged && !methodChanged && !dateChanged) {
          parts.push(`${line.doc_no}#${line.sub_no} 已套用過`)
          continue
        }
        rowChanged = true
        if (lampChanged) stats.lamps_lit++
        if (noteChanged) stats.notes_updated++
        if (methodChanged) stats.methods_filled++
        if (dateChanged) stats.dates_filled++
        const done = [
          lampChanged ? '亮出貨燈' : '',
          noteChanged ? '備註' : '',
          methodChanged ? `貨運=${methodNew}` : '',
          dateChanged ? `日期=${shipDateNew}` : '',
        ].filter(Boolean).join('+')
        parts.push(`${line.doc_no}#${line.sub_no} ${done}`)
        if (!dryRun) {
          const payload = {
            doc_no: line.doc_no,
            sub_no: line.sub_no,
            sent_at: t?.sent_at ?? null,
            shipped_at: t?.shipped_at ?? shippedAtNew,
            ship_method: t?.ship_method ?? methodNew,
            expected_ship_date: t?.expected_ship_date ?? shipDateNew,
            note,
            updated_by: UPDATED_BY,
            updated_at: now,
          }
          pendingLineWrites.set(key, payload)
          // 之後同批還會再讀到同一行時,要以更新後狀態為準
          trackingMap.set(key, { ...payload })
        }
      }
      if (!rowChanged) stats.already_applied++
      const summary = parts.join(';')
      applyResults.set(m.row.mark_key, { applied: true, note: summary })
      actions.push(`${m.row.po_no} ${m.row.item_code ?? ''} → ${summary}`
        + (m.status.startsWith('multi_line') ? `(同品號 ${m.lines.length} 行全套用)` : '')
        + (m.status.endsWith('_by_so') ? '(工作表單號對不到,用來源單+品號對回)' : ''))
    }

    // ---- 2b) 批次寫入採購行追蹤:只寫「最終狀態 ≠ 原始」的行,統計也以此為準 ----
    if (!dryRun) {
      stats.lamps_lit = 0
      stats.notes_updated = 0
      stats.methods_filled = 0
      stats.dates_filled = 0
      const writes: (typeof pendingLineWrites extends Map<string, infer V> ? V : never)[] = []
      for (const [key, p] of pendingLineWrites) {
        const o = originalTracking.get(key)
        if (o && o.sent_at === p.sent_at && o.shipped_at === p.shipped_at && o.ship_method === p.ship_method
          && o.expected_ship_date === p.expected_ship_date && o.note === p.note) {
          continue   // 最終沒變 → 不寫(也不洗 updated_at/by)
        }
        if (!o?.shipped_at && p.shipped_at) stats.lamps_lit++
        if ((o?.note ?? null) !== (p.note ?? null)) stats.notes_updated++
        if (!o?.ship_method && p.ship_method) stats.methods_filled++
        if (!o?.expected_ship_date && p.expected_ship_date) stats.dates_filled++
        writes.push(p)
      }
      for (const part of chunk(writes, IN_CHUNK)) {
        const { error } = await supabase
          .from('po_line_tracking')
          .upsert(part, { onConflict: 'doc_no,sub_no' })
        if (error) throw new Error(`po_line_tracking 批次寫入: ${error.message}`)
      }
    }

    // ---- 3) 標記快照 upsert(dry_run 完全跳過 → 建表前也能先測比對) ----
    if (!dryRun) {
      const keys = rows.map((r) => r.mark_key)
      const existingKeys = new Set<string>()
      for (const part of chunk(keys, IN_CHUNK)) {
        const { data, error } = await supabase
          .from('changping_ship_marks')
          .select('mark_key')
          .in('mark_key', part)
        if (error) throw new Error(`changping_ship_marks 讀取失敗(建表 SQL 跑了嗎?): ${error.message}`)
        for (const k of (data ?? []) as { mark_key: string }[]) existingKeys.add(k.mark_key)
      }
      stats.new_marks = keys.filter((k) => !existingKeys.has(k)).length

      const upserts = matched.map(({ row, lines, status }) => {
        const res = applyResults.get(row.mark_key)
        return {
          mark_key: row.mark_key,
          sheet: row.sheet,
          row_no: row.row_no ?? null,
          detail_id: row.detail_id ?? null,
          po_no: row.po_no,
          pr_no: row.pr_no ?? null,
          so_no: row.so_no ?? null,
          vendor: row.vendor ?? null,
          item_code: row.item_code ?? null,
          item_name: row.item_name ?? null,
          qty: row.qty ?? null,
          order_date: row.order_date ?? null,
          hope_date: row.hope_date ?? null,
          transport: row.transport ?? null,
          expected_ship: row.expected_ship ?? null,
          ship_date_text: row.ship_date_text ?? null,
          ship_date: row.ship_date ?? null,
          fill_color: row.fill_color ?? null,
          still_marked: true,
          last_seen_at: now,
          matched_lines: lines.map((l) => ({ doc_no: l.doc_no, sub_no: l.sub_no })),
          match_status: status,
          ...(res?.applied ? { applied_at: now, apply_note: res.note } : { apply_note: res?.note ?? null }),
        }
      })
      // 防禦性去重:同鍵在同一批出現兩次會觸發 ON CONFLICT cannot affect row a second time
      const dedup = new Map<string, (typeof upserts)[number]>()
      for (const u of upserts) dedup.set(u.mark_key, u)
      for (const part of chunk([...dedup.values()], IN_CHUNK)) {
        const { error } = await supabase
          .from('changping_ship_marks')
          .upsert(part, { onConflict: 'mark_key' })
        if (error) throw new Error(`changping_ship_marks upsert: ${error.message}`)
      }

      // 下架(增量模式):客戶端明列消失的標記,直接下架,不做全量差集掃描
      if (incremental) {
        const removed = (body.removed_keys ?? []).filter((k) => typeof k === 'string' && k)
        stats.unmarked = removed.length
        for (const part of chunk(removed, IN_CHUNK)) {
          const { error } = await supabase
            .from('changping_ship_marks')
            .update({ still_marked: false, last_seen_at: now })
            .in('mark_key', part)
            .eq('still_marked', true)
          if (error) throw new Error(`still_marked 下架(增量): ${error.message}`)
        }
      } else if (!onlyPo && sheets.length > 0) {
      // 下架(全量快照):同分頁但這次沒掃到的標記 → still_marked=false。
      // 不能用 not-in URL(數千 key 會爆 URL 長度)→ 先分頁讀出現存 active keys,記憶體取差集再分塊更新
        const activeKeys: string[] = []
        const PAGE = 1000
        for (let offset = 0; ; offset += PAGE) {
          const { data, error } = await supabase
            .from('changping_ship_marks')
            .select('mark_key')
            .in('sheet', sheets)
            .eq('still_marked', true)
            .order('mark_key', { ascending: true })
            .range(offset, offset + PAGE - 1)
          if (error) throw new Error(`still_marked 讀取: ${error.message}`)
          const page = (data ?? []) as { mark_key: string }[]
          activeKeys.push(...page.map((x) => x.mark_key))
          if (page.length < PAGE) break
        }
        const payloadKeySet = new Set(keys)
        const stale = activeKeys.filter((k) => !payloadKeySet.has(k))
        stats.unmarked = stale.length
        for (const part of chunk(stale, IN_CHUNK)) {
          const { error } = await supabase
            .from('changping_ship_marks')
            .update({ still_marked: false, last_seen_at: now })
            .in('mark_key', part)
          if (error) throw new Error(`still_marked 下架: ${error.message}`)
        }
      }
    }

    // 全量首跑 actions 可達數千筆,回應只帶前 200 筆避免爆量
    const cappedActions = actions.length > 200
      ? [...actions.slice(0, 200), `…另 ${actions.length - 200} 筆(略)`]
      : actions
    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      stats,
      actions: cappedActions,
      // 增量同步的握手旗標:客戶端見此旗標才敢送增量(舊版伺服器缺它→退回全量,
      // 否則舊版會把「沒送的列」當成消失整批下架)
      supports_incremental: true,
      // 對不到採購行的標記鍵(僅本次送來的列):客戶端存起來,之後每晚重試(ERP 晚開單補得回來)
      unmatched_keys: matched.filter((m) => m.status === 'no_line').map((m) => m.row.mark_key),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
