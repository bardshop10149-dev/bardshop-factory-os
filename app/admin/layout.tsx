'use client'

import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { ReactNode } from 'react'
import { NAV_GROUPS } from '../../config/menuItems' // 引入共用設定
import { FavoritesProvider, useFavorites } from '../../context/FavoritesContext' // 引入 Context

interface ThemeColors {
  text: string
  activeBg: string
  border: string
  glow: string
  hoverText: string
  menuBorder: string
}

// 抽離出一個內部組件來使用 useFavorites (因為 Provider 必須在更外層)
function AdminNavbar() {
  const router = useRouter()
  const pathname = usePathname()
  const { favorites, toggleFavorite } = useFavorites()

  // 輔助顏色函式 (維持不變)
  const getThemeColors = (theme: string) => {
    const colors: Record<string, ThemeColors> = {
      cyan: { text: "text-cyan-400", activeBg: "bg-cyan-950/80", border: "border-cyan-400", glow: "shadow-[0_0_20px_rgba(34,211,238,0.6)]", hoverText: "hover:text-cyan-300", menuBorder: "border-cyan-500/50 shadow-[0_0_30px_rgba(34,211,238,0.2)]" },
      purple: { text: "text-purple-400", activeBg: "bg-purple-950/80", border: "border-purple-400", glow: "shadow-[0_0_20px_rgba(192,132,252,0.6)]", hoverText: "hover:text-purple-300", menuBorder: "border-purple-500/50 shadow-[0_0_30px_rgba(192,132,252,0.2)]" },
      blue: { text: "text-blue-400", activeBg: "bg-blue-950/80", border: "border-blue-400", glow: "shadow-[0_0_20px_rgba(96,165,250,0.6)]", hoverText: "hover:text-blue-300", menuBorder: "border-blue-500/50 shadow-[0_0_30px_rgba(96,165,250,0.2)]" },
      orange: { text: "text-orange-400", activeBg: "bg-orange-950/80", border: "border-orange-400", glow: "shadow-[0_0_20px_rgba(251,146,60,0.6)]", hoverText: "hover:text-orange-300", menuBorder: "border-orange-500/50 shadow-[0_0_30px_rgba(251,146,60,0.2)]" },
      indigo: { text: "text-indigo-400", activeBg: "bg-indigo-950/80", border: "border-indigo-400", glow: "shadow-[0_0_20px_rgba(129,140,248,0.6)]", hoverText: "hover:text-indigo-300", menuBorder: "border-indigo-500/50 shadow-[0_0_30px_rgba(129,140,248,0.2)]" },
      emerald: { text: "text-emerald-400", activeBg: "bg-emerald-950/80", border: "border-emerald-400", glow: "shadow-[0_0_20px_rgba(52,211,153,0.6)]", hoverText: "hover:text-emerald-300", menuBorder: "border-emerald-500/50 shadow-[0_0_30px_rgba(52,211,153,0.2)]" }
    }
    return colors[theme] || colors['cyan']
  }

  return (
    <div className="sticky top-0 z-50 bg-[#050b14]/90 backdrop-blur-md border-b border-slate-800 shadow-lg shadow-black/80">
      <div className="w-full px-4 md:px-6"> 
        <div className="flex flex-col xl:flex-row items-center justify-start py-3 gap-4 xl:gap-8">
          
          {/* 左側控制區 */}
          <div className="flex items-center gap-3 w-full xl:w-auto shrink-0 border-b xl:border-b-0 border-slate-800/50 pb-3 xl:pb-0">
             {/* 1. 回到網站首頁 (Home) */}
             <Link href="/" className="flex items-center justify-center w-10 h-10 rounded-lg bg-slate-900/80 border border-slate-700 text-cyan-500 hover:bg-cyan-950 hover:border-cyan-500 hover:text-cyan-400 hover:shadow-[0_0_15px_rgba(6,182,212,0.5)] transition-all group" title="回到網站首頁">
               <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
             </Link>

             {/* 🔥 2. [新增] 回到 Admin 首頁/最愛 (Dashboard) */}
             <Link href="/admin" className="flex items-center justify-center w-10 h-10 rounded-lg bg-slate-900/80 border border-slate-700 text-slate-400 hover:bg-slate-800 hover:border-yellow-500 hover:text-yellow-400 hover:shadow-[0_0_15px_rgba(234,179,8,0.5)] transition-all group" title="回到管理後台首頁 (最愛)">
               <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
             </Link>

             {/* 3. 回上一頁 (Back) */}
             <button onClick={() => router.back()} className="flex items-center justify-center w-10 h-10 rounded-lg bg-slate-900/80 border border-slate-700 text-slate-400 hover:bg-slate-800 hover:border-slate-500 hover:text-white transition-all" title="回上一頁">
               <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
             </button>

             <div className="h-8 w-px bg-slate-800 mx-2 hidden xl:block"></div>
             <div className="hidden sm:flex flex-col justify-center shrink-0">
               <div className="text-white font-bold text-xs tracking-[0.2em]">CONSOLE</div>
               <div className="text-[10px] text-cyan-500/60 font-mono">V2.4 PRO</div>
             </div>
          </div>

          {/* 右側下拉導航 */}
          <nav className="flex items-center gap-4 overflow-visible w-full xl:w-auto">
            {NAV_GROUPS.map((group) => {
              const colors = getThemeColors(group.theme)
              const isActiveGroup = group.items.some(item => pathname === item.path || pathname.startsWith(item.path + '?'))

              return (
                <div key={group.title} className="relative group/menu">
                  <button className={`flex items-center gap-2 px-4 py-2 rounded transition-all duration-300 font-bold text-sm tracking-wide border ${isActiveGroup ? `${colors.text} ${colors.activeBg} ${colors.border} ${colors.glow}` : `text-slate-400 border-transparent hover:text-white hover:bg-slate-800/50`}`}>
                    <span>{group.title}</span>
                    <svg className="w-3 h-3 transition-transform duration-300 group-hover/menu:rotate-180 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  </button>

                  <div className="absolute left-0 top-full pt-3 w-64 opacity-0 translate-y-2 pointer-events-none group-hover/menu:opacity-100 group-hover/menu:translate-y-0 group-hover/menu:pointer-events-auto transition-all duration-200 z-50">
                    <div className={`bg-[#0b1120] border rounded-xl shadow-2xl overflow-hidden backdrop-blur-xl flex flex-col py-2 ${colors.menuBorder}`}>
                      <div className={`h-0.5 w-full bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-50`}></div>

                      {group.items.map((item) => {
                          const isItemActive = pathname === item.path
                          const isFav = favorites.includes(item.path)
                          
                          return (
                            <div key={item.path} className={`group/item flex items-center px-4 py-2 hover:bg-slate-800/50 transition-colors border-l-4 ${isItemActive ? `border-${group.theme}-400 bg-slate-800/80` : 'border-transparent'}`}>
                              {/* ⭐ 星星開關 */}
                              <button 
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(item.path); }}
                                className={`mr-3 p-1 rounded-full transition-all ${isFav ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' : 'text-slate-600 hover:text-slate-400'}`}
                                title={isFav ? "移除常用" : "加入常用"}
                              >
                                <svg className="w-4 h-4" fill={isFav ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                              </button>

                              <Link href={item.path} className={`flex-1 text-sm font-medium tracking-wide ${isItemActive ? colors.text : `text-slate-400 ${colors.hoverText} hover:text-white`}`}>
                                {item.name}
                              </Link>
                            </div>
                          )
                      })}
                    </div>
                  </div>
                </div>
              )
            })}
          </nav>
        </div>
      </div>
    </div>
  )
}

function SystemSettingsNavbar() {
  const pathname = usePathname()

  const getButtonClass = (isActive: boolean) =>
    `px-3 py-1.5 rounded border text-sm transition-colors ${
      isActive
        ? 'bg-orange-950/60 border-orange-500/70 text-orange-300'
        : 'bg-slate-900/80 border-slate-700 text-slate-300 hover:bg-slate-800'
    }`

  return (
    <div className="sticky top-0 z-50 bg-[#050b14]/90 backdrop-blur-md border-b border-slate-800 shadow-lg shadow-black/80">
      <div className="w-full px-4 md:px-6 py-3 flex flex-row items-center justify-end gap-3">
        <Link href="/admin/system-logs" className={getButtonClass(pathname === '/admin/system-logs')}>
          系統 LOG
        </Link>
        <Link href="/" className={getButtonClass(false)}>
          返回首頁
        </Link>
      </div>
    </div>
  )
}

const SYSTEM_SETTINGS_PATH_PREFIXES = ['/admin/settings', '/admin/team', '/admin/system-logs']

const isSystemSettingsRoute = (pathname: string) =>
  SYSTEM_SETTINGS_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))

// 主 Layout 組件
export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const useSystemSettingsNavbar = isSystemSettingsRoute(pathname)

  return (
    <FavoritesProvider>
      <div className="min-h-screen bg-[#050b14] text-slate-300 font-sans selection:bg-cyan-500 selection:text-white relative">
        {/* 全域背景 */}
        <div className="fixed inset-0 z-0 pointer-events-none">
          <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 brightness-100 contrast-150"></div>
          <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-blue-900/10 via-transparent to-slate-950/90"></div>
          <div className="absolute inset-0 opacity-[0.15]" style={{ backgroundImage: 'linear-gradient(rgba(6, 182, 212, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(6, 182, 212, 0.1) 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>
        </div>

        <div className="no-print">
          {useSystemSettingsNavbar ? <SystemSettingsNavbar /> : <AdminNavbar />}
        </div>

        <main className="relative z-10 min-h-[calc(100vh-70px)] p-4 md:p-6">
          {children}
        </main>
      </div>
    </FavoritesProvider>
  )
}