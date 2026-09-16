'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

// 工程專區入口：目前只有「工程維護/維修表」，之後的工程相關功能都掛在這一頁底下，
// 不另外在首頁長出新卡片。

const ZONE_ITEMS = [
  {
    name: '工程維護/維修表',
    href: '/engineering/maintenance',
    desc: '設備報修與保養登記，從報修、指派到完成的處理紀錄。',
    en: 'Maintenance',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  },
]

export default function EngineeringPage() {
  const router = useRouter()
  const [status, setStatus] = useState<'checking' | 'allowed' | 'denied'>('checking')

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.status === 401) { router.replace('/login'); return }
        if (!res.ok) { setStatus('denied'); return }
        const me = await res.json() as { is_admin?: boolean; permissions?: string[] }
        const permissions = Array.isArray(me.permissions) ? me.permissions : []
        setStatus(Boolean(me.is_admin) || permissions.includes('engineering') ? 'allowed' : 'denied')
      } catch { setStatus('denied') }
    }
    void check()
  }, [router])

  if (status === 'checking') {
    return (
      <div className="min-h-screen bg-[#050b14] flex items-center justify-center">
        <div className="text-orange-400 font-mono text-sm animate-pulse">驗證權限中...</div>
      </div>
    )
  }

  if (status === 'denied') {
    return (
      <div className="min-h-screen bg-[#050b14] flex items-center justify-center font-sans p-4">
        <div className="bg-slate-900 border border-red-800 rounded-2xl p-10 max-w-md w-full text-center shadow-2xl">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-red-400 mb-3">存取被拒絕</h1>
          <p className="text-slate-400 text-sm mb-6 leading-relaxed">
            你沒有 <span className="text-orange-400 font-mono">工程專區</span> 的存取權限。<br />
            請聯絡核心管理員開通。
          </p>
          <button onClick={() => router.push('/')}
            className="px-6 py-2 rounded border border-slate-600 text-slate-300 text-sm font-mono hover:bg-slate-700 transition-all">
            ← 返回首頁
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#050b14] text-white p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <button onClick={() => router.push('/')}
          className="mb-6 flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 hover:bg-slate-800 transition-all text-xs font-mono">
          ← 返回首頁
        </button>

        <div className="mb-8">
          <h1 className="text-2xl md:text-3xl font-bold">工程專區</h1>
          <p className="text-slate-400 text-sm mt-1">設備維護、維修與工程相關作業 (Engineering)</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {ZONE_ITEMS.map(item => (
            <Link key={item.href} href={item.href}
              className="group relative h-48 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm
                         flex flex-col items-center justify-center text-center p-5 transition-all duration-300
                         hover:border-orange-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(249,115,22,0.15)]">
              <div className="absolute top-3 right-3 px-2 py-1 bg-orange-500/10 rounded border border-orange-500/20">
                <span className="text-[10px] text-orange-400 font-bold uppercase tracking-wider">{item.en}</span>
              </div>
              <div className="mb-4 p-3 rounded-full bg-slate-800 group-hover:bg-orange-900/50 text-slate-400 group-hover:text-orange-400 transition-colors">
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={item.icon} />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-white mb-1 group-hover:text-orange-400 transition-colors">{item.name}</h2>
              <p className="text-slate-500 text-xs px-2 group-hover:text-slate-300">{item.desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
