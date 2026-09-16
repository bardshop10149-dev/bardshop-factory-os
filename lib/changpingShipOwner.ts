import { NextResponse } from 'next/server'
import { guardAuth } from './requireAuth'

/**
 * 常平訂單資料區 — 守門（Snow 2026-09-16 改版）。
 *
 * 用權限鍵 `changping_ship` 開放，在後台「團隊管理」勾選；目前只勾給 Snow（工號 10011）一個人。
 * 跟一般功能的差別：**管理員不會自動通過**——guardPermission 會讓 is_admin 直接放行，
 * 這區要的是「勾了才看得到」，所以直接看 permissions 陣列，不看 is_admin。
 * （2026-09-14 那版是寫死 email 白名單，改成權限鍵後要換人不用改程式、不用改環境變數。）
 */
export const CHANGPING_SHIP_PERMISSION = 'changping_ship'

export function isChangpingShipOwner(permissions: string[] | null | undefined): boolean {
  return Array.isArray(permissions) && permissions.includes(CHANGPING_SHIP_PERMISSION)
}

/** 需在後台被勾「常平訂單資料區」；沒勾一律 404（不洩漏此功能存在，管理員也一樣）。 */
export async function guardChangpingShipOwner() {
  const g = await guardAuth()
  if (!g.ok) return g
  if (!isChangpingShipOwner(g.member.permissions)) {
    return { ok: false as const, res: NextResponse.json({ error: '找不到此頁面' }, { status: 404 }) }
  }
  return g
}
