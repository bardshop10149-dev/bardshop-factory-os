'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../../lib/supabaseClient'

// ─── 型別 ─────────────────────────────────────────────
interface SoLine {
  id: number
  project_id: string
  begin_date: string | null
  sales_name: string | null
  partner_name: string | null
  line_no: string
  mbp_part: string | null
  duedate: string | null
  order_qty_oru: number | null
  unit_of_measure_oru: string | null
  description: string | null
  packing: string | null
  remark2: string | null
}

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

// Excel 欄位順序（Tab 分隔）
// 工單編號 | (空) | 單據種類 | 簽收人員 | (空) | 打樣 | 附素材 | 美編 | 客戶/供應商名 | LINE暱稱 | 承辦人 | 開單人員 | 品項編碼 | 品名/規格 | 備註 | 數量 | 交付日期
function buildExcelRow(r: SoLine): string {
  const cols = [
    r.project_id,                          // 工單編號
    '',                                    // 單據種類
    '',                                    // 簽收人員
    '',                                    // (空) ← 單據種類跟打樣之間加的一格
    '',                                    // 打樣
    '',                                    // 附素材
    '',                                    // 美編
    r.partner_name ?? '',                  // 客戶/供應商名
    '',                                    // LINE暱稱
    r.sales_name ?? '',                    // 承辦人 ← 業務
    '',                                    // 開單人員
    r.mbp_part ?? '',                      // 品項編碼
    r.description ?? '',                   // 品名/規格
    r.packing ?? '',                       // 備註 ← 商品備註
    r.order_qty_oru != null ? String(r.order_qty_oru) : '', // 數量
    fmtDate(r.duedate),                    // 交付日期
  ]
  return cols.join('\t')
}

export default function SoQueryPage() {
  const [queryInput, setQueryInput]   = useState('')
  const [rows, setRows]               = useState<SoLine[]>([])
  const [loading, setLoading]         = useState(false)
  const [fetchError, setFetchError]   = useState<string | null>(null)
  const [searched, setSearched]       = useState(false)
  const [copyMsg, setCopyMsg]         = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  const handleQuery = useCallback(async () => {
    const raw = queryInput.trim()
    if (!raw) return
    const ids = [raw]

    setLoading(true)
    setFetchError(null)
    setRows([])
    setSelectedIds(new Set())
    setSearched(true)

    const { data, error } = await supabase
      .from('erp_so_lines')
      .select('id,project_id,begin_date,sales_name,partner_name,line_no,mbp_part,duedate,order_qty_oru,unit_of_measure_oru,description,packing,remark2')
      .in('project_id', ids)
      .order('project_id', { ascending: true })
      .order('line_no',    { ascending: true })

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

  const COLS = 11 // colSpan 數量（含勾選欄）

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
            placeholder="例如：RO26050101"
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
              <th className="px-3 py-2.5 text-left whitespace-nowrap">客戶名稱</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">業務</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">料號</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">品名/規格</th>
              <th className="px-3 py-2.5 text-right whitespace-nowrap">數量</th>
              <th className="px-3 py-2.5 text-left whitespace-nowrap">商品備註</th>
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
                <td className="px-3 py-2 font-mono text-cyan-300 whitespace-nowrap">{r.project_id}</td>
                <td className="px-3 py-2 text-slate-500">{r.line_no}</td>
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtDate(r.begin_date)}</td>
                <td className={`px-3 py-2 whitespace-nowrap font-medium ${normalizeDate(r.duedate) && (normalizeDate(r.duedate) ?? '') < today() ? 'text-red-400' : 'text-emerald-400'}`}>
                  {fmtDate(r.duedate)}
                </td>
                <td className="px-3 py-2 text-slate-200 max-w-[140px] truncate" title={r.partner_name ?? ''}>{r.partner_name ?? '—'}</td>
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{r.sales_name ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">{r.mbp_part ?? '—'}</td>
                <td className="px-3 py-2 text-slate-300 max-w-[200px] truncate" title={r.description ?? ''}>{r.description ?? '—'}</td>
                <td className="px-3 py-2 text-right text-white font-medium">
                  {r.order_qty_oru != null ? r.order_qty_oru.toLocaleString() : '—'}
                  {r.unit_of_measure_oru ? <span className="text-slate-500 ml-1 font-normal">{r.unit_of_measure_oru}</span> : null}
                </td>
                <td className="px-3 py-2 text-slate-400 max-w-[320px] truncate" title={r.packing ?? ''}>{r.packing ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── Footer ─── */}
      {rows.length > 0 && (
        <div className="px-4 py-3 border-t border-slate-800/60 text-xs text-slate-600">
          共 {rows.length.toLocaleString()} 筆
        </div>
      )}
    </main>
  )
}
