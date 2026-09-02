'use client'

import Link from 'next/link'
import { NavButton } from '../../../components/NavButton'
import { PRODUCTION_SECTIONS } from '../../../config/productionSections'

// 卡片內容與配色統一取自 config/productionSections，與點進去之後的排程看板共用同一組
// 主色與圖示（原本這裡自帶一份重複的定義，兩邊會各自漂移）
const CATEGORIES = PRODUCTION_SECTIONS.map(s => ({
  id: s.id,
  name: `${s.name}產程`,
  eng: s.eng,
  desc: s.desc,
  color: s.gradient,
  icon: (
    <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={s.iconPath} />
    </svg>
  ),
}))

export default function DashboardMenuPage() {
  return (
    <div className="p-8 max-w-7xl mx-auto min-h-screen flex flex-col justify-center bg-[#050b14] relative">
      
      {/* 🔥 新增：左上角返回系統入口按鈕 */}
      <div className="absolute top-6 left-6">
        <NavButton href="/" direction="home" title="回系統入口" className="px-4 py-2" />
      </div>

      <div className="text-center mb-12">
        <h1 className="text-4xl font-black text-white tracking-tight mb-2">產線電子看板</h1>
        <p className="text-slate-400 font-mono uppercase tracking-widest">
          PRODUCTION DASHBOARD // READ-ONLY ACCESS
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {CATEGORIES.map((cat) => (
          <Link 
            key={cat.id} 
            href={`/dashboard/production/${cat.id}`}
            className="group relative bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden hover:border-slate-600 transition-all duration-300 hover:shadow-2xl hover:-translate-y-1 block"
          >
            {/* 背景光暈特效 */}
            <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-br ${cat.color} opacity-20 blur-3xl group-hover:opacity-30 transition-opacity rounded-full -translate-y-1/2 translate-x-1/2`}></div>
            
            <div className="p-8 relative z-10 h-full flex flex-col">
              <div className={`w-14 h-14 rounded-xl bg-gradient-to-br ${cat.color} flex items-center justify-center shadow-lg mb-6 group-hover:scale-110 transition-transform duration-300`}>
                {cat.icon}
              </div>
              
              <h2 className="text-2xl font-bold text-white mb-1 group-hover:text-cyan-400 transition-colors">
                {cat.name}
              </h2>
              <p className="text-xs font-mono text-slate-500 uppercase tracking-wider mb-4">
                {cat.eng}
              </p>
              
              <p className="text-slate-400 text-sm leading-relaxed mb-6 flex-1">
                {cat.desc}
              </p>

              <div className="flex items-center text-sm font-bold text-slate-500 group-hover:text-white transition-colors">
                <span>檢視看板</span>
                <svg className="w-4 h-4 ml-2 transform group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}