import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { rowMatchesKeyword } from '@/lib/argoerp/dailyOrderSheetShared'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// 出單總表：把所有日期的每日出單表攤平成一張表，附上每一列的「生產狀態」。
//
// 為什麼放在伺服器端算：
//   daily_order_sheets 目前 104 天、7,328 列、rows 整包 6.18MB。讓瀏覽器整包拉下來
//   再自己 join 塔台報工，行動裝置會直接卡住；而且 sara_wip_schedule 之類的表
//   匿名身分讀不到（見 sheet-progress 的說明），本來就得由伺服器代讀。
//
// 狀態判定（2026-09-24 與使用者確認）：以「最後一站有沒有報工」為準。
//   已完成 = 這張工單在「包裝站」有報工紀錄
//   進行中 = 有報工紀錄，但包裝站還沒有
//   未開始 = 完全沒有報工紀錄（含尚未轉單）
//   無資料 = 查無報工，而且這張出單表早於我們第一次同步塔台報工的日期
//
// 為什麼要有「無資料」這個狀態：我們第一次同步 wip_records 是 2026-08-31，塔台只留
// 一段時間、當時已經結案移除的舊單再也拉不回來。實測報工表裡的台北製令，單號年月
// 2605 只有 6 個、2606 有 155 個，2607 之後才跳到 900 多個——也就是 6 月以前的單
// 塔台上幾乎沒有紀錄。若把這些一律算成「未開始」，預設的未完成清單會被三千多筆
// 早就做完的舊單灌爆，整頁就沒用了。分成獨立狀態、且不計入未完成，才是誠實的呈現。
//
// 為什麼「最後一站」可以直接寫死成包裝站：查過 route_operations，161 條途程的
// 最後一道工序 100% 都落在包裝站（常規包裝/QC檢驗入庫那一類），沒有例外。
// 這比「所有工序都 finished」可靠——舊資料常有中間站沒報完、但貨其實已經出掉的情況。
//
// 為什麼不拿報工紀錄自己推「最後一站」：那會變成循環判斷——只要有任何報工，
// 最大序號那筆就是「最後一站」，結果每張有報工的單都變成已完成。
//
// 常平／委外的工單號比對會多試一次「裸單號」：塔台在 2026-09-04（commit 193f422
// 幫採購/請購單號加上行號）之前存的是不帶行號的裸號，不退一步比就整批判成未開始。
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_TABLE = 'daily_order_sheets'
const CHUNK = 200
/** 途程的最後一站——完成與否就看這一站有沒有報工 */
const FINAL_STATION = '包裝站'

export type RowStatus = '未開始' | '進行中' | '已完成' | '無資料'

interface SummaryRow extends Record<string, unknown> {
  sheet_date: string
  row_status: RowStatus
  /** 狀態的判斷依據，滑鼠移上去看得到為什麼是這個狀態 */
  status_note: string
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const str = (v: unknown) => String(v ?? '').trim()

/** 出單表列 → 送到塔台的工單號（與 process-gen／改單面板同一套規則） */
function refOf(r: Record<string, unknown>): string {
  const f = str(r.factory)
  if (f === 'C') {
    const base = str(r.po_number); const sub = str(r.po_sub_no)
    return base ? `${base}${sub ? `-${sub}` : ''}` : ''
  }
  if (f === 'O') {
    const base = str(r.pr_number); const sub = str(r.pr_sub_no)
    return base ? `${base}${sub ? `-${sub}` : ''}` : ''
  }
  return str(r.mo_number)
}

const bareOf = (mo: string) => mo.replace(/-\d+$/, '')

export async function GET(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const sp = request.nextUrl.searchParams
    const statusFilter = sp.get('status') ?? '未完成'
    const factoryFilter = sp.get('factory') ?? 'ALL'
    const keyword = (sp.get('keyword') ?? '').trim()
    const limit = Math.min(Number(sp.get('limit') ?? 4000) || 4000, 10000)

    const supabase = getSupabaseAdminClient()

    // 第一次同步塔台報工的日期——比這更早的出單表，查無報工只代表「我們沒有資料」，
    // 不代表沒做。查不到就退回一個保守的預設，寧可標成無資料也不要誤報未開始。
    const { data: firstSync } = await supabase
      .from('sara_sync_logs').select('created_at')
      .eq('action', 'wip_records').eq('ok', true)
      .order('created_at', { ascending: true }).limit(1)
    const firstSyncDate = str(firstSync?.[0]?.created_at).slice(0, 10) || '2026-08-31'

    // ① 攤平所有日期的出單表
    const { data: sheets, error: sheetErr } = await supabase
      .from(SHEET_TABLE)
      .select('sheet_date, rows')
      .order('sheet_date', { ascending: false })
    if (sheetErr) throw sheetErr

    const flat: SummaryRow[] = []
    for (const s of (sheets ?? []) as Array<{ sheet_date: string; rows: unknown }>) {
      const rows = Array.isArray(s.rows) ? s.rows as Record<string, unknown>[] : []
      for (const r of rows) {
        if (!str(r.order_number) && !str(r.item_code)) continue
        flat.push({ ...r, sheet_date: s.sheet_date, row_status: '未開始', status_note: '' })
      }
    }

    // ② 撈這些工單號的報工紀錄（含裸號，供舊資料比對）
    const refs = new Set<string>()
    for (const r of flat) {
      const ref = refOf(r).toUpperCase()
      if (!ref) continue
      refs.add(ref)
      const bare = bareOf(ref)
      if (bare !== ref) refs.add(bare)
    }
    // mo → { any: 有無任何報工, packed: 包裝站有無報工, lastAt: 最後一次報工時間 }
    const stat = new Map<string, { any: boolean; packed: boolean; lastAt: string | null }>()
    const bump = (mo: string) => {
      if (!stat.has(mo)) stat.set(mo, { any: false, packed: false, lastAt: null })
      return stat.get(mo)!
    }
    for (const part of chunk([...refs], CHUNK)) {
      const { data, error } = await supabase
        .from('sara_wip_records')
        .select('mo_nbr, workcenter_name, real_end_time, real_start_time')
        .in('mo_nbr', part)
      if (error) throw error
      for (const x of (data ?? []) as Array<{ mo_nbr: string | null; workcenter_name: string | null; real_end_time: string | null; real_start_time: string | null }>) {
        const mo = str(x.mo_nbr).toUpperCase(); if (!mo) continue
        const st = bump(mo)
        st.any = true
        if (str(x.workcenter_name).includes(FINAL_STATION)) st.packed = true
        const t = x.real_end_time ?? x.real_start_time
        if (t && (!st.lastAt || t > st.lastAt)) st.lastAt = t
      }
    }

    // ③ 逐列判定
    for (const r of flat) {
      const ref = refOf(r).toUpperCase()
      const beforeSync = str(r.sheet_date) < firstSyncDate
      if (!ref) {
        r.row_status = beforeSync ? '無資料' : '未開始'
        r.status_note = beforeSync
          ? `尚未轉單，且出單日早於塔台報工同步起點（${firstSyncDate}），無從判斷`
          : '尚未轉單，塔台上還沒有這筆'
        continue
      }
      const exact = stat.get(ref)
      const bare = bareOf(ref)
      const fallback = bare !== ref ? stat.get(bare) : undefined
      const st = exact?.any ? exact : fallback
      const viaBare = !exact?.any && !!fallback?.any

      if (!st?.any) {
        r.row_status = beforeSync ? '無資料' : '未開始'
        r.status_note = beforeSync
          ? `出單日早於塔台報工同步起點（${firstSyncDate}），塔台上已無這張單的紀錄，無從判斷`
          : `${ref} 在塔台上還沒有任何報工`
        continue
      }
      const suffix = viaBare ? `（以裸單號 ${bare} 比對，涵蓋同一張單的所有行號）` : ''
      if (st.packed) {
        r.row_status = '已完成'
        r.status_note = `${FINAL_STATION}已報工${suffix}`
      } else {
        r.row_status = '進行中'
        r.status_note = `已開工，${FINAL_STATION}尚未報工${suffix}`
      }
      if (st.lastAt) r.last_report_at = st.lastAt
      r.matched_via_bare = viaBare
    }

    // ④ 篩選（狀態／單據／關鍵字都在伺服器端做完）
    const isJidan = (r: SummaryRow) => str(r.doc_type).includes('集單')
    let out = flat
    if (factoryFilter !== 'ALL') {
      out = factoryFilter === 'G'
        ? out.filter(isJidan)
        : out.filter(r => !isJidan(r) && str(r.factory) === factoryFilter)
    }
    const counts = {
      全部: out.length,
      未開始: out.filter(r => r.row_status === '未開始').length,
      進行中: out.filter(r => r.row_status === '進行中').length,
      已完成: out.filter(r => r.row_status === '已完成').length,
      無資料: out.filter(r => r.row_status === '無資料').length,
    }
    if (statusFilter !== 'all') {
      // 未完成＝未開始＋進行中。「無資料」刻意不計入：那是我們沒有紀錄，
      // 不是還沒做完，混進來只會讓這份清單失去可信度。
      out = statusFilter === '未完成'
        ? out.filter(r => r.row_status === '未開始' || r.row_status === '進行中')
        : out.filter(r => r.row_status === statusFilter)
    }
    if (keyword) out = out.filter(r => rowMatchesKeyword(r, keyword))

    const total = out.length
    return NextResponse.json({
      success: true,
      rows: out.slice(0, limit),
      total,
      truncated: total > limit,
      counts,
      first_sync_date: firstSyncDate,
      sheet_count: (sheets ?? []).length,
      all_count: flat.length,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
