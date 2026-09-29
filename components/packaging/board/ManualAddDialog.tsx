'use client'

// D66 手動加入（待排池「＋加入訂單」）：主管把「不在待排池」的訂單品項行手動加進來排程。
// 流程：輸入單號 →「查詢」（GET /api/packaging/manual?so=）→ 列出該 SO 全部品項行＋逐行「為什麼不在待排池」
//       → 勾選品項行、改數量／途程類型、填原因（選填）→「加入」（POST）→ 顯示結果（加入 N 行、略過 M 行與原因）。
// - 顆粒度＝SO 品項行（Snow 確認）；資料一律取自 EIP 鏡像（erp_so_lines、塔台、採購…），不查 ARGO；廠商代碼不回前端。
// - 數量預設 ERP 訂單量、可改；可以超過訂單量（訂單單位與包裝數量可能不同，例 30 張 vs 2100 件）→ 只黃字提醒、不擋。
// - 途程類型預設用查詢給的建議值（有常平採購＝常平、其他廠商採購＝委外、否則自製），用來估工時。
// - 已在待排池、已手動加入、費用行、訂單量 0 的行不能勾（伺服器加入時還會再驗一次，不信任前端）。
// 同檔另有：ManualEditDialog（改手動加入數量／途程／原因，PATCH）、ManualRemoveDialog（移出待排池，POST /manual/remove）。
// D103（Snow 確認）：手動加入的數量＝這筆訂單的「總量」（含已完成），不是剩餘量；改數量對話框的欄位與預警都照這個語意。
// 手動加入／移出是「供給」的事實輸入，不進 Undo；誤加可移出、誤移出可再加入。
// D102：入口搬到待排池頁（components/packaging/pool/usePoolManual），工作台側欄不再開這三個對話框。
//   寫入只要 packaging_admin，不再需要編輯鎖（Snow 確認；伺服器理由見 app/api/packaging/manual/route.ts 檔頭），
//   所以對話框不再向父層要 lockToken（getLockToken 保留成選填、不使用，只為舊呼叫端能編譯）。
//   唯讀者（沒有 packaging_admin）按「查詢訂單」開的是 editable=false：可查某張單為什麼不在待排池，不能加入。

import { useState } from 'react'
import {
  ADJUST_REASON_MAX,
  MAX_MANUAL_ITEMS_PER_REQUEST,
  type ManualAbsenceCode,
  type ManualInclusionMeta,
  type ManualLookupLine,
  type ManualLookupResponse,
  type ManualMutationResponse,
  type ManualRouteType,
} from '@/lib/packaging/scheduleTypes'
import type { PackagingCard } from '@/lib/packaging/types'
import { fmtQty } from '@/components/packaging/poolStyles'
import Modal, { Btn } from './Modal'
import { clock, md } from './boardFormat'
import { addManual, lookupManual, removeManual, updateManual, type ApiResult } from './boardApi'

type LookupOk = Extract<ManualLookupResponse, { success: true }>
type Skipped = Extract<ManualMutationResponse, { success: true }>['skipped']

const ROUTE_TYPES: readonly ManualRouteType[] = ['自製', '常平', '委外']
/** 同伺服器白名單：SO／SOB／RO 開頭 */
const SO_RE = /^(SO|SOB|RO)[A-Z0-9-]{4,30}$/
/** 數量：> 0、最多 3 位小數 */
const QTY_RE = /^\d{1,9}(\.\d{1,3})?$/

/** 原因標籤的顏色：不能勾的（紅）、已在池內／已手動（藍紫）、其他（灰黃） */
const REASON_TONE: Record<ManualAbsenceCode, string> = {
  in_pool: 'border-sky-700 bg-sky-950/50 text-sky-200',
  manual_active: 'border-violet-700 bg-violet-950/50 text-violet-200',
  non_physical: 'border-rose-800 bg-rose-950/40 text-rose-200',
  zero_qty: 'border-rose-800 bg-rose-950/40 text-rose-200',
  // D73：ARGO 已全數銷貨（出貨），不能勾
  sold_out: 'border-rose-800 bg-rose-950/40 text-rose-200',
  // D104：主管已結案（未復原），不能勾
  closed: 'border-rose-800 bg-rose-950/40 text-rose-200',
  non_schedule_doc: 'border-amber-800 bg-amber-950/30 text-amber-200',
  tower_closed: 'border-amber-800 bg-amber-950/30 text-amber-200',
  packaged_done: 'border-amber-800 bg-amber-950/30 text-amber-200',
  sheet_stale: 'border-amber-800 bg-amber-950/30 text-amber-200',
  waiting_source: 'border-slate-600 bg-slate-800/60 text-slate-200',
  unknown: 'border-slate-600 bg-slate-800/60 text-slate-300',
}

export function isQtyText(x: string): boolean {
  const t = x.trim()
  return QTY_RE.test(t) && Number(t) > 0
}

/**
 * 使用者輸入 → 查詢用單號：去空白、轉大寫；貼上的是品項行（SO260924020-1）時拆出單號與項次。
 * 只在拆完仍是「字首＋純數字」時才拆，避免誤切本身含 '-' 的單號。
 */
export function parseSoInput(raw: string): { so: string; lineNo: string | null } {
  const t = raw.trim().toUpperCase().replace(/\s+/g, '')
  const m = t.match(/^((?:SO|SOB|RO)\d+)-(\d{1,4})$/)
  return m ? { so: m[1], lineNo: String(Number(m[2])) } : { so: t, lineNo: null }
}

/** 寫入失敗 → 中文說明（伺服器 error 已是中文） */
export function manualError(r: ApiResult<ManualMutationResponse>): string {
  const j = r.json && !r.json.success ? r.json : null
  // D102 起伺服器不再回鎖相關錯誤；部署交接那幾分鐘若打到舊版伺服器才可能出現
  if (j?.code === 'lock_required' || j?.code === 'lock_lost') return '伺服器仍要求編輯權（可能正在更新版本），請稍後重新整理再試'
  if (r.missingTable) return r.error ?? '資料庫尚未更新'
  return j?.error || r.error || '儲存失敗'
}

interface RowForm {
  checked: boolean
  qty: string
  route: ManualRouteType
}

function initForms(lines: readonly ManualLookupLine[], preselect: string | null): Record<string, RowForm> {
  const out: Record<string, RowForm> = {}
  for (const l of lines) {
    out[l.soLineKey] = {
      checked: l.selectable && preselect != null && String(Number(l.lineNo)) === preselect,
      qty: String(l.suggestedQty),
      route: l.suggestedRouteType,
    }
  }
  return out
}

function stateBadge(l: ManualLookupLine, action?: React.ReactNode) {
  if (l.state === 'in_pool') {
    return (
      <div className="text-[10px] text-sky-300">
        已在待排池：{l.inPoolBlocks.map(b => `${b.title} ${fmtQty(b.qty)}`).join('、') || '—'}
      </div>
    )
  }
  if (l.state === 'manual' && l.manual) {
    // 已全數完成的手動紀錄：待排池已無此卡 → 右鍵入口消失，改在這裡提供「移出」（D66 紀錄要有終點）
    return (
      <div className="text-[10px] text-violet-300">
        手動・{l.manual.addedByName ?? l.manual.addedBy}・{clock(l.manual.addedAt)}（總量 {fmtQty(l.manual.qty)}
        {(l.completedQty ?? 0) > 0 && <>・已完成 {fmtQty(l.completedQty ?? 0)}</>}，
        {l.manualDone ? '已全數完成，待排池已無此卡；不再需要可移出' : '改數量／移出請用待排池頁「手動加入」區該卡的按鈕'}）
        {action}
      </div>
    )
  }
  return null
}

/**
 * D103：加入前這一行就有已勾完成的量（正常區塊時期、或舊手動紀錄移出前完成的）→ 加入後會算進總量。
 * 數量 ≤ 已完成 → 黃字提醒（不擋，伺服器加入也不設下限）：加入後這筆立刻算包完、待排池不出卡。
 * 已完成 0 → 不顯示（總量＝還要包的量，沒有歧義）。
 */
export function ManualAddCompletedHint({ completedQty, qtyText }: { completedQty: number | undefined; qtyText: string }) {
  const done = completedQty ?? 0
  if (!(done > 0)) return null
  const atOrBelow = isQtyText(qtyText) && Number(qtyText.trim()) <= done + 1e-9
  return (
    <div className={`text-[10px] ${atOrBelow ? 'text-amber-300' : 'text-slate-400'}`}>
      此行已完成 {fmtQty(done)}（會算進總量）
      {atOrBelow && <>；總量不大於已完成，加入後立刻算包完、不出卡。還要再包 N 請填 {fmtQty(done)}＋N</>}
    </div>
  )
}

/** D102：唯讀時 footer 的預設說明（加入不再需要編輯鎖，只看權限） */
const DEFAULT_READONLY_NOTE = '唯讀：可以查詢這張單為什麼不在待排池；加入需要包裝主管（packaging_admin）權限'

export default function ManualAddDialog({ editable, onClose, onChanged, readOnlyNote }: {
  /** 可以加入／移出（D102：＝有 packaging_admin；false＝只能查詢） */
  editable: boolean
  /** @deprecated D102 起不需要編輯鎖，這個參數不再使用（保留只為舊呼叫端能編譯） */
  getLockToken?: () => string | null
  onClose: () => void
  /** 加入／移出成功（父層重新載入待排池） */
  onChanged: () => void
  /** 唯讀（editable=false）時 footer 顯示的說明；省略用 DEFAULT_READONLY_NOTE */
  readOnlyNote?: string
}) {
  const [soText, setSoText] = useState('')
  const [data, setData] = useState<LookupOk | null>(null)
  const [forms, setForms] = useState<Record<string, RowForm>>({})
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ added: number; skipped: Skipped } | null>(null)
  /** 對話框內「移出」：先按一次進入確認，再按一次才送出 */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const doLookup = async (keepResult = false) => {
    const { so, lineNo } = parseSoInput(soText)
    if (!SO_RE.test(so)) { setError('單號格式錯誤（例：SO260924020、SOB260902504、RO25080441）'); return }
    setLoading(true)
    setError(null)
    if (!keepResult) setResult(null)
    try {
      const r = await lookupManual(so)
      if (!r.json?.success) { setError(r.error ?? '查詢失敗'); return }
      setData(r.json)
      setForms(initForms(r.json.lines, lineNo))
    } finally {
      setLoading(false)
    }
  }

  const lines = data?.lines ?? []
  const checked = lines.filter(l => l.selectable && forms[l.soLineKey]?.checked)
  const selectableCount = lines.filter(l => l.selectable).length
  const qtyErr = checked.find(l => !isQtyText(forms[l.soLineKey]?.qty ?? ''))
  const reasonTrim = reason.trim()
  const tooMany = checked.length > MAX_MANUAL_ITEMS_PER_REQUEST
  const canSubmit = editable && !saving && !loading && checked.length > 0 && !qtyErr && !tooMany && reasonTrim.length <= ADJUST_REASON_MAX

  const setForm = (key: string, p: Partial<RowForm>) => setForms(f => ({ ...f, [key]: { ...f[key], ...p } }))
  const setAll = (on: boolean) => setForms(f => {
    const next = { ...f }
    for (const l of lines) if (l.selectable) next[l.soLineKey] = { ...next[l.soLineKey], checked: on }
    return next
  })

  const submit = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      const items = checked.map(l => ({
        soLineKey: l.soLineKey,
        qty: Number(forms[l.soLineKey].qty.trim()),
        routeType: forms[l.soLineKey].route,
        reason: reasonTrim || null,
      }))
      const r = await addManual(items)
      if (!r.json?.success) { setError(manualError(r)); return }
      const added = r.json.inclusions.length
      setResult({ added, skipped: r.json.skipped })
      if (added > 0) {
        onChanged()
        setReason('')
      }
      // 重新查詢：已加入的行改顯示「手動・誰・何時」、不能再勾
      await doLookup(true)
    } finally {
      setSaving(false)
    }
  }

  // 移出手動加入紀錄（軟刪除）。主要給「已全數完成、待排池已無此卡」的紀錄用；
  // 還有未完成排定卡時伺服器回 manual_has_placements，照樣顯示錯誤訊息。
  const removeLine = async (soLineKey: string) => {
    setSaving(true)
    setError(null)
    try {
      const r = await removeManual({ soLineKey, reason: null })
      if (!r.json?.success) { setError(manualError(r)); return }
      setConfirmRemove(null)
      onChanged()
      await doLookup(true)
    } finally {
      setSaving(false)
    }
  }

  const removeAction = (l: ManualLookupLine) => {
    if (!editable || l.state !== 'manual') return undefined
    return confirmRemove === l.soLineKey ? (
      <span className="ml-1 inline-flex gap-1">
        <button type="button" disabled={saving} onClick={() => void removeLine(l.soLineKey)}
          className="rounded border border-rose-700 px-1 text-rose-200 hover:bg-rose-950/60">確定移出</button>
        <button type="button" disabled={saving} onClick={() => setConfirmRemove(null)}
          className="rounded border border-slate-600 px-1 text-slate-300 hover:text-white">取消</button>
      </span>
    ) : (
      <button type="button" disabled={saving} onClick={() => setConfirmRemove(l.soLineKey)}
        aria-label={`移出第 ${l.lineNo} 項的手動加入`}
        className="ml-1 rounded border border-violet-700 px-1 text-violet-200 hover:bg-violet-950/60">移出</button>
    )
  }

  const lineName = (key: string) => {
    const l = lines.find(x => x.soLineKey === key)
    return l ? `第 ${l.lineNo} 項${l.itemName ? ` ${l.itemName}` : ''}` : key
  }

  return (
    <Modal
      title={editable ? '手動加入訂單品項（D66）' : '查詢訂單品項為什麼不在待排池'}
      onClose={onClose}
      wide
      footer={<>
        {error && <span className="mr-auto text-xs text-rose-300">{error}</span>}
        {!error && !editable && <span className="mr-auto text-xs text-slate-400">{readOnlyNote ?? DEFAULT_READONLY_NOTE}</span>}
        {!error && editable && tooMany && <span className="mr-auto text-xs text-orange-300">一次最多加入 {MAX_MANUAL_ITEMS_PER_REQUEST} 行</span>}
        {!error && editable && !tooMany && qtyErr && <span className="mr-auto text-xs text-orange-300">第 {qtyErr.lineNo} 項數量須大於 0、最多 3 位小數</span>}
        <Btn onClick={onClose}>{result ? '完成' : '取消'}</Btn>
        {editable && data?.found && (
          <Btn tone="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {saving ? '加入中…' : `加入待排池${checked.length > 0 ? `（${checked.length} 行）` : ''}`}
          </Btn>
        )}
      </>}
    >
      <div className="space-y-3 text-xs">
        <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); void doLookup() }}>
          <input
            autoFocus
            value={soText}
            onChange={e => setSoText(e.target.value)}
            placeholder="單號，例：SO260924020"
            aria-label="單號"
            className="w-56 rounded border border-slate-600 bg-slate-950 px-2 py-1 font-mono text-slate-100 placeholder:font-sans placeholder:text-slate-500"
          />
          <Btn type="submit" disabled={loading || soText.trim() === ''}>{loading ? '查詢中…' : '查詢'}</Btn>
          <span className="text-[11px] text-slate-500">列出這張單全部品項行，以及每一行為什麼不在待排池。</span>
        </form>

        {result && (
          <div className="rounded border border-emerald-800 bg-emerald-950/30 px-2 py-1.5 text-[11px] text-emerald-100">
            已加入 <b>{result.added}</b> 行到待排池「手動加入」區塊{result.skipped.length > 0 ? `，略過 ${result.skipped.length} 行：` : '。'}
            {result.skipped.length > 0 && (
              <ul className="mt-0.5 list-disc pl-4 text-orange-200">
                {result.skipped.map(s => <li key={`${s.soLineKey}:${s.code}`}>{lineName(s.soLineKey)}：{s.message}</li>)}
              </ul>
            )}
          </div>
        )}

        {data && !data.found && (
          <div className="rounded border border-rose-800 bg-rose-950/30 px-2 py-1.5 text-rose-200">
            ERP 查無 <span className="font-mono">{data.so}</span>（可能已結案、或單號打錯），不能手動加入。
          </div>
        )}

        {data?.found && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span className="font-mono text-slate-200">{data.so}</span>
              <span className="text-slate-300">{data.customer ?? '（無客戶名稱）'}</span>
              <span>共 {lines.length} 行，可加入 {selectableCount} 行</span>
              <span className="flex-1" />
              {editable && selectableCount > 0 && (
                <>
                  <button type="button" onClick={() => setAll(true)} className="rounded border border-slate-700 px-2 py-0.5 hover:text-white">全選可加入的行</button>
                  <button type="button" onClick={() => setAll(false)} className="rounded border border-slate-700 px-2 py-0.5 hover:text-white">全不選</button>
                </>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse">
                <thead className="text-left text-[11px] text-slate-400">
                  <tr className="border-b border-slate-800">
                    <th className="w-7 py-1 font-normal" />
                    <th className="py-1 pr-2 font-normal">項次</th>
                    <th className="py-1 pr-2 font-normal">品號／品名</th>
                    <th className="py-1 pr-2 font-normal">PACKING</th>
                    <th className="py-1 pr-2 text-right font-normal">訂單量</th>
                    <th className="py-1 pr-2 font-normal">交期</th>
                    <th className="py-1 pr-2 font-normal">狀態／不在池內的原因</th>
                    <th className="py-1 pr-2 font-normal">加入數量</th>
                    <th className="py-1 font-normal">途程類型</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(l => {
                    const f = forms[l.soLineKey]
                    const on = !!f?.checked && l.selectable
                    const over = on && isQtyText(f.qty) && Number(f.qty) > l.orderQty
                    return (
                      <tr key={l.soLineKey} className={`border-b border-slate-800/70 align-top ${on ? 'bg-sky-950/30' : ''} ${l.selectable ? '' : 'text-slate-400'}`}>
                        <td className="py-1.5">
                          <input type="checkbox" checked={on} disabled={!editable || !l.selectable || saving}
                            aria-label={`勾選第 ${l.lineNo} 項`}
                            title={l.selectable ? undefined : (l.blockedReason ?? '不能加入')}
                            onChange={e => setForm(l.soLineKey, { checked: e.target.checked })} className="accent-sky-500" />
                        </td>
                        <td className="py-1.5 pr-2 font-mono">{l.lineNo}</td>
                        <td className="max-w-[16rem] py-1.5 pr-2">
                          <div className="font-mono text-[10px] text-slate-500">{l.itemCode ?? '—'}</div>
                          <div className="break-words text-slate-100">{l.itemName ?? '（無品名）'}</div>
                        </td>
                        <td className="max-w-[10rem] py-1.5 pr-2">
                          <div className="line-clamp-2 break-words text-[11px]" title={l.packing ?? undefined}>{l.packing?.trim() || '—'}</div>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmtQty(l.orderQty)}{l.unit ? <span className="text-slate-500"> {l.unit}</span> : null}</td>
                        <td className="py-1.5 pr-2 whitespace-nowrap">{md(l.dueDate)}</td>
                        <td className="max-w-[18rem] py-1.5 pr-2">
                          <div className="flex flex-wrap gap-1">
                            {l.reasons.map(x => (
                              <span key={x.code} className={`rounded border px-1 py-px text-[10px] ${REASON_TONE[x.code] ?? REASON_TONE.unknown}`}>{x.label}</span>
                            ))}
                          </div>
                          {stateBadge(l, removeAction(l))}
                          {!l.selectable && l.blockedReason && l.state === 'absent' && <div className="text-[10px] text-rose-300">{l.blockedReason}</div>}
                        </td>
                        <td className="py-1.5 pr-2">
                          {l.selectable && f ? (
                            <>
                              <input value={f.qty} inputMode="decimal" disabled={!editable || saving}
                                aria-label={`第 ${l.lineNo} 項加入數量`}
                                onChange={e => setForm(l.soLineKey, { qty: e.target.value, checked: editable ? true : f.checked })}
                                className={`w-20 rounded border bg-slate-950 px-1 py-0.5 text-right tabular-nums text-slate-100 ${on && !isQtyText(f.qty) ? 'border-rose-500' : 'border-slate-700'}`} />
                              {over && <div className="text-[10px] text-amber-300">超過訂單量（單位可能不同，請確認）</div>}
                              <ManualAddCompletedHint completedQty={l.completedQty} qtyText={f.qty} />
                            </>
                          ) : <span className="text-slate-600">—</span>}
                        </td>
                        <td className="py-1.5">
                          {l.selectable && f ? (
                            <select value={f.route} disabled={!editable || saving}
                              aria-label={`第 ${l.lineNo} 項途程類型`}
                              title="用來估工時；預設依採購來源建議"
                              onChange={e => setForm(l.soLineKey, { route: e.target.value as ManualRouteType })}
                              className="rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-slate-100">
                              {ROUTE_TYPES.map(t => <option key={t} value={t}>{t}{t === l.suggestedRouteType ? '（建議）' : ''}</option>)}
                            </select>
                          ) : <span className="text-slate-600">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {editable && selectableCount > 0 && (
              <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                加入原因（選填，勾選的行共用）
                <input value={reason} maxLength={ADJUST_REASON_MAX} disabled={saving}
                  onChange={e => setReason(e.target.value)}
                  placeholder="例：塔台漏報、客戶急單先包…"
                  className="rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-slate-200 placeholder:text-slate-600" />
              </label>
            )}
            <p className="text-[11px] leading-relaxed text-slate-500">
              加入後出現在待排池最上面的「手動加入」區塊，一律視為可包（實線），可以到排程工作台正常排程、拆卡、勾完成
              （工作台已開著的話按「重新整理」就看得到）。
              之後若這一行自己回到待排池（例：塔台補上報工），手動卡會自動讓位，不會重複計算。要取消請在「手動加入」區按該卡的「移出待排池」。
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// 改手動加入數量／途程類型／原因（PATCH /api/packaging/manual）
// ─────────────────────────────────────────────────────────────────────

/**
 * D103 改總量的預警：與伺服器 manualPool.manualQtyFloorError 同樣兩段、同樣順序、同樣的比較式
 * （前端不 import manualPool：它會把 classify、salesAlloc 等伺服器邏輯打包進瀏覽器）。
 * completed＝總量 < 已完成；placed＝總量 < 已完成＋未完成擺放。floorQty＝最少要填多少。
 */
export function manualEditFloorWarning(qty: number, completedQty: number, placedQty: number): { kind: 'completed' | 'placed'; floorQty: number } | null {
  if (qty + 1e-9 < completedQty) return { kind: 'completed', floorQty: Math.round(completedQty * 1000) / 1000 }
  if (qty + 1e-9 < completedQty + placedQty) return { kind: 'placed', floorQty: Math.round((completedQty + placedQty) * 1000) / 1000 }
  return null
}

export function ManualEditDialog({ card, meta, placedQty, completedQty = 0, onClose, onChanged }: {
  card: PackagingCard
  meta: ManualInclusionMeta
  /** 目前已排出去（未完成）的量（PoolManualLine.placedQty；伺服器同一個算法） */
  placedQty: number
  /**
   * D103：已勾完成的量（PoolManualLine.completedQty）。數量＝這筆訂單的總量（含已完成），
   * 伺服器下限＝已完成＋未完成（manualPool.manualQtyFloorError）；省略＝0（D102 前的呼叫端）。
   */
  completedQty?: number
  /** @deprecated D102 起不需要編輯鎖，不再使用 */
  getLockToken?: () => string | null
  onClose: () => void
  onChanged: () => void
}) {
  const [qty, setQty] = useState(String(meta.qty))
  const [route, setRoute] = useState<ManualRouteType>(meta.routeType)
  const [reason, setReason] = useState(meta.reason ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const qtyOk = isQtyText(qty)
  const changedQty = qtyOk && Number(qty) !== meta.qty
  const changedRoute = route !== meta.routeType
  const reasonTrim = reason.trim()
  const changedReason = (reasonTrim || null) !== (meta.reason ?? null)
  // D103：伺服器只在數量有變時檢查下限，這裡也只在有變時提醒
  const warn = changedQty ? manualEditFloorWarning(Number(qty), completedQty, placedQty) : null
  const canSave = !saving && qtyOk && (changedQty || changedRoute || changedReason)

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const r = await updateManual({
        soLineKey: card.soLineKey,
        ...(changedQty ? { qty: Number(qty.trim()) } : {}),
        ...(changedRoute ? { routeType: route } : {}),
        ...(changedReason ? { reason: reasonTrim || null } : {}),
      })
      if (!r.json?.success) { setError(manualError(r)); return }
      onChanged()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={<span>改手動加入　<span className="font-mono">{card.soLineKey}</span></span>}
      onClose={onClose}
      footer={<>
        {error && <span className="mr-auto text-xs text-rose-300">{error}</span>}
        <Btn onClick={onClose}>取消</Btn>
        <Btn tone="primary" disabled={!canSave} onClick={() => void save()}>{saving ? '儲存中…' : '儲存'}</Btn>
      </>}
    >
      <form className="space-y-2 text-xs" onSubmit={e => { e.preventDefault(); void save() }}>
        <div className="break-words text-slate-200">{card.itemName ?? '（無品名）'}</div>
        <div className="text-[11px] text-slate-400">
          {meta.addedByName ?? meta.addedBy} 於 {clock(meta.addedAt)} 加入・目前總量 {fmtQty(meta.qty)}
          {completedQty > 0 && <>・已完成 {fmtQty(completedQty)}</>}
          {placedQty > 0 && <>・已排 {fmtQty(placedQty)}</>}
        </div>
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-16 text-slate-400">總量</span>
          <input autoFocus value={qty} inputMode="decimal" onChange={e => setQty(e.target.value)}
            aria-label="總量（含已完成）"
            className={`w-28 rounded border bg-slate-950 px-1.5 py-0.5 text-right tabular-nums text-slate-100 ${qtyOk ? 'border-slate-600' : 'border-rose-500'}`} />
          <span className="text-[11px] text-slate-500">含已完成</span>
          {!qtyOk && <span className="text-[11px] text-rose-300">須大於 0、最多 3 位小數</span>}
          {warn?.kind === 'completed' && <span className="text-[11px] text-orange-300">已完成 {fmtQty(completedQty)}，總量不能少於 {fmtQty(warn.floorQty)}，會被擋下</span>}
          {warn?.kind === 'placed' && (completedQty > 0
            ? <span className="text-[11px] text-orange-300">已完成 {fmtQty(completedQty)}＋已排 {fmtQty(placedQty)}，總量不能少於 {fmtQty(warn.floorQty)}，會被擋下（請先到排程工作台把排定卡拖回待排池）</span>
            : <span className="text-[11px] text-orange-300">低於已排量，會被擋下（請先到排程工作台把排定卡拖回待排池）</span>)}
        </label>
        <p className="text-[11px] text-slate-500">
          總量＝這筆訂單要包的全部數量（含已完成），不是「還剩多少」。例：已完成 50、還要再包 30 → 填 80；
          填成等於已完成＝這筆包完了，卡片會移到「已全數完成」。
        </p>
        <label className="flex items-center gap-2">
          <span className="w-16 text-slate-400">途程類型</span>
          <select value={route} onChange={e => setRoute(e.target.value as ManualRouteType)}
            className="rounded border border-slate-600 bg-slate-950 px-1 py-0.5 text-slate-100">
            {ROUTE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span className="text-[11px] text-slate-500">用來估工時</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-16 text-slate-400">原因</span>
          <input value={reason} maxLength={ADJUST_REASON_MAX} onChange={e => setReason(e.target.value)}
            placeholder="選填"
            className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-950 px-1.5 py-0.5 text-slate-100 placeholder:text-slate-600" />
        </label>
        <p className="text-[11px] text-slate-500">不進復原（Undo）；改錯請再改一次。</p>
      </form>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// 移出待排池（POST /api/packaging/manual/remove；軟刪除，紀錄保留）
// ─────────────────────────────────────────────────────────────────────

export function ManualRemoveDialog({ card, meta, onClose, onChanged }: {
  card: PackagingCard
  meta: ManualInclusionMeta
  /** @deprecated D102 起不需要編輯鎖，不再使用 */
  getLockToken?: () => string | null
  onClose: () => void
  onChanged: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setSaving(true)
    setError(null)
    try {
      const r = await removeManual({ soLineKey: card.soLineKey, reason: reason.trim() || null })
      if (!r.json?.success) { setError(manualError(r)); return }
      onChanged()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={<span>移出待排池？　<span className="font-mono">{card.soLineKey}</span></span>}
      onClose={onClose}
      footer={<>
        {error && <span className="mr-auto text-xs text-rose-300">{error}</span>}
        <Btn onClick={onClose}>取消</Btn>
        <Btn tone="danger" disabled={saving} onClick={() => void remove()}>{saving ? '移出中…' : '移出待排池'}</Btn>
      </>}
    >
      <div className="space-y-2 text-xs">
        {/* D103：手動加入的數量＝這筆訂單的總量（含已完成），標清楚免得讀成剩餘量 */}
        <div className="break-words text-slate-200">{card.itemName ?? '（無品名）'}・總量 {fmtQty(meta.qty)}</div>
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-slate-400">
          <li>這一行會從「手動加入」區塊消失；紀錄保留，之後可以再加入（已勾完成的量會算進再加入時填的總量）。</li>
          <li>還有未完成的排定卡時不能移出，請先到排程工作台把排定卡拖回待排池。已勾完成的卡不受影響。</li>
          <li>不進復原（Undo）。</li>
        </ul>
        <input value={reason} maxLength={ADJUST_REASON_MAX} onChange={e => setReason(e.target.value)}
          placeholder="移出原因（選填）"
          className="w-full rounded border border-slate-600 bg-slate-950 px-1.5 py-1 text-slate-100 placeholder:text-slate-600" />
      </div>
    </Modal>
  )
}
