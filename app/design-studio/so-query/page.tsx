'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../../lib/supabaseClient'
import type { PublicPoLine } from '../../../lib/purchasing/types'

// ─── 型別 ─────────────────────────────────────────────
interface SoLine {
  id: number
  project_id: string
  begin_date: string | null
  sales_name: string | null
  partner_name: string | null
  tpn_part_no: string | null
  line_no: string
  mbp_part: string | null
  duedate: string | null
  order_qty_oru: number | null
  unit_of_measure_oru: string | null
  description: string | null
  packing: string | null
  remark2: string | null
  hold_status: string | null
}

// 模糊查詢單次最多回傳筆數（防止輸入過短時撈回全表）
const QUERY_LIMIT = 500

// ─── 輔助 ─────────────────────────────────────────────
function normalizeDate(d: string | null): string | null {
  if (!d) return null
  const s = d.trim()
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`
  if (/^\d{4}\/\d{2}\/\d{2}/.test(s)) return s.slice(0,10).replace(/\//g, '-')
  return s.slice(0, 10)
}

function fmtDate(d: string | null) {
  return normalizeDate(d) ?? '—'
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

// Excel 欄位順序（Tab 分隔，對齊出單表 A~Q 欄；R 欄「盤數」為人工填寫，不輸出以免貼上時被清空）
// A工單編號 | B(空) | C單據種類 | D簽收人員 | E打樣單號 | F打樣 | G附素材 | H客戶/供應商名 | I LINE暱稱 | J承辦人 | K開單人員 | L品項編碼 | M品名/規格 | N出貨備註 | O PACKING | P數量 | Q交付日期

// 清洗 TSV 儲存格：移除換行/tab 避免 Excel 貼上時錯位
function sanitizeCell(v: string | number | null | undefined): string {
  if (v == null) return ''
  return String(v)
    .replace(/\r\n/g, ' / ')   // CRLF → 分隔符
    .replace(/[\r\n]+/g, ' / ') // 單獨 CR 或 LF
    .replace(/\t+/g, ' ')       // tab → 空白
    .replace(/ {2,}/g, ' ')     // 連續空白收斂
    .trim()
}

function buildExcelRow(r: SoLine): string {
  const cols = [
    r.project_id,                          // 工單編號
    '',                                    // (空)
    '',                                    // 單據種類
    '',                                    // 簽收人員
    r.tpn_part_no ?? '',                   // 打樣單號＝前置單號（E欄）
    '',                                    // 打樣
    '',                                    // 附素材
    r.partner_name ?? '',                  // 客戶/供應商名
    '',                                    // LINE暱稱
    r.sales_name ?? '',                    // 承辦人
    '',                                    // 開單人員
    r.mbp_part ?? '',                      // 品項編碼
    r.description ?? '',                   // 品名/規格
    r.remark2 ?? '',                       // 出貨備註（N欄）
    r.packing ?? '',                       // PACKING（O欄）
    r.order_qty_oru != null ? String(r.order_qty_oru) : '', // 數量
    fmtDate(r.duedate),                    // 交付日期
  ]
  return cols.map(sanitizeCell).join('\t')
}

export default function SoQueryPage() {
  const [queryInput, setQueryInput]   = useState('')
  const [rows, setRows]               = useState<SoLine[]>([])
  const [loading, setLoading]         = useState(false)
  const [fetchError, setFetchError]   = useState<string | null>(null)
  const [searched, setSearched]       = useState(false)
  const [copyMsg, setCopyMsg]         = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [syncing, setSyncing]         = useState(false)
  const [syncMsg, setSyncMsg]         = useState('')
  const [syncModalOpen, setSyncModalOpen] = useState(false)
  const [syncStage, setSyncStage] = useState('')
  const [syncElapsed, setSyncElapsed] = useState(0)
  const [syncResult, setSyncResult] = useState<{ ok: boolean; text: string } | null>(null)
  const syncStartRef = useRef<number>(0)

  // 採購進度 modal（跨區資訊：僅進度/貨運/交期，不含供應商與付款）
  const [poModalSo, setPoModalSo] = useState<string | null>(null)
  const [poFocus, setPoFocus] = useState<string | null>(null)   // 點 PO 單號 → 顯示整張 PO 明細
  const [poLines, setPoLines] = useState<PublicPoLine[]>([])
  const [poLoading, setPoLoading] = useState(false)
  const [poError, setPoError] = useState<string | null>(null)

  const fetchPoLines = useCallback(async (query: string) => {
    setPoLines([])
    setPoError(null)
    setPoLoading(true)
    try {
      const res = await fetch(`/api/purchasing/po-public?${query}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setPoLines(json.lines as PublicPoLine[])
    } catch (e) {
      setPoError(e instanceof Error ? e.message : String(e))
    } finally {
      setPoLoading(false)
    }
  }, [])

  const openPoModal = useCallback((soNo: string) => {
    setPoModalSo(soNo)
    setPoFocus(null)
    void fetchPoLines(`so=${encodeURIComponent(soNo)}`)
  }, [fetchPoLines])

  /** 點 PO 單號 → 整張採購單明細（仍走 po-public，不含供應商/付款） */
  const openPoFull = useCallback((poNo: string) => {
    setPoFocus(poNo)
    void fetchPoLines(`po=${encodeURIComponent(poNo)}`)
  }, [fetchPoLines])

  const backToSoView = useCallback(() => {
    setPoFocus(null)
    if (poModalSo) void fetchPoLines(`so=${encodeURIComponent(poModalSo)}`)
  }, [poModalSo, fetchPoLines])

  // 同步進行中的階段提示（依據經過時間推測）
  useEffect(() => {
    if (!syncing) return
    const tick = () => {
      const elapsed = Math.floor((Date.now() - syncStartRef.current) / 1000)
      setSyncElapsed(elapsed)
      if (elapsed < 3) setSyncStage('向 ARGO 請求 PJ_PROJECT 表頭…')
      else if (elapsed < 10) setSyncStage('接收 SO 表頭資料並建立索引…')
      else if (elapsed < 25) setSyncStage('向 ARGO 請求 PJ_PROJECTDETAIL 明細…')
      else if (elapsed < 50) setSyncStage('合併表頭 / 明細並去重…')
      else if (elapsed < 90) setSyncStage('寫入 Supabase（分批插入）…')
      else setSyncStage('仍在處理中，請稍候…')
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [syncing])

  const handleSyncSo = useCallback(async () => {
    if (syncing) return
    if (!window.confirm('確定要同步 ARGO 銷售訂單嗎？\n（將以 ARGO 最新資料覆寫本地快照）')) return
    syncStartRef.current = Date.now()
    setSyncing(true)
    setSyncMsg('')
    setSyncResult(null)
    setSyncModalOpen(true)
    setSyncElapsed(0)
    setSyncStage('連線 ARGO…')
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_so' }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.status === 'error') {
        throw new Error(json?.error || `HTTP ${res.status}`)
      }
      const synced = json?.syncedCount ?? '?'
      const total = json?.totalRows ?? '?'
      const headers = json?.headerCount ?? '?'
      const elapsedSec = Math.floor((Date.now() - syncStartRef.current) / 1000)
      const text = `寫入 ${synced} 筆明細（表頭 ${headers} 張 / 原始明細 ${total} 筆）\n耗時：${elapsedSec} 秒`
      setSyncResult({ ok: true, text })
      setSyncMsg(`✅ 同步成功：${synced} 筆`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSyncResult({ ok: false, text: msg })
      setSyncMsg(`❌ 同步失敗：${msg}`)
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(''), 6000)
    }
  }, [syncing])

  const handleQuery = useCallback(async () => {
    const raw = queryInput.trim()
    if (!raw) return

    setLoading(true)
    setFetchError(null)
    setRows([])
    setSelectedIds(new Set())
    setSearched(true)

    // 局部比對（不分大小寫）：輸入部分單號即可列出所有可能的訂單
    const { data, error } = await supabase
      .from('erp_so_lines')
      .select('id,project_id,begin_date,sales_name,partner_name,tpn_part_no,line_no,mbp_part,duedate,order_qty_oru,unit_of_measure_oru,description,packing,remark2,hold_status')
      .ilike('project_id', `%${raw}%`)
      .order('project_id', { ascending: true })
      .order('line_no',    { ascending: true })
      .limit(QUERY_LIMIT)

    setLoading(false)
    if (error) { setFetchError(error.message); return }
    setRows((data ?? []) as SoLine[])
  }, [queryInput])

  const handleCopy = useCallback(async () => {
    if (selectedIds.size === 0) return
    const selected = rows
      .filter(r => selectedIds.has(r.id))
      .sort((a, b) => {
        if (a.project_id < b.project_id) return -1
        if (a.project_id > b.project_id) return 1
        return (parseInt(a.line_no, 10) || 0) - (parseInt(b.line_no, 10) || 0)
      })
    const text = selected.map(buildExcelRow).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopyMsg(`已複製 ${selected.length} 筆！可直接貼到 Excel`)
    } catch {
      setCopyMsg('複製失敗，請手動選取')
    }
    setTimeout(() => setCopyMsg(''), 3000)
  }, [rows, selectedIds])

  const COLS = 14 // colSpan 數量（含勾選欄與採購欄）

  const allSelected = rows.length > 0 && rows.every(r => selectedIds.has(r.id))
  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(rows.map(r => r.id)))
    }
  }
  const toggleRow = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      {/* ─── Header ─── */}
      <div className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm px-4 py-3 flex items-center gap-4">
        <Link href="/design-studio" className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0">
          ← 美編天地
        </Link>
        <h1 className="text-sm font-bold text-white">銷售訂單查詢</h1>
        <div className="ml-auto flex items-center gap-3">
          {syncMsg && <span className="text-xs text-slate-300">{syncMsg}</span>}
          <button
            type="button"
            onClick={() => void handleSyncSo()}
            disabled={syncing}
            title="呼叫 ERP 同步區「同步銷售訂單」（sync_so）"
            className="px-3 py-1.5 rounded bg-indigo-700 hover:bg-indigo-600 disabled:bg-slate-700 disabled:text-slate-500 text-xs font-semibold text-white transition-colors"
          >
            {syncing ? '同步中…' : '🔄 同步銷售訂單'}
          </button>
        </div>
      </div>

      {/* ─── Query bar ─── */}
      <div className="px-4 py-4 border-b border-slate-800/60 flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[260px]">
          <label className="block text-xs text-slate-400 mb-1">訂單號碼</label>
          <input
            type="text"
            value={queryInput}
            onChange={e => setQueryInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleQuery() } }}
            placeholder="例如：RO26050101，或輸入部分單號如 0603"
            className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan-600 transition-colors font-mono"
          />
        </div>
        <div className="flex flex-col gap-2 pt-5">
          <button
            type="button"
            onClick={() => void handleQuery()}
            disabled={loading || !queryInput.trim()}
            className="px-5 py-2 rounded bg-cyan-700 hover:bg-cyan-600 disabled:bg-slate-700 disabled:text-slate-500 text-sm font-semibold text-white transition-colors"
          >
            {loading ? '查詢中…' : '查詢'}
          </button>
          {rows.length > 0 && (
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={selectedIds.size === 0}
              className="px-5 py-2 rounded bg-emerald-800 hover:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-500 text-sm font-semibold text-white transition-colors"
            >
              {selectedIds.size > 0 ? `複製 ${selectedIds.size} 筆` : '一鍵複製'}
            </button>
          )}
        </div>
        {copyMsg && (
          <p className="w-full text-xs text-emerald-400 mt-1">{copyMsg}</p>
        )}
      </div>

      {/* ─── Error banner ─── */}
      {fetchError && (
        <div className="px-4 py-3 bg-red-900/40 border-b border-red-800 text-red-300 text-xs">
          ⚠ 查詢失敗：{fetchError}
        </div>
      )}

      {/* ─── Table ─── */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[800px]">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/70 text-slate-400 font-medium">
              <th className="px-3 py-2.5 text-center w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-cyan-500 cursor-pointer"
                  title="全選/全不選"
                />
              </th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">訂單號</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">序號</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">下單日</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">交期</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">前置單號</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">客戶名稱</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">業務</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">料號</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">品名/規格</th>
              <th className="px-3 py-2.5 text-right whitespace-nowrap">數量</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">出貨備註</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">PACKING</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">採購</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={COLS} className="px-3 py-8 text-center text-slate-600">查詢中…</td>
              </tr>
            )}
            {!loading && searched && rows.length === 0 && (
              <tr>
                <td colSpan={COLS} className="px-3 py-8 text-center text-slate-600">
                  找不到符合的訂單，請確認訂單號碼是否正確或 ERP 已同步。
                </td>
              </tr>
            )}
            {!loading && !searched && (
              <tr>
                <td colSpan={COLS} className="px-3 py-8 text-center text-slate-600">
                  輸入訂單號碼後按「查詢」
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-b border-slate-800/40 hover:bg-slate-900/50 transition-colors cursor-pointer ${selectedIds.has(r.id) ? 'bg-cyan-950/30' : ''}`}
                onClick={() => toggleRow(r.id)}
              >
                <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(r.id)}
                    onChange={() => toggleRow(r.id)}
                    className="accent-cyan-500 cursor-pointer"
                  />
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="font-mono text-cyan-300">{r.project_id}</span>
                  {r.hold_status && (
                    <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                      r.hold_status === 'OPEN' ? 'bg-emerald-900/60 text-emerald-400 border border-emerald-700/50' :
                      r.hold_status === 'UNSIGNED' ? 'bg-amber-900/60 text-amber-400 border border-amber-700/50' :
                      'bg-slate-800 text-slate-400 border border-slate-600'
                    }`}>{r.hold_status}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-500">{r.line_no}</td>
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtDate(r.begin_date)}</td>
                <td className={`px-3 py-2 whitespace-nowrap font-medium ${normalizeDate(r.duedate) && (normalizeDate(r.duedate) ?? '') < today() ? 'text-red-400' : 'text-emerald-400'}`}>
                  {fmtDate(r.duedate)}
                </td>
                <td className="px-3 py-2 font-mono text-sky-400/90 whitespace-nowrap">{r.tpn_part_no ?? '—'}</td>
                <td className="px-3 py-2 text-slate-200 max-w-[140px] truncate" title={r.partner_name ?? ''}>{r.partner_name ?? '—'}</td>
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{r.sales_name ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">{r.mbp_part ?? '—'}</td>
                <td className="px-3 py-2 text-slate-300 max-w-[200px] truncate" title={r.description ?? ''}>{r.description ?? '—'}</td>
                <td className="px-3 py-2 text-right text-white font-medium">
                  {r.order_qty_oru != null ? r.order_qty_oru.toLocaleString() : '—'}
                  {r.unit_of_measure_oru ? <span className="text-slate-500 ml-1 font-normal">{r.unit_of_measure_oru}</span> : null}
                </td>
                <td className="px-3 py-2 text-slate-400 max-w-[320px] truncate" title={r.remark2 ?? ''}>{r.remark2 ?? '—'}</td>
                <td className="px-3 py-2 text-slate-400 max-w-[320px] truncate" title={r.packing ?? ''}>{r.packing ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => void openPoModal(r.project_id)}
                    title="查看此訂單後續採購單的執行進度 / 出貨方式 / 預計出貨日"
                    className="text-[10px] px-2 py-0.5 rounded bg-indigo-900/60 hover:bg-indigo-800 border border-indigo-700/50 text-indigo-300 font-semibold transition-colors"
                  >採購進度</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── Footer ─── */}
      {rows.length > 0 && (
        <div className="px-4 py-3 border-t border-slate-800/60 text-xs text-slate-600">
          共 {rows.length.toLocaleString()} 筆
          {rows.length >= QUERY_LIMIT && (
            <span className="text-amber-500 ml-2">已達 {QUERY_LIMIT} 筆顯示上限，請輸入更完整的單號</span>
          )}
        </div>
      )}

      {/* ─── 同步進度 Modal ─── */}
      {syncModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[420px] max-w-[92vw] rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              {syncing ? (
                <div className="h-6 w-6 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
              ) : syncResult?.ok ? (
                <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center text-sm">✓</div>
              ) : (
                <div className="h-6 w-6 rounded-full bg-rose-500 flex items-center justify-center text-sm">✕</div>
              )}
              <h3 className="text-lg font-semibold">
                {syncing ? '正在同步銷售訂單' : syncResult?.ok ? '同步完成' : '同步失敗'}
              </h3>
            </div>

            {syncing ? (
              <>
                <div className="text-sm text-slate-300 mb-2">{syncStage || '準備中…'}</div>
                <div className="text-xs text-slate-500 mb-4">已耗時 {syncElapsed} 秒</div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full w-1/3 animate-pulse bg-sky-400" />
                </div>
                <div className="mt-4 text-xs text-slate-500">
                  ⚠ ARGO 大量資料同步通常需 30~120 秒，請勿關閉視窗。
                </div>
              </>
            ) : (
              <>
                <pre className={`whitespace-pre-wrap text-sm rounded-lg p-3 mb-4 border ${syncResult?.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200' : 'bg-rose-500/10 border-rose-500/30 text-rose-200'}`}>
{syncResult?.text}
                </pre>
                <div className="flex justify-end gap-2">
                  {syncResult?.ok && (
                    <button
                      onClick={() => { setSyncModalOpen(false); handleQuery() }}
                      className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-sm font-semibold"
                    >
                      重新載入查詢
                    </button>
                  )}
                  <button
                    onClick={() => setSyncModalOpen(false)}
                    className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm"
                  >
                    關閉
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ─── 採購進度 Modal（跨區資訊，不含供應商與付款） ─── */}
      {poModalSo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setPoModalSo(null)}>
          <div className="w-[720px] max-w-[94vw] max-h-[80vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <h3 className="text-lg font-semibold">{poFocus ? '採購單明細' : '採購執行進度'}</h3>
              <span className="font-mono text-sm text-cyan-300">{poFocus ?? poModalSo}</span>
              <div className="ml-auto flex items-center gap-2">
                {poFocus && (
                  <button
                    onClick={backToSoView}
                    className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                  >← 回訂單檢視</button>
                )}
                <button
                  onClick={() => setPoModalSo(null)}
                  className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                >關閉</button>
              </div>
            </div>

            {poLoading && <p className="text-sm text-slate-500 py-6 text-center">載入中…</p>}
            {poError && <p className="text-sm text-rose-300 py-4">⚠ {poError}</p>}
            {!poLoading && !poError && poLines.length === 0 && (
              <p className="text-sm text-slate-500 py-6 text-center">此訂單無進行中採購單。</p>
            )}
            {!poLoading && poLines.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[640px]">
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400">
                      <th className="px-2 py-2 text-left whitespace-nowrap">採購單號</th>
                      <th className="px-2 py-2 text-left whitespace-nowrap">序</th>
                      <th className="px-2 py-2 text-left whitespace-nowrap">料號</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">數量</th>
                      <th className="px-2 py-2 text-left whitespace-nowrap">交期</th>
                      <th className="px-2 py-2 text-left whitespace-nowrap">進度</th>
                      <th className="px-2 py-2 text-left whitespace-nowrap">出貨方式</th>
                      <th className="px-2 py-2 text-left whitespace-nowrap">預計出貨日</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poLines.map(l => (
                      <tr key={`${l.doc_no}|${l.sub_no}`} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-2 py-2 font-mono whitespace-nowrap">
                          {poFocus ? (
                            <span className="text-cyan-300">{l.doc_no}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openPoFull(l.doc_no)}
                              title="點擊查看這張採購單的整張明細"
                              className="text-cyan-300 hover:text-cyan-200 hover:underline"
                            >{l.doc_no}</button>
                          )}
                          {l.po_status && l.po_status !== 'OPEN' && (
                            <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-600">{l.po_status}</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-slate-500">{l.sub_no}</td>
                        <td className="px-2 py-2 font-mono text-slate-300 whitespace-nowrap">{l.item_code ?? '—'}</td>
                        <td className="px-2 py-2 text-right text-white whitespace-nowrap">
                          {l.qty != null ? l.qty.toLocaleString() : '—'}
                          {l.unit ? <span className="text-slate-500 ml-1">{l.unit}</span> : null}
                        </td>
                        <td className="px-2 py-2 text-slate-300 whitespace-nowrap">{l.due_date ?? '—'}</td>
                        <td className="px-2 py-2 whitespace-nowrap">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${
                            l.progress === '已到倉' ? 'bg-emerald-900/60 text-emerald-400 border-emerald-700/50'
                            : l.progress === '已出貨' ? 'bg-amber-900/60 text-amber-400 border-amber-700/50'
                            : l.progress === '已發單' ? 'bg-sky-900/60 text-sky-300 border-sky-700/50'
                            : 'bg-slate-800 text-slate-400 border-slate-600'
                          }`}>{l.progress}</span>
                        </td>
                        <td className="px-2 py-2 text-slate-300 whitespace-nowrap">{l.ship_method ?? '—'}</td>
                        <td className="px-2 py-2 text-slate-300 whitespace-nowrap">{l.expected_ship_date ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
