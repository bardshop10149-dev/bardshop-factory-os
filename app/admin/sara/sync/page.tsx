'use client'

import Link from 'next/link'
import { useState } from 'react'

interface ApiResult {
  ok: boolean
  action: string
  elapsedMs?: number
  count?: number | null
  error?: string
  preview?: string
  message?: string
}

const ACTIONS: { key: string; label: string; desc: string; needsBody?: boolean; syncAction?: string }[] = [
  { key: 'ping',       label: '🔌 測試連線（取 api_key）', desc: 'POST /api/data_export/temp_token' },
  { key: 'order',      label: '📋 工單列表',             desc: '/data/order',     syncAction: 'sync_order' },
  { key: 'workcenter', label: '🏭 站點列表',             desc: '/data/workcenter', syncAction: 'sync_workcenter' },
  { key: 'jlb',        label: '⚙️ 製程列表',             desc: '/data/jlb',        syncAction: 'sync_jlb' },
  { key: 'resource',   label: '🔧 資源列表',             desc: '/data/resource (含 events / job_name)', syncAction: 'sync_resource' },
  { key: 'lot_detail', label: '🧭 途程列表',             desc: '/data/lot_detail（需 items）', needsBody: true, syncAction: 'sync_lot_detail' },
]

export default function SaraSyncPage() {
  const [results, setResults] = useState<Record<string, ApiResult>>({})
  const [loading, setLoading] = useState<string | null>(null)
  const [lotItems, setLotItems] = useState<string>(JSON.stringify([
    { mo_nbr: 'A001', product_name: 'P1', lot_nbr: 'L1' },
  ], null, 2))

  const callApi = async (action: string, isSync = false) => {
    const stateKey = isSync ? `sync:${action}` : action
    setLoading(stateKey)
    try {
      let body: unknown = {}
      if (action === 'lot_detail' || action === 'sync_lot_detail') {
        try {
          const items = JSON.parse(lotItems)
          body = { items }
        } catch {
          setResults(prev => ({ ...prev, [stateKey]: { ok: false, action, error: 'items JSON 格式錯誤' } }))
          return
        }
      }

      const res = await fetch('/api/sara', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, body }),
      })
      const json = await res.json().catch(() => ({}))
      setResults(prev => ({
        ...prev,
        [stateKey]: {
          ok: !!json.ok,
          action,
          elapsedMs: json.elapsedMs,
          count: json.count,
          error: json.error,
          message: json.message,
          preview: json.result ? JSON.stringify(json.result, null, 2).slice(0, 4000) : undefined,
        },
      }))
    } catch (e) {
      setResults(prev => ({
        ...prev,
        [stateKey]: { ok: false, action, error: e instanceof Error ? e.message : String(e) },
      }))
    } finally {
      setLoading(null)
    }
  }

  const syncAll = async () => {
    for (const a of ACTIONS) {
      if (!a.syncAction || a.key === 'lot_detail') continue // 途程需要 items 不自動跑
      await callApi(a.syncAction, true)
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="border-b border-slate-800/60 bg-slate-900/60 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-emerald-300">塔台 SARA · 同步區</h1>
          <p className="text-sm text-slate-400 mt-1">與 SARA Factory API 的連線測試與資料抓取面板</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/sara/schema"
            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm border border-slate-600"
          >
            📋 欄位檢視
          </Link>
          <Link
            href="/admin"
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm border border-slate-700"
          >
            ← 返回管理首頁
          </Link>
        </div>
      </div>

      <div className="p-6 max-w-6xl space-y-6">
        <div className="flex justify-end">
          <button
            onClick={syncAll}
            disabled={!!loading}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold"
          >
            {loading?.startsWith('sync:') ? '同步進行中…' : '🚀 一鍵同步全部（不含途程）'}
          </button>
        </div>
        {/* 環境變數提示 */}
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 text-sm">
          <div className="font-semibold text-amber-300 mb-1">⚙️ 環境變數設定</div>
          <p className="text-slate-300 leading-relaxed">
            請在 <code className="px-1 bg-slate-800 rounded">.env.local</code> 設定：
          </p>
          <pre className="mt-2 bg-slate-900 rounded p-3 text-xs text-emerald-200 overflow-x-auto">
SARA_CLIENT_SECRET=你的_client_secret
# 可選，預設即為下方網址
SARA_BASE_URL=https://sara-factory.com/api/data_export
          </pre>
          <p className="text-slate-400 mt-2 text-xs">
            client_secret 請至 SARA 系統產生或聯絡塔台同仁。設定後重新啟動 dev server 即可。
          </p>
        </div>

        {/* 動作按鈕區 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ACTIONS.map(a => {
            const r = results[a.key]
            const sr = a.syncAction ? results[`sync:${a.syncAction}`] : undefined
            const busy = loading === a.key
            const syncBusy = a.syncAction ? loading === `sync:${a.syncAction}` : false
            return (
              <div
                key={a.key}
                className={`rounded-xl border p-4 transition ${
                  r?.ok ? 'border-emerald-500/40 bg-emerald-950/20'
                  : r && !r.ok ? 'border-rose-500/40 bg-rose-950/20'
                  : 'border-slate-700 bg-slate-900/40'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="font-semibold">{a.label}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{a.desc}</div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => callApi(a.key)}
                      disabled={busy || syncBusy}
                      className="px-3 py-1.5 rounded-lg text-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="呼叫 API 並預覽回應"
                    >
                      {busy ? '預覽中…' : '預覽'}
                    </button>
                    {a.syncAction && (
                      <button
                        onClick={() => callApi(a.syncAction!, true)}
                        disabled={busy || syncBusy}
                        className="px-3 py-1.5 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="呼叫 API 並寫入 Supabase"
                      >
                        {syncBusy ? '入庫中…' : '同步入庫'}
                      </button>
                    )}
                  </div>
                </div>

                {a.needsBody && (
                  <div className="mt-2">
                    <label className="text-xs text-slate-400">items（JSON 陣列）</label>
                    <textarea
                      className="w-full mt-1 bg-slate-950 border border-slate-700 rounded p-2 text-xs font-mono"
                      rows={5}
                      value={lotItems}
                      onChange={e => setLotItems(e.target.value)}
                    />
                  </div>
                )}

                {sr && (
                  <div className="mt-3 text-xs">
                    {sr.ok ? (
                      <div className="text-emerald-300">
                        🗄️ 入庫成功 · {sr.elapsedMs}ms{sr.count != null ? ` · ${sr.count} 筆` : ''}
                        {sr.message ? ` · ${sr.message}` : ''}
                      </div>
                    ) : (
                      <div className="text-rose-300 break-all">🗄️ 入庫失敗：{sr.error}</div>
                    )}
                  </div>
                )}

                {r && (
                  <div className="mt-3 text-xs">
                    {r.ok ? (
                      <div className="text-emerald-300">
                        ✓ 預覽成功 · {r.elapsedMs}ms{r.count != null ? ` · ${r.count} 筆` : ''}
                      </div>
                    ) : (
                      <div className="text-rose-300 break-all">✗ {r.error}</div>
                    )}
                    {r.preview && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-slate-400 hover:text-slate-200">查看回應內容</summary>
                        <pre className="mt-2 max-h-80 overflow-auto bg-slate-950 border border-slate-800 rounded p-2 text-[11px] text-slate-300">
{r.preview}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </main>
  )
}
