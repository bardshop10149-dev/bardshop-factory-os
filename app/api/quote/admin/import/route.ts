import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, describeError } from '@/lib/supabaseAdmin'
import { guardQuote } from '@/lib/quote/guard'
import { buildImportPreview } from '@/lib/quote/excelImport'
import type { ImportApplyRequest, ImportGoldenProposal } from '@/lib/quote/api'
import type { AcrylicSettings } from '@/lib/quote/types'
import seedSettings from '@/lib/quote/seed/settings.json'

export const dynamic = 'force-dynamic'

// POST（multipart，欄位 file）      → 解析 报价模板 Excel，回 ImportPreviewResponse（不寫資料庫）
// POST ?apply=1（JSON ImportApplyRequest）→ 套用勾選的價格差異 + 寫入 golden proposed
//
// 價格比對用「現有 quote_price_items」：表不存在或 QUOTE_DEV_SEED=1 時當空 Map（全部會是 new）並在 notes 標示；
// apply 一律要有資料表，沒有就 503。

const MAX_FILE_BYTES = 5 * 1024 * 1024
const PLANT = 'changping'
const TABLE_MISSING_MSG = '報價系統資料表尚未建立，請通知管理員執行 sql/20260913_quote_system.sql'

function isMissingTable(msg: string): boolean {
  const m = msg.toLowerCase()
  return m.includes('does not exist') || m.includes('could not find the table') || m.includes('schema cache') || m.includes('42p01')
}

function fail(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status })
}

function todayIso(): string {
  // 台灣時區的今天（Vercel 跑 UTC，晚上 8 點後會差一天）
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

/** 線上 quote_settings.acrylic_settings；讀不到就用 seed（Excel 讀不到的格子沿用這個值，snapshot 存完整常數） */
async function loadBaseSettings(supabase: ReturnType<typeof getSupabaseAdminClient>, notes: string[]): Promise<AcrylicSettings> {
  const seed = (seedSettings as { acrylic_settings: AcrylicSettings }).acrylic_settings
  if (process.env.QUOTE_DEV_SEED === '1') return seed
  const { data, error } = await supabase.from('quote_settings').select('value').eq('key', 'acrylic_settings').maybeSingle()
  if (error) {
    notes.push(isMissingTable(error.message) ? '全域參數表尚未建立，settings_snapshot 以 seed 為基準' : `讀取全域參數失敗（${error.message}），以 seed 為基準`)
    return seed
  }
  const v = data?.value
  if (v && typeof v === 'object' && 'cut' in (v as object)) return v as AcrylicSettings
  notes.push('線上沒有 acrylic_settings，settings_snapshot 以 seed 為基準')
  return seed
}

/* ---------------------------------------------------------------- 預覽 */

async function handlePreview(request: NextRequest) {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return fail(400, '請以 multipart/form-data 上傳，欄位名稱 file')
  }
  const file = form.get('file')
  if (!(file instanceof File)) return fail(400, '缺少檔案（欄位 file）')
  if (!/\.xlsx$/i.test(file.name)) return fail(400, '只接受 .xlsx（报价模板 v1.5.x）')
  if (file.size > MAX_FILE_BYTES) return fail(400, `檔案超過 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`)
  if (file.size === 0) return fail(400, '檔案是空的')

  const notes: string[] = []
  let currentPrices = new Map<string, number>()
  let supabase: ReturnType<typeof getSupabaseAdminClient> | null = null
  try {
    supabase = getSupabaseAdminClient()
  } catch (e) {
    notes.push(`Supabase 未設定（${describeError(e)}），價格差異全部以「新增」呈現`)
  }

  let baseSettings: AcrylicSettings = (seedSettings as { acrylic_settings: AcrylicSettings }).acrylic_settings
  if (supabase) {
    if (process.env.QUOTE_DEV_SEED === '1') {
      notes.push('QUOTE_DEV_SEED=1：未讀取線上價格表，差異全部以「新增」呈現')
    } else {
      const { data, error } = await supabase.from('quote_price_items').select('name, price').eq('plant', PLANT)
      if (error) {
        if (isMissingTable(error.message)) notes.push(`${TABLE_MISSING_MSG}；本次差異全部以「新增」呈現，無法套用`)
        else return fail(500, describeError(error))
      } else {
        currentPrices = new Map((data ?? []).map((r) => [String(r.name), Number(r.price)]))
        if (currentPrices.size === 0) notes.push('線上價格表目前是空的，差異全部以「新增」呈現')
      }
    }
    baseSettings = await loadBaseSettings(supabase, notes)
  }

  try {
    const data = new Uint8Array(await file.arrayBuffer())
    const preview = buildImportPreview(data, file.name, baseSettings, currentPrices, notes)
    return NextResponse.json({ success: true, ...preview })
  } catch (e) {
    return fail(400, `Excel 解析失敗：${describeError(e)}`)
  }
}

/* ---------------------------------------------------------------- 套用 */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function validateApply(body: unknown): { ok: true; value: ImportApplyRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid JSON' }
  const b = body as Partial<ImportApplyRequest>
  const fileName = typeof b.fileName === 'string' ? b.fileName.trim() : ''
  if (!fileName) return { ok: false, error: '缺少 fileName' }
  if (!Array.isArray(b.priceUpdates) || !Array.isArray(b.goldenCases)) return { ok: false, error: 'priceUpdates / goldenCases 必須是陣列' }

  const priceUpdates: ImportApplyRequest['priceUpdates'] = []
  for (const [i, p] of b.priceUpdates.entries()) {
    const name = typeof p?.name === 'string' ? p.name.trim() : ''
    const group = typeof p?.group === 'string' ? p.group.trim() : ''
    if (!name) return { ok: false, error: `priceUpdates[${i}] 缺少 name` }
    if (!group) return { ok: false, error: `priceUpdates[${i}]「${name}」缺少 group` }
    if (!isFiniteNumber(p.price) || p.price < 0) return { ok: false, error: `priceUpdates[${i}]「${name}」price 必須是 ≥ 0 的數字` }
    priceUpdates.push({ name, group, price: p.price })
  }

  const goldenCases: ImportApplyRequest['goldenCases'] = []
  for (const [i, g] of b.goldenCases.entries()) {
    const productId = typeof g?.productId === 'string' ? g.productId.trim() : ''
    const name = typeof g?.name === 'string' ? g.name.trim() : ''
    if (!productId) return { ok: false, error: `goldenCases[${i}]「${name || '?'}」缺少 productId` }
    if (!name) return { ok: false, error: `goldenCases[${i}] 缺少 name` }
    if (!g.input || typeof g.input !== 'object') return { ok: false, error: `goldenCases[${i}]「${name}」缺少 input` }
    if (!isFiniteNumber(g.expected_cost) || !isFiniteNumber(g.expected_price)) return { ok: false, error: `goldenCases[${i}]「${name}」expected_cost / expected_price 必須是數字` }
    const proposal: ImportGoldenProposal & { productId: string } = {
      productId,
      name,
      sheet: typeof g.sheet === 'string' ? g.sheet : '',
      template_version: typeof g.template_version === 'string' ? g.template_version : '',
      qty: isFiniteNumber(g.qty) ? g.qty : 0,
      expected_cost: g.expected_cost,
      expected_price: g.expected_price,
      input: g.input,
      settings_snapshot: g.settings_snapshot && typeof g.settings_snapshot === 'object' ? g.settings_snapshot : {},
      warnings: Array.isArray(g.warnings) ? g.warnings.filter((w): w is string => typeof w === 'string') : [],
    }
    goldenCases.push(proposal)
  }
  return { ok: true, value: { fileName, priceUpdates, goldenCases } }
}

async function handleApply(request: NextRequest, updatedBy: string) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return fail(400, 'Invalid JSON')
  }
  const v = validateApply(raw)
  if (!v.ok) return fail(400, v.error)
  const { fileName, priceUpdates, goldenCases } = v.value
  if (priceUpdates.length === 0 && goldenCases.length === 0) return fail(400, '沒有勾選任何要套用的項目')

  let supabase: ReturnType<typeof getSupabaseAdminClient>
  try {
    supabase = getSupabaseAdminClient()
  } catch (e) {
    return fail(500, describeError(e))
  }
  const now = new Date().toISOString()
  const today = todayIso()

  try {
    /* ---- 價格：既有 → 只改價（on conflict (plant,name) 的語意）；不存在 → 新增 ---- */
    let pricesUpdated = 0
    let pricesInserted = 0
    if (priceUpdates.length > 0) {
      const names = priceUpdates.map((p) => p.name)
      const { data: existing, error: readErr } = await supabase
        .from('quote_price_items')
        .select('name')
        .eq('plant', PLANT)
        .in('name', names)
      if (readErr) {
        if (isMissingTable(readErr.message)) return fail(503, TABLE_MISSING_MSG)
        throw new Error(readErr.message)
      }
      const existingNames = new Set((existing ?? []).map((r) => String(r.name)))

      for (const p of priceUpdates) {
        if (existingNames.has(p.name)) {
          const { error } = await supabase
            .from('quote_price_items')
            .update({ price: p.price, effective_from: today, source_file: fileName, updated_by: updatedBy, updated_at: now })
            .eq('plant', PLANT)
            .eq('name', p.name)
          if (error) throw new Error(`更新「${p.name}」失敗：${error.message}`)
          pricesUpdated++
        }
      }
      const toInsert = priceUpdates
        .filter((p) => !existingNames.has(p.name))
        .map((p) => ({
          group: p.group,
          name: p.name,
          unit: '個',
          price: p.price,
          currency: 'RMB',
          plant: PLANT,
          effective_from: today,
          source_file: fileName,
          updated_by: updatedBy,
          updated_at: now,
        }))
      if (toInsert.length > 0) {
        // 同一批裡同名重複（Excel 同名兩價）只留第一筆，避免 unique (plant,name) 撞
        const dedup = [...new Map(toInsert.map((r) => [r.name, r])).values()]
        const { error } = await supabase.from('quote_price_items').insert(dedup)
        if (error) throw new Error(`新增價格項目失敗：${error.message}`)
        pricesInserted = dedup.length
      }
    }

    /* ---- golden：一律 proposed；同品項同名已存在就跳過（不覆蓋已核可的案例） ---- */
    let goldenInserted = 0
    const goldenSkipped: string[] = []
    if (goldenCases.length > 0) {
      const productIds = [...new Set(goldenCases.map((g) => g.productId))]
      const { data: products, error: prodErr } = await supabase.from('quote_products').select('id').in('id', productIds)
      if (prodErr) {
        if (isMissingTable(prodErr.message)) return fail(503, TABLE_MISSING_MSG)
        throw new Error(prodErr.message)
      }
      const known = new Set((products ?? []).map((r) => String(r.id)))
      const unknown = productIds.filter((id) => !known.has(id))
      if (unknown.length > 0) return fail(400, `找不到品項：${unknown.join('、')}`)

      const { data: existingGolden, error: gErr } = await supabase
        .from('quote_golden_cases')
        .select('product_id, name')
        .in('product_id', productIds)
      if (gErr) {
        if (isMissingTable(gErr.message)) return fail(503, TABLE_MISSING_MSG)
        throw new Error(gErr.message)
      }
      const existingKeys = new Set((existingGolden ?? []).map((r) => `${r.product_id}|${r.name}`))

      const rows = []
      for (const g of goldenCases) {
        const key = `${g.productId}|${g.name}`
        if (existingKeys.has(key)) {
          goldenSkipped.push(g.name)
          continue
        }
        existingKeys.add(key)
        rows.push({
          product_id: g.productId,
          name: g.name,
          status: 'proposed',
          template_version: g.template_version || null,
          source_file: fileName,
          source_sheet: g.sheet || null,
          // 匯入的案例還沒人稽核過：先標明，核可前後台看得到
          audit_note: `由後台 Excel 匯入（${fileName}／${g.sheet || '主产品'}），尚未稽核${g.warnings?.length ? `；解析警告 ${g.warnings.length} 則` : ''}`,
          input: g.input,
          settings_snapshot: g.settings_snapshot,
          expected_cost: g.expected_cost,
          expected_price: g.expected_price,
          tolerance: 0.01,
        })
      }
      if (rows.length > 0) {
        const { error } = await supabase.from('quote_golden_cases').insert(rows)
        if (error) throw new Error(`寫入驗證案例失敗：${error.message}`)
        goldenInserted = rows.length
      }
    }

    return NextResponse.json({ success: true, pricesUpdated, pricesInserted, goldenInserted, goldenSkipped })
  } catch (e) {
    const msg = describeError(e)
    if (isMissingTable(msg)) return fail(503, TABLE_MISSING_MSG)
    return fail(500, msg)
  }
}

/* ---------------------------------------------------------------- 入口 */

export async function POST(request: NextRequest) {
  const guard = await guardQuote('quote_admin')
  if (!guard.ok) return guard.res

  const apply = request.nextUrl.searchParams.get('apply') === '1'
  if (apply) return handleApply(request, guard.member.realName ?? guard.member.email)
  return handlePreview(request)
}
