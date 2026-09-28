// 包裝專區 D102 — 排程寫入「之後」回讀手動加入紀錄（write-then-read-back 的工作台那一半；I/O 層）
//
// 為什麼需要：D102 讓待排池頁的移出／改量不再拿編輯鎖。工作台（持鎖者）寫擺放是「先讀手動供給、後寫擺放」，
//   待排池頁移出是「先讀擺放、後寫 removed_at」——兩個請求交錯時兩邊的檢查都會過，排定卡就沒了供給
//   （讀取時被當成「行已不在待排池」略過：卡從畫面消失）。只改待排池頁那一邊只能把窗口縮小，關不掉。
// 做法：待排池頁那邊「寫完再讀擺放」（manual/remove、manual PATCH），這裡是工作台這邊「寫完擺放再讀手動紀錄」：
//   只要有一邊的讀看得到另一邊的寫（兩個「寫→讀」在 read committed 下一定至少有一邊看得到），就能修正。
//   工作台這邊看到「紀錄剛被移出／數量剛被改低」→ 以排程為準恢復供給（寫入的卡已經回給使用者，不能再撤回），記 op_log 說明。
// 成本：只有這批寫過「只靠手動供給」的行、寫完仍有未完成擺放時才多一個查詢；一般的卡（正常區塊）完全不多查（D98 存檔速度不受影響）。
// 盡力而為：回讀或恢復失敗只記 log、不讓已成功的排程寫入變成失敗（最壞情況＝回到 D102 前「卡片被略過、重新加入即回來」）。
// 只寫 packaging_manual_inclusions／packaging_op_log。

import { describeError } from '@/lib/supabaseAdmin'
import type { ManualInclusionMeta, Placement } from '@/lib/packaging/scheduleTypes'
import { manualReconcileCandidates, planManualReconcile } from '@/lib/packaging/manualPool'
import { loadActiveInclusionsByKeys, restoreInclusionFields, unremoveInclusion } from '@/lib/packaging/manualDb'
import { invalidateManualCache } from '@/lib/packaging/manualCache'
import { insertOpLog, type SupabaseAdmin } from '@/lib/packaging/scheduleDb'

export interface ManualReconcileResult {
  /** 恢復成有效的手動紀錄（SO 行） */
  restored: string[]
  /** 數量恢復成排程驗證時的值（SO 行） */
  requantified: string[]
}

const NONE: ManualReconcileResult = { restored: [], requantified: [] }

export async function reconcileManualAfterPlacementWrite(
  sb: SupabaseAdmin,
  input: {
    meta: Readonly<Record<string, ManualInclusionMeta>>
    normalKeys: ReadonlySet<string>
    res: { inserts: readonly Placement[]; updates: readonly { after: Placement }[]; next: ReadonlyMap<string, Placement> }
    actor: { email: string; name: string | null }
    /** op_log 的來源說明（例「排程工作台」「採用 AI 模擬 #12」） */
    via: string
  },
): Promise<ManualReconcileResult> {
  const candidates = manualReconcileCandidates({
    meta: input.meta,
    normalKeys: input.normalKeys,
    written: [...input.res.inserts, ...input.res.updates.map((u) => u.after)],
    next: input.res.next.values(),
  })
  if (candidates.length === 0) return NONE
  try {
    const active = await loadActiveInclusionsByKeys(sb, candidates.map((c) => c.soLineKey))
    const plan = planManualReconcile(candidates, active)
    if (plan.restore.length === 0 && plan.requantify.length === 0) return NONE
    const nowIso = new Date().toISOString()
    const restored: string[] = []
    const requantified: string[] = []
    const ops: unknown[] = []
    for (const r of plan.restore) {
      const back = await unremoveInclusion(sb, r.inclusionId, {}, input.actor, nowIso)
      // 'duplicate'＝同一行剛被重新加入（新紀錄已提供供給）；null＝已被別人恢復 → 都不必再做
      if (back && back !== 'duplicate') {
        restored.push(r.soLineKey)
        ops.push({ action: 'restore', id: r.inclusionId, soLineKey: r.soLineKey, why: 'placement_written_concurrently' })
      }
    }
    for (const q of plan.requantify) {
      const back = await restoreInclusionFields(sb, q.inclusionId, { qty: q.from }, { qty: q.to }, input.actor, nowIso)
      if (back) {
        requantified.push(q.soLineKey)
        ops.push({ action: 'update', id: q.inclusionId, soLineKey: q.soLineKey, before: { qty: q.from }, after: { qty: q.to }, why: 'placement_written_concurrently' })
      }
    }
    if (ops.length > 0) {
      invalidateManualCache()
      const keys = [...restored, ...requantified]
      console.warn(`[packaging/manual-reconcile] ${input.via}：與待排池頁的移出／改量同時發生，已恢復手動供給 ${keys.join('、')}`)
      await insertOpLog(sb, {
        actorEmail: input.actor.email, actorName: input.actor.name, kind: 'manual',
        label: `恢復手動加入 ${keys.slice(0, 5).join('、')}${keys.length > 5 ? ` 等 ${keys.length} 行` : ''}（${input.via}同時排了卡，排程優先）`.slice(0, 120),
        ops,
      })
    }
    return { restored, requantified }
  } catch (e) {
    console.error(`[packaging/manual-reconcile] ${input.via} 回讀手動加入失敗（排程已寫入，不影響）：`, describeError(e))
    return NONE
  }
}
