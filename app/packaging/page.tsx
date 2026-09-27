'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { canUseAiFrom } from '@/components/packaging/ai/aiAccess'

// 包裝專區入口（D36 / D42）：比照工程專區，包裝站排程相關功能都掛在這一頁底下。
// P1 起「排程工作台」「每日產能」「版本歷史」可用（後兩者連到工作台並自動開對應面板）；
// P3「AI 模擬排程」（取代原本灰掉的「AI 規則」卡）只有被授權的主管看得到（D89：admin，或 packaging_ai＋packaging_admin）。
// 權限（D30）：admin 或 packaging（唯讀，可進入檢視）/ packaging_admin（可編輯）。
// 編輯提示只給有編輯權的人看；唯讀者一樣進得去，只是看到「唯讀檢視」。
// 頁面自查只是體驗；真正的資料守門在 /api/packaging/* 各路由：guardAuth() 後再判斷 admin || packaging || packaging_admin。

type ZoneItem = {
  name: string
  en: string
  desc: string
  icon: string
  /** 可用時的連結；未上線為 null */
  href: string | null
  /** 未上線時的期別標籤（有 href 的項目不設） */
  phase?: 'P2'
  /** 需要額外權限才進得去（塔台看板在 /admin 底下，proxy 要求 production_admin） */
  needsProductionAdmin?: boolean
  /** 編輯類入口：有編輯權（packaging_admin/admin）時顯示這段提示；唯讀者改顯示「唯讀檢視」 */
  editHint?: string
  /** 只有 AI 模擬排程被授權人看得到（D89；沒權限的人整張卡不顯示） */
  needsAi?: boolean
}

const ZONE_ITEMS: ZoneItem[] = [
  {
    name: '待排池',
    en: 'Pool',
    desc: '常平、委外、自製製令中「可以包／快可以包」的品項，依區塊分組，含估計工時與交期提醒。',
    href: '/packaging/pool',
    icon: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4',
  },
  {
    name: '排程工作台',
    en: 'Workbench',
    desc: '把待排池卡片拖到日期欄排定包裝日，可拆卡、自動儲存與復原。',
    href: '/packaging/schedule',
    editHint: '可拖曳排程・同一時間只有一人能編輯',
    icon: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2',
  },
  {
    name: '每日產能',
    en: 'Capacity',
    desc: '設定每天的包裝人力與工時，對照已排工時看是否超載。',
    href: '/packaging/schedule?panel=capacity',
    editHint: '可設定每日正常／加班總時數與週末加班',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  },
  {
    name: '版本歷史',
    en: 'Versions',
    desc: '每次排程的快照與異動紀錄，可比對、可還原。',
    href: '/packaging/schedule?panel=versions',
    editHint: '可存版本、還原快照',
    icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  {
    name: 'AI 模擬排程',
    en: 'AI Sim',
    desc: '在獨立的模擬區讓 AI 依主管規則排 2／4／6 個工作日，調整滿意後再採用到正式排程（可退回）。',
    href: '/packaging/ai',
    needsAi: true,
    editHint: '鎖定、AI 排程、採用；規則與大量門檻也在這裡改',
    icon: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
  },
  {
    name: '包裝站塔台看板',
    en: 'Tower Board',
    desc: '塔台（SARA）包裝站的即時工序看板（原「包裝排程」選單）。',
    href: '/admin/production/packaging',
    needsProductionAdmin: true,
    icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
]

type Access = { isAdmin: boolean; permissions: string[] }

export default function PackagingPage() {
  const router = useRouter()
  const [status, setStatus] = useState<'checking' | 'allowed' | 'denied'>('checking')
  const [access, setAccess] = useState<Access>({ isAdmin: false, permissions: [] })

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.status === 401) { router.replace('/login'); return }
        if (!res.ok) { setStatus('denied'); return }
        const me = await res.json() as { is_admin?: boolean; permissions?: string[] }
        const permissions = Array.isArray(me.permissions) ? me.permissions : []
        const isAdmin = Boolean(me.is_admin)
        setAccess({ isAdmin, permissions })
        const ok = isAdmin || permissions.includes('packaging') || permissions.includes('packaging_admin')
        setStatus(ok ? 'allowed' : 'denied')
      } catch { setStatus('denied') }
    }
    void check()
  }, [router])

  if (status === 'checking') {
    return (
      <div className="min-h-screen bg-[#050b14] flex items-center justify-center">
        <div className="text-violet-400 font-mono text-sm animate-pulse">驗證權限中...</div>
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
            你沒有 <span className="text-violet-400 font-mono">包裝專區</span> 的存取權限。<br />
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

  const canEdit = access.isAdmin || access.permissions.includes('packaging_admin')
  const canTowerBoard = access.isAdmin || access.permissions.includes('production_admin')
  const canUseAi = canUseAiFrom(access)

  return (
    <div className="min-h-screen bg-[#050b14] text-white p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <button onClick={() => router.push('/')}
          className="mb-6 flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 hover:bg-slate-800 transition-all text-xs font-mono">
          ← 返回首頁
        </button>

        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl md:text-3xl font-bold">包裝專區</h1>
            <span className={`px-2 py-0.5 rounded border text-[11px] font-mono ${
              canEdit
                ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
                : 'border-slate-600 bg-slate-800/60 text-slate-400'
            }`}>
              {canEdit ? '主管編輯權限' : '唯讀'}
            </span>
          </div>
          <p className="text-slate-400 text-sm mt-1">包裝站排程：待排池、排程工作台、每日產能 (Packaging)</p>
          <p className="text-slate-500 text-xs mt-2 leading-relaxed">
            可在工作台排定包裝日、設定每日產能、存取版本；排程只存在 EIP，不回寫塔台。
            {canUseAi ? '「AI 模擬排程」（P3 試用）可讓 AI 先在模擬區排好，再由主管確認採用。' : ''}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {ZONE_ITEMS.filter(item => !item.needsAi || canUseAi).map(item => {
            const locked = item.needsProductionAdmin && !canTowerBoard
            const available = item.href !== null && !locked
            const cardBody = (
              <>
                <div className={`absolute top-3 right-3 px-2 py-1 rounded border ${
                  available ? 'bg-violet-500/10 border-violet-500/20' : 'bg-slate-800/60 border-slate-700'
                }`}>
                  <span className={`text-[10px] font-bold uppercase tracking-wider ${available ? 'text-violet-400' : 'text-slate-500'}`}>
                    {item.en}
                  </span>
                </div>
                {item.phase && !available && (
                  <div className="absolute top-3 left-3 px-2 py-1 rounded border border-slate-700 bg-slate-800/60">
                    <span className="text-[10px] text-slate-400 font-bold">即將推出・{item.phase}</span>
                  </div>
                )}
                <div className={`mb-4 p-3 rounded-full bg-slate-800 transition-colors ${
                  available ? 'text-slate-400 group-hover:bg-violet-900/50 group-hover:text-violet-400' : 'text-slate-500'
                }`}>
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={item.icon} />
                  </svg>
                </div>
                <h2 className={`text-lg font-bold mb-1 transition-colors ${
                  available ? 'text-white group-hover:text-violet-400' : 'text-slate-300'
                }`}>
                  {item.name}
                </h2>
                <p className={`text-xs px-2 ${available ? 'text-slate-500 group-hover:text-slate-300' : 'text-slate-500'}`}>
                  {item.desc}
                </p>
                {item.editHint && available && (
                  <p className={`mt-2 text-[11px] ${canEdit ? 'text-violet-400/80' : 'text-slate-600'}`}>
                    {canEdit ? `✎ ${item.editHint}` : '唯讀檢視（編輯需包裝主管權限）'}
                  </p>
                )}
                {item.needsProductionAdmin && (
                  <p className={`mt-2 text-[11px] ${locked ? 'text-amber-500/80' : 'text-slate-600'}`}>
                    {locked ? '🔒 需生產管理權限（production_admin）' : '需生產管理權限'}
                  </p>
                )}
              </>
            )
            const baseClass = 'group relative min-h-48 rounded-2xl border flex flex-col items-center justify-center text-center px-5 pt-10 pb-5 transition-all duration-300'

            if (!available) {
              return (
                <div key={item.name} aria-disabled="true"
                  title={locked ? '需要生產管理權限，請聯絡核心管理員' : `${item.phase} 階段推出`}
                  className={`${baseClass} border-slate-800 bg-slate-900/20 opacity-70 cursor-not-allowed select-none`}>
                  {cardBody}
                </div>
              )
            }
            return (
              <Link key={item.name} href={item.href!}
                className={`${baseClass} border-slate-700 bg-slate-900/40 backdrop-blur-sm
                           hover:border-violet-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(139,92,246,0.15)]`}>
                {cardBody}
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
