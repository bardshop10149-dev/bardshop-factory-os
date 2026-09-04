import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// route 檔只能匯出 HTTP method 與路由設定；此常數僅本檔使用，不可 export
// （export 會讓 next build --webpack 型別驗證失敗，同 exchange-csv 前例）
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

// POST：核發一次性簽名上傳網址，讓瀏覽器直接把檔案傳去 Supabase Storage，不經過
// 這台伺服器的 Serverless Function——Vercel 的 Function 請求本文上限約 4.5MB，示意圖
// 掃描檔／照片常常超過，直接把檔案 POST 到這支 API 會被 Vercel 擋在最前面回傳非 JSON
// 的錯誤頁（前端會看到「不是有效的 JSON」）。改成只傳檔名/類型等極小的 JSON 過來，
// 換回簽名網址後由瀏覽器端直接上傳，完全繞開這個限制。
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as {
      order_number?: string
      line_no?: string
      file_name?: string
      content_type?: string
      file_size?: number
    }
    const orderNumber = String(body.order_number ?? '').trim()
    const lineNo = String(body.line_no ?? '').trim()
    const fileName = String(body.file_name ?? '').trim()
    const contentType = String(body.content_type ?? '').trim()
    const fileSize = Number(body.file_size ?? 0)

    if (!fileName) {
      return NextResponse.json({ success: false, error: '請提供檔案名稱' }, { status: 400 })
    }
    if (!ALLOWED_TYPES.has(contentType)) {
      return NextResponse.json({ success: false, error: `不支援的檔案類型：${contentType || '未知'}（僅接受圖片或 PDF）` }, { status: 400 })
    }
    if (fileSize > MAX_SIZE) {
      return NextResponse.json({ success: false, error: `檔案過大（上限 ${MAX_SIZE / 1024 / 1024}MB）` }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    await ensureBucket(supabase)

    const ext = fileName.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
    const safePrefix = `${orderNumber}_${lineNo}`.replace(/[^\w#-]/g, '_') || 'sketch'
    const path = `${safePrefix}_${Date.now()}.${ext}`

    const { data, error: signErr } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (signErr || !data) throw signErr || new Error('無法建立簽名上傳網址')

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path)
    return NextResponse.json({
      success: true,
      bucket: BUCKET,
      path,
      token: data.token,
      publicUrl: urlData.publicUrl,
    })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
