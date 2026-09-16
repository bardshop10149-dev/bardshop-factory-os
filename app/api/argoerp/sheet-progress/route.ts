import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// 出單表的「生產進度」：一次查一整張出單表上所有製令，逐道工序判斷做完了沒。
//
// 為什麼要走 API 而不是讓頁面直接查 Supabase：
//   sara_wip_schedule / sara_lot_progress 有 RLS（select to authenticated），
//   而本站的登入 token 放在 httpOnly cookie、瀏覽器端的 supabase client 其實是
//   匿名身分——直接查會靜默回空陣列。故比照 /api/sara/wip-schedule，由伺服器
//   以 service role 代讀，前端只拿彙總結果。
//
// 三個來源各自回答一個問題（見 sql/20260825_sara_wip_from_web_api.sql）：
//   sara_wip_records   哪幾道工序「已經報工」——這是判斷完成與否的唯一可靠來源
//   sara_wip_schedule  還在排程上的工序（做完的會從塔台排程消失，但不保證立刻消失）
//   sara_lot_progress  塔台自己算的整批百分比
// 兩邊的工序取聯集才是完整途程：只看排程會漏掉已完成的，只看報工會漏掉還沒做的。
//
// 判斷完成一律用 status='finished'，不能只看 real_end_time——暫停(pause)的報工
// 同樣有結束時間（全庫 557 筆 pause 都有值），只看時間會把暫停誤判為完成。
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MOS = 500
const CHUNK = 200

export type StepStatus = 'finished' | 'running' | 'pause' | 'pending'

export interface SheetProgressStep {
  sequence: number | null
  station: string | null
  jobName: string | null
  status: StepStatus
  qty: number | null        // 已報工數量（同一道工序多次報工則加總）
  endTime: string | null    // 最後一次完工時間
}

export interface SheetProgress {
  doneCount: number
  totalCount: number
  runningCount: number
  percentage: number | null   // 塔台自己算的整批百分比（多批時取平均）
  healthState: string | null
  lastReportAt: string | null
  steps: SheetProgressStep[]
}

interface RecordRow {
  mo_nbr: string | null
  job_sequence: number | null
  job_name: string | null
  workcenter_name: string | null
  status: string | null
  wip_qty: number | null
  real_end_time: string | null
}

interface ScheduleRow {
  mo_nbr: string | null
  job_sequence: number | null
  job_name: string | null
  workcenter_name: string | null
  system_status: string | null
  synced_at: string | null
}

interface LotRow {
  mo_nbr: string | null
  progress_percentage: number | null
  health_state: string | null
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json().catch(() => null)
    const mos = [...new Set(
      (Array.isArray(body?.mos) ? body.mos : [])
        .map((m: unknown) => String(m ?? '').trim().toUpperCase())
        .filter(Boolean) as string[]
    )].slice(0, MAX_MOS)

    if (mos.length === 0) {
      return NextResponse.json({ success: true, progress: {}, synced_at: null })
    }

    const supabase = getSupabaseAdminClient()
    const records: RecordRow[] = []
    const schedules: ScheduleRow[] = []
    const lots: LotRow[] = []

    for (const part of chunk(mos, CHUNK)) {
      const [rec, sch, lot] = await Promise.all([
        supabase
          .from('sara_wip_records')
          .select('mo_nbr, job_sequence, job_name, workcenter_name, status, wip_qty, real_end_time')
          .in('mo_nbr', part),
        supabase
          .from('sara_wip_schedule')
          .select('mo_nbr, job_sequence, job_name, workcenter_name, system_status, synced_at')
          .in('mo_nbr', part),
        supabase
          .from('sara_lot_progress')
          .select('mo_nbr, progress_percentage, health_state')
          .in('mo_nbr', part),
      ])
      if (rec.error) throw new Error(rec.error.message)
      if (sch.error) throw new Error(sch.error.message)
      if (lot.error) throw new Error(lot.error.message)
      records.push(...((rec.data ?? []) as RecordRow[]))
      schedules.push(...((sch.data ?? []) as ScheduleRow[]))
      lots.push(...((lot.data ?? []) as LotRow[]))
    }

    // 以「製令 → 工序序號」為格子彙總；序號缺漏的列用 -1 當作獨立一格，不與其他工序混在一起
    const byMo = new Map<string, Map<number, SheetProgressStep>>()
    const stepsOf = (mo: string) => {
      if (!byMo.has(mo)) byMo.set(mo, new Map())
      return byMo.get(mo)!
    }

    // ① 先鋪排程上的工序（含還沒開工的），這是「完整途程」的骨架
    for (const r of schedules) {
      const mo = (r.mo_nbr ?? '').toUpperCase()
      if (!mo) continue
      const seq = r.job_sequence ?? -1
      const raw = (r.system_status ?? '').toLowerCase()
      const status: StepStatus =
        raw === 'finished' ? 'finished' : raw === 'running' ? 'running' : raw === 'pause' ? 'pause' : 'pending'
      stepsOf(mo).set(seq, {
        sequence: r.job_sequence,
        station: r.workcenter_name,
        jobName: r.job_name,
        status,
        qty: null,
        endTime: null,
      })
    }

    // ② 再用報工紀錄覆蓋：報工是既成事實，優先於排程狀態。
    //    同一道工序可能報工多次（分批報），數量加總、時間取最後一次。
    let lastSyncedAt: string | null = null
    for (const r of records) {
      const mo = (r.mo_nbr ?? '').toUpperCase()
      if (!mo) continue
      const seq = r.job_sequence ?? -1
      const map = stepsOf(mo)
      const prev = map.get(seq)
      const raw = (r.status ?? '').toLowerCase()
      const reported: StepStatus =
        raw === 'finished' ? 'finished' : raw === 'running' ? 'running' : raw === 'pause' ? 'pause' : 'pending'
      // 一道工序只要有任何一筆 finished 就算做完（分批報工時最後一筆才是 finished）
      const status: StepStatus =
        prev?.status === 'finished' || reported === 'finished' ? 'finished'
        : prev?.status === 'running' || reported === 'running' ? 'running'
        : reported
      const qty = (prev?.qty ?? 0) + (r.wip_qty ?? 0)
      const endTime = [prev?.endTime, r.real_end_time].filter(Boolean).sort().pop() ?? null
      map.set(seq, {
        sequence: r.job_sequence ?? prev?.sequence ?? null,
        station: r.workcenter_name ?? prev?.station ?? null,
        jobName: r.job_name ?? prev?.jobName ?? null,
        status,
        qty: qty || null,
        endTime,
      })
      if (endTime && (!lastSyncedAt || endTime > lastSyncedAt)) lastSyncedAt = endTime
    }

    // ③ 塔台自己算的整批百分比（一張製令理論上一批，真有多批時取平均）
    const lotAgg = new Map<string, { sum: number; n: number; health: string | null }>()
    for (const l of lots) {
      const mo = (l.mo_nbr ?? '').toUpperCase()
      if (!mo) continue
      const cur = lotAgg.get(mo) ?? { sum: 0, n: 0, health: null }
      if (l.progress_percentage != null) { cur.sum += Number(l.progress_percentage); cur.n++ }
      cur.health = cur.health ?? l.health_state
      lotAgg.set(mo, cur)
    }

    const progress: Record<string, SheetProgress> = {}
    for (const [mo, map] of byMo) {
      const steps = [...map.values()].sort((a, b) => (a.sequence ?? 999) - (b.sequence ?? 999))
      const agg = lotAgg.get(mo)
      progress[mo] = {
        doneCount: steps.filter(s => s.status === 'finished').length,
        totalCount: steps.length,
        runningCount: steps.filter(s => s.status === 'running').length,
        percentage: agg && agg.n > 0 ? Math.round(agg.sum / agg.n) : null,
        healthState: agg?.health ?? null,
        lastReportAt: steps.reduce<string | null>((max, s) => (s.endTime && (!max || s.endTime > max) ? s.endTime : max), null),
        steps,
      }
    }

    // 排程表的同步時間 ＝ 這份進度資料的新鮮度（報工紀錄另有自己的排程，兩者都是定時同步）
    const syncedAt = schedules.reduce<string | null>(
      (max, r) => (r.synced_at && (!max || r.synced_at > max) ? r.synced_at : max), null,
    )

    return NextResponse.json(
      { success: true, progress, synced_at: syncedAt },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
