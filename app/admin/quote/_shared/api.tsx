'use client'

/**
 * 報價系統後台三頁共用：fetch 包裝 + 回應拆封 + 格式化小工具。
 *
 * 所有 /api/quote/admin/* 一律回 `{ success:true, ... }` 或 `{ success:false, error }`；
 * 資料表尚未建立時回 503。這裡把三種情況統一成 AdminFetchResult，頁面只要 early-return。
 */

export const NOT_READY_MSG =
  '報價系統資料表尚未建立，請先執行 sql/20260913_quote_system.sql（到 Supabase SQL Editor 跑一次即可）'

export type AdminFetchResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; notReady: boolean; status: number }

export async function adminFetch<T = Record<string, unknown>>(
  url: string,
  opts?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown },
): Promise<AdminFetchResult<T>> {
  let res: Response
  try {
    res = await fetch(url, {
      method: opts?.method ?? 'GET',
      cache: 'no-store',
      headers: opts?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch (e) {
    return { ok: false, error: `連線失敗：${e instanceof Error ? e.message : String(e)}`, notReady: false, status: 0 }
  }
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const errText = j && typeof j.error === 'string' && j.error ? j.error : ''
  if (res.status === 503) return { ok: false, error: errText || NOT_READY_MSG, notReady: true, status: 503 }
  if (!res.ok || !j || j.success !== true) {
    return { ok: false, error: errText || `HTTP ${res.status}`, notReady: false, status: res.status }
  }
  return { ok: true, data: j as unknown as T, status: res.status }
}

/** 從回應物件依候選鍵名取第一個「是陣列」的欄位（route 的包裝鍵名不在契約內，這裡保守拆封） */
export function pickArray<T>(obj: unknown, keys: string[]): T[] {
  if (!obj || typeof obj !== 'object') return []
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (Array.isArray(v)) return v as T[]
  }
  return []
}

/** 從回應物件依候選鍵名取第一個「是物件」的欄位 */
export function pickObject<T>(obj: unknown, keys: string[]): T | null {
  if (!obj || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as T
  }
  return null
}

/* ---------------------------------------------------------------- 格式化 */

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function fmtNum(n: number | null | undefined, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: digits })
}

/** 誤差比例（0.0042 → 0.42%）。契約的 tolerance 用 0.01 表 1%，同一口徑。 */
export function fmtPct(frac: number | null | undefined, digits = 2): string {
  if (frac == null || !Number.isFinite(frac)) return '—'
  return `${(frac * 100).toFixed(digits)}%`
}

export function todayISO(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 深比較（JSON 序列化版，表單資料夠用） */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
