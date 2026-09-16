/**
 * 數字欄的 IME 正規化（設計書 §12.6「數字輸入」、§12.12 注音 IME 提醒）。
 *
 * 時機：只在 `compositionend` 與 `blur` 跑；composing 期間不驗證、不格式化，
 * 否則 Windows 注音打到一半的字會被吃掉。
 *
 * 做的事：全形數字／小數點／逗號／乘號→半形、剝單位（cm/mm/pcs/個/片）、
 * 「5x5」「5×5 cm」拆成 W/H、尺寸取 1 位小數、數量取整。
 */

/** 全形→半形（數字、標點、字母、空白） */
export function toHalfWidth(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0)
    else if (ch === '。' || ch === '．') out += '.'
    else if (ch === '，') out += ','
    else out += ch
  }
  return out
}

const UNIT_RE = /\s*(cm|mm|pcs|pc|個|个|片|版|件|公分|公釐)\s*$/i

/** 剝掉尾端單位與千分位逗號 */
export function stripUnits(s: string): string {
  return toHalfWidth(s).trim().replace(UNIT_RE, '').replace(/,/g, '').trim()
}

/** 解析小數（尺寸用）；解析不出回 null */
export function parseDecimal(raw: string): number | null {
  const s = stripUnits(raw)
  if (s === '') return null
  if (!/^-?\d*(?:\.\d*)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 解析整數（數量、版數用）；小數會四捨五入 */
export function parseInteger(raw: string): number | null {
  const n = parseDecimal(raw)
  if (n === null) return null
  return Math.round(n)
}

/** 「5x5」「5×5 cm」「5*5」「5X5」→ { w, h }；不是尺寸對就回 null */
export function parseSizePair(raw: string): { w: number; h: number } | null {
  const s = toHalfWidth(raw).trim().replace(UNIT_RE, '')
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:x|X|×|\*)\s*(\d+(?:\.\d+)?)\s*$/.exec(s)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null
  return { w, h }
}

/** 尺寸顯示值：1 位小數，去掉多餘 .0 */
export function formatDimValue(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/** 數量顯示值：整數千分位 */
export function formatQtyValue(n: number): string {
  return Math.round(n).toLocaleString('zh-TW')
}

/** 正規化尺寸欄文字：解析得到就格式化，否則原樣（讓錯誤留在原地給使用者看） */
export function normalizeDimText(raw: string): string {
  const n = parseDecimal(raw)
  return n === null ? toHalfWidth(raw).trim() : formatDimValue(n)
}

/** 正規化數量欄文字 */
export function normalizeQtyText(raw: string): string {
  const n = parseInteger(raw)
  return n === null ? toHalfWidth(raw).trim() : formatQtyValue(n)
}
