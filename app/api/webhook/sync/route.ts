import { NextRequest, NextResponse } from 'next/server'

// 此 webhook 供外部系統（如個人 EIP）觸發公司 ERP 同步
// 驗證方式：Header `Authorization: Bearer <WEBHOOK_SECRET>`
// 不需要 bardshop-token cookie

const ALLOWED_ACTIONS = ['sync_so', 'sync_mo', 'sync_pj', 'sync_po', 'sync_pr', 'sync_material_prep', 'sync_vendor', 'run_mo_match'] as const
type AllowedAction = typeof ALLOWED_ACTIONS[number]

export async function POST(request: NextRequest) {
  // 驗證 secret
  const authHeader = request.headers.get('Authorization') ?? ''
  const secret = authHeader.replace(/^Bearer\s+/i, '').trim()
  const expectedSecret = process.env.WEBHOOK_SECRET ?? ''

  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  let body: { action?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const { action } = body
  if (!action || !(ALLOWED_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { success: false, error: `action 必須是 ${ALLOWED_ACTIONS.join(' | ')}` },
      { status: 400 }
    )
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

  // run_mo_match 直接呼叫內部 batch API，不需要 bardshop-token
  if (action === 'run_mo_match') {
    const res = await fetch(`${baseUrl}/api/argoerp/batch-mo-match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const json = await res.json()
    return NextResponse.json(json, { status: res.status })
  }

  // 其餘同步 action 轉發到 /api/argoerp（用 X-Internal-Secret 繞過 cookie auth）
  const res = await fetch(`${baseUrl}/api/argoerp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': expectedSecret,
    },
    body: JSON.stringify({ action: action as AllowedAction }),
  })

  const json = await res.json()
  return NextResponse.json(json, { status: res.status })
}
