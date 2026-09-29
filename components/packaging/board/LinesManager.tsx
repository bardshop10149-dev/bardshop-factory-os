'use client'

// 分線輪 D67／D71：線別管理（新增、改名、停用／啟用、排序）。
// - 預設由 CapacityEditor 的「線別管理」按鈕開啟；(a) 若要從工具列開，照同一組 props 即可。
// - 線不能刪、只能停用（歷史擺放與產能列都指向它）；停用前該線不能有「未完成、已排進日期」的卡
//   （伺服器回 line_has_cards＋張數：停用後自動搬卡會悄悄改掉主管的安排，所以擋下讓主管自己移）。
// - 不能停用最後一條啟用中的線；上限：含停用共 MAX_LINES 條、同時啟用 MAX_ACTIVE_LINES 條（伺服器擋，這裡先提示）。
// - 代碼（A、B、C…）建立後不改：新增時由伺服器自動取下一個沒用過的字母；改名只改顯示名稱。
// - 排序：↑↓ 對調後把整份清單重新編號（10、20、30…），只 PATCH 值有變的線；線最多 12 條，逐筆送也很快。
// 線別修改是設定，不進 Undo（同產能）。寫入要持有編輯鎖（D53），全部經 /api/packaging/lines。

import { useCallback, useEffect, useState } from 'react'
import { LINE_NAME_MAX, MAX_ACTIVE_LINES, MAX_LINES, type LineMutationResponse, type PackagingLine } from '@/lib/packaging/scheduleTypes'
import { nextLineCode, validateLineName } from '@/lib/packaging/scheduleLines'
import Modal, { Btn } from './Modal'
import { createLine, fetchLines, patchLine, type ApiResult } from './boardApi'

const byOrder = (a: PackagingLine, b: PackagingLine) => a.sortOrder - b.sortOrder || a.id - b.id

/** 寫入失敗 → 中文說明（伺服器的 error 已是中文，這裡只補鎖相關的統一說法） */
function mutationError(r: ApiResult<LineMutationResponse>): string {
  const j = r.json && !r.json.success ? r.json : null
  if (j?.code === 'lock_required' || j?.code === 'lock_lost') return '編輯權已失效，請重新取得編輯權後再修改'
  return j?.error || r.error || '儲存失敗'
}

export default function LinesManager({ editable, getLockToken, onClose, onChanged }: {
  /** 持有編輯鎖 */
  editable: boolean
  getLockToken: () => string | null
  onClose: () => void
  /** 新增／改名／停用／啟用／排序成功（父層據此重新載入產能表與工作台） */
  onChanged: () => void
}) {
  const [lines, setLines] = useState<PackagingLine[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  /** 改名中的線 */
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)

  const load = useCallback(async () => {
    setLoadErr(null)
    const r = await fetchLines()
    if (!r.json || !r.json.success) { setLoadErr(r.error ?? '讀取線別失敗'); return }
    setLines([...r.json.lines].sort(byOrder))
  }, [])

  useEffect(() => { void load() }, [load])

  const token = (): string | null => {
    const t = getLockToken()
    if (!t) setError('需要先取得編輯權（開始編輯）')
    return t
  }

  /** 送一個寫入；成功回 true 並更新清單 */
  const run = async (fn: (lockToken: string) => Promise<ApiResult<LineMutationResponse>>, okMsg: string): Promise<boolean> => {
    const t = token()
    if (!t) return false
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const r = await fn(t)
      if (r.json?.success) {
        setLines([...r.json.lines].sort(byOrder))
        setInfo(okMsg)
        onChanged()
        return true
      }
      setError(mutationError(r))
      // 可能是別人剛改過：重新讀一次，畫面才不會停在舊狀態
      if (r.json && !r.json.success && (r.json.code === 'not_found' || r.json.code === 'code_exists')) void load()
      return false
    } finally {
      setBusy(false)
    }
  }

  const list = lines ?? []
  const activeCount = list.filter(l => l.active).length
  const nameErr = newName.trim() === '' ? null : validateLineName(newName)
  const nextCode = nextLineCode(list)
  const canAdd = editable && !busy && newName.trim() !== '' && !nameErr && list.length < MAX_LINES && activeCount < MAX_ACTIVE_LINES

  const add = async () => {
    if (!canAdd) return
    const name = newName.trim()
    const ok = await run(t => createLine({ lockToken: t, name }), `已新增「${name}」`)
    if (ok) setNewName('')
  }

  const rename = async () => {
    if (!editing) return
    const err = validateLineName(editing.name)
    if (err) { setError(err); return }
    const name = editing.name.trim()
    const ok = await run(t => patchLine({ lockToken: t, id: editing.id, name }), `已改名為「${name}」`)
    if (ok) setEditing(null)
  }

  const toggleActive = (l: PackagingLine) => {
    void run(t => patchLine({ lockToken: t, id: l.id, active: !l.active }), l.active ? `已停用「${l.name}」` : `已啟用「${l.name}」`)
  }

  /** ↑↓：對調後整份重新編號，只送值有變的線 */
  const move = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (!lines || j < 0 || j >= lines.length) return
    const next = [...lines]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    const changes = next.map((l, i) => ({ l, so: (i + 1) * 10 })).filter(x => x.l.sortOrder !== x.so)
    for (const c of changes) {
      const ok = await run(t => patchLine({ lockToken: t, id: c.l.id, sortOrder: c.so }), '已調整順序')
      if (!ok) { void load(); return }
    }
  }

  return (
    <Modal
      title="線別管理"
      onClose={onClose}
      footer={<>
        {error && <span className="mr-auto text-xs text-rose-300">{error}</span>}
        {!error && info && <span className="mr-auto text-xs text-emerald-300">{info}</span>}
        {!error && !info && !editable && <span className="mr-auto text-xs text-slate-400">唯讀：取得編輯權後才能修改</span>}
        <Btn tone="primary" onClick={onClose}>完成</Btn>
      </>}
    >
      {loadErr ? (
        <div className="rounded border border-rose-800 bg-rose-950/30 p-3 text-xs text-rose-200">
          {loadErr}
          <button type="button" onClick={() => void load()} className="ml-2 underline">重試</button>
        </div>
      ) : !lines ? (
        <p className="py-6 text-center text-xs text-slate-400">讀取中…</p>
      ) : (
        <div className="space-y-3 text-xs">
          <p className="text-[11px] leading-relaxed text-slate-400">
            工作台的日檢視每條啟用中的線一欄，產能表每條線一組「正常／加班」。線不能刪除，只能停用（歷史紀錄保留）；
            停用前請先把那條線上未完成的卡移到其他線。最多 {MAX_LINES} 條（含停用）、同時啟用 {MAX_ACTIVE_LINES} 條。
          </p>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {lines.map((l, i) => (
              <li key={l.id} className={`flex items-center gap-2 px-2 py-1.5 ${l.active ? '' : 'opacity-60'}`}>
                <span className="w-9 shrink-0 rounded bg-slate-800 py-0.5 text-center font-mono font-bold text-slate-200" title="代碼（建立後不改）">{l.code}</span>
                {editing?.id === l.id ? (
                  <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={e => { e.preventDefault(); void rename() }}>
                    <input
                      autoFocus
                      value={editing.name}
                      maxLength={LINE_NAME_MAX}
                      onChange={e => setEditing({ id: l.id, name: e.target.value })}
                      className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-950 px-1.5 py-0.5 text-slate-100"
                    />
                    <Btn type="submit" tone="primary" disabled={busy}>儲存</Btn>
                    <Btn onClick={() => setEditing(null)} disabled={busy}>取消</Btn>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-slate-100">
                      {l.name}
                      {!l.active && <span className="ml-1.5 rounded bg-slate-700 px-1 text-[10px] text-slate-300">已停用</span>}
                    </span>
                    {editable && (
                      <>
                        <button type="button" disabled={busy || i === 0} onClick={() => void move(i, -1)} aria-label={`${l.name}往上移`}
                          className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-300 hover:text-white disabled:opacity-30">↑</button>
                        <button type="button" disabled={busy || i === lines.length - 1} onClick={() => void move(i, 1)} aria-label={`${l.name}往下移`}
                          className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-300 hover:text-white disabled:opacity-30">↓</button>
                        <button type="button" disabled={busy} onClick={() => { setError(null); setEditing({ id: l.id, name: l.name }) }}
                          className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-300 hover:text-white disabled:opacity-30">改名</button>
                        <button
                          type="button"
                          disabled={busy || (l.active && activeCount <= 1) || (!l.active && activeCount >= MAX_ACTIVE_LINES)}
                          title={l.active && activeCount <= 1 ? '至少要保留一條啟用中的線'
                            : !l.active && activeCount >= MAX_ACTIVE_LINES ? `同時啟用最多 ${MAX_ACTIVE_LINES} 條線`
                            : l.active ? '停用後不出現在工作台與產能表（歷史保留）；該線還有未完成的卡時不能停用' : '重新啟用（原本填的產能照舊生效）'}
                          onClick={() => toggleActive(l)}
                          className={`rounded border px-1.5 py-0.5 disabled:opacity-30 ${l.active ? 'border-rose-800 text-rose-300 hover:bg-rose-950/50' : 'border-emerald-700 text-emerald-300 hover:bg-emerald-950/50'}`}
                        >{l.active ? '停用' : '啟用'}</button>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>

          {editable && (
            <form className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/70 p-2" onSubmit={e => { e.preventDefault(); void add() }}>
              <span className="font-semibold text-slate-200">新增一條線</span>
              <input
                value={newName}
                maxLength={LINE_NAME_MAX}
                onChange={e => setNewName(e.target.value)}
                placeholder={nextCode ? `例：${nextCode} 線` : '線名'}
                className="w-40 rounded border border-slate-600 bg-slate-950 px-1.5 py-0.5 text-slate-100 placeholder:text-slate-500"
              />
              <Btn type="submit" tone="primary" disabled={!canAdd}>{busy ? '處理中…' : '新增'}</Btn>
              <span className="text-[11px] text-slate-500">
                {list.length >= MAX_LINES ? `已達上限 ${MAX_LINES} 條`
                  : activeCount >= MAX_ACTIVE_LINES ? `啟用中已達 ${MAX_ACTIVE_LINES} 條，請先停用一條`
                  : nameErr ?? (nextCode ? `代碼自動為 ${nextCode}` : '英文代碼已用完')}
              </span>
            </form>
          )}
        </div>
      )}
    </Modal>
  )
}
