'use client'

// 出單總表——所有日期的每日出單表攤平成一張表。
//
// 每日出單表一次只看得到一天，要回答「還有哪些單沒做完」得一天一天翻。這頁把 104 天
// 全部攤平，預設只顯示未完成（未開始＋進行中），再用單據別與關鍵字收斂。
//
// 狀態與篩選都在伺服器端算完（見 /api/argoerp/order-summary）：整包 rows 有 6MB 多，
// 而且狀態要 join 塔台報工，不適合丟給瀏覽器。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MoProgressCell, type SheetProgress } from '../../../../components/MoProgressCell'

interface SummaryRow {
  sheet_date: string
  row_status: '未開始' | '進行中' | '已完成' | '無資料'
  status_note: string
  last_report_at?: string
  matched_via_bare?: boolean
  overdue?: boolean
  idle?: boolean
  progress?: SheetProgress
  pm_note?: string
  order_number?: string
  match_line_no?: string
  line_no_input?: string
  customer?: string
  item_code?: string
  item_name?: string
  note?: string
  quantity?: string
  plate_count?: string
  delivery_date?: string
  factory?: string
  doc_type?: string
  mo_number?: string
  mo_status?: string
  po_number?: string
  po_sub_no?: string
  pr_number?: string
  pr_sub_no?: string
  material_prep_status?: string
  argo_slip_no?: string
  is_sample?: string
  machine?: string
  assigned_machine?: string
  designer?: string
  handler?: string
  issuer?: string
  packing?: string
}

const STATUSES = [
  { key: '未完成', label: '未完成', hint: '未開始＋進行中' },
  { key: '未開始', label: '未開始', hint: '塔台上還沒有任何報工' },
  { key: '進行中', label: '進行中', hint: '已開工，包裝站尚未報工' },
  { key: '已完成', label: '已完成', hint: '包裝站已報工' },
  { key: '無資料', label: '無資料', hint: '出單日早於塔台報工同步起點，塔台上已無紀錄，無從判斷' },
  { key: 'all', label: '全部', hint: '' },
] as const

/** 另一組切角：不是生產狀態，而是「該注意的單」 */
const ALERTS = [
  { key: '遲交', label: '⏰ 遲交', hint: '已經過了交付日、狀態還不是已完成' },
  { key: '閒置', label: '💤 閒置', hint: '發單後超過 5 個工作天，狀態還停在未開始' },
] as const

const FACTORIES = [
  { key: 'ALL', label: '全部' },
  { key: 'T', label: '台北' },
  { key: 'C', label: '常平' },
  { key: 'O', label: '委外' },
  { key: 'G', label: '集單' },
] as const

const FACTORY_BADGE: Record<string, string> = {
  T: 'bg-cyan-950/50 text-cyan-300 border-cyan-800/50',
  C: 'bg-orange-950/50 text-orange-300 border-orange-800/50',
  O: 'bg-purple-950/50 text-purple-300 border-purple-800/50',
}
const FACTORY_LABEL: Record<string, string> = { T: '台北', C: '常平', O: '委外' }

const STATUS_STYLE: Record<string, string> = {
  未開始: 'bg-slate-800 text-slate-400 border-slate-700',
  進行中: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
  已完成: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50',
  無資料: 'bg-slate-900 text-slate-600 border-slate-800',
}

const shortTime = (s?: string) => {
  if (!s) return ''
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 這一列對應的單號（與伺服器端 refOf 同一套規則） */
function docNoOf(r: SummaryRow): string {
  if (r.factory === 'C') return r.po_number ? `${r.po_number}${r.po_sub_no ? `-${r.po_sub_no}` : ''}` : ''
  if (r.factory === 'O') return r.pr_number ? `${r.pr_number}${r.pr_sub_no ? `-${r.pr_sub_no}` : ''}` : ''
  return r.mo_number ?? ''
}

export default function OrderSummaryPage() {
  const router = useRouter()
  const [rows, setRows] = useState<SummaryRow[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [meta, setMeta] = useState<{ sheets: number; all: number; firstSync: string }>({ sheets: 0, all: 0, firstSync: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [page, setPage] = useState(0)
  const PAGE_SIZE = 20

  const [status, setStatus] = useState<string>('未完成')
  const [factory, setFactory] = useState<string>('ALL')
  const [keyword, setKeyword] = useState('')
  const [appliedKeyword, setAppliedKeyword] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ status, factory })
      if (appliedKeyword.trim()) qs.set('keyword', appliedKeyword.trim())
      const res = await fetch(`/api/argoerp/order-summary?${qs}`, { cache: 'no-store' })
      const j = await res.json() as {
        success: boolean; rows?: SummaryRow[]; total?: number; truncated?: boolean
        counts?: Record<string, number>; sheet_count?: number; all_count?: number
        first_sync_date?: string; error?: string
      }
      if (!j.success) throw new Error(j.error)
      setRows(j.rows ?? [])
      setPage(0)
      setTotal(j.total ?? 0)
      setTruncated(!!j.truncated)
      setCounts(j.counts ?? {})
      setMeta({ sheets: j.sheet_count ?? 0, all: j.all_count ?? 0, firstSync: j.first_sync_date ?? '' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [status, factory, appliedKeyword])

  useEffect(() => { void load() }, [load])

  const pageRows = useMemo(() => rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [rows, page])
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))

  const unfinished = useMemo(() => (counts['未開始'] ?? 0) + (counts['進行中'] ?? 0), [counts])
  const countOf = (k: string) => k === '未完成' ? unfinished : k === 'all' ? (counts['全部'] ?? 0) : (counts[k] ?? 0)

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1700px] mx-auto">

        <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold">出單總表</h1>
            <p className="text-slate-400 text-sm mt-1">
              所有日期的每日出單表攤平成一張，不分日期
              {meta.sheets > 0 && <span className="ml-2 text-slate-500">（共 {meta.sheets} 天、{meta.all.toLocaleString()} 列）</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => router.push('/admin/argoerp/daily-order-sheet')}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-sm hover:text-white transition-colors">
              每日出單表
            </button>
            <button onClick={() => void load()} disabled={loading}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-sm hover:text-white disabled:opacity-50 transition-colors">
              {loading ? '載入中…' : '重新整理'}
            </button>
          </div>
        </div>

        {/* 搜尋 */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="relative flex-1 min-w-[18rem] max-w-md">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') setAppliedKeyword(keyword) }}
              placeholder="搜尋單號 / 客戶 / 品項…"
              className="w-full pl-9 pr-8 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-cyan-500"
            />
            {keyword && (
              <button onClick={() => { setKeyword(''); setAppliedKeyword('') }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">✕</button>
            )}
          </div>
          <button onClick={() => setAppliedKeyword(keyword)}
            className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors">
            搜尋
          </button>
          {appliedKeyword && (
            <span className="text-xs text-slate-400">
              關鍵字「{appliedKeyword}」
            </span>
          )}
        </div>

        {/* 狀態 */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="text-xs text-slate-500 w-10">狀態</span>
          {STATUSES.map(s => (
            <button key={s.key} onClick={() => setStatus(s.key)} title={s.hint}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                status === s.key ? 'bg-cyan-600 border-cyan-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
              }`}>
              {s.label}
              <span className="ml-1.5 opacity-70">{countOf(s.key).toLocaleString()}</span>
            </button>
          ))}
        </div>

        {/* 警示切角 */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="text-xs text-slate-500 w-10">注意</span>
          {ALERTS.map(a => (
            <button key={a.key} onClick={() => setStatus(a.key)} title={a.hint}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                status === a.key ? 'bg-rose-600 border-rose-500 text-white' : 'bg-slate-900 border-rose-900/50 text-rose-300/80 hover:text-rose-200'
              }`}>
              {a.label}
              <span className="ml-1.5 opacity-70">{(counts[a.key] ?? 0).toLocaleString()}</span>
            </button>
          ))}
          <span className="text-[11px] text-slate-600">兩者都不含「無資料」的舊單</span>
        </div>

        {/* 單據別 */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-xs text-slate-500 w-10">單據</span>
          {FACTORIES.map(f => (
            <button key={f.key} onClick={() => setFactory(f.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                factory === f.key ? 'bg-slate-200 border-slate-300 text-slate-900' : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
              }`}>
              {f.label}
            </button>
          ))}
          <div className="flex-1" />
          <span className="text-xs text-slate-400">
            顯示 {rows.length.toLocaleString()} / {total.toLocaleString()} 列
            {truncated && <span className="text-amber-400 ml-1">（超過上限，請再縮小條件）</span>}
          </span>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-800/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">❌ {error}</div>
        )}

        {/* 表格：欄位對齊每日出單表 */}
        <div className="rounded-xl border border-slate-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 sticky top-0 z-10">
              <tr className="text-left text-xs text-slate-400">
                <th className="px-2 py-2.5 whitespace-nowrap">出單日 / 廠別</th>
                <th className="px-2 py-2.5 whitespace-nowrap">工單 / 製令‧採購單號</th>
                <th className="px-2 py-2.5 min-w-[220px]">客戶 / 品項編碼 / 品名規格</th>
                <th className="px-2 py-2.5 whitespace-nowrap text-right">數量</th>
                <th className="px-2 py-2.5 whitespace-nowrap text-right">盤數</th>
                <th className="px-2 py-2.5 whitespace-nowrap min-w-[130px]">交付日 / 生產進度</th>
                <th className="px-2 py-2.5 w-[210px] max-w-[210px]">PACKING / 備註</th>
                <th className="px-2 py-2.5 whitespace-nowrap text-center">批備料</th>
                <th className="px-2 py-2.5 whitespace-nowrap">打樣/追加</th>
                <th className="px-2 py-2.5 whitespace-nowrap">機台 / 狀態</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-12 text-center text-slate-600 text-sm">
                  {loading ? '載入中…' : '沒有符合條件的資料'}
                </td></tr>
              )}
              {pageRows.map((r, i) => {
                const docNo = docNoOf(r)
                const seq = r.match_line_no || r.line_no_input || ''
                return (
                  <tr key={`${r.sheet_date}-${r.order_number}-${r.item_code}-${i}`}
                    className="border-t border-slate-800/60 hover:bg-slate-900/50 transition-colors">
                    <td className="px-2 py-2 whitespace-nowrap">
                      <div className="font-mono text-xs text-slate-400">{r.sheet_date}</div>
                      <div className="mt-0.5">
                        {r.doc_type?.includes('集單')
                          ? <span className="px-1.5 py-0.5 rounded border text-[10px] bg-pink-950/50 text-pink-300 border-pink-800/50">集單</span>
                          : r.factory
                          ? <span className={`px-1.5 py-0.5 rounded border text-[10px] ${FACTORY_BADGE[r.factory] ?? 'bg-slate-800 text-slate-400 border-slate-700'}`}>
                              {FACTORY_LABEL[r.factory] ?? r.factory}
                            </span>
                          : null}
                      </div>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <div className="font-mono text-xs text-cyan-300">
                        {r.order_number || '—'}
                        {seq && <span className="text-cyan-500/80">-{seq}</span>}
                      </div>
                      <div className="font-mono text-[11px] text-slate-400 mt-0.5">
                        {docNo || <span className="text-slate-600">尚未轉單</span>}
                        {r.mo_status === '已匯入製令' && <span className="ml-1 text-emerald-400">✓</span>}
                      </div>
                    </td>
                    <td className="px-2 py-2 min-w-[220px]">
                      {r.customer && <div className="text-[11px] text-purple-300 truncate" title={r.customer}>{r.customer}</div>}
                      <div className="font-mono text-xs text-white break-all">{r.item_code || '—'}</div>
                      <div className="text-[11px] text-slate-400 line-clamp-2 break-words" title={r.item_name ?? ''}>{r.item_name || ''}</div>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-sm whitespace-nowrap">{r.quantity || '—'}</td>
                    <td className="px-2 py-2 text-right font-mono text-xs text-yellow-400/80 whitespace-nowrap">{r.plate_count || '—'}</td>
                    <td className="px-2 py-2">
                      <div className={`text-[11px] whitespace-nowrap mb-1 ${r.overdue ? 'text-rose-400 font-semibold' : 'text-slate-500'}`}>
                        {r.delivery_date || '—'}{r.overdue && ' ⏰'}
                      </div>
                      <MoProgressCell progress={r.progress} hasMo={!!docNo} factory={r.factory} onOpen={() => {}} />
                    </td>
                    <td className="px-2 py-2 text-[11px] w-[210px] max-w-[210px] leading-snug">
                      <div className="text-slate-300 break-words" title={r.packing ?? ''}>
                        {r.packing || <span className="text-slate-700">—</span>}
                      </div>
                      <div className="text-slate-400 break-words mt-0.5" title={r.note ?? ''}>
                        {r.note || <span className="text-slate-700">—</span>}
                      </div>
                      {r.pm_note && (
                        <div className="text-amber-500/80 break-words mt-0.5" title={r.pm_note}>{r.pm_note}</div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center whitespace-nowrap">
                      {(() => {
                        // 已備料/已批備料打勾、無需備料打三角形、其餘打叉
                        const st = r.material_prep_status
                        if (st === '已備料' || st === '已批備料') {
                          return <span className="text-emerald-400 text-base" title={st + (r.argo_slip_no ? '・' + r.argo_slip_no : '')}>✓</span>
                        }
                        if (st === '無需備料') return <span className="text-slate-400 text-base" title="無需備料">▲</span>
                        return <span className="text-rose-500/80 text-base" title="尚未備料">✕</span>
                      })()}
                    </td>
                    <td className="px-2 py-2 text-[11px] font-mono text-slate-400 whitespace-nowrap">{r.is_sample || '—'}</td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <div className="text-[11px] text-slate-300">{r.machine || r.assigned_machine || <span className="text-slate-600">—</span>}</div>
                      <div className="mt-0.5">
                        <span title={r.status_note}
                          className={`px-2 py-0.5 rounded-full text-[11px] border ${STATUS_STYLE[r.row_status]}`}>
                          {r.row_status}
                        </span>
                        {r.idle && (
                          <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] border border-rose-700/50 bg-rose-950/40 text-rose-300"
                            title="發單後超過 5 個工作天還沒開工">💤 閒置</span>
                        )}
                      </div>
                      {r.last_report_at && (
                        <div className="text-[10px] text-slate-600 mt-0.5">{shortTime(r.last_report_at)}</div>
                      )}
                      {r.matched_via_bare && (
                        <div className="text-[10px] text-amber-600/80" title="塔台上是不帶行號的舊單號，以裸單號比對，涵蓋同一張單的所有行號">裸號比對</div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {rows.length > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-2 mt-3 text-xs">
            <button onClick={() => setPage(0)} disabled={page === 0}
              className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 hover:text-white disabled:opacity-30">« 第一頁</button>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 hover:text-white disabled:opacity-30">‹ 上一頁</button>
            <span className="text-slate-400 px-2">
              第 {page + 1} / {totalPages} 頁
              <span className="text-slate-600 ml-2">（每頁 {PAGE_SIZE} 筆，共 {rows.length.toLocaleString()} 列）</span>
            </span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 hover:text-white disabled:opacity-30">下一頁 ›</button>
            <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 hover:text-white disabled:opacity-30">最後頁 »</button>
          </div>
        )}

        <p className="text-xs text-slate-600 mt-3 leading-relaxed">
          狀態判定：<span className="text-slate-500">已完成</span>＝這張工單在「包裝站」有報工紀錄（161 條途程的最後一道工序都在包裝站）；
          <span className="text-slate-500">進行中</span>＝有報工但包裝站還沒有；
          <span className="text-slate-500">未開始</span>＝塔台上完全沒有報工，含尚未轉單的列。
          滑鼠移到狀態標籤上可以看到每一列的判斷依據。
          <br />
          <span className="text-slate-500">無資料</span>＝出單日早於塔台報工同步起點
          {meta.firstSync && <span className="text-slate-500">（{meta.firstSync}）</span>}
          、塔台上已無這些舊單的紀錄，無從判斷；這類不算進「未完成」，免得把早就做完的舊單混進待辦清單。
        </p>
      </div>
    </div>
  )
}
