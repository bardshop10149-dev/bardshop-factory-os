'use client'

import Link from 'next/link'
import { useFavorites } from '../../context/FavoritesContext'
import { NAV_GROUPS } from '../../config/menuItems'

interface ColorClasses {
  icon: string
  bg: string
  border: string
  bar: string
}

export default function AdminDashboard() {
  const { favorites, loading } = useFavorites()

  // 1. 將所有選單攤平成一個陣列，方便查找（含子選單展開）
  const allItems = NAV_GROUPS.flatMap(g =>
    g.items.flatMap(i => {
      if ('children' in i && Array.isArray(i.children)) {
        return (i.children as Array<{ name: string; path: string; icon?: string }>).map(c => ({ ...c, theme: g.theme, groupTitle: g.title }))
      }
      const di = i as { name: string; path: string; icon?: string }
      return [{ ...di, theme: g.theme, groupTitle: g.title }]
    })
  )

  // 2. 過濾出使用者設定的常用功能
  const favoriteItems = allItems.filter(item => favorites.includes(item.path))

  // 顏色對照表
  const getColorClasses = (theme: string) => {
    const maps: Record<string, ColorClasses> = {
      cyan: { icon: "text-cyan-400", bg: "hover:bg-cyan-950/30", border: "hover:border-cyan-500/50", bar: "bg-cyan-400" },
      purple: { icon: "text-purple-400", bg: "hover:bg-purple-950/30", border: "hover:border-purple-500/50", bar: "bg-purple-400" },
      blue: { icon: "text-blue-400", bg: "hover:bg-blue-950/30", border: "hover:border-blue-500/50", bar: "bg-blue-400" },
      orange: { icon: "text-orange-400", bg: "hover:bg-orange-950/30", border: "hover:border-orange-500/50", bar: "bg-orange-400" }
    }
    return maps[theme] || maps['cyan']
  }

  if (loading) return <div className="text-center py-20 animate-pulse text-slate-500">載入設定檔...</div>

  return (
    <div className="min-h-screen flex flex-col items-center justify-start pt-10">
      
      <div className="w-full max-w-[1600px] px-6">
        
        {/* Header */}
        <div className="flex justify-between items-end mb-12 border-b border-slate-800 pb-6">
          <div>
            <h1 className="text-4xl font-black text-white tracking-tight mb-2">常用功能儀表板</h1>
            <p className="text-cyan-500 font-mono tracking-widest uppercase text-sm">
              MY SHORTCUTS
            </p>
          </div>
        </div>

        {/* 內容區：判斷是否有最愛 */}
        {favoriteItems.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-8">
            {favoriteItems.map((item, idx) => {
              const colors = getColorClasses(item.theme)
              const isLocked = Boolean((item as { locked?: boolean }).locked)
              return (
                <div
                  key={idx}
                  className={`
                    group relative bg-slate-900/40 border border-slate-700/60 rounded-2xl p-8 
                    flex flex-col gap-6 transition-all duration-300 backdrop-blur-sm
                    ${isLocked ? 'opacity-60 cursor-not-allowed' : `hover:shadow-[0_0_30px_rgba(0,0,0,0.3)] hover:-translate-y-1 ${colors.border} ${colors.bg}`}
                  `}
                >
                  <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[10px] font-mono tracking-widest text-slate-500 bg-slate-900 px-2 py-1 rounded border border-slate-700">
                      {item.groupTitle}
                    </span>
                  </div>

                  {isLocked && (
                    <div className="absolute top-4 left-4">
                      <span className="text-[10px] font-mono tracking-widest text-amber-300 bg-amber-950/70 px-2 py-1 rounded border border-amber-700/60">
                        LOCKED
                      </span>
                    </div>
                  )}

                  <div className={`p-4 rounded-xl bg-slate-950 w-fit shadow-lg ${colors.icon}`}>
                    <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={item.icon} /></svg>
                  </div>
                  
                  <div className="mt-2">
                    <h2 className="text-2xl font-bold text-white mb-2 group-hover:tracking-wide transition-all">{item.name}</h2>
                    <p className="text-sm text-slate-500 font-mono">Quick Access</p>
                  </div>

                  <div className="mt-auto pt-6 flex items-center justify-between border-t border-white/5 group-hover:border-white/10 transition-colors">
                     <div className={`h-1 w-12 rounded-full opacity-20 group-hover:w-full transition-all duration-500 ${colors.bar}`}></div>
                     <span className="text-xs font-mono opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all text-white">
                       {isLocked ? 'LOCKED' : 'ENTER →'}
                     </span>
                  </div>
                  {!isLocked && (
                    <Link href={item.path} className="absolute inset-0" aria-label={item.name} />
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          /* 空狀態顯示 (Empty State) */
          <div className="flex flex-col items-center justify-center py-20 text-center border-2 border-dashed border-slate-800 rounded-3xl bg-slate-900/20">
            <div className="w-24 h-24 rounded-full bg-slate-900 flex items-center justify-center mb-6 shadow-xl border border-slate-700 text-slate-600">
               <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
            </div>
            <h3 className="text-2xl font-bold text-white mb-2">您尚未設定常用功能</h3>
            <p className="text-slate-500 max-w-md mx-auto mb-8">
              請點選上方導航列中，各功能選單左側的 <span className="text-yellow-400 font-bold mx-1">★ 星星符號</span>，<br/>即可將該功能加入此儀表板，建立您的專屬捷徑。
            </p>
            
            {/* 指示箭頭動畫 */}
            <div className="animate-bounce text-slate-600">
              <svg className="w-8 h-8 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}