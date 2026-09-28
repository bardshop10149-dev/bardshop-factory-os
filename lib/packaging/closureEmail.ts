// 包裝專區 — D105 結案每日通知信（純函式；lines.md 第十四章）
//
// 每天台北 18:00（vercel.json cron `0 10 * * *`）由 app/api/cron/packaging-closure-email/route.ts 觸發：
//   取「台北當日」新結案列 → 沒有就不寄；有 → 組信（①當日明細 ②本月累計與區塊分布 ③結案後 ARGO 仍未銷貨對照）＋ Excel 附件。
// 本檔只有純函式：分組／統計、HTML、Excel 分頁資料、收件人解析。I/O（查表、Resend、op_log）都在路由。
// 不 import supabase、不讀時鐘（date 由呼叫端傳入）；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。
//
// 「結案後 ARGO 仍未銷貨」的比法（D105 定案）：對本月所有「未復原」的結案列，用（SO＋品號）查 erp_so_sales 鏡像的 sold_qty，
//   sold_qty < qty_at_close 的行列出來。qty_at_close 是結案當下待排池裡這一行的剩餘量、sold_qty 是這張 SO 這個品號的累計銷貨；
//   同一張 SO 同品號多行時，每一行都拿同一個 sold_qty 去比（不做分配）——這是刻意的簡化：通知信只要「提醒可能漏銷貨」，
//   多行同品號很少見，真正的行別分配（salesAlloc.allocateSoldToLines）需要 erp_so_lines，而結案行常常已被 ERP 結案／刪行。

import type { Closure, YMD } from './scheduleTypes'
import type { SoSalesRow } from './salesAlloc'
import { POOL_BLOCK_META } from './types'
import { taipeiDayOf } from './closures'

const EPS = 1e-9
const TAIPEI_OFFSET_MS = 8 * 3600_000
const r3 = (x: number): number => Math.round(x * 1000) / 1000

export const DEFAULT_CLOSURE_EMAIL_RECIPIENTS: readonly string[] = ['Snow@bardshoptw.com']
/** app_settings 的 key：值可為 JSON 陣列（同 daily_machine_output_recipients）或逗號分隔字串 */
export const CLOSURE_EMAIL_RECIPIENTS_KEY = 'packaging_closure_email_recipients'

/** op_log（kind 'closure'）「當日已寄」標記的 label；寄前用它查、寄後用它寫 */
export const closureEmailSentLabel = (date: YMD): string => `結案通知信已寄 ${date}`

export interface ClosureEmailInput {
  /** 台北日（信件的「當日」） */
  date: YMD
  /** closed_at 落在當日的結案列（含當日又復原的） */
  dayClosures: readonly Closure[]
  /** closed_at 落在本月 1 日～當日的結案列（含已復原；用來算累計與未銷貨對照） */
  monthClosures: readonly Closure[]
  /** erp_so_sales 鏡像列（只需本月結案 SO 的）；null＝鏡像表未建或讀取失敗 */
  sales: readonly SoSalesRow[] | null
  /** erp_so_sales_sync.last_ok_at；null＝沒有成功同步過或讀不到 */
  salesSyncedAt: string | null
}

/** 「結案後 ARGO 仍未銷貨」一行 */
export interface UnsoldRow {
  soLineKey: string
  so: string
  soLine: string
  customer: string | null
  itemCode: string
  itemName: string | null
  /** 應銷＝結案當下的剩餘量（qty_at_close） */
  qtyAtClose: number
  /** 結案當下鏡像分配到本行的已銷貨量（鏡像未啟用＝null） */
  soldQtyAtClose: number | null
  /** 現在鏡像裡這張 SO 這個品號的累計銷貨量（沒有鏡像列＝0） */
  soldQtyNow: number
  /** 差額＝應銷 − 現在已銷（> 0 才列） */
  shortQty: number
  /** 鏡像裡有沒有這（SO, 品號）列；false＝ARGO 完全沒有銷貨紀錄 */
  hasSalesRow: boolean
  dueDate: YMD | null
  closedAt: string
  closedByName: string | null
}

export interface BlockCount {
  block: string
  title: string
  count: number
}

export interface ClosureEmailModel {
  date: YMD
  monthStart: YMD
  /** 當日新結案（closed_at 升冪；含當日又復原的，看 restoredAt） */
  day: Closure[]
  dayRestoredCount: number
  /** 本月未復原的結案列 */
  monthActive: Closure[]
  monthCount: number
  monthRestoredCount: number
  /** 本月未復原結案依「原區塊」分布（多到少；不在池內＝'—'） */
  byBlock: BlockCount[]
  /** null＝鏡像不可用（信裡寫明、不列表） */
  unsold: UnsoldRow[] | null
  /** 本月未復原結案裡沒有品號、無法對照的筆數 */
  unsoldSkippedNoItem: number
  salesSyncedAt: string | null
}

// ─────────────────────────────────────────────────────────────────────
// 日期／格式
// ─────────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' → 該月 1 日 */
export const monthStartOf = (date: YMD): YMD => `${date.slice(0, 7)}-01`

/** ISO 時間 → 台北 'MM-DD HH:mm'（信件與 Excel 用；不合法回原字串） */
export function fmtTaipeiTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return String(iso)
  const s = new Date(t + TAIPEI_OFFSET_MS).toISOString()
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`
}

const fmtQty = (n: number | null | undefined): string =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(n)

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const blockTitle = (block: string | null): string => {
  if (!block) return '—'
  const meta = (POOL_BLOCK_META as Record<string, { title: string } | undefined>)[block]
  return meta ? `${block} ${meta.title}` : block
}

// ─────────────────────────────────────────────────────────────────────
// 分組／統計
// ─────────────────────────────────────────────────────────────────────

/** 只留 closed_at 落在台北「date」當日的列（呼叫端多半已用 listClosures 切好，這裡再守一次），closed_at 升冪 */
export function pickDayClosures(closures: readonly Closure[], date: YMD): Closure[] {
  return closures
    .filter((c) => taipeiDayOf(c.closedAt) === date)
    .sort((a, b) => (a.closedAt < b.closedAt ? -1 : a.closedAt > b.closedAt ? 1 : a.id - b.id))
}

/** 未復原結案依原區塊計數（多到少，同數依區塊代碼） */
export function countByBlock(closures: readonly Closure[]): BlockCount[] {
  const m = new Map<string, number>()
  for (const c of closures) {
    const k = c.blockAtClose ?? '—'
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([block, count]) => ({ block, title: blockTitle(block === '—' ? null : block), count }))
    .sort((a, b) => b.count - a.count || (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
}

/**
 * 「結案後 ARGO 仍未銷貨」對照：本月未復原的結案列 × 鏡像（SO＋品號，品號不分大小寫）。
 * sold_qty < qty_at_close（差 > 0.001）才列；沒有鏡像列＝已銷 0。沒有品號的結案列無法對照 → 略過並計數。
 * 排序：差額大的在前，同差額依交期、單號。
 */
export function buildUnsoldRows(
  monthActive: readonly Closure[],
  sales: readonly SoSalesRow[],
): { rows: UnsoldRow[]; skippedNoItem: number } {
  const soldBy = new Map<string, number>()
  for (const s of sales) {
    const k = `${s.so.trim().toUpperCase()}\u0000${s.itemCode.trim().toUpperCase()}`
    soldBy.set(k, r3((soldBy.get(k) ?? 0) + (Number(s.soldQty) || 0)))
  }
  const rows: UnsoldRow[] = []
  let skippedNoItem = 0
  for (const c of monthActive) {
    const item = (c.itemCode ?? '').trim()
    if (!item) { skippedNoItem++; continue }
    const k = `${c.so.trim().toUpperCase()}\u0000${item.toUpperCase()}`
    const has = soldBy.has(k)
    const soldNow = soldBy.get(k) ?? 0
    const short = r3(c.qtyAtClose - soldNow)
    if (short <= 0.001 - EPS) continue
    rows.push({
      soLineKey: c.soLineKey, so: c.so, soLine: c.soLine, customer: c.customer,
      itemCode: item, itemName: c.itemName,
      qtyAtClose: c.qtyAtClose, soldQtyAtClose: c.soldQtyAtClose, soldQtyNow: soldNow, shortQty: short,
      hasSalesRow: has, dueDate: c.dueDate, closedAt: c.closedAt, closedByName: c.closedByName,
    })
  }
  rows.sort((a, b) => b.shortQty - a.shortQty
    || ((a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : (a.dueDate ?? '9999') > (b.dueDate ?? '9999') ? 1 : 0)
    || (a.soLineKey < b.soLineKey ? -1 : a.soLineKey > b.soLineKey ? 1 : 0))
  return { rows, skippedNoItem }
}

export function buildClosureEmailModel(input: ClosureEmailInput): ClosureEmailModel {
  const day = pickDayClosures(input.dayClosures, input.date)
  const monthActive = input.monthClosures.filter((c) => !c.restoredAt)
  const unsold = input.sales ? buildUnsoldRows(monthActive, input.sales) : null
  return {
    date: input.date,
    monthStart: monthStartOf(input.date),
    day,
    dayRestoredCount: day.filter((c) => !!c.restoredAt).length,
    monthActive,
    monthCount: monthActive.length,
    monthRestoredCount: input.monthClosures.length - monthActive.length,
    byBlock: countByBlock(monthActive),
    unsold: unsold ? unsold.rows : null,
    unsoldSkippedNoItem: unsold ? unsold.skippedNoItem : 0,
    salesSyncedAt: input.salesSyncedAt,
  }
}

// ─────────────────────────────────────────────────────────────────────
// 收件人
// ─────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/**
 * app_settings 的值 → 收件人：JSON 陣列或逗號／分號分隔字串都收；去空白、去重、丟掉不像 email 的；
 * 一個都不剩 → 用 fallback（預設 Snow）。
 */
export function parseRecipients(value: unknown, fallback: readonly string[] = DEFAULT_CLOSURE_EMAIL_RECIPIENTS): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string' ? value.split(/[,;\n]/) : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    const t = v.trim()
    if (!EMAIL_RE.test(t)) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out.length > 0 ? out : [...fallback]
}

// ─────────────────────────────────────────────────────────────────────
// 信件
// ─────────────────────────────────────────────────────────────────────

export function closureEmailSubject(m: ClosureEmailModel): string {
  const unsold = m.unsold && m.unsold.length > 0 ? `、未銷貨 ${m.unsold.length} 筆` : ''
  return `包裝結案通知 ${m.date}（新結案 ${m.day.length} 筆${unsold}）`
}

export const closureEmailAttachmentName = (date: YMD): string => `包裝結案_${date}.xlsx`

const TD = 'padding:5px 8px;border:1px solid #ddd;'
const TDR = `${TD}text-align:right;`
const TH = 'padding:5px 8px;border:1px solid #ddd;text-align:left;background:#f2f2f2;'
const THR = `${TH}text-align:right;`
const td = (v: string | null | undefined, style = TD) => `<td style="${style}">${v ? escapeHtml(v) : '—'}</td>`
const tdn = (v: number | null | undefined) => `<td style="${TDR}">${fmtQty(v)}</td>`

export function buildClosureEmailHtml(m: ClosureEmailModel): string {
  const dayRows = m.day.map((c) => {
    const restored = c.restoredAt
      ? `<div style="color:#b45309;font-size:12px;">已於 ${escapeHtml(fmtTaipeiTime(c.restoredAt))} 復原${c.restoredByName ? `（${escapeHtml(c.restoredByName)}）` : ''}</div>`
      : ''
    return `<tr>
      ${td(c.soLineKey, `${TD}font-weight:600;white-space:nowrap;`)}
      ${td(c.customer)}
      <td style="${TD}">${c.itemCode ? `<div style="font-size:12px;color:#666;">${escapeHtml(c.itemCode)}</div>` : ''}${c.itemName ? escapeHtml(c.itemName) : '—'}</td>
      ${tdn(c.qtyAtClose)}
      ${td(c.dueDate, `${TD}white-space:nowrap;`)}
      ${td(blockTitle(c.blockAtClose))}
      ${td(c.closedByName)}
      <td style="${TD}white-space:nowrap;">${escapeHtml(fmtTaipeiTime(c.closedAt))}${restored}</td>
      ${td(c.note)}
    </tr>`
  }).join('')

  const blockRows = m.byBlock.map((b) => `<tr>${td(b.title)}${tdn(b.count)}</tr>`).join('')

  let unsoldSection: string
  if (m.unsold == null) {
    unsoldSection = `<p style="color:#b91c1c;font-size:13px;margin:0 0 16px;">銷貨鏡像（erp_so_sales）無法讀取，這次沒有對照。請確認 D73 銷貨同步是否正常。</p>`
  } else if (m.unsold.length === 0) {
    unsoldSection = `<p style="color:#15803d;font-size:13px;margin:0 0 16px;">本月未復原的 ${m.monthCount} 筆結案，ARGO 銷貨量都已達結案量。</p>`
  } else {
    const rows = m.unsold.map((u) => `<tr>
      ${td(u.soLineKey, `${TD}font-weight:600;white-space:nowrap;`)}
      ${td(u.customer)}
      <td style="${TD}"><div style="font-size:12px;color:#666;">${escapeHtml(u.itemCode)}</div>${u.itemName ? escapeHtml(u.itemName) : '—'}</td>
      ${tdn(u.qtyAtClose)}
      <td style="${TDR}">${fmtQty(u.soldQtyNow)}${u.hasSalesRow ? '' : '<div style="font-size:11px;color:#999;">（無銷貨紀錄）</div>'}</td>
      <td style="${TDR}color:#b91c1c;font-weight:600;">${fmtQty(u.shortQty)}</td>
      ${tdn(u.soldQtyAtClose)}
      ${td(u.dueDate, `${TD}white-space:nowrap;`)}
      <td style="${TD}white-space:nowrap;">${escapeHtml(fmtTaipeiTime(u.closedAt))}${u.closedByName ? `<div style="font-size:12px;color:#666;">${escapeHtml(u.closedByName)}</div>` : ''}</td>
    </tr>`).join('')
    unsoldSection = `
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:16px;">
        <thead><tr>
          <th style="${TH}">單號-項次</th><th style="${TH}">客戶</th><th style="${TH}">品號／品名</th>
          <th style="${THR}">應銷（結案量）</th><th style="${THR}">已銷（現在）</th><th style="${THR}">差額</th>
          <th style="${THR}">已銷（結案時）</th><th style="${TH}">交期</th><th style="${TH}">結案</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }
  const skipped = m.unsoldSkippedNoItem > 0
    ? `<p style="color:#666;font-size:12px;margin:0 0 16px;">另有 ${m.unsoldSkippedNoItem} 筆結案沒有品號，無法對照。</p>`
    : ''

  return `
    <div style="font-family:Arial,'Microsoft JhengHei',sans-serif;color:#111;">
      <h2 style="margin:0 0 4px;">包裝結案每日通知（${escapeHtml(m.date)}）</h2>
      <p style="color:#666;font-size:13px;margin:0 0 16px;">
        主管在包裝排程工作台／模擬區按「結案」的品項行（D104）：結案後永久不再進待排池，除非在已結案清單復原。
        資料一律取自 EIP 鏡像（不查 ARGO）。
      </p>

      <h3 style="margin:0 0 4px;">① 當日新結案（${m.day.length} 筆${m.dayRestoredCount > 0 ? `，其中 ${m.dayRestoredCount} 筆當日已復原` : ''}）</h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px;">
        <thead><tr>
          <th style="${TH}">單號-項次</th><th style="${TH}">客戶</th><th style="${TH}">品號／品名</th>
          <th style="${THR}">結案時數量</th><th style="${TH}">交期</th><th style="${TH}">原區塊</th>
          <th style="${TH}">誰</th><th style="${TH}">時間</th><th style="${TH}">備註</th>
        </tr></thead>
        <tbody>${dayRows}</tbody>
      </table>

      <h3 style="margin:0 0 4px;">② 本月累計（${escapeHtml(m.monthStart)} ～ ${escapeHtml(m.date)}）</h3>
      <p style="font-size:13px;margin:0 0 8px;">未復原 <b>${m.monthCount}</b> 筆${m.monthRestoredCount > 0 ? `（另 ${m.monthRestoredCount} 筆已復原，不計）` : ''}；依原區塊：</p>
      <table style="border-collapse:collapse;font-size:13px;margin-bottom:20px;">
        <thead><tr><th style="${TH}">原區塊</th><th style="${THR}">筆數</th></tr></thead>
        <tbody>${blockRows || `<tr><td colspan="2" style="${TD}color:#999;text-align:center;">無</td></tr>`}</tbody>
      </table>

      <h3 style="margin:0 0 4px;color:#b91c1c;">③ 結案後 ARGO 仍未銷貨 — 請補銷貨或改交期${m.unsold ? `（${m.unsold.length} 筆）` : ''}</h3>
      <p style="color:#666;font-size:12px;margin:0 0 8px;">
        本月未復原的結案行 × ARGO 銷貨鏡像（同 SO＋品號累計）：已銷 &lt; 結案量的列出。已完工卻沒銷貨＝漏開銷貨單；
        還沒出貨卻結案＝應改交期而不是結案（請到已結案清單復原）。
      </p>
      ${unsoldSection}
      ${skipped}

      <p style="color:#999;font-size:12px;margin:16px 0 0;border-top:1px solid #eee;padding-top:8px;">
        ARGO 銷貨鏡像同步時間：${m.salesSyncedAt ? escapeHtml(fmtTaipeiTime(m.salesSyncedAt)) : '（尚未成功同步）'}（台北時間）。
        附件 Excel：「當日結案」「ARGO 未銷貨對照」兩個分頁。此信由 EIP 每日 18:00 自動寄出，當日沒有新結案不寄。
      </p>
    </div>`
}

// ─────────────────────────────────────────────────────────────────────
// Excel 分頁資料（路由再用 xlsx 套件轉成 buffer）
// ─────────────────────────────────────────────────────────────────────

export type SheetCell = string | number | null
export interface SheetData {
  name: string
  /** 第一列＝表頭 */
  rows: SheetCell[][]
}

export const CLOSURE_SHEET_DAY = '當日結案'
export const CLOSURE_SHEET_UNSOLD = 'ARGO 未銷貨對照'

export function buildClosureEmailSheets(m: ClosureEmailModel): SheetData[] {
  const day: SheetCell[][] = [
    ['單號-項次', '單號', '項次', '客戶', '品號', '品名', '結案時數量', '交期', '原區塊', '結案時已銷', '誰', '結案時間', '備註', '已復原', '復原時間', '復原者'],
    ...m.day.map((c): SheetCell[] => [
      c.soLineKey, c.so, c.soLine, c.customer, c.itemCode, c.itemName, c.qtyAtClose, c.dueDate,
      blockTitle(c.blockAtClose), c.soldQtyAtClose, c.closedByName, fmtTaipeiTime(c.closedAt), c.note,
      c.restoredAt ? '是' : '', c.restoredAt ? fmtTaipeiTime(c.restoredAt) : null, c.restoredByName,
    ]),
  ]
  const unsoldHeader: SheetCell[] = ['單號-項次', '單號', '項次', '客戶', '品號', '品名', '應銷（結案量）', '已銷（現在）', '差額', '已銷（結案時）', '有銷貨紀錄', '交期', '結案時間', '誰']
  const unsold: SheetCell[][] = m.unsold == null
    ? [unsoldHeader, ['銷貨鏡像無法讀取，這次沒有對照']]
    : [
      unsoldHeader,
      ...m.unsold.map((u): SheetCell[] => [
        u.soLineKey, u.so, u.soLine, u.customer, u.itemCode, u.itemName, u.qtyAtClose, u.soldQtyNow, u.shortQty,
        u.soldQtyAtClose, u.hasSalesRow ? '是' : '否', u.dueDate, fmtTaipeiTime(u.closedAt), u.closedByName,
      ]),
    ]
  return [
    { name: CLOSURE_SHEET_DAY, rows: day },
    { name: CLOSURE_SHEET_UNSOLD, rows: unsold },
  ]
}
