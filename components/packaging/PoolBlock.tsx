'use client'

import { useState, type ReactNode } from 'react'
import type { PackagingCard as PackagingCardData, PoolBlock as PoolBlockData } from '@/lib/packaging/types'
import PackagingCard from '@/components/packaging/PackagingCard'
import { BLOCK_TONE, TONE_STYLES, fmtHours } from '@/components/packaging/poolStyles'

// 待排池的一個區塊：標題列（卡數、工時合計、逾期／打樣／工時未知計數）＋卡片清單。
// 標題列的數字一律用 API 算好的整區合計（不受篩選影響），篩選時另外顯示「符合 x 張」。

/** 一次先畫這麼多張，其餘按「顯示更多」——委外已入庫區可能上百張，一口氣全畫手機會卡 */
const PAGE = 40

/** 4x「複製清單」的 TSV（D35：給 Snow 查塔台工序是否設錯） */
function buildNoPreStationTsv(cards: PackagingCardData[]): string {
  const clean = (v: string | number | null | undefined) =>
    v == null ? '' : String(v).replace(/[\t\r\n]+/g, ' ').trim()
  const header = ['製令', 'SO', '項次', '品號', '品名', '包裝工序', '數量']
  const rows = cards.map(c => [
    c.preStation?.moNbr ?? c.sources.find(s => s.kind === 'inhouse')?.docNo ?? '',
    c.so,
    c.soLine ?? '',
    c.itemCode ?? '',
    c.itemName ?? '',
    (c.preStation?.packagingJobs ?? []).map(j => j.jobName).join('、'),
    c.qtyCard,
  ].map(clean).join('\t'))
  return [header.join('\t'), ...rows].join('\n')
}

/** 寫入剪貼簿；舊瀏覽器或非安全來源（http 內網 IP）沒有 navigator.clipboard 時退回 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 退回下面的舊做法 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export default function PoolBlock({ block, cards, filtered, collapsed, onToggle, onOpenOrder, today, notice, changpingSyncLabel, wide = false }: {
  block: PoolBlockData
  /** 篩選、排序後要顯示的卡（未篩選時＝block.cards） */
  cards: PackagingCardData[]
  /** 目前是否有關鍵字／焦點篩選 */
  filtered: boolean
  collapsed: boolean
  onToggle: () => void
  onOpenOrder: (so: string) => void
  today: string
  /** 區塊標題下方的提示列（例：區塊 3「出貨燈可能誤亮」）；不隨卡片清單收合 */
  notice?: ReactNode
  /** 常平卡角落的「常平資料更新於」文字（D37） */
  changpingSyncLabel?: string
  /** 整列寬的區塊（ns）：桌機卡片排三欄，不像欄內區塊只排一欄 */
  wide?: boolean
}) {
  const [limit, setLimit] = useState(PAGE)
  const [copyMsg, setCopyMsg] = useState('')
  const tone = TONE_STYLES[BLOCK_TONE[block.id]]
  const empty = block.cardCount === 0

  const handleCopy = async () => {
    const ok = await copyText(buildNoPreStationTsv(block.cards))
    setCopyMsg(ok ? `已複製 ${block.cards.length} 筆（可直接貼到 Excel）` : '複製失敗（瀏覽器不允許存取剪貼簿）')
    setTimeout(() => setCopyMsg(''), 3000)
  }

  const shown = cards.slice(0, limit)

  return (
    <section
      id={`pool-block-${block.id}`}
      className={`scroll-mt-4 min-w-0 overflow-hidden rounded-xl border ${tone.border} bg-slate-950/40 ${empty && !notice ? 'opacity-70' : ''}`}
    >
      {/* ── 標題列（點擊折疊） ── */}
      <div className={`relative ${tone.headerBg}`}>
        <span className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} aria-hidden />
        <button
          type="button"
          onClick={onToggle}
          disabled={empty}
          aria-expanded={!collapsed}
          className="w-full pl-3.5 pr-3 py-2 text-left disabled:cursor-default"
        >
          <div className="flex items-start gap-2">
            <span className={`mt-0.5 shrink-0 rounded bg-slate-950/60 px-1.5 font-mono text-[11px] font-bold ${tone.title}`}>{block.id}</span>
            <div className="min-w-0 flex-1">
              <h3 className={`text-sm font-bold leading-tight ${tone.title}`}>{block.title}</h3>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{block.hint}</p>
            </div>
            {!empty && (
              <span className="shrink-0 pt-0.5 text-[11px] text-slate-400">{collapsed ? '展開 ▾' : '收合 ▴'}</span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-0.5 text-[11px]">
            <span className="text-slate-200">
              <b className="text-base leading-none">{block.cardCount}</b> 張
              {/* 篩選時標明實際顯示幾張（標題數字仍是整區合計） */}
              {!empty && (filtered || cards.length !== block.cardCount) && (
                <span className="ml-1 text-sky-300">（顯示 {cards.length}／共 {block.cardCount}）</span>
              )}
            </span>
            <span className="text-amber-200" title="已知工時合計（1 人，分鐘換算小時）">
              工時 <b className="text-sm leading-none">{fmtHours(block.totalMinutes)}</b> 小時
            </span>
            {block.unknownMinutesCards > 0 && (
              <span className="text-orange-300" title="這些卡對不到途程與品類，未計入工時合計">工時未知 {block.unknownMinutesCards}</span>
            )}
            {block.overdueCount > 0 && <span className="font-semibold text-red-300">逾期 {block.overdueCount}</span>}
            {block.sampleCount > 0 && <span className="text-fuchsia-300">打樣類 {block.sampleCount}</span>}
            {empty && <span className="text-slate-400">目前沒有卡片</span>}
          </div>
        </button>
        {block.id === '4x' && !empty && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-800/60 pl-3.5 pr-3 py-1.5">
            <button
              type="button"
              onClick={() => void handleCopy()}
              title="複製 TSV：製令、SO、項次、品號、品名、包裝工序、數量"
              className="rounded border border-rose-700/60 bg-rose-950/50 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-900/60"
            >複製清單（{block.cards.length} 筆）</button>
            {copyMsg && <span className="text-[11px] text-slate-300">{copyMsg}</span>}
          </div>
        )}
      </div>

      {notice && <div className={`px-2 pt-2 ${collapsed || empty ? 'pb-2' : ''}`}>{notice}</div>}

      {/* ── 卡片 ── */}
      {!collapsed && !empty && (
        <div className="p-2">
          {cards.length === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-slate-400">沒有符合篩選條件的卡片</p>
          ) : (
            // 手機單欄；平板（整頁單欄）卡片兩欄；桌機（整頁三欄、每欄窄）又回到單欄；整列寬區塊桌機排三欄
            <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${wide ? 'lg:grid-cols-3' : 'lg:grid-cols-1'}`}>
              {shown.map(c => (
                <PackagingCard key={c.cardId} card={c} today={today} onOpenOrder={onOpenOrder} changpingSyncLabel={changpingSyncLabel} />
              ))}
            </div>
          )}
          {cards.length > shown.length && (
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => setLimit(l => l + PAGE)}
                className="rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-300 hover:text-white"
              >再顯示 {Math.min(PAGE, cards.length - shown.length)} 張</button>
              <button
                type="button"
                onClick={() => setLimit(cards.length)}
                className="rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-400 hover:text-white"
              >全部顯示（剩 {cards.length - shown.length}）</button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
