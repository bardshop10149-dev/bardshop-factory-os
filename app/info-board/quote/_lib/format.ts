/**
 * 報價計算機的顯示格式（設計書 §12.4 混排規則）。
 *
 * 幣別規則：
 *   - 報價大數字前用「RMB」全稱（呼叫端自己排），其餘人民幣用「¥」。
 *   - 台幣「NT$」，一律整數元（Math.round）。
 *   - 千分位一律 toLocaleString('zh-TW')。
 *   - 無法計算顯示「—」，永遠不顯示 0。
 */

const ZH = 'zh-TW'

/** 千分位整數 */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString(ZH)
}

/** 固定小數位（千分位） */
export function fmtFixed(n: number, digits: number): string {
  return n.toLocaleString(ZH, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** 人民幣：¥ + 千分位；digits 預設 2 */
export function fmtYen(n: number, digits = 2): string {
  return `¥${fmtFixed(n, digits)}`
}

/** 台幣：NT$ + 整數元 */
export function fmtNt(n: number): string {
  return `NT$ ${fmtInt(n)}`
}

/** 報價大數字拆成整數／小數兩段（收據金額感：整數 40px、小數 24px） */
export function splitMoney(n: number): { int: string; dec: string } {
  const s = fmtFixed(n, 2)
  const i = s.lastIndexOf('.')
  return { int: i >= 0 ? s.slice(0, i) : s, dec: i >= 0 ? s.slice(i) : '.00' }
}

/** 尺寸：最多 1 位小數，去掉多餘的 .0（5 → 「5」、10.2 → 「10.2」） */
export function fmtDim(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString(ZH, { maximumFractionDigits: 1 })
}

/** 「W × H cm」，乘號用 U+00D7、數字與單位間半形空格 */
export function fmtSize(w: number, h: number): string {
  return `${fmtDim(w)} × ${fmtDim(h)} cm`
}

/** YYYY-MM-DD（本地時區） */
export function fmtDate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** MM/DD（徽章用） */
export function fmtMonthDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}` : iso
}

/** HH:mm */
export function fmtTime(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 有效期：今天 + N 天 */
export function fmtValidUntil(days: number, from: Date = new Date()): string {
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  return fmtDate(d)
}

/** 板材標籤：從價格表名稱「亚克力板【挤压型】 [300mm * 400mm * 2.8]」抽出「300×400×2.8」 */
export function boardShortLabel(name: string, fallback?: string): string {
  const m = /\[\s*(\d+(?:\.\d+)?)\s*mm?\s*\*\s*(\d+(?:\.\d+)?)\s*mm?\s*\*\s*(\d+(?:\.\d+)?)\s*\]/.exec(name)
  if (m) return `${m[1]}×${m[2]}×${m[3]}`
  return fallback ?? name
}

/** 板材厚度（mm）：優先 attrs.thickness_mm，否則從名稱抽 */
export function boardThickness(name: string, attrs: Record<string, unknown> | null): number | null {
  const a = attrs?.thickness_mm
  if (typeof a === 'number' && Number.isFinite(a)) return a
  const m = /\*\s*(\d+(?:\.\d+)?)\s*\]/.exec(name)
  return m ? Number(m[1]) : null
}

/** 板材套版可用範圍（cm）：attrs.layout_w_cm / layout_h_cm（相容 layoutWcm 寫法） */
export function boardLayout(attrs: Record<string, unknown> | null): { w: number; h: number } | null {
  if (!attrs) return null
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = attrs[k]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    }
    return null
  }
  const w = pick('layout_w_cm', 'layoutWcm', 'layout_w')
  const h = pick('layout_h_cm', 'layoutHcm', 'layout_h')
  return w && h ? { w, h } : null
}

/** 單件放不放得進板材（正放或旋轉；單件不受拼板間距影響） */
export function fitsBoard(w: number, h: number, layout: { w: number; h: number } | null): boolean | null {
  if (!layout) return null
  return (w <= layout.w && h <= layout.h) || (h <= layout.w && w <= layout.h)
}
