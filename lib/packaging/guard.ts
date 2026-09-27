// 包裝專區 API 守門（規格 §四；D30）
//
// read ：packaging（唯讀）或 packaging_admin（主管編輯）
// write：packaging_admin
// admin 一律通過。身分與權限一律以 DB members 為準（guardAuth 驗 httpOnly token），不信任前端 cookie。
//
// 另外提供寫入 API 共用的兩個小工具：
// - requireJson：只收 Content-Type: application/json。瀏覽器跨站 <form> 只能送 urlencoded／multipart／text/plain
//   這三種「簡單請求」，JSON 必定觸發 CORS 預檢而被擋——cookie 驗證的 API 用這招擋 CSRF。
// - noStore：所有回應 Cache-Control: no-store（排程資料是即時狀態，瀏覽器／CDN 都不可快取）。

import { NextResponse, type NextRequest } from 'next/server'
import { guardAuth, type AuthedMember } from '@/lib/requireAuth'

export const PACKAGING_READ_PERMISSIONS = ['packaging', 'packaging_admin'] as const
export const PACKAGING_WRITE_PERMISSION = 'packaging_admin'

export type PackagingGuard =
  | { ok: true; member: AuthedMember; canEdit: boolean }
  | { ok: false; res: NextResponse }

export const NO_STORE = { 'Cache-Control': 'no-store' } as const

/** JSON 回應＋no-store */
export function noStore<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

export function canEditPackaging(m: AuthedMember): boolean {
  return m.isAdmin || m.permissions.includes(PACKAGING_WRITE_PERMISSION)
}

export async function guardPackaging(level: 'read' | 'write'): Promise<PackagingGuard> {
  const g = await guardAuth()
  if (!g.ok) return g
  const m = g.member
  const canEdit = canEditPackaging(m)
  if (level === 'write') {
    if (!canEdit) return { ok: false, res: noStore({ success: false, error: '需要權限：包裝主管（packaging_admin）', code: 'forbidden' }, 403) }
    return { ok: true, member: m, canEdit }
  }
  if (!m.isAdmin && !PACKAGING_READ_PERMISSIONS.some((p) => m.permissions.includes(p))) {
    return { ok: false, res: noStore({ success: false, error: '需要權限：包裝專區（packaging）', code: 'forbidden' }, 403) }
  }
  return { ok: true, member: m, canEdit }
}

/** 寫入 API：Content-Type 必須是 application/json，否則 415 */
export function requireJson(request: NextRequest): NextResponse | null {
  const ct = (request.headers.get('content-type') ?? '').toLowerCase()
  if (ct.split(';')[0].trim() === 'application/json') return null
  return noStore({ success: false, error: 'Content-Type 必須是 application/json', code: 'bad_request' }, 415)
}

/** 讀 JSON body；解析失敗回 null */
export async function readJson(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await request.json()
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null
  } catch {
    return null
  }
}
