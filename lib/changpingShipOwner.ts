import { NextResponse } from 'next/server'
import { guardAuth } from './requireAuth'

/**
 * 常平訂單資料區 — 單一擁有者守門(Snow 2026-09-14)。
 *
 * 與其他功能不同:這區**不是**用權限鍵開放,而是白名單 email 限定,
 * 連其他管理員也看不到(guardPermission 會讓 is_admin 自動通過,不符需求)。
 * 名單走環境變數 CHANGPING_SHIP_OWNERS(逗號分隔),未設時退回 Snow 的帳號。
 */
const DEFAULT_OWNERS = ['s9323162@gmail.com']

export function changpingShipOwners(): string[] {
  const raw = process.env.CHANGPING_SHIP_OWNERS ?? ''
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return list.length > 0 ? list : DEFAULT_OWNERS
}

export function isChangpingShipOwner(email: string | null | undefined): boolean {
  return changpingShipOwners().includes(String(email ?? '').trim().toLowerCase())
}

/** 需為常平訂單資料區擁有者;非擁有者一律 404(不洩漏此功能存在)。 */
export async function guardChangpingShipOwner() {
  const g = await guardAuth()
  if (!g.ok) return g
  if (!isChangpingShipOwner(g.member.email)) {
    return { ok: false as const, res: NextResponse.json({ error: '找不到此頁面' }, { status: 404 }) }
  }
  return g
}
