'use client'

/**
 * 後台 ③ 全域參數 /admin/quote/settings（設計書 §8-③、§6 quote_settings 鍵、§5.6 旗標）。
 *
 * 資料來源：GET /api/quote/admin/settings → QuoteSettingsMap；儲存：PUT 同路徑。
 * 旗標區每個附「Excel 現況」說明；翻旗標必須填理由（§8-③），理由隨 PUT 一起送。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AcrylicSettings } from '@/lib/quote/types'
import type { QuoteSettingsMap } from '@/lib/quote/api'
import { adminFetch, cloneJson, pickObject, sameJson } from '../_shared/api'
import {
  Btn, Check, Field, INPUT_CLS, INPUT_SM_CLS, LoadingBlock, MONO, NotReadyBanner, Notice, NumInput, PageHeader, SaveBar, Section, TD_CLS, TH_CLS,
} from '../_shared/ui'

const API = '/api/quote/admin/settings'

/** §5.6 已知模板瑕疵：每個旗標的 Excel 現況說明（預設值 = Excel 行為） */
const FLAG_DOCS: { key: keyof AcrylicSettings['flags']; title: string; excel: string; ifOff: string }[] = [
  {
    key: 'outlineScrapFactorFixed',
    title: '外形段銑時間用固定係數，不隨報廢率',
    excel: 'Excel 現況：外形 H26 = L10 × 1.1 硬編碼（不看 L5），G26 再乘 (1 + s/100)，等於報廢套兩次 ×1.21；銑槽 H35 = L11 × (1 + L5/100) 才有跟著報廢率走。',
    ifOff: '關閉後外形段改用 (1 + 報廢率%) 當係數，跟銑槽／蓋板同構。',
  },
  {
    key: 'secondBoardExcludedFromCut',
    title: '第二板材不進切割段',
    excel: 'Excel 現況：第二板 C10 不進任何切割段，D26:D30 只乘主板盤數 C9（登山沟實案照抄）。',
    ifOff: '關閉後第二板材標記 cut=true 的盤數會併入切割佔用天。',
  },
  {
    key: 'fixedFeeScrapApplied',
    title: '一次性外發費放包材段一起乘報廢率',
    excel: 'Excel 現況：烫金开版、纳米胶這類一次性費用塞在包材段（ANDY A71），被 ×(1 + s/100)。',
    ifOff: '關閉後 group=outsourced 的固定費不乘報廢率。',
  },
]

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 表單只擋「會讓引擎算出 NaN」的空值；業務邏輯合理性交給 Snow 判斷 */
function validate(m: QuoteSettingsMap): string[] {
  const errs: string[] = []
  const s = m.acrylic_settings
  if (!isNum(s.nesting.gapCm) || !isNum(s.nesting.marginCm)) errs.push('拼板：間距／邊距必須是數字')
  const c = s.cut
  for (const [k, label] of [
    ['hoursPerDay', '每日工時'], ['machines', '機台數'], ['shiftFactor', '班次係數'], ['efficiency', '稼動率'],
    ['workDays', '工作天'], ['outlineTimeFactor', '外形時間係數'], ['laborMonthly', '人工月薪'],
    ['knifeOutlineMonthly', '外形刀費月額'], ['knifeGrooveMonthly', '銑槽刀費月額'], ['knifeCoverMonthly', '蓋板刀費月額'],
  ] as const) {
    if (!isNum(c[k])) errs.push(`切割：${label} 必須是數字`)
  }
  c.machinesMonthly.forEach((x, i) => {
    if (!x.name.trim()) errs.push(`切割：第 ${i + 1} 台機台缺名稱`)
    if (!isNum(x.monthly)) errs.push(`切割：機台「${x.name || i + 1}」月折舊必須是數字`)
  })
  if (!isNum(s.packLabor.hoursPerDay) || !isNum(s.packLabor.workDays)) errs.push('包裝人工：每日工時／工作天必須是數字')
  s.packLabor.staff.forEach((p, i) => {
    if (!p.name.trim()) errs.push(`包裝人工：第 ${i + 1} 位人員缺名稱`)
    if (!isNum(p.share)) errs.push(`包裝人工：「${p.name || i + 1}」分攤比必須是數字`)
    const hasMonthly = isNum(p.monthly)
    const hasHourly = isNum(p.hourly)
    if (!hasMonthly && !hasHourly) errs.push(`包裝人工：「${p.name || i + 1}」月薪與時薪至少填一個`)
  })
  const k = s.koshi
  if (!isNum(k.allowancePct) || !isNum(k.trialSheets) || !isNum(k.extraFreeSheets) || !isNum(k.extraUnitPrice)) errs.push('柯氏：四個欄位必須都是數字')
  if (m.fx_rmb_twd) {
    if (!isNum(m.fx_rmb_twd.rate) || m.fx_rmb_twd.rate <= 0) errs.push('匯率：rate 必須是正數')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.fx_rmb_twd.as_of)) errs.push('匯率：as_of 需為 YYYY-MM-DD')
  }
  if (!isNum(m.markup_bardshop_pct)) errs.push('啟盛加成 % 必須是數字')
  if (!isNum(m.quote_validity_days) || m.quote_validity_days < 0) errs.push('報價有效天數必須是 0 以上的數字')
  if (!m.rate_version.trim()) errs.push('費率版本字串不可空白')
  return errs
}

export default function QuoteSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [notReady, setNotReady] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [orig, setOrig] = useState<QuoteSettingsMap | null>(null)
  const [draft, setDraft] = useState<QuoteSettingsMap | null>(null)
  const [meta, setMeta] = useState<{ updated_by?: string | null; updated_at?: string | null } | null>(null)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const r = await adminFetch<Record<string, unknown>>(API)
    if (!r.ok) {
      if (r.notReady) setNotReady(r.error)
      else setError(r.error)
      setLoading(false)
      return
    }
    // route 可能包在 settings 鍵下，也可能直接攤平在頂層
    const map = pickObject<QuoteSettingsMap>(r.data, ['settings', 'values', 'map'])
      ?? (pickObject<AcrylicSettings>(r.data, ['acrylic_settings']) ? (r.data as unknown as QuoteSettingsMap) : null)
    if (!map || !map.acrylic_settings) {
      setError('回應缺少 settings.acrylic_settings，請檢查 API 回應格式')
      setLoading(false)
      return
    }
    const normalized: QuoteSettingsMap = {
      acrylic_settings: map.acrylic_settings,
      fx_rmb_twd: map.fx_rmb_twd ?? null,
      markup_bardshop_pct: Number(map.markup_bardshop_pct ?? 0),
      quote_validity_days: Number(map.quote_validity_days ?? 14),
      rate_version: String(map.rate_version ?? ''),
    }
    setOrig(cloneJson(normalized))
    setDraft(cloneJson(normalized))
    setMeta(pickObject(r.data, ['meta']) ?? null)
    setReason('')
    setNotReady(null)
    setLoading(false)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(t)
  }, [load])

  const dirty = useMemo(() => !!draft && !!orig && !sameJson(draft, orig), [draft, orig])
  const flagsChanged = useMemo(() => !!draft && !!orig && !sameJson(draft.acrylic_settings.flags, orig.acrylic_settings.flags), [draft, orig])
  const errors = useMemo(() => (draft ? validate(draft) : []), [draft])

  const shareTotal = useMemo(() => draft?.acrylic_settings.packLabor.staff.reduce((a, p) => a + (isNum(p.share) ? p.share : 0), 0) ?? 0, [draft])

  /** 每件包裝人工 = Σ(月薪/工作天/工時 或 時薪) × 分攤比 ÷ 產能；這裡只顯示「每工時成本」給 Snow 對照 Excel D64 的 18.12564 */
  const laborPerHour = useMemo(() => {
    if (!draft) return 0
    const { hoursPerDay, workDays, staff } = draft.acrylic_settings.packLabor
    if (!isNum(hoursPerDay) || !isNum(workDays) || hoursPerDay <= 0 || workDays <= 0) return 0
    return staff.reduce((a, p) => {
      const rate = isNum(p.monthly) ? p.monthly / workDays / hoursPerDay : isNum(p.hourly) ? p.hourly : 0
      return a + rate * (isNum(p.share) ? p.share : 0)
    }, 0)
  }, [draft])

  const knifeMonthly = (unit: number) => draft ? draft.acrylic_settings.cut.machines * 2 * 3 * unit * draft.acrylic_settings.cut.workDays : 0

  const setA = (fn: (s: AcrylicSettings) => void) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = cloneJson(prev)
      fn(next.acrylic_settings)
      return next
    })
  }
  const setM = (fn: (m: QuoteSettingsMap) => void) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = cloneJson(prev)
      fn(next)
      return next
    })
  }

  const save = async () => {
    if (!draft) return
    if (errors.length) {
      alert(`請先修正：\n${errors.join('\n')}`)
      return
    }
    if (flagsChanged && !reason.trim()) {
      alert('你改了瑕疵旗標，請填「翻旗標理由」再儲存（設計書 §8-③）。')
      return
    }
    setSaving(true)
    setError(null)
    setOkMsg(null)
    const r = await adminFetch(API, { method: 'PUT', body: { settings: draft, reason: reason.trim() || undefined } })
    setSaving(false)
    if (!r.ok) {
      if (r.notReady) setNotReady(r.error)
      else setError(`儲存失敗：${r.error}`)
      return
    }
    setOkMsg('已儲存全域參數。前台下一次試算即套用新值；已產生的報價 log 保留當時快照不受影響。')
    await load()
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto text-slate-300 min-h-screen font-sans">
      <PageHeader
        title="全域參數"
        subtitle="quote_settings // 機台、人工、柯氏、旗標、匯率"
        current="/admin/quote/settings"
        actions={meta?.updated_at ? <span className="text-xs text-slate-500">上次更新：{meta.updated_by ?? '—'} · {new Date(meta.updated_at).toLocaleString('zh-TW', { hour12: false })}</span> : undefined}
      />

      {notReady && <NotReadyBanner message={notReady} />}
      {error && <Notice kind="error">{error}</Notice>}
      {okMsg && <Notice kind="ok">{okMsg}</Notice>}

      {loading ? (
        <LoadingBlock />
      ) : !draft ? null : (
        <>
          {/* 拼板 */}
          <Section title="拼板" desc="計算器 B7/B8：間距 g、邊距 m（cm）。套版尺寸掛在板材 attrs，不在這裡。">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Field label="間距 g（cm）" hint="Excel B7/10 = 0.4">
                <NumInput value={draft.acrylic_settings.nesting.gapCm} onChange={(v) => setA((s) => { s.nesting.gapCm = v })} />
              </Field>
              <Field label="邊距 m（cm）" hint="Excel B8/10 = 0">
                <NumInput value={draft.acrylic_settings.nesting.marginCm} onChange={(v) => setA((s) => { s.nesting.marginCm = v })} />
              </Field>
            </div>
          </Section>

          {/* 切割 */}
          <Section title="切割（外形／銑槽／蓋板共用）" desc="產能 E26 = 工時×60 ÷ 銑時間 × 機台數 × 班次係數 × 稼動率；月固定 = 機台折舊 + 人工 + 刀費；每段 D = 月固定 ÷ 工作天 × 佔用天。">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-4">
              <Field label="每日工時（h）"><NumInput value={draft.acrylic_settings.cut.hoursPerDay} onChange={(v) => setA((s) => { s.cut.hoursPerDay = v })} /></Field>
              <Field label="機台數"><NumInput value={draft.acrylic_settings.cut.machines} onChange={(v) => setA((s) => { s.cut.machines = v })} /></Field>
              <Field label="班次係數"><NumInput value={draft.acrylic_settings.cut.shiftFactor} onChange={(v) => setA((s) => { s.cut.shiftFactor = v })} /></Field>
              <Field label="稼動率"><NumInput value={draft.acrylic_settings.cut.efficiency} onChange={(v) => setA((s) => { s.cut.efficiency = v })} /></Field>
              <Field label="工作天／月"><NumInput value={draft.acrylic_settings.cut.workDays} onChange={(v) => setA((s) => { s.cut.workDays = v })} /></Field>
              <Field label="外形時間係數" hint="H26 硬編碼 1.1"><NumInput value={draft.acrylic_settings.cut.outlineTimeFactor} onChange={(v) => setA((s) => { s.cut.outlineTimeFactor = v })} /></Field>
              <Field label="人工月薪"><NumInput value={draft.acrylic_settings.cut.laborMonthly} onChange={(v) => setA((s) => { s.cut.laborMonthly = v })} /></Field>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-400">機台月折舊清單（年限不進公式，只存月額）</span>
                  <Btn size="sm" onClick={() => setA((s) => { s.cut.machinesMonthly.push({ name: '', monthly: 0 }) })}>＋ 新增機台</Btn>
                </div>
                <table className="w-full">
                  <thead><tr><th className={TH_CLS}>名稱</th><th className={`${TH_CLS} text-right`}>月折舊</th><th className={TH_CLS}></th></tr></thead>
                  <tbody>
                    {draft.acrylic_settings.cut.machinesMonthly.map((m, i) => (
                      <tr key={i}>
                        <td className={TD_CLS}><input className={INPUT_CLS} value={m.name} onChange={(e) => setA((s) => { s.cut.machinesMonthly[i].name = e.target.value })} /></td>
                        <td className={`${TD_CLS} w-40`}><NumInput value={m.monthly} onChange={(v) => setA((s) => { s.cut.machinesMonthly[i].monthly = v })} /></td>
                        <td className={`${TD_CLS} w-16 text-right`}><Btn size="sm" variant="danger" onClick={() => setA((s) => { s.cut.machinesMonthly.splice(i, 1) })}>刪除</Btn></td>
                      </tr>
                    ))}
                    <tr>
                      <td className={`${TD_CLS} text-slate-400`}>合計</td>
                      <td className={`${TD_CLS} text-right ${MONO} text-white`}>{draft.acrylic_settings.cut.machinesMonthly.reduce((a, m) => a + (isNum(m.monthly) ? m.monthly : 0), 0).toFixed(2)}</td>
                      <td className={TD_CLS}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <div className="text-xs text-slate-400 mb-2">刀費月額（C30 = 機台數 × 2 把 × 3 次/天 × 刀單價 × 工作天；這裡直接存月額）</div>
                <div className="grid grid-cols-1 gap-3">
                  <Field label="外形刀費月額" hint={`對照：刀單價 27 → ${knifeMonthly(27).toLocaleString()}；12 → ${knifeMonthly(12).toLocaleString()}（2026-03-27 起用 27）`}>
                    <NumInput value={draft.acrylic_settings.cut.knifeOutlineMonthly} onChange={(v) => setA((s) => { s.cut.knifeOutlineMonthly = v })} />
                  </Field>
                  <Field label="銑槽刀費月額" hint="所有版本刀單價 12 → 9360">
                    <NumInput value={draft.acrylic_settings.cut.knifeGrooveMonthly} onChange={(v) => setA((s) => { s.cut.knifeGrooveMonthly = v })} />
                  </Field>
                  <Field label="蓋板刀費月額" hint="所有版本刀單價 12 → 9360">
                    <NumInput value={draft.acrylic_settings.cut.knifeCoverMonthly} onChange={(v) => setA((s) => { s.cut.knifeCoverMonthly = v })} />
                  </Field>
                </div>
              </div>
            </div>
          </Section>

          {/* 包裝人工 */}
          <Section
            title="包裝人工"
            desc="D54~D57：每人 (月薪 ÷ 工作天 ÷ 工時 或 時薪) × 總工時 × 分攤比；總工時 = Q ÷ 包裝產能。"
            actions={<Btn size="sm" onClick={() => setA((s) => { s.packLabor.staff.push({ name: '', monthly: undefined, hourly: undefined, share: 0 }) })}>＋ 新增人員</Btn>}
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <Field label="每日工時（h）"><NumInput value={draft.acrylic_settings.packLabor.hoursPerDay} onChange={(v) => setA((s) => { s.packLabor.hoursPerDay = v })} /></Field>
              <Field label="工作天／月"><NumInput value={draft.acrylic_settings.packLabor.workDays} onChange={(v) => setA((s) => { s.packLabor.workDays = v })} /></Field>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr>
                    <th className={TH_CLS}>名稱</th>
                    <th className={TH_CLS}>計薪</th>
                    <th className={`${TH_CLS} text-right`}>月薪 / 時薪</th>
                    <th className={`${TH_CLS} text-right`}>分攤比</th>
                    <th className={`${TH_CLS} text-right`}>每工時成本</th>
                    <th className={TH_CLS}></th>
                  </tr>
                </thead>
                <tbody>
                  {draft.acrylic_settings.packLabor.staff.map((p, i) => {
                    const mode: 'monthly' | 'hourly' = isNum(p.hourly) && !isNum(p.monthly) ? 'hourly' : 'monthly'
                    const { hoursPerDay, workDays } = draft.acrylic_settings.packLabor
                    const rate = mode === 'monthly' ? (isNum(p.monthly) && hoursPerDay > 0 && workDays > 0 ? p.monthly / workDays / hoursPerDay : 0) : (isNum(p.hourly) ? p.hourly : 0)
                    return (
                      <tr key={i}>
                        <td className={TD_CLS}><input className={INPUT_CLS} value={p.name} onChange={(e) => setA((s) => { s.packLabor.staff[i].name = e.target.value })} /></td>
                        <td className={`${TD_CLS} w-28`}>
                          <select
                            className={INPUT_CLS}
                            value={mode}
                            onChange={(e) => setA((s) => {
                              const st = s.packLabor.staff[i]
                              if (e.target.value === 'hourly') { st.hourly = isNum(st.hourly) ? st.hourly : 0; delete st.monthly }
                              else { st.monthly = isNum(st.monthly) ? st.monthly : 0; delete st.hourly }
                            })}
                          >
                            <option value="monthly">月薪</option>
                            <option value="hourly">時薪</option>
                          </select>
                        </td>
                        <td className={`${TD_CLS} w-36`}>
                          {mode === 'monthly'
                            ? <NumInput value={p.monthly} onChange={(v) => setA((s) => { s.packLabor.staff[i].monthly = v })} />
                            : <NumInput value={p.hourly} onChange={(v) => setA((s) => { s.packLabor.staff[i].hourly = v })} />}
                        </td>
                        <td className={`${TD_CLS} w-28`}><NumInput value={p.share} step={0.01} onChange={(v) => setA((s) => { s.packLabor.staff[i].share = v })} /></td>
                        <td className={`${TD_CLS} text-right ${MONO} text-slate-400`}>{(rate * (isNum(p.share) ? p.share : 0)).toFixed(5)}</td>
                        <td className={`${TD_CLS} w-16 text-right`}><Btn size="sm" variant="danger" onClick={() => setA((s) => { s.packLabor.staff.splice(i, 1) })}>刪除</Btn></td>
                      </tr>
                    )
                  })}
                  <tr>
                    <td className={`${TD_CLS} text-slate-400`} colSpan={3}>合計</td>
                    <td className={`${TD_CLS} text-right ${MONO} ${Math.abs(shareTotal - 1) > 1e-6 ? 'text-yellow-300' : 'text-white'}`}>{shareTotal.toFixed(2)}</td>
                    <td className={`${TD_CLS} text-right ${MONO} text-white`} title="Excel D64 模板值 18.12564">{laborPerHour.toFixed(5)}</td>
                    <td className={TD_CLS}></td>
                  </tr>
                </tbody>
              </table>
            </div>
            {Math.abs(shareTotal - 1) > 1e-6 && (
              <div className="text-xs text-yellow-300 mt-2">※ 分攤比合計 {shareTotal.toFixed(2)} ≠ 1.00。Excel 模板四人合計 1.00；不等於 1 引擎照算，只是提醒。</div>
            )}
          </Section>

          {/* 柯氏 */}
          <Section title="柯氏（柯式印刷）" desc="PET 盤數 C11 = C9 ÷ k_pet × (1 + 放數%) + 試機張數；加印 D19 = 加印單價 × MAX(0, C11 − 免費張數)。">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Field label="放數 %" hint="C11 的 ×1.1 → 10"><NumInput value={draft.acrylic_settings.koshi.allowancePct} onChange={(v) => setA((s) => { s.koshi.allowancePct = v })} /></Field>
              <Field label="試機張數" hint="C11 的 +600"><NumInput value={draft.acrylic_settings.koshi.trialSheets} onChange={(v) => setA((s) => { s.koshi.trialSheets = v })} /></Field>
              <Field label="加印免費張數" hint="C19 的 600 + 1000 = 1600"><NumInput value={draft.acrylic_settings.koshi.extraFreeSheets} onChange={(v) => setA((s) => { s.koshi.extraFreeSheets = v })} /></Field>
              <Field label="加印單價（RMB/張）" hint="0.8"><NumInput value={draft.acrylic_settings.koshi.extraUnitPrice} onChange={(v) => setA((s) => { s.koshi.extraUnitPrice = v })} /></Field>
            </div>
          </Section>

          {/* 旗標 */}
          <Section title="已知模板瑕疵旗標（§5.6）" desc="引擎照抄 Excel，包含瑕疵；每個瑕疵一個旗標，預設 = Excel 現況。要「修正」是 Snow 拍板後在這裡翻旗標，不是工程師順手改。">
            <div className="space-y-3">
              {FLAG_DOCS.map((f) => {
                const on = draft.acrylic_settings.flags[f.key]
                const changed = orig ? orig.acrylic_settings.flags[f.key] !== on : false
                return (
                  <div key={f.key} className={`rounded border p-3 ${changed ? 'border-yellow-600 bg-yellow-950/20' : 'border-slate-700 bg-slate-900/40'}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Check checked={on} onChange={(v) => setA((s) => { s.flags[f.key] = v })} label={<span className="font-bold">{f.title}</span>} />
                      <span className={`text-[11px] font-mono ${on ? 'text-emerald-300' : 'text-red-300'}`}>{f.key} = {String(on)}{changed ? '（已變更）' : ''}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-2">{f.excel}</div>
                    <div className="text-xs text-slate-500 mt-1">關閉時：{f.ifOff}</div>
                  </div>
                )
              })}
            </div>
            <Field label={<span>翻旗標理由{flagsChanged && <span className="text-yellow-300">（必填）</span>}</span>} hint="會隨儲存一起送到 API 留紀錄。" className="mt-4">
              <textarea className={`${INPUT_CLS} min-h-[64px]`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：Snow 2026-09-15 拍板，外形段報廢率只套一次" />
            </Field>
          </Section>

          {/* 匯率與加成 */}
          <Section title="匯率、加成、有效期、費率版本" desc="報價(TWD) = 報價(RMB) × 匯率 × (1 + 啟盛加成%)。未設匯率時前台只顯示 RMB。">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Field label="RMB → TWD 匯率" hint="1 RMB = ? TWD；清空 = 未設定">
                <NumInput
                  value={draft.fx_rmb_twd?.rate ?? null}
                  placeholder="未設定"
                  onChange={(v) => setM((m) => {
                    if (!Number.isFinite(v)) { m.fx_rmb_twd = null; return }
                    m.fx_rmb_twd = { rate: v, as_of: m.fx_rmb_twd?.as_of ?? new Date().toISOString().slice(0, 10) }
                  })}
                />
              </Field>
              <Field label="匯率日期 as_of">
                <input
                  type="date"
                  className={`${INPUT_CLS} ${MONO}`}
                  disabled={!draft.fx_rmb_twd}
                  value={draft.fx_rmb_twd?.as_of ?? ''}
                  onChange={(e) => setM((m) => { if (m.fx_rmb_twd) m.fx_rmb_twd.as_of = e.target.value })}
                />
              </Field>
              <Field label="啟盛加成 %"><NumInput value={draft.markup_bardshop_pct} onChange={(v) => setM((m) => { m.markup_bardshop_pct = v })} /></Field>
              <Field label="報價有效天數"><NumInput value={draft.quote_validity_days} min={0} step={1} onChange={(v) => setM((m) => { m.quote_validity_days = v })} /></Field>
              <Field label="費率版本字串" hint="前台徽章顯示，例如 2026-09；改價後記得跟著改" className="col-span-2">
                <input className={`${INPUT_SM_CLS} w-full ${MONO}`} value={draft.rate_version} onChange={(e) => setM((m) => { m.rate_version = e.target.value })} />
              </Field>
            </div>
          </Section>

          {errors.length > 0 && (
            <Notice kind="error">
              <div className="font-bold mb-1">尚有 {errors.length} 個欄位需要修正：</div>
              <ul className="list-disc pl-5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </Notice>
          )}

          <SaveBar
            dirty={dirty}
            saving={saving}
            onSave={() => { void save() }}
            onReset={() => { if (orig) { setDraft(cloneJson(orig)); setReason('') } }}
            extra={flagsChanged ? <span className="text-xs text-yellow-300">旗標有變更，需填理由</span> : undefined}
          />
        </>
      )}
    </div>
  )
}
