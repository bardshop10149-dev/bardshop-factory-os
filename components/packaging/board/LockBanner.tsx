'use client'

// D53 編輯鎖橫幅（規格 §5.8 五種狀況）：
//   唯讀權限 → 「唯讀檢視」；可寫無人編輯 → [開始編輯]；別人編輯中 → [接手編輯]（先確認）；
//   自己持有 → [結束編輯]＋逾時倒數；被接手 → 紅色提示。

import { useState, type ReactNode } from 'react'
import { LOCK_IDLE_MS } from '@/lib/packaging/scheduleTypes'
import Modal, { Btn } from './Modal'
import { ago, clock } from './boardFormat'
import type { EditLockApi } from './useEditLock'

export default function LockBanner({ lk, canEdit, nowMs, pending, pausedForLock }: {
  lk: EditLockApi
  /** me.canEdit（packaging_admin／admin） */
  canEdit: boolean
  nowMs: number
  /** 尚未儲存的操作數（結束編輯前要等它送完） */
  pending: number
  /** 佇列因鎖逾時暫停中 */
  pausedForLock: boolean
}) {
  const [confirmTakeover, setConfirmTakeover] = useState(false)
  const lock = lk.lock
  const serverNow = nowMs + lk.offsetMs
  const holder = lock?.held ? (lock.holderName || lock.holderEmail || '其他主管') : null

  let tone = 'border-slate-700 bg-slate-900/70 text-slate-300'
  let body: ReactNode

  if (!canEdit) {
    body = (
      <span>
        <b className="text-slate-100">唯讀檢視</b>（每 60 秒自動更新）
        {holder && <span className="text-slate-400">・{holder} 正在編輯中</span>}
      </span>
    )
  } else if (lk.phase === 'mine') {
    const expMs = lock?.expiresAt ? Date.parse(lock.expiresAt) - serverNow : LOCK_IDLE_MS
    const soon = expMs < 60_000
    tone = soon ? 'border-orange-600/70 bg-orange-950/40 text-orange-100' : 'border-emerald-700/60 bg-emerald-950/30 text-emerald-100'
    body = (
      <>
        <span>
          <b>你正在編輯</b>
          {soon
            ? <span className="ml-1 font-semibold">・{Math.max(0, Math.ceil(expMs / 1000))} 秒後因無動作自動釋放</span>
            : <span className="ml-1 text-emerald-200/70">・5 分鐘無動作會自動釋放</span>}
        </span>
        <span className="flex-1" />
        {soon && <Btn tone="primary" onClick={() => void lk.touch()}>繼續編輯</Btn>}
        <Btn
          onClick={() => void lk.release()}
          disabled={lk.busy || pending > 0}
          title={pending > 0 ? '還有操作儲存中，請稍候' : '釋放編輯權，讓其他主管可以編輯'}
        >結束編輯</Btn>
      </>
    )
  } else if (lk.phase === 'lost') {
    tone = 'border-red-600/80 bg-red-950/50 text-red-100'
    body = (
      <>
        <span>
          <b>已由 {lk.lostTo?.name ?? '其他主管'}{lk.lostTo?.at ? ` 於 ${clock(lk.lostTo.at, nowMs)}` : ''} 接手編輯</b>，你已轉為唯讀。
        </span>
        <span className="flex-1" />
        {holder ? (
          <Btn onClick={() => setConfirmTakeover(true)} disabled={lk.busy}>接手編輯</Btn>
        ) : (
          <Btn tone="primary" onClick={() => void lk.acquire()} disabled={lk.busy}>開始編輯</Btn>
        )}
      </>
    )
  } else if (holder && !lock?.isMine) {
    tone = 'border-amber-700/60 bg-amber-950/30 text-amber-100'
    body = (
      <>
        <span>
          <b>{holder}</b> 正在編輯中
          {lock?.lastActionAt && <span className="text-amber-200/70">（最後動作 {ago(lock.lastActionAt, serverNow)}）</span>}
          ・你目前是唯讀
        </span>
        <span className="flex-1" />
        <Btn onClick={() => setConfirmTakeover(true)} disabled={lk.busy}>接手編輯</Btn>
      </>
    )
  } else {
    body = (
      <>
        <span>
          {lk.phase === 'expired' || pausedForLock
            ? <b className="text-orange-200">編輯權已逾時釋放（5 分鐘無動作）</b>
            : <>目前沒有人在編輯</>}
          <span className="text-slate-400">・按「開始編輯」才能拖曳、勾完成（同一時間只有一人能編輯）</span>
        </span>
        <span className="flex-1" />
        <Btn tone="primary" onClick={() => void lk.acquire()} disabled={lk.busy}>
          {lk.phase === 'expired' || pausedForLock ? '重新取得編輯權' : '開始編輯'}
        </Btn>
      </>
    )
  }

  return (
    <>
      <div className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs ${tone}`} role="status">
        {body}
        {lk.error && (
          <span className="basis-full text-[11px] text-rose-300">
            {lk.error}
            <button type="button" onClick={lk.clearError} className="ml-2 underline">知道了</button>
          </span>
        )}
      </div>
      {confirmTakeover && (
        <Modal
          title="接手編輯"
          onClose={() => setConfirmTakeover(false)}
          footer={<>
            <Btn onClick={() => setConfirmTakeover(false)}>取消</Btn>
            <Btn tone="danger" disabled={lk.busy} onClick={() => { void lk.takeover().then(() => setConfirmTakeover(false)) }}>確定接手</Btn>
          </>}
        >
          <p>
            <b>{holder ?? '對方'}</b> 目前正在編輯。接手後對方會在 30 秒內轉為唯讀，
            <b className="text-orange-300">對方尚未儲存的操作會遺失</b>（已自動儲存的不受影響）。
          </p>
        </Modal>
      )}
    </>
  )
}
