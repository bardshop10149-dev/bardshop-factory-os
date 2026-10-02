// SARA 工序工時的計算基準——個數 × 單位時間，或盤數 × 單位時間。
//
// 為什麼要有這個檔：這段規則原本有四份複製（lib/sara/autoProcessGen.ts、
// lib/sara/clientRowGen.ts、app/admin/sara/process-gen/sheetRows.ts，以及
// process-gen 頁面內的兩處），四份都用同一個硬寫的猜測：「盤數有填就用盤數，
// 沒填就用個數」，完全沒讀 route_operations.qty_mode。
//
// 2026-08-24 其實已經加了 qty_mode 欄位（個數/盤數）與維護介面，當時的計畫是
// 「生管填完設定後，產生邏輯改讀這個欄位」（見 sql/20260824_route_operations_qty_mode.sql）。
// 第三步一直沒做，所以那個開關是唯寫的——生管在頁面上切換，對送出去的工時毫無影響。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ 為什麼補好了還不能直接打開：設定本身目前是錯的
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-02 用全部出單表資料模擬過兩種規則，結果跟直覺相反：
//
//   情況                                      工序數    舊規則     依設定
//   設定個數＋有盤數（舊用盤數→依設定會改用個數）   1,981   6,332 時  108,144 時
//   設定盤數＋有盤數（兩者都用盤數）              1,671   3,863 時    3,863 時
//   設定盤數＋沒填盤數（舊用個數→依設定會擋下）        68     581 時        0 時
//   設定個數＋沒填盤數（兩者都用個數）               276   1,272 時    1,272 時
//
// 也就是說：照設定算會讓印刷工時從 6,332 小時變成 108,144 小時，暴增 17 倍。
// 全部來自 1,981 道「設定寫個數、但實際有盤數」的工序——幾乎都是 3mm 壓克力。
//
// 而 3mm 的設定極可能是漏設而不是刻意：qty_mode 的預設值就是「個數」，生管只切了
// 150/631 筆；同品類的其他厚度（2mm 壓克力片、2mm 壓克力畫板）全部是盤數，只有
// 3mm 停在預設值，而 3mm+1mm 貼合又是盤數。所以現在這個「錯的」硬寫規則，
// 反而比「對的」設定更接近現實。
//
// 結論：先用 legacy 規則維持現狀，等生管把 3mm 補完，再把開關切到 route-qty-mode。
// 開關放在 app_settings（見 EST_BASIS_MODE_KEY），不必改程式就能切換與回復。
//
// ─────────────────────────────────────────────────────────────────────────────
// 盤數該填卻沒填時：一律以 1 盤計算，但非集單要標成異常
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-02 生管決定的處理方式：
//   集單   —— 本來就免填盤數，以 1 盤計算，正常情況，不標異常
//   非集單 —— 也以 1 盤計算（還是要送出去），但標成異常，請生管補正確盤數
//
// 為什麼不是「算不出來就整列不送」：不送的話塔台根本不知道有這張單，比送一個偏小的
// 數字更糟。以 1 盤計算會低估工時，但低估只是排得緊，高估（退回用個數）則會把一條線
// 整天塞滿——2026-09-30 稽核時就有一道 UV 印刷因為退回個數被排成 95 小時。
// 低估＋標異常是兩害相權的選擇：單子照樣進得去塔台，而且有明確的待辦把它改對。
//
// 關鍵是異常一定要看得見。上一版「缺盤數默默退回個數」真正的問題不是算錯，
// 而是算錯了沒有任何痕跡。所以代入 1 盤時一律回報 assumedPan，非集單再加 anomaly，
// 讓出單總表標得出來、產生工序的頁面講得出來。
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js'

/** route_operations.qty_mode 的值；欄位有 NOT NULL DEFAULT '個數' */
export type QtyMode = '個數' | '盤數'

export function normalizeQtyMode(v: unknown): QtyMode {
  return String(v ?? '').trim() === '盤數' ? '盤數' : '個數'
}

/**
 * 工時基準的取法。
 *
 * - `legacy-pan-first`：盤數有填就用盤數，沒填退回個數。完全不看 qty_mode。
 *   這是 2026-10-02 之前唯一存在的行為，也是目前的預設——因為 3mm 的設定還沒補完。
 * - `route-qty-mode`：依 route_operations.qty_mode 決定；設定盤數卻沒填盤數就擋下。
 *   等生管把設定補齊後才切到這個。
 */
export type EstBasisMode = 'legacy-pan-first' | 'route-qty-mode'

export const EST_BASIS_MODE_KEY = 'sara_est_basis_mode'
export const DEFAULT_EST_BASIS_MODE: EstBasisMode = 'legacy-pan-first'

export function normalizeEstBasisMode(v: unknown): EstBasisMode {
  return String(v ?? '').trim() === 'route-qty-mode' ? 'route-qty-mode' : DEFAULT_EST_BASIS_MODE
}

/**
 * 讀取目前要用哪種基準。讀失敗一律回 legacy——維持現狀比冒險套用新規則安全，
 * 而且新規則在設定補完前會把工時放大 17 倍（見檔頭）。
 */
export async function loadEstBasisMode(sb: SupabaseClient): Promise<EstBasisMode> {
  try {
    const { data } = await sb.from('app_settings').select('value').eq('key', EST_BASIS_MODE_KEY).maybeSingle()
    return normalizeEstBasisMode(data?.value)
  } catch {
    return DEFAULT_EST_BASIS_MODE
  }
}

// 站別特例。這兩條與 qty_mode 無關，是站別本身的性質：
//   包裝站——包裝是逐個包的，一律用個數
//   轉運站——只是站間搬運，固定算一次
// 2026-10-02 確認資料庫裡沒有任何包裝站/轉運站工序被設成盤數，所以這兩條特例
// 目前不會跟 qty_mode 衝突。日後若真要讓包裝站按盤數算，要先改這裡。
export const isPackagingStation = (s: string) => s.includes('包裝站')
export const isTransitStation = (s: string) => s.includes('轉運')
export const isPrintStation2F6F = (s: string) => s === '印刷站2F' || s === '印刷站6F'

/** 盤數沒填時代入的盤數（2026-10-02 生管指定；集單與非集單都一樣，差別只在要不要標異常） */
export const DEFAULT_PAN_WHEN_BLANK = 1

export interface EffQtyInput {
  station: string
  /** 該途程該道工序的設定基準（route_operations.qty_mode） */
  qtyMode: QtyMode
  /** 生產數量（個數） */
  quantity: number
  /** 盤數 */
  panCount: number
  /** 省略時用 legacy，維持 2026-10-02 之前的行為 */
  mode?: EstBasisMode
  /**
   * 這一列是不是集單（doc_type 含「集單」）。
   *
   * 只影響「缺盤數算不算異常」，不影響代入的數字——兩者都代入 1 盤。
   * 集單本來就免填（多張小單併成一盤下去跑），非集單缺盤數則是該補的資料。
   */
  isGroupOrder?: boolean
}

/**
 * 工時基準的計算結果。一定算得出來——缺盤數不再擋下整列，而是代入 1 盤並標記。
 */
export interface EffQtyResult {
  /** 要乘上單位時間的數量 */
  effQty: number
  /** 用的是哪個基準 */
  basis: '固定1' | '個數' | '盤數'
  /** true＝盤數沒填，effQty 是代入的 1 盤，不是出單表上真的有這個數字 */
  assumedPan?: true
  /** true＝代入了 1 盤而且這不是集單，屬於該補的資料，要標成異常 */
  anomaly?: true
}

/**
 * 決定這道工序要用哪個數量當計算基準。
 *
 * 回傳的 assumedPan / anomaly 一定要往上傳到畫面——代入預設值本身沒問題，
 * 沒留痕跡才是問題（見檔頭）。
 */
export function resolveEffQty(input: EffQtyInput): EffQtyResult {
  const { station, qtyMode, quantity, panCount, mode = DEFAULT_EST_BASIS_MODE, isGroupOrder = false } = input
  if (isTransitStation(station)) return { effQty: 1, basis: '固定1' }
  if (isPackagingStation(station)) return { effQty: quantity, basis: '個數' }

  if (mode === 'legacy-pan-first') {
    return panCount > 0
      ? { effQty: panCount, basis: '盤數' }
      : { effQty: quantity, basis: '個數' }
  }

  if (qtyMode === '盤數') {
    if (!(panCount > 0)) {
      // 缺盤數一律代 1 盤，不退回個數（個數會把工時放大一個量級），也不擋下整列
      // （不送比送偏小的數字更糟，塔台會完全不知道有這張單）。
      // 集單是正常情況；非集單則是該補的資料，加上 anomaly 讓它進異常清單。
      return isGroupOrder
        ? { effQty: DEFAULT_PAN_WHEN_BLANK, basis: '盤數', assumedPan: true }
        : { effQty: DEFAULT_PAN_WHEN_BLANK, basis: '盤數', assumedPan: true, anomaly: true }
    }
    return { effQty: panCount, basis: '盤數' }
  }
  return { effQty: quantity, basis: '個數' }
}

/**
 * 工時 = 單位時間 × 基準數量，不足 10 分鐘補到 10 分鐘。
 * 單位時間為 0（工時表沒填）時回 0，維持原本行為——那是主檔缺資料，不是這裡的事。
 */
export function estTimeFrom(std: number, effQty: number): number {
  if (std === 0) return 0
  return Math.max(10, Math.round(std * effQty * 10) / 10)
}
