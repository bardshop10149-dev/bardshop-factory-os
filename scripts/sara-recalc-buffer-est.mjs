// ============================================================================
//  交換區工時重算（就地修正，預設只試跑）
// ----------------------------------------------------------------------------
//  用途：交換區裡有些印刷／雷切工序的預估工時是用「個數」算的，應該用「盤數」。
//  沒填盤數的一律以 1 盤計算（集單是正常情況，非集單會另外列出來請生管補）。
//  原因是 2026-10-02 之前產生邏輯沒讀 route_operations.qty_mode（見 lib/sara/estTime.ts）。
//  這支把那些列的「製程數量」與「預估工時」改成正確值。
//
//  ── 為什麼是就地改兩個欄位，不是重新產生整份交換區 ──
//  交換區是塔台的全量來源：塔台每次拉整份、而且不會清除。2026-09-08 就發生過交換區
//  被清空、塔台整個看板掉了 495 張單的事故。所以這支的設計原則是「能不動的就別動」：
//    · 不重新產生：重產會連帶重算排程優先等級與最早可開始時間（兩者都看今天是哪一天），
//      也會重新決定「哪些列該存在」——那正是會掉單的那一類操作。
//    · 只改 Job Quantity 與 Est. Time 兩欄，其餘每一格都必須逐字不變（會驗證）。
//    · 列數必須完全相同（會驗證），少一列就中止。
//    · 一次整份原子寫入，塔台不會讀到改一半的狀態。
//    · 寫入前先拍快照（app_settings 另一個 key ＋ 本機 CSV），隨時可還原。
//    · 寫入前重新確認 updated_at 沒變——中間若有排程寫入就中止，不覆蓋別人的資料。
//
//  ── 執行時機 ──
//  sara-process-gen 排程在台北時間 17:30 與 17:40 會寫交換區，17:45 做檢查，
//  塔台 18:00 來拉。所以請在 **17:30 之前** 執行，留足餘裕。
//
//  用法：
//    node --experimental-strip-types --import ./scripts/ts-resolve-local.mjs \
//      scripts/sara-recalc-buffer-est.mjs                 試跑，只印出差異
//    ... scripts/sara-recalc-buffer-est.mjs --apply        真的寫入（會先拍快照）
//    ... scripts/sara-recalc-buffer-est.mjs --include-done 連已完成的工單一起修
//    ... scripts/sara-recalc-buffer-est.mjs --force-window  明知在 17:25–18:05 窗口內仍要寫
//
//  預設只修「還沒完成」的工單（包裝站尚無報工）。已完成的單改工時不影響排程，
//  風險卻一樣，所以要改得另外指定。
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { loadPlateRuleMeta, resolveRoute, isGroupOrderDocType } from '../lib/sara/routeResolve.ts'
import { resolveEffQty, normalizeQtyMode, loadEstBasisMode, estTimeFrom } from '../lib/sara/estTime.ts'

const APPLY = process.argv.includes('--apply')
const INCLUDE_DONE = process.argv.includes('--include-done')
// 明知在排程窗口內仍要寫入時才加（例如要搶在今天的塔台拉取之前修好）
const FORCE_WINDOW = process.argv.includes('--force-window')

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } },
)

const s = v => String(v ?? '').trim()
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0 }

const H = 'Order Number,Manufacturing Order Number,Product Name,Product Description,Lot Number,Production Quantity,Due,Priority Level,Earliest Start Time,Job Sequence,Workcenter,Job Name,Job Quantity,Out Sourcing,Est. Time,Time Unit,BOM Components,Material Required Quantity,customer_id,assigned_machine,Rule,Parameter 1'.split(',')
const COL = Object.fromEntries(H.map((h, i) => [h, i]))
const BUFFER_KEY = 'sara_csv_buffer'

// ── 讀主檔 ──
const meta = await loadPlateRuleMeta(sb)
const estMode = await loadEstBasisMode(sb)
const { data: otData } = await sb.from('operation_times').select('op_name, station, std_time_min')
const stationOf = new Map(otData.map(o => [o.op_name, s(o.station)]))
const stdOf = new Map(otData.map(o => [o.op_name, num(o.std_time_min)]))
const { data: roData } = await sb.from('route_operations').select('route_id, op_name, qty_mode')
const qtyModeOf = new Map(roData.map(r => [`${r.route_id}|${r.op_name}`, normalizeQtyMode(r.qty_mode)]))

// ── 出單表：盤數／單據別／廠別／規格 ──
const { data: sheets } = await sb.from('daily_order_sheets').select('sheet_date, rows')
const sheetBy = new Map()
for (const sh of sheets ?? []) {
  for (const r of (Array.isArray(sh.rows) ? sh.rows : [])) {
    const info = {
      plate: num(r.plate_count), docType: s(r.doc_type), factory: s(r.factory),
      spec: s(r.item_name) || s(r.item_spec), date: sh.sheet_date, qty: num(r.quantity),
    }
    const o = s(r.order_number), p = s(r.item_code), q = s(r.line_no_input) || s(r.match_line_no)
    for (const k of [`${o}|${p}|${q}`, `${o}|${p}`]) if (!sheetBy.has(k)) sheetBy.set(k, info)
  }
}

// ── 報工：哪些工單已經在包裝站報工（＝已完成）──
// 一定要分頁：Supabase 預設只回 1000 筆，不分頁會把幾乎所有單誤判成未完成。
// 也要退一步比裸號：塔台在 2026-09-04 之前存的是不帶行號的單號。
const packed = new Set()
for (let from = 0; ; from += 1000) {
  const { data } = await sb.from('sara_wip_records')
    .select('mo_nbr, workcenter_name').range(from, from + 999)
  for (const w of data ?? []) {
    if (s(w.workcenter_name).includes('包裝站')) packed.add(s(w.mo_nbr).toUpperCase())
  }
  if (!data || data.length < 1000) break
}
const bare = v => v.replace(/-\d+$/, '')
const barePacked = new Set([...packed].map(bare))
const isPacked = mo => packed.has(mo) || barePacked.has(bare(mo))

// ── 讀交換區 ──
const { data: bufRow } = await sb.from('app_settings')
  .select('value, updated_at').eq('key', BUFFER_KEY).maybeSingle()
const original = Array.isArray(bufRow?.value) ? bufRow.value : []
const readAt = bufRow?.updated_at
if (original.length === 0) {
  console.error('交換區是空的——這很不對勁，中止。交換區永遠不該是空的（塔台拉全量）。')
  process.exit(1)
}
console.log(`交換區 ${original.length} 列，最後更新 ${readAt}`)
console.log(`工時基準模式：${estMode}\n`)

// ── 逐列算出正確值 ──
const changes = []
const skippedDone = []
const needPlate = []
for (let idx = 0; idx < original.length; idx++) {
  const row = original[idx]
  const station = s(row[COL['Workcenter']])
  if (!(station.includes('印刷') || station.includes('雷切'))) continue

  const part = s(row[COL['Product Name']])
  const op = s(row[COL['Job Name']])
  const order = s(row[COL['Order Number']])
  const lot = s(row[COL['Lot Number']])
  const mo = s(row[COL['Manufacturing Order Number']]).toUpperCase()
  const info = sheetBy.get(`${order}|${part}|${lot}`) ?? sheetBy.get(`${order}|${part}`)
  if (!info) continue   // 出單表找不到對應，算不出正確值，不動

  const { routeId } = resolveRoute({ item_code: part, item_spec: info.spec, factory: info.factory }, meta.irMap)
  if (!routeId) continue
  const qm = qtyModeOf.get(`${routeId}|${op}`)
  if (qm !== '盤數') continue

  const eff = resolveEffQty({
    station, qtyMode: '盤數', quantity: info.qty || num(row[COL['Production Quantity']]),
    panCount: info.plate, mode: estMode, isGroupOrder: isGroupOrderDocType(info.docType),
  })
  const cur = { jobQty: num(row[COL['Job Quantity']]), est: num(row[COL['Est. Time']]) }
  // 缺盤數不再「算不出來」——一律以 1 盤計算（見 lib/sara/estTime.ts）。
  // 非集單的另外記下來，提醒生管補正確盤數後再跑一次這支。
  if (eff.anomaly) needPlate.push({ idx, order, part, op, station, date: info.date, done: isPacked(mo), ...cur })
  const newEst = estTimeFrom(stdOf.get(op) ?? 0, eff.effQty)
  if (eff.effQty === cur.jobQty && newEst === cur.est) continue   // 已經正確

  const rec = {
    idx, order, part, op, station, date: info.date, mo,
    prodQty: num(row[COL['Production Quantity']]), plate: info.plate,
    assumed: !!eff.assumedPan, done: isPacked(mo),
    oldJobQty: cur.jobQty, oldEst: cur.est, newJobQty: eff.effQty, newEst,
  }
  if (rec.done && !INCLUDE_DONE) { skippedDone.push(rec); continue }
  changes.push(rec)
}

const hrs = m => (m / 60).toFixed(1)
const sumOld = a => a.reduce((x, r) => x + r.oldEst, 0)
const sumNew = a => a.reduce((x, r) => x + r.newEst, 0)

console.log(`要修正的列：${changes.length} 道`)
console.log(`  目前合計 ${sumOld(changes).toFixed(0)} 分（${hrs(sumOld(changes))} 小時）`)
console.log(`  改後合計 ${sumNew(changes).toFixed(0)} 分（${hrs(sumNew(changes))} 小時）`)
if (!INCLUDE_DONE) {
  console.log(`\n略過（工單已完成，改工時不影響排程；要一起改請加 --include-done）：${skippedDone.length} 道`)
  console.log(`  那些列目前合計 ${hrs(sumOld(skippedDone))} 小時`)
}
console.log(`\n沒填盤數、工時暫以 1 盤計算的（非集單，請生管補正確盤數後再跑一次）：${needPlate.length} 道`)
needPlate.filter(r => !r.done).slice(0, 15).forEach(r =>
  console.log(`   ${s(r.date).padEnd(11)} ${r.order.padEnd(14)} ${r.part.padEnd(22)} ${r.op.slice(0, 16).padEnd(17)} 目前 ${r.est} 分`))

console.log(`\n── 逐列差異 ──`)
changes.sort((a, b) => (b.oldEst - b.newEst) - (a.oldEst - a.newEst)).forEach(r =>
  console.log(`  [${String(r.idx).padStart(5)}] ${s(r.date).padEnd(11)} ${r.order.padEnd(14)} ${r.part.padEnd(22)} ${r.op.slice(0, 16).padEnd(17)}`
    + ` 個數=${String(r.prodQty).padEnd(6)} 盤=${String(r.plate).padEnd(5)}${r.assumed ? '(集單代1)' : '         '}`
    + ` 製程數量 ${r.oldJobQty}→${r.newJobQty}  工時 ${r.oldEst}→${r.newEst} 分`))

if (changes.length === 0) { console.log('\n沒有要改的列，結束。'); process.exit(0) }

// ── 組出新陣列（只改兩欄，其餘逐字複製）──
const updated = original.map(r => [...r])
for (const c of changes) {
  updated[c.idx][COL['Job Quantity']] = String(c.newJobQty)
  updated[c.idx][COL['Est. Time']] = String(c.newEst)
}

// ── 驗證：列數相同、且只有預期的那幾格不同 ──
const problems = []
if (updated.length !== original.length) problems.push(`列數不同：${original.length} → ${updated.length}`)
const allowed = new Set(changes.map(c => c.idx))
for (let i = 0; i < original.length; i++) {
  const a = original[i], b = updated[i]
  if (a.length !== b.length) { problems.push(`第 ${i} 列欄數不同`); continue }
  for (let j = 0; j < a.length; j++) {
    if (a[j] === b[j]) continue
    const okCell = allowed.has(i) && (j === COL['Job Quantity'] || j === COL['Est. Time'])
    if (!okCell) problems.push(`第 ${i} 列第 ${j} 欄（${H[j]}）不該被改：「${a[j]}」→「${b[j]}」`)
  }
}
if (problems.length) {
  console.error(`\n✗ 驗證失敗，中止，沒有寫入任何東西：`)
  problems.slice(0, 10).forEach(p => console.error('   ' + p))
  process.exit(1)
}
console.log(`\n✅ 驗證通過：列數不變（${original.length}），只有 ${changes.length} 列的「製程數量」與「預估工時」被改`)

if (!APPLY) {
  console.log('\n這是試跑，沒有寫入。確認上面的差異沒問題後，加 --apply 執行。')
  process.exit(0)
}

// ── 排程窗口保護（硬性拒絕，不靠人記得）──
// sara-process-gen 在台北 17:30 與 17:40 寫交換區，17:45 做檢查，塔台 18:00 來拉。
// 在這段時間寫入會跟排程搶同一份資料（讀取—修改—寫回之間被插入就會互相覆蓋），
// 而且留給塔台的餘裕太少。
//
// 這道保護是補上來的：2026-10-02 我自己就在 17:39 誤跑了一次 --apply，當時只在註解與
// 說明文字裡寫「請在 17:30 前執行」，而說明文字擋不住任何人。能用程式擋的就不要只寫在文件裡。
const tpeNow = new Date(Date.now() + 8 * 3600 * 1000)
const minuteOfDay = tpeNow.getUTCHours() * 60 + tpeNow.getUTCMinutes()
if (!FORCE_WINDOW && minuteOfDay >= 17 * 60 + 25 && minuteOfDay <= 18 * 60 + 5) {
  const hhmm = `${String(tpeNow.getUTCHours()).padStart(2, '0')}:${String(tpeNow.getUTCMinutes()).padStart(2, '0')}`
  console.error(`\n✗ 現在是台北時間 ${hhmm}，落在排程寫入與塔台拉取的窗口內（17:25–18:05），拒絕寫入。`)
  console.error('  sara-process-gen 於 17:30／17:40 寫交換區，17:45 檢查，塔台 18:00 來拉。')
  console.error('  請改在 18:05 之後，或隔天 17:25 之前執行。')
  console.error('  真的必須現在寫（例如要搶在今天這次拉取之前修好），加 --force-window。')
  process.exit(1)
}

// ── 寫入前拍快照 ──
const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '')
const backupKey = `sara_csv_buffer_backup_${stamp}`
const { error: bkErr } = await sb.from('app_settings').upsert(
  { key: backupKey, value: original, updated_at: new Date().toISOString() }, { onConflict: 'key' })
if (bkErr) { console.error('快照寫入失敗，中止：', bkErr.message); process.exit(1) }
const localBackup = `sara_csv_buffer_backup_${stamp}.json`
writeFileSync(localBackup, JSON.stringify(original), 'utf8')
console.log(`\n快照已存：app_settings['${backupKey}'] 與本機 ${localBackup}`)

// ── 樂觀鎖：確認這段期間沒有別人寫入（排程 17:30/17:40 會寫）──
const { data: recheck } = await sb.from('app_settings')
  .select('updated_at').eq('key', BUFFER_KEY).maybeSingle()
if (recheck?.updated_at !== readAt) {
  console.error(`\n✗ 交換區在這段期間被改過了（${readAt} → ${recheck?.updated_at}），中止。`)
  console.error('  很可能是 sara-process-gen 排程寫入。請重新執行這支（會重新讀取最新內容）。')
  process.exit(1)
}

// ── 一次整份原子寫入 ──
const { error: wErr } = await sb.from('app_settings').upsert(
  { key: BUFFER_KEY, value: updated, updated_at: new Date().toISOString() }, { onConflict: 'key' })
if (wErr) { console.error('寫入失敗：', wErr.message); process.exit(1) }

// ── 寫完回讀驗證 ──
const { data: after } = await sb.from('app_settings').select('value').eq('key', BUFFER_KEY).maybeSingle()
const written = Array.isArray(after?.value) ? after.value : []
if (written.length !== original.length) {
  console.error(`✗ 寫入後列數不對（${original.length} → ${written.length}）！請立刻用快照還原：`)
  console.error(`   app_settings['${backupKey}']`)
  process.exit(1)
}
let mismatch = 0
for (const c of changes) {
  if (num(written[c.idx][COL['Est. Time']]) !== c.newEst) mismatch++
}
console.log(mismatch === 0
  ? `\n✅ 完成：${changes.length} 道工序的工時已更正，交換區仍為 ${written.length} 列。`
  : `\n✗ 有 ${mismatch} 道寫入後對不上，請檢查並考慮用快照 '${backupKey}' 還原。`)
