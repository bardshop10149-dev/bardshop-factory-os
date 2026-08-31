'use client'

// 塔台產線看板（唯讀）——六個產線排程看板（印刷/雷切/後加工/包裝/委外/常平）共用的本體。
//
// 2026-08-31 起這六個看板改以塔台（SARA）資料為準、完全唯讀：不提供任何修改操作，
// 要更正資料請至塔台系統操作，下次同步自動反映。每個看板依 SECTION_WORKCENTERS
// 對應到塔台的站點，只顯示自己站點的報工與排程。
//
// 資料來源：
//   sara_wip_records  ＝報工紀錄（/api/cron/sara-wip-sync 定時從塔台 /data/wip 同步）
//   sara_wip_schedule ＝排程（/api/sara/wip-sync 每小時同步，經 /api/sara/wip-schedule 代讀）
//
// 時間欄位注意：real_start_time/real_end_time 儲存的是台北當地時鐘值（沿用人工 CSV
// 匯入時代的慣例，字面值即台北時間，僅型別上被標成 UTC），所以顯示直接切字串、
// 計算經過時間時用「現在的台北時鐘」對減，不做時區轉換。

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabaseClient'

/** 六個看板 → 塔台站點的對應（塔台實際出現過的 workcenter_name） */
export const SECTION_WORKCENTERS: Record<string, string[]> = {
  printing:   ['印刷站2F', '印刷站6F', 'UV印刷'],
  laser:      ['雷切站'],
  post:       ['後加工站'],
  packaging:  ['包裝站'],
  outsourced: ['轉運站', '委外製作'],
  changping:  ['常平廠'],
}

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

// ── 排程檢視 ──────────────────────────────────────────────────────────

interface ScheduleRow {
  jid: number
  mo_nbr: string | null
  doc_nbr: string | null
  so_line_no: string | null
  product_name: string | null
  lot_nbr: string | null
  workcenter_name: string | null
  job_name: string | null
  job_sequence: number | null
  qty: number | null
  wip_qty: number | null
  system_status: string | null
  is_running: boolean | null
  plan_start_time: string | null
  plan_end_time: string | null
  real_start_time: string | null
  resource_names: string | null
  sourcing: string | null
}

// 機台群組（2026-08-31 生管定義：同一組操作人員的機台併成一欄）。
// 之後要調整分組直接改這裡即可；沒列在群組裡的機台各自獨立一欄。
const MACHINE_GROUPS: { name: string; members: string[] }[] = [
  {
    name: '7151（3/6/11）', // 周立婷、陳龍隆操作
    members: ['7151#3', '7151#6', '7151#11'],
  },
  {
    name: '7151（7/8/9/10）', // 聰、季操作
    members: ['7151#7', '7151#8', '7151#9', '7151#10'],
  },
  {
    name: '雷切機群（S400＋大黃蜂）', // 共同操作
    members: [
      '雷射切割機_S400#1_GCC', '雷射切割機_S400#2_GCC', '雷射切割機_S400#3_GCC',
      '雷射切割機_大黃蜂#1', '雷射切割機_大黃蜂#2', '雷射切割機_大黃蜂#3',
      '雷射切割機_大黃蜂#4', '雷射切割機_大黃蜂#5',
    ],
  },
]

const MACHINE_TO_GROUP = new Map<string, string>(
  MACHINE_GROUPS.flatMap(g => g.members.map(m => [m, g.name] as [string, string]))
)

/** 塔台排程的資源欄可能是「機台,操作人員」組合（如 7151#8,瞿㻑倫）——拆出機台本體與人員 */
function splitResource(resourceNames: string | null): { machine: string; operator: string | null } {
  const raw = (resourceNames ?? '').trim()
  if (!raw) return { machine: '(未指定機台)', operator: null }
  const idx = raw.indexOf(',')
  if (idx === -1) return { machine: raw, operator: null }
  return { machine: raw.slice(0, idx).trim(), operator: raw.slice(idx + 1).trim() || null }
}

/** 機台 → 顯示群組名稱（有定義群組的併組，其餘用機台本名） */
function machineGroupName(machine: string): string {
  return MACHINE_TO_GROUP.get(machine) ?? machine
}

/** 'YYYY-MM-DD HH:mm' → 'HH:mm'；空值回 '—' */
function planClock(ts: string | null): string {
  if (!ts) return '—'
  return ts.slice(11, 16) || '—'
}

const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const

export default function SaraProductionBoard({ sectionId, sectionName }: { sectionId: string, sectionName: string }) {
  const boardWorkcenters = useMemo(() => SECTION_WORKCENTERS[sectionId] ?? [], [sectionId])
  const [activeRows, setActiveRows] = useState<WipRow[]>([])
  const [finishedToday, setFinishedToday] = useState<WipRow[]>([])
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [resyncing, setResyncing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null)

  // 這六頁本來就是「排程看板」，預設先看排程週曆，即時現況為次要分頁
  const [view, setView] = useState<'now' | 'schedule'>('schedule')
  const [schedRows, setSchedRows] = useState<ScheduleRow[]>([])
  const [schedSyncedAt, setSchedSyncedAt] = useState<string | null>(null)
  const [schedMode, setSchedMode] = useState<'station' | 'machine'>('machine')
  const [schedSelected, setSchedSelected] = useState<string | null>(null)
  // 週曆位移：0=本週、1=下週、2=下下週…（跟既有排程看板一樣以週一為一週起點）
  const [weekOffset, setWeekOffset] = useState(0)

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
          .in('workcenter_name', boardWorkcenters)
          .gte('real_start_time', activeCutoff)
          .order('real_start_time', { ascending: false })
          .limit(500),
        supabase
          .from('sara_wip_records')
          .select('work_order,mo_nbr,product_name,product_description,lot_nbr,workcenter_name,job_name,job_sequence,status,wip_qty,real_start_time,real_end_time,report_resources,username,site_label')
          .eq('status', 'finished')
          .in('workcenter_name', boardWorkcenters)
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

      // 排程資料（sara_wip_schedule 有 RLS，經 API 以 service role 代讀）
      try {
        const schedRes = await fetch('/api/sara/wip-schedule', { cache: 'no-store' })
        const schedJson = await schedRes.json() as { success: boolean; rows?: ScheduleRow[]; synced_at?: string | null }
        if (schedRes.ok && schedJson.success) {
          setSchedRows((schedJson.rows ?? []).filter(r => boardWorkcenters.includes(r.workcenter_name ?? '')))
          setSchedSyncedAt(schedJson.synced_at ?? null)
        }
      } catch {
        // 排程載入失敗不影響即時現況檢視
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [boardWorkcenters])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 60000)
    return () => clearInterval(timer)
  }, [load])

  // 手動觸發「向塔台重新同步」：塔台每次重新排程會整批重算（工序ID/時間/機台都會變），
  // 定時快照最多落後半小時；懷疑畫面舊了可按此立即抓最新（實測一輪約 10 秒）
  const handleResync = useCallback(async () => {
    if (resyncing) return
    setResyncing(true)
    try {
      const res = await fetch('/api/sara/wip-sync', { method: 'POST' })
      const j = await res.json().catch(() => null)
      if (!res.ok || j?.status !== 'ok') throw new Error(j?.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setLoadError(`向塔台同步失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setResyncing(false)
    }
  }, [resyncing, load])

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

  // ── 排程檢視：依站點或機台群組彙整 ──
  const todayStr = useMemo(() => {
    const t = new Date(taipeiNowAsUtcMs())
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
  }, [refreshedAt])  // eslint-disable-line react-hooks/exhaustive-deps -- 隨每次刷新重算即可

  const schedGroups = useMemo(() => {
    const map = new Map<string, ScheduleRow[]>()
    for (const r of schedRows) {
      const key = schedMode === 'station'
        ? (r.workcenter_name || '(未指定站點)')
        : machineGroupName(splitResource(r.resource_names).machine)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    for (const rows of map.values()) {
      rows.sort((a, b) => (a.plan_start_time ?? '9999').localeCompare(b.plan_start_time ?? '9999'))
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length)
  }, [schedRows, schedMode])

  const selectedGroupKey = schedSelected && schedGroups.some(([k]) => k === schedSelected)
    ? schedSelected
    : (schedGroups[0]?.[0] ?? null)
  const selectedGroupRows = useMemo(() => {
    if (!selectedGroupKey) return []
    return schedGroups.find(([k]) => k === selectedGroupKey)?.[1] ?? []
  }, [schedGroups, selectedGroupKey])

  // 選定週的每一天（週一為起點，7 天）
  const weekDates = useMemo(() => {
    const now = new Date(taipeiNowAsUtcMs())
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const dow = base.getUTCDay() // 0=日
    base.setUTCDate(base.getUTCDate() - (dow === 0 ? 6 : dow - 1) + weekOffset * 7)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base)
      d.setUTCDate(base.getUTCDate() + i)
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    })
  }, [weekOffset, refreshedAt])  // eslint-disable-line react-hooks/exhaustive-deps -- 隨每次刷新重算即可

  // 選定群組的排程依日期索引（供週曆格查表）
  const selectedByDate = useMemo(() => {
    const map = new Map<string, ScheduleRow[]>()
    for (const r of selectedGroupRows) {
      const d = (r.plan_start_time ?? '').slice(0, 10)
      if (!d) continue
      if (!map.has(d)) map.set(d, [])
      map.get(d)!.push(r)
    }
    return map
  }, [selectedGroupRows])

  return (
    <div className="min-h-screen bg-[#050b14] p-4 md:p-6">
      {/* 頁首 */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            📡 {sectionName}排程看板
            <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-600 text-slate-400 text-[10px] font-medium">唯讀・塔台資料</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            資料一律以塔台（SARA）為準（站點：{boardWorkcenters.join('、')}），本頁不提供修改；要更正請至塔台操作，下次同步自動反映。
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right text-[11px] text-slate-500">
            <div>塔台最新報工時間：<span className="text-slate-300 font-mono">{lastSyncedAt ? fmtClock(lastSyncedAt) : '—'}</span></div>
            <div>畫面更新於：<span className="text-slate-300 font-mono">{refreshedAt ? refreshedAt.toLocaleTimeString('zh-TW', { hour12: false }) : '—'}</span>（每分鐘自動刷新）</div>
          </div>
          <button
            onClick={() => void handleResync()}
            disabled={resyncing}
            title="塔台每次重新排程會整批重算，定時快照最多落後半小時；按此立即向塔台抓最新排程（約 10 秒）"
            className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-xs font-medium hover:bg-slate-700 hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-50 transition-colors"
          >
            {resyncing ? '⏳ 同步中…' : '🔄 立即同步塔台'}
          </button>
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

      {/* 檢視切換 */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setView('now')}
          className={`px-4 py-1.5 rounded-lg text-sm font-bold border transition-colors ${view === 'now' ? 'bg-cyan-800/60 text-cyan-200 border-cyan-600' : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-white'}`}
        >
          ⚡ 即時現況
        </button>
        <button
          onClick={() => setView('schedule')}
          className={`px-4 py-1.5 rounded-lg text-sm font-bold border transition-colors ${view === 'schedule' ? 'bg-purple-800/60 text-purple-200 border-purple-600' : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-white'}`}
        >
          🗓 排程檢視
        </button>
        {view === 'schedule' && (
          <>
            <div className="w-px h-6 bg-slate-800 mx-1" />
            <button
              onClick={() => { setSchedMode('machine'); setSchedSelected(null) }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${schedMode === 'machine' ? 'bg-slate-700 text-white border-slate-500' : 'bg-slate-900 text-slate-500 border-slate-800 hover:text-white'}`}
            >
              依機台/群組
            </button>
            <button
              onClick={() => { setSchedMode('station'); setSchedSelected(null) }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${schedMode === 'station' ? 'bg-slate-700 text-white border-slate-500' : 'bg-slate-900 text-slate-500 border-slate-800 hover:text-white'}`}
            >
              依站點
            </button>
            <span className="text-[10px] text-slate-600 ml-2">排程同步於：{schedSyncedAt ? new Date(schedSyncedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—'}</span>
          </>
        )}
      </div>

      {view === 'schedule' ? (
        schedRows.length === 0 ? (
          <div className="text-center py-24 text-slate-500 text-sm">尚無排程資料（可能還沒同步，稍後自動重試）</div>
        ) : (
          <div className="flex flex-col lg:flex-row gap-4 items-start">
            {/* 左：群組選單 */}
            <div className="w-full lg:w-64 shrink-0 bg-slate-950 border border-slate-800 rounded-xl p-2 flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-x-visible lg:max-h-[calc(100vh-320px)] lg:overflow-y-auto">
              {schedGroups.map(([key, rows]) => (
                <button
                  key={key}
                  onClick={() => setSchedSelected(key)}
                  className={`shrink-0 lg:w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors flex items-center justify-between gap-2 ${
                    key === selectedGroupKey
                      ? 'bg-purple-900/40 border-purple-600 text-white font-bold'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white hover:border-slate-600'
                  }`}
                >
                  <span className="truncate">{key}</span>
                  <span className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{rows.length}</span>
                </button>
              ))}
            </div>

            {/* 右：選定群組的週曆排程（跟既有排程看板同樣的週檢視，可翻上/下週） */}
            <div className="flex-1 min-w-0">
              {/* 週切換列 */}
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={() => setWeekOffset(o => o - 1)}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-300 text-xs hover:text-white hover:border-slate-500"
                >◀ 上週</button>
                <button
                  onClick={() => setWeekOffset(0)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-bold ${weekOffset === 0 ? 'bg-purple-800/60 text-purple-200 border-purple-600' : 'bg-slate-900 border-slate-700 text-slate-300 hover:text-white'}`}
                >本週</button>
                <button
                  onClick={() => setWeekOffset(o => o + 1)}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-300 text-xs hover:text-white hover:border-slate-500"
                >下週 ▶</button>
                <span className="text-xs text-slate-500 font-mono ml-2">
                  {weekDates[0]?.slice(5)} ~ {weekDates[6]?.slice(5)}
                  {weekOffset > 0 && <span className="ml-1 text-purple-400">（+{weekOffset} 週）</span>}
                  {weekOffset < 0 && <span className="ml-1 text-slate-400">（{weekOffset} 週）</span>}
                </span>
                <span className="text-[10px] text-slate-600 ml-auto">本週共 {weekDates.reduce((s, d) => s + (selectedByDate.get(d)?.length ?? 0), 0)} 道工序</span>
              </div>

              {/* 週曆格：一天一欄 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-7 gap-2">
                {weekDates.map((date, i) => {
                  const rows = selectedByDate.get(date) ?? []
                  const isToday = date === todayStr
                  return (
                    <div key={date} className={`rounded-xl border flex flex-col min-h-[120px] ${isToday ? 'border-purple-600 bg-purple-950/20' : 'border-slate-800 bg-slate-950'}`}>
                      <div className={`px-2 py-1.5 border-b text-center ${isToday ? 'border-purple-700/50 bg-purple-900/30' : 'border-slate-800 bg-slate-900/60'}`}>
                        <div className={`text-[10px] ${isToday ? 'text-purple-300' : 'text-slate-500'}`}>週{DOW_ZH[(i + 1) % 7]}</div>
                        <div className={`text-xs font-bold font-mono ${isToday ? 'text-purple-200' : 'text-slate-300'}`}>{date.slice(5)}{isToday ? '・今天' : ''}</div>
                      </div>
                      <div className="flex-1 p-1.5 space-y-1.5 overflow-y-auto max-h-[52vh]">
                        {rows.length === 0 ? (
                          <div className="text-center text-slate-700 text-[10px] py-3">—</div>
                        ) : rows.map(r => {
                          const { machine, operator } = splitResource(r.resource_names)
                          const running = r.is_running === true || r.system_status === 'running'
                          return (
                            <div key={r.jid} className={`p-1.5 rounded-lg border text-[10px] ${running ? 'bg-yellow-950/30 border-yellow-700/50' : 'bg-slate-900 border-slate-800'}`}>
                              <div className="flex items-center justify-between gap-1 mb-0.5">
                                <span className="font-mono text-slate-400">{planClock(r.plan_start_time)}–{planClock(r.plan_end_time)}</span>
                                {running && <span className="relative flex h-1.5 w-1.5 shrink-0"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-yellow-400"></span></span>}
                              </div>
                              <div className="font-mono font-bold text-cyan-300 truncate" title={r.mo_nbr ?? undefined}>{r.mo_nbr || '—'}</div>
                              <div className="text-white font-semibold truncate" title={r.product_name ?? undefined}>{r.product_name || '—'}</div>
                              <div className="text-slate-400 truncate">{r.job_name || '—'}</div>
                              <div className="flex items-center justify-between gap-1 mt-0.5 text-slate-500">
                                <span className="truncate">
                                  {schedMode === 'machine'
                                    ? (MACHINE_TO_GROUP.has(machine) ? machine : (r.workcenter_name || ''))
                                    : machine}
                                </span>
                                <span className="text-emerald-300 font-mono shrink-0">{r.qty != null ? r.qty.toLocaleString() : '—'}</span>
                              </div>
                              {operator && <div className="text-slate-500 truncate">👤 {operator}</div>}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )
      ) : loading ? (
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
