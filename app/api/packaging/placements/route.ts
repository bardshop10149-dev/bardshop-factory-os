import { NextRequest } from 'next/server'
import { handleApplyRequest } from '@/lib/packaging/scheduleWrite'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P1：擺放操作（寫＋編輯鎖）。規格 docs/design/2026-09-27-packaging-schedule-p1.md §四.2
//
// POST PlacementsRequest { lockToken, ops: PlacementOp[1..50], label? } → ApplyResponse
//   op：place／move／split／merge／unplace／setQty（Undo 用）／restore（Undo 用）／complete／uncomplete
// 權限：packaging_admin（admin 自動通過，D30）＋持有編輯鎖（D53）；Content-Type 必須 application/json（擋 CSRF）。
// 只寫 packaging_placements／packaging_op_log（＋鎖續命），絕不寫既有表、不回寫塔台（D4／D24）。
// 流程與驗證在 lib/packaging/scheduleWrite.ts（與 /cards/complete 共用 applyOps）。

export async function POST(request: NextRequest) {
  return handleApplyRequest(request, { kind: 'placements' })
}
