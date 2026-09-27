'use client'

// 正式工作台的「AI 採用紀錄」（規格 §6.2、§八；D82／D86「返回上一個版本」、預設「退回採用＝只在該次範圍內」）。
//
// 列表：最近 20 筆採用（誰、何時、範圍、張數、是否已退回）。只有「最近一筆、還沒退回」的能退回（較早的要先退回較新的）。
// 退回：先預覽（會退回／移回待排池／新增幾張；採用後又被改過的卡也會一起倒回；已完成／已銷貨的無法還原）→ 確認 → 寫入。
//   只動該次採用的範圍（那幾天 × 當時未鎖定的線）；範圍外、待排區、已完成完全不動。退回前伺服器會再自動存一版「還原前備份」。
// 需要正式區編輯鎖（D53）：用工作台自己的鎖（getLockToken），沒持有時請主管先按「開始編輯」——
//   這裡不另外 acquire：工作台已經有一套鎖的狀態與橫幅，兩套並存會互相打架（同一分頁同一把 token）。
// 完整還原（整張排程）仍在「版本」面板，那是最後手段：會連範圍外一起倒回。

import { useCallback, useEffect, useState } from 'react'
import type { AdoptionMeta, LockedLineConflict, RevertPreviewResponse } from '@/lib/packaging/ai/types'
import type { PackagingLine } from '@/lib/packaging/scheduleTypes'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import { fmtQty } from '@/components/packaging/poolStyles'
import Modal, { Btn } from '@/components/packaging/board/Modal'
import { clock, md } from '@/components/packaging/board/boardFormat'
import Drawer from './Drawer'
import { fetchAdoptions, fetchRevertPreview, postRevert } from './simApi'
import { countsText } from './simText'

type RevertPreview = Extract<RevertPreviewResponse, { success: true }>

export default function AdoptionsDialog({ editable, getLockToken, nowMs, lines, onClose, onReverted }: {
  /** 持有正式區編輯鎖（工作台 lk.phase === 'mine'） */
  editable: boolean
  getLockToken: () => string | null
  nowMs: number
  lines: PackagingLine[]
  onClose: () => void
  /** 退回成功：呼叫端清 Undo、重新載入工作台、顯示訊息 */
  onReverted: (msg: string) => void
}) {
  const [list, setList] = useState<AdoptionMeta[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<RevertPreview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [partial, setPartial] = useState<number | null>(null)
  /** POST 回 locked_line_diverged 時伺服器列出的範圍外不一致（預覽之後才發生的變化） */
  const [postConflicts, setPostConflicts] = useState<LockedLineConflict[] | null>(null)

  const load = useCallback(async () => {
    const r = await fetchAdoptions()
    if (r.json && r.json.success) { setList(r.json.adoptions); setErr(null) }
    else setErr(r.error ?? '讀取 AI 採用紀錄失敗')
  }, [])
  useEffect(() => { void load() }, [load])

  const openPreview = async (a: AdoptionMeta) => {
    setBusy(true)
    setMsg(null)
    setPreviewErr(null)
    setPartial(null)
    setPostConflicts(null)
    try {
      const r = await fetchRevertPreview(a.id)
      if (r.json && r.json.success) setPreview(r.json)
      else setMsg(r.error ?? '無法預覽退回')
    } finally {
      setBusy(false)
    }
  }

  const doRevert = async () => {
    if (!preview) return
    const token = getLockToken()
    if (!editable || !token) { setPreviewErr('需要編輯權：請先關閉這個視窗，按工作台上方的「開始編輯」，再回來退回。'); return }
    setBusy(true)
    setPreviewErr(null)
    setPartial(null)
    try {
      const id = preview.adoption.id
      const r = await postRevert(id, { lockToken: token })
      if (r.json && r.json.success) {
        const rep = r.json.report
        const m = `已退回 AI 採用 #${id}：${countsText(rep.counts)}；退回前的排程已存成版本 #${rep.backupVersionId}`
        setPreview(null)
        setMsg(m)
        onReverted(m)
        await load()
        return
      }
      const code = r.code
      if (code === 'lock_required' || code === 'lock_lost') {
        setPreviewErr(code === 'lock_lost' ? '編輯權已被其他主管接手，這次沒有寫入。' : '編輯權已逾時釋放，這次沒有寫入；請重新按「開始編輯」後再試。')
      } else if (r.json && !r.json.success && r.json.partial) {
        setPartial(r.json.versionId ?? null)
        setPreviewErr(r.error ?? '寫入到一半失敗')
      } else {
        if (code === 'locked_line_diverged') setPostConflicts(r.json && !r.json.success ? r.json.conflicts ?? [] : [])
        setPreviewErr(r.error ?? '退回失敗')
        if (code === 'not_latest_adoption' || code === 'already_reverted' || code === 'revert_in_progress') void load()
      }
    } finally {
      setBusy(false)
    }
  }

  const scopeText = (a: Pick<AdoptionMeta, 'windowDates' | 'lineIds'>) =>
    `${a.windowDates.length > 0 ? `${md(a.windowDates[0])}～${md(a.windowDates[a.windowDates.length - 1])}` : '—'}・${a.lineIds.map(id => lineNameOf(lines, id)).join('、') || '—'}`

  return (
    <>
      <Drawer title="AI 採用紀錄" onClose={onClose}>
        <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-slate-400">
            每次在 AI 模擬區按「採用此版排程」都會記一筆（採用前自動存版本）。退回＝只把<b className="text-slate-300">那次採用的範圍</b>（那幾天 × 當時未鎖定的線）
            倒回採用前；範圍外的日子、待排區、已完成的卡完全不動。只能退回最近一筆。
          </p>
          {!editable && (
            <div className="rounded border border-slate-700 bg-slate-950/50 px-3 py-2 text-[11px] text-slate-300">
              目前是唯讀：要退回請先關閉這個視窗，按工作台上方的「開始編輯」。
            </div>
          )}
          {msg && <div className="rounded border border-sky-800 bg-sky-950/30 px-3 py-2 text-xs text-sky-200">{msg}</div>}
          {err ? (
            <div className="rounded border border-rose-800 bg-rose-950/30 p-3 text-xs text-rose-200">
              {err}
              <button type="button" onClick={() => void load()} className="ml-2 underline">重試</button>
            </div>
          ) : !list ? (
            <p className="py-6 text-center text-xs text-slate-400">讀取中…</p>
          ) : list.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">還沒有 AI 採用紀錄</p>
          ) : (
            <ul className="space-y-2">
              {list.map(a => (
                <li key={a.id} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-1.5 py-px text-[10px] ${
                      a.revertedAt ? 'border-slate-600 bg-slate-800 text-slate-300'
                        : a.canRevert ? 'border-violet-600/60 bg-violet-950/50 text-violet-200' : 'border-slate-700 bg-slate-900 text-slate-400'
                    }`}>{a.revertedAt ? '已退回' : a.canRevert ? '最近一次' : '已採用'}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold text-slate-100">{clock(a.createdAt, nowMs)}・{a.actorName ?? a.actorEmail}</span>
                    <span className="text-[10px] text-slate-500">#{a.id}{a.runId != null ? `・AI #${a.runId}` : ''}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400">{scopeText(a)}</div>
                  <div className="mt-0.5 text-[11px] text-slate-300">{countsText(a.counts)}{a.skippedCount > 0 ? `（略過 ${a.skippedCount}）` : ''}</div>
                  {a.revertedAt && (
                    <div className="mt-0.5 text-[11px] text-slate-500">{a.revertedByName ?? '—'} 於 {clock(a.revertedAt, nowMs)} 退回</div>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-slate-500">採用前版本 #{a.versionId}</span>
                    <span className="flex-1" />
                    {!a.revertedAt && (
                      <Btn disabled={busy || !a.canRevert} title={a.canRevert ? undefined : '只能退回最近一筆未退回的採用（要先退回較新的）'} onClick={() => void openPreview(a)}>
                        預覽退回…
                      </Btn>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-500">
            最後手段：整張排程還原請用工作台的「版本」面板（選「AI 前」的版本）。那會連範圍外的日子、待排區的變動一起倒回，採用後其他人新排的卡也會被移除。
          </p>
        </div>
      </Drawer>

      {preview && (
        <Modal
          title={`退回 AI 採用 #${preview.adoption.id}？`}
          onClose={() => setPreview(null)}
          wide
          footer={<>
            <Btn onClick={() => setPreview(null)}>取消</Btn>
            <Btn tone="danger" disabled={busy || !preview.canRevert || !editable} onClick={() => void doRevert()}
              title={!editable ? '需要編輯權（先按工作台上方的「開始編輯」）' : undefined}>
              {busy ? '退回中…' : '確定退回'}
            </Btn>
          </>}
        >
          <div className="space-y-2 text-sm">
            {!preview.canRevert && (
              <div className="rounded border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">不能退回：{preview.reason ?? '—'}</div>
            )}
            <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-200">
              <li>範圍：{scopeText(preview.adoption)}（範圍外、待排區、已完成完全不動）</li>
              <li>會做的變更：<b className="text-violet-200">{countsText(preview.counts)}</b></li>
              <li>退回前會再自動存一版「還原前備份」，萬一退錯還能再還原回來。</li>
            </ul>
            {preview.changedAfter.length > 0 && (
              <CardList title={`採用後又被改過的卡（${preview.changedAfter.length}）：這些調整也會一起被倒回`} tone="warn" items={preview.changedAfter} lines={lines} />
            )}
            {preview.addedAfter.length > 0 && (
              <CardList title={`採用後才新排進這個範圍的卡（${preview.addedAfter.length}）：會移回待排池`} tone="warn" items={preview.addedAfter} lines={lines} />
            )}
            {(postConflicts ?? preview.outsideConflicts).length > 0 && (
              <div className="rounded border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs leading-relaxed text-rose-100">
                <b>範圍外的線上有 {(postConflicts ?? preview.outsideConflicts).length} 項在採用後被改過，而且同一品項在範圍內也要還原：</b>
                只倒回範圍內會讓卡片消失或重複。請先在正式區把這些卡搬回原本的線，或改用「版本」面板整張還原。
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-rose-200/90">
                  {(postConflicts ?? preview.outsideConflicts).map((c, i) => (
                    <li key={`${c.soLineKey}:${i}`}><span className="font-mono text-sky-300">{c.soLineKey}</span>：{c.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {preview.unrestorable.length > 0 && (
              <details className="rounded border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs">
                <summary className="cursor-pointer text-slate-300">無法還原的卡（已完成、已銷貨、已不在待排池…）（{preview.unrestorable.length}）</summary>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-slate-400">
                  {preview.unrestorable.map((s, i) => <li key={`${s.soLineKey}:${i}`}><span className="font-mono text-sky-300">{s.soLineKey}</span>：{s.message}</li>)}
                </ul>
              </details>
            )}
            {!editable && <div className="text-xs text-slate-400">目前是唯讀：要退回請先關閉視窗，按工作台上方的「開始編輯」。</div>}
            {previewErr && (
              <div className="rounded border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                {previewErr}
                {partial != null && <div className="mt-1">正式排程可能只寫入了一部分：請按「版本」從 <b>版本 #{partial}</b> 還原。</div>}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}

function CardList({ title, items, lines, tone }: {
  title: string
  items: { placementId: string; soLineKey: string; planDate: string | null; lineId: number | null; qty: number }[]
  lines: PackagingLine[]
  tone: 'warn' | 'default'
}) {
  return (
    <details open className={`rounded border px-3 py-2 text-xs ${tone === 'warn' ? 'border-amber-700/60 bg-amber-950/20' : 'border-slate-700 bg-slate-950/40'}`}>
      <summary className={`cursor-pointer ${tone === 'warn' ? 'text-amber-200' : 'text-slate-300'}`}>{title}</summary>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-slate-300">
        {items.map(c => (
          <li key={c.placementId}>
            <span className="font-mono text-sky-300">{c.soLineKey}</span>
            <span className="text-slate-400">　{c.planDate ? md(c.planDate) : '待排區'} {c.lineId != null ? lineNameOf(lines, c.lineId) : ''}・{fmtQty(c.qty)}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
