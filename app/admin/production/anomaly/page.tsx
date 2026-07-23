'use client'

import Link from 'next/link'
import { NavButton } from '../../../../components/NavButton'

export default function QaZonePage() {
  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto min-h-screen space-y-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">品保專區</h1>
          <p className="text-teal-400 mt-1 font-mono text-sm uppercase">QUALITY ASSURANCE // 異常提報與紀錄追蹤</p>
        </div>
        <NavButton href="/" direction="home" title="回到首頁" className="px-3 py-2" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        <Link
          href="/qa/records"
          className="group rounded-2xl border border-slate-700 bg-slate-900/50 p-6 hover:border-cyan-500 hover:bg-slate-800/60 transition-all"
        >
          <div className="mb-4 inline-flex p-3 rounded-full bg-slate-800 group-hover:bg-cyan-900/40 text-slate-300 group-hover:text-cyan-300 transition-colors">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white mb-2 group-hover:text-cyan-300">異常紀錄表</h2>
          <p className="text-slate-400 text-sm">查看待處理/已處理回報，並執行確認結案。</p>
          <p className="text-xs text-cyan-400 font-mono mt-4">VIEW RECORDS →</p>
        </Link>

        <Link
          href="/qa/options"
          className="group rounded-2xl border border-slate-700 bg-slate-900/50 p-6 hover:border-fuchsia-500 hover:bg-slate-800/60 transition-all"
        >
          <div className="mb-4 inline-flex p-3 rounded-full bg-slate-800 group-hover:bg-fuchsia-900/40 text-slate-300 group-hover:text-fuchsia-300 transition-colors">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M7 12h10m-7 6h4" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white mb-2 group-hover:text-fuchsia-300">下拉選項管理</h2>
          <p className="text-slate-400 text-sm">統一管理回報人、處理人、分類與缺失人員選項。</p>
          <p className="text-xs text-fuchsia-400 font-mono mt-4">MANAGE OPTIONS →</p>
        </Link>

        <Link
          href="/qa/upload"
          className="group rounded-2xl border border-slate-700 bg-slate-900/50 p-6 hover:border-amber-500 hover:bg-slate-800/60 transition-all"
        >
          <div className="mb-4 inline-flex p-3 rounded-full bg-slate-800 group-hover:bg-amber-900/40 text-slate-300 group-hover:text-amber-300 transition-colors">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 16V4m0 12l-3-3m3 3l3-3M4 20h16" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white mb-2 group-hover:text-amber-300">批量上傳異常單</h2>
          <p className="text-slate-400 text-sm">匯入 CSV 並預覽內容，批次建立異常回報資料。</p>
          <p className="text-xs text-amber-400 font-mono mt-4">BATCH IMPORT →</p>
        </Link>

        <Link
          href="/qa/analytics"
          className="group rounded-2xl border border-slate-700 bg-slate-900/50 p-6 hover:border-emerald-500 hover:bg-slate-800/60 transition-all"
        >
          <div className="mb-4 inline-flex p-3 rounded-full bg-slate-800 group-hover:bg-emerald-900/40 text-slate-300 group-hover:text-emerald-300 transition-colors">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3v18h18M8 14l3-3 3 2 4-5" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white mb-2 group-hover:text-emerald-300">異常統計分析</h2>
          <p className="text-slate-400 text-sm">以日期區間分析異常原因與相關人員的比例分布。</p>
          <p className="text-xs text-emerald-400 font-mono mt-4">OPEN ANALYTICS →</p>
        </Link>

        <Link
          href="/qa/personnel-stats"
          className="group rounded-2xl border border-slate-700 bg-slate-900/50 p-6 hover:border-rose-500 hover:bg-slate-800/60 transition-all"
        >
          <div className="mb-4 inline-flex p-3 rounded-full bg-slate-800 group-hover:bg-rose-900/40 text-slate-300 group-hover:text-rose-300 transition-colors">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white mb-2 group-hover:text-rose-300">異常人員缺失單處理作業</h2>
          <p className="text-slate-400 text-sm">查詢缺失紀錄、批量修改處置並列印品質異常處理單。</p>
          <p className="text-xs text-rose-400 font-mono mt-4">PERSONNEL STATS →</p>
        </Link>
      </div>
    </div>
  )
}
