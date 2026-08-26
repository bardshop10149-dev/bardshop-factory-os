import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const BUCKET = 'order-sketch-images'
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf'])
const MAX_SIZE = 20 * 1024 * 1024 // 20MB，示意圖多為掃描檔/photo，PDF 也可能較大

// 確保 bucket 存在（idempotent）——跟這個系統其他上傳功能（如 anomaly-attachments）一樣，
// bucket 只需要建立一次；用 createBucket 而非要求人工先到 Supabase 後台手動建，第一次呼叫
// 時若已存在會回錯誤，直接忽略即可。
async function ensureBucket(supabase: ReturnType<typeof getSupabaseAdminClient>) {
  try {
    await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX_SIZE })
  } catch {
    // 已存在或無建立權限時忽略，後續 upload 若真的失敗會回報明確錯誤
  }
}

// POST：上傳一張示意圖/PDF，回傳公開網址（不寫回出單表——由前端拿到網址後自行決定寫哪一列，
// 沿用出單表既有「整份 rows 存回」的儲存模式，這裡只單純負責檔案上傳）
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const formData = await request.formData()
    const file = formData.get('file')
    const orderNumber = String(formData.get('order_number') ?? '').trim()
    const lineNo = String(formData.get('line_no') ?? '').trim()

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ success: false, error: '請提供檔案' }, { status: 400 })
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ success: false, error: `不支援的檔案類型：${file.type || '未知'}（僅接受圖片或 PDF）` }, { status: 400 })
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ success: false, error: `檔案過大（上限 ${MAX_SIZE / 1024 / 1024}MB）` }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    await ensureBucket(supabase)

    const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
    const safePrefix = `${orderNumber}_${lineNo}`.replace(/[^\w#-]/g, '_') || 'sketch'
    const path = `${safePrefix}_${Date.now()}.${ext}`
    const arrayBuffer = await file.arrayBuffer()

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, Buffer.from(arrayBuffer), { upsert: false, contentType: file.type })
    if (upErr) throw upErr

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path)
    return NextResponse.json({ success: true, url: urlData.publicUrl })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
