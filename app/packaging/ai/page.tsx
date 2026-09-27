'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import SimLayout from '@/components/packaging/ai/SimLayout'
import { useAiAccess } from '@/components/packaging/ai/aiAccess'

// 包裝專區 P3：AI 模擬排程（規格 §八；D89／D90）。
// 頁面殼只做權限自查（/api/auth/me → canUseAi：admin，或 packaging_ai＋packaging_admin），通過後交給 SimLayout。
// /packaging/* 的頁面 proxy 沒有擋（規格 §二），所以這裡一定要自查、無權限顯示說明畫面；
// 但這只是體驗——真正的守門在 /api/packaging/ai/** 的 guardPackagingAi()，就算繞過這一頁也讀不到、寫不進。

export default function PackagingAiPage() {
  const router = useRouter()
  const access = useAiAccess()

  useEffect(() => {
    if (access.status === 'unauthorized') router.replace('/login')
  }, [access.status, router])

  if (access.status === 'checking' || access.status === 'unauthorized') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050b14]">
        <div className="animate-pulse font-mono text-sm text-violet-400">驗證權限中...</div>
      </div>
    )
  }

  if (access.status === 'error' || !access.canUseAi) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050b14] p-4">
        <div className="w-full max-w-md rounded-2xl border border-red-800 bg-slate-900 p-8 text-center shadow-2xl sm:p-10">
          <div className="mb-4 text-5xl">🔒</div>
          <h1 className="mb-3 text-xl font-bold text-red-400">{access.status === 'error' ? '無法確認權限' : '沒有 AI 模擬排程的權限'}</h1>
          {access.status === 'error' ? (
            <p className="mb-6 text-sm leading-relaxed text-slate-400">讀取登入資訊失敗，請重新整理頁面再試一次。</p>
          ) : (
            <div className="mb-6 space-y-2 text-sm leading-relaxed text-slate-400">
              <p>
                AI 模擬排程只開放給被授權的包裝主管：需要
                <span className="mx-1 font-mono text-violet-400">包裝專區（AI 模擬排程）</span>
                權限，而且要能編輯包裝排程（採用會寫入正式排程）。
              </p>
              <p className="text-xs text-slate-500">請聯絡核心管理員在「管理後台 → 團隊成員」勾選開通。</p>
            </div>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            {access.status === 'error' && (
              <button type="button" onClick={() => window.location.reload()}
                className="rounded border border-slate-600 px-6 py-2 text-sm text-slate-300 hover:bg-slate-700">重新整理</button>
            )}
            <Link href={access.canViewPackaging ? '/packaging' : '/'}
              className="rounded border border-slate-600 px-6 py-2 font-mono text-sm text-slate-300 hover:bg-slate-700">
              {access.canViewPackaging ? '← 回包裝專區' : '← 返回首頁'}
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return <SimLayout meEmail={access.email} />
}
