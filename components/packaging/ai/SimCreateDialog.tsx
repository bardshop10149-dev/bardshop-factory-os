'use client'

// 建立／重設模擬區（規格 §三「建立/重設」；D78① 複製或清空、D83 範圍 2／4／6 天、預設第 8 點起始日今天／下一個工作日）。
// 同一份表單兩種用法：還沒有模擬區時直接放在頁面上（SimCreateForm）；已有模擬區時從工具列開對話框重設（SimCreateDialog）。
// 重設不會刪東西：伺服器先把目前整份狀態推進「退回上一步」，按一下就能回來。
// D101：重設時可選「保留模擬產線時數」（預設保留：重設多半是換模式重排，時數設定不該跟著消失；只留仍落在新範圍內的）。

import { useState } from 'react'
import { AI_DEFAULT_HORIZON, AI_HORIZONS, SIM_MODES, type AiHorizon, type SimMode, type SimStartOption } from '@/lib/packaging/ai/types'
import Modal, { Btn } from '@/components/packaging/board/Modal'
import { MODE_HINT, MODE_LABEL, horizonLabel } from './simText'

export interface SimCreateValue {
  horizon: AiHorizon
  mode: SimMode
  start: SimStartOption
  /** D101 重設時保留仍在新範圍內的模擬產線時數（省略＝保留） */
  keepCapacity?: boolean
}

const START_LABEL: Record<SimStartOption, { label: string; hint: string }> = {
  today: { label: '從今天', hint: '今天不是工作日（週末、假日）時自動從下一個工作日開始' },
  next: { label: '從下一個工作日', hint: '今天已排得差不多時，從明天（下一個工作日）開始模擬' },
}

function Choice<T extends string | number>({ name, value, options, onChange, disabled }: {
  name: string
  value: T
  options: { value: T; label: string; hint?: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={name} className="grid gap-1.5 sm:grid-cols-2">
      {options.map(o => (
        <label
          key={String(o.value)}
          className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
            value === o.value ? 'border-violet-500 bg-violet-950/40 text-violet-100' : 'border-slate-700 bg-slate-950/40 text-slate-300 hover:border-slate-500'
          } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
        >
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            disabled={disabled}
            className="mt-0.5 accent-violet-500"
          />
          <span className="min-w-0">
            <span className="block font-semibold">{o.label}</span>
            {o.hint && <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  )
}

export function SimCreateForm({ disabled, value, onChange }: {
  disabled?: boolean
  value: SimCreateValue
  onChange: (v: SimCreateValue) => void
}) {
  return (
    <div className="space-y-3">
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-semibold text-slate-300">模擬範圍（D83）</legend>
        <Choice<AiHorizon>
          name="horizon"
          value={value.horizon}
          disabled={disabled}
          onChange={h => onChange({ ...value, horizon: h })}
          options={AI_HORIZONS.map(h => ({
            value: h,
            label: horizonLabel(h),
            hint: h === AI_DEFAULT_HORIZON ? '建議值；已開加班的週六／週日會插入，不佔名額' : h === 2 ? '範圍小、AI 跑得快' : '範圍大、AI 要想比較久',
          }))}
        />
      </fieldset>
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-semibold text-slate-300">起始日</legend>
        <Choice<SimStartOption>
          name="start"
          value={value.start}
          disabled={disabled}
          onChange={s => onChange({ ...value, start: s })}
          options={(['today', 'next'] as const).map(s => ({ value: s, label: START_LABEL[s].label, hint: START_LABEL[s].hint }))}
        />
      </fieldset>
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-semibold text-slate-300">開始方式（D78）</legend>
        <Choice<SimMode>
          name="mode"
          value={value.mode}
          disabled={disabled}
          onChange={m => onChange({ ...value, mode: m })}
          options={SIM_MODES.map(m => ({ value: m, label: MODE_LABEL[m], hint: MODE_HINT[m] }))}
        />
      </fieldset>
      <p className="text-[11px] leading-relaxed text-slate-500">
        模擬區是你自己的草稿，不會動到正式排程；調整滿意後按「採用此版排程」才會寫進正式排程（採用前會自動存版本，可以退回）。
      </p>
    </div>
  )
}

export default function SimCreateDialog({ initial, busy, onClose, onSubmit, capacityCount = 0 }: {
  initial?: Partial<SimCreateValue>
  busy: boolean
  onClose: () => void
  onSubmit: (v: SimCreateValue) => void
  /** D101 目前模擬區調整過的產線時數（格＋模擬開的週末）；0 不顯示「保留」選項 */
  capacityCount?: number
}) {
  const [value, setValue] = useState<SimCreateValue>({
    horizon: initial?.horizon ?? AI_DEFAULT_HORIZON,
    mode: initial?.mode ?? 'copy',
    start: initial?.start ?? 'today',
    keepCapacity: true,
  })
  return (
    <Modal
      title="重設模擬區"
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>取消</Btn>
        <Btn tone="primary" disabled={busy} onClick={() => onSubmit(value)}>{busy ? '處理中…' : '重設模擬區'}</Btn>
      </>}
    >
      <div className="mb-3 rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-100">
        重設會用新的範圍與方式重新開始模擬區（鎖定也會依新範圍重來）。目前的模擬內容會先存進「退回上一步」，按一下就能回來。
      </div>
      <SimCreateForm value={value} onChange={setValue} disabled={busy} />
      {capacityCount > 0 && (
        <label className="mt-3 flex items-start gap-2 rounded-lg border border-violet-700/60 bg-violet-950/30 px-3 py-2 text-xs text-violet-100">
          <input type="checkbox" checked={value.keepCapacity !== false} disabled={busy}
            onChange={e => setValue(v => ({ ...v, keepCapacity: e.target.checked }))} className="mt-0.5 accent-violet-500" />
          <span>
            保留模擬產線時數（目前調整了 {capacityCount} 項）
            <span className="mt-0.5 block text-[11px] text-violet-200/70">只保留仍落在新範圍內的日子；範圍外的、以及不在新範圍中間的模擬週末加班會拿掉。不勾＝全部回到正式產能表的值。</span>
          </span>
        </label>
      )}
    </Modal>
  )
}
