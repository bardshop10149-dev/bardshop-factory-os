import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { LOCKED_ERP_FIELDS, LOCKED_FIELD_FROM_ARGO, presetOf } from '@/lib/productDev/categoryPresets'
import { getPartTemplate } from '@/lib/productDev/argoParts'
import { buildPayload, createPart, VERIFIED_CATEGORIES } from '@/lib/productDev/ifaf007'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TABLE = 'item_code_requests'

/** 大類：ARGO PRODUCT_CATEGORY，同時也是料號第一碼 */
const CATEGORIES = ['M', 'W', 'P', 'C', 'S', 'A', 'O'] as const
const STATUSES = ['pending', 'approved', 'created', 'rejected', 'failed'] as const

/** 只有這些欄位允許由前端寫入；申請人、單號、狀態一律由後端決定 */
const INPUT_FIELDS = [
  'template_part',
  'part_name', 'part_desc', 'unit_of_measure', 'product_category', 'product_category_2',
  'source_type', 'inventory_type', 'cost_category', 'leadtime_flag',
  'bom_warehouse_id', 'lot_no_flag', 'expense_flag',
  'level_code_inv', 'account_no_inv', 'validdate',
  'suggested_part', 'note', 'reference_url',
] as const

const REQUIRED_FIELDS: { key: string; label: string }[] = [
  { key: 'part_name', label: '品項名稱' },
  { key: 'unit_of_measure', label: '單位' },
  { key: 'product_category', label: '產品大類' },
  { key: 'product_category_2', label: '產品次類別' },
  { key: 'note', label: '用途說明' },
]

const str = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s ? s : null
}

/**
 * 資料庫錯誤轉人話。
 * 最常見的一種是「資料表還沒建」——上線時漏跑 SQL 就會撞到，
 * 直接把 PostgREST 的英文訊息丟給商開看，他們只會來問「這是什麼」。
 */
function dbError(message: string): string {
  if (/could not find the table|schema cache|does not exist/i.test(message)) {
    return '申請單資料表尚未建立，請通知管理員執行 sql/20260910_item_code_requests.sql'
  }
  return formatSupabaseAdminError(message)
}

const LOG_TABLE = 'item_code_request_logs'

/**
 * 算出「申請人不能改」的那幾個欄位該是什麼值。
 *
 * 前端雖然把這些欄位鎖成唯讀，但唯讀只是 UX——請求是可以偽造的，真正的防線在這裡：
 * 後端一律無視前端送來的值，自己重算。有引用品項就抄引用來源（最可靠），
 * 沒有就退回大類預設。
 */
async function resolveLockedFields(
  templatePart: string | null,
  category: string,
): Promise<{ values: Record<string, string | null>; from: string }> {
  if (templatePart) {
    try {
      const tpl = await getPartTemplate(templatePart)
      if (tpl) {
        const values: Record<string, string | null> = {}
        for (const key of LOCKED_ERP_FIELDS) {
          const raw = tpl[LOCKED_FIELD_FROM_ARGO[key]]
          values[key] = raw == null || String(raw).trim() === '' ? null : String(raw).trim()
        }
        return { values, from: '引用 ' + templatePart }
      }
    } catch (err) {
      // 抄不到就退回大類預設，不讓 ARGO 連不上把整張申請單卡死
      console.error('[item-request] 讀取引用品項失敗，改用大類預設:', err)
    }
  }
  const preset = presetOf(category)
  const values: Record<string, string | null> = {}
  for (const key of LOCKED_ERP_FIELDS) {
    const v = preset[key]
    values[key] = v == null || v === '' ? null : v
  }
  return { values, from: '大類 ' + category + ' 預設' }
}

/**
 * 寫一筆軌跡。刻意不讓寫 log 失敗連累主要操作——申請單已經成立了，
 * 卻因為 log 寫不進去回報「送出失敗」，使用者會重送、變成兩張單，那更糟。
 */
async function writeLog(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  entry: {
    request_id: number
    request_no: string
    action: string
    actor_email: string
    actor_name: string | null
    changes?: Record<string, unknown> | null
    note?: string | null
  },
) {
  const { error } = await supabase.from(LOG_TABLE).insert(entry)
  if (error) console.error('[item-request] 寫入異動軌跡失敗:', error.message)
}

/** 申請單號 IR + yyMMdd + 3 碼流水（台灣時間） */
function todayStampTW(): string {
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return tw.toISOString().slice(2, 10).replace(/-/g, '')
}

async function nextRequestNo(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
): Promise<string> {
  const prefix = 'IR' + todayStampTW()
  const { data, error } = await supabase
    .from(TABLE)
    .select('request_no')
    .like('request_no', prefix + '%')
    .order('request_no', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  const last = data?.[0]?.request_no as string | undefined
  const seq = last ? Number(last.slice(prefix.length)) + 1 : 1
  return prefix + String(seq).padStart(3, '0')
}

/**
 * GET：申請清單。?status=pending 篩狀態、?mine=1 只看自己送出的、
 * ?logs=<申請單id> 改回該單的異動軌跡。
 *
 * 軌跡走「展開才查」而非跟清單一起回：清單一次 300 張，每張都帶軌跡會把回應撐大好幾倍，
 * 而實際上一次只會看一張。
 */
export async function GET(request: NextRequest) {
  const guard = await guardPermission('product_dev')
  if (!guard.ok) return guard.res

  const { searchParams } = new URL(request.url)
  const status = (searchParams.get('status') ?? '').trim()
  // 審查視角：看所有人的單，要有核准權限才給。沒帶 all=1 時一律只回自己送的，
  // 這樣申請頁不必自己記得加 mine=1——預設就是安全的那邊。
  const wantAll = searchParams.get('all') === '1'
  const canApprove = guard.member.isAdmin || guard.member.permissions.includes('product_dev_approve')
  const mine = !(wantAll && canApprove)

  // 乾跑：組好要送給 ARGO 的完整欄位但不送，讓主管按下建檔前先看一眼
  const payloadFor = Number(searchParams.get('payload') ?? 0)
  if (Number.isInteger(payloadFor) && payloadFor > 0) {
    if (!(guard.member.isAdmin || guard.member.permissions.includes('product_dev_approve'))) {
      return NextResponse.json({ success: false, error: '沒有品項編碼審查權限' }, { status: 403 })
    }
    const sb = getSupabaseAdminClient()
    const { data: row } = await sb.from(TABLE).select('*').eq('id', payloadFor).maybeSingle()
    if (!row) return NextResponse.json({ success: false, error: '找不到這張申請單' }, { status: 404 })
    const r = row as Record<string, unknown>
    const part = String(r.approved_part ?? r.suggested_part ?? '').trim().toUpperCase()
    if (!part) return NextResponse.json({ success: false, error: '尚未決定品項編碼' }, { status: 400 })
    const category = String(r.product_category ?? '').toUpperCase()
    const payload = buildPayload({
      ...(r as unknown as Parameters<typeof buildPayload>[0]),
      approved_part: part,
      approved_by_emp_no: String(r.approved_by_emp_no ?? guard.member.employeeNo ?? ''),
    })
    return NextResponse.json({
      success: true,
      payload,
      fieldCount: Object.keys(payload).length,
      categoryVerified: (VERIFIED_CATEGORIES as readonly string[]).includes(category),
      category,
    })
  }

  const logsFor = Number(searchParams.get('logs') ?? 0)
  if (Number.isInteger(logsFor) && logsFor > 0) {
    const sb = getSupabaseAdminClient()
    const { data, error } = await sb
      .from(LOG_TABLE)
      .select('id, action, actor_email, actor_name, changes, note, created_at')
      .eq('request_id', logsFor)
      .order('created_at', { ascending: true })
    if (error) {
      // 軌跡表沒建不該讓整頁掛掉，回空陣列並附說明即可
      console.error('[item-request] 讀取軌跡失敗:', error.message)
      return NextResponse.json({ success: true, logs: [], warning: dbError(error.message) })
    }
    return NextResponse.json({ success: true, logs: data ?? [] })
  }

  const supabase = getSupabaseAdminClient()
  let query = supabase
    .from(TABLE)
    .select('*')
    .order('requested_at', { ascending: false })
    .limit(300)

  if (STATUSES.includes(status as (typeof STATUSES)[number])) query = query.eq('status', status)
  if (mine) query = query.eq('requester_email', guard.member.email)

  const { data, error } = await query
  if (error) {
    return NextResponse.json(
      { success: false, error: dbError(error.message) },
      { status: 500 },
    )
  }
  return NextResponse.json({ success: true, rows: data ?? [], me: guard.member.email })
}

/** POST：送出新品項編碼申請 */
export async function POST(request: NextRequest) {
  const guard = await guardPermission('product_dev')
  if (!guard.ok) return guard.res

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: '請求格式錯誤' }, { status: 400 })
  }

  const row: Record<string, unknown> = {}
  for (const key of INPUT_FIELDS) row[key] = str(body[key])

  for (const f of REQUIRED_FIELDS) {
    if (!row[f.key]) {
      return NextResponse.json({ success: false, error: '「' + f.label + '」為必填' }, { status: 400 })
    }
  }

  const category = String(row.product_category).toUpperCase()
  if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    return NextResponse.json(
      { success: false, error: '產品大類只能是 ' + CATEGORIES.join(' / ') },
      { status: 400 },
    )
  }
  row.product_category = category
  row.product_category_2 = String(row.product_category_2).toUpperCase()
  if (row.suggested_part) row.suggested_part = String(row.suggested_part).toUpperCase()

  // 安全庫存：允許留空；填了就必須是 0 以上的數字
  const safetyRaw = str(body.safety_qty)
  if (safetyRaw !== null) {
    const n = Number(safetyRaw)
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ success: false, error: '安全庫存必須是 0 以上的數字' }, { status: 400 })
    }
    row.safety_qty = n
  }

  row.requester_email = guard.member.email
  row.requester_name = guard.member.realName ?? null
  row.status = 'pending'

  // 會影響帳務的欄位無視前端送來的值，後端重算（前端的唯讀只是 UX，不是防線）
  const locked = await resolveLockedFields(str(row.template_part) as string | null, category)
  Object.assign(row, locked.values)

  const supabase = getSupabaseAdminClient()

  // 兩人同時送出會撞到同一個流水號 → unique 擋下後重取，最多 3 次
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      row.request_no = await nextRequestNo(supabase)
    } catch (err) {
      const message = err instanceof Error ? err.message : '單號產生失敗'
      return NextResponse.json({ success: false, error: dbError(message) }, { status: 500 })
    }
    const { data, error } = await supabase.from(TABLE).insert(row).select().single()
    if (!error) {
      await writeLog(supabase, {
        request_id: data.id,
        request_no: data.request_no,
        action: 'submitted',
        actor_email: guard.member.email,
        actor_name: guard.member.realName ?? null,
        changes: { ...row },
        note: '送出申請｜帳務欄位來源：' + locked.from,
      })
      return NextResponse.json({ success: true, row: data })
    }
    if (!/duplicate key|unique/i.test(error.message) || attempt === 2) {
      return NextResponse.json(
        { success: false, error: dbError(error.message) },
        { status: 500 },
      )
    }
  }
  return NextResponse.json({ success: false, error: '申請單號產生失敗，請重試' }, { status: 500 })
}

/** PATCH：處理申請 —— 回填已建立的品項編碼結案、退回、或救回誤按 */
export async function PATCH(request: NextRequest) {
  const guard = await guardPermission('product_dev')
  if (!guard.ok) return guard.res

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: '請求格式錯誤' }, { status: 400 })
  }

  const id = Number(body.id)
  const action = String(body.action ?? '')
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: '缺少申請單 id' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = {
    handled_by: guard.member.email,
    handled_at: now,
    updated_at: now,
  }

  if (action === 'approved') {
    // 核准＝主管審過、編碼也定案了，但 ARGO 還沒建（Phase 1 建檔仍人工）
    if (!(guard.member.isAdmin || guard.member.permissions.includes('product_dev_approve'))) {
      return NextResponse.json({ success: false, error: '沒有品項編碼審查權限' }, { status: 403 })
    }
    const part = str(body.approved_part)
    if (!part) {
      return NextResponse.json({ success: false, error: '請填寫核准的品項編碼' }, { status: 400 })
    }
    const finalPart = part.toUpperCase()

    // 申請人不能核准自己送的單。擋的是自審，不是要求兩個人簽。
    // admin 例外（Snow 2026-09-21 定）：他既是主管也會自己發需求，擋下來那張單就沒人能審了。
    // 一般審核者仍受限——這條對他們才有防弊意義。
    const { data: own } = await getSupabaseAdminClient()
      .from(TABLE).select('requester_email').eq('id', id).maybeSingle()
    const selfApprove = !!own && String(own.requester_email) === guard.member.email
    if (selfApprove && !guard.member.isAdmin) {
      return NextResponse.json({
        success: false,
        error: '不能核准自己送出的申請，請由其他有審查權限的主管處理',
      }, { status: 403 })
    }

    // 送出前再查一次 ARGO——從審查到按下核准之間，這個編碼可能已經被別人用掉
    try {
      const dup = await getPartTemplate(finalPart)
      if (dup) {
        return NextResponse.json({
          success: false,
          error: `編碼 ${finalPart} 在 ARGO 已存在（${String(dup.PART_NAME ?? '')}），請改號`,
        }, { status: 409 })
      }
    } catch (err) {
      // ARGO 連不上時不放行——沒查到不等於不存在，這種時候寧可擋下來
      console.error('[item-request] 核准前查重失敗:', err)
      return NextResponse.json({
        success: false, error: 'ARGO 查詢失敗，無法確認編碼是否重複，請稍後再試',
      }, { status: 503 })
    }

    patch.status = 'approved'
    patch.approved_part = finalPart
    patch.approved_by = guard.member.email
    patch.approved_by_name = guard.member.realName
    patch.approved_by_emp_no = guard.member.employeeNo
    patch.approved_at = now
    patch.reject_reason = null
  } else if (action === 'create_in_argo') {
    // 直接寫入 ARGO。這是整個系統唯一會動到 ERP 的地方。
    if (!(guard.member.isAdmin || guard.member.permissions.includes('product_dev_approve'))) {
      return NextResponse.json({ success: false, error: '沒有品項編碼審查權限' }, { status: 403 })
    }
    const sb0 = getSupabaseAdminClient()
    const { data: row } = await sb0.from(TABLE).select('*').eq('id', id).maybeSingle()
    if (!row) return NextResponse.json({ success: false, error: '找不到這張申請單' }, { status: 404 })
    const r0 = row as Record<string, unknown>
    // 只有已核准（或上次寫入失敗）的單能寫入——沒審過的東西不該進 ERP
    if (!['approved', 'failed'].includes(String(r0.status))) {
      return NextResponse.json({
        success: false, error: `狀態是「${String(r0.status)}」，只有已核准或建檔失敗的單可以寫入 ARGO`,
      }, { status: 409 })
    }
    const part = String(r0.approved_part ?? '').trim().toUpperCase()
    if (!part) return NextResponse.json({ success: false, error: '這張單還沒有核准編碼' }, { status: 400 })

    let outcome
    try {
      outcome = await createPart(buildPayload({
        ...(r0 as unknown as Parameters<typeof buildPayload>[0]),
        approved_part: part,
        approved_by_emp_no: String(r0.approved_by_emp_no ?? guard.member.employeeNo ?? ''),
      }))
    } catch (err) {
      // 連線層就掛掉：不改狀態，讓它留在 approved 可以重試。
      // 標成 failed 會讓人以為 ARGO 拒絕了這筆資料，但其實只是網路不通。
      const msg = err instanceof Error ? err.message : String(err)
      await writeLog(sb0, {
        request_id: id, request_no: String(r0.request_no), action: 'create_failed',
        actor_email: guard.member.email, actor_name: guard.member.realName ?? null,
        changes: null, note: 'ARGO 連線失敗，狀態未變更可重試：' + msg,
      })
      return NextResponse.json({ success: false, error: 'ARGO 連線失敗：' + msg }, { status: 503 })
    }

    const nowIso = new Date().toISOString()
    if (!outcome.ok) {
      await sb0.from(TABLE).update({ status: 'failed', updated_at: nowIso }).eq('id', id)
      await writeLog(sb0, {
        request_id: id, request_no: String(r0.request_no), action: 'create_failed',
        actor_email: guard.member.email, actor_name: guard.member.realName ?? null,
        changes: { status: { before: r0.status, after: 'failed' } },
        note: outcome.message + (outcome.batchNo ? `（批號 ${outcome.batchNo}）` : ''),
      })
      return NextResponse.json({ success: false, error: outcome.message, outcome }, { status: 422 })
    }

    const { data: done, error: upErr } = await sb0.from(TABLE).update({
      status: 'created', assigned_part: part,
      handled_by: guard.member.email, handled_at: nowIso, updated_at: nowIso,
    }).eq('id', id).select().single()
    if (upErr) {
      // ARGO 已經建好了，EIP 卻沒更新到——這種不一致要吵出來，不能靜默
      console.error('[item-request] ARGO 已建檔但 EIP 更新失敗:', upErr.message)
      return NextResponse.json({
        success: false,
        error: `ARGO 已成功建立 ${part}，但 EIP 狀態更新失敗（${upErr.message}），請重新整理確認`,
      }, { status: 500 })
    }
    await writeLog(sb0, {
      request_id: id, request_no: String(r0.request_no), action: 'created',
      actor_email: guard.member.email, actor_name: guard.member.realName ?? null,
      changes: { status: { before: r0.status, after: 'created' },
                 assigned_part: { before: r0.assigned_part ?? null, after: part } },
      note: `透過 IFAF007 寫入 ARGO 建檔成功（審核工號 ${String(r0.approved_by_emp_no ?? '-')}）`,
    })
    return NextResponse.json({ success: true, row: done, outcome })
  } else if (action === 'created') {
    const assigned = str(body.assigned_part)
    if (!assigned) {
      return NextResponse.json({ success: false, error: '請填寫實際建立的品項編碼' }, { status: 400 })
    }
    patch.status = 'created'
    patch.assigned_part = assigned.toUpperCase()
    patch.reject_reason = null
  } else if (action === 'rejected') {
    const reason = str(body.reject_reason)
    if (!reason) {
      return NextResponse.json({ success: false, error: '請填寫退回原因' }, { status: 400 })
    }
    patch.status = 'rejected'
    patch.reject_reason = reason
    patch.assigned_part = null
  } else if (action === 'reopen') {
    // 誤按結案／退回後要救回待建檔
    patch.status = 'pending'
    patch.assigned_part = null
    patch.reject_reason = null
    patch.handled_by = null
    patch.handled_at = null
    // 核准紀錄也要一起清，否則會出現「狀態是待審、卻顯示已被某人核准」的矛盾畫面
    patch.approved_by = null
    patch.approved_by_name = null
    patch.approved_by_emp_no = null
    patch.approved_at = null
    patch.approved_part = null
  } else {
    return NextResponse.json({ success: false, error: '不支援的操作' }, { status: 400 })
  }

  const supabase = getSupabaseAdminClient()

  // 先撈舊值，才記得出「從什麼變成什麼」——更新後就再也問不到了
  const { data: before } = await supabase
    .from(TABLE).select('status, assigned_part, reject_reason, approved_part').eq('id', id).maybeSingle()

  const { data, error } = await supabase.from(TABLE).update(patch).eq('id', id).select().single()
  if (error) {
    return NextResponse.json(
      { success: false, error: dbError(error.message) },
      { status: 500 },
    )
  }

  const changes: Record<string, { before: unknown; after: unknown }> = {}
  for (const key of ['status', 'assigned_part', 'reject_reason', 'approved_part'] as const) {
    const b = (before as Record<string, unknown> | null)?.[key] ?? null
    const a = (data as Record<string, unknown>)[key] ?? null
    if (b !== a) changes[key] = { before: b, after: a }
  }
  const noteOf: Record<string, string> = {
    approved: '核准建檔，編碼定為 ' + String(data.approved_part ?? '-')
      + '（審核工號 ' + String(data.approved_by_emp_no ?? '未設定') + '）'
      + (String(data.requester_email ?? '') === guard.member.email ? '［自審：申請人即核准人］' : ''),
    created: '完成建檔，編碼 ' + String(data.assigned_part ?? '-'),
    rejected: '退回：' + String(data.reject_reason ?? '-'),
    reopen: '救回待建檔（清掉原本的結案／退回紀錄）',
  }
  await writeLog(supabase, {
    request_id: id,
    request_no: String(data.request_no),
    action,
    actor_email: guard.member.email,
    actor_name: guard.member.realName ?? null,
    changes,
    note: noteOf[action] ?? null,
  })

  return NextResponse.json({ success: true, row: data })
}
