'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// 業務訂單修改 LOG（唯讀顯示）
//
// 資料來自 /api/argoerp/so-edit-log：把既有 5 分鐘增量同步寫下的 erp_change_log
// 翻成人話，並即時向 ARGO 補查「誰改的（UPDATE_BY）、幾點改的（UPDATE_DATE）」。
// 這個分頁不觸發任何同步、不寫任何資料。
// ─────────────────────────────────────────────────────────────────────────────

interface LineImpact {
  dispatchState: string
  moNumbers: string[]
  matchConfidence: '雙重吻合' | '僅末碼' | '僅料號' | '對不到此行' | '未發單'
  progress: number | null
  warnings: string[]
  running: Array<{ station: string; job: string; status: string; qty: number | null; done: number | null; resource: string | null }>
  stations: string[]
  stationsPredicted: boolean
  /** 這張訂單目前有幾張工單行號已失效 */
  misalignedMos: number
}

interface Props {
  /** 點「工單行號失效」標記時，跳到「工單對位體檢」並篩選該訂單 */
  onInspectOrder?: (docNo: string) => void
}

interface EditLogEntry {
  key: string
  groupKey: string
  at: string
  empNo: string
  empName: string
  action: '新增' | '修改' | '刪除'
  docNo: string
  lineNo: string
  salesName: string
  field: string
  fieldLabel: string
  oldValue: string | null
  newValue: string | null
  approximate: boolean
  detectedAt: string
  impact: LineImpact
  notify: { target: string; note: string }
}

/** 通知對象的顏色 */
const NOTIFY_STYLE: Record<string, string> = {
  全廠: 'bg-red-900/60 text-red-300 border-red-700/50',
  財務部門: 'bg-sky-900/50 text-sky-300 border-sky-700/50',
  美編部門: 'bg-slate-800 text-slate-400 border-slate-700',
}

/** 一頁最多幾筆（以「一次操作」為單位換算，不會把同一次操作拆到兩頁） */
const PAGE_SIZE = 100

/** 發單狀態的顏色：愈後面代表改單的殺傷力愈大 */
const STATE_STYLE: Record<string, string> = {
  未發單: 'bg-slate-800 text-slate-400 border-slate-700',
  該單已發單: 'bg-slate-800 text-slate-300 border-slate-600',
  已開製令: 'bg-sky-900/60 text-sky-300 border-sky-700/50',
  已發單上傳: 'bg-amber-900/50 text-amber-300 border-amber-700/50',
  已備料: 'bg-orange-900/60 text-orange-300 border-orange-700/50',
  生產中: 'bg-red-900/70 text-red-300 border-red-600/60',
}

/** 排序權重：愈危險排愈前面 */
const STATE_RANK: Record<string, number> = {
  生產中: 5, 已備料: 4, 已發單上傳: 3, 已開製令: 2, 該單已發單: 1, 未發單: 0,
}

/** 一次操作超過這麼多筆變更就預設收起來 */
const COLLAPSE_OVER = 4
/** 收起時仍先露出的筆數 */
const PEEK_ROWS = 2

const DAY_OPTIONS = [
  { value: 1, label: '近 1 天' },
  { value: 3, label: '近 3 天' },
  { value: 7, label: '近 7 天' },
  { value: 14, label: '近 14 天' },
]

const ACTION_STYLE: Record<string, string> = {
  新增: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/50',
  修改: 'bg-amber-900/60 text-amber-300 border-amber-700/50',
  刪除: 'bg-red-900/60 text-red-300 border-red-700/50',
}

/** 多行內容壓成一行顯示，過長截斷（滑鼠移上去看全文） */
function preview(v: string | null, max = 46): string {
  if (v === null || v === '') return '(空白)'
  const s = v.replace(/\s*\n\s*/g, ' ⏎ ')
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** '2026/08/25 17:57:32' → { date:'2026/08/25', time:'17:57' } */
function splitAt(at: string): { date: string; time: string } {
  const m = at.match(/^(\d{4}[/-]\d{2}[/-]\d{2})[ T](\d{2}:\d{2})/)
  if (m) return { date: m[1].replace(/-/g, '/'), time: m[2] }
  return { date: at.slice(0, 10), time: at.slice(11, 16) }
}

export default function SoEditLogCard({ onInspectOrder }: Props) {
  const [days, setDays] = useState(3)
  const [entries, setEntries] = useState<EditLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [actionFilter, setActionFilter] = useState<'全部' | '新增' | '修改' | '刪除'>('全部')
  const [riskOnly, setRiskOnly] = useState(false)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  /** 非 null＝紀錄筆數達上限，只讀到這個時間點為止，更舊的沒顯示 */
  const [truncated, setTruncated] = useState<string | null>(null)
  /** 已展開的操作（groupKey），其餘超過門檻者維持收合 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      // 每天的變動量約 500 筆，筆數不夠會讀不到較舊的紀錄（發單狀態會誤判成未發單）
      const limit = Math.min(days * 700, 8000)
      const res = await fetch(`/api/argoerp/so-edit-log?days=${days}&limit=${limit}`)
      const json = await res.json() as {
        status: string; entries?: EditLogEntry[]; error?: string
        truncated?: boolean; oldestScanned?: string | null
      }
      if (json.status !== 'ok') throw new Error(json.error ?? '讀取失敗')
      setEntries(json.entries ?? [])
      setTruncated(json.truncated ? (json.oldestScanned ?? '') : null)
      setLoadedAt(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = entries.filter((e) => {
      if (actionFilter !== '全部' && e.action !== actionFilter) return false
      if (riskOnly && (STATE_RANK[e.impact.dispatchState] ?? 0) < 3) return false
      if (!q) return true
      return [e.docNo, e.empNo, e.empName, e.salesName, e.fieldLabel, e.oldValue, e.newValue,
        e.impact.dispatchState, ...e.impact.stations]
        .some((v) => v && String(v).toLowerCase().includes(q))
    })
    // 只看高風險時改成「危險的排前面」，否則維持時間序（新→舊）
    return riskOnly
      ? [...list].sort((a, b) =>
        (STATE_RANK[b.impact.dispatchState] ?? 0) - (STATE_RANK[a.impact.dispatchState] ?? 0))
      : list
  }, [entries, search, actionFilter, riskOnly])

  const stats = useMemo(() => ({
    新增: entries.filter((e) => e.action === '新增').length,
    修改: entries.filter((e) => e.action === '修改').length,
    刪除: entries.filter((e) => e.action === '刪除').length,
    人數: new Set(entries.map((e) => e.empNo).filter(Boolean)).size,
    // 已發單上傳以後才改的（＝料可能已經領了、甚至已經在做）
    風險: new Set(entries.filter((e) => (STATE_RANK[e.impact.dispatchState] ?? 0) >= 3)
      .map((e) => `${e.docNo}|${e.lineNo}`)).size,
    生產中: new Set(entries.filter((e) => e.impact.dispatchState === '生產中')
      .map((e) => `${e.docNo}|${e.lineNo}`)).size,
  }), [entries])

  const exportCsv = useCallback(() => {
    const head = ['異動時間', '工號', '姓名', '動作', '訂單號', '行號', '修改位置', '原內容', '新內容',
      '訂單業務員', '應通知', '通知原因', '發單狀態', '對應製令', '對應可信度', '塔台進度%', '進行中工序', '影響單位', '偵測時間']
    const body = filtered.map((e) => [
      e.at, e.empNo, e.empName, e.action, e.docNo, e.lineNo, e.fieldLabel,
      e.oldValue ?? '', e.newValue ?? '', e.salesName,
      e.notify.target, e.notify.note,
      e.impact.dispatchState,
      e.impact.moNumbers.join(' '),
      e.impact.matchConfidence,
      e.impact.progress ?? '',
      e.impact.running.map((r) => `${r.station}/${r.job}(${r.status})`).join(' '),
      (e.impact.stationsPredicted ? '預估 ' : '') + e.impact.stations.join(' → '),
      e.detectedAt,
    ])
    const csv = [head, ...body]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `業務訂單修改LOG_近${days}天.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [filtered, days])

  // 同一人、同一張單、同一秒 = 同一次操作 → 視覺上併成一組。
  // id 用該組第一列的 key：groupKey 在不連續的位置可能重複出現，
  // 拿它當展開狀態的識別會讓兩組連動、數量也對不上。
  const groups = useMemo(() => {
    const out: { id: string; groupKey: string; rows: EditLogEntry[] }[] = []
    for (const e of filtered) {
      const last = out[out.length - 1]
      if (last && last.groupKey === e.groupKey) last.rows.push(e)
      else out.push({ id: e.key, groupKey: e.groupKey, rows: [e] })
    }
    return out
  }, [filtered])

  /** 會被收合的操作（供「全部展開／收合」用） */
  const collapsibleKeys = useMemo(
    () => groups.filter((g) => g.rows.length > COLLAPSE_OVER).map((g) => g.id),
    [groups],
  )

  // 分頁：以「一次操作」為切割單位累加到 PAGE_SIZE，同一次操作不會被拆到兩頁
  const pages = useMemo(() => {
    const out: typeof groups[] = []
    let cur: typeof groups = []
    let n = 0
    for (const g of groups) {
      if (cur.length > 0 && n + g.rows.length > PAGE_SIZE) {
        out.push(cur)
        cur = []
        n = 0
      }
      cur.push(g)
      n += g.rows.length
    }
    if (cur.length) out.push(cur)
    return out
  }, [groups])

  const pageCount = Math.max(1, pages.length)
  const curPage = Math.min(page, pageCount - 1)
  const pageGroups = pages[curPage] ?? []

  // 條件變動時回到第一頁
  useEffect(() => { setPage(0) }, [search, actionFilter, riskOnly, days])

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      {/* 標題列 */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">訂單修改紀錄</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            每 5 分鐘增量偵測銷售訂單的異動，逐筆記錄「誰、幾點、把哪張單的哪個位置、從什麼改成什麼」。
            <span className="text-slate-500">（人員與時間取自 ARGO 的 UPDATE_BY / UPDATE_DATE，即實際動手改的人）</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-cyan-500/50 focus:outline-none"
          >
            {DAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input
            type="text"
            placeholder="搜尋單號 / 姓名 / 工號 / 內容"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-cyan-500/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            {loading ? '讀取中…' : '🔄 重新整理'}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-40"
          >
            ⬇ 匯出 CSV
          </button>
        </div>
      </div>

      {/* 統計 + 動作篩選 */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        {(['全部', '新增', '修改', '刪除'] as const).map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setActionFilter(a)}
            className={`rounded-lg border px-3 py-1.5 transition-colors ${
              actionFilter === a
                ? 'border-cyan-600 bg-cyan-700/40 text-white'
                : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:text-white'
            }`}
          >
            {a}
            {a !== '全部' && <span className="ml-1 font-mono text-slate-400">{stats[a]}</span>}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setRiskOnly((v) => !v)}
          title="只看已發單上傳、已備料、生產中才被改的訂單行（料可能已經領出去或已經在做）"
          className={`ml-1 rounded-lg border px-3 py-1.5 transition-colors ${
            riskOnly
              ? 'border-red-600 bg-red-800/50 text-white'
              : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:text-white'
          }`}
        >
          ⚠ 只看已發單後才改
          <span className="ml-1 font-mono">{stats.風險}</span>
        </button>
        {collapsibleKeys.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((prev) =>
              prev.size >= collapsibleKeys.length ? new Set() : new Set(collapsibleKeys))}
            className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-slate-400 transition-colors hover:text-white"
          >
            {expanded.size >= collapsibleKeys.length ? '▾ 全部收合' : '▸ 全部展開'}
            <span className="ml-1 font-mono">{collapsibleKeys.length}</span>
          </button>
        )}
        <span className="ml-2 text-slate-400">
          共 <span className="font-mono font-semibold text-cyan-300">{filtered.length}</span> 條
          {search && <span className="text-slate-500">（篩選自 {entries.length} 條）</span>}
          ．涉及 <span className="font-mono text-cyan-300">{stats.人數}</span> 人
          {stats.生產中 > 0 && (
            <span className="ml-2 text-red-400">生產中被改 {stats.生產中} 行</span>
          )}
        </span>
        {loadedAt && (
          <span className="text-slate-500">讀取於 {loadedAt.toLocaleTimeString('zh-TW', { hour12: false })}</span>
        )}
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-800/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          ❌ {error}
        </p>
      )}

      {truncated && (
        <p className="mb-4 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          ⚠ 這段期間的變動筆數超過單次讀取上限，只顯示到 {truncated.slice(0, 19).replace('T', ' ')} 為止，
          更早的紀錄未列出。請縮短天數查詢。
        </p>
      )}

      {/* LOG 條列 */}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 bg-slate-900">
              <th className="whitespace-nowrap px-3 py-3 text-left text-xs text-slate-300">異動時間</th>
              <th className="whitespace-nowrap px-3 py-3 text-left text-xs text-slate-300">工號 / 姓名</th>
              <th className="whitespace-nowrap px-3 py-3 text-left text-xs text-slate-300">動作</th>
              <th className="whitespace-nowrap px-3 py-3 text-left text-xs text-slate-300">訂單 / 行號</th>
              <th className="whitespace-nowrap px-3 py-3 text-left text-xs text-slate-300">修改位置</th>
              <th className="px-3 py-3 text-left text-xs text-slate-300">原內容 → 新內容</th>
              <th className="whitespace-nowrap px-3 py-3 text-left text-xs text-slate-300">發單狀態</th>
              <th className="whitespace-nowrap px-3 py-3 text-left text-xs text-slate-300">影響單位</th>
              <th className="whitespace-nowrap px-3 py-3 text-left text-xs text-slate-300">應通知</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-3 py-10 text-center text-slate-500">讀取中…（需向 ARGO 補查異動人員，約數秒）</td></tr>
            )}
            {!loading && pageGroups.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-10 text-center text-slate-500">
                {entries.length === 0 ? `近 ${days} 天沒有偵測到訂單異動` : '無符合條件的紀錄'}
              </td></tr>
            )}
            {!loading && pageGroups.map((g, gi) => {
              // 一次操作改很多筆時預設收起來，避免一張單洗掉整個畫面
              const collapsible = g.rows.length > COLLAPSE_OVER
              const open = expanded.has(g.id)
              const shown = collapsible && !open ? g.rows.slice(0, PEEK_ROWS) : g.rows
              const hiddenCount = g.rows.length - shown.length
              const hiddenLines = new Set(g.rows.slice(shown.length).map((x) => x.lineNo)).size

              return [...shown.map((e, ri) => {
              const { date, time } = splitAt(e.at)
              const first = ri === 0
              // 發單狀態／影響單位是「整個訂單行」的性質，同一行改了多個欄位只印一次
              const firstOfLine = g.rows.findIndex((x) => x.lineNo === e.lineNo) === ri
              return (
                <tr
                  key={e.key}
                  className={`${first && gi > 0 ? 'border-t-2 border-t-slate-700' : 'border-t border-slate-800/40'} ${
                    gi % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/10'
                  } hover:bg-slate-800/40`}
                >
                  {/* 同一次操作只在第一列顯示時間/人/單號，其餘留白，讀起來像一次操作 */}
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs">
                    {first && (
                      <>
                        <span className="text-slate-400">{date}</span>{' '}
                        <span className="font-semibold text-cyan-300">{time}</span>
                        {e.approximate && (
                          <span title="該行在 ARGO 已被刪除，時間與人員取自這張單的最後異動紀錄，非該行本身"
                            className="ml-1 cursor-help text-amber-500">*</span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top text-xs">
                    {first && (
                      <>
                        <span className="font-mono text-cyan-300">{e.empNo || '—'}</span>{' '}
                        <span className="text-slate-200">{e.empName || '(工號未建檔)'}</span>
                        {e.salesName && e.empName && e.salesName !== e.empName && (
                          <div className="mt-0.5 text-[11px] text-slate-500">單上業務：{e.salesName}</div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top">
                    {first && (
                      <span className={`rounded border px-2 py-0.5 text-[11px] ${ACTION_STYLE[e.action]}`}>
                        {e.action}
                      </span>
                    )}
                  </td>
                  {/* 行號每列都印：同一次操作常一次改好幾行，隱藏行號會誤讀成都改同一行 */}
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs">
                    {first
                      ? <span className="text-cyan-300">{e.docNo}</span>
                      : <span className="text-slate-600">↳</span>}
                    {e.lineNo && <span className="ml-1 text-slate-300">#{e.lineNo}</span>}
                    {/* 這張單目前有工單行號失效 → 可點進「工單對位體檢」看明細 */}
                    {first && e.impact.misalignedMos > 0 && (
                      <button
                        type="button"
                        onClick={() => onInspectOrder?.(e.docNo)}
                        title={`這張訂單目前有 ${e.impact.misalignedMos} 張工單的行號已失效，點擊查看明細`}
                        className="ml-1 rounded border border-red-700/60 bg-red-900/60 px-1.5 py-0.5 font-sans text-[10px] text-red-300 underline decoration-dotted underline-offset-2 transition-colors hover:bg-red-800/70 hover:text-white"
                      >
                        工單行號失效 {e.impact.misalignedMos}
                      </button>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top text-xs text-slate-300">
                    {e.fieldLabel}
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    {e.action === '修改' ? (
                      <span>
                        <span className="text-slate-400 line-through decoration-slate-600" title={e.oldValue ?? ''}>
                          {preview(e.oldValue)}
                        </span>
                        <span className="mx-2 text-slate-500">改為</span>
                        <span className="font-medium text-emerald-300" title={e.newValue ?? ''}>
                          {preview(e.newValue)}
                        </span>
                      </span>
                    ) : e.action === '新增' ? (
                      <span className="text-emerald-300" title={e.newValue ?? ''}>{preview(e.newValue, 70)}</span>
                    ) : (
                      <span className="text-red-300 line-through decoration-red-800" title={e.oldValue ?? ''}>
                        {preview(e.oldValue, 70)}
                      </span>
                    )}
                  </td>
                  {/* 發單狀態：同一訂單行的多個欄位共用，只在該行第一列顯示 */}
                  <td className="whitespace-nowrap px-3 py-2 align-top text-xs">
                    {firstOfLine && (
                      <>
                        <span className={`rounded border px-2 py-0.5 text-[11px] ${
                          STATE_STYLE[e.impact.dispatchState] ?? STATE_STYLE.未發單}`}>
                          {e.impact.dispatchState}
                        </span>
                        {e.impact.progress != null && e.impact.progress > 0 && (
                          <span className="ml-1 font-mono text-[11px] text-slate-400">{e.impact.progress}%</span>
                        )}
                        {e.impact.warnings.includes('skip_station') && (
                          <span className="ml-1 text-[11px] text-amber-400" title="塔台標記跳站">跳站</span>
                        )}
                        {e.impact.moNumbers.length > 0 && (
                          <div className="mt-0.5 font-mono text-[10px] text-slate-500"
                            title={e.impact.moNumbers.join(', ')}>
                            {e.impact.moNumbers[0]}
                            {e.impact.moNumbers.length > 1 && ` +${e.impact.moNumbers.length - 1}`}
                          </div>
                        )}
                        {(e.impact.matchConfidence === '僅末碼' || e.impact.matchConfidence === '僅料號'
                          || e.impact.matchConfidence === '對不到此行') && (
                          <div className="text-[10px] text-amber-500"
                            title="製令號末兩碼＝發單當下的訂單行號；訂單中間插行會讓行號位移而對不上">
                            ⚠{e.impact.matchConfidence}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  {/* 影響單位 */}
                  <td className="px-3 py-2 align-top text-xs">
                    {firstOfLine && (
                      <div className="max-w-[220px]">
                        {e.impact.running.map((r, i) => (
                          <div key={i} className="text-[11px] text-red-300">
                            ● {r.station}／{r.job}
                            <span className="ml-1 text-slate-400">
                              {r.status === 'running' ? '進行中' : '暫停'}
                              {r.done != null && r.qty != null && ` ${r.done}/${r.qty}`}
                            </span>
                            {r.resource && <span className="ml-1 text-slate-500">{r.resource}</span>}
                          </div>
                        ))}
                        {e.impact.stations.length > 0 ? (
                          <div className={`text-[11px] ${e.impact.stationsPredicted ? 'text-slate-500' : 'text-slate-300'}`}>
                            {e.impact.stationsPredicted && <span className="text-slate-600">預估 </span>}
                            {e.impact.stations.join(' → ')}
                          </div>
                        ) : e.impact.running.length === 0 && (
                          <span className="text-slate-600">—</span>
                        )}
                      </div>
                    )}
                  </td>
                  {/* 應通知：依「改了什麼」＋「有沒有發單」判定 */}
                  <td className="whitespace-nowrap px-3 py-2 align-top text-xs">
                    <span
                      title={e.notify.note}
                      className={`cursor-help rounded border px-2 py-0.5 text-[11px] ${
                        NOTIFY_STYLE[e.notify.target] ?? NOTIFY_STYLE.美編部門}`}
                    >
                      {e.notify.target}
                    </span>
                  </td>
                </tr>
              )
            }),
            collapsible ? (
              <tr
                key={`${g.id}-toggle`}
                onClick={() => setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(g.id)) next.delete(g.id)
                  else next.add(g.id)
                  return next
                })}
                className={`cursor-pointer border-t border-slate-800/40 ${
                  gi % 2 === 0 ? 'bg-slate-900/40' : 'bg-slate-900/10'
                } hover:bg-slate-800/60`}
              >
                <td colSpan={9} className="px-3 py-1.5 text-xs text-slate-400">
                  <span className="ml-1 text-slate-500">{open ? '▾' : '▸'}</span>
                  <span className="ml-2">
                    {open
                      ? '收合這次操作'
                      : `這次操作還有 ${hiddenCount} 項變更（涉及 ${hiddenLines} 個品項行），點此展開`}
                  </span>
                </td>
              </tr>
            ) : null,
            ]
            })}
          </tbody>
        </table>
      </div>

      {/* 分頁 */}
      {pageCount > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-slate-400">
            第 <span className="font-mono text-cyan-300">{curPage + 1}</span> / {pageCount} 頁
            <span className="ml-2 text-slate-500">
              本頁 {pageGroups.reduce((n, g) => n + g.rows.length, 0)} 條，共 {filtered.length} 條
            </span>
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(0)}
              disabled={curPage === 0}
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-slate-300 transition-colors hover:text-white disabled:opacity-35"
            >
              « 第一頁
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={curPage === 0}
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-slate-300 transition-colors hover:text-white disabled:opacity-35"
            >
              ‹ 上一頁
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={curPage >= pageCount - 1}
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-slate-300 transition-colors hover:text-white disabled:opacity-35"
            >
              下一頁 ›
            </button>
            <button
              type="button"
              onClick={() => setPage(pageCount - 1)}
              disabled={curPage >= pageCount - 1}
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-slate-300 transition-colors hover:text-white disabled:opacity-35"
            >
              最後一頁 »
            </button>
          </div>
        </div>
      )}

      {/* 判讀說明 */}
      <div className="mt-4 space-y-1.5 rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-xs leading-relaxed text-slate-400">
        <p className="font-medium text-slate-300">判讀說明</p>
        <p>
          原內容<span className="text-slate-400 line-through decoration-slate-600">整段劃掉</span>、
          新內容用<span className="text-emerald-300">綠字</span>；內容過長會截斷，滑鼠移上去看全文。
        </p>
        <p>
          <span className="text-slate-300">異動時間</span>是 ARGO 記錄的真實操作時間（非我們偵測到的時間）；
          偵測每 5 分鐘一輪，所以最新一筆異動最多會晚 5 分鐘出現在這裡。
        </p>
        <p>
          <span className="text-slate-300">工號 / 姓名</span>是 ARGO 的 UPDATE_BY，即「實際動手改的人」，
          與訂單掛名業務不一定相同；不同時會另外標示「單上業務」。
        </p>
        <p>
          <span className="text-amber-500">*</span> 標記＝該行已被刪除，ARGO 查不到該行的異動人，
          時間與人員改用<span className="text-slate-300">這張單最後的異動紀錄</span>推得，僅供參考。
        </p>
        <p>
          <span className="text-slate-300">發單狀態</span>是這一行發到哪了：
          未發單 → 已開製令 → 已發單上傳 → 已備料（料已領出去）→
          <span className="text-red-300">生產中</span>（機台正在做）。愈後面代表改單的殺傷力愈大。
          百分比是塔台的整批進度。
        </p>
        <p>
          <span className="text-slate-300">影響單位</span>紅點是塔台上正在跑或暫停的工序（含機台/人員）；
          灰字是這一行會經過的站別，標「預估」代表塔台還沒有這批、是用料號的標準途程推的。
        </p>
        <p>
          <span className="text-slate-300">應通知</span>依「改了什麼」加「有沒有發單」判定：
          單價、幣別、發票型態這類只影響帳務 →
          <span className="mx-1 rounded border border-sky-700/50 bg-sky-900/50 px-1.5 text-sky-300">財務部門</span>；
          尚未發單 → <span className="mx-1 rounded border border-slate-700 bg-slate-800 px-1.5 text-slate-400">美編部門</span>
          （不影響生產，但美編可能已依舊內容作業）；
          已發單後才改 → <span className="mx-1 rounded border border-red-700/50 bg-red-900/60 px-1.5 text-red-300">全廠</span>，
          交期與包裝連包裝出貨都要知悉。滑鼠移到標籤上有判定原因。
        </p>
        <p>
          訂單號旁的
          <span className="mx-1 rounded border border-red-700/60 bg-red-900/60 px-1.5 text-[11px] text-red-300">工單行號失效</span>
          代表這張訂單目前有工單對不上行號（可能是好幾週前的改單累積造成的，不一定是這一次）。
          點它可跳到「工單對位體檢」看是哪幾張。
        </p>
        <p className="text-slate-500">
          註：ARGO 行號在中間插入新行時會整體往後推，該情況會呈現為「多行的料號/品名同時被改」，
          實際上是插行造成的位移。製令號末兩碼＝發單當下的行號，位移時會對不上，
          此時發單狀態會標 <span className="text-amber-500">⚠僅末碼／僅料號／對不到此行</span>，
          代表對應關係不完全可信，不要直接當結論。
        </p>
      </div>
    </div>
  )
}
