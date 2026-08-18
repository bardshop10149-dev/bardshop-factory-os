import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const TABLE = 'order_anomaly_records'
const BUCKET = 'anomaly-attachments'

interface AnomalyRecordFields {
  anomaly_date: string | null
  anomaly_category: string | null
  responsible_department: string | null
  responsible_person: string | null
  anomaly_description: string | null
  resolution: string | null
}

// ============================================================
// 共用：把 FormData 裡的純量欄位整理成寫入用的物件
// ============================================================
function pickFields(formData: FormData): AnomalyRecordFields {
  const get = (key: string): string | null => {
    const v = formData.get(key)
    if (typeof v !== 'string') return null
    const trimmed = v.trim()
    return trimmed === '' ? null : trimmed
  }
  return {
    anomaly_date: get('anomaly_date'),
    anomaly_category: get('anomaly_category'),
    responsible_department: get('responsible_department'),
    responsible_person: get('responsible_person'),
    anomaly_description: get('anomaly_description'),
    resolution: get('resolution'),
  }
}

// ============================================================
// 共用：把 FormData 裡的檔案上傳到 anomaly-attachments bucket，
// 回傳公開網址陣列（伺服器端執行，前端不再直接碰 storage）。
// ============================================================
async function uploadAttachments(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  formData: FormData
): Promise<{ urls: string[] } | { error: string }> {
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0)
  const urls: string[] = []

  for (const file of files) {
    const ext = file.name.split('.').pop() || 'bin'
    const path = `order-anomaly/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
    const arrayBuffer = await file.arrayBuffer()

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, Buffer.from(arrayBuffer), {
        upsert: false,
        contentType: file.type || undefined,
      })

    if (upErr) return { error: upErr.message }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path)
    urls.push(urlData.publicUrl)
  }

  return { urls }
}

function parseExistingAttachments(formData: FormData): string[] {
  const raw = formData.get('existing_attachments')
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : []
  } catch {
    return []
  }
}

// ============================================================
// GET：列出所有異常紀錄（依 created_at 新到舊）
// ============================================================
export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, records: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// POST：新增一筆異常紀錄（multipart/form-data，可附帶 files）
// ============================================================
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const formData = await request.formData()
    const supabase = getSupabaseAdminClient()

    const uploadResult = await uploadAttachments(supabase, formData)
    if ('error' in uploadResult) {
      return NextResponse.json({ success: false, error: `上傳失敗：${uploadResult.error}` }, { status: 500 })
    }

    const existingAttachments = parseExistingAttachments(formData)
    const payload = {
      ...pickFields(formData),
      attachments: [...existingAttachments, ...uploadResult.urls],
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from(TABLE)
      .insert(payload)
      .select('*')
      .single()

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, record: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// PUT：更新一筆異常紀錄（multipart/form-data，body 需含 id）
// ============================================================
export async function PUT(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const formData = await request.formData()
    const idRaw = formData.get('id')
    const id = typeof idRaw === 'string' ? Number(idRaw) : NaN
    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ success: false, error: 'id 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    const uploadResult = await uploadAttachments(supabase, formData)
    if ('error' in uploadResult) {
      return NextResponse.json({ success: false, error: `上傳失敗：${uploadResult.error}` }, { status: 500 })
    }

    const existingAttachments = parseExistingAttachments(formData)
    const payload = {
      ...pickFields(formData),
      attachments: [...existingAttachments, ...uploadResult.urls],
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from(TABLE)
      .update(payload)
      .eq('id', id)
      .select('*')
      .single()

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, record: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// DELETE：刪除一筆異常紀錄（?id= 或 body 帶 { id }）
// ============================================================
export async function DELETE(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const url = new URL(request.url)
    let idRaw: string | null = url.searchParams.get('id')

    if (!idRaw) {
      try {
        const body = await request.json()
        idRaw = body?.id != null ? String(body.id) : null
      } catch {
        idRaw = null
      }
    }

    const id = idRaw ? Number(idRaw) : NaN
    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ success: false, error: 'id 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).delete().eq('id', id)

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
