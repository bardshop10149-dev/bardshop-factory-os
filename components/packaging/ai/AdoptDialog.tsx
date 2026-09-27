'use client'

// 「採用此版排程」確認（規格 §6.1；D82／D86／D87／D90）。
//
// 流程：打開 → GET 預覽（範圍、會新增／移動／移回待排池幾張、會略過哪些）→ 按「採用」
//   → 取得正式區編輯鎖（D53：寫正式排程一律要鎖；模擬區本身不用鎖）→ POST 採用 → 顯示結果 → 釋放鎖。
// 編輯鎖沿用正式工作台的 useEditLock（同一套 acquire／takeover API）。這個 hook 掛在本對話框：
//   對話框關掉（元件卸載）時它會自動釋放鎖，採用完不會一直佔住、讓別的主管只能「接手」。
// 同一個人在別的分頁持有鎖（例如正式工作台開著且按了「開始編輯」）：鎖是「每個分頁一把」（token 存 sessionStorage），
//   這裡會拿不到（held_by_other）。畫面把狀況講清楚：可以接手（那個分頁轉唯讀、尚未儲存的操作會遺失），
//   或先到那個分頁按「結束編輯」再回來。
// 不能採用的兩種情況要分開講（D95「訊息要讓主管看得懂」）：
//   - 範圍內真的一模一樣（沒有變更、也沒有略過）→「不需要採用」；
//   - 有變更但全部會被自動略過（卡已完成／已銷貨／不在待排池）→「這些變更都無法套用，正式排程不會被修改」＋展開略過清單。
//   - 鎖定線上的模擬內容與正式區不一致（lockedConflicts）→ 列出來、停用採用（伺服器也會擋 locked_line_diverged）。
// 伺服器採用前會先佔用模擬區（version + 1）：失敗（鎖的問題以外）時呼叫 onFailed 讓模擬區重新載入，並要求關閉重開——
//   重開會重新預覽，主管看到的永遠是這次會寫進去的內容（不在同一個視窗裡用新的 version 直接再送一次）。

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { AdoptPreviewResponse, AdoptResponse, LockedLineConflict } from '@/lib/packaging/ai/types'
import type { PackagingLine } from '@/lib/packaging/scheduleTypes'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import Modal, { Btn } from '@/components/packaging/board/Modal'
import { md } from '@/components/packaging/board/boardFormat'
import { useEditLock } from '@/components/packaging/board/useEditLock'
import { fetchAdoptPreview, postAdopt } from './simApi'
import { adoptPreviewFlags, countsText } from './simText'

type Preview = Extract<AdoptPreviewResponse, { success: true }>
type Adopted = Extract<AdoptResponse, { success: true }>

export default function AdoptDialog({ meEmail, lines, getVersion, isIdle, onClose, onAdopted, onFailed }: {
  meEmail: string
  lines: PackagingLine[]
  /** 最新確認過的模擬區 version */
  getVersion: () => number | null
  /** 模擬區的操作佇列是否已清空 */
  isIdle: () => boolean
  onClose: () => void
  onAdopted: (r: Adopted) => void
  /** 採用失敗（鎖的問題以外）：模擬區 version 可能已被佔用而改變 → 呼叫端重新載入模擬區 */
  onFailed?: () => void
}) {
  const lk = useEditLock({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [partial, setPartial] = useState<number | null>(null)
  const [lockProblem, setLockProblem] = useState(false)
  const [result, setResult] = useState<Adopted | null>(null)
  /** POST 回 locked_line_diverged 時伺服器列出的不一致（預覽之後才發生的變化） */
  const [postConflicts, setPostConflicts] = useState<LockedLineConflict[] | null>(null)
  /** 採用失敗（鎖以外）後：預覽已過時（模擬區可能已被佔用或被改過）→ 要關閉重開才能再採用 */
  const [mustReopen, setMustReopen] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchAdoptPreview().then(r => {
      if (!alive) return
      if (r.json && r.json.success) setPreview(r.json)
      else setPreviewErr(r.error ?? '無法預覽採用內容')
    })
    return () => { alive = false }
  }, [])

  const holder = lk.lock?.held && !lk.lock.isMine ? lk.lock : null
  const heldByMeElsewhere = !!holder && !!holder.holderEmail && holder.holderEmail.toLowerCase() === meEmail.toLowerCase()

  const doAdopt = async (how: 'acquire' | 'takeover') => {
    if (!isIdle()) { setErr('模擬區還有操作儲存中，請稍候再按'); return }
    const version = getVersion()
    if (version == null) { setErr('模擬區不存在，請重新整理'); return }
    setBusy(true)
    setErr(null)
    setPartial(null)
    setPostConflicts(null)
    let gotLock = lk.phase === 'mine'
    try {
      if (!gotLock) {
        gotLock = how === 'takeover' ? await lk.takeover() : await lk.acquire()
        if (!gotLock) { setLockProblem(true); return }
      }
      setLockProblem(false)
      const token = lk.getToken()
      if (!token) { setErr('沒有取得編輯權，請再試一次'); return }
      const r = await postAdopt({ lockToken: token, version })
      if (r.json && r.json.success) {
        setResult(r.json)
        onAdopted(r.json)
        return
      }
      const code = r.code
      if (code === 'lock_required' || code === 'lock_lost') {
        setErr(code === 'lock_lost' ? '編輯權剛被其他主管接手，這次沒有寫入。請再按一次「採用」。' : '編輯權已逾時，這次沒有寫入。請再按一次「採用」。')
      } else {
        if (code === 'version_conflict') {
          setErr('模擬區剛被改過（或這一版剛被採用過、AI 剛寫回），這次沒有寫入。請關閉後確認模擬區內容，再按一次採用。')
        } else if (code === 'locked_line_diverged') {
          setPostConflicts(r.json && !r.json.success ? r.json.conflicts ?? [] : [])
          setErr(r.error ?? '鎖定的線上有和正式排程不一致的卡，這次沒有寫入')
        } else if (r.json && !r.json.success && r.json.partial) {
          setPartial(r.json.versionId ?? null)
          setErr(r.error ?? '寫入到一半失敗')
        } else {
          setErr(r.error ?? '採用失敗')
        }
        // 伺服器可能已佔用模擬區（version + 1）或模擬區被改過 → 重新載入；這個視窗的預覽已過時，要關閉重開
        setMustReopen(true)
        onFailed?.()
      }
    } finally {
      setBusy(false)
      // 採用這個動作做完（成功或失敗）就放掉鎖：模擬頁不需要一直持有正式區的編輯權
      if (gotLock) void lk.release()
    }
  }

  const lockedNames = preview ? preview.scope.lockedLineIds.map(id => lineNameOf(lines, id)) : []
  const lineNames = preview ? preview.scope.lineIds.filter(id => !preview.scope.lockedLineIds.includes(id)).map(id => lineNameOf(lines, id)) : []
  const conflicts = postConflicts ?? preview?.lockedConflicts ?? []
  // identical＝範圍內一模一樣；allSkipped＝有變更但全部會被自動略過（採用也不會改到正式排程）；blocked＝採用鈕停用
  const { identical, allSkipped, blocked } = adoptPreviewFlags(preview, postConflicts)
  const dates = preview?.scope.windowDates ?? []

  return (
    <Modal
      title={result ? '已採用到正式排程' : '採用此版排程'}
      onClose={onClose}
      wide
      footer={result ? (
        <>
          <Link href="/packaging/schedule" className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700">到正式排程工作台看看</Link>
          <Btn tone="primary" onClick={onClose}>關閉（繼續留在模擬區）</Btn>
        </>
      ) : (
        <>
          <Btn onClick={onClose}>取消</Btn>
          {lockProblem && holder ? (
            <Btn tone="danger" disabled={busy || !preview || blocked || mustReopen} onClick={() => void doAdopt('takeover')}>
              {heldByMeElsewhere ? '接手我另一個分頁的編輯權並採用' : '接手編輯權並採用'}
            </Btn>
          ) : (
            <Btn tone="primary" disabled={busy || !preview || blocked || mustReopen} onClick={() => void doAdopt('acquire')}>
              {busy ? '處理中…' : '採用此版排程'}
            </Btn>
          )}
        </>
      )}
    >
      {result ? (
        <div className="space-y-2 text-sm">
          <p>{countsText(result.counts)}。</p>
          <p className="text-xs text-slate-300">
            採用前已自動存成版本 <b>#{result.versionId}</b>。要退回：到正式排程工作台按「AI 採用紀錄」→ 退回這次採用（只倒回這次的範圍）。
          </p>
          {result.skipped.length > 0 && <SkippedList items={result.skipped} title="自動略過的卡（系統事實，D86）" />}
          <p className="text-xs text-slate-400">模擬區保留原樣，可以繼續調整或再讓 AI 排一次。</p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          {previewErr && <div className="rounded border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{previewErr}</div>}
          {!preview && !previewErr && <p className="py-4 text-center text-xs text-slate-400">計算採用內容中…</p>}
          {preview && (
            <>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-200">
                <li>
                  範圍：<b>{dates.length > 0 ? `${md(dates[0])}～${md(dates[dates.length - 1])}` : '—'}</b>（{dates.length} 天）×
                  <b> {lineNames.join('、') || '（沒有可覆蓋的線）'}</b>
                  {lockedNames.length > 0 && <span className="text-slate-400">；鎖定的線（{lockedNames.join('、')}）完全不動</span>}
                </li>
                <li>正式排程在這個範圍內會<b>完全照模擬版</b>（D86，不合併、不擋衝突）；範圍外的日子、待排區、已完成的卡完全不動（D87）。</li>
                <li>
                  會做的變更：<b className="text-violet-200">{countsText(preview.counts)}</b>
                  {preview.counts.returned > 0 && <span className="text-slate-400">（模擬版沒有的卡會移回待排池）</span>}
                </li>
                <li>採用前會自動存版本「{preview.versionLabel}」；之後可在正式工作台「AI 採用紀錄」退回這次採用。</li>
              </ul>
              {identical && <div className="rounded border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-300">模擬版與正式排程在這個範圍內一模一樣，不需要採用。</div>}
              {allSkipped && (
                <div className="rounded border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-100">
                  範圍內的 <b>{preview.skipped.length}</b> 項變更都無法套用（卡片已完成、已銷貨或已不在待排池），採用也不會修改正式排程。
                  下方是略過的原因；要排這些卡請先在模擬區調整或重設模擬區。
                </div>
              )}
              {conflicts.length > 0 && <ConflictList items={conflicts} />}
              {preview.skipped.length > 0 && <SkippedList items={preview.skipped} title="會自動略過的卡（已完成、已銷貨、已不在待排池…，D86）" open={allSkipped} />}
            </>
          )}

          {lockProblem && (
            <div className="rounded-lg border border-amber-600/70 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-100">
              {holder ? (
                heldByMeElsewhere ? (
                  <>
                    <b>你自己在另一個分頁（例如正式排程工作台）正持有編輯權。</b>
                    編輯權是每個分頁各一把：可以按「接手」，那個分頁會轉為唯讀、<b>它尚未儲存的操作會遺失</b>；
                    或先到那個分頁按「結束編輯」，再回來按「採用此版排程」。
                  </>
                ) : (
                  <>
                    <b>{holder.holderName || holder.holderEmail || '其他主管'}</b> 正在編輯正式排程。
                    採用會寫入正式排程，需要編輯權；接手後對方會轉為唯讀，<b>對方尚未儲存的操作會遺失</b>。
                  </>
                )
              ) : (
                <>{lk.error ?? '取得編輯權失敗，請再試一次'}</>
              )}
            </div>
          )}
          {err && (
            <div className="rounded border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
              {err}
              {partial != null && (
                <div className="mt-1">正式排程可能只寫入了一部分：請到正式工作台按「版本」，從 <b>版本 #{partial}</b>（採用前自動存的）還原。</div>
              )}
              {mustReopen && <div className="mt-1 text-rose-200/80">要再採用，請關閉這個視窗後重新開啟（會重新計算預覽）。</div>}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function SkippedList({ items, title, open = false }: { items: { soLineKey: string; message: string }[]; title: string; open?: boolean }) {
  return (
    <details open={open} className="rounded border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs">
      <summary className="cursor-pointer text-slate-300">{title}（{items.length}）</summary>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-slate-400">
        {items.map((s, i) => <li key={`${s.soLineKey}:${i}`}><span className="font-mono text-sky-300">{s.soLineKey}</span>：{s.message}</li>)}
      </ul>
    </details>
  )
}

/** 鎖定線上與正式排程不一致、會讓採用結果和模擬區不同的項目（採用被擋下的原因） */
function ConflictList({ items }: { items: LockedLineConflict[] }) {
  return (
    <div className="rounded border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs leading-relaxed text-rose-100">
      <b>不能採用：鎖定的線上有 {items.length} 項和正式排程不一致。</b>
      採用只覆蓋未鎖定的線，照這樣採用會讓卡片消失或重複排。請解除這些線的鎖定（採用時以模擬版為準一起覆蓋），或重設模擬區後再採用。
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-rose-200/90">
        {items.map((c, i) => <li key={`${c.soLineKey}:${i}`}><span className="font-mono text-sky-300">{c.soLineKey}</span>：{c.message}</li>)}
      </ul>
    </div>
  )
}
