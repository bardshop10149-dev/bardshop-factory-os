import { NextRequest } from 'next/server'
import type { PlacementOp } from '@/lib/packaging/scheduleTypes'
import { handleApplyRequest } from '@/lib/packaging/scheduleWrite'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P1：手動完成勾選（寫＋編輯鎖）。規格 §四.3；D24／D26／D45
//
// POST CompleteRequest { lockToken, ops, label? } → ApplyResponse（inverse 可 Undo）
//   ops 只收 complete／uncomplete／place：待排池卡直接勾完成＝同一批送
//   [place{ toDate: rollTarget, qty: 剩餘 }, complete{ version: 1 }]。
// D24 第一版勾完成「不寫入塔台」；只寫 packaging_placements（completed_*）與 packaging_op_log。
// 獨立一支的理由：稽核上「勾完成」是獨立動作（op_log.kind = complete），P3 接塔台報工時只改這一支。

const ALLOWED = new Set<PlacementOp['op']>(['complete', 'uncomplete', 'place'])

export async function POST(request: NextRequest) {
  return handleApplyRequest(request, { kind: 'complete', allowed: ALLOWED })
}
