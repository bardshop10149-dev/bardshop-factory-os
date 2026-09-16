import type { CatalogPriceItem, CatalogProduct, FxInfo } from '@/lib/quote/api'
import type { PrintMethod } from '@/lib/quote/types'
import { fmtDate, fmtInt, fmtNt, fmtSize, fmtValidUntil } from './format'

/** 印刷方式顯示文案（設計書 §1 用語對照） */
export const METHOD_LABEL: Record<PrintMethod, string> = {
  '7151': '仿柯 7151',
  jingutian: '仿柯 百川',
  koshi: '柯式',
  none: '無印刷',
}

/** 單款尺寸（MVP 單款；型別依 §12.6 預留多款） */
export interface SizeState {
  id: string
  w: string
  h: string
  qty: string
}

export interface OverrideState {
  value: number
  autoValue: number
  key: string
}

export interface RetiredOverride {
  value: number
  /** 剛退役 2 秒內為 true（顯示「已依新板材重算」），之後改顯示「上次手動 · 套回」 */
  recent: boolean
}

export type FieldKey = 'product' | 'w' | 'h' | 'qty' | 'board' | 'versions'

export interface FieldError {
  field: FieldKey
  /** 狀態列的短標（「數量」） */
  label: string
  /** 欄位下的「※ …」 */
  message: string
}

export function priceMap(items: CatalogPriceItem[]): Map<string, CatalogPriceItem> {
  const m = new Map<string, CatalogPriceItem>()
  for (const it of items) m.set(it.name, it)
  return m
}

/** 顯示名：display_name ?? name（catalog 已合併成 displayName，這裡只補空值） */
export function displayNameOf(name: string, prices: Map<string, CatalogPriceItem>): string {
  const it = prices.get(name)
  return it?.displayName?.trim() ? it.displayName : name
}

export interface SummaryInput {
  quoteNo: string
  createdAt: Date
  product: CatalogProduct
  w: number
  h: number
  thicknessMm: number | null
  /** 貼合款：整段板材描述（「2 貼 2，1.8 + 1.8 mm」），有給就取代厚度 */
  boardText?: string
  qty: number
  quoteUnit: number
  twdUnit: number | null
  total: number
  sides: 1 | 2
  method: PrintMethod
  versions: number
  accessories: { name: string; k: number }[]
  packing: string[]
  /** 業務模式伺服器不回每盤資訊，摘要就不寫這行 */
  perSheetUsed?: number
  perSheetAuto?: number
  overridden: boolean
  validityDays: number
  userName: string
  rateVersion: string
  fx: FxInfo | null
}

/** 可貼 LINE 的文字摘要（§12.6 主按鈕＋摘要） */
export function buildSummaryText(s: SummaryInput): string {
  const lines: string[] = []
  lines.push('【啟盛國際 報價】')
  lines.push(`日期：${fmtDate(s.createdAt)}`)
  lines.push(`報價編號：${s.quoteNo}`)
  lines.push(`品項：${s.product.name}`)
  const thick = s.boardText ? `（${s.boardText}）` : s.thicknessMm !== null ? `（${s.thicknessMm} mm）` : ''
  const twd = s.twdUnit !== null ? `（≈ ${fmtNt(s.twdUnit)}）` : ''
  lines.push(`款 1：${fmtSize(s.w, s.h)}${thick} ${fmtInt(s.qty)} pcs　單價 RMB ${s.quoteUnit.toFixed(2)}${twd}`)
  const sidesText = s.sides === 2 ? '雙面' : '單面'
  const methodText =
    s.method === 'none'
      ? METHOD_LABEL.none
      : s.method === 'koshi'
        ? `${sidesText} ${METHOD_LABEL.koshi} ${s.versions} 版`
        : `${sidesText} ${METHOD_LABEL[s.method]}`
  lines.push(`印刷：${methodText}`)
  lines.push(`配件：${s.accessories.length ? s.accessories.map((a) => `${a.name} ×${a.k}`).join('、') : '無'}`)
  lines.push(`包裝：${s.packing.length ? s.packing.join('、') : '無'}`)
  if (s.perSheetUsed != null) {
    lines.push(
      `每盤數量 ${fmtInt(s.perSheetUsed)}${s.overridden && s.perSheetAuto != null ? `（手動覆寫，自動值 ${fmtInt(s.perSheetAuto)}）` : ''}`,
    )
  }
  lines.push(`本單合計：RMB ${fmtInt(s.total)}`)
  lines.push(`有效期：至 ${fmtValidUntil(s.validityDays, s.createdAt)}`)
  lines.push(`業務：${s.userName || '—'}`)
  const fxText = s.fx ? ` · 匯率 ${s.fx.rate}（${s.fx.asOf}）` : ' · 匯率未設定'
  lines.push(`費率版本 ${s.rateVersion}${fxText}`)
  return lines.join('\n')
}

/** 讀 localStorage（全部 try/catch；私密視窗、被封鎖時視為沒有） */
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 忽略：儲存失敗不影響功能 */
  }
}
