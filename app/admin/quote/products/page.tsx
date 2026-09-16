'use client'

/**
 * 後台 ① 品項維護 /admin/quote/products（設計書 §8-①、§9 SOP）。
 *
 * 列表 → 點「編輯」進表單改 ProductConfig（一般表單元件，底部有唯讀 JSON）→ 儲存
 * （POST update；route 端會把 status 退回 testing、version+1）。
 * golden 區：核可／退回（setGoldenStatus）→ 跑驗證（POST verify）→ gate=pass 才亮「發布」。
 *
 * 選中的品項用 ?id= 帶在網址上（Excel 匯入頁完成後可直接連過來）。
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { PackingMode, Plant, PrintMethod, ProductConfig, ProductStatus, Sides } from '@/lib/quote/types'
import type { AdminPriceRow, AdminProductRow, AdminProductsAction, GoldenRow, VerifyCaseResult, VerifyResponse } from '@/lib/quote/api'
import seedProducts from '@/lib/quote/seed/products.json'
import { adminFetch, cloneJson, fmtDateTime, fmtNum, fmtPct, pickArray, pickObject, sameJson } from '../_shared/api'
import {
  Badge, Btn, Check, Field, INPUT_CLS, JsonView, LoadingBlock, MONO, NotReadyBanner, Notice, NumInput, PageHeader, SaveBar, Section, TD_CLS, TH_CLS,
} from '../_shared/ui'

const API = '/api/quote/admin/products'
const API_VERIFY = '/api/quote/admin/verify'
const API_PRICES = '/api/quote/admin/prices'

const PRINT_ORDER: PrintMethod[] = ['7151', 'jingutian', 'koshi', 'none']
const PRINT_LABEL: Record<PrintMethod, string> = { '7151': '仿柯（7151）', jingutian: '仿柯（百川）', koshi: '柯式', none: '無印刷' }
const MODE_LABEL: Record<PackingMode, string> = {
  per_unit: '每件 × k',
  per_n_units: '每 n 件 1 個（進位）',
  per_box: '每箱 × k（n 件/箱）',
  fixed: '固定 × n 次',
}
const PLANT_LABEL: Record<Plant, string> = { changping: '常平廠（RMB）', taiwan: '台灣廠（TWD）' }
const SEGMENT_LABEL: Record<string, string> = { material: '材料', print: '印刷貼合清洗', cut: '切割', packLabor: '包裝人工', packMaterial: '包材配件' }
const SEGMENT_ORDER = ['material', 'print', 'cut', 'packLabor', 'packMaterial']

/** 新品項的 config 範本：直接拿 seed 鑰匙圈的設定（真實價格表品名），建立後再改 */
const TEMPLATE_CONFIG: ProductConfig = (seedProducts as unknown as { config: ProductConfig }[])[0]?.config ?? {
  boards: { options: [], defaultItem: '', sides: 1 },
  extraBoards: [],
  printMethods: ['7151', 'none'],
  defaultPrintMethod: '7151',
  petByMethod: {},
  kPet: 2,
  laminate: [{ item: '贴合', platesFrom: ['main'] }],
  wash: { item: '清洗', platesFrom: 'main' },
  cut: { t1: 12, t2: 0, t3: 0 },
  accessories: [],
  packing: [],
  scrapPct: 10,
  costRatio: 0.72,
  packCapacityPerHour: 100,
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/* ================================================================ 驗證 config */

function validateConfig(row: AdminProductRow): string[] {
  const e: string[] = []
  const c = row.config
  if (!row.name.trim()) e.push('品項名稱不可空白')
  if (!row.category.trim()) e.push('分類不可空白')
  if (!c.boards.options.length) e.push('板材：至少一個選項')
  c.boards.options.forEach((o, i) => { if (!o.item.trim()) e.push(`板材：第 ${i + 1} 個選項缺價格表品名`) })
  if (!c.boards.options.some((o) => (o.key ?? o.item) === c.boards.defaultItem)) e.push('板材：預設板材必須是選項之一')
  const optKeys = c.boards.options.map((o) => o.key ?? o.item)
  if (new Set(optKeys).size !== optKeys.length) e.push('板材：同一張主板出現在多個選項時，每個選項要各自填「選項 key」')
  const keys = new Set<string>(['main'])
  c.extraBoards.forEach((b, i) => {
    if (!b.key.trim()) e.push(`第二板材：第 ${i + 1} 列缺 key`)
    else if (keys.has(b.key)) e.push(`第二板材：key「${b.key}」重複（main 是主板保留字）`)
    keys.add(b.key)
    if (!b.item.trim() && !b.fromBoardOption) e.push(`第二板材「${b.key}」缺價格表品名（或勾「由板材選項帶入」）`)
    if (b.fromBoardOption && !c.boards.options.every((o) => o.pairItem)) e.push(`第二板材「${b.key}」由板材選項帶入，但有板材選項沒填「貼合第二板」`)
    if (b.nPerSheet != null && (!isNum(b.nPerSheet) || b.nPerSheet <= 0)) e.push(`第二板材「${b.key}」每盤數必須 > 0（留空＝跟主板）`)
  })
  if (!c.printMethods.length) e.push('印刷：至少勾一種方式')
  if (!c.printMethods.includes(c.defaultPrintMethod)) e.push('印刷：預設方式必須在已勾選的方式內')
  for (const m of c.printMethods) {
    if (m !== 'none' && !(c.petByMethod[m] ?? '').trim()) e.push(`印刷：${PRINT_LABEL[m]} 缺對應的 PET 品名`)
  }
  if (!isNum(c.kPet) || c.kPet <= 0) e.push('柯氏 k_pet 必須 > 0')
  c.laminate.forEach((l, i) => {
    if (!l.item.trim()) e.push(`貼合：第 ${i + 1} 列缺品名`)
    if (!l.platesFrom.length) e.push(`貼合：第 ${i + 1} 列至少選一張板`)
    for (const k of l.platesFrom) if (!keys.has(k)) e.push(`貼合：第 ${i + 1} 列引用不存在的板材 key「${k}」`)
  })
  if (!c.wash.item.trim()) e.push('清洗：缺品名')
  if (Array.isArray(c.wash.platesFrom)) {
    if (!c.wash.platesFrom.length) e.push('清洗：自訂板材清單至少選一張')
    for (const k of c.wash.platesFrom) if (!keys.has(k)) e.push(`清洗：引用不存在的板材 key「${k}」`)
  }
  for (const t of ['t1', 't2', 't3'] as const) if (!isNum(c.cut[t]) || c.cut[t] < 0) e.push(`切割：${t} 必須是 ≥ 0 的數字`)
  if (!isNum(c.scrapPct) || c.scrapPct < 0) e.push('報廢率必須是 ≥ 0 的數字')
  if (!isNum(c.costRatio) || c.costRatio <= 0 || c.costRatio > 1) e.push('成本率必須在 0 ~ 1 之間（例 0.72）')
  if (!isNum(c.packCapacityPerHour) || c.packCapacityPerHour <= 0) e.push('包裝產能必須 > 0')
  c.accessories.forEach((a, i) => {
    if (!a.item.trim()) e.push(`配件：第 ${i + 1} 列缺品名`)
    if (!isNum(a.k) || a.k <= 0) e.push(`配件「${a.item || i + 1}」用量 k 必須 > 0`)
  })
  c.packing.forEach((p, i) => {
    const label = p.item || String(i + 1)
    if (!p.item.trim()) e.push(`包裝：第 ${i + 1} 列缺品名`)
    if (p.mode === 'per_unit' && !(isNum(p.k) && p.k > 0)) e.push(`包裝「${label}」每件用量 k 必須 > 0`)
    if (p.mode === 'per_n_units' && !(isNum(p.n) && p.n > 0)) e.push(`包裝「${label}」每 n 件的 n 必須 > 0`)
    if (p.mode === 'per_box' && !(isNum(p.n) && p.n > 0 && isNum(p.k) && p.k > 0)) e.push(`包裝「${label}」每箱模式需 n（件/箱）與 k 都 > 0`)
    if (p.mode === 'fixed' && !(isNum(p.n) && p.n > 0)) e.push(`包裝「${label}」固定模式需 n（次數）> 0`)
  })
  return e
}

/* ================================================================ 頁面外殼 */

export default function QuoteProductsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <ProductsInner />
    </Suspense>
  )
}

function ProductsInner() {
  const router = useRouter()
  const sp = useSearchParams()
  const selectedId = sp.get('id')

  const [loading, setLoading] = useState(true)
  const [notReady, setNotReady] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [products, setProducts] = useState<AdminProductRow[]>([])
  const [goldensByProduct, setGoldensByProduct] = useState<Record<string, GoldenRow[] | undefined>>({})
  const [prices, setPrices] = useState<AdminPriceRow[]>([])
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [r, p] = await Promise.all([
      adminFetch<Record<string, unknown>>(API),
      adminFetch<Record<string, unknown>>(API_PRICES),
    ])
    if (!r.ok) {
      if (r.notReady) setNotReady(r.error)
      else setError(r.error)
      setLoading(false)
      return
    }
    const list = pickArray<AdminProductRow>(r.data, ['products', 'rows', 'items', 'data'])
    setProducts(list)
    // 列表回應若一併附 golden，就先分好；沒附的等選到品項再用 ?id= 補抓
    const goldens = pickArray<GoldenRow>(r.data, ['goldens', 'goldenCases', 'golden_cases', 'cases'])
    if (goldens.length || 'goldens' in r.data || 'goldenCases' in r.data || 'golden_cases' in r.data) {
      const map: Record<string, GoldenRow[]> = {}
      for (const pr of list) map[pr.id] = []
      for (const g of goldens) (map[g.product_id] ??= []).push(g)
      setGoldensByProduct(map)
    } else {
      setGoldensByProduct({})
    }
    if (p.ok) setPrices(pickArray<AdminPriceRow>(p.data, ['items', 'prices', 'rows', 'data']))
    setNotReady(null)
    setLoading(false)
  }, [])

  const loadGoldens = useCallback(async (productId: string) => {
    const r = await adminFetch<Record<string, unknown>>(`${API}?id=${encodeURIComponent(productId)}`)
    if (!r.ok) {
      if (r.notReady) setNotReady(r.error)
      setGoldensByProduct((prev) => ({ ...prev, [productId]: [] }))
      return
    }
    const all = pickArray<GoldenRow>(r.data, ['goldens', 'goldenCases', 'golden_cases', 'cases'])
    setGoldensByProduct((prev) => ({ ...prev, [productId]: all.filter((g) => g.product_id === productId) }))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(t)
  }, [load])

  useEffect(() => {
    if (!selectedId || loading) return
    if (goldensByProduct[selectedId] === undefined) void loadGoldens(selectedId)
  }, [selectedId, loading, goldensByProduct, loadGoldens])

  const selected = useMemo(() => products.find((p) => p.id === selectedId) ?? null, [products, selectedId])

  const select = (id: string | null) => {
    router.replace(id ? `/admin/quote/products?id=${encodeURIComponent(id)}` : '/admin/quote/products')
  }

  const post = async (body: AdminProductsAction): Promise<Record<string, unknown> | null> => {
    const r = await adminFetch<Record<string, unknown>>(API, { method: 'POST', body })
    if (!r.ok) {
      if (r.notReady) setNotReady(r.error)
      else setError(r.error)
      return null
    }
    return r.data
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto text-slate-300 min-h-screen font-sans">
      <PageHeader
        title="品項維護"
        subtitle="quote_products // 設定、驗證、發布"
        current="/admin/quote/products"
        actions={
          selected ? (
            <Btn onClick={() => select(null)}>← 回列表</Btn>
          ) : (
            <Btn variant="primary" onClick={() => setShowCreate((v) => !v)} disabled={!!notReady || loading}>＋ 新增品項</Btn>
          )
        }
      />

      {notReady && <NotReadyBanner message={notReady} />}
      {error && <Notice kind="error">{error}</Notice>}
      {okMsg && <Notice kind="ok">{okMsg}</Notice>}

      {loading ? (
        <LoadingBlock />
      ) : selected ? (
        <ProductEditor
          key={`${selected.id}:${selected.version}:${selected.updated_at}`}
          product={selected}
          goldens={goldensByProduct[selected.id]}
          prices={prices}
          post={post}
          setError={setError}
          setOkMsg={setOkMsg}
          setNotReady={setNotReady}
          reload={async () => { await load(); await loadGoldens(selected.id) }}
        />
      ) : (
        <>
          {showCreate && (
            <CreatePanel
              onCancel={() => setShowCreate(false)}
              onCreate={async (draft) => {
                setError(null)
                const res = await post({ action: 'create', product: draft })
                if (!res) return
                setShowCreate(false)
                setOkMsg(`已建立「${draft.name}」（草稿）。接著編輯設定、匯入 golden、跑驗證。`)
                await load()
                const created = pickObject<AdminProductRow>(res, ['product', 'row', 'data'])
                if (created?.id) select(created.id)
              }}
            />
          )}
          <ProductList products={products} goldensByProduct={goldensByProduct} onEdit={(id) => select(id)} />
        </>
      )}
    </div>
  )
}

/* ================================================================ 列表 */

function ProductList({ products, goldensByProduct, onEdit }: {
  products: AdminProductRow[]
  goldensByProduct: Record<string, GoldenRow[] | undefined>
  onEdit: (id: string) => void
}) {
  const sorted = useMemo(() => [...products].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-Hant')), [products])
  if (!sorted.length) {
    return <div className="text-center text-slate-500 py-16 border border-dashed border-slate-700 rounded-xl">還沒有品項。按右上「＋ 新增品項」建立第一個（MVP：壓克力鑰匙圈）。</div>
  }
  return (
    <div className="bg-slate-900/50 border border-slate-700 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead>
            <tr>
              <th className={TH_CLS}>品項</th>
              <th className={TH_CLS}>分類 / 廠別</th>
              <th className={TH_CLS}>狀態</th>
              <th className={`${TH_CLS} text-right`}>版本</th>
              <th className={TH_CLS}>Golden（核可/總數）</th>
              <th className={TH_CLS}>印刷方式</th>
              <th className={TH_CLS}>更新</th>
              <th className={TH_CLS}>發布時間</th>
              <th className={TH_CLS}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const gs = goldensByProduct[p.id]
              const approved = gs?.filter((g) => g.status === 'approved').length
              return (
                <tr key={p.id} className="hover:bg-slate-800/40 cursor-pointer" onClick={() => onEdit(p.id)}>
                  <td className={`${TD_CLS} font-bold text-white`}>{p.name}<div className="text-[11px] text-slate-500 font-normal">{p.config.boards.options.length} 種板材 · {p.config.accessories.length} 配件 · {p.config.packing.length} 包裝</div></td>
                  <td className={TD_CLS}>{p.category}<div className="text-[11px] text-slate-500">{PLANT_LABEL[p.plant] ?? p.plant}</div></td>
                  <td className={TD_CLS}><Badge value={p.status} /></td>
                  <td className={`${TD_CLS} text-right ${MONO}`}>v{p.version}</td>
                  <td className={`${TD_CLS} ${MONO}`}>{gs ? `${approved} / ${gs.length}` : '…'}</td>
                  <td className={`${TD_CLS} text-xs text-slate-400`}>{p.config.printMethods.map((m) => PRINT_LABEL[m] ?? m).join('、')}</td>
                  <td className={`${TD_CLS} text-[11px] text-slate-500 whitespace-nowrap`}>{p.updated_by ?? '—'}<br />{fmtDateTime(p.updated_at)}</td>
                  <td className={`${TD_CLS} text-[11px] text-slate-500 whitespace-nowrap`}>{fmtDateTime(p.published_at)}</td>
                  <td className={`${TD_CLS} text-right`}><Btn size="sm" onClick={(e) => { e.stopPropagation(); onEdit(p.id) }}>編輯</Btn></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ================================================================ 新增 */

type CreateDraft = Omit<AdminProductRow, 'id' | 'version' | 'updated_by' | 'updated_at' | 'published_at'>

function CreatePanel({ onCancel, onCreate }: { onCancel: () => void; onCreate: (d: CreateDraft) => Promise<void> }) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('壓克力')
  const [plant, setPlant] = useState<Plant>('changping')
  const [sortOrder, setSortOrder] = useState(100)
  const [busy, setBusy] = useState(false)
  return (
    <Section title="新增品項" desc="以 seed 鑰匙圈的設定當範本建立（狀態 draft），建立後再逐項調整。品項是資料不是程式：壓克力家族內新增品項不改 code。">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 items-end">
        <Field label="品項名稱 *" className="md:col-span-2"><input className={INPUT_CLS} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：鑰匙圈" /></Field>
        <Field label="分類"><input className={INPUT_CLS} value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
        <Field label="廠別">
          <select className={INPUT_CLS} value={plant} onChange={(e) => setPlant(e.target.value as Plant)}>
            {(Object.keys(PLANT_LABEL) as Plant[]).map((k) => <option key={k} value={k}>{PLANT_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="排序"><NumInput value={sortOrder} step={1} onChange={setSortOrder} /></Field>
      </div>
      <div className="flex gap-2 mt-4 justify-end">
        <Btn onClick={onCancel} disabled={busy}>取消</Btn>
        <Btn
          variant="primary"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true)
            await onCreate({
              family: 'acrylic', category: category.trim() || '壓克力', name: name.trim(), plant, status: 'draft',
              config: cloneJson(TEMPLATE_CONFIG), sort_order: isNum(sortOrder) ? sortOrder : 100,
            })
            setBusy(false)
          }}
        >
          {busy ? '建立中…' : '建立'}
        </Btn>
      </div>
    </Section>
  )
}

/* ================================================================ 編輯器 */

interface EditorProps {
  product: AdminProductRow
  goldens: GoldenRow[] | undefined
  prices: AdminPriceRow[]
  post: (body: AdminProductsAction) => Promise<Record<string, unknown> | null>
  setError: (s: string | null) => void
  setOkMsg: (s: string | null) => void
  setNotReady: (s: string | null) => void
  reload: () => Promise<void>
}

function ProductEditor({ product, goldens, prices, post, setError, setOkMsg, setNotReady, reload }: EditorProps) {
  const [orig] = useState<AdminProductRow>(() => cloneJson(product))
  const [draft, setDraft] = useState<AdminProductRow>(() => cloneJson(product))
  const [saving, setSaving] = useState(false)
  const [verify, setVerify] = useState<VerifyResponse | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [busyStatus, setBusyStatus] = useState(false)
  const [showJson, setShowJson] = useState(false)

  const dirty = useMemo(() => !sameJson(draft, orig), [draft, orig])
  const errors = useMemo(() => validateConfig(draft), [draft])

  const setCfg = (fn: (c: ProductConfig) => void) => {
    setDraft((prev) => {
      const next = cloneJson(prev)
      fn(next.config)
      return next
    })
  }
  const setRow = (patch: Partial<AdminProductRow>) => setDraft((prev) => ({ ...prev, ...patch }))

  /** 價格表品名的 datalist：依 group 分；找不到該 group 就退回全部品名 */
  const priceGroups = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of prices) {
      const g = p.group || '（未分組）'
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(p.name)
    }
    return m
  }, [prices])
  const listId = (group: string) => (priceGroups.has(group) ? `dl-${group}` : 'dl-all')

  const boardKeys = useMemo(() => ['main', ...draft.config.extraBoards.map((b) => b.key).filter(Boolean)], [draft.config.extraBoards])

  const save = async () => {
    if (errors.length) {
      alert(`請先修正：\n${errors.join('\n')}`)
      return
    }
    setSaving(true)
    setError(null)
    setOkMsg(null)
    const patch: NonNullable<Extract<AdminProductsAction, { action: 'update' }>['patch']> = {}
    if (draft.name !== orig.name) patch.name = draft.name.trim()
    if (draft.category !== orig.category) patch.category = draft.category.trim()
    if (draft.plant !== orig.plant) patch.plant = draft.plant
    if (draft.sort_order !== orig.sort_order) patch.sort_order = draft.sort_order
    if (!sameJson(draft.config, orig.config)) patch.config = draft.config
    const res = await post({ action: 'update', id: draft.id, patch })
    setSaving(false)
    if (!res) return
    setVerify(null)
    setOkMsg(patch.config
      ? '已儲存設定。改了 config 會自動退回「測試中」並版本 +1；請重新跑驗證，全過才能再發布。'
      : '已儲存基本資料。')
    await reload()
  }

  const runVerify = async () => {
    setVerifying(true)
    setError(null)
    setOkMsg(null)
    const r = await adminFetch<Record<string, unknown>>(API_VERIFY, { method: 'POST', body: { productId: draft.id, includeProposed: true } })
    setVerifying(false)
    if (!r.ok) {
      if (r.notReady) setNotReady(r.error)
      else setError(`跑驗證失敗：${r.error}`)
      return
    }
    const v = (Array.isArray(r.data.results) ? (r.data as unknown as VerifyResponse) : pickObject<VerifyResponse>(r.data, ['result', 'verify', 'data']))
    if (!v || !Array.isArray(v.results)) {
      setError('驗證回應缺少 results，請檢查 API 回應格式')
      return
    }
    // 先 reload（重讀 golden 的 last_result），再放本次結果；devSeed 模式沒有寫回、不必 reload
    // （而且 reload 會讓 editor 依 updated_at 重掛而丟掉結果）
    if (!(r.data as { devSeed?: boolean }).devSeed) await reload()
    setVerify(v)
  }

  const setStatus = async (status: ProductStatus) => {
    const label = status === 'published' ? '發布' : status === 'testing' ? '下架（退回測試中）' : '退回草稿'
    if (!confirm(`確定要${label}「${draft.name}」嗎？${status === 'published' ? '\n發布後業務在前台立刻看得到、可以算價。' : '\n下架後前台立刻看不到此品項。'}`)) return
    setBusyStatus(true)
    setError(null)
    const res = await post({ action: 'setStatus', id: draft.id, status })
    setBusyStatus(false)
    if (!res) return
    setOkMsg(`已${label}「${draft.name}」。`)
    await reload()
  }

  const setGoldenStatus = async (g: GoldenRow, status: 'approved' | 'rejected' | 'proposed') => {
    setError(null)
    const res = await post({ action: 'setGoldenStatus', goldenId: g.id, status })
    if (!res) return
    setVerify(null)
    await reload()
  }

  const approvedCount = goldens?.filter((g) => g.status === 'approved').length ?? 0
  const canPublish = !dirty && draft.status !== 'published' && verify?.gate === 'pass' && verify.productId === draft.id
  const publishHint = dirty ? '先儲存變更' : draft.status === 'published' ? '已是發布狀態' : !verify ? '先跑驗證' : verify.gate === 'no-approved-cases' ? '沒有已核可的 golden，先核可' : verify.gate === 'fail' ? '驗證未全過' : ''

  return (
    <>
      {/* 抬頭 */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-white">{draft.name || '（未命名）'}</h2>
        <Badge value={product.status} />
        <span className={`text-sm ${MONO} text-slate-400`}>v{product.version}</span>
        <span className="text-xs text-slate-500">更新：{product.updated_by ?? '—'} · {fmtDateTime(product.updated_at)}{product.published_at ? ` · 發布於 ${fmtDateTime(product.published_at)}` : ''}</span>
        <div className="flex-1" />
        {product.status === 'published'
          ? <Btn variant="danger" onClick={() => { void setStatus('testing') }} disabled={busyStatus}>下架</Btn>
          : <Btn variant="ok" onClick={() => { void setStatus('published') }} disabled={!canPublish || busyStatus} title={publishHint}>發布{publishHint ? `（${publishHint}）` : ''}</Btn>}
      </div>

      {/* datalist：價格表品名建議 */}
      <datalist id="dl-all">{prices.map((p) => <option key={p.id} value={p.name}>{p.display_name ?? ''}</option>)}</datalist>
      {[...priceGroups.entries()].map(([g, names]) => (
        <datalist key={g} id={`dl-${g}`}>{names.map((n) => <option key={n} value={n} />)}</datalist>
      ))}

      {/* 基本資料 */}
      <Section title="基本資料">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Field label="品項名稱 *" className="md:col-span-2"><input className={INPUT_CLS} value={draft.name} onChange={(e) => setRow({ name: e.target.value })} /></Field>
          <Field label="分類"><input className={INPUT_CLS} value={draft.category} onChange={(e) => setRow({ category: e.target.value })} /></Field>
          <Field label="廠別" hint="MVP 只做常平；台灣廠常數待 Snow 提供">
            <select className={INPUT_CLS} value={draft.plant} onChange={(e) => setRow({ plant: e.target.value as Plant })}>
              {(Object.keys(PLANT_LABEL) as Plant[]).map((k) => <option key={k} value={k}>{PLANT_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="排序"><NumInput value={draft.sort_order} step={1} onChange={(v) => setRow({ sort_order: v })} /></Field>
        </div>
      </Section>

      {/* 板材 */}
      <Section
        title="板材（主板）"
        desc="業務只選厚度；套版尺寸（29×39 等）掛在價格表該板材的 attrs，不在這裡。品名要跟價格表完全一致（有建議清單）。"
        actions={<Btn size="sm" onClick={() => setCfg((c) => { c.boards.options.push({ item: '', label: '' }) })}>＋ 新增板材選項</Btn>}
      >
        <table className="w-full mb-4">
          <thead><tr><th className={TH_CLS}>選項 key</th><th className={TH_CLS}>價格表品名（主板）</th><th className={TH_CLS}>貼合第二板（選填）</th><th className={TH_CLS}>顯示短標</th><th className={TH_CLS}>預設</th><th className={TH_CLS}></th></tr></thead>
          <tbody>
            {draft.config.boards.options.map((o, i) => (
              <tr key={i}>
                <td className={`${TD_CLS} w-24`}><input className={`${INPUT_CLS} ${MONO}`} value={o.key ?? ''} placeholder="同 item" onChange={(e) => setCfg((c) => { c.boards.options[i].key = e.target.value.trim() || undefined })} /></td>
                <td className={TD_CLS}><input className={INPUT_CLS} list={listId('板材')} value={o.item} onChange={(e) => setCfg((c) => { c.boards.options[i].item = e.target.value })} /></td>
                <td className={TD_CLS}><input className={INPUT_CLS} list={listId('板材')} value={o.pairItem ?? ''} placeholder="2貼2 這種雙板貼合才填" onChange={(e) => setCfg((c) => { c.boards.options[i].pairItem = e.target.value || undefined })} /></td>
                <td className={`${TD_CLS} w-40`}><input className={INPUT_CLS} value={o.label ?? ''} placeholder="例 300 × 400 × 2.8 / 2 貼 2" onChange={(e) => setCfg((c) => { c.boards.options[i].label = e.target.value || undefined })} /></td>
                <td className={`${TD_CLS} w-16 text-center`}>
                  <input type="radio" name="board-default" className="accent-amber-500" checked={draft.config.boards.defaultItem === (o.key ?? o.item) && !!o.item} onChange={() => setCfg((c) => { c.boards.defaultItem = o.key ?? o.item })} />
                </td>
                <td className={`${TD_CLS} w-16 text-right`}><Btn size="sm" variant="danger" onClick={() => setCfg((c) => { c.boards.options.splice(i, 1) })}>刪除</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field label="亞克力單／雙面（sides_a）" hint="L8：影響主板盤數 C9 = ROUNDUP(Q/N) × sides">
            <select className={INPUT_CLS} value={draft.config.boards.sides} onChange={(e) => setCfg((c) => { c.boards.sides = Number(e.target.value) as Sides })}>
              <option value={1}>單面（1）</option><option value={2}>雙面（2）</option>
            </select>
          </Field>
        </div>
      </Section>

      {/* 第二板材 */}
      <Section
        title="第二板材 / 第二膜（extra_boards）"
        desc="登山勾這種雙板材品項用。每盤數直接手填（登山沟 C10 = E9/66 的 66），留空＝跟主板；貼合款（2貼2）勾「由板材選項帶入」，板材由上面選項的「貼合第二板」決定；是否進位、進印刷／貼合／切割段各自勾。"
        actions={<Btn size="sm" onClick={() => setCfg((c) => { c.extraBoards.push({ key: `acc${c.extraBoards.length + 1}`, item: '', nPerSheet: 66, roundup: false, sides: 1, printed: true, laminated: true, cut: false }) })}>＋ 新增第二板材</Btn>}
      >
        {draft.config.extraBoards.length === 0 ? (
          <div className="text-xs text-slate-500">無（鑰匙圈預設只有主板）</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead><tr><th className={TH_CLS}>key</th><th className={TH_CLS}>價格表品名</th><th className={TH_CLS}>由板材選項帶入</th><th className={TH_CLS}>每盤數 N2</th><th className={TH_CLS}>進位</th><th className={TH_CLS}>面</th><th className={TH_CLS}>印刷</th><th className={TH_CLS}>貼合</th><th className={TH_CLS}>切割</th><th className={TH_CLS}></th></tr></thead>
              <tbody>
                {draft.config.extraBoards.map((b, i) => (
                  <tr key={i}>
                    <td className={`${TD_CLS} w-24`}><input className={`${INPUT_CLS} ${MONO}`} value={b.key} onChange={(e) => setCfg((c) => { c.extraBoards[i].key = e.target.value.trim() })} /></td>
                    <td className={TD_CLS}><input className={INPUT_CLS} list={listId('板材')} value={b.item} disabled={!!b.fromBoardOption} placeholder={b.fromBoardOption ? '由板材選項決定' : ''} onChange={(e) => setCfg((c) => { c.extraBoards[i].item = e.target.value })} /></td>
                    <td className={`${TD_CLS} w-16`}><Check checked={!!b.fromBoardOption} onChange={(v) => setCfg((c) => { c.extraBoards[i].fromBoardOption = v || undefined; if (v) c.extraBoards[i].item = '' })} label="" /></td>
                    <td className={`${TD_CLS} w-28`}><NumInput value={b.nPerSheet ?? null} placeholder="跟主板" onChange={(v) => setCfg((c) => { c.extraBoards[i].nPerSheet = v > 0 ? v : undefined })} /></td>
                    <td className={`${TD_CLS} w-20`}><Check checked={b.roundup} onChange={(v) => setCfg((c) => { c.extraBoards[i].roundup = v })} label="" /></td>
                    <td className={`${TD_CLS} w-24`}>
                      <select className={INPUT_CLS} value={b.sides} onChange={(e) => setCfg((c) => { c.extraBoards[i].sides = Number(e.target.value) as Sides })}><option value={1}>1</option><option value={2}>2</option></select>
                    </td>
                    <td className={`${TD_CLS} w-16`}><Check checked={b.printed} onChange={(v) => setCfg((c) => { c.extraBoards[i].printed = v })} label="" /></td>
                    <td className={`${TD_CLS} w-16`}><Check checked={b.laminated} onChange={(v) => setCfg((c) => { c.extraBoards[i].laminated = v })} label="" /></td>
                    <td className={`${TD_CLS} w-16`}><Check checked={b.cut} onChange={(v) => setCfg((c) => { c.extraBoards[i].cut = v })} label="" /></td>
                    <td className={`${TD_CLS} w-16 text-right`}><Btn size="sm" variant="danger" onClick={() => setCfg((c) => { c.extraBoards.splice(i, 1) })}>刪除</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[11px] text-slate-500 mt-2">※ 旗標 cut.second_board_excluded=true 時，這裡的「切割」勾了也不進切割段（Excel 現況）。</div>
          </div>
        )}
      </Section>

      {/* 印刷 */}
      <Section title="印刷方式與 PET" desc="仿柯：PET 盤數 = ROUNDUP(Q/N) × sides_p；柯式：C9 ÷ k_pet × 1.1 + 600（版數 V 由業務填）；無印刷不用 PET。">
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <div className="text-xs text-slate-400 mb-2">允許的印刷方式（前台只列勾到的）</div>
            <div className="flex flex-wrap gap-4 mb-4">
              {PRINT_ORDER.map((m) => (
                <Check
                  key={m}
                  checked={draft.config.printMethods.includes(m)}
                  label={PRINT_LABEL[m]}
                  onChange={(on) => setCfg((c) => {
                    c.printMethods = on ? PRINT_ORDER.filter((x) => x === m || c.printMethods.includes(x)) : c.printMethods.filter((x) => x !== m)
                    if (!c.printMethods.includes(c.defaultPrintMethod) && c.printMethods.length) c.defaultPrintMethod = c.printMethods[0]
                  })}
                />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="預設印刷方式">
                <select className={INPUT_CLS} value={draft.config.defaultPrintMethod} onChange={(e) => setCfg((c) => { c.defaultPrintMethod = e.target.value as PrintMethod })}>
                  {draft.config.printMethods.map((m) => <option key={m} value={m}>{PRINT_LABEL[m]}</option>)}
                </select>
              </Field>
              <Field label="柯氏 k_pet（每張 PET 貼幾盤）" hint="C11 的 /2；5CM色纸／老屋顏 = 1">
                <NumInput value={draft.config.kPet} onChange={(v) => setCfg((c) => { c.kPet = v })} />
              </Field>
              <Field label="PET 面數（L9）" hint="單板雙面＝兩面各一張 PET（跟印刷面數）；貼合款（2貼1 這種夾中間的）是彩白彩單張 PET，固定 1">
                <select className={INPUT_CLS} value={draft.config.petSides ?? ''} onChange={(e) => setCfg((c) => { c.petSides = e.target.value ? (Number(e.target.value) as Sides) : undefined })}>
                  <option value="">跟印刷面數（雙面 PET ×2）</option><option value={1}>固定 1（貼合款）</option><option value={2}>固定 2</option>
                </select>
              </Field>
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-2">各印刷方式對應的 PET 品名（價格表）</div>
            <div className="space-y-3">
              {draft.config.printMethods.filter((m) => m !== 'none').map((m) => (
                <Field key={m} label={PRINT_LABEL[m]}>
                  <input className={INPUT_CLS} list={listId('PET')} value={draft.config.petByMethod[m] ?? ''} onChange={(e) => setCfg((c) => { c.petByMethod[m] = e.target.value })} />
                </Field>
              ))}
              {draft.config.printMethods.filter((m) => m !== 'none').length === 0 && <div className="text-xs text-slate-500">（只有無印刷，不需要 PET）</div>}
            </div>
          </div>
        </div>
      </Section>

      {/* 貼合與清洗 */}
      <Section
        title="貼合與清洗"
        desc="貼合列可多列（冰箱贴第二列再貼軟磁）；盤數來源勾板材 key。清洗盤數：主板 C9／貼合盤數 C18／自訂板材清單；倍率給冰箱贴 C9×3 這種。"
        actions={<Btn size="sm" onClick={() => setCfg((c) => { c.laminate.push({ item: '贴合', platesFrom: ['main'] }) })}>＋ 新增貼合列</Btn>}
      >
        <table className="w-full mb-4">
          <thead><tr><th className={TH_CLS}>貼合品名（價格表）</th><th className={TH_CLS}>盤數來源（板材 key）</th><th className={TH_CLS}></th></tr></thead>
          <tbody>
            {draft.config.laminate.map((l, i) => (
              <tr key={i}>
                <td className={`${TD_CLS} w-1/2`}><input className={INPUT_CLS} list={listId('工序')} value={l.item} onChange={(e) => setCfg((c) => { c.laminate[i].item = e.target.value })} /></td>
                <td className={TD_CLS}>
                  <div className="flex flex-wrap gap-3">
                    {boardKeys.map((k) => (
                      <Check key={k} label={<span className={MONO}>{k}</span>} checked={l.platesFrom.includes(k)} onChange={(on) => setCfg((c) => {
                        const cur = c.laminate[i].platesFrom
                        c.laminate[i].platesFrom = on ? [...cur.filter((x) => x !== k), k] : cur.filter((x) => x !== k)
                      })} />
                    ))}
                  </div>
                </td>
                <td className={`${TD_CLS} w-16 text-right`}><Btn size="sm" variant="danger" onClick={() => setCfg((c) => { c.laminate.splice(i, 1) })}>刪除</Btn></td>
              </tr>
            ))}
            {draft.config.laminate.length === 0 && <tr><td className={`${TD_CLS} text-xs text-slate-500`} colSpan={3}>無貼合（F 款這種只有板的品項）</td></tr>}
          </tbody>
        </table>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field label="清洗品名（價格表）"><input className={INPUT_CLS} list={listId('工序')} value={draft.config.wash.item} onChange={(e) => setCfg((c) => { c.wash.item = e.target.value })} /></Field>
          <Field label="清洗盤數來源">
            <select
              className={INPUT_CLS}
              value={Array.isArray(draft.config.wash.platesFrom) ? 'custom' : draft.config.wash.platesFrom}
              onChange={(e) => setCfg((c) => { c.wash.platesFrom = e.target.value === 'custom' ? ['main'] : (e.target.value as 'main' | 'laminate') })}
            >
              <option value="main">主板盤數 C9</option>
              <option value="laminate">貼合盤數 C18</option>
              <option value="custom">自訂板材清單</option>
            </select>
          </Field>
          {Array.isArray(draft.config.wash.platesFrom) && (
            <Field label="自訂板材 key">
              <div className="flex flex-wrap gap-3 pt-2">
                {boardKeys.map((k) => (
                  <Check key={k} label={<span className={MONO}>{k}</span>} checked={(draft.config.wash.platesFrom as string[]).includes(k)} onChange={(on) => setCfg((c) => {
                    const cur = Array.isArray(c.wash.platesFrom) ? c.wash.platesFrom : []
                    c.wash.platesFrom = on ? [...cur.filter((x) => x !== k), k] : cur.filter((x) => x !== k)
                  })} />
                ))}
              </div>
            </Field>
          )}
          <Field label="清洗倍率（可留空）" hint="冰箱贴 C9×3 → 3">
            <NumInput value={draft.config.wash.multiplier ?? null} placeholder="1" onChange={(v) => setCfg((c) => { if (Number.isFinite(v)) c.wash.multiplier = v; else delete c.wash.multiplier })} />
          </Field>
        </div>
      </Section>

      {/* 切割與成本參數 */}
      <Section title="切割時間與成本參數" desc="t1/t2/t3 = 外形／銑槽／蓋板 分/板（L10:L12）；t=0 該段整段 0。報廢率 L5、成本率 C5（直接輸入 0.72 這種）、包裝產能 L7 個/人時。前台可覆寫。">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <Field label="外形 t1（分/板）"><NumInput value={draft.config.cut.t1} onChange={(v) => setCfg((c) => { c.cut.t1 = v })} /></Field>
          <Field label="銑槽 t2（分/板）"><NumInput value={draft.config.cut.t2} onChange={(v) => setCfg((c) => { c.cut.t2 = v })} /></Field>
          <Field label="蓋板 t3（分/板）"><NumInput value={draft.config.cut.t3} onChange={(v) => setCfg((c) => { c.cut.t3 = v })} /></Field>
          <Field label="報廢率 s（%）" hint="10；2026-08 後部分 15"><NumInput value={draft.config.scrapPct} onChange={(v) => setCfg((c) => { c.scrapPct = v })} /></Field>
          <Field label="成本率 r" hint="報價 = 成本 ÷ r"><NumInput value={draft.config.costRatio} step={0.01} onChange={(v) => setCfg((c) => { c.costRatio = v })} /></Field>
          <Field label="包裝產能 P（個/人時）" hint="實案 60~200"><NumInput value={draft.config.packCapacityPerHour} onChange={(v) => setCfg((c) => { c.packCapacityPerHour = v })} /></Field>
        </div>
      </Section>

      {/* 配件 */}
      <Section
        title="配件（五金等）"
        desc="每件用量 k（登山勾小龍蝦扣每套 2 顆 → k=2）；「預設勾選」前台預先打勾；「階梯單價」= 單價依數量手填（纸卡 0.25/0.3/0.5），前台讓業務改單價。"
        actions={<Btn size="sm" onClick={() => setCfg((c) => { c.accessories.push({ item: '', k: 1, defaultOn: false }) })}>＋ 新增配件</Btn>}
      >
        <table className="w-full">
          <thead><tr><th className={TH_CLS}>價格表品名</th><th className={TH_CLS}>用量 k</th><th className={TH_CLS}>預設勾選</th><th className={TH_CLS}>階梯單價</th><th className={TH_CLS}>順序</th><th className={TH_CLS}></th></tr></thead>
          <tbody>
            {draft.config.accessories.map((a, i) => (
              <tr key={i}>
                <td className={TD_CLS}><input className={INPUT_CLS} list={listId('五金')} value={a.item} onChange={(e) => setCfg((c) => { c.accessories[i].item = e.target.value })} /></td>
                <td className={`${TD_CLS} w-24`}><NumInput value={a.k} onChange={(v) => setCfg((c) => { c.accessories[i].k = v })} /></td>
                <td className={`${TD_CLS} w-24`}><Check checked={a.defaultOn} onChange={(v) => setCfg((c) => { c.accessories[i].defaultOn = v })} label="" /></td>
                <td className={`${TD_CLS} w-24`}><Check checked={!!a.tierPrices} onChange={(v) => setCfg((c) => { if (v) c.accessories[i].tierPrices = true; else delete c.accessories[i].tierPrices })} label="" /></td>
                <td className={`${TD_CLS} w-20 whitespace-nowrap`}>
                  <Btn size="sm" variant="link" disabled={i === 0} onClick={() => setCfg((c) => { const t = c.accessories[i - 1]; c.accessories[i - 1] = c.accessories[i]; c.accessories[i] = t })}>↑</Btn>
                  <Btn size="sm" variant="link" disabled={i === draft.config.accessories.length - 1} onClick={() => setCfg((c) => { const t = c.accessories[i + 1]; c.accessories[i + 1] = c.accessories[i]; c.accessories[i] = t })}>↓</Btn>
                </td>
                <td className={`${TD_CLS} w-16 text-right`}><Btn size="sm" variant="danger" onClick={() => setCfg((c) => { c.accessories.splice(i, 1) })}>刪除</Btn></td>
              </tr>
            ))}
            {draft.config.accessories.length === 0 && <tr><td className={`${TD_CLS} text-xs text-slate-500`} colSpan={6}>無配件</td></tr>}
          </tbody>
        </table>
      </Section>

      {/* 包裝 */}
      <Section
        title="包裝材料"
        desc="數量模式：每件×k（OPP 小袋）、每 n 件 1 個進位（中袋 n=20、紙箱 n=200）、每箱×k（出貨平卡 = 紙箱數×2，n 為每箱件數）、固定×n（開版費）。"
        actions={<Btn size="sm" onClick={() => setCfg((c) => { c.packing.push({ item: '', mode: 'per_unit', k: 1, defaultOn: true }) })}>＋ 新增包裝項</Btn>}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead><tr><th className={TH_CLS}>價格表品名</th><th className={TH_CLS}>數量模式</th><th className={TH_CLS}>k</th><th className={TH_CLS}>n</th><th className={TH_CLS}>預設勾選</th><th className={TH_CLS}>順序</th><th className={TH_CLS}></th></tr></thead>
            <tbody>
              {draft.config.packing.map((p, i) => {
                const needK = p.mode === 'per_unit' || p.mode === 'per_box'
                const needN = p.mode !== 'per_unit'
                return (
                  <tr key={i}>
                    <td className={TD_CLS}><input className={INPUT_CLS} list={listId('包材')} value={p.item} onChange={(e) => setCfg((c) => { c.packing[i].item = e.target.value })} /></td>
                    <td className={`${TD_CLS} w-52`}>
                      <select className={INPUT_CLS} value={p.mode} onChange={(e) => setCfg((c) => { c.packing[i].mode = e.target.value as PackingMode })}>
                        {(Object.keys(MODE_LABEL) as PackingMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                      </select>
                    </td>
                    <td className={`${TD_CLS} w-24`}><NumInput value={p.k ?? null} disabled={!needK} placeholder={needK ? '' : '—'} onChange={(v) => setCfg((c) => { if (Number.isFinite(v)) c.packing[i].k = v; else delete c.packing[i].k })} /></td>
                    <td className={`${TD_CLS} w-24`}><NumInput value={p.n ?? null} disabled={!needN} placeholder={needN ? '' : '—'} onChange={(v) => setCfg((c) => { if (Number.isFinite(v)) c.packing[i].n = v; else delete c.packing[i].n })} /></td>
                    <td className={`${TD_CLS} w-24`}><Check checked={!!p.defaultOn} onChange={(v) => setCfg((c) => { c.packing[i].defaultOn = v })} label="" /></td>
                    <td className={`${TD_CLS} w-20 whitespace-nowrap`}>
                      <Btn size="sm" variant="link" disabled={i === 0} onClick={() => setCfg((c) => { const t = c.packing[i - 1]; c.packing[i - 1] = c.packing[i]; c.packing[i] = t })}>↑</Btn>
                      <Btn size="sm" variant="link" disabled={i === draft.config.packing.length - 1} onClick={() => setCfg((c) => { const t = c.packing[i + 1]; c.packing[i + 1] = c.packing[i]; c.packing[i] = t })}>↓</Btn>
                    </td>
                    <td className={`${TD_CLS} w-16 text-right`}><Btn size="sm" variant="danger" onClick={() => setCfg((c) => { c.packing.splice(i, 1) })}>刪除</Btn></td>
                  </tr>
                )
              })}
              {draft.config.packing.length === 0 && <tr><td className={`${TD_CLS} text-xs text-slate-500`} colSpan={7}>無包裝項</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 進階 JSON */}
      <Section title="進階：檢視 JSON（唯讀）" actions={<Btn size="sm" onClick={() => setShowJson((v) => !v)}>{showJson ? '收合' : '展開'}</Btn>}>
        {showJson ? <JsonView value={draft.config} /> : <div className="text-xs text-slate-500">quote_products.config 目前內容（含尚未儲存的修改）。</div>}
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
        onReset={() => setDraft(cloneJson(orig))}
        extra={dirty && !sameJson(draft.config, orig.config) ? <span className="text-xs text-yellow-300">儲存 config 會退回「測試中」、版本 +1</span> : undefined}
      />

      {/* ------------------------------------------------ golden 與驗證 */}
      <div className="mt-8" />
      <Section
        title={`驗證案例 Golden（已核可 ${approvedCount} / 共 ${goldens?.length ?? 0}）`}
        desc="匯入後為「待核可」，Snow 核可才成發布閘門。跑驗證會用每筆自己的 settings_snapshot 覆蓋現價（驗邏輯不驗現價），誤差 < tolerance 才 PASS。"
        actions={
          <>
            <Btn onClick={() => { void runVerify() }} disabled={verifying || dirty || !goldens?.length} title={dirty ? '先儲存變更' : undefined}>{verifying ? '驗證中…' : '跑驗證'}</Btn>
          </>
        }
      >
        {goldens === undefined ? (
          <LoadingBlock text="載入 golden…" />
        ) : goldens.length === 0 ? (
          <div className="text-xs text-slate-500">此品項還沒有 golden case。到「Excel 匯入」上傳該品項的 报价模板，每個數量分頁會產生一筆待核可案例。</div>
        ) : (
          <GoldenTable goldens={goldens} onSetStatus={setGoldenStatus} />
        )}

        {verify && verify.productId === draft.id && (
          <div className="mt-6">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-sm font-bold text-white">驗證結果</span>
              <Badge value={verify.gate} label={verify.gate === 'pass' ? '閘門 PASS' : verify.gate === 'fail' ? '閘門 FAIL' : undefined} />
              <span className="text-xs text-slate-500">閘門只看 approved 的案例；其他狀態的案例照跑供參考。</span>
            </div>
            <VerifyTable results={verify.results} />
          </div>
        )}
      </Section>
    </>
  )
}

/* ================================================================ golden 表 */

function GoldenTable({ goldens, onSetStatus }: { goldens: GoldenRow[]; onSetStatus: (g: GoldenRow, s: 'approved' | 'rejected' | 'proposed') => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (g: GoldenRow, s: 'approved' | 'rejected' | 'proposed') => {
    setBusy(g.id)
    await onSetStatus(g, s)
    setBusy(null)
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px]">
        <thead>
          <tr>
            <th className={TH_CLS}>案例</th>
            <th className={TH_CLS}>狀態</th>
            <th className={TH_CLS}>模板版本 / 來源</th>
            <th className={`${TH_CLS} text-right`}>期望成本</th>
            <th className={`${TH_CLS} text-right`}>期望報價</th>
            <th className={`${TH_CLS} text-right`}>容差</th>
            <th className={TH_CLS}>上次結果</th>
            <th className={TH_CLS}>核可</th>
            <th className={TH_CLS}></th>
          </tr>
        </thead>
        <tbody>
          {goldens.map((g) => {
            const diff = g.last_diff as Record<string, unknown> | null
            const isOpen = open === g.id
            return (
              <GoldenRows key={g.id} g={g} diff={diff} isOpen={isOpen} busy={busy === g.id} onToggle={() => setOpen(isOpen ? null : g.id)} onAct={(s) => { void act(g, s) }} />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function GoldenRows({ g, diff, isOpen, busy, onToggle, onAct }: {
  g: GoldenRow; diff: Record<string, unknown> | null; isOpen: boolean; busy: boolean
  onToggle: () => void; onAct: (s: 'approved' | 'rejected' | 'proposed') => void
}) {
  return (
    <>
      <tr className="hover:bg-slate-800/40">
        <td className={`${TD_CLS} font-bold text-white min-w-[220px]`}>{g.name}</td>
        <td className={TD_CLS}><Badge value={g.status} /></td>
        <td className={`${TD_CLS} text-xs text-slate-400`}>
          <div>{g.template_version ?? '—'}</div>
          <div className="text-slate-500 truncate max-w-[280px]" title={`${g.source_file ?? ''} / ${g.source_sheet ?? ''}`}>{g.source_file ?? '—'}{g.source_sheet ? ` / ${g.source_sheet}` : ''}</div>
        </td>
        <td className={`${TD_CLS} text-right ${MONO}`}>{fmtNum(g.expected_cost, 6)}</td>
        <td className={`${TD_CLS} text-right ${MONO}`}>{fmtNum(g.expected_price, 6)}</td>
        <td className={`${TD_CLS} text-right ${MONO} text-slate-400`}>{fmtPct(g.tolerance, 1)}</td>
        <td className={`${TD_CLS} text-xs`}>
          <div className="flex items-center gap-2">
            <Badge value={g.last_result} />
            <span className="text-slate-500">{g.last_run_at ? fmtDateTime(g.last_run_at) : '未跑過'}</span>
          </div>
        </td>
        <td className={`${TD_CLS} text-[11px] text-slate-500 whitespace-nowrap`}>{g.approved_by ?? '—'}<br />{fmtDateTime(g.approved_at)}</td>
        <td className={`${TD_CLS} whitespace-nowrap text-right`}>
          <div className="flex gap-1 justify-end">
            {g.status !== 'approved' && <Btn size="sm" variant="ok" disabled={busy} onClick={() => onAct('approved')}>核可</Btn>}
            {g.status !== 'rejected' && <Btn size="sm" variant="danger" disabled={busy} onClick={() => onAct('rejected')}>退回</Btn>}
            {g.status !== 'proposed' && <Btn size="sm" disabled={busy} onClick={() => onAct('proposed')}>改回待核可</Btn>}
            <Btn size="sm" variant="link" onClick={onToggle}>{isOpen ? '收合' : '檢視'}</Btn>
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={9} className="px-2 pb-4 border-b border-slate-800">
            <div className="grid lg:grid-cols-3 gap-4 mt-2">
              <div><div className="text-xs text-slate-400 mb-1">input（引擎輸入）</div><JsonView value={g.input} maxHeight="18rem" /></div>
              <div><div className="text-xs text-slate-400 mb-1">settings_snapshot（當時常數）</div><JsonView value={g.settings_snapshot} maxHeight="18rem" /></div>
              <div><div className="text-xs text-slate-400 mb-1">last_diff（上次差異）</div>{diff ? <JsonView value={diff} maxHeight="18rem" /> : <div className="text-xs text-slate-500">尚未跑過驗證</div>}</div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/* ================================================================ 驗證結果表 */

function VerifyTable({ results }: { results: VerifyCaseResult[] }) {
  const segKeys = useMemo(() => {
    const present = new Set<string>()
    for (const r of results) for (const s of r.segments ?? []) present.add(s.key)
    return [...SEGMENT_ORDER.filter((k) => present.has(k)), ...[...present].filter((k) => !SEGMENT_ORDER.includes(k))]
  }, [results])
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px]">
        <thead>
          <tr>
            <th className={TH_CLS}>案例</th>
            <th className={TH_CLS}>狀態</th>
            <th className={TH_CLS}>結果</th>
            {segKeys.map((k) => <th key={k} className={`${TH_CLS} text-right`}>{SEGMENT_LABEL[k] ?? k}</th>)}
            <th className={`${TH_CLS} text-right`}>成本 算出 / 期望</th>
            <th className={`${TH_CLS} text-right`}>成本誤差</th>
            <th className={`${TH_CLS} text-right`}>報價 算出 / 期望</th>
            <th className={`${TH_CLS} text-right`}>報價誤差</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const segMap = new Map((r.segments ?? []).map((s) => [s.key, s.amount]))
            return (
              <tr key={r.goldenId} className={r.pass ? 'bg-emerald-950/10' : 'bg-red-950/10'}>
                <td className={`${TD_CLS} font-bold text-white min-w-[220px]`}>
                  {r.name}
                  {r.error && <div className="text-[11px] text-red-300 font-normal whitespace-pre-wrap">{r.error}</div>}
                </td>
                <td className={TD_CLS}><Badge value={r.status} /></td>
                <td className={TD_CLS}><Badge value={r.pass ? 'pass' : 'fail'} /></td>
                {segKeys.map((k) => <td key={k} className={`${TD_CLS} text-right ${MONO} text-slate-300`}>{fmtNum(segMap.get(k), 4)}</td>)}
                <td className={`${TD_CLS} text-right ${MONO}`}><span className="text-white">{fmtNum(r.gotCost, 6)}</span><span className="text-slate-500"> / {fmtNum(r.expectedCost, 6)}</span></td>
                <td className={`${TD_CLS} text-right ${MONO} ${Math.abs(r.errCost) < 0.01 ? 'text-emerald-300' : 'text-red-300'}`}>{fmtPct(r.errCost, 3)}</td>
                <td className={`${TD_CLS} text-right ${MONO}`}><span className="text-white">{fmtNum(r.gotPrice, 6)}</span><span className="text-slate-500"> / {fmtNum(r.expectedPrice, 6)}</span></td>
                <td className={`${TD_CLS} text-right ${MONO} ${Math.abs(r.errPrice) < 0.01 ? 'text-emerald-300' : 'text-red-300'}`}>{fmtPct(r.errPrice, 3)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="text-[11px] text-slate-500 mt-2">※ 誤差 = (算出 − 期望) ÷ 期望；五段金額為該段每件含報廢（Excel G 欄）或該段合計，依 API 回傳。</div>
    </div>
  )
}
