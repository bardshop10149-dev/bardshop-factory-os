// 定義六大生產區塊
//
// 這裡同時是「產線電子看板」入口頁與各區塊看板共用的設計語彙來源：
// 入口頁的卡片、以及點進去之後的排程看板，用同一組主色與圖示，
// 讓「點哪張卡片 → 進到哪個看板」在視覺上是連貫的，不會每頁各自一套配色。
export const PRODUCTION_SECTIONS = [
  {
    id: 'printing', name: '印刷', eng: 'Printing Schedule',
    desc: 'UV直噴、熱昇華、數位印刷排程監控',
    color: 'bg-blue-500', text: 'text-blue-400', border: 'border-blue-500',
    gradient: 'from-blue-600 to-cyan-600',
    accentText: 'text-cyan-300', accentBorder: 'border-cyan-600/60', accentBg: 'bg-cyan-950/30',
    iconPath: 'M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2.4-9h6.2M6 13h2m0 0l-.867 12.142A2 2 0 015.138 21H3.862a2 2 0 01-1.995-1.858L3 7m2 6h14m-2 0l.867 12.142A2 2 0 0018.862 21h1.276a2 2 0 001.995-1.858L21 7',
  },
  {
    id: 'laser', name: '雷切', eng: 'Laser Cutting',
    desc: '雷射切割、板材裁切與雕刻進度',
    color: 'bg-red-500', text: 'text-red-400', border: 'border-red-500',
    gradient: 'from-red-600 to-rose-600',
    accentText: 'text-rose-300', accentBorder: 'border-rose-600/60', accentBg: 'bg-rose-950/30',
    iconPath: 'M13 10V3L4 14h7v7l9-11h-7z',
  },
  {
    id: 'post', name: '後加工', eng: 'Post Processing',
    desc: '壓克力貼合、配件組裝、打磨',
    color: 'bg-purple-500', text: 'text-purple-400', border: 'border-purple-500',
    gradient: 'from-purple-600 to-violet-600',
    accentText: 'text-violet-300', accentBorder: 'border-violet-600/60', accentBg: 'bg-violet-950/30',
    iconPath: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  },
  {
    id: 'packaging', name: '包裝', eng: 'Packaging',
    desc: '產品包裝、貼標、出貨前準備',
    color: 'bg-orange-500', text: 'text-orange-400', border: 'border-orange-500',
    gradient: 'from-orange-500 to-amber-500',
    accentText: 'text-amber-300', accentBorder: 'border-amber-600/60', accentBg: 'bg-amber-950/30',
    iconPath: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  },
  {
    id: 'outsourced', name: '委外', eng: 'Outsourced',
    desc: '外部廠商加工進度、轉運站追蹤',
    color: 'bg-slate-500', text: 'text-slate-400', border: 'border-slate-500',
    gradient: 'from-slate-600 to-gray-500',
    accentText: 'text-slate-200', accentBorder: 'border-slate-500/60', accentBg: 'bg-slate-800/40',
    iconPath: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
  },
  {
    id: 'changping', name: '常平', eng: 'Changping Factory',
    desc: '常平廠區專屬生產與進度追蹤',
    color: 'bg-emerald-500', text: 'text-emerald-400', border: 'border-emerald-500',
    gradient: 'from-emerald-600 to-teal-600',
    accentText: 'text-emerald-300', accentBorder: 'border-emerald-600/60', accentBg: 'bg-emerald-950/30',
    iconPath: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
] as const;

export type SectionId = typeof PRODUCTION_SECTIONS[number]['id'];
export type ProductionSection = typeof PRODUCTION_SECTIONS[number];

/** 取得區塊設定；查無時回傳印刷（避免未知 id 造成畫面整個沒有樣式） */
export function getSection(id: string): ProductionSection {
  return PRODUCTION_SECTIONS.find(s => s.id === id) ?? PRODUCTION_SECTIONS[0]
}
