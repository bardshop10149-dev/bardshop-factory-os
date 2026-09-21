import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { searchParts, getPartTemplate } from '@/lib/productDev/argoParts'
import { LOCKED_ERP_FIELDS, LOCKED_FIELD_FROM_ARGO, presetOf } from '@/lib/productDev/categoryPresets'

export const dynamic = 'force-dynamic'

// 品項編碼申請 —— 核准前的自動預檢。
//
// 這支是「輕鬆審查」的核心：主管不該自己開 ARGO 一張一張查有沒有重複、有沒有
// 長得很像的品項。把該查的先查完攤在他眼前，他只需要做「判斷」這件機器做不了的事。
//
// 硬擋(block)與警示(warn)的分野：
//   block = 送進 ARGO 一定會失敗，或一定是錯的（重複編碼、前綴對不上大類、必填缺）
//   warn  = 可能沒問題也可能有問題，只有人知道（相似品項、帳務欄位偏離引用來源）
// 沒有第三種。任何「系統覺得怪但說不清為什麼」的檢查都不該存在——那只會訓練
// 使用者無視警告。

const CATEGORY_CODES = ['M', 'W', 'P', 'C', 'S', 'A', 'O']

interface Check {
  key: string
  label: string
  level: 'block' | 'warn' | 'ok'
  message: string
  detail?: unknown
}

/**
 * 兩個品名有多像。用的是字元集合的 Jaccard 相似度，不是編輯距離——
 * 中文品名常是「客製 | 壓克力鑰匙圈 5cm」這種由固定詞彙拼起來的字串，
 * 順序不同但用字幾乎一樣的情況很多，集合比對抓得到，編輯距離會因為位移而低估。
 */
function similarity(a: string, b: string): number {
  const norm = (x: string) => new Set(x.replace(/[\s|｜/／,，、()（）*x×]/g, '').toLowerCase())
  const sa = norm(a)
  const sb = norm(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let hit = 0
  for (const c of sa) if (sb.has(c)) hit++
  return hit / (sa.size + sb.size - hit)
}

export async function GET(request: NextRequest) {
  const guard = await guardPermission('product_dev')
  if (!guard.ok) return guard.res

  const id = Number(request.nextUrl.searchParams.get('id') ?? 0)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: '缺少申請單 id' }, { status: 400 })
  }
  // 主管可以先試算「如果編碼改成這個」的檢查結果，不必真的存檔
  const overridePart = (request.nextUrl.searchParams.get('part') ?? '').trim().toUpperCase()

  const supabase = getSupabaseAdminClient()
  const { data: row, error } = await supabase
    .from('item_code_requests').select('*').eq('id', id).maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ success: false, error: '找不到這張申請單' }, { status: 404 })

  const r = row as Record<string, unknown>
  const s = (v: unknown) => String(v ?? '').trim()
  const category = s(r.product_category).toUpperCase()
  const sub = s(r.product_category_2).toUpperCase()
  const part = overridePart || s(r.approved_part).toUpperCase() || s(r.suggested_part).toUpperCase()

  const checks: Check[] = []
  const push = (c: Check) => checks.push(c)

  // ── ① 有沒有填編碼 ───────────────────────────────────────────────
  if (!part) {
    push({ key: 'part_missing', label: '品項編碼', level: 'block', message: '尚未決定編碼，請在下方填寫' })
  }

  // ── ② 編碼首字母要與大類一致 ────────────────────────────────────
  if (part) {
    if (!CATEGORY_CODES.includes(category)) {
      push({ key: 'category', label: '產品大類', level: 'block', message: `大類 ${category || '(空)'} 不在 M/W/P/C/S/A/O 之內` })
    } else if (part[0] !== category) {
      push({
        key: 'prefix', label: '編碼前綴', level: 'block',
        message: `編碼開頭是 ${part[0]}，但大類是 ${category}。ARGO 會依 BOMF008 的類別定義檢核，對不上會被擋`,
      })
    } else {
      push({ key: 'prefix', label: '編碼前綴', level: 'ok', message: `開頭 ${part[0]} 與大類 ${category} 一致` })
    }
  }

  // ── ③ 編碼是否已存在（硬擋）──────────────────────────────────────
  if (part) {
    try {
      const dup = await getPartTemplate(part)
      if (dup) {
        push({
          key: 'duplicate', label: '編碼重複', level: 'block',
          message: `ARGO 已經有這個編碼：${s(dup.PART_NAME)}`,
          detail: { part: s(dup.PART), name: s(dup.PART_NAME), desc: s(dup.PART_DESC) },
        })
      } else {
        push({ key: 'duplicate', label: '編碼重複', level: 'ok', message: 'ARGO 查無此編碼，可以使用' })
      }
    } catch (err) {
      // 查不到不等於不存在。ARGO 掛掉時要說清楚「沒查成」，不能顯示成「沒重複」
      push({
        key: 'duplicate', label: '編碼重複', level: 'block',
        message: 'ARGO 查詢失敗，無法確認是否重複：' + (err instanceof Error ? err.message : String(err)),
      })
    }
  }

  // ── ④ 必填欄位 ───────────────────────────────────────────────────
  const required: [string, string][] = [
    ['part_name', '品項名稱'], ['unit_of_measure', '單位'],
    ['product_category', '產品大類'], ['product_category_2', '產品次類別'], ['note', '用途說明'],
  ]
  const missing = required.filter(([k]) => !s(r[k])).map(([, label]) => label)
  push(missing.length
    ? { key: 'required', label: '必填欄位', level: 'block', message: '缺少：' + missing.join('、') }
    : { key: 'required', label: '必填欄位', level: 'ok', message: '必填欄位齊全' })

  // ── ⑤ 單位是否為 ARGO 在用的單位（硬擋）──────────────────────────
  const unit = s(r.unit_of_measure)
  if (unit) {
    const { data: units } = await supabase
      .from('mm_bom_part_units').select('unit_of_measure').eq('unit_of_measure', unit).limit(1)
    push((units ?? []).length > 0
      ? { key: 'unit', label: '單位', level: 'ok', message: `「${unit}」是 ARGO 既有單位` }
      : {
          key: 'unit', label: '單位', level: 'block',
          message: `「${unit}」不在 ARGO 既有單位清單中，建檔會被擋`,
        })
  }

  // ── ⑥ 同次類別有沒有長得很像的既有品項（警示）────────────────────
  // 重複編碼的真實成因幾乎都不是打錯字，而是不知道公司已經有幾乎一樣的東西。
  const name = s(r.part_name)
  if (name && sub) {
    try {
      const pool = await searchParts(sub, 200)
      const similar = pool
        .map((p) => ({
          part: s(p.PART), name: s(p.PART_NAME), desc: s(p.PART_DESC),
          score: Math.max(similarity(name, s(p.PART_NAME)), similarity(name + s(r.part_desc), s(p.PART_NAME) + s(p.PART_DESC))),
        }))
        .filter((x) => x.part && x.score >= 0.6)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
      push(similar.length
        ? {
            key: 'similar', label: '相似品項', level: 'warn',
            message: `同次類別 ${sub} 底下有 ${similar.length} 個名稱相近的品項，請確認不是重複開`,
            detail: similar,
          }
        : { key: 'similar', label: '相似品項', level: 'ok', message: `同次類別 ${sub} 底下沒有名稱相近的品項` })
    } catch (err) {
      push({
        key: 'similar', label: '相似品項', level: 'warn',
        message: '相似品項查詢失敗（不影響建檔）：' + (err instanceof Error ? err.message : String(err)),
      })
    }
  }

  // ── ⑦ 帳務欄位有沒有偏離引用來源（警示）──────────────────────────
  const template = s(r.template_part)
  if (template) {
    try {
      const tpl = await getPartTemplate(template)
      if (tpl) {
        const diffs: Array<{ field: string; here: string; there: string }> = []
        for (const key of LOCKED_ERP_FIELDS) {
          const here = s(r[key])
          const there = s(tpl[LOCKED_FIELD_FROM_ARGO[key]])
          if (here !== there) diffs.push({ field: key, here, there })
        }
        push(diffs.length
          ? {
              key: 'locked_drift', label: '帳務欄位', level: 'warn',
              message: `與引用來源 ${template} 有 ${diffs.length} 欄不同（可能是引用後 ARGO 那邊改過）`,
              detail: diffs,
            }
          : { key: 'locked_drift', label: '帳務欄位', level: 'ok', message: `與引用來源 ${template} 一致` })
      } else {
        push({ key: 'locked_drift', label: '帳務欄位', level: 'warn', message: `引用來源 ${template} 在 ARGO 已查不到` })
      }
    } catch {
      push({ key: 'locked_drift', label: '帳務欄位', level: 'warn', message: '引用來源查詢失敗（不影響建檔）' })
    }
  } else {
    const preset = presetOf(category)
    push({
      key: 'locked_drift', label: '帳務欄位', level: 'warn',
      message: `這張單沒有引用既有品項，帳務設定用的是大類 ${category} 的預設值，請確認適用`,
      detail: LOCKED_ERP_FIELDS.map((k) => ({ field: k, here: s(r[k]), preset: preset[k] ?? '' })),
    })
  }

  const blocks = checks.filter((c) => c.level === 'block')
  const warns = checks.filter((c) => c.level === 'warn')
  return NextResponse.json({
    success: true,
    part,
    canApprove: blocks.length === 0,
    needsConfirm: warns.length > 0,
    counts: { block: blocks.length, warn: warns.length, ok: checks.length - blocks.length - warns.length },
    checks,
  })
}
