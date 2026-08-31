'use client'

// 塔台即時看板（唯讀）
//
// 資料來源：sara_wip_records（由 /api/cron/sara-wip-sync 定時從塔台 /data/wip 同步進來，
// 見 lib/saraSync.ts 的 syncWipRecords）。本頁面完全唯讀——不提供任何修改操作，
// 顯示內容一律以塔台回報為準；要更正資料請至塔台系統操作，下次同步自動反映。
//
// 時間欄位注意：sara_wip_records 的 real_start_time/real_end_time 儲存的是台北當地
// 時鐘值（沿用人工 CSV 匯入時代的慣例，字面值即台北時間，僅型別上被標成 UTC），
// 所以顯示直接切字串、計算經過時間時用「現在的台北時鐘」對減，不做時區轉換。

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

interface WipRow {
  work_order: string
  mo_nbr: string | null
  product_name: string | null
  product_description: string | null
  lot_nbr: string | null
  workcenter_name: string | null
  job_name: string | null
  job_sequence: number | null
  status: string | null
  wip_qty: number | null
  real_start_time: string | null
  real_end_time: string | null
  report_resources: string | null
  username: string | null
  site_label: string | null
}

/** 現在的台北時鐘值，用「假裝是 UTC」的 epoch 表示（跟資料庫存值同一座標系，可直接相減） */
function taipeiNowAsUtcMs(): number {
  return Date.now() + 8 * 3600 * 1000
}

function fmtClock(ts: string | null): string {
  if (!ts) return '—'
  return ts.slice(5, 16).replace('T', ' ')
}

function fmtElapsed(startTs: string | null): string {
  if (!startTs) return ''
  const start = Date.parse(startTs)
  if (!Number.isFinite(start)) return ''
  const mins = Math.max(0, Math.floor((taipeiNowAsUtcMs() - start) / 60000))
  if (mins < 60) return `${mins} 分鐘`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h} 小時 ${mins % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小時`
}

const SITE_BADGE: Record<string, string> = {
  '台北': 'bg-sky-800/60 text-sky-300 border border-sky-700/40',
  '常平': 'bg-orange-800/60 text-orange-300 border border-orange-700/40',
  '委外': 'bg-violet-800/60 text-violet-300 border border-violet-700/40',
}

// 進行中卡片只看這個時間內開始的（塔台裡有大量從未收尾的陳年 running 紀錄，
// 必須用時間窗過濾，否則畫面會被幾千筆殭屍紀錄淹掉）
const ACTIVE_WINDOW_HOURS = 48

export default function SaraLiveBoardPage() {
  const [activeRows, setActiveRows] = useState<WipRow[]>([])
  const [finishedToday, setFinishedToday] = useState<WipRow[]>([])
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null)

  const load = useCallback(async () => {
    try {
      setLoadError('')
      const nowUtcLike = taipeiNowAsUtcMs()
      const activeCutoff = new Date(nowUtcLike - ACTIVE_WINDOW_HOURS * 3600 * 1000).toISOString()
      // 台北的今天 00:00（同座標系）
      const taipeiNow = new Date(nowUtcLike)
      const todayStart = new Date(Date.UTC(taipeiNow.getUTCFullYear(), taipeiNow.getUTCMonth(), taipeiNow.getUTCDate())).toISOString()

      const [activeRes, finishedRes, syncRes] = await Promise.all([
        supabase
          .from('sara_wip_records')
          .select('work_order,mo_nbr,product_name,product_description,lot_nbr,workcenter_name,job_name,job_sequence,status,wip_qty,real_start_time,real_end_time,report_resources,username,site_label')
          .in('status', ['running', 'pause'])
          .gte('real_start_time', activeCutoff)
          .order('real_start_time', { ascending: false })
          .limit(500),
        supabase
          .from('sara_wip_records')
          .select('work_order,mo_nbr,product_name,product_description,lot_nbr,workcenter_name,job_name,job_sequence,status,wip_qty,real_start_time,real_end_time,report_resources,username,site_label')
          .eq('status', 'finished')
          .gte('real_end_time', todayStart)
          .order('real_end_time', { ascending: false })
          .limit(1000),
        supabase
          .from('sara_wip_records')
          .select('real_end_time')
          .not('real_end_time', 'is', null)
          .order('real_end_time', { ascending: false })
          .limit(1),
      ])
      if (activeRes.error) throw new Error(activeRes.error.message)
      if (finishedRes.error) throw new Error(finishedRes.error.message)
      setActiveRows((activeRes.data ?? []) as WipRow[])
      setFinishedToday((finishedRes.data ?? []) as WipRow[])
      const sync = (syncRes.data?.[0] as { real_end_time?: string } | undefined)?.real_end_time ?? null
      setLastSyncedAt(sync)
      setRefreshedAt(new Date())
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 60000)
    return () => clearInterval(timer)
  }, [load])

  // 依站點分欄（進行中優先排前面的站，其次今日有完成量的站）
  const workcenters = useMemo(() => {
    const set = new Map<string, { active: WipRow[]; finished: WipRow[] }>()
    const ensure = (name: string) => {
      if (!set.has(name)) set.set(name, { active: [], finished: [] })
      return set.get(name)!
    }
    for (const r of activeRows) ensure(r.workcenter_name || '未指定站點').active.push(r)
    for (const r of finishedToday) ensure(r.workcenter_name || '未指定站點').finished.push(r)
    return Array.from(set.entries())
      .sort((a, b) => (b[1].active.length - a[1].active.length) || (b[1].finished.length - a[1].finished.length))
  }, [activeRows, finishedToday])

  const totalRunning = activeRows.filter(r => r.status === 'running').length
  const totalPause = activeRows.filter(r => r.status === 'pause').length
  const totalFinishedQty = finishedToday.reduce((s, r) => s + (r.wip_qty ?? 0), 0)

  return (
    <div className="min-h-screen bg-[#050b14] p-4 md:p-6">
      {/* 頁首 */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            📡 塔台即時看板
            <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-600 text-slate-400 text-[10px] font-medium">唯讀</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            資料一律以塔台（SARA）現場報工為準，本頁不提供修改；要更正請至塔台操作，下次同步自動反映。
          </p>
        </div>
        <div className="text-right text-[11px] text-slate-500 shrink-0">
          <div>塔台最新報工時間：<span className="text-slate-300 font-mono">{lastSyncedAt ? fmtClock(lastSyncedAt) : '—'}</span></div>
          <div>畫面更新於：<span className="text-slate-300 font-mono">{refreshedAt ? refreshedAt.toLocaleTimeString('zh-TW', { hour12: false }) : '—'}</span>（每分鐘自動刷新）</div>
        </div>
      </div>

      {/* 總覽列 */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="px-4 py-2 rounded-xl bg-yellow-950/40 border border-yellow-700/40">
          <div className="text-[10px] text-yellow-500/80">進行中</div>
          <div className="text-2xl font-bold text-yellow-300 font-mono">{totalRunning}</div>
        </div>
        <div className="px-4 py-2 rounded-xl bg-amber-950/40 border border-amber-700/40">
          <div className="text-[10px] text-amber-500/80">暫停中</div>
          <div className="text-2xl font-bold text-amber-300 font-mono">{totalPause}</div>
        </div>
        <div className="px-4 py-2 rounded-xl bg-emerald-950/40 border border-emerald-700/40">
          <div className="text-[10px] text-emerald-500/80">今日完成筆數</div>
          <div className="text-2xl font-bold text-emerald-300 font-mono">{finishedToday.length}</div>
        </div>
        <div className="px-4 py-2 rounded-xl bg-emerald-950/40 border border-emerald-700/40">
          <div className="text-[10px] text-emerald-500/80">今日完成數量</div>
          <div className="text-2xl font-bold text-emerald-300 font-mono">{totalFinishedQty.toLocaleString()}</div>
        </div>
      </div>

      {loadError && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/30 border border-red-700/50 text-red-300 text-sm">
          ❌ 載入失敗：{loadError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24 text-slate-500">
          <svg className="animate-spin w-6 h-6 mr-2" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          載入中…
        </div>
      ) : workcenters.length === 0 ? (
        <div className="text-center py-24 text-slate-500 text-sm">目前沒有 {ACTIVE_WINDOW_HOURS} 小時內開始的進行中工序，今日也尚無完成回報</div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4 items-start">
          {workcenters.map(([wc, group]) => (
            <div key={wc} className="w-80 shrink-0 bg-slate-950 border border-slate-800 rounded-xl flex flex-col max-h-[calc(100vh-260px)]">
              {/* 欄標題 */}
              <div className="p-3 border-b border-slate-800 bg-slate-900/60 rounded-t-xl flex items-center justify-between">
                <h2 className="font-bold text-white text-sm truncate">{wc}</h2>
                <div className="flex items-center gap-2 shrink-0 text-[10px]">
                  {group.active.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-300 border border-yellow-700/40 font-mono">{group.active.length} 進行</span>
                  )}
                  <span className="px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-300 border border-emerald-700/40 font-mono">今日完成 {group.finished.length}</span>
                </div>
              </div>

              {/* 進行中卡片 */}
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {group.active.length === 0 && (
                  <div className="text-center text-slate-600 text-xs py-4">目前無進行中工序</div>
                )}
                {group.active.map(r => {
                  const isPause = r.status === 'pause'
                  return (
                    <div key={r.work_order} className={`p-2.5 rounded-lg border ${isPause ? 'bg-amber-950/20 border-amber-800/50' : 'bg-slate-900 border-slate-700'}`}>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="font-mono font-bold text-cyan-300 text-xs truncate">{r.mo_nbr || '—'}</span>
                        <span className={`shrink-0 flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                          isPause ? 'bg-amber-900/60 text-amber-300 border-amber-600/50' : 'bg-yellow-900/60 text-yellow-300 border-yellow-600/50'
                        }`}>
                          {!isPause && <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-yellow-400"></span></span>}
                          {isPause ? '暫停' : '進行中'}
                        </span>
                      </div>
                      <div className="text-white text-xs font-semibold mb-0.5 truncate" title={r.product_name ?? undefined}>{r.product_name || '—'}</div>
                      <div className="text-slate-400 text-[11px] mb-1.5 truncate">{r.job_name || '—'}{r.job_sequence != null ? `（第 ${r.job_sequence} 站）` : ''}</div>
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-400 truncate max-w-[55%]" title={r.report_resources ?? undefined}>👤 {r.report_resources || '—'}</span>
                        {r.site_label && <span className={`px-1.5 py-0.5 rounded-full font-semibold ${SITE_BADGE[r.site_label] ?? 'bg-slate-700 text-slate-300'}`}>{r.site_label}</span>}
                      </div>
                      <div className="mt-1.5 pt-1.5 border-t border-slate-800/60 flex items-center justify-between text-[10px] text-slate-500 font-mono">
                        <span>{fmtClock(r.real_start_time)} 開始</span>
                        <span className={isPause ? 'text-amber-400' : 'text-yellow-400'}>已 {fmtElapsed(r.real_start_time)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* 今日完成清單（收合式） */}
              {group.finished.length > 0 && (
                <details className="border-t border-slate-800">
                  <summary className="px-3 py-2 text-[11px] text-emerald-400/90 cursor-pointer select-none hover:bg-slate-900/60">
                    ✅ 今日完成 {group.finished.length} 筆（共 {group.finished.reduce((s, r) => s + (r.wip_qty ?? 0), 0).toLocaleString()} 件）
                  </summary>
                  <div className="max-h-56 overflow-y-auto px-2 pb-2 space-y-1">
                    {group.finished.map(r => (
                      <div key={r.work_order} className="px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800/60 text-[10px] flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-mono text-cyan-400/80">{r.mo_nbr || '—'}</span>
                          <span className="text-slate-400 ml-1.5">{r.job_name || ''}</span>
                        </div>
                        <div className="shrink-0 text-right">
                          <span className="text-emerald-300 font-mono">{r.wip_qty != null ? r.wip_qty.toLocaleString() : '—'} 件</span>
                          <span className="text-slate-600 font-mono ml-1.5">{r.real_end_time ? r.real_end_time.slice(11, 16) : ''}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
