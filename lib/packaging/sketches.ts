// 包裝專區：訂單示意圖查詢（GET /api/packaging/sketches 的資料層）
//
// 來源：daily_order_sheets.rows[].sketch_urls（出單表上傳到 Storage bucket order-sketch-images
// 的原檔，4961×7017 PNG/JPG；舊資料退用單張 sketch_url）。規格見
// docs/design/2026-09-27-packaging-schedule.md §7.2。
//
// 查詢方式（避免每次掃整張出單表，全表約 6.5MB）：
//   rows=cs.[{"order_number":"<SO>"}]（jsonb 包含）＋ sheet_date ≥ 台北今天−180 天
//   → 只回傳「含這張 SO 的那幾天」出單表（實測 1~2 張、0.1~0.4 秒），再於伺服器端篩出該 SO 的列。
//   同一張 SO 可能出現在多天出單表（追加／重複發單，全表 263 張 SO 如此），一律合併、較新的在前。
// 180 天＝待排池採購行的開單窗口（§7.1），也涵蓋出單表索引的 120 天（§7.3），
// 所以卡片上 hasSketch=true 的行，這裡一定查得到。
//
// 網址一律經 resolveSketchUrl() 產出，前端不得自行拼接（D39：bucket 之後改 private＋短期簽名網址）。

import type { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { SketchImage, SketchLine } from '@/lib/packaging/types'
import { todayTaipei } from '@/lib/packaging/workdays'

type SupabaseAdmin = ReturnType<typeof getSupabaseAdminClient>

const SKETCH_BUCKET = 'order-sketch-images'
/** 出單表回看天數（日曆天） */
const SHEET_LOOKBACK_DAYS = 180
/** 快取存活時間：出單表上傳新圖後，最慢 1 分鐘內包裝專區看得到 */
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 300

/**
 * SO 單號格式：SO／SOA／SOB／RO／ASO… 開頭＋數字，允許連字號（SOA260924-095321-313）。
 * 這裡擋掉特殊字元，確保組進 jsonb 包含條件時不會變成別的查詢。
 */
const SO_PATTERN = /^[A-Z]{2,4}\d[A-Z0-9-]{3,40}$/

/** 正規化並驗證 SO 單號；不合格回 null */
export function normalizeSoParam(raw: string | null | undefined): string | null {
  const so = String(raw ?? '').trim().toUpperCase()
  return SO_PATTERN.test(so) ? so : null
}

// ---------------------------------------------------------------------------
// 網址擴充點
// ---------------------------------------------------------------------------

/**
 * 從 Storage 網址解析出 bucket 內的物件路徑（例 `SO260922010_1_1790238574924.png`）。
 * 接受 public／sign／authenticated 三種網址形狀；不是本 bucket 的網址回 null。
 */
export function parseSketchObjectPath(storedUrl: string): string | null {
  try {
    const u = new URL(storedUrl)
    const m = u.pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/)
    if (!m || m[1] !== SKETCH_BUCKET) return null
    return decodeURIComponent(m[2])
  } catch {
    return null
  }
}

/**
 * 把出單表存的示意圖網址轉成「前端可直接顯示」的網址 —— 全站唯一的轉換點。
 *
 * P0（現況）：bucket 是 public，原樣回傳 { url: storedUrl, expiresAt: null }。
 *
 * 之後 bucket 改 private（D39，由另一個 session 處理）時只改這個函式：
 *   const path = parseSketchObjectPath(storedUrl)
 *   if (!path) return { url: storedUrl, expiresAt: null }   // 非本 bucket 的網址照舊
 *   const { data, error } = await supabase.storage.from(SKETCH_BUCKET).createSignedUrl(path, 600)
 *   if (error || !data) return null                           // 簽不出來就當沒圖，不要回傳失效網址
 *   return { url: data.signedUrl, expiresAt: new Date(Date.now() + 600_000).toISOString() }
 * 張數多時可改在 resolveSketchImages() 一次呼叫 createSignedUrls(paths, 600) 批次簽名。
 * 注意：快取（下方 cache）存的是「原始網址」，每次回應才經過這裡，簽名網址不會被快取到過期。
 *
 * 只放行 http(s) 網址；其他（javascript:、data:、空字串）回 null，避免前端拿去當連結開啟。
 */
export async function resolveSketchUrl(
  storedUrl: string,
  // P0 用不到；改成簽名網址時要用 service role client 呼叫 storage
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  supabase: SupabaseAdmin,
): Promise<{ url: string; expiresAt: string | null } | null> {
  const raw = String(storedUrl ?? '').trim()
  if (!/^https?:\/\//i.test(raw)) return null
  return { url: raw, expiresAt: null }
}

// ---------------------------------------------------------------------------
// 查詢與合併
// ---------------------------------------------------------------------------

/** 出單表 rows[] 內本檔用到的鍵（完整型別見 lib/argoerp/dailyOrderSheetShared.ts SheetRow） */
interface SheetRowLite {
  order_number?: string | null
  line_no_input?: string | null
  match_line_no?: string | null
  item_code?: string | null
  item_name?: string | null
  sketch_urls?: string[] | null
  sketch_url?: string | null
}

interface RawImage {
  storedUrl: string
  kind: SketchImage['kind']
  fileName: string
  sheetDate: string
}

interface RawLine {
  lineNo: string | null
  itemCode: string | null
  itemName: string | null
  images: RawImage[]
}

const text = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}

/** 項次正規化成 ERP line_no 的寫法（"01" → "1"）；非純數字原樣保留 */
const normLineNo = (v: unknown): string | null => {
  const s = text(v)
  if (!s) return null
  return /^\d+$/.test(s) ? String(Number(s)) : s
}

/** 出單表列的示意圖網址：新版陣列優先，沒有才退用舊版單張欄位（與出單表頁 getSketchUrls 同規則） */
const rowSketchUrls = (r: SheetRowLite): string[] => {
  if (Array.isArray(r.sketch_urls) && r.sketch_urls.length > 0) return r.sketch_urls.filter(u => typeof u === 'string')
  return r.sketch_url ? [r.sketch_url] : []
}

function describeStoredUrl(storedUrl: string): { kind: SketchImage['kind']; fileName: string } {
  let pathname = storedUrl
  try { pathname = new URL(storedUrl).pathname } catch { /* 非網址就用原字串推檔名 */ }
  const last = pathname.split('/').filter(Boolean).pop() ?? ''
  let fileName = last
  try { fileName = decodeURIComponent(last) } catch { /* 編碼壞掉就用原字串 */ }
  return { kind: /\.pdf$/i.test(fileName) ? 'pdf' : 'image', fileName: fileName || '示意圖' }
}

/** 台北今天往前 n 個日曆天（YYYY-MM-DD） */
function taipeiDaysAgo(n: number): string {
  const d = new Date(`${todayTaipei()}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

const lineSort = (a: RawLine, b: RawLine): number => {
  const na = a.lineNo !== null && /^\d+$/.test(a.lineNo) ? Number(a.lineNo) : Number.POSITIVE_INFINITY
  const nb = b.lineNo !== null && /^\d+$/.test(b.lineNo) ? Number(b.lineNo) : Number.POSITIVE_INFINITY
  if (na !== nb) return na - nb
  return String(a.lineNo ?? a.itemCode ?? '').localeCompare(String(b.lineNo ?? b.itemCode ?? ''))
}

/**
 * 查一張 SO 的示意圖（未經網址轉換的原始結果）。
 *
 * 行號對應：出單表列用 `match_line_no || line_no_input`（match_line_no 是比對 ERP 後的項次，
 * 兩者不一致時以它為準；全表僅 2 列不一致）。兩者都空的列（全表 147 列，多為比對失敗）
 * 改用品號對 erp_so_lines：該 SO 只有一行是這個品號才歸到那行，否則以品號單獨成組（lineNo=null）。
 * erp_so_lines 同時提供品名，並把出單表沒出現的行也列出（images: []），讓彈窗能顯示「無示意圖」。
 */
async function querySketchLines(supabase: SupabaseAdmin, so: string): Promise<RawLine[]> {
  const since = taipeiDaysAgo(SHEET_LOOKBACK_DAYS)
  const [sheetRes, erpRes] = await Promise.all([
    supabase
      .from('daily_order_sheets')
      .select('sheet_date, rows')
      // jsonb 包含查詢要傳 JSON 字串；supabase-js 的 .contains() 傳陣列會組成 Postgres 陣列字面值而報錯
      .filter('rows', 'cs', JSON.stringify([{ order_number: so }]))
      .gte('sheet_date', since)
      .order('sheet_date', { ascending: false })
      .limit(1000),
    supabase
      .from('erp_so_lines')
      .select('line_no, mbp_part, description')
      .eq('project_id', so)
      .limit(1000),
  ])
  if (sheetRes.error) throw sheetRes.error
  if (erpRes.error) throw erpRes.error

  // ERP 行（僅 OPEN/UNSIGNED 的單會在鏡像裡；結案單查不到就只靠出單表）
  const erpLines = (erpRes.data ?? []) as { line_no: string | null; mbp_part: string | null; description: string | null }[]
  const erpByLine = new Map<string, { itemCode: string | null; itemName: string | null }>()
  const erpLinesByPart = new Map<string, string[]>()
  for (const l of erpLines) {
    const ln = normLineNo(l.line_no)
    if (!ln) continue
    const part = text(l.mbp_part)
    erpByLine.set(ln, { itemCode: part, itemName: text(l.description) })
    if (part) erpLinesByPart.set(part, [...(erpLinesByPart.get(part) ?? []), ln])
  }

  const groups = new Map<string, RawLine>()
  const seenUrls = new Map<string, Set<string>>()
  const ensure = (key: string, init: Omit<RawLine, 'images'>): RawLine => {
    let g = groups.get(key)
    if (!g) {
      g = { ...init, images: [] }
      groups.set(key, g)
      seenUrls.set(key, new Set())
    }
    return g
  }

  // 出單表已依 sheet_date 新→舊排序，先遇到的圖就是較新的
  for (const sheet of (sheetRes.data ?? []) as { sheet_date: string; rows: SheetRowLite[] | null }[]) {
    const rows = Array.isArray(sheet.rows) ? sheet.rows : []
    for (const r of rows) {
      if (text(r.order_number)?.toUpperCase() !== so) continue
      const itemCode = text(r.item_code)
      let lineNo = normLineNo(r.match_line_no) ?? normLineNo(r.line_no_input)
      if (!lineNo && itemCode) {
        const cands = erpLinesByPart.get(itemCode) ?? []
        if (cands.length === 1) lineNo = cands[0]
      }
      const key = lineNo ? `L:${lineNo}` : itemCode ? `I:${itemCode}` : 'U:'
      const erp = lineNo ? erpByLine.get(lineNo) : undefined
      const g = ensure(key, {
        lineNo,
        // 品號／品名以 ERP 為準（彈窗顯示的是 ERP 行），ERP 沒有才用出單表的
        itemCode: erp?.itemCode ?? itemCode,
        itemName: erp?.itemName ?? text(r.item_name),
      })
      const seen = seenUrls.get(key)!
      for (const u of rowSketchUrls(r)) {
        const storedUrl = String(u).trim()
        if (!storedUrl || seen.has(storedUrl)) continue
        seen.add(storedUrl)
        g.images.push({ storedUrl, ...describeStoredUrl(storedUrl), sheetDate: sheet.sheet_date })
      }
    }
  }

  // 出單表沒出現的 ERP 行也列出（無圖）
  for (const [ln, erp] of erpByLine) ensure(`L:${ln}`, { lineNo: ln, itemCode: erp.itemCode, itemName: erp.itemName })

  // 對不到項次、也沒有圖的列（多為出單表比對失敗的空列）沒有顯示價值，略過
  return [...groups.values()].filter(g => g.lineNo !== null || g.images.length > 0).sort(lineSort)
}

// 模組層記憶體快取（每個 serverless 實例各一份）：同一張 SO 在 TTL 內重複開彈窗不再查庫；
// 存 Promise 讓同時進來的相同請求共用一次查詢。只存原始網址，回應前才經 resolveSketchUrl。
const cache = new Map<string, { at: number; promise: Promise<RawLine[]> }>()

function getSketchLinesCached(supabase: SupabaseAdmin, so: string, fresh: boolean): Promise<RawLine[]> {
  const now = Date.now()
  const hit = cache.get(so)
  if (!fresh && hit && now - hit.at < CACHE_TTL_MS) return hit.promise

  const promise = querySketchLines(supabase, so)
  cache.set(so, { at: now, promise })
  // 查詢失敗不留在快取，下一次重試
  promise.catch(() => { if (cache.get(so)?.promise === promise) cache.delete(so) })
  // 超過上限時淘汰最舊的（Map 依插入順序）
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return promise
}

/** 把原始網址逐張轉成可顯示網址；轉不出來（非 http、之後簽名失敗）的圖略過 */
async function resolveSketchImages(supabase: SupabaseAdmin, images: RawImage[]): Promise<SketchImage[]> {
  const resolved = await Promise.all(images.map(img => resolveSketchUrl(img.storedUrl, supabase)))
  const out: SketchImage[] = []
  images.forEach((img, i) => {
    const r = resolved[i]
    if (r) out.push({ url: r.url, kind: img.kind, fileName: img.fileName, expiresAt: r.expiresAt, sheetDate: img.sheetDate })
  })
  return out
}

/** 取得一張 SO 各品項行的示意圖（已轉成可顯示網址）。so 須先經 normalizeSoParam() */
export async function getSoSketches(
  supabase: SupabaseAdmin,
  so: string,
  opts: { fresh?: boolean } = {},
): Promise<SketchLine[]> {
  const raw = await getSketchLinesCached(supabase, so, Boolean(opts.fresh))
  return Promise.all(raw.map(async l => ({
    lineNo: l.lineNo,
    itemCode: l.itemCode,
    itemName: l.itemName,
    images: await resolveSketchImages(supabase, l.images),
  })))
}
