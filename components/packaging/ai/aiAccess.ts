'use client'

// 包裝 AI 模擬排程（P3）的「前端權限自查」：入口卡、/packaging/ai 頁面、正式工作台的「AI 採用紀錄」按鈕共用。
//
// 為什麼不直接 import lib/packaging/guard.ts 的 canUseAi：guard.ts 會帶進 next/server 與 requireAuth（伺服器專用），
// 前端 bundle 不能引用。這裡照同一條規則重寫一份（D89／D90）：
//   admin，或「有 packaging_ai」且「能編輯包裝排程（packaging_admin）」
// 前端自查只是體驗（決定按鈕／入口顯示與否），真正的守門在 /api/packaging/ai/** 的 guardPackagingAi()。

import { useEffect, useState } from 'react'

/** 同 lib/packaging/guard.ts PACKAGING_AI_PERMISSION（不能 import，理由見檔頭） */
export const AI_PERMISSION_KEY = 'packaging_ai'

export interface AiAccessInput {
  isAdmin: boolean
  permissions: readonly string[]
}

/** 同 guard.ts canUseAi（D89／D90） */
export function canUseAiFrom(a: AiAccessInput): boolean {
  if (a.isAdmin) return true
  return a.permissions.includes(AI_PERMISSION_KEY) && a.permissions.includes('packaging_admin')
}

export interface AiAccessState {
  status: 'checking' | 'ready' | 'unauthorized' | 'error'
  isAdmin: boolean
  permissions: string[]
  email: string | null
  name: string | null
  canUseAi: boolean
  /** 能進包裝專區（packaging／packaging_admin／admin） */
  canViewPackaging: boolean
}

const INITIAL: AiAccessState = {
  status: 'checking', isAdmin: false, permissions: [], email: null, name: null, canUseAi: false, canViewPackaging: false,
}

/**
 * 問一次 /api/auth/me（後端以 DB members 為準回傳自己的權限）。
 * enabled＝false 時不問（例：工作台已判定沒有包裝權限）。
 */
export function useAiAccess(enabled = true): AiAccessState {
  const [state, setState] = useState<AiAccessState>(INITIAL)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' })
        if (!alive) return
        if (res.status === 401) { setState({ ...INITIAL, status: 'unauthorized' }); return }
        if (!res.ok) { setState({ ...INITIAL, status: 'error' }); return }
        const me = await res.json() as { is_admin?: boolean; permissions?: unknown; email?: string; real_name?: string | null }
        if (!alive) return
        const permissions = Array.isArray(me.permissions) ? me.permissions.filter((p): p is string => typeof p === 'string') : []
        const isAdmin = Boolean(me.is_admin)
        setState({
          status: 'ready',
          isAdmin,
          permissions,
          email: typeof me.email === 'string' ? me.email : null,
          name: typeof me.real_name === 'string' ? me.real_name : null,
          canUseAi: canUseAiFrom({ isAdmin, permissions }),
          canViewPackaging: isAdmin || permissions.includes('packaging') || permissions.includes('packaging_admin'),
        })
      } catch {
        if (alive) setState({ ...INITIAL, status: 'error' })
      }
    })()
    return () => { alive = false }
  }, [enabled])
  return state
}
