'use client'

// AI 執行的進度與結果（規格 §八 AiRunPanel；§4.1 輪詢、§五 驗算報告、D94 加班、D80 規則建議、D95 失敗原因）。
//
// 執行中：文字進度條＋三個階段（準備資料 → AI 思考中 → 程式驗算）＋經過秒數。
//   AI 思考沒有真正的百分比可讀，進度是「依階段與經過時間」估的（simText.runProgressPct），只讓主管知道還在動、大概多久。
// 完成：AI 摘要（原文，客戶／卡代號伺服器已換回）→ 系統修正（驗算丟掉／修正了什麼）→ 風險 → 加班建議 → 規則建議 →
//   未排入 → 工時未知 → 未設門檻品類。每張 AI 卡的理由另外在卡片詳情看（aiReason）。
// 失敗：伺服器寫的原因（error_message，給主管看得懂）；模擬區保持原樣（D95）。
// 結果沒寫回模擬區（applied=false：AI 跑的期間主管動過模擬區）→ 提示可從這裡載入這次結果。

import type { ReactNode } from 'react'
import type { AiRunDetail, AiRunStatusInfo, RunPhase, ValidationReport } from '@/lib/packaging/ai/types'
import type { PackagingLine, YMD } from '@/lib/packaging/scheduleTypes'
import { fmtQty } from '@/components/packaging/poolStyles'
import { Btn } from '@/components/packaging/board/Modal'
import { clock, md, mdw } from '@/components/packaging/board/boardFormat'
import Drawer from './Drawer'
import {
  ISSUE_LABEL,
  MODE_LABEL,
  RUN_ERROR_LABEL,
  RUN_EXPECTED_SEC,
  RUN_STATUS_LABEL,
  RUN_STEPS,
  durationText,
  horizonLabel,
  hoursOf,
  runProgressPct,
  textBar,
} from './simText'

/** 經過毫秒：伺服器給的 elapsedMs 與「現在 − 開始」取大者（輪詢間隔 3 秒內也要一秒一秒往前走） */
export function runElapsedMs(r: { startedAt: string; elapsedMs: number }, nowMs: number, serverOffsetMs: number): number {
  const start = Date.parse(r.startedAt)
  const local = Number.isFinite(start) ? nowMs + serverOffsetMs - start : 0
  return Math.max(r.elapsedMs, local, 0)
}

/** 執行中的進度（工具列下方的橫幅與面板共用） */
export function RunProgress({ phase, elapsedMs, compact = false }: { phase: RunPhase; elapsedMs: number; compact?: boolean }) {
  const pct = runProgressPct(phase, elapsedMs)
  const at = RUN_STEPS.findIndex(s => s.phase === phase)
  const long = elapsedMs / 1000 > RUN_EXPECTED_SEC.max
  return (
    <div className={compact ? 'min-w-0 space-y-0.5' : 'space-y-2'}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]" aria-label="AI 執行階段">
        {RUN_STEPS.map((s, i) => (
          <span key={s.phase} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-slate-600">→</span>}
            <span className={
              i < at ? 'text-emerald-300' : i === at ? 'animate-pulse font-bold text-violet-200' : 'text-slate-500'
            }>{i < at ? '✓ ' : ''}{s.label}</span>
          </span>
        ))}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="AI 排程進度（依階段與經過時間估計）"
        className={`truncate font-mono tabular-nums text-violet-200 ${compact ? 'text-[11px]' : 'text-sm'}`}
      >{textBar(pct, compact ? 16 : 24)}</div>
      <div className="text-[11px] text-slate-400">
        已經過 {durationText(elapsedMs)}（通常 {RUN_EXPECTED_SEC.min / 60}～{RUN_EXPECTED_SEC.max / 60} 分鐘）
        {long && <span className="text-amber-300">・比平常久，仍在等 AI 回覆（約 4.5 分鐘會自動逾時並顯示原因；超過 6 分鐘仍沒結束代表背景執行可能已中斷，可以重新執行）</span>}
        {!compact && <span className="block text-slate-500">可以先離開這一頁，結果會存起來；回來後在「歷史」或「AI 結果」查看。</span>}
      </div>
    </div>
  )
}

function Section({ title, count, children, tone = 'default' }: { title: string; count?: number; children: ReactNode; tone?: 'default' | 'warn' | 'info' }) {
  const head = tone === 'warn' ? 'text-amber-200' : tone === 'info' ? 'text-sky-200' : 'text-slate-200'
  return (
    <section className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <h3 className={`text-xs font-bold ${head}`}>{title}{count != null && <span className="ml-1 font-normal text-slate-400">（{count}）</span>}</h3>
      <div className="space-y-1 text-xs leading-relaxed text-slate-300">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-slate-500">{children}</p>
}

function Key({ k }: { k: string | null }) {
  return k ? <span className="font-mono text-sky-300">{k}</span> : <span className="text-slate-500">（整體）</span>
}

function ValidationSections({ v, lineName }: { v: ValidationReport; lineName: (code: string) => string }) {
  const fixes = v.adjusted.length + v.dropped.length + v.capacityTrimmed.length
  return (
    <>
      <Section title="系統修正（程式驗算）" count={fixes}>
        <p>
          AI 給的排法原樣接受 <b className="text-slate-100">{v.accepted}</b> 筆
          {v.keptCopy > 0 && <>、沿用原本位置 <b className="text-slate-100">{v.keptCopy}</b> 筆</>}
          {v.lockedKept > 0 && <>、鎖定原樣保留 <b className="text-slate-100">{v.lockedKept}</b> 張</>}
          ；結果模擬區共 <b className="text-slate-100">{v.resultCount}</b> 張。
        </p>
        {fixes === 0 && <Empty>沒有需要修正的地方。</Empty>}
        {v.adjusted.length > 0 && (
          <div>
            <div className="font-semibold text-slate-200">修正後採用（{v.adjusted.length}）</div>
            <ul className="list-disc space-y-0.5 pl-5">
              {v.adjusted.map((a, i) => (
                <li key={`a${i}`}>
                  <Key k={a.soLineKey} />：{ISSUE_LABEL[a.code]}
                  <span className="text-slate-400">（{md(a.from.date)} {lineName(a.from.line)} {fmtQty(a.from.qty)} → {md(a.to.date)} {lineName(a.to.line)} {fmtQty(a.to.qty)}）</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {v.dropped.length > 0 && (
          <div>
            <div className="font-semibold text-slate-200">沒採用（{v.dropped.length}）</div>
            <ul className="list-disc space-y-0.5 pl-5">
              {v.dropped.map((d, i) => (
                <li key={`d${i}`}>
                  <Key k={d.soLineKey} />：{ISSUE_LABEL[d.code]}
                  <span className="text-slate-400">（第 {d.day} 天 {lineName(d.line)} {fmtQty(d.qty)}{d.message ? `；${d.message}` : ''}）</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {v.capacityTrimmed.length > 0 && (
          <div>
            <div className="font-semibold text-slate-200">超過產能上限、退回待排池（{v.capacityTrimmed.length}）</div>
            <ul className="list-disc space-y-0.5 pl-5">
              {v.capacityTrimmed.map((t, i) => (
                <li key={`t${i}`}><Key k={t.soLineKey} />：{mdw(t.date)} {lineName(t.line)} 減 {fmtQty(t.qty)}（{hoursOf(t.minutes)} h）</li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="風險提醒" count={v.aiWarnings.length} tone="warn">
        {v.aiWarnings.length === 0 ? <Empty>AI 沒有特別提醒。</Empty> : (
          <ul className="list-disc space-y-0.5 pl-5">
            {v.aiWarnings.map((w, i) => <li key={`w${i}`}><Key k={w.soLineKey} />：{w.message}</li>)}
          </ul>
        )}
      </Section>

      <Section title="加班建議（D94：以不加班為主，只顯示、不會自動改產能表）" count={v.aiOvertime.length + v.overtimeUsed.length}>
        {v.overtimeUsed.length > 0 && (
          <div>
            <div className="font-semibold text-slate-200">這個結果已用到產能表上組長填的加班額度</div>
            <ul className="list-disc space-y-0.5 pl-5">
              {v.overtimeUsed.map((o, i) => <li key={`o${i}`}>{mdw(o.date)} {lineName(o.line)}：{hoursOf(o.minutes)} h</li>)}
            </ul>
          </div>
        )}
        {v.aiOvertime.length > 0 && (
          <div>
            <div className="font-semibold text-slate-200">AI 建議另外加班</div>
            <ul className="list-disc space-y-0.5 pl-5">
              {v.aiOvertime.map((o, i) => (
                <li key={`ao${i}`}>{o.date ? mdw(o.date) : `第 ${o.day} 天`} {lineName(o.line)} {o.hours} 小時：{o.reason}</li>
              ))}
            </ul>
          </div>
        )}
        {v.aiOvertime.length + v.overtimeUsed.length === 0 && <Empty>不需要加班。</Empty>}
      </Section>

      <Section title="規則修改建議（D80：AI 只提出，不會自己改；要採納請到「規則與門檻」修改）" count={v.ruleSuggestions.length} tone="info">
        {v.ruleSuggestions.length === 0 ? <Empty>沒有建議。</Empty> : (
          <ul className="list-disc space-y-0.5 pl-5">{v.ruleSuggestions.map((s, i) => <li key={`r${i}`}>{s}</li>)}</ul>
        )}
      </Section>

      <Section title="未排入（重要但排不下的卡）" count={v.aiUnplaced.length} tone="warn">
        {v.aiUnplaced.length === 0 ? <Empty>沒有。</Empty> : (
          <ul className="list-disc space-y-0.5 pl-5">{v.aiUnplaced.map((u, i) => <li key={`u${i}`}><Key k={u.soLineKey} />：{u.reason}</li>)}</ul>
        )}
      </Section>

      <Section title="工時未知（沒有交給 AI，請手動排）" count={v.unknownMinutes.count}>
        {v.unknownMinutes.count === 0 ? <Empty>沒有。</Empty> : (
          <p>
            {v.unknownMinutes.count} 張：
            {v.unknownMinutes.categories.map(c => `${c.cat} ${c.count} 張`).join('、')}
            <span className="text-slate-500">（多半是委外品，途程沒有工時；可在待排池找到後手動拖進模擬區）</span>
          </p>
        )}
      </Section>

      <Section title="未設大量門檻的品類（不判大量，請到「規則與門檻」補）" count={v.noThresholdCategories.length}>
        {v.noThresholdCategories.length === 0 ? <Empty>都有門檻。</Empty> : <p>{v.noThresholdCategories.join('、')}</p>}
      </Section>

      {v.notSent > 0 && (
        <Section title="沒有送給 AI 的卡" tone="warn">
          <p>候選卡超過上限，依「逾期 → 交期近」取前面的送出，另有 <b>{v.notSent}</b> 張沒送（仍在待排池，可手動排）。</p>
        </Section>
      )}
    </>
  )
}

export default function AiRunPanel({
  run, running, loading, error, nowMs, serverOffsetMs, lines, currentWindow, isOwner, busy, onClose, onLoad,
}: {
  /** 詳情（輪詢中＝進度；結束＝結果）；還沒讀到 null */
  run: AiRunDetail | null
  /** 模擬區上的執行中資訊（詳情還沒讀到時先顯示進度） */
  running: AiRunStatusInfo | null
  loading: boolean
  error: string | null
  nowMs: number
  serverOffsetMs: number
  lines: PackagingLine[]
  /** 目前模擬區的範圍（判斷能不能載入） */
  currentWindow: YMD[] | null
  isOwner: boolean
  busy: boolean
  onClose: () => void
  onLoad: (runId: number, which: 'result' | 'base') => void
}) {
  const lineName = (code: string) => lines.find(l => l.code === code)?.name ?? `${code} 線`
  // 逾時（stale）的 run 不顯示進度條：背景執行多半已中斷，進度不會再動
  const staleSrc = run ? (run.status === 'running' && run.stale ? run : null) : (running?.status === 'running' && running.stale ? running : null)
  const showRunning = !staleSrc && (run ? run.status === 'running' : running?.status === 'running')
  const progressSrc = run && run.status === 'running' ? run : running
  const v = run?.validation ?? null
  const canLoad = !!run && run.status === 'done' && run.canLoad && isOwner && !busy
  const loadHint = !run || run.status !== 'done' ? null
    : !isOwner ? '別人的模擬區只能檢視'
      : !run.canLoad ? (currentWindow ? '這次的範圍與目前模擬區不同（先重設成同樣範圍才能載入）' : '目前沒有模擬區')
        : null

  return (
    <Drawer
      title={run ? `AI 排程結果 #${run.id}` : 'AI 排程'}
      label="AI 排程結果"
      wide
      onClose={onClose}
      footer={run && run.status === 'done' ? (
        <>
          {loadHint && <span className="mr-auto text-[11px] text-slate-500">{loadHint}</span>}
          <Btn disabled={!canLoad} onClick={() => onLoad(run.id, 'base')} title="回到這次 AI 執行之前的模擬區（會先存進退回上一步）">載入 AI 前的狀態</Btn>
          <Btn tone="primary" disabled={!canLoad} onClick={() => onLoad(run.id, 'result')} title="把這次的結果放進模擬區（會先存進退回上一步）">載入這次結果</Btn>
        </>
      ) : undefined}
    >
      <div className="space-y-3">
        {error && <div className="rounded border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
        {loading && !run && <p className="py-6 text-center text-xs text-slate-400">讀取中…</p>}

        {showRunning && progressSrc && (
          <div className="rounded-lg border border-violet-700/60 bg-violet-950/30 px-3 py-3">
            <div className="mb-2 text-sm font-bold text-violet-100">AI 正在排程…</div>
            <RunProgress phase={progressSrc.phase} elapsedMs={runElapsedMs(progressSrc, nowMs, serverOffsetMs)} />
          </div>
        )}

        {staleSrc && (
          <div className="rounded-lg border border-amber-600/70 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
            <div className="font-bold">這次 AI 排程超過 6 分鐘沒有結束，背景執行可能已中斷</div>
            <div className="mt-1 text-xs leading-relaxed">
              已經過 {durationText(runElapsedMs(staleSrc, nowMs, serverOffsetMs))}。模擬區沒有被改動；可以關閉這裡、再按工具列的「AI 排程」重新執行（這一次會被標成失敗）。
            </div>
          </div>
        )}

        {!run && !showRunning && !staleSrc && !loading && !error && (
          <p className="py-6 text-center text-xs text-slate-400">還沒有 AI 排程紀錄。按工具列的「AI 排程」開始。</p>
        )}

        {run && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span className={`rounded border px-1.5 py-px text-[10px] font-semibold ${
              run.status === 'done' ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
                : run.status === 'failed' ? 'border-rose-700 bg-rose-950/50 text-rose-200'
                  : 'border-violet-700 bg-violet-950/50 text-violet-200'
            }`}>{RUN_STATUS_LABEL[run.status]}</span>
            <span>{run.ownerName ?? run.ownerEmail}・{clock(run.startedAt, nowMs)} 開始</span>
            {run.status !== 'running' && <span>耗時 {durationText(run.durationMs ?? run.elapsedMs)}</span>}
            <span>{horizonLabel(run.horizon)}・{MODE_LABEL[run.mode]}</span>
            {run.windowDates.length > 0 && <span>{md(run.windowDates[0])}～{md(run.windowDates[run.windowDates.length - 1])}</span>}
            {run.rulesId != null && <span>規則第 #{run.rulesId} 版</span>}
          </div>
        )}

        {run?.status === 'failed' && (
          <div className="rounded-lg border border-rose-700 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
            <div className="font-bold">AI 排程失敗，模擬區保持原樣</div>
            <div className="mt-1 text-xs leading-relaxed">
              {run.errorMessage || (run.errorCode ? RUN_ERROR_LABEL[run.errorCode] : '原因不明')}
            </div>
          </div>
        )}

        {run?.status === 'done' && (
          <>
            {v && !v.applied && (
              <div className="rounded-lg border border-amber-600/70 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-100">
                <b>這次結果沒有自動放進模擬區</b>：AI 執行期間模擬區被改過（你手動調整過，或在別的分頁操作）。
                如果要用這次結果，按下方「載入這次結果」（目前的模擬區會先存進「退回上一步」）。
              </div>
            )}
            {v?.applied && (
              <div className="rounded-lg border border-emerald-700/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-100">
                結果已放進模擬區。不滿意可以直接在模擬區調整，或按工具列「退回上一步」回到 AI 前。
              </div>
            )}
            <Section title="AI 摘要">
              {run.summary
                ? <p className="whitespace-pre-wrap break-words text-slate-200">{run.summary}</p>
                : <Empty>AI 沒有寫摘要。</Empty>}
            </Section>
            {v ? <ValidationSections v={v} lineName={lineName} /> : <Empty>沒有驗算報告。</Empty>}
            {(run.model || run.usage) && (
              <p className="text-[10px] text-slate-500">
                {run.model && <>模型 {run.model}</>}
                {run.usage && <>・輸入 {run.usage.inputTokens.toLocaleString()}（快取 {run.usage.cacheReadInputTokens.toLocaleString()}）・輸出 {run.usage.outputTokens.toLocaleString()} tokens</>}
              </p>
            )}
          </>
        )}
      </div>
    </Drawer>
  )
}
