/**
 * CSV 工具（全站單一實作）
 *
 * 2026-09 結構健檢時，同一件事在 20 個檔案各寫了一份、共 4 個函式名、3 種不同的引號規則。
 * 這裡收成一份；兩種引號模式都保留，讓既有頁面遷移時輸出位元組完全不變：
 *
 *   - 'auto'（預設）：只在必要時加引號——含逗號、雙引號、CR、LF 才包。
 *                     符合 RFC 4180；舊的 escCsv / 各頁 inline 判斷屬此類。
 *   - 'always'：一律加引號。舊的 toCsvCell / 多數 `"${String(v).replace(...)}"` inline 屬此類。
 *
 * 第二個參數若不是合法模式字串（例如被 Array.prototype.map 當 callback 時傳進 index），
 * 一律視為 'auto'——所以 `.map(csvCell)` 這種寫法是安全的。
 *
 * 純函式、不碰 DOM；只有 downloadCsv 會用到 document/URL，且只在被呼叫時執行，
 * 因此 server 端 route 檔也能安全 import 本模組（只要不呼叫 downloadCsv）。
 */

export type CsvQuoteMode = 'auto' | 'always'

/** 需要加引號的字元：逗號、雙引號、CR、LF（RFC 4180） */
const NEEDS_QUOTE = /[,"\r\n]/

/** 單一儲存格 → CSV 字串。null/undefined 一律視為空字串（不會變成 "null" 字樣）。 */
export function csvCell(v: unknown, mode?: CsvQuoteMode | unknown): string {
  const s = String(v ?? '')
  const escaped = s.replace(/"/g, '""')
  if (mode === 'always') return `"${escaped}"`
  return NEEDS_QUOTE.test(s) ? `"${escaped}"` : s
}

/** 一律加引號版本（單參數，可直接丟給 .map） */
export function csvCellQuoted(v: unknown): string {
  return csvCell(v, 'always')
}

/** 一列儲存格 → 一行 CSV */
export function csvLine(cells: readonly unknown[], mode: CsvQuoteMode = 'auto'): string {
  return cells.map((c) => csvCell(c, mode)).join(',')
}

/**
 * 組完整 CSV 文字。
 * @param newline 既有頁面兩種都有人用：'\n'（多數）與 '\r\n'（ERP 同步區匯出）；預設 '\n'。
 */
export function buildCsv(
  headers: readonly unknown[],
  rows: readonly (readonly unknown[])[],
  opts: { mode?: CsvQuoteMode; newline?: '\n' | '\r\n' } = {},
): string {
  const { mode = 'auto', newline = '\n' } = opts
  return [csvLine(headers, mode), ...rows.map((r) => csvLine(r, mode))].join(newline)
}

/** UTF-8 BOM：讓 Excel 直接開 CSV 時正確辨識中文（全站 16 處各自寫 '\uFEFF'，收成一處） */
export const CSV_BOM = '\uFEFF'

/**
 * 瀏覽器端下載 CSV（含 BOM）。僅限 client component 呼叫。
 * 沿用出單表原本的 downloadCsv 簽名（一律加引號），既有呼叫端零改動。
 */
export function downloadCsv(
  fileName: string,
  headers: readonly unknown[],
  rows: readonly (readonly unknown[])[],
  opts: { mode?: CsvQuoteMode; newline?: '\n' | '\r\n' } = {},
): void {
  const { mode = 'always', newline = '\n' } = opts
  downloadTextFile(fileName, CSV_BOM + buildCsv(headers, rows, { mode, newline }), 'text/csv;charset=utf-8;')
}

/** 瀏覽器端把一段文字存成檔案（Blob → 暫時 URL → 點擊 → 釋放）。 */
export function downloadTextFile(fileName: string, content: string, mimeType = 'text/plain;charset=utf-8;'): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
