'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * 商品開發 —— 品項編碼審查（主管）
 *
 * 與申請頁 /product-dev/item-request 的分工：那邊是「填申請、看自己的進度」，
 * 這裡是「看所有人的待審、核准或退回」。處理動作集中在這一頁，不讓兩邊都能改。
 *
 * 設計重點是「主管不用自己去 ARGO 查」：打開一張單，系統已經把編碼重不重複、
 * 前綴對不對、單位在不在、有沒有長得很像的既有品項全查完攤在眼前。主管只做
 * 機器做不了的那件事——判斷這到底是不是該開的新品項。
 *
 * 🔴 硬擋沒過就不給核准；🟡 警示要勾「我已確認」才放行。刻意沒有「略過檢查」的
 * 後門——留了後門，久了就變成每次都按略過。
 */

interface RequestRow {
  id: number
  request_no: string
  status: 'pending' | 'approved' | 'created' | 'rejected' | 'failed'
  requester_email: string
  requester_name: string | null
  requested_at: string
  updated_at: string
  template_part: string | null
  part_name: string
  part_desc: string | null
  unit_of_measure: string
  product_category: string
  product_category_2: string
  source_type: string | null
  inventory_type: string | null
  cost_category: string | null
  leadtime_flag: string | null
  bom_warehouse_id: string | null
  lot_no_flag: string | null
  expense_flag: string | null
  level_code_inv: string | null
  account_no_inv: string | null
  safety_qty: number | null
  validdate: string | null
  suggested_part: string | null
  note: string
  reference_url: string | null
  assigned_part: string | null
  approved_part: string | null
  approved_by: string | null
  approved_by_name: string | null
  approved_by_emp_no: string | null
  approved_at: string | null
  handled_by: string | null
  handled_at: string | null
  reject_reason: string | null
}

interface Check {
  key: string
  label: string
  level: 'block' | 'warn' | 'ok'
  message: string
  detail?: unknown
}

interface LogRow {
  id: number
  action: string
  actor_email: string
  actor_name: string | null
  note: string | null
  created_at: string
}

interface Precheck {
  part: string
  canApprove: boolean
  needsConfirm: boolean
  counts: { block: number; warn: number; ok: number }
  checks: Check[]
}

const STATUS_META: Record<RequestRow['status'], { label: string; cls: string }> = {
  pending: { label: '待審', cls: 'bg-amber-900/50 text-amber-300 border-amber-700/60' },
  approved: { label: '已核准待建檔', cls: 'bg-sky-900/50 text-sky-300 border-sky-700/60' },
  created: { label: '已建檔', cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/60' },
  rejected: { label: '已退回', cls: 'bg-rose-900/50 text-rose-300 border-rose-700/60' },
  failed: { label: '建檔失敗', cls: 'bg-orange-900/50 text-orange-300 border-orange-700/60' },
}

const LOG_ACTION_META: Record<string, { label: string; cls: string }> = {
  submitted: { label: '送出申請', cls: 'bg-sky-900/50 text-sky-300 border-sky-700/60' },
  approved: { label: '核准建檔', cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/60' },
  created: { label: '完成建檔', cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/60' },
  create_failed: { label: '建檔失敗', cls: 'bg-orange-900/50 text-orange-300 border-orange-700/60' },
  rejected: { label: '退回', cls: 'bg-rose-900/50 text-rose-300 border-rose-700/60' },
  reopen: { label: '救回待審', cls: 'bg-amber-900/50 text-amber-300 border-amber-700/60' },
}

const LEVEL_META: Record<Check['level'], { icon: string; cls: string }> = {
  block: { icon: '🔴', cls: 'border-rose-700/50 bg-rose-950/30 text-rose-200' },
  warn: { icon: '🟡', cls: 'border-amber-700/50 bg-amber-950/30 text-amber-200' },
  ok: { icon: '🟢', cls: 'border-slate-700/50 bg-slate-800/30 text-slate-400' },
}

const fmtTime = (s: string | null) => {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export default function ItemApprovalPage() {
  const [rows, setRows] = useState<RequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'created' | 'rejected' | 'failed' | ''>('pending')
  const [openId, setOpenId] = useState<number | null>(null)
  const [me, setMe] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const qs = new URLSearchParams({ all: '1' })
      if (statusFilter) qs.set('status', statusFilter)
      const res = await fetch('/api/product-dev/item-request?' + qs.toString())
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `讀取失敗 (HTTP ${res.status})`)
      setRows(json.rows ?? [])
      setMe(String(json.me ?? ''))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { void load() }, [load])

  const counts = rows.length

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-300">← 回首頁</Link>
          <h1 className="text-xl font-bold text-white">品項編碼審查</h1>
          <span className="text-xs text-slate-500">核准後由建檔人員在 ARGO 建立，回填編碼結案</span>
          <Link
            href="/product-dev/item-request"
            className="ml-auto rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            我要申請新編碼 →
          </Link>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {([
            ['pending', '待審'], ['approved', '已核准待建檔'], ['failed', '建檔失敗'],
            ['created', '已建檔'], ['rejected', '已退回'], ['', '全部'],
          ] as const).map(([v, label]) => (
            <button
              key={v || 'all'}
              onClick={() => { setStatusFilter(v); setOpenId(null) }}
              className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                statusFilter === v
                  ? 'border-emerald-600 bg-emerald-700/30 text-emerald-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
          <button onClick={() => void load()} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            🔄 重新整理
          </button>
          <span className="text-xs text-slate-500">共 {counts} 張</span>
        </div>

        {loading && <div className="py-16 text-center text-sm text-slate-500">讀取中…</div>}
        {error && <div className="rounded-xl border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">⚠ {error}</div>}
        {!loading && !error && rows.length === 0 && (
          <div className="py-16 text-center text-sm text-slate-500">
            沒有符合條件的申請單
            {statusFilter === 'pending' && <div className="mt-1 text-xs text-slate-600">目前沒有待審的品項編碼申請</div>}
          </div>
        )}

        <div className="flex flex-col gap-3">
          {rows.map(row => (
            <ApprovalCard
              key={row.id}
              row={row}
              me={me}
              open={openId === row.id}
              onToggle={() => setOpenId(openId === row.id ? null : row.id)}
              onDone={() => { setOpenId(null); void load() }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function ApprovalCard({
  row, me, open, onToggle, onDone,
}: {
  row: RequestRow
  me: string
  open: boolean
  onToggle: () => void
  onDone: () => void
}) {
  const meta = STATUS_META[row.status]
  const [part, setPart] = useState(row.approved_part ?? row.suggested_part ?? '')
  const [pre, setPre] = useState<Precheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [reason, setReason] = useState(row.reject_reason ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null)
  const [payloadMeta, setPayloadMeta] = useState<{ fieldCount: number; categoryVerified: boolean; category: string } | null>(null)
  const [showPayload, setShowPayload] = useState(false)
  const [logs, setLogs] = useState<LogRow[] | null>(null)

  // 軌跡：展開才抓，處理完（row.updated_at 變動）自動重抓，失敗原因當場看得到
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/product-dev/item-request?logs=' + row.id)
      .then(r => r.json())
      .then(j => { if (!cancelled) setLogs(j.success ? (j.logs ?? []) : []) })
      .catch(() => { if (!cancelled) setLogs([]) })
    return () => { cancelled = true }
  }, [open, row.id, row.updated_at])

  // 預檢：展開時跑一次。編碼改了要重按「重新檢查」，不做即時查——
  // 每打一個字就打一次 ARGO，又慢又吵。
  const runPrecheck = useCallback(async (p: string) => {
    setChecking(true)
    setMsg('')
    try {
      const qs = new URLSearchParams({ id: String(row.id) })
      if (p.trim()) qs.set('part', p.trim())
      const res = await fetch('/api/product-dev/item-precheck?' + qs.toString())
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || '預檢失敗')
      setPre(json as Precheck)
      setConfirmed(false)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
      setPre(null)
    } finally {
      setChecking(false)
    }
  }, [row.id])

  useEffect(() => {
    if (open && !pre) void runPrecheck(part)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 乾跑：把要送給 ARGO 的完整欄位撈回來先看。寫進 ERP 的料件只能作廢不能刪，
  // 按下去之前多看一眼的成本遠低於建錯。
  const loadPayload = async () => {
    setBusy(true)
    setMsg('')
    try {
      const res = await fetch('/api/product-dev/item-request?payload=' + row.id)
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || '組不出 payload')
      setPayload(json.payload)
      setPayloadMeta({ fieldCount: json.fieldCount, categoryVerified: json.categoryVerified, category: json.category })
      setShowPayload(true)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const act = async (body: Record<string, unknown>) => {
    setBusy(true)
    setMsg('')
    try {
      const res = await fetch('/api/product-dev/item-request', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, ...body }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `失敗 (HTTP ${res.status})`)
      onDone()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const blocked = !pre || !pre.canApprove
  const needConfirm = !!pre?.needsConfirm && !confirmed
  const cell = (label: string, value: unknown) => (
    <div>
      <div className="text-[10px] text-slate-600">{label}</div>
      <div className="text-slate-300">{value === null || value === undefined || value === '' ? '—' : String(value)}</div>
    </div>
  )

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60">
      <button onClick={onToggle} className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left">
        <span className={`rounded border px-2 py-0.5 text-[11px] ${meta.cls}`}>{meta.label}</span>
        <span className="font-mono text-sm text-cyan-300">{row.request_no}</span>
        <span className="text-sm text-slate-200">{row.part_name}</span>
        <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
          {row.product_category} / {row.product_category_2}
        </span>
        {row.approved_part && (
          <span className="font-mono text-xs text-emerald-300">→ {row.approved_part}</span>
        )}
        <span className="ml-auto text-xs text-slate-500">
          {row.requester_name || row.requester_email}　{fmtTime(row.requested_at)}
        </span>
        <span className="text-xs text-slate-500">{open ? '收合' : '展開'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-800 px-5 py-4 text-xs">
          {/* 申請內容 */}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {cell('引用來源', row.template_part)}
            {cell('申請人建議編碼', row.suggested_part)}
            {cell('規格', row.part_desc)}
            {cell('單位', row.unit_of_measure)}
            {cell('來源型態', row.source_type)}
            {cell('庫存類型 🔒', row.inventory_type)}
            {cell('成本類別 🔒', row.cost_category)}
            {cell('費用類 🔒', row.expense_flag)}
            {cell('前置時間', row.leadtime_flag)}
            {cell('預設倉', row.bom_warehouse_id)}
            {cell('批號控管', row.lot_no_flag)}
            {cell('安全庫存', row.safety_qty)}
            {cell('生效日', row.validdate)}
            {cell('存貨科目 🔒', (row.level_code_inv || row.account_no_inv)
              ? `${row.level_code_inv ?? ''} / ${row.account_no_inv ?? ''}` : null)}
          </div>
          <div className="mb-4">
            <div className="text-[10px] text-slate-600">用途說明</div>
            <div className="whitespace-pre-wrap text-slate-300">{row.note}</div>
            {row.reference_url && <div className="mt-1 break-all text-slate-500">參考：{row.reference_url}</div>}
          </div>

          {/* 預檢結果 */}
          <div className="mb-4 border-t border-slate-800 pt-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-slate-600">系統預檢</span>
              {pre && (
                <span className="text-[10px] text-slate-500">
                  🔴 {pre.counts.block}　🟡 {pre.counts.warn}　🟢 {pre.counts.ok}
                </span>
              )}
              <button
                onClick={() => void runPrecheck(part)}
                disabled={checking}
                className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {checking ? '檢查中…' : '🔄 重新檢查'}
              </button>
            </div>

            {checking && <div className="py-3 text-slate-500">正在向 ARGO 查詢…</div>}
            {!checking && pre && (
              <div className="flex flex-col gap-1.5">
                {pre.checks.map(c => {
                  const lm = LEVEL_META[c.level]
                  return (
                    <div key={c.key} className={`rounded-lg border px-3 py-2 ${lm.cls}`}>
                      <div className="flex gap-2">
                        <span>{lm.icon}</span>
                        <div className="min-w-0">
                          <span className="font-medium">{c.label}</span>
                          <span className="ml-2 opacity-90">{c.message}</span>
                          {Array.isArray(c.detail) && c.detail.length > 0 && (
                            <div className="mt-1 space-y-0.5">
                              {(c.detail as Record<string, unknown>[]).map((d, i) => (
                                <div key={i} className="font-mono text-[10px] opacity-80">
                                  {'part' in d
                                    ? `${d.part}　${d.name ?? ''}　${d.desc ?? ''}`
                                    : `${d.field}: ${d.here || '—'}${'there' in d ? ` ↔ 來源 ${d.there || '—'}` : ''}${'preset' in d ? ` ↔ 預設 ${d.preset || '—'}` : ''}`}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 異動軌跡：寫入 ARGO 失敗的原因就記在這裡 */}
          <div className="mb-4 border-t border-slate-800 pt-3">
            <div className="mb-2 text-[10px] text-slate-600">異動軌跡</div>
            {logs === null ? (
              <div className="text-slate-600">讀取中…</div>
            ) : logs.length === 0 ? (
              <div className="text-slate-600">沒有軌跡紀錄</div>
            ) : (
              <ol className="space-y-1.5">
                {logs.map(lg => {
                  const m = LOG_ACTION_META[lg.action] ?? { label: lg.action, cls: 'bg-slate-800 text-slate-300 border-slate-700' }
                  return (
                    <li key={lg.id} className="flex gap-2">
                      <span className={`h-fit shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${m.cls}`}>{m.label}</span>
                      <div className="min-w-0">
                        <div className="text-slate-400">
                          {lg.actor_name || lg.actor_email}
                          <span className="ml-2 text-slate-600">{fmtTime(lg.created_at)}</span>
                        </div>
                        {lg.note && <div className="break-all text-slate-500">{lg.note}</div>}
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>

          {/* 處理動作 */}
          {row.status === 'pending' ? (
            <div className="border-t border-slate-800 pt-3">
              <div className="mb-2 flex flex-wrap items-end gap-2">
                <div>
                  <div className="mb-1 text-[10px] text-slate-600">核准的品項編碼（由你決定，申請人填的只是建議）</div>
                  <input
                    value={part}
                    onChange={e => setPart(e.target.value.toUpperCase())}
                    placeholder={row.suggested_part ?? '例：CACRXXX-001'}
                    className="w-56 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-xs text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <button
                  onClick={() => void runPrecheck(part)}
                  disabled={checking || !part.trim()}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                >
                  檢查這個編碼
                </button>
              </div>

              {me && row.requester_email === me && (
                <div className="mb-2 rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-amber-200">
                  ⚠ 這是你自己送出的申請。你有管理員權限所以可以核准，但軌跡會記下「自審」。
                </div>
              )}
              {pre?.needsConfirm && (
                <label className="mb-2 flex cursor-pointer items-center gap-2 text-amber-300">
                  <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="accent-amber-500" />
                  我已確認上面的 🟡 提醒（相似品項／帳務設定），這確實是需要新開的品項
                </label>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => act({ action: 'approved', approved_part: part })}
                  disabled={busy || blocked || needConfirm || !part.trim()}
                  title={blocked ? '有 🔴 項目未通過，不能核准' : needConfirm ? '請先勾選確認' : ''}
                  className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                >
                  ✅ 核准建檔
                </button>
                <input
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="退回原因"
                  className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-rose-500 focus:outline-none"
                />
                <button
                  onClick={() => act({ action: 'rejected', reject_reason: reason })}
                  disabled={busy || !reason.trim()}
                  className="rounded-lg border border-rose-700 px-4 py-1.5 text-xs text-rose-300 hover:bg-rose-900/40 disabled:opacity-40"
                >
                  退回
                </button>
              </div>
            </div>
          ) : (
            <div className="border-t border-slate-800 pt-3">
              {row.status === 'approved' && (
                <div className="mb-2 text-sky-300">
                  已由 {row.approved_by_name || row.approved_by}
                  （工號 {row.approved_by_emp_no || '未設定'}）於 {fmtTime(row.approved_at)} 核准，
                  編碼 <span className="font-mono">{row.approved_part}</span>。
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    請在 ARGO 建立後回填實際編碼結案（Phase 2 接上自動寫入後這一步會自動完成）
                  </div>
                </div>
              )}
              {row.status === 'failed' && (
                <div className="mb-2 text-orange-300">
                  上次寫入 ARGO 失敗，這張單仍維持已核准、沒有建檔。
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    失敗原因記在下方軌跡；修正後可按「重試寫入 ARGO」
                  </div>
                </div>
              )}
              {row.status === 'rejected' && row.reject_reason && (
                <div className="mb-2 text-rose-300">退回原因：{row.reject_reason}</div>
              )}
              {row.status === 'created' && (
                <div className="mb-2 text-emerald-300">
                  已建檔，編碼 <span className="font-mono">{row.assigned_part}</span>
                  <span className="ml-2 text-slate-500">{row.handled_by}　{fmtTime(row.handled_at)}</span>
                </div>
              )}

              {/* 乾跑預覽：按下建檔之前，把要送進 ERP 的 40 幾個欄位攤開來看 */}
              {(row.status === 'approved' || row.status === 'failed') && (
                <div className="mb-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => (showPayload ? setShowPayload(false) : void loadPayload())}
                      disabled={busy}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      {showPayload ? '收合' : '🔍 預覽將送給 ARGO 的內容'}
                    </button>
                    {payloadMeta && showPayload && (
                      <span className="text-[11px] text-slate-500">
                        共 {payloadMeta.fieldCount} 欄
                        {payloadMeta.categoryVerified
                          ? `・大類 ${payloadMeta.category} 已實測過`
                          : `・⚠ 大類 ${payloadMeta.category} 尚未實測，失敗會標「建檔失敗」並保留原因`}
                      </span>
                    )}
                  </div>
                  {showPayload && payload && (
                    <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/60 p-3 font-mono text-[10px] leading-relaxed">
                      {Object.entries(payload).map(([k, v]) => (
                        <div key={k} className="flex gap-2">
                          <span className="w-44 shrink-0 text-slate-500">{k}</span>
                          <span className="text-slate-300">{String(v)}</span>
                        </div>
                      ))}
                      <div className="mt-2 border-t border-slate-800 pt-2 text-slate-600">
                        會計科目刻意不送——手動帶會被 ARGO 判科目類別衝突，只給 ACCOUNT_FLAG=Y
                        讓它依料件類別自動帶。
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {(row.status === 'approved' || row.status === 'failed') && (
                  <button
                    onClick={() => act({ action: 'create_in_argo' })}
                    disabled={busy}
                    className="rounded-lg bg-violet-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-violet-500 disabled:opacity-40"
                    title="透過 IFAF007 直接在 ARGO 建立料件主檔，成功後自動結案"
                  >
                    🚀 {row.status === 'failed' ? '重試寫入 ARGO' : '直接建進 ARGO'}
                  </button>
                )}
                {row.status === 'approved' && (
                  <>
                    <span className="text-slate-700">或手動建好後</span>
                    <input
                      value={part}
                      onChange={e => setPart(e.target.value.toUpperCase())}
                      placeholder="ARGO 實際建好的編碼"
                      className="w-48 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-xs text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
                    />
                    <button
                      onClick={() => act({ action: 'created', assigned_part: part })}
                      disabled={busy || !part.trim()}
                      className="rounded-lg border border-emerald-700 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-40"
                    >
                      回填結案
                    </button>
                  </>
                )}
                <button
                  onClick={() => act({ action: 'reopen' })}
                  disabled={busy}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800 disabled:opacity-40"
                >
                  救回待審
                </button>
              </div>
            </div>
          )}

          {msg && <div className="mt-2 text-rose-300">⚠ {msg}</div>}
        </div>
      )}
    </div>
  )
}
