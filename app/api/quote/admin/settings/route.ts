import { NextRequest, NextResponse } from 'next/server'
import { guardQuote } from '@/lib/quote/guard'
import { describeError } from '@/lib/supabaseAdmin'
import { deepMerge } from '@/lib/quote/golden'
import {
  badRequest,
  createQuoteCtx,
  loadSettings,
  quoteErrorResponse,
  readJsonBody,
  validateAcrylicSettings,
  writableClient,
} from '@/lib/quote/data'
import type { QuoteSettingsMap } from '@/lib/quote/api'
import type { AcrylicSettings } from '@/lib/quote/types'

export const dynamic = 'force-dynamic'

// GET：QuoteSettingsMap（缺的 key 已用 seed 補齊）。
export async function GET() {
  const guard = await guardQuote('quote_admin')
  if (!guard.ok) return guard.res

  try {
    const ctx = createQuoteCtx()
    const settings = await loadSettings(ctx)
    return NextResponse.json({ success: true, settings, devSeed: ctx.devSeed })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** 翻旗標理由的稽核軌跡：quote_settings 一列，value 是最近 N 筆 { at, by, reason, from, to } */
const FLAG_REASON_LOG_KEY = 'acrylic_flags_reason_log'
const FLAG_REASON_LOG_MAX = 50
const REASON_MAX_LEN = 200

type PutBody = Partial<QuoteSettingsMap> & { settings?: Partial<QuoteSettingsMap>; reason?: string }

// PUT：部分更新（只送要改的 key）。acrylic_settings 可送片段，會深合併進現值後整包存回。
// body 接受兩種形狀：{ acrylic_settings?, fx_rmb_twd?, … , reason? } 或 { settings: {...}, reason? }（後台頁面用後者）。
// 改了 acrylic_settings.flags 必須附 reason（設計書 §8-③），並寫進 FLAG_REASON_LOG_KEY 留紀錄。
export async function PUT(request: NextRequest) {
  const guard = await guardQuote('quote_admin')
  if (!guard.ok) return guard.res

  const raw = await readJsonBody<PutBody>(request)
  if (!isPlainObject(raw)) return badRequest('Invalid JSON')
  const body: Partial<QuoteSettingsMap> = isPlainObject(raw.settings) ? raw.settings : raw
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, REASON_MAX_LEN) : ''

  try {
    const ctx = createQuoteCtx()
    const sb = writableClient(ctx)
    if (!sb) return badRequest('目前為開發 seed 模式（資料表尚未建立或 QUOTE_DEV_SEED=1），無法寫入', 'DEV_SEED')
    const current = await loadSettings(ctx)
    const updatedBy = guard.member.realName ?? guard.member.email
    const now = new Date().toISOString()

    const upserts: { key: string; value: unknown }[] = []

    if (body.acrylic_settings !== undefined) {
      if (!isPlainObject(body.acrylic_settings)) return badRequest('acrylic_settings 必須是物件')
      const merged = deepMerge<AcrylicSettings>(JSON.parse(JSON.stringify(current.acrylic_settings)), body.acrylic_settings)
      const err = validateAcrylicSettings(merged)
      if (err) return badRequest(err)
      upserts.push({ key: 'acrylic_settings', value: merged })

      const flagsChanged = JSON.stringify(merged.flags) !== JSON.stringify(current.acrylic_settings.flags)
      if (flagsChanged) {
        if (!reason) return badRequest('你改了瑕疵旗標，請填「翻旗標理由」再儲存', 'FLAG_REASON_REQUIRED')
        const { data: logRow, error: logErr } = await sb
          .from('quote_settings')
          .select('value')
          .eq('key', FLAG_REASON_LOG_KEY)
          .maybeSingle()
        if (logErr) throw new Error(describeError(logErr))
        const prev = Array.isArray((logRow as { value?: unknown } | null)?.value) ? ((logRow as { value: unknown[] }).value) : []
        const entry = { at: now, by: updatedBy, reason, from: current.acrylic_settings.flags, to: merged.flags }
        upserts.push({ key: FLAG_REASON_LOG_KEY, value: [...prev.slice(-(FLAG_REASON_LOG_MAX - 1)), entry] })
      }
    }
    if (body.fx_rmb_twd !== undefined) {
      if (body.fx_rmb_twd === null) {
        upserts.push({ key: 'fx_rmb_twd', value: null })
      } else {
        const fx = body.fx_rmb_twd
        const rate = Number(fx?.rate)
        if (!isPlainObject(fx) || !Number.isFinite(rate) || rate <= 0) return badRequest('fx_rmb_twd.rate 必須是 > 0 的數字')
        const asOf = String(fx.as_of ?? '').trim()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return badRequest('fx_rmb_twd.as_of 格式須為 YYYY-MM-DD')
        upserts.push({ key: 'fx_rmb_twd', value: { rate, as_of: asOf } })
      }
    }
    if (body.markup_bardshop_pct !== undefined) {
      const n = Number(body.markup_bardshop_pct)
      if (!Number.isFinite(n) || n < 0) return badRequest('markup_bardshop_pct 必須是 ≥ 0 的數字')
      upserts.push({ key: 'markup_bardshop_pct', value: n })
    }
    if (body.quote_validity_days !== undefined) {
      const n = Number(body.quote_validity_days)
      if (!Number.isInteger(n) || n <= 0) return badRequest('quote_validity_days 必須是正整數')
      upserts.push({ key: 'quote_validity_days', value: n })
    }
    if (body.rate_version !== undefined) {
      const v = typeof body.rate_version === 'string' ? body.rate_version.trim() : ''
      if (!v || v.length > 20) return badRequest('rate_version 必填，最多 20 字')
      upserts.push({ key: 'rate_version', value: v })
    }
    if (upserts.length === 0) return badRequest('沒有可更新的欄位')

    const { error } = await sb
      .from('quote_settings')
      .upsert(upserts.map((u) => ({ key: u.key, value: u.value, updated_by: updatedBy, updated_at: now })), { onConflict: 'key' })
    if (error) throw new Error(describeError(error))

    const settings = await loadSettings(ctx)
    return NextResponse.json({ success: true, settings, updatedKeys: upserts.map((u) => u.key) })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}
