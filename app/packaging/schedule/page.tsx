'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import BoardLayout from '@/components/packaging/board/BoardLayout'

// 包裝專區 P1：拖曳排程工作台（D21、D42）。
// 頁面殼只做權限自查（比照待排池頁：先問 /api/auth/me），通過後交給 BoardLayout。
// 權限（D30）：packaging／packaging_admin／admin 都能進來看；能不能編輯由 GET /api/packaging/board 的 me.canEdit
// （packaging_admin 或 admin）＋編輯鎖決定。頁面自查只是體驗，真正的守門在各 API 路由。

export default function PackagingSchedulePage() {
  const router = useRouter()
  const [auth, setAuth] = useState<'checking' | 'allowed' | 'denied'>('checking')

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.status === 401) { router.replace('/login'); return }
        if (!res.ok) { setAuth('denied'); return }
        const me = await res.json() as { is_admin?: boolean; permissions?: string[] }
        const perms = Array.isArray(me.permissions) ? me.permissions : []
        setAuth(Boolean(me.is_admin) || perms.includes('packaging') || perms.includes('packaging_admin') ? 'allowed' : 'denied')
      } catch { setAuth('denied') }
    }
    void check()
  }, [router])

  if (auth === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050b14]">
        <div className="animate-pulse font-mono text-sm text-amber-400">驗證權限中...</div>
      </div>
    )
  }
  if (auth === 'denied') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050b14] p-4">
        <div className="w-full max-w-md rounded-2xl border border-red-800 bg-slate-900 p-10 text-center">
          <h1 className="mb-3 text-xl font-bold text-red-400">存取被拒絕</h1>
          <p className="mb-6 text-sm leading-relaxed text-slate-400">
            你沒有<span className="mx-1 font-mono text-amber-400">包裝專區</span>的存取權限。<br />
            請聯絡核心管理員開通。
          </p>
          <button type="button" onClick={() => router.push('/')}
            className="rounded border border-slate-600 px-6 py-2 font-mono text-sm text-slate-300 hover:bg-slate-700">← 返回首頁</button>
        </div>
      </div>
    )
  }
  return <BoardLayout />
}
