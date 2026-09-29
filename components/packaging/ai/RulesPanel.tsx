'use client'

// 主管建議規則區（D91；規格 §七）：一份文字、統一一個輸入入口（可分段寫 A／B／C），每次儲存新增一版（留 LOG：誰、何時）。
// AI 每次執行讀最新版。儲存帶 baseId（編輯時看到的版本）：別人剛存過新版 → 伺服器回 rules_conflict，
// 你的文字留在框裡不會不見，看過最新版再決定要不要覆蓋（不需要編輯鎖，所以用這種「樂觀檢查」防互蓋）。
// 歷史：最近 50 版，可點開看全文、可「以此版為基礎編輯」（把舊版文字放回編輯框，存檔時仍是新增一版）。

import { useCallback, useEffect, useState } from 'react'
import { AI_RULES_MAX, type AiRulesMeta, type AiRulesVersion } from '@/lib/packaging/ai/types'
import { Btn } from '@/components/packaging/board/Modal'
import { clock } from '@/components/packaging/board/boardFormat'
import { fetchRules, fetchRulesVersion, saveRules } from './simApi'

export default function RulesPanel({ nowMs, onDirtyChange }: {
  nowMs: number
  /** 有未儲存的修改（抽屜關閉前提醒） */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [current, setCurrent] = useState<AiRulesVersion | null>(null)
  const [history, setHistory] = useState<AiRulesMeta[]>([])
  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState('')
  const [baseId, setBaseId] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [viewing, setViewing] = useState<AiRulesVersion | null>(null)

  const dirty = loaded && text !== (current?.body ?? '')
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  /** keepText：保留編輯框的內容（衝突後只更新「最新版」資訊） */
  const load = useCallback(async (keepText: boolean) => {
    const r = await fetchRules()
    if (r.json && r.json.success) {
      const cur = r.json.current
      setCurrent(cur)
      setHistory(r.json.history)
      setBaseId(cur?.id ?? null)
      if (!keepText) setText(cur?.body ?? '')
      setLoaded(true)
      setErr(null)
    } else {
      setErr(r.error ?? '讀取規則失敗')
    }
  }, [])
  useEffect(() => { void load(false) }, [load])

  const trimmedLen = text.trim().length
  const tooLong = text.length > AI_RULES_MAX
  const canSave = loaded && !busy && dirty && trimmedLen > 0 && !tooLong

  const save = async () => {
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      const r = await saveRules({ body: text, baseId })
      if (r.json && r.json.success) {
        setCurrent(r.json.current)
        setBaseId(r.json.current.id)
        setText(r.json.current.body)
        setConflict(false)
        setMsg(`已儲存為第 #${r.json.current.id} 版；下次 AI 排程會用這一版`)
        void load(true)
        return
      }
      if (r.code === 'rules_conflict') {
        setConflict(true)
        setErr('有人剛存過新版規則。你的文字還在框裡；請先看過最新版，再決定要不要以你的內容覆蓋。')
        return
      }
      setErr(r.error ?? '儲存失敗')
    } finally {
      setBusy(false)
    }
  }

  const openVersion = async (id: number) => {
    setBusy(true)
    try {
      const r = await fetchRulesVersion(id)
      if (r.json && r.json.success) setViewing(r.json.version)
      else setErr(r.error ?? '讀取該版失敗')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-slate-400">
        寫給 AI 的排程偏好（分線、衝突時怎麼放、交期、加班）。這是「偏好」不是硬規則：產能、鎖定、可包日由程式驗算，AI 違反會被退回。
        規則裡請不要寫客戶全名或電話（這段文字會原樣送給 AI）。
      </p>
      {err && (
        <div className="rounded border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
          {err}
          {conflict && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Btn onClick={() => { if (current) void openVersion(current.id) }}>看最新版</Btn>
              <Btn onClick={() => { void load(true).then(() => { setConflict(false); setErr(null); setMsg('已更新為最新版號；再按一次「儲存」會以你的內容存成新的一版') }) }}>保留我的內容，再存一次</Btn>
              <Btn tone="danger" onClick={() => { void load(false).then(() => { setConflict(false); setErr(null) }) }}>放棄我的修改，載入最新版</Btn>
            </div>
          )}
        </div>
      )}
      {msg && <div className="rounded border border-sky-800 bg-sky-950/30 px-3 py-2 text-xs text-sky-200">{msg}</div>}

      <div className="text-[11px] text-slate-400">
        {current
          ? <>目前規則：第 #{current.id} 版・{current.byName ?? current.by}・{clock(current.at, nowMs)}</>
          : loaded ? '目前還沒有規則（請先套用 migration 種子，或直接寫一版）' : '讀取中…'}
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={!loaded || busy}
        rows={14}
        aria-label="主管建議規則"
        className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100 focus:border-violet-500 focus:outline-none disabled:opacity-60"
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-[11px] tabular-nums ${tooLong ? 'text-rose-300' : 'text-slate-500'}`}>{text.length.toLocaleString()} / {AI_RULES_MAX.toLocaleString()} 字</span>
        {dirty && <span className="text-[11px] text-amber-300">有未儲存的修改</span>}
        <span className="flex-1" />
        <Btn disabled={!dirty || busy} onClick={() => { setText(current?.body ?? ''); setMsg(null) }}>還原成目前版本</Btn>
        <Btn tone="primary" disabled={!canSave} onClick={() => void save()}>{busy ? '處理中…' : '儲存（新增一版）'}</Btn>
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-bold text-slate-200">歷史版本（最近 {history.length} 版）</h3>
        {history.length === 0 ? (
          <p className="text-[11px] text-slate-500">沒有歷史。</p>
        ) : (
          <ul className="space-y-1">
            {history.map(h => (
              <li key={h.id} className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950/40 px-2 py-1 text-[11px]">
                <span className="font-mono text-slate-400">#{h.id}</span>
                <span className="min-w-0 flex-1 truncate text-slate-300">{h.byName ?? '—'}・{clock(h.at, nowMs)}・{h.length} 字</span>
                {current?.id === h.id && <span className="rounded bg-violet-800/70 px-1 text-[10px] text-violet-100">目前</span>}
                <button type="button" disabled={busy} onClick={() => void openVersion(h.id)}
                  className="rounded border border-slate-600 px-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">看全文</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {viewing && (
        <div className="rounded-lg border border-slate-600 bg-slate-950 p-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span className="font-semibold text-slate-200">第 #{viewing.id} 版</span>
            <span>{viewing.byName ?? viewing.by}・{clock(viewing.at, nowMs)}</span>
            <span className="flex-1" />
            <Btn onClick={() => { setText(viewing.body); setViewing(null); setMsg(`已把第 #${viewing.id} 版的內容放進編輯框；按「儲存」會存成新的一版`) }}>以此版為基礎編輯</Btn>
            <Btn onClick={() => setViewing(null)}>關閉</Btn>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-200">{viewing.body}</pre>
        </div>
      )}
    </div>
  )
}
