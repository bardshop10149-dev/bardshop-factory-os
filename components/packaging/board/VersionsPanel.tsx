'use client'

// D33 版本快照面板（右側抽屜）：清單、存成版本、還原（先預覽再確認）。
// 還原＝刪除目前所有「未完成」的擺放，寫入快照中的擺放；已勾完成的卡不受影響；還原前伺服器會自動備份一份。
// 唯讀模式只能看清單。

import { useCallback, useEffect, useState } from 'react'
import type { RestorePlan, VersionMeta, VersionSource } from '@/lib/packaging/scheduleTypes'
import Modal, { Btn } from './Modal'
import { clock, md } from './boardFormat'
import { createVersion, fetchVersions, postRestore, previewRestore } from './boardApi'

const SOURCE_BADGE: Record<VersionSource, { label: string; cls: string }> = {
  manual: { label: '手動', cls: 'border-sky-600/60 bg-sky-950/50 text-sky-200' },
  auto_before_ai: { label: 'AI 前', cls: 'border-violet-600/60 bg-violet-950/50 text-violet-200' },
  auto_after_ai: { label: 'AI 後', cls: 'border-violet-600/60 bg-violet-950/50 text-violet-200' },
  auto_before_restore: { label: '還原前備份', cls: 'border-amber-600/60 bg-amber-950/50 text-amber-200' },
}

function defaultLabel(nowMs: number): string {
  const f = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${f.format(new Date(nowMs)).replace(/\s+/g, ' ')} 手動存檔`
}

export default function VersionsPanel({ editable, getLockToken, nowMs, onClose, onRestored }: {
  editable: boolean
  getLockToken: () => string | null
  nowMs: number
  onClose: () => void
  /** 還原成功：呼叫端清空 Undo／Redo、重新載入 */
  onRestored: (msg: string) => void
}) {
  const [list, setList] = useState<VersionMeta[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [label, setLabel] = useState(() => defaultLabel(nowMs))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ version: VersionMeta; plan: RestorePlan } | null>(null)

  const load = useCallback(async () => {
    const r = await fetchVersions()
    if (r.json?.success) { setList(r.json.versions); setErr(null) }
    else setErr(r.error ?? '讀取版本清單失敗')
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    const token = getLockToken()
    const name = label.trim()
    if (!token || !name) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await createVersion(token, name.slice(0, 80))
      if (r.json?.success) {
        setMsg(`已存成版本 #${r.json.version.id}（${r.json.version.placementCount} 張卡）`)
        setLabel(defaultLabel(Date.now()))
        await load()
      } else setMsg(r.error ?? '存檔失敗')
    } finally { setBusy(false) }
  }

  const openPreview = async (v: VersionMeta) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await previewRestore(v.id)
      if (r.json?.success) setPreview({ version: r.json.version, plan: r.json.plan })
      else setMsg(r.error ?? '無法預覽還原')
    } finally { setBusy(false) }
  }

  const doRestore = async () => {
    if (!preview) return
    const token = getLockToken()
    if (!token) { setMsg('需要先取得編輯權'); return }
    setBusy(true)
    try {
      const r = await postRestore(preview.version.id, token)
      if (r.json?.success) {
        const m = `已還原到「${preview.version.label}」：移除 ${r.json.plan.removeCount} 張、寫入 ${r.json.plan.insertCount} 張；還原前備份為版本 #${r.json.backup.id}`
        setPreview(null)
        onRestored(m)
        await load()
      } else {
        setMsg(r.error ?? '還原失敗')
        setPreview(null)
      }
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="fixed inset-0 z-[55] bg-black/40" onPointerDown={onClose} />
      <aside className="fixed inset-y-0 right-0 z-[56] flex w-full max-w-md flex-col border-l border-slate-700 bg-slate-900 text-slate-200 shadow-2xl" aria-label="版本快照">
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="flex-1 text-base font-bold text-white">版本快照</h2>
          <button type="button" onClick={onClose} aria-label="關閉" className="rounded px-2 text-lg text-slate-400 hover:bg-slate-800 hover:text-white">×</button>
        </div>

        {editable && (
          <div className="space-y-2 border-b border-slate-800 px-4 py-3">
            <div className="flex gap-2">
              <input value={label} maxLength={80} onChange={e => setLabel(e.target.value)} aria-label="版本名稱"
                className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm" />
              <Btn tone="primary" disabled={busy || !label.trim()} onClick={() => void save()}>存成版本</Btn>
            </div>
            <p className="text-[11px] text-slate-500">只存「未完成」的擺放（完成是事實，不隨版本還原）；保留 90 天。</p>
          </div>
        )}
        {msg && <div className="border-b border-slate-800 px-4 py-2 text-xs text-sky-200">{msg}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {err ? (
            <div className="rounded border border-rose-800 bg-rose-950/30 p-3 text-xs text-rose-200">
              {err}
              <button type="button" onClick={() => void load()} className="ml-2 underline">重試</button>
            </div>
          ) : !list ? (
            <p className="py-6 text-center text-xs text-slate-400">讀取中…</p>
          ) : list.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">還沒有任何版本</p>
          ) : (
            <ul className="space-y-2">
              {list.map(v => (
                <li key={v.id} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-1.5 py-px text-[10px] ${SOURCE_BADGE[v.source].cls}`}>{SOURCE_BADGE[v.source].label}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold text-slate-100" title={v.label}>{v.label}</span>
                    <span className="text-[10px] text-slate-500">#{v.id}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
                    <span>{clock(v.createdAt, nowMs)}</span>
                    <span>{v.createdByName ?? v.createdBy}</span>
                    <span>{v.placementCount} 張</span>
                    <span className="text-slate-500">保留到 {md(v.expiresAt.slice(0, 10))}</span>
                    <span className="flex-1" />
                    {editable && (
                      <button type="button" disabled={busy} onClick={() => void openPreview(v)}
                        className="rounded border border-slate-600 px-2 py-0.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">還原…</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {preview && (
        <Modal
          title={`還原到「${preview.version.label}」？`}
          onClose={() => setPreview(null)}
          footer={<>
            <Btn onClick={() => setPreview(null)}>取消</Btn>
            <Btn tone="danger" disabled={busy} onClick={() => void doRestore()}>{busy ? '還原中…' : '確定還原'}</Btn>
          </>}
        >
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>將移除目前 <b>{preview.plan.removeCount}</b> 張未完成的卡，寫入 <b>{preview.plan.insertCount}</b> 張。</li>
            {preview.plan.pastDateCount > 0 && <li>其中 <b>{preview.plan.pastDateCount}</b> 張日期已過，會順延到今天並標「延誤」。</li>}
            {preview.plan.lineGoneCount > 0 && <li><b>{preview.plan.lineGoneCount}</b> 張的訂單已不在待排池（已完成或結案），會隱藏。</li>}
            {/* 分線輪（lines.md §4.7）：舊版快照沒有線別、或原線已停用 → 改放預設線（啟用中排第一的線） */}
            {(preview.plan.lineRemappedCount ?? 0) > 0 && <li><b>{preview.plan.lineRemappedCount}</b> 張會改放到預設線（排第一的啟用線）：原線已停用，或是分線前的舊版快照沒有線別。</li>}
            <li>已勾完成的卡不受影響。</li>
            <li>還原前會自動備份目前的排程（「還原前備份」），可以再還原回來。</li>
            <li className="text-orange-300">目前的復原（Undo）紀錄會清空。</li>
          </ul>
        </Modal>
      )}
    </>
  )
}
