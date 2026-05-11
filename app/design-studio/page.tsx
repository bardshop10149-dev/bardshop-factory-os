'use client'

import Link from 'next/link'

const SECTIONS = [
  {
    href: '/design-studio/crm-cross',
    label: '美編比對',
    sublabel: 'CRM × 訂單交叉比對',
    desc: '將 CRM 待完成表格與訂單明細對比，依品項編碼批次整理。',
    tag: 'CROSS MATCH',
    color: 'pink',
    icon: (
      <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    ),
  },
  {
    href: '/design-studio/so-query',
    label: '銷售訂單查詢',
    sublabel: 'SO Line Items',
    desc: '依訂單號/客戶/品項搜尋 ERP 銷售訂單明細，快速查詢交期與數量。',
    tag: 'SO QUERY',
    color: 'cyan',
    icon: (
      <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
]

const colorMap: Record<string, { border: string; hover: string; shadow: string; tag: string; icon: string; btn: string; text: string }> = {
  pink: {
    border: 'border-slate-700 hover:border-pink-500',
    hover: 'hover:shadow-[0_0_30px_rgba(236,72,153,0.15)] hover:bg-slate-800/60',
    shadow: '',
    tag: 'bg-pink-500/10 border-pink-500/20 text-pink-400',
    icon: 'group-hover:bg-pink-900/50 group-hover:text-pink-400',
    btn: 'group-hover:bg-pink-600 group-hover:border-pink-600 group-hover:text-white border-slate-600 text-slate-300',
    text: 'group-hover:text-pink-400',
  },
  cyan: {
    border: 'border-slate-700 hover:border-cyan-500',
    hover: 'hover:shadow-[0_0_30px_rgba(34,211,238,0.15)] hover:bg-slate-800/60',
    shadow: '',
    tag: 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400',
    icon: 'group-hover:bg-cyan-900/50 group-hover:text-cyan-400',
    btn: 'group-hover:bg-cyan-600 group-hover:border-cyan-600 group-hover:text-white border-slate-600 text-slate-300',
    text: 'group-hover:text-cyan-400',
  },
}

export default function DesignStudioHubPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-8">
      {/* Back */}
      <div className="w-full max-w-3xl mb-6">
        <Link href="/" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
          ← 返回首頁
        </Link>
      </div>

      {/* Title */}
      <div className="text-center mb-10 w-full max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-[0.3em] text-pink-500 mb-2">Design Studio</p>
        <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">美編天地</h1>
        <p className="text-slate-500 text-sm">選擇功能分區</p>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-3xl">
        {SECTIONS.map((s) => {
          const c = colorMap[s.color]
          return (
            <Link
              key={s.href}
              href={s.href}
              className={`group relative h-64 rounded-2xl border bg-slate-900/40 backdrop-blur-sm
                flex flex-col items-center justify-center text-center p-8 transition-all duration-500 cursor-pointer
                ${c.border} ${c.hover}`}
            >
              {/* Tag */}
              <div className={`absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 rounded border ${c.tag}`}>
                <span className="text-[10px] font-bold uppercase tracking-wider">{s.tag}</span>
              </div>

              {/* Icon */}
              <div className={`mb-5 p-4 rounded-full bg-slate-800 text-slate-400 transition-colors ${c.icon}`}>
                {s.icon}
              </div>

              {/* Label */}
              <h2 className={`text-xl font-bold text-white mb-1 transition-colors ${c.text}`}>{s.label}</h2>
              <p className="text-slate-500 text-xs mb-5 px-2">{s.desc}</p>

              <span className={`px-4 py-2 rounded border text-xs font-mono transition-all ${c.btn}`}>
                {s.sublabel} &rarr;
              </span>
            </Link>
          )
        })}
      </div>
    </main>
  )
}
