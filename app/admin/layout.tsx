'use client'

import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { ReactNode, useEffect, useRef, useState } from 'react'
import { NAV_GROUPS } from '../../config/menuItems' // 引入共用設定
import { FavoritesProvider, useFavorites } from '../../context/FavoritesContext' // 引入 Context

// 導覽列上的「產期詢問記錄」提示徽章：輪詢尚未回覆（planner_reply is null）的筆數，
// 讓生管不用點進頁面就知道有沒有未確認的單子。放在 layout 層級，任何後台頁面都看得到。
const SCHEDULE_CONFIRM_PATH = '/admin/production/notice/schedule-confirm'
function usePendingScheduleCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    const fetchCount = () => {
      fetch(`/api/production/schedule-confirm?count=pending`, { cache: 'no-store' })
        .then(r => r.json())
        .then(j => { if (!cancelled && j?.success) setCount(Number(j.count) || 0) })
        .catch(() => { /* 靜默：導覽列提示非關鍵路徑 */ })
    }
    fetchCount()
    const timer = setInterval(fetchCount, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  return count
}

// 「SARA 工序自動產生」待處理徽章：無途程且不符合自動規則而被跳過的列數，
// 同產期詢問未讀的做法，讓生管不用點進頁面就知道有幾筆要人工補處理。
const PROCESS_GEN_PATH = '/admin/sara/process-gen'
function useSaraPendingCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    const fetchCount = () => {
      fetch(`/api/sara/process-gen-pending?count=1`, { cache: 'no-store' })
        .then(r => r.json())
        .then(j => { if (!cancelled && j?.success) setCount(Number(j.count) || 0) })
        .catch(() => { /* 靜默：導覽列提示非關鍵路徑 */ })
    }
    fetchCount()
    const timer = setInterval(fetchCount, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  return count
}

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
  const pendingScheduleCount = usePendingScheduleCount()
  const saraPendingCount = useSaraPendingCount()

  // 導覽選單原本只靠 CSS :hover 展開——觸控裝置（手機/平板）沒有滑鼠 hover 狀態，
  // 點擊完全沒反應（2026-08-27 使用者回報：手機版點不開選單）。改成同時支援點擊：
  // 桌機維持 hover 直接展開的便利性，手機/觸控則靠這裡的狀態點擊展開/收合。
  const navRef = useRef<HTMLDivElement>(null)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [openSubGroup, setOpenSubGroup] = useState<string | null>(null)
  // 手機版（<xl）導覽：漢堡收合選單。桌機的水平選單列在窄螢幕下 6 個分類文字擠不下，
  // 沒有換行/收合機制，中文字會被硬擠成逐字直排（2026-08-27 使用者回報：手機版排版跑掉，
  // 這才是原始問題的根源——先前修的是「選單點不開」，這裡才是「選單列本身就跑版」）。
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const closeAllMenus = () => { setOpenGroup(null); setOpenSubGroup(null); setMobileMenuOpen(false) }

  useEffect(() => {
    const handleOutside = (e: Event) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) closeAllMenus()
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('touchstart', handleOutside)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('touchstart', handleOutside)
    }
  }, [])

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

  // 一個分類群組底下的項目列表——桌機浮動下拉選單、手機收合選單共用同一份，
  // 避免我的最愛/角標/子選單這些邏輯要維護兩份、彼此漂移。
  const renderGroupItems = (group: (typeof NAV_GROUPS)[number], colors: ThemeColors, variant: 'desktop' | 'mobile' = 'desktop') => (
    <>
      {group.items.map((item) => {
        // ── 子選單群組
        if ('children' in item && Array.isArray(item.children)) {
          type Child = { name: string; path: string }
          const sub = item as { name: string; children: Child[] }
          const isSubActive = sub.children.some(c => pathname === c.path || pathname.startsWith(c.path + '?'))
          const isSubOpen = openSubGroup === sub.name

          const childLinks = sub.children.map(child => {
            const isChildActive = pathname === child.path
            const isFav = favorites.includes(child.path)
            return (
              <div key={child.path} className={`group/item flex items-center px-4 py-2 transition-colors border-l-4 hover:bg-slate-800/50 ${isChildActive ? `border-${group.theme}-400 bg-slate-800/80` : 'border-transparent'}`}>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(child.path) }}
                  className={`mr-3 p-1 rounded-full transition-all ${isFav ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' : 'text-slate-600 hover:text-slate-400'}`}
                  title={isFav ? '移除常用' : '加入常用'}
                >
                  <svg className="w-4 h-4" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                </button>
                <Link href={child.path} onClick={closeAllMenus} className={`flex-1 text-sm font-medium tracking-wide ${isChildActive ? colors.text : `text-slate-400 ${colors.hoverText} hover:text-white`}`}>
                  {child.name}
                </Link>
              </div>
            )
          })

          // 桌機：滑鼠移過去往右浮出（跟改版前一樣），不佔用/推擠其他項目的排版位置，
          // 避免像手風琴那樣因為內容展開把下面的項目往下推、選單看起來一直在跳動
          if (variant === 'desktop') {
            return (
              <div key={sub.name} className="relative group/sub">
                <div className={`flex items-center px-4 py-2 transition-colors border-l-4 hover:bg-slate-800/50 cursor-default select-none ${isSubActive ? `border-${group.theme}-400 bg-slate-800/80` : 'border-transparent'}`}>
                  <span className="mr-3 w-6 h-6 shrink-0" />
                  <span className={`flex-1 text-sm font-medium tracking-wide ${isSubActive ? colors.text : 'text-slate-400 group-hover/sub:text-white'}`}>
                    {sub.name}
                  </span>
                  <svg className="w-3 h-3 text-slate-500 ml-2 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
                {/* 往右展開的子選單 */}
                <div className="absolute left-full top-0 pl-1 w-56 opacity-0 -translate-x-2 pointer-events-none group-hover/sub:opacity-100 group-hover/sub:translate-x-0 group-hover/sub:pointer-events-auto transition-all duration-200 z-[60]">
                  <div className={`bg-[#0b1120] border rounded-xl shadow-2xl backdrop-blur-xl flex flex-col py-2 ${colors.menuBorder}`}>
                    {childLinks}
                  </div>
                </div>
              </div>
            )
          }

          // 手機/平板：往右展開會超出窄螢幕外，改用向下展開的手風琴（跟主選單同一路逐層收合）
          return (
            <div key={sub.name} className="relative group/sub">
              <button
                onClick={() => setOpenSubGroup(prev => prev === sub.name ? null : sub.name)}
                className={`w-full flex items-center px-4 py-2 transition-colors border-l-4 hover:bg-slate-800/50 select-none ${isSubActive ? `border-${group.theme}-400 bg-slate-800/80` : 'border-transparent'}`}
              >
                <span className="mr-3 w-6 h-6 shrink-0" />
                <span className={`flex-1 text-left text-sm font-medium tracking-wide ${isSubActive ? colors.text : 'text-slate-400 group-hover/sub:text-white'}`}>
                  {sub.name}
                </span>
                <svg className={`w-3 h-3 text-slate-500 ml-2 shrink-0 transition-transform duration-200 ${isSubOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <div className={`pl-2 transition-all duration-200 overflow-hidden ${
                isSubOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
              }`}>
                <div className={`my-1 mx-2 rounded-lg border flex flex-col py-1 bg-black/20 ${colors.menuBorder}`}>
                  {childLinks}
                </div>
              </div>
            </div>
          )
        }

        // ── 一般直接項目
        const directItem = item as { name: string; path: string; locked?: boolean }
        const isItemActive = pathname === directItem.path
        const isLocked = Boolean(directItem.locked)
        const isFav = favorites.includes(directItem.path)
        const itemPendingCount = directItem.path === SCHEDULE_CONFIRM_PATH ? pendingScheduleCount
          : directItem.path === PROCESS_GEN_PATH ? saraPendingCount : 0
        return (
          <div key={directItem.path} className={`group/item flex items-center px-4 py-2 transition-colors border-l-4 ${isLocked ? 'opacity-60 cursor-not-allowed' : 'hover:bg-slate-800/50'} ${isItemActive ? `border-${group.theme}-400 bg-slate-800/80` : 'border-transparent'}`}>
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!isLocked) toggleFavorite(directItem.path) }}
              disabled={isLocked}
              className={`mr-3 p-1 rounded-full transition-all ${isLocked ? 'text-slate-700 cursor-not-allowed' : isFav ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' : 'text-slate-600 hover:text-slate-400'}`}
              title={isFav ? '移除常用' : '加入常用'}
            >
              <svg className="w-4 h-4" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
            </button>
            {isLocked ? (
              <span className="flex-1 text-sm font-medium tracking-wide text-slate-500 select-none">{directItem.name}（鎖定）</span>
            ) : (
              <Link href={directItem.path} onClick={closeAllMenus} className={`flex-1 flex items-center gap-2 text-sm font-medium tracking-wide ${isItemActive ? colors.text : `text-slate-400 ${colors.hoverText} hover:text-white`}`}>
                {directItem.name}
                {itemPendingCount > 0 && (
                  <span
                    className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0"
                    title={`${itemPendingCount} 筆尚未回覆`}
                  >
                    {itemPendingCount > 99 ? '99+' : itemPendingCount}
                  </span>
                )}
              </Link>
            )}
          </div>
        )
      })}
    </>
  )

  return (
    <div className="sticky top-0 z-50 bg-[#050b14]/90 backdrop-blur-md border-b border-slate-800 shadow-lg shadow-black/80">
      <div className="w-full px-4 md:px-6">
        <div ref={navRef} className="flex flex-col xl:flex-row items-center justify-start py-3 gap-4 xl:gap-8">

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

             {/* 手機/平板（<xl）漢堡選單按鈕，放在最右邊 */}
             <button
               onClick={() => setMobileMenuOpen(prev => !prev)}
               className="xl:hidden ml-auto flex items-center justify-center w-10 h-10 rounded-lg bg-slate-900/80 border border-slate-700 text-slate-300 hover:bg-slate-800 hover:border-cyan-500 hover:text-cyan-400 transition-all shrink-0"
               title="選單"
             >
               {mobileMenuOpen ? (
                 <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
               ) : (
                 <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
               )}
             </button>
          </div>

          {/* 右側下拉導航（桌機／xl 以上：水平列 + 浮動下拉選單） */}
          <nav className="hidden xl:flex items-center gap-4 overflow-visible">
            {NAV_GROUPS.map((group) => {
              const colors = getThemeColors(group.theme)
              const isActiveGroup = group.items.some(item => {
                if ('children' in item && Array.isArray(item.children)) {
                  return (item.children as { path: string }[]).some(c => pathname === c.path || pathname.startsWith(c.path + '?'))
                }
                const p = (item as { path: string }).path
                return pathname === p || pathname.startsWith(p + '?')
              })

              const groupPendingCount = group.title === '生產管理入口' ? pendingScheduleCount : group.title === '塔台SARA' ? saraPendingCount : 0
              const isGroupOpen = openGroup === group.title

              return (
                <div key={group.title} className="relative group/menu">
                  <button
                    onClick={() => { setOpenGroup(prev => prev === group.title ? null : group.title); setOpenSubGroup(null) }}
                    className={`relative flex items-center gap-2 px-4 py-2 rounded transition-all duration-300 font-bold text-sm tracking-wide border ${isActiveGroup ? `${colors.text} ${colors.activeBg} ${colors.border} ${colors.glow}` : `text-slate-400 border-transparent hover:text-white hover:bg-slate-800/50`}`}>
                    <span>{group.title}</span>
                    <svg className={`w-3 h-3 transition-transform duration-300 opacity-50 ${isGroupOpen ? 'rotate-180' : 'group-hover/menu:rotate-180'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                    {groupPendingCount > 0 && (
                      <span
                        className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow-[0_0_8px_rgba(239,68,68,0.7)] animate-pulse"
                        title={`${groupPendingCount} 筆產期詢問尚未回覆`}
                      >
                        {groupPendingCount > 99 ? '99+' : groupPendingCount}
                      </span>
                    )}
                  </button>

                  <div className={`absolute left-0 top-full pt-3 w-64 transition-all duration-200 z-50 ${
                    isGroupOpen
                      ? 'opacity-100 translate-y-0 pointer-events-auto'
                      : 'opacity-0 translate-y-2 pointer-events-none group-hover/menu:opacity-100 group-hover/menu:translate-y-0 group-hover/menu:pointer-events-auto'
                  }`}>
                    <div className={`bg-[#0b1120] border rounded-xl shadow-2xl backdrop-blur-xl flex flex-col py-2 ${colors.menuBorder}`}>
                      <div className={`h-0.5 w-full bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-50`}></div>

                      {renderGroupItems(group, colors)}
                    </div>
                  </div>
                </div>
              )
            })}
          </nav>

          {/* 手機/平板（<xl）收合選單：垂直手風琴，跟桌機共用 renderGroupItems */}
          {mobileMenuOpen && (
            <div className="xl:hidden w-full flex flex-col gap-2 pb-2">
              {NAV_GROUPS.map((group) => {
                const colors = getThemeColors(group.theme)
                const isActiveGroup = group.items.some(item => {
                  if ('children' in item && Array.isArray(item.children)) {
                    return (item.children as { path: string }[]).some(c => pathname === c.path || pathname.startsWith(c.path + '?'))
                  }
                  const p = (item as { path: string }).path
                  return pathname === p || pathname.startsWith(p + '?')
                })
                const groupPendingCount = group.title === '生產管理入口' ? pendingScheduleCount : group.title === '塔台SARA' ? saraPendingCount : 0
                const isGroupOpen = openGroup === group.title

                return (
                  <div key={group.title} className={`rounded-xl border overflow-hidden ${colors.menuBorder}`}>
                    <button
                      onClick={() => { setOpenGroup(prev => prev === group.title ? null : group.title); setOpenSubGroup(null) }}
                      className={`relative w-full flex items-center justify-between gap-2 px-4 py-3 font-bold text-sm tracking-wide transition-colors ${isActiveGroup ? `${colors.text} ${colors.activeBg}` : 'text-slate-300 bg-[#0b1120]'}`}
                    >
                      <span className="flex items-center gap-2">
                        {group.title}
                        {groupPendingCount > 0 && (
                          <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                            {groupPendingCount > 99 ? '99+' : groupPendingCount}
                          </span>
                        )}
                      </span>
                      <svg className={`w-4 h-4 opacity-60 transition-transform duration-200 shrink-0 ${isGroupOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                    </button>
                    {isGroupOpen && (
                      <div className="bg-[#0b1120] border-t border-white/5 flex flex-col py-1 max-h-[60vh] overflow-y-auto">
                        {renderGroupItems(group, colors, 'mobile')}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
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