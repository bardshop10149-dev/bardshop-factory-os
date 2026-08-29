import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { type ShipMethod } from '@/lib/purchasing/types'

export const dynamic = 'force-dynamic'

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
  const stats = { rows: rows.length, new_marks: 0, lamps_lit: 0, notes_updated: 0, methods_filled: 0, dates_filled: 0, already_applied: 0, unmatched: 0 }

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
    const poNos = [...new Set(rows.map((r) => r.po_no.trim()).filter(Boolean))]
    type PjLine = { doc_no: string; sub_no: string; item_code: string | null }
    const pjLines: PjLine[] = []
    for (const part of chunk(poNos, IN_CHUNK)) {
      const { data, error } = await supabase
        .from('erp_pj_sync')
        .select('doc_no, sub_no, item_code')
        .eq('doc_type', '採購單號')
        .in('doc_no', part)
      if (error) throw new Error(error.message)
      pjLines.push(...((data ?? []) as PjLine[]))
    }
    const lineIndex = new Map<string, PjLine[]>()
    for (const l of pjLines) {
      const k = `${norm(l.doc_no)}|${norm(l.item_code)}`
      const list = lineIndex.get(k) ?? []
      list.push(l)
      lineIndex.set(k, list)
    }

    type Matched = { row: MarkRow; lines: PjLine[]; status: 'matched' | 'multi_line' | 'no_line' }
    const matched: Matched[] = rows.map((row) => {
      const lines = lineIndex.get(`${norm(row.po_no)}|${norm(row.item_code)}`) ?? []
      const status = lines.length === 0 ? 'no_line' : lines.length === 1 ? 'matched' : 'multi_line'
      if (status === 'no_line') {
        stats.unmatched++
        actions.push(`對不到採購行:${row.po_no} / ${row.item_code ?? '-'}(${row.sheet} r${row.row_no ?? '?'})`)
      }
      return { row, lines, status }
    })

    // ---- 2) 讀既有 po_line_tracking,套出貨燈 + 備註 ----
    const lampDocs = [...new Set(matched.flatMap((m) => m.lines.map((l) => l.doc_no)))]
    type Tracking = {
      doc_no: string; sub_no: string; sent_at: string | null; shipped_at: string | null
      ship_method: string | null; expected_ship_date: string | null; note: string | null
    }
    const trackingMap = new Map<string, Tracking>()
    for (const part of chunk(lampDocs, IN_CHUNK)) {
      const { data, error } = await supabase
        .from('po_line_tracking')
        .select('doc_no, sub_no, sent_at, shipped_at, ship_method, expected_ship_date, note')
        .in('doc_no', part)
      if (error) throw new Error(error.message)
      for (const t of (data ?? []) as Tracking[]) trackingMap.set(`${t.doc_no}|${t.sub_no}`, t)
    }

    const applyResults = new Map<string, { applied: boolean; note: string }>()
    for (const m of matched) {
      if (m.lines.length === 0) {
        applyResults.set(m.row.mark_key, { applied: false, note: '對不到採購行' })
        continue
      }
      const shipInfo = (m.row.ship_date_text ?? '').trim() || '已出貨(工作表黃底,日期未填)'
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
          const { error } = await supabase
            .from('po_line_tracking')
            .upsert(payload, { onConflict: 'doc_no,sub_no' })
          if (error) throw new Error(`po_line_tracking ${key}: ${error.message}`)
          // 之後同批還會再讀到同一行時,要以更新後狀態為準
          trackingMap.set(key, { ...payload })
        }
      }
      if (!rowChanged) stats.already_applied++
      const summary = parts.join(';')
      applyResults.set(m.row.mark_key, { applied: true, note: summary })
      actions.push(`${m.row.po_no} ${m.row.item_code ?? ''} → ${summary}${m.status === 'multi_line' ? `(同品號 ${m.lines.length} 行全套用)` : ''}`)
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
      for (const part of chunk(upserts, IN_CHUNK)) {
        const { error } = await supabase
          .from('changping_ship_marks')
          .upsert(part, { onConflict: 'mark_key' })
        if (error) throw new Error(`changping_ship_marks upsert: ${error.message}`)
      }

      // 下架:整批快照(非 only_po)時,同分頁但這次沒掃到的標記 → still_marked=false
      if (!onlyPo && sheets.length > 0) {
        const keySet = keys.length > 0 ? `(${keys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')})` : null
        let q = supabase
          .from('changping_ship_marks')
          .update({ still_marked: false, last_seen_at: now })
          .in('sheet', sheets)
          .eq('still_marked', true)
        if (keySet) q = q.not('mark_key', 'in', keySet)
        const { error } = await q
        if (error) throw new Error(`still_marked 下架: ${error.message}`)
      }
    }

    return NextResponse.json({ success: true, dry_run: dryRun, stats, actions })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
