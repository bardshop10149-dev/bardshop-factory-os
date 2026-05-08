'use client'

import { useState } from 'react'

// ─── RawSampleTable ───────────────────────────────────
function RawSampleTable({ sample }: { sample: Record<string, unknown> }) {
  return (
    <div className="mt-2 rounded bg-slate-950 border border-slate-800 p-3 max-h-72 overflow-y-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr>
            <th className="text-left text-slate-500 pr-6 pb-1">欄位名稱</th>
            <th className="text-left text-slate-500 pb-1">值</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(sample).map(([k, v]) => (
            <tr key={k} className={String(v ?? '').trim() ? '' : 'opacity-30'}>
              <td className="pr-6 py-0.5 font-mono text-cyan-400">{k}</td>
              <td className="py-0.5 text-slate-300 break-all">{String(v ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── CellValue ────────────────────────────────────────
function CellValue({ value }: { value: string | null }) {
  if (value === null || value === '') return <span className="text-slate-600">—</span>
  const hasSpecial = /[\n\r\t]/.test(value)
  const display = value.replace(/\n/g, '↵ ').replace(/\r/g, '').replace(/\t/g, '→ ')
  return (
    <span title={value} className={hasSpecial ? 'text-amber-300' : ''}>
      {display}
      {hasSpecial && <span className="ml-1 text-amber-500/60 text-[10px]">[含換行]</span>}
    </span>
  )
}

// ─── 主頁面 ───────────────────────────────────────────
export default function RemarksTestPage() {
  const [projectId, setProjectId] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{
    status: 'idle' | 'ok' | 'error'
    rows: Array<{ pdl_seq: string; remark: string | null; packing: string | null; remark2: string | null; customer_remark: string | null }>
    rawSnippet: string
    error: string
    parseMode: 'direct' | 'sanitized' | 'failed'
    headerRawSample: Record<string, unknown> | null
    detailRawSample: Record<string, unknown> | null
  }>({ status: 'idle', rows: [], rawSnippet: '', error: '', parseMode: 'direct', headerRawSample: null, detailRawSample: null })

  const run = async () => {
    const id = projectId.trim()
    if (!id) return
    setRunning(true)
    setResult({ status: 'idle', rows: [], rawSnippet: '', error: '', parseMode: 'direct', headerRawSample: null, detailRawSample: null })
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test_remarks', projectId: id }),
      })
      const json = await res.json() as {
        status: string
        rows?: Array<{ pdl_seq: string; remark: string | null; packing: string | null; remark2: string | null; customer_remark: string | null }>
        rawSnippet?: string
        parseMode?: 'direct' | 'sanitized' | 'failed'
        headerRawSample?: Record<string, unknown> | null
        detailRawSample?: Record<string, unknown> | null
        error?: string
      }
      if (json.status === 'ok') {
        setResult({ status: 'ok', rows: json.rows ?? [], rawSnippet: json.rawSnippet ?? '', error: '', parseMode: json.parseMode ?? 'direct', headerRawSample: json.headerRawSample ?? null, detailRawSample: json.detailRawSample ?? null })
      } else {
        setResult({ status: 'error', rows: [], rawSnippet: json.rawSnippet ?? '', error: json.error ?? '未知錯誤', parseMode: 'failed', headerRawSample: null, detailRawSample: null })
      }
    } catch (e) {
      setResult({ status: 'error', rows: [], rawSnippet: '', error: e instanceof Error ? e.message : String(e), parseMode: 'failed' })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-amber-300 mb-1">🧪 備註欄同步測試</h1>
          <p className="text-sm text-slate-400">
            針對 REMARK / PACKING / REMARK2 欄位的單筆解析測試，驗證控制字元修復邏輯是否正常運作。
          </p>
        </div>

        {/* Input */}
        <div className="rounded-2xl border border-slate-700 bg-slate-900/60 p-6 mb-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">查詢條件</h2>
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-400">訂單號碼 (project_id)</label>
              <input
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void run()}
                placeholder="例：SO260505001"
                className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm w-64 focus:outline-none focus:border-amber-500"
              />
            </div>
            <button
              onClick={() => void run()}
              disabled={running || !projectId.trim()}
              className="px-5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 text-white text-sm font-medium transition-colors"
            >
              {running ? '查詢中…' : '🔍 查詢'}
            </button>
          </div>
        </div>

        {/* Error */}
        {result.status === 'error' && (
          <div className="rounded-xl bg-red-900/30 border border-red-700/50 p-4 text-red-300 text-sm mb-6">
            ❌ {result.error}
            {result.rawSnippet && (
              <pre className="mt-2 text-xs text-red-200/70 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {result.rawSnippet}
              </pre>
            )}
          </div>
        )}

        {/* Results */}
        {result.status === 'ok' && (
          <div className="rounded-2xl border border-slate-700 bg-slate-900/60 p-6 space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-emerald-400">✓ 解析成功 — {result.rows.length} 筆明細</span>
              <span className={`text-xs px-2 py-0.5 rounded border ${
                result.parseMode === 'direct'
                  ? 'bg-emerald-900/30 text-emerald-300 border-emerald-700/50'
                  : 'bg-amber-900/30 text-amber-300 border-amber-700/50'
              }`}>
                {result.parseMode === 'direct' ? '直接解析' : '修復後解析（含控制字元）'}
              </span>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-700">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-800 text-slate-300">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium w-16">PDL_SEQ</th>
                    <th className="px-3 py-2 text-left text-xs font-medium">REMARK</th>
                    <th className="px-3 py-2 text-left text-xs font-medium">PACKING</th>
                    <th className="px-3 py-2 text-left text-xs font-medium">REMARK2</th>                  <th className="px-3 py-2 text-left text-xs font-medium">客戶備註</th>                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {result.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-slate-800/50">
                      <td className="px-3 py-2 text-slate-400 font-mono text-xs">{row.pdl_seq}</td>
                      <td className="px-3 py-2 text-slate-200 text-xs max-w-xs">
                        <CellValue value={row.remark} />
                      </td>
                      <td className="px-3 py-2 text-slate-200 text-xs max-w-xs">
                        <CellValue value={row.packing} />
                      </td>
                      <td className="px-3 py-2 text-slate-200 text-xs max-w-xs">
                        <CellValue value={row.remark2} />
                      </td>
                      <td className="px-3 py-2 text-slate-200 text-xs max-w-xs">
                        <CellValue value={row.customer_remark} />
                      </td>
                    </tr>
                  ))}
                  {result.rows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-slate-500 text-xs">無明細資料</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {result.headerRawSample && (
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-300">🔍 展開 PJ_PROJECT 表頭所有欄位</summary>
                <RawSampleTable sample={result.headerRawSample} />
              </details>
            )}

            {result.detailRawSample && (
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-300">🔍 展開 PJ_PROJECTDETAIL 明細所有欄位</summary>
                <RawSampleTable sample={result.detailRawSample} />
              </details>
            )}

            {result.rawSnippet && (
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-300">展開 Raw 回應片段</summary>
                <pre className="mt-2 rounded bg-slate-950 border border-slate-800 p-3 text-slate-400 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                  {result.rawSnippet}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
