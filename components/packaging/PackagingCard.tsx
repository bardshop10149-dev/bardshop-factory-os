'use client'

import { useState, type ReactNode } from 'react'
import type { CardStatus, DangerFlag, PackagingCard as PackagingCardData, WorkEstimate } from '@/lib/packaging/types'
import { packingMethodText } from '@/lib/packaging/stdTime'
import {
  FLAG_LEVEL_RANK,
  FLAG_STYLES,
  PRE_STATUS_LABEL,
  PRE_STATUS_TEXT,
  QTY_CARD_LABEL,
  SOURCE_STYLES,
  STATUS_STYLES,
  fmtMinutes,
  fmtQty,
  fmtShortDate,
} from '@/components/packaging/poolStyles'

// 待排池卡片（一張卡＝一個 ARGO 品項行，D6）。
// 預設精簡：長文字（品名、備註）截兩行；按「詳細」才展開工時拆解、來源明細、其他製令。
// 外框：可包量為 0（在途／品檢中／未寄）用虛線，對應 D22「未到貨的卡以虛線框顯示」；已逾期加紅框。

/** 交期提醒已經由右上角的交期晶片表達，旗標列不重複顯示這兩個 */
const DUE_FLAG_CODES = new Set(['overdue', 'due_soon'])

/** 「預估可包日」的意義依狀態不同：在途＝寄出日＋運輸天數、品檢中＝今天（已到台）、製令＝前站計畫完工日 */
function estReadyTip(status: CardStatus): string {
  if (status === 'qc_pending') return '已到台，品檢入庫後即可包'
  if (status.startsWith('pre_station_')) return '前站計畫完工日（塔台排程）'
  return '預估可包日＝寄出日＋預設運輸工作天（尚未以實績校正）'
}

/**
 * 包裝欄拆成「包裝方式本體」與「附註」：
 * 本體與工時計算用同一個 packingMethodText()（取「-||-」前、第一段），
 * 「-||-」之後與 Tab／換行後的段落是業務附註，另外顯示，不混進「包裝」列。
 */
function splitPacking(raw: string | null): { main: string | null; extra: string | null } {
  if (!raw) return { main: null, extra: null }
  const [head, ...afterBar] = raw.split('-||-')
  const [first, ...otherSegs] = head.split(/[\t\r\n]+/)
  const extra = [...otherSegs, ...afterBar]
    .map(t => t.trim())
    .filter(t => t && !/^[.。．、,，\-_]*$/.test(t))
    .join(' / ')
  return {
    main: packingMethodText(raw) ? first.trim().replace(/\s+/g, ' ') : null,
    extra: extra || null,
  }
}

/** 訂單備註常常只是再存一次品名（remark2 約 1/4 是品名）；和品名相同或被品名包含就不顯示 */
function remarkWorthShowing(remark: string | null, itemName: string | null): string | null {
  if (!remark) return null
  const norm = (t: string) => t.replace(/\s+/g, '')
  const r = norm(remark)
  if (!r) return null
  if (itemName && norm(itemName).includes(r)) return null
  return remark
}

/** 工時拆解（詳細模式與滑過提示共用） */
export function workBreakdown(w: WorkEstimate): string[] {
  const lines: string[] = []
  for (const op of w.baseOps) lines.push(`${op.opName} ${op.perUnit} 分/件`)
  for (const a of w.addons) lines.push(`＋ ${a.label} ${a.perUnit} 分/件`)
  if (w.perUnit != null) {
    lines.push(`每件 ${w.perUnit} 分 × ${fmtQty(w.qtyBasis)} = ${w.minutes != null ? Math.round(w.minutes) : '—'} 分`)
  }
  if (w.minApplied) lines.push('未滿 10 分鐘，套用「每卡最少 10 分鐘」')
  if (w.gaps.length > 0) lines.push(`附加工時未定義（未計入）：${w.gaps.join('、')}`)
  return lines
}

function DueChip({ card, today }: { card: PackagingCardData; today: string }) {
  if (!card.dueDate) {
    return <span className="shrink-0 text-[11px] text-slate-400">交期 —</span>
  }
  const w = card.workdaysLeft
  // 逾期以日期判斷，不看工作天：交期落在週六、今天週一時 workdaysBetween 會是 0，但其實已逾期
  const overdue = card.dueDate < today
  const dueToday = card.dueDate === today
  const threshold = card.sample.isSample ? 3 : 5
  const tone = overdue || dueToday
    ? 'border-red-500/80 bg-red-600/25 text-red-100'
    : w != null && w <= threshold
      ? 'border-orange-500/70 bg-orange-600/15 text-orange-200'
      : 'border-slate-700 bg-slate-800/60 text-slate-300'
  const sub = overdue
    ? (w != null && w < 0 ? `逾期 ${-w} 工作天` : '已逾期')
    : dueToday ? '今天到期' : w != null ? `剩 ${w} 工作天` : ''
  const tip = card.flags.filter(f => DUE_FLAG_CODES.has(f.code)).map(f => f.label).join('；')
  return (
    <span
      title={`ERP 品項行交期 ${card.dueDate}${tip ? `｜${tip}` : ''}（台灣工作天，含國定假日）`}
      className={`shrink-0 rounded border px-1.5 py-0.5 text-right leading-tight ${tone}`}
    >
      <span className="block text-[11px] font-semibold whitespace-nowrap">交期 {fmtShortDate(card.dueDate, today)}</span>
      {sub && <span className="block text-[10px] whitespace-nowrap">{sub}</span>}
    </span>
  )
}

/** 標籤＋可截斷文字（備註類）：精簡模式兩行，詳細模式全文保留換行 */
function LabeledText({ label, labelCls, text, expanded }: { label: string; labelCls: string; text: string; expanded: boolean }) {
  return (
    <div className="flex items-start gap-1.5 min-w-0">
      <span className={`shrink-0 mt-px rounded px-1 text-[10px] leading-4 border ${labelCls}`}>{label}</span>
      <span
        title={expanded ? undefined : text}
        className={`min-w-0 break-words text-slate-300 ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}
      >{text}</span>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 min-w-0">
      <span className="shrink-0 w-8 text-[10px] leading-5 text-slate-400">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export default function PackagingCard({ card, today, onOpenOrder, changpingSyncLabel }: {
  card: PackagingCardData
  /** 台北今天 YYYY-MM-DD（由 API 回傳，與伺服器判定一致） */
  today: string
  onOpenOrder: (so: string) => void
  /** 常平卡角落顯示的「常平資料更新於」（D37）；只在 sourceKind＝常平時顯示 */
  changpingSyncLabel?: string
}) {
  const [expanded, setExpanded] = useState(false)

  const overdue = card.dueDate != null && card.dueDate < today
  const notReady = card.qtyReady <= 0
  const frame = overdue
    ? 'border-red-500/70 ring-1 ring-red-500/30'
    : 'border-slate-700/80'

  const flags: DangerFlag[] = card.flags
    .filter(f => !(card.dueDate && DUE_FLAG_CODES.has(f.code)))
    .sort((a, b) => FLAG_LEVEL_RANK[a.level] - FLAG_LEVEL_RANK[b.level])

  const { main: packing, extra: packingExtra } = splitPacking(card.packing)
  const orderRemark = remarkWorthShowing(card.orderRemark, card.itemName)
  const work = card.work
  const breakdown = workBreakdown(work)
  const pre = card.preStation
  const etaPassed = card.flags.some(f => f.code === 'eta_passed')
  const qtyLabel = QTY_CARD_LABEL[card.status]

  return (
    <article
      className={`min-w-0 rounded-lg border bg-slate-900/80 px-2.5 py-2 text-xs leading-snug text-slate-300 ${notReady ? 'border-dashed' : ''} ${frame}`}
    >
      {/* ── 第一列：狀態、打樣、SO 單號（點開詳情）｜交期 ── */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className={`rounded border px-1.5 py-px text-[10px] font-semibold ${STATUS_STYLES[card.status]}`}>
              {card.statusLabel}
            </span>
            {card.sample.isSample && (
              <span
                title={card.sample.reason === 'sheet_doc_type'
                  ? '出單表單據種類＝打樣單'
                  : '品名含「打樣」（含打樣費行）；品名備註提到打樣的大貨也會被抓到，請確認'}
                className="rounded border border-fuchsia-500/70 bg-fuchsia-900/40 px-1.5 py-px text-[10px] font-bold text-fuchsia-200"
              >打樣類{card.sample.reason === 'line_name' ? '・品名' : ''}</span>
            )}
            {card.sourceKind === 'changping' && changpingSyncLabel && (
              <span
                title="常平黃底出貨資料的最後同步時間（目前每晚一次）；之後才寄出的貨，這張卡還不會反映"
                className="ml-auto text-[10px] text-slate-400"
              >{changpingSyncLabel}</span>
            )}
            {card.split && (
              <span
                title="同一 SO 行因部分入庫／部分在途拆成多張卡，數量合計＝原數量"
                className="rounded border border-slate-600 bg-slate-800 px-1 py-px text-[10px] text-slate-300"
              >拆 {card.split.index}/{card.split.total}</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 min-w-0">
            <button
              type="button"
              onClick={() => onOpenOrder(card.so)}
              title="開啟訂單詳情（全部品項＋示意圖）"
              className="font-mono text-[13px] font-semibold text-sky-300 hover:text-sky-200 hover:underline"
            >
              {card.so}{card.soLine ? <span className="text-slate-400">-{card.soLine}</span> : null}
            </button>
            {card.hasSketch && (
              <button
                type="button"
                onClick={() => onOpenOrder(card.so)}
                title="出單表有這一行的示意圖，點開訂單詳情查看"
                className="rounded border border-fuchsia-700/50 bg-fuchsia-950/40 px-1 text-[10px] text-fuchsia-300 hover:bg-fuchsia-900/50"
              >示意圖</button>
            )}
            {card.customer && <span className="min-w-0 truncate text-slate-400" title={card.customer}>{card.customer}</span>}
          </div>
        </div>
        <DueChip card={card} today={today} />
      </div>

      {/* ── 危險旗標：放在最上方，紅色優先 ── */}
      {flags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {flags.map(f => (
            <span key={f.code} title={f.label} className={`rounded border px-1.5 py-px text-[10px] ${FLAG_STYLES[f.level]}`}>
              {f.level === 'danger' ? '⚠ ' : ''}{f.label}
            </span>
          ))}
        </div>
      )}

      {/* ── 品名規格 ── */}
      <div className="mt-1.5 min-w-0">
        <p
          title={expanded ? undefined : card.itemName ?? ''}
          className={`break-words text-[13px] text-slate-100 ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}
        >{card.itemName || <span className="text-slate-400">（無品名）</span>}</p>
        {card.itemCode && <p className="font-mono text-[10px] text-slate-400 break-all">{card.itemCode}</p>}
      </div>

      <div className="mt-1.5 space-y-1">
        {/* 包裝方式 */}
        {(packing || packingExtra) && (
          <Row label="包裝">
            {packing && (
              <span
                title={expanded ? undefined : packing}
                className={`break-words text-amber-100/90 ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}
              >{packing}</span>
            )}
            {packingExtra && (expanded ? (
              <span className="block break-words text-slate-400">包裝欄附註：{packingExtra}</span>
            ) : (
              <span title={`包裝欄附註：${packingExtra}`} className="ml-1 text-[10px] text-slate-400">＋附註</span>
            ))}
          </Row>
        )}

        {/* 數量：可包量／總量；本卡數量意義依狀態不同（在途、品檢中、未寄…） */}
        <Row label="數量">
          <div className="flex flex-wrap items-baseline gap-x-2 leading-5">
            <span>
              可包 <b className={`text-sm ${card.qtyReady > 0 ? 'text-lime-300' : 'text-slate-400'}`}>{fmtQty(card.qtyReady)}</b>
              <span className="text-slate-400"> / 總量 {fmtQty(card.qtyTotal)}{card.unit ? ` ${card.unit}` : ''}</span>
            </span>
            {card.qtyCard !== card.qtyReady && (
              <span className="text-slate-400">{qtyLabel} <b className="text-slate-200">{fmtQty(card.qtyCard)}</b></span>
            )}
            {card.receivedQty != null && card.receivedQty > 0 && (
              <span className="text-slate-400" title="ARGO 已入庫量（入庫＝品檢完成，不是包裝完成）">已入庫 {fmtQty(card.receivedQty)}</span>
            )}
          </div>
        </Row>

        {/* 寄出／預估可包日 */}
        {(card.ship || card.estReadyDate) && (
          <Row label="到貨">
            <div className="flex flex-wrap items-baseline gap-x-2 leading-5">
              {card.ship && (
                <span className="text-slate-400">
                  {card.ship.method ?? '寄法未知'}
                  {card.ship.shippedAt ? ` · ${fmtShortDate(card.ship.shippedAt, today)} 寄出` : ''}
                  {card.ship.transitWorkdays != null ? ` · 運輸 ${card.ship.transitWorkdays} 工作天` : ''}
                </span>
              )}
              {card.estReadyDate && (
                <span
                  title={estReadyTip(card.status)}
                  className={`font-semibold ${etaPassed ? 'text-orange-300' : 'text-emerald-300'}`}
                >預估可包 {fmtShortDate(card.estReadyDate, today)}{etaPassed ? '（已過，仍未入庫）' : ''}</span>
              )}
            </div>
          </Row>
        )}

        {/* 工時與來源說明 */}
        <Row label="工時">
          <div className="flex flex-wrap items-baseline gap-x-1.5 leading-5 min-w-0">
            <span
              title={work.minutes != null ? `${Math.round(work.minutes)} 分鐘（1 人）` : '對不到途程與品類，工時未知'}
              className={`shrink-0 rounded px-1.5 font-semibold ${work.minutes == null
                ? 'bg-orange-600/20 text-orange-200'
                : 'bg-amber-500/15 text-amber-200'}`}
            >{fmtMinutes(work.minutes)}</span>
            {/* 工時未知時左邊晶片已寫「工時未知」，說明文字若只是同一句就不重複 */}
            {work.explain && work.explain !== fmtMinutes(work.minutes) && (
              <span title={breakdown.join('\n')} className={`min-w-0 break-words text-slate-400 ${expanded ? '' : 'line-clamp-1'}`}>
                {work.explain}{work.minApplied ? '（最少 10 分）' : ''}
              </span>
            )}
            {work.gaps.length > 0 && !expanded && (
              <span title={`附加工時未定義（未計入）：${work.gaps.join('、')}`} className="text-[10px] text-orange-300">缺附加工時</span>
            )}
          </div>
          {expanded && breakdown.length > 0 && (
            <ul className="mt-1 space-y-px rounded bg-slate-950/60 px-2 py-1 text-[11px] text-slate-400">
              {breakdown.map((l, i) => <li key={i} className="break-words">{l}</li>)}
            </ul>
          )}
        </Row>

        {/* 製令＋前站（區塊 4 / 4x） */}
        {pre && (
          <Row label="製令">
            <div className="rounded border border-violet-800/40 bg-violet-950/20 px-1.5 py-1 leading-5">
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-mono text-violet-200">{pre.moNbr}</span>
                {pre.lotNbr && <span className="text-[10px] text-slate-400">批 {pre.lotNbr}</span>}
              </div>
              {pre.station ? (
                <div className="break-words">
                  <span className="text-slate-400">前站：</span>
                  <span className="text-slate-200">{pre.station}</span>
                  {pre.jobName && <span className="text-slate-400">・{pre.jobName}</span>}
                  <span className="text-slate-400">
                    {' '}已報 <b className="text-slate-100">{fmtQty(pre.reportedQty)}</b> / 應做 {fmtQty(pre.requiredQty)}
                  </span>
                  {pre.status && <span className={`ml-1 font-semibold ${PRE_STATUS_TEXT[pre.status]}`}>· {PRE_STATUS_LABEL[pre.status]}</span>}
                  {pre.parallel && <span className="ml-1 text-[10px] text-orange-300" title="同序號有多道不同工作站的工序（平行鏈），狀態取最落後者、可包量取最小值">平行</span>}
                </div>
              ) : (
                <div className="text-rose-300">無前站（途程只有包裝站）</div>
              )}
              {pre.packagingJobs.length > 0 && (
                <div className="break-words text-slate-400">
                  <span className="text-slate-400">包裝：</span>
                  {pre.packagingJobs.map((j, i) => (
                    <span key={`${j.jobName}-${i}`}>
                      {i > 0 ? '、' : ''}{j.jobName}
                      <span className={PRE_STATUS_TEXT[j.status]}> {PRE_STATUS_LABEL[j.status]}</span>
                      {j.reportedQty != null && j.reportedQty > 0 ? ` 已報 ${fmtQty(j.reportedQty)}` : ''}
                    </span>
                  ))}
                </div>
              )}
              {pre.otherMos.length > 0 && (
                <div className="break-words text-[10px] text-slate-400" title="erp_mo_lines 同 SO 同品號的其他製令（補印、MOS 後綴），僅供參考">
                  同行其他製令：{expanded ? pre.otherMos.join('、') : `${pre.otherMos.slice(0, 2).join('、')}${pre.otherMos.length > 2 ? ` 等 ${pre.otherMos.length} 張` : ''}`}
                </div>
              )}
            </div>
          </Row>
        )}

        {/* 來源標籤（常平／委外／自製＋單號） */}
        {card.sources.length > 0 && (
          <Row label="來源">
            <div className="flex flex-wrap gap-1">
              {card.sources.map((s, i) => (
                <span
                  key={`${s.docNo}-${s.lineNo ?? ''}-${i}`}
                  title={`${SOURCE_STYLES[s.kind].label} ${s.docType} ${s.docNo}${s.lineNo ? ` 第 ${s.lineNo} 行` : ''}｜塔台批：${s.saraMo ?? '對不到'}｜本卡數量 ${fmtQty(s.qty)}`}
                  className={`inline-flex max-w-full items-baseline gap-1 rounded border px-1 text-[10px] leading-4 ${SOURCE_STYLES[s.kind].chip}`}
                >
                  <span className="font-semibold">{SOURCE_STYLES[s.kind].label}</span>
                  <span className="font-mono break-all">{s.docNo}{s.lineNo ? `-${s.lineNo}` : ''}</span>
                  {(card.sources.length > 1 || expanded) && <span className="opacity-70">×{fmtQty(s.qty)}</span>}
                  {expanded && s.saraMo && s.saraMo !== `${s.docNo}${s.lineNo ? `-${s.lineNo}` : ''}` && (
                    <span className="font-mono opacity-70">塔台 {s.saraMo}</span>
                  )}
                </span>
              ))}
            </div>
          </Row>
        )}

        {/* 備註：常平出貨（只有【常平出貨】那一行）＋訂單備註 */}
        {card.cpShipNote && (
          <LabeledText
            label="常平出貨"
            labelCls="border-emerald-700/60 bg-emerald-950/50 text-emerald-300"
            text={card.cpShipNote}
            expanded={expanded}
          />
        )}
        {orderRemark && (
          <LabeledText
            label="訂單備註"
            labelCls="border-slate-600 bg-slate-800 text-slate-300"
            text={orderRemark}
            expanded={expanded}
          />
        )}
      </div>

      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >{expanded ? '收合 ▴' : '詳細 ▾'}</button>
      </div>
    </article>
  )
}
