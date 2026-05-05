'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../../../lib/supabaseClient'

interface MaterialOption {
  item_code: string
  item_name: string | null
}

interface SubstituteRule {
  id: number
  source_item_code: string
  substitute_item_code: string
  priority: number
  note: string | null
  created_at: string
  updated_at: string
}

interface DbErrorShape {
  code?: string
  message?: string
  details?: string
  hint?: string
}

export default function MaterialsSubstitutePage() {
  const [materials, setMaterials] = useState<MaterialOption[]>([])
  const [rules, setRules] = useState<SubstituteRule[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [keyword, setKeyword] = useState('')
  const [sourceItemCode, setSourceItemCode] = useState('')
  const [substituteItemCode, setSubstituteItemCode] = useState('')
  const [selectedSubstitutes, setSelectedSubstitutes] = useState<string[]>([])
  const [priority, setPriority] = useState(1)
  const [note, setNote] = useState('')

  const itemNameMap = useMemo(() => {
    const map = new Map<string, string>()
    materials.forEach((item) => {
      map.set(item.item_code, item.item_name || '-')
    })
    return map
  }, [materials])

  const getItemLabel = (itemCode: string) => {
    const itemName = itemNameMap.get(itemCode)
    return itemName ? `${itemCode}｜${itemName}` : itemCode
  }

  const filteredRules = useMemo(() => {
    const normalized = keyword.trim().toLowerCase()
    if (!normalized) return rules

    return rules.filter((rule) => {
      const sourceName = itemNameMap.get(rule.source_item_code) || ''
      const substituteName = itemNameMap.get(rule.substitute_item_code) || ''
      const combined = [
        rule.source_item_code,
        sourceName,
        rule.substitute_item_code,
        substituteName,
        rule.note || '',
      ]
        .join(' ')
        .toLowerCase()

      return combined.includes(normalized)
    })
  }, [rules, keyword, itemNameMap])

  const groupedFilteredRules = useMemo(() => {
    const sorted = [...filteredRules].sort((a, b) => {
      const sourceCompare = a.source_item_code.localeCompare(b.source_item_code)
      if (sourceCompare !== 0) return sourceCompare

      const priorityCompare = (a.priority || 0) - (b.priority || 0)
      if (priorityCompare !== 0) return priorityCompare

      return a.id - b.id
    })

    const groups = new Map<string, SubstituteRule[]>()
    sorted.forEach((rule) => {
      const list = groups.get(rule.source_item_code) || []
      list.push(rule)
      groups.set(rule.source_item_code, list)
    })

    return Array.from(groups.entries())
  }, [filteredRules])

  const formatDbErrorMessage = (error: DbErrorShape | null | undefined) => {
    if (!error) return '未知錯誤'

    const raw = [error.message, error.details, error.hint].filter(Boolean).join(' | ')

    if (error.code === '23505') {
      if (raw.includes('idx_material_substitute_rules_source_priority')) {
        return '同一主料號下已有相同優先順序，請更換優先順序後再試。'
      }
      if (raw.includes('material_substitute_rules_unique_pair')) {
        return '此主料號與替代料號配對已存在。'
      }
      return '資料重複（唯一鍵衝突），請檢查是否已建立相同規則。'
    }

    if (raw.includes('不可建立雙向替代')) {
      return '存在反向規則，系統不允許雙向替代。'
    }

    return raw || '未知錯誤'
  }

  const resetForm = () => {
    setEditingId(null)
    setSourceItemCode('')
    setSubstituteItemCode('')
    setSelectedSubstitutes([])
    setPriority(1)
    setNote('')
  }

  const fetchData = useCallback(async () => {
    setLoading(true)

    const [materialsResult, rulesResult] = await Promise.all([
      supabase
        .from('material_inventory_list')
        .select('item_code, item_name')
        .order('item_code', { ascending: true }),
      supabase
        .from('material_substitute_rules')
        .select('id, source_item_code, substitute_item_code, priority, note, created_at, updated_at')
        .order('source_item_code', { ascending: true })
        .order('priority', { ascending: true })
        .order('id', { ascending: true }),
    ])

    if (materialsResult.error) {
      alert(`讀取物料清單失敗：${materialsResult.error.message}`)
    } else {
      setMaterials((materialsResult.data as MaterialOption[]) || [])
    }

    if (rulesResult.error) {
      alert(`讀取替代規則失敗：${rulesResult.error.message}`)
      setRules([])
    } else {
      setRules((rulesResult.data as SubstituteRule[]) || [])
    }

    setLoading(false)
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const handleSubmit = async () => {
    if (!sourceItemCode) {
      alert('請先輸入或選擇主料號')
      return
    }

    setSaving(true)

    try {
      if (editingId !== null) {
        if (!substituteItemCode) {
          alert('編輯模式下請輸入替代料號')
          return
        }

        if (sourceItemCode === substituteItemCode) {
          alert('主料號與替代料號不可相同')
          return
        }

        const duplicatedRule = rules.some(
          (rule) =>
            rule.source_item_code === sourceItemCode &&
            rule.substitute_item_code === substituteItemCode &&
            rule.id !== editingId
        )

        if (duplicatedRule) {
          alert('此替代規則已存在')
          return
        }

        const reversedRule = rules.some(
          (rule) =>
            rule.source_item_code === substituteItemCode &&
            rule.substitute_item_code === sourceItemCode &&
            rule.id !== editingId
        )

        if (reversedRule) {
          alert(`已存在反向規則：${substituteItemCode} → ${sourceItemCode}，不可建立雙向替代`)
          return
        }

        const payload = {
          source_item_code: sourceItemCode,
          substitute_item_code: substituteItemCode,
          priority: Math.max(1, Number(priority) || 1),
          note: note.trim(),
        }

        const { error } = await supabase.from('material_substitute_rules').update(payload).eq('id', editingId)
        if (error) throw error

        alert('✅ 規則已更新')
      } else {
        if (selectedSubstitutes.length === 0) {
          alert('請先加入至少一個替代料號')
          return
        }

        if (selectedSubstitutes.includes(sourceItemCode)) {
          alert('主料號不可同時出現在替代料號清單')
          return
        }

        const hasDuplicate = selectedSubstitutes.some((code) =>
          rules.some(
            (rule) =>
              rule.source_item_code === sourceItemCode &&
              rule.substitute_item_code === code
          )
        )

        if (hasDuplicate) {
          alert('清單中有已存在的替代規則，請先調整')
          return
        }

        const hasReversed = selectedSubstitutes.some((code) =>
          rules.some(
            (rule) =>
              rule.source_item_code === code &&
              rule.substitute_item_code === sourceItemCode
          )
        )

        if (hasReversed) {
          alert('清單中有反向規則衝突（不可雙向替代），請先調整')
          return
        }

        const getLatestMaxPriority = async () => {
          const { data, error } = await supabase
            .from('material_substitute_rules')
            .select('priority')
            .eq('source_item_code', sourceItemCode)
            .order('priority', { ascending: false })
            .limit(1)

          if (error) throw error
          return data?.[0]?.priority ?? 0
        }

        const buildPayload = (basePriority: number) =>
          selectedSubstitutes.map((code, index) => ({
            source_item_code: sourceItemCode,
            substitute_item_code: code,
            priority: basePriority + index + 1,
            note: note.trim(),
          }))

        const firstBasePriority = await getLatestMaxPriority()
        let payload = buildPayload(firstBasePriority)

        let { error } = await supabase.from('material_substitute_rules').insert(payload)

        if (error?.code === '23505' && String(error.message || '').includes('idx_material_substitute_rules_source_priority')) {
          const retryBasePriority = await getLatestMaxPriority()
          payload = buildPayload(retryBasePriority)
          const retryResult = await supabase.from('material_substitute_rules').insert(payload)
          error = retryResult.error
        }

        if (error) throw error

        alert(`✅ 已建立 ${payload.length} 筆替代規則`)
      }

      resetForm()
      await fetchData()
    } catch (error) {
      const dbError = (error ?? {}) as DbErrorShape
      const message = formatDbErrorMessage(dbError)
      alert(`${editingId ? '更新' : '建立'}失敗：${message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (rule: SubstituteRule) => {
    setEditingId(rule.id)
    setSourceItemCode(rule.source_item_code)
    setSubstituteItemCode(rule.substitute_item_code)
    setPriority(rule.priority)
    setSelectedSubstitutes([])
    setNote(rule.note || '')
  }

  const handleAddSubstitute = () => {
    const code = substituteItemCode.trim()

    if (!code) {
      alert('請先輸入替代料號')
      return
    }

    if (!sourceItemCode.trim()) {
      alert('請先輸入主料號，再加入替代料號')
      return
    }

    if (code === sourceItemCode.trim()) {
      alert('替代料號不可等於主料號')
      return
    }

    if (selectedSubstitutes.includes(code)) {
      alert('替代料號清單中已存在此料號')
      return
    }

    setSelectedSubstitutes((prev) => [...prev, code])
    setSubstituteItemCode('')
  }

  const handleMoveSubstitute = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= selectedSubstitutes.length) return

    setSelectedSubstitutes((prev) => {
      const next = [...prev]
      const temp = next[index]
      next[index] = next[targetIndex]
      next[targetIndex] = temp
      return next
    })
  }

  const handleRemoveSubstitute = (code: string) => {
    setSelectedSubstitutes((prev) => prev.filter((item) => item !== code))
  }

  const handleDelete = async (rule: SubstituteRule) => {
    if (!confirm(`確定刪除替代規則？\n${rule.source_item_code} ← ${rule.substitute_item_code}`)) return

    setDeletingId(rule.id)
    const { error } = await supabase.from('material_substitute_rules').delete().eq('id', rule.id)
    setDeletingId(null)

    if (error) {
      alert(`刪除失敗：${error.message}`)
      return
    }

    if (editingId === rule.id) resetForm()
    await fetchData()
  }

  const handleExportCSV = () => {
    const header = ['主料號', '主料名稱', '替代料號', '替代料名稱', '優先順序', '備註', '更新時間']
    const rows = [...rules]
      .sort((a, b) => {
        const src = a.source_item_code.localeCompare(b.source_item_code)
        return src !== 0 ? src : a.priority - b.priority
      })
      .map((rule) => [
        rule.source_item_code,
        itemNameMap.get(rule.source_item_code) || '',
        rule.substitute_item_code,
        itemNameMap.get(rule.substitute_item_code) || '',
        rule.priority,
        rule.note || '',
        new Date(rule.updated_at).toLocaleString(),
      ])

    const csvContent = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `替代料號設定_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-4 md:p-8 max-w-[1400px] mx-auto min-h-screen text-slate-300 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white tracking-tight">替代料號設定</h1>
          <p className="text-orange-500 mt-1 font-mono text-sm uppercase">MATERIAL MANAGEMENT // SUBSTITUTE ITEM</p>
        </div>
        <Link
          href="/admin/argoerp/erp-db/inventory"
          className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm"
        >
          返回倉庫庫存表
        </Link>
      </div>

      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 space-y-4">
        <div className="text-sm text-slate-400">
          規則方向：<span className="text-white font-bold">主料號</span> 被 <span className="text-cyan-300 font-bold">替代料號</span> 取代（單向）。
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">主料號（被取代）</label>
            <input
              type="text"
              list="material-item-codes"
              value={sourceItemCode}
              onChange={(event) => setSourceItemCode(event.target.value.trim())}
              placeholder="可輸入或下拉選擇料號"
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:border-cyan-500 outline-none"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-500 mb-1">替代料號（可取代上方料號）</label>
            <input
              type="text"
              list="material-item-codes"
              value={substituteItemCode}
              onChange={(event) => setSubstituteItemCode(event.target.value.trim())}
              placeholder={editingId !== null ? '可輸入或下拉選擇料號' : '輸入後按「加入清單」'}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:border-cyan-500 outline-none"
            />
          </div>
        </div>

        {editingId === null ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleAddSubstitute}
                disabled={saving || loading}
                className="px-4 py-2 rounded border border-cyan-700 bg-cyan-900/30 text-cyan-300 hover:bg-cyan-900/50 text-sm font-bold disabled:opacity-50"
              >
                加入清單
              </button>
              <div className="text-xs text-slate-500 self-center">
                可一次加入多個替代料號，順序即優先順序（1 最優先）
              </div>
            </div>

            <div className="bg-black/20 border border-slate-800 rounded p-3 space-y-2">
              {selectedSubstitutes.length === 0 ? (
                <div className="text-sm text-slate-500">尚未加入替代料號</div>
              ) : (
                selectedSubstitutes.map((code, index) => (
                  <div key={`${code}-${index}`} className="flex items-center justify-between gap-3 bg-slate-900/70 border border-slate-700 rounded px-3 py-2">
                    <div>
                      <div className="text-xs text-slate-500">優先順序 {index + 1}</div>
                      <div className="font-mono text-emerald-300">{code}</div>
                      <div className="text-xs text-slate-500">{itemNameMap.get(code) || '-'}</div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleMoveSubstitute(index, -1)}
                        className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs"
                      >
                        上移
                      </button>
                      <button
                        onClick={() => handleMoveSubstitute(index, 1)}
                        className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs"
                      >
                        下移
                      </button>
                      <button
                        onClick={() => handleRemoveSubstitute(code)}
                        className="px-2 py-1 rounded border border-rose-700 text-rose-300 hover:bg-rose-900/30 text-xs"
                      >
                        移除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div>
            <label className="block text-xs text-slate-500 mb-1">優先順序（同主料號內）</label>
            <input
              type="number"
              min={1}
              value={priority}
              onChange={(event) => setPriority(Math.max(1, Number(event.target.value) || 1))}
              className="w-full md:w-[220px] bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:border-cyan-500 outline-none"
            />
          </div>
        )}

        <datalist id="material-item-codes">
          {materials.map((item) => (
            <option key={item.item_code} value={item.item_code} label={getItemLabel(item.item_code)} />
          ))}
        </datalist>

        <div>
          <label className="block text-xs text-slate-500 mb-1">備註（可選）</label>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="例如：材質同級，可直接替代"
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:border-cyan-500 outline-none"
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => void handleSubmit()}
            disabled={saving || loading}
            className="px-4 py-2 rounded border border-cyan-700 bg-cyan-900/30 text-cyan-300 hover:bg-cyan-900/50 text-sm font-bold disabled:opacity-50"
          >
            {saving ? '儲存中...' : editingId ? '更新規則' : '建立規則'}
          </button>

          {editingId !== null && (
            <button
              onClick={resetForm}
              disabled={saving}
              className="px-4 py-2 rounded border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 text-sm font-bold"
            >
              取消編輯
            </button>
          )}

          <button
            onClick={() => void fetchData()}
            disabled={loading || saving}
            className="px-4 py-2 rounded border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 text-sm font-bold disabled:opacity-50"
          >
            重新載入
          </button>
        </div>
      </div>

      <div className="bg-slate-900/60 border border-slate-700 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="text-sm text-slate-400">
            目前共 {rules.length} 筆替代規則，篩選後 {filteredRules.length} 筆（同主料號內依優先順序排列）
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜尋：料號 / 料名 / 備註"
              className="w-full md:w-[280px] bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:border-cyan-500 outline-none"
            />
            <button
              onClick={handleExportCSV}
              disabled={rules.length === 0}
              className="px-4 py-2 rounded border border-emerald-700 bg-emerald-900/30 text-emerald-300 hover:bg-emerald-900/50 text-sm font-bold whitespace-nowrap disabled:opacity-40"
            >
              匯出 CSV
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-slate-950 text-slate-300">
              <tr>
                <th className="p-3 text-left">優先</th>
                <th className="p-3 text-left">主料號（被取代）</th>
                <th className="p-3 text-left">替代料號（可取代）</th>
                <th className="p-3 text-left">備註</th>
                <th className="p-3 text-left">更新時間</th>
                <th className="p-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">讀取中...</td>
                </tr>
              ) : groupedFilteredRules.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    {rules.length === 0 ? '尚未建立替代規則' : '找不到符合關鍵字的規則'}
                  </td>
                </tr>
              ) : (
                groupedFilteredRules.flatMap(([sourceCode, sourceRules]) => [
                  <tr key={`group-${sourceCode}`} className="bg-slate-950/80">
                    <td colSpan={6} className="p-3 border-y border-slate-800">
                      <div className="text-xs text-slate-500">主料號分組</div>
                      <div className="font-mono text-cyan-300">{sourceCode}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{itemNameMap.get(sourceCode) || '-'}</div>
                    </td>
                  </tr>,
                  ...sourceRules.map((rule) => (
                    <tr key={rule.id} className="hover:bg-slate-800/30">
                      <td className="p-3 font-mono text-amber-300">{rule.priority}</td>
                      <td className="p-3">
                        <div className="font-mono text-cyan-300">{rule.source_item_code}</div>
                        <div className="text-xs text-slate-500 mt-0.5">{itemNameMap.get(rule.source_item_code) || '-'}</div>
                      </td>
                      <td className="p-3">
                        <div className="font-mono text-emerald-300">{rule.substitute_item_code}</div>
                        <div className="text-xs text-slate-500 mt-0.5">{itemNameMap.get(rule.substitute_item_code) || '-'}</div>
                      </td>
                      <td className="p-3 text-slate-300">{rule.note || '-'}</td>
                      <td className="p-3 text-slate-400">{new Date(rule.updated_at).toLocaleString()}</td>
                      <td className="p-3">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => handleEdit(rule)}
                            className="px-3 py-1 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-900/30 text-xs font-bold"
                          >
                            編輯
                          </button>
                          <button
                            onClick={() => void handleDelete(rule)}
                            disabled={deletingId === rule.id}
                            className="px-3 py-1 rounded border border-rose-700 text-rose-300 hover:bg-rose-900/30 text-xs font-bold disabled:opacity-50"
                          >
                            {deletingId === rule.id ? '刪除中...' : '刪除'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )),
                ])
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
