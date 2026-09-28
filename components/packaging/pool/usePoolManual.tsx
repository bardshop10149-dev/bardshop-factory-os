'use client'

// D102 待排池頁的手動加入控制（只給 /packaging/pool 用）：開哪個對話框、關掉後重抓。
//
// 為什麼這麼薄：Snow 確認「待排池頁加單／改量／移出不受編輯權限制」（工作台有人在編輯也照樣能加，
// 工作台按重新整理就看得到新卡），伺服器也已拿掉 lockToken 檢查 → 這裡不取鎖、不需要「編輯權衝突」視窗、
// 也不必擔心 acquire／release 競速。守門只剩兩道：
//   1. 前端 canEdit（is_admin 或 packaging_admin）只決定按鈕：主管＝加入／改數量／移出；唯讀者＝只能「查詢」。
//   2. 真正的權限在伺服器（guardPackaging('write')）；數量安全也在伺服器（改量不可低於已排量、有排定卡不可移出）。
//
// 重抓策略：寫入成功就重抓；關閉對話框時若這次沒有任何成功寫入，也重抓一次——
// 涵蓋「別人剛移出 → 我按改數量得到 404」這類情況，關掉後畫面立刻跟上（重抓很便宜，見 app/api/packaging/pool）。

import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { PackagingCard } from '@/lib/packaging/types'
import type { PoolManualLine } from '@/lib/packaging/manualPool'
import ManualAddDialog, { ManualEditDialog, ManualRemoveDialog } from '@/components/packaging/board/ManualAddDialog'

type Dialog =
  | { t: 'add' }
  | { t: 'edit'; card: PackagingCard; line: PoolManualLine }
  | { t: 'remove'; card: PackagingCard; line: PoolManualLine }

export interface PoolManualController {
  /** 標題列「＋加入訂單」（主管）／「查詢訂單」（唯讀） */
  openAdd: () => void
  openEdit: (card: PackagingCard, line: PoolManualLine) => void
  openRemove: (card: PackagingCard, line: PoolManualLine) => void
  /** 對話框；頁面放在最底下 render */
  dialogs: ReactNode
}

const READONLY_NOTE = '唯讀：可以查詢這張單為什麼不在待排池；加入、改數量、移出需要包裝主管（packaging_admin）權限'

export function usePoolManual(opts: {
  /** is_admin || packaging_admin（同 guardPackaging('write')） */
  canEdit: boolean
  /** 頁面重抓 /api/packaging/pool（排隊版：進行中就排下一次，不會漏抓） */
  onChanged: () => void
}): PoolManualController {
  const { canEdit, onChanged } = opts
  const [dialog, setDialog] = useState<Dialog | null>(null)
  /** 這次開著的對話框是否已經有成功寫入（已重抓過，關閉時就不必再抓） */
  const wroteRef = useRef(false)

  const open = useCallback((d: Dialog) => {
    wroteRef.current = false
    setDialog(d)
  }, [])
  const openAdd = useCallback(() => open({ t: 'add' }), [open])
  // 唯讀者不會看到改數量／移出按鈕（ManualPoolSection 只在 canEdit 時畫）；這裡再擋一次，萬一被呼叫也不開寫入對話框
  const openEdit = useCallback((card: PackagingCard, line: PoolManualLine) => { if (canEdit) open({ t: 'edit', card, line }) }, [canEdit, open])
  const openRemove = useCallback((card: PackagingCard, line: PoolManualLine) => { if (canEdit) open({ t: 'remove', card, line }) }, [canEdit, open])

  const changed = useCallback(() => {
    wroteRef.current = true
    onChanged()
  }, [onChanged])
  const close = useCallback(() => {
    setDialog(null)
    if (!wroteRef.current) onChanged()
    wroteRef.current = false
  }, [onChanged])

  let dialogs: ReactNode = null
  if (dialog?.t === 'add') {
    dialogs = <ManualAddDialog editable={canEdit} readOnlyNote={READONLY_NOTE} onClose={close} onChanged={changed} />
  } else if (dialog?.t === 'edit') {
    // D103：數量＝總量（含已完成）→ 對話框要知道已完成多少，預警才和伺服器下限（已完成＋未完成）一致
    dialogs = (
      <ManualEditDialog
        card={dialog.card}
        meta={dialog.line.meta}
        placedQty={dialog.line.placedQty}
        completedQty={dialog.line.completedQty}
        onClose={close}
        onChanged={changed}
      />
    )
  } else if (dialog?.t === 'remove') {
    dialogs = <ManualRemoveDialog card={dialog.card} meta={dialog.line.meta} onClose={close} onChanged={changed} />
  }

  return { openAdd, openEdit, openRemove, dialogs }
}
