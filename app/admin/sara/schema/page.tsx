'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

interface ColumnInfo {
  name: string
  type: string
  sample: string
}

interface TableInfo {
  table: string
  count: number
  columns: ColumnInfo[]
  hasData: boolean
}

const TYPE_COLOR: Record<string, string> = {
  text:        'bg-sky-900/60 text-sky-200',
  integer:     'bg-violet-900/60 text-violet-200',
  number:      'bg-violet-900/60 text-violet-200',
  boolean:     'bg-amber-900/60 text-amber-200',
  timestamptz: 'bg-teal-900/60 text-teal-200',
  jsonb:       'bg-rose-900/60 text-rose-200',
  null:        'bg-slate-700/60 text-slate-400',
}

export default function SaraSchemaPage() {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/sara/schema')
      .then(r => r.json())
      .then(j => {
        if (!j.ok) throw new Error(j.error)
        setTables(j.tables)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="border-b border-slate-800/60 bg-slate-900/60 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-emerald-300">塔台 SARA · 資料表欄位</h1>
          <p className="text-sm text-slate-400 mt-1">各 sara_* 表格的欄位清單、類型與筆數</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/sara/sync"
            className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm border border-emerald-600"
          >
            ← 同步區
          </Link>
          <Link
            href="/admin"
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm border border-slate-700"
          >
            管理首頁
          </Link>
        </div>
      </div>

      <div className="p-6 max-w-7xl space-y-6">
        {loading && (
          <div className="text-slate-400 text-center py-20">載入中…</div>
        )}
        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/20 p-4 text-rose-300">
            {error}
          </div>
        )}
        {!loading && !error && (
          <>
            {/* 統計摘要 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {tables.map(t => (
                <div
                  key={t.table}
                  className="rounded-xl border border-slate-700 bg-slate-900/50 p-3 text-center"
                >
                  <div className="text-xs text-slate-400 truncate">{t.table}</div>
                  <div className="text-2xl font-bold text-emerald-300 mt-1">
                    {t.count.toLocaleString()}
                  </div>
                  <div className="text-xs text-slate-500">筆 · {t.columns.length} 欄</div>
                </div>
              ))}
            </div>

            {/* 各表欄位詳情 */}
            {tables.map(t => (
              <div
                key={t.table}
                className="rounded-xl border border-slate-700 bg-slate-900/40 overflow-hidden"
              >
                <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
                  <h2 className="font-mono font-semibold text-emerald-300">{t.table}</h2>
                  <span className="text-xs text-slate-400">
                    {t.count.toLocaleString()} 筆 · {t.columns.length} 欄
                    {!t.hasData && <span className="ml-2 text-amber-400">（尚無資料）</span>}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-slate-500 border-b border-slate-800">
                        <th className="text-left px-4 py-2 w-8">#</th>
                        <th className="text-left px-4 py-2">欄位名稱</th>
                        <th className="text-left px-4 py-2 w-32">類型</th>
                        <th className="text-left px-4 py-2">樣本值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.columns.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-slate-500 text-xs">
                            尚未同步資料，欄位資訊無法顯示
                          </td>
                        </tr>
                      ) : (
                        t.columns.map((col, i) => (
                          <tr
                            key={col.name}
                            className="border-b border-slate-800/50 hover:bg-slate-800/30 transition"
                          >
                            <td className="px-4 py-2 text-xs text-slate-600">{i + 1}</td>
                            <td className="px-4 py-2 font-mono text-slate-200">{col.name}</td>
                            <td className="px-4 py-2">
                              <span className={`px-2 py-0.5 rounded text-xs font-mono ${TYPE_COLOR[col.type] ?? 'bg-slate-700 text-slate-300'}`}>
                                {col.type}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-xs text-slate-400 font-mono truncate max-w-xs">
                              {col.sample}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </main>
  )
}
