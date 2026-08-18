'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ErpSyncPage } from '../admin/argoerp/erp-sync/ErpSyncPage'

export default function ArgoDBPage() {
  const router = useRouter()
  const [status, setStatus] = useState<'checking' | 'allowed' | 'denied'>('checking')

  useEffect(() => {
    const check = async () => {
      try {
        // SEC 修復：改用後端 /api/auth/me（guardAuth 驗 token）判斷權限，
        // 不再用 anon key 直讀 members（那條路等於讓匿名可讀整張員工表含明文密碼）。
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.status === 401) {
          router.replace('/login')
          return
        }
        if (!res.ok) {
          setStatus('denied')
          return
        }
        const me = await res.json() as { is_admin?: boolean; permissions?: string[] }
        const isAdmin = Boolean(me.is_admin)
        const permissions: string[] = Array.isArray(me.permissions) ? me.permissions : []
        setStatus(isAdmin || permissions.includes('argo_db') ? 'allowed' : 'denied')
      } catch {
        setStatus('denied')
      }
    }
    void check()
  }, [router])

  if (status === 'checking') {
    return (
      <div className="min-h-screen bg-[#050b14] flex items-center justify-center">
        <div className="text-cyan-400 font-mono text-sm animate-pulse">驗證權限中...</div>
      </div>
    )
  }

  if (status === 'denied') {
    return (
      <div className="min-h-screen bg-[#050b14] flex items-center justify-center font-sans">
        <div className="bg-slate-900 border border-red-800 rounded-2xl p-10 max-w-md w-full text-center shadow-2xl">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-red-400 mb-3">存取被拒絕</h1>
          <p className="text-slate-400 text-sm mb-6 leading-relaxed">
            你沒有 <span className="text-orange-400 font-mono">ARGO資料庫</span> 的存取權限。<br />
            請聯絡核心管理員開通。
          </p>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-2 rounded border border-slate-600 text-slate-300 text-sm font-mono hover:bg-slate-700 transition-all"
          >
            ← 返回首頁
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative">
      <div className="fixed top-4 left-4 z-50">
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 hover:bg-slate-800 transition-all backdrop-blur-sm text-xs font-mono"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
          首頁
        </button>
      </div>
      <ErpSyncPage />
    </div>
  )
}
