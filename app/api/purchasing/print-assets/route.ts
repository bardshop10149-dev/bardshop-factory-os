import { NextRequest, NextResponse } from 'next/server'

import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// 示意圖索引查詢（唯讀）
//
// 資料來源：print_asset_index——內網掃描器（tools/print_index_scanner.py）每小時
// 把 NAS「ro排單圖庫」的檔案清單寫上來。EIP 部署在 Vercel 摸不到內網，
// 這裡只回「路徑與檔名」；設計圖本體不出內網，開檔靠使用者把 UNC 路徑
// 貼進檔案總管（未來若做內網橋接預覽，仍以本索引為基礎）。
//
// GET /api/purchasing/print-assets?so=SO260817009,SOA260810-090811-235
//   → { assets: { [so_no]: { count, previews, files: [...] } }, nasRoot }
// ─────────────────────────────────────────────────────────────────────────────

/** UNC 主機根：rel_path 已含共享名（RO排單圖庫\...／歷年排單圖庫2號倉\...），組合即完整路徑 */
const NAS_ROOT = '\\\\192.168.1.141'

const PAGE = 1000
const MAX_SO = 300

export interface PrintAssetFile {
  rel_path: string
  file_name: string
  ext: string | null
  is_preview: boolean
  size_bytes: number | null
  file_mtime: string | null
}

export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res

  const raw = request.nextUrl.searchParams.get('so') ?? ''
  const soNos = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))]
  if (soNos.length === 0) return NextResponse.json({ success: true, assets: {}, nasRoot: NAS_ROOT })
  if (soNos.length > MAX_SO) {
    return NextResponse.json({ success: false, error: `一次最多查 ${MAX_SO} 張單` }, { status: 400 })
  }

  try {
    const supabase = getSupabaseAdminClient()
    // 單次查詢上限 1000 列，一定分頁讀到底（單頁 100 列 × 每單數十檔可能超過）
    const rows: (PrintAssetFile & { so_no: string })[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('print_asset_index')
        .select('so_no, rel_path, file_name, ext, is_preview, size_bytes, file_mtime')
        .in('so_no', soNos)
        .order('so_no').order('rel_path')
        .range(from, from + PAGE - 1)
      if (error) throw new Error(error.message)
      const batch = (data ?? []) as (PrintAssetFile & { so_no: string })[]
      rows.push(...batch)
      if (batch.length < PAGE) break
    }

    const assets: Record<string, { count: number; previews: number; files: PrintAssetFile[] }> = {}
    for (const r of rows) {
      const e = (assets[r.so_no] ??= { count: 0, previews: 0, files: [] })
      e.count += 1
      if (r.is_preview) e.previews += 1
      e.files.push({
        rel_path: r.rel_path, file_name: r.file_name, ext: r.ext,
        is_preview: r.is_preview, size_bytes: r.size_bytes, file_mtime: r.file_mtime,
      })
    }
    // 示意圖排最前、其餘依修改時間新→舊
    for (const e of Object.values(assets)) {
      e.files.sort((a, b) =>
        Number(b.is_preview) - Number(a.is_preview)
        || String(b.file_mtime ?? '').localeCompare(String(a.file_mtime ?? '')))
    }

    return NextResponse.json({ success: true, assets, nasRoot: NAS_ROOT })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
