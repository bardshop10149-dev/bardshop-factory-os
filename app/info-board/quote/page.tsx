'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import type { CalcRequest, CatalogCategory, CatalogResponse, LogRequest, LogResponse, QuoteMode } from '@/lib/quote/api'
import type { PrintMethod, Sides } from '@/lib/quote/types'
import { boardShortLabel, fmtDate, fmtDim, fmtInt, fmtMonthDay, fmtSize, fmtTime } from './_lib/format'
import {
  buildSummaryText,
  displayNameOf,
  METHOD_LABEL,
  priceMap,
  readLocal,
  writeLocal,
  type FieldError,
  type FieldKey,
  type OverrideState,
  type RetiredOverride,
  type SizeState,
} from './_lib/model'
import { formatDimValue, normalizeDimText, parseDecimal, parseInteger } from './_lib/normalize'
import { useCalc } from './_lib/useCalc'
import { BoardNotice, BoardSelect, buildBoardChoices, smallestFittingBoard } from './_components/BoardSelect'
import { CategoryTabs } from './_components/CategoryTabs'
import { CheckList, type CheckRow } from './_components/CheckList'
import { PrintControls } from './_components/PrintControls'
import { ProductSelect } from './_components/ProductSelect'
import { ResultPanel, type OverrideView } from './_components/ResultPanel'
import { SizeRow } from './_components/SizeRow'
import type { StatusInfo } from './_components/StatusLine'
import type { CopyState } from './_components/QuoteSummary'
import { NumberInput } from './_components/NumberInput'
import { Banner, BTN_TEXT, Msg, SectionHeader } from './_components/ui'

/**
 * 報價計算機前台（設計書 §4 MVP 左欄、§12 紙墨報價單）。
 *
 * 資料流：GET /api/quote/catalog → 品項／板材／配件／包裝選項（價格從 priceItems 顯示）
 *        → 表單 → CalcRequest → useCalc（150ms debounce）→ POST /api/quote/calc → 結果面板
 *        → 「產生報價」POST /api/quote/log → 頁尾摘要＋複製。
 * 即時重算邊界：盤數／本單合計／TWD 顯示本地算；N、五段、成本、報價由 API 算。
 */

type CatalogState = 'loading' | 'ok' | 'denied' | 'error'

const ID_TO_FIELD: Record<string, FieldKey> = {
  'q-product': 'product',
  'q-w': 'w',
  'q-h': 'h',
  'q-qty': 'qty',
  'q-board': 'board',
  'q-versions': 'versions',
}

function focusEl(el: HTMLElement | null | undefined) {
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.focus({ preventScroll: true })
}

function daysSince(iso: string): number | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.floor((Date.now() - t) / 86400000)
}

export default function QuoteCalculatorPage() {
  /* ---------------------------------------------------------------- 目錄與登入者 */
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [catalogState, setCatalogState] = useState<CatalogState>('loading')
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogTick, setCatalogTick] = useState(0)
  const [userName, setUserName] = useState('')
  const [today] = useState(() => fmtDate())

  useEffect(() => {
    let cancelled = false
    setCatalogState('loading')
    ;(async () => {
      try {
        const res = await fetch('/api/quote/catalog', { credentials: 'include', cache: 'no-store' })
        if (cancelled) return
        if (res.status === 401 || res.status === 403) {
          setCatalogState('denied')
          return
        }
        const body = (await res.json().catch(() => null)) as ({ success: true } & CatalogResponse) | { success: false; error: string } | null
        if (cancelled) return
        if (!res.ok || !body || body.success !== true) {
          setCatalogError(body && body.success === false && body.error ? body.error : '費率服務暫時無法連線')
          setCatalogState('error')
          return
        }
        setCatalog(body)
        setCatalogState('ok')
      } catch {
        if (!cancelled) {
          setCatalogError('費率服務暫時無法連線')
          setCatalogState('error')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [catalogTick])

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((me: { real_name?: string | null; email?: string } | null) => {
        if (cancelled || !me) return
        setUserName(me.real_name?.trim() || me.email?.split('@')[0] || '')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const prices = useMemo(() => priceMap(catalog?.priceItems ?? []), [catalog])

  /* ---------------------------------------------------------------- 表單狀態 */
  const [category, setCategory] = useState<CatalogCategory['code']>('acrylic')
  const [productId, setProductId] = useState('')
  const [size, setSize] = useState<SizeState>({ id: 's1', w: '', h: '', qty: '' })
  const [boardItem, setBoardItem] = useState('')
  const [boardAutoPicked, setBoardAutoPicked] = useState(false)
  const [boardManual, setBoardManual] = useState(false)
  const [sides, setSides] = useState<Sides>(1)
  const [method, setMethod] = useState<PrintMethod>('7151')
  const [versions, setVersions] = useState('1')
  // 毛利率（%）＝ Excel L4「成本率(利润%)」；品項預設 r 換算回來（0.72 → 28）。兩個模式都可調（伺服器業務模式只放行這一個覆寫）
  const [marginPct, setMarginPct] = useState('')
  const [acc, setAcc] = useState<Record<string, { on: boolean; k: number; price: number | null }>>({})
  const [pack, setPack] = useState<Record<string, { on: boolean; n?: number }>>({})
  const [override, setOverride] = useState<OverrideState | null>(null)
  const [retired, setRetired] = useState<RetiredOverride | null>(null)
  const [overrideFlash, setOverrideFlash] = useState(0)
  const [showTwd, setShowTwd] = useState(false)
  // 檢視模式：預設業務模式。這只是「請求」，伺服器沒 quote_admin 一律回 sales（見 lib/quote/api.ts QuoteMode）
  const [mode, setMode] = useState<QuoteMode>('sales')
  const [touched, setTouched] = useState<Set<FieldKey>>(() => new Set())
  const [submitted, setSubmitted] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [log, setLog] = useState<{ quoteNo: string; createdAt: Date; text: string } | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')

  const productRef = useRef<HTMLSelectElement>(null)
  const boardRef = useRef<HTMLSelectElement>(null)
  const wRef = useRef<HTMLInputElement>(null)
  const hRef = useRef<HTMLInputElement>(null)
  const qtyRef = useRef<HTMLInputElement>(null)
  const versionsRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setShowTwd(readLocal<boolean>('q.showTwd', false))
    if (readLocal<string>('q.mode', 'sales') === 'engineer') setMode('engineer')
  }, [])
  // 有權限的人才切得到工程模式；權限拿掉時本地記憶也一起失效
  const canEngineer = catalog?.canEngineer === true
  const effectiveMode: QuoteMode = mode === 'engineer' && canEngineer ? 'engineer' : 'sales'
  const eng = effectiveMode === 'engineer'

  // 只列 published；依目前品類分頁過濾（品類名稱對 product.category）。
  // devSeed（本機用 seed 跑、未連 DB）時放行未發布品項，否則沒東西可測；選項會標「（未發布）」。
  const products = useMemo(() => {
    const catName = catalog?.categories.find((c) => c.code === category)?.name
    const allowUnpublished = catalog?.devSeed === true
    return (catalog?.products ?? []).filter(
      (p) => (p.status === 'published' || allowUnpublished) && (!catName || p.category === catName),
    )
  }, [catalog, category])
  const product = useMemo(() => products.find((p) => p.id === productId) ?? null, [products, productId])

  // 只有一個品項時直接預選，少一次點擊
  useEffect(() => {
    if (!productId && products.length === 1) setProductId(products[0].id)
  }, [products, productId])

  // 換品項：板材／印刷／配件／包裝全部回到品項預設；覆寫與摘要清掉
  useEffect(() => {
    if (!product) return
    const c = product.config
    setBoardItem(c.boards.defaultItem)
    setBoardManual(false)
    setBoardAutoPicked(false)
    setSides(c.defaultPrintSides ?? c.boards.sides)
    setMethod(c.printMethods.includes(c.defaultPrintMethod) ? c.defaultPrintMethod : c.printMethods[0] ?? 'none')
    setVersions('1')
    setMarginPct(formatDimValue((1 - c.costRatio) * 100))
    setAcc(Object.fromEntries(c.accessories.map((a) => [a.item, { on: a.defaultOn, k: a.k, price: null }])))
    setPack(Object.fromEntries(c.packing.map((p) => [p.item, { on: p.defaultOn ?? true, n: p.n }])))
    setOverride(null)
    setRetired(null)
    setLog(null)
    setLogError(null)
  }, [product])

  /* ---------------------------------------------------------------- 解析與驗證 */
  const wNum = parseDecimal(size.w)
  const hNum = parseDecimal(size.h)
  const qtyNum = parseInteger(size.qty)
  const vNum = parseInteger(versions)
  const marginNum = parseDecimal(marginPct)
  const marginDefault = product ? (1 - product.config.costRatio) * 100 : null
  const marginErr = marginPct.trim() !== '' && (marginNum === null || marginNum < 0 || marginNum >= 100) ? '※ 毛利率請輸入 0 到 99.9 之間的數值' : null
  // 有效且跟品項預設不同才送覆寫；空白＝用預設
  const marginOverride = marginNum !== null && !marginErr && marginDefault !== null && Math.abs(marginNum - marginDefault) > 1e-9 ? marginNum : null
  const wOk = wNum !== null && wNum >= 0.1
  const hOk = hNum !== null && hNum >= 0.1

  const choices = useMemo(
    () => (product ? buildBoardChoices(product.config.boards.options, prices, wOk ? wNum : null, hOk ? hNum : null) : []),
    [product, prices, wNum, hNum, wOk, hOk],
  )
  const board = choices.find((c) => c.value === boardItem) ?? null

  // 自動預選：目前板材放不下且沒手動選過 → 換成放得下的最小板材（同厚度優先，不擅自改厚度）
  useEffect(() => {
    if (!product || boardManual || !board || board.fits !== false) return
    const fitting = choices.filter((c) => c.fits === true && c.layout)
    if (!fitting.length) return
    const minArea = Math.min(...fitting.map((c) => c.layout!.w * c.layout!.h))
    const smallest = fitting.filter((c) => Math.abs(c.layout!.w * c.layout!.h - minArea) < 1e-6)
    const same = smallest.find((c) => c.thickness === board.thickness) ?? smallestFittingBoard(smallest)
    if (same && same.value !== boardItem) {
      setBoardItem(same.value)
      setBoardAutoPicked(true)
    }
  }, [product, boardManual, board, choices, boardItem])

  const fieldErrors: FieldError[] = useMemo(() => {
    const list: FieldError[] = []
    if (!productId) list.push({ field: 'product', label: '品項', message: '請選擇品項' })
    if (!wOk) list.push({ field: 'w', label: '寬度', message: '請輸入 0.1 以上的數值' })
    if (!hOk) list.push({ field: 'h', label: '高度', message: '請輸入 0.1 以上的數值' })
    if (qtyNum === null || qtyNum < 1) list.push({ field: 'qty', label: '數量', message: '請輸入 1 以上的整數' })
    if (productId && !boardItem) list.push({ field: 'board', label: '板材', message: '請選擇板材' })
    if (method === 'koshi' && (vNum === null || vNum < 1)) list.push({ field: 'versions', label: '版數', message: '請輸入 1 以上的整數' })
    return list
  }, [productId, wOk, hOk, qtyNum, boardItem, method, vNum])

  const showErr = (f: FieldKey) => (submitted || touched.has(f) ? fieldErrors.find((e) => e.field === f)?.message ?? null : null)
  const fitError = board?.fits === false
  const sizeText = wOk && hOk ? fmtSize(wNum!, hNum!) : null

  /* ---------------------------------------------------------------- 覆寫生命週期：key = w|h|board */
  const overrideKey = `${wOk ? wNum : ''}|${hOk ? hNum : ''}|${boardItem}`
  useEffect(() => {
    if (override && override.key !== overrideKey) {
      setRetired({ value: override.value, recent: true })
      setOverride(null)
      setOverrideFlash((t) => t + 1)
    }
  }, [override, overrideKey])
  // 2 秒後從「已依新板材重算」切成「上次手動 N · 套回」。計時器獨立一個 effect：
  // 放在上面那個 effect 裡會被 setOverride(null) 觸發的 cleanup 立刻清掉，永遠不會到期。
  const retiredRecent = !!retired?.recent
  useEffect(() => {
    if (!retiredRecent) return
    const timer = setTimeout(() => setRetired((r) => (r ? { ...r, recent: false } : r)), 2000)
    return () => clearTimeout(timer)
  }, [retiredRecent])

  /* ---------------------------------------------------------------- 組 CalcRequest（缺項或無法拼板 → null） */
  const request = useMemo<CalcRequest | null>(() => {
    if (!product || fieldErrors.length || fitError || !wOk || !hOk || qtyNum === null) return null
    const accessories = product.config.accessories
      .filter((a) => acc[a.item]?.on)
      .map((a) => {
        const st = acc[a.item]
        const entry: CalcRequest['accessories'][number] = { item: a.item, k: st.k }
        if (a.tierPrices && st.price !== null) entry.unitPrice = st.price
        return entry
      })
    const packing = product.config.packing
      .filter((p) => pack[p.item]?.on)
      .map((p) => {
        const st = pack[p.item]
        const entry: CalcRequest['packing'][number] = { item: p.item }
        if (p.mode === 'per_n_units' && st.n && st.n !== p.n) entry.n = st.n
        return entry
      })
    const req: CalcRequest = {
      mode: effectiveMode,
      productId: product.id,
      sizes: [
        {
          id: size.id,
          w: wNum!,
          h: hNum!,
          qty: qtyNum,
          nOverride: override && override.key === overrideKey ? { value: override.value, autoValue: override.autoValue, key: override.key } : null,
        },
      ],
      boardItem,
      print: { method, sides: method === 'none' ? 1 : sides, ...(method === 'koshi' ? { versions: vNum ?? 1 } : {}) },
      accessories,
      packing,
      ...(marginOverride !== null ? { overrides: { costRatio: 1 - marginOverride / 100 } } : {}),
    }
    return req
  }, [product, fieldErrors.length, fitError, wOk, hOk, wNum, hNum, qtyNum, acc, pack, size.id, override, overrideKey, boardItem, method, sides, vNum, effectiveMode, marginOverride])

  const calc = useCalc(request)
  const sizeResult = calc.result?.sizes[0] ?? null
  const apiErrors = calc.result?.errors ?? []
  const auto = sizeResult?.nPerSheetAuto ?? 0

  const overrideHigh: OverrideView['high'] = override && auto > 0 ? (override.value > auto * 1.5 ? 'seal' : override.value > auto ? 'warn' : 'none') : 'none'
  const overrideView: OverrideView = {
    state: sizeResult && auto === 0 && qtyNum ? 'invalid' : override ? 'overridden' : 'auto',
    override,
    retired,
    flashTick: overrideFlash,
    high: overrideHigh,
  }

  /* ---------------------------------------------------------------- 狀態判定 */
  let blockReason: string | null = null
  if (fitError) blockReason = '尺寸超過板材可用範圍，無法拼板'
  else if (apiErrors.length) blockReason = apiErrors[0].message
  else if (sizeResult && sizeResult.quoteUnit <= 0 && qtyNum) blockReason = sizeResult.warnings[0] ?? '無法拼板'
  else if (overrideHigh === 'seal') blockReason = '每盤數量超過拼板上限'

  const focusField = useCallback((f: FieldKey) => {
    const map: Record<FieldKey, HTMLElement | null> = {
      product: productRef.current,
      w: wRef.current,
      h: hRef.current,
      qty: qtyRef.current,
      board: boardRef.current,
      versions: versionsRef.current,
    }
    focusEl(map[f])
  }, [])

  const status: StatusInfo = (() => {
    if (catalogState === 'loading') return { kind: 'idle', text: '載入資料中' }
    if (fieldErrors.length) {
      const flagged = submitted || touched.size > 0
      return {
        kind: flagged ? 'missing' : 'idle',
        text: '尚缺：',
        missing: fieldErrors.map((e) => ({ label: e.label, onClick: () => focusField(e.field) })),
      }
    }
    if (fitError) return { kind: 'error', text: '尺寸超過板材可用範圍，無法拼板' }
    if (calc.error) return { kind: 'error', text: calc.error.kind === 'auth' ? '沒有報價計算機權限' : '費率服務暫時無法連線' }
    if (calc.pending && calc.slow) return { kind: 'calc', text: '計算中' }
    if (apiErrors.length) return { kind: 'error', text: apiErrors[0].message }
    if (sizeResult && calc.lastCalcAt) return { kind: 'ok', text: `已計算 ${fmtTime(calc.lastCalcAt)}` }
    return { kind: 'calc', text: '計算中' }
  })()

  /* ---------------------------------------------------------------- 產生報價 */
  // 連點主鈕／連按 Ctrl+Enter 只能送一次 log（state 的 generating 在同一個 tick 內還沒更新，要用 ref 擋）
  const generateInFlight = useRef(false)
  const generate = useCallback(async () => {
    setSubmitted(true)
    setLogError(null)
    if (fieldErrors.length) {
      focusField(fieldErrors[0].field)
      return
    }
    if (blockReason || !request || !calc.result || calc.stale || calc.pending || !product || !sizeResult) return
    // 150ms debounce 視窗內：request 已變、result 還是上一筆的 → 不能把新 request 配舊 result 寫進 log
    if (!calc.resultFor || JSON.stringify(calc.resultFor) !== JSON.stringify(request)) return
    if (generateInFlight.current) return
    generateInFlight.current = true
    setGenerating(true)
    try {
      const payload: LogRequest = { request, response: calc.result }
      const res = await fetch('/api/quote/log', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json().catch(() => null)) as ({ success: true } & LogResponse) | { success: false; error: string } | null
      if (res.status === 401 || res.status === 403) {
        setLogError('沒有報價計算機權限')
        return
      }
      if (!res.ok || !body || body.success !== true) {
        setLogError(body && body.success === false && body.error ? body.error : '費率服務暫時無法連線，報價未儲存')
        return
      }
      const createdAt = new Date(body.createdAt)
      const created = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt
      const text = buildSummaryText({
        quoteNo: body.quoteNo,
        createdAt: created,
        product,
        w: wNum!,
        h: hNum!,
        thicknessMm: board?.thickness ?? null,
        boardText: board?.pair ? `${board.label}，${fmtDim(board.thickness ?? 0)} + ${fmtDim(board.pair.thickness ?? 0)} mm` : undefined,
        qty: qtyNum!,
        quoteUnit: sizeResult.quoteUnit,
        twdUnit: sizeResult.twdUnit,
        total: sizeResult.quoteUnit * qtyNum!,
        sides: method === 'none' ? 1 : sides,
        method,
        versions: vNum ?? 1,
        accessories: request.accessories.map((a) => ({ name: displayNameOf(a.item, prices), k: a.k })),
        packing: request.packing.map((p) => displayNameOf(p.item, prices)),
        perSheetUsed: sizeResult.nPerSheetUsed,
        perSheetAuto: sizeResult.nPerSheetAuto,
        overridden: !!request.sizes[0].nOverride,
        validityDays: calc.result.validityDays,
        userName,
        rateVersion: calc.result.rateVersion,
        fx: calc.result.fx,
      })
      setLog({ quoteNo: body.quoteNo, createdAt: created, text })
      setCopyState('idle')
    } catch {
      setLogError('費率服務暫時無法連線，報價未儲存')
    } finally {
      generateInFlight.current = false
      setGenerating(false)
    }
  }, [fieldErrors, focusField, blockReason, request, calc.result, calc.resultFor, calc.stale, calc.pending, product, sizeResult, wNum, hNum, board, prices, qtyNum, method, sides, vNum, userName])

  // Ctrl+Enter 任何位置產生報價（IME composing 不觸發）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return
      if (e.isComposing || e.keyCode === 229) return
      e.preventDefault()
      void generate()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [generate])

  const onCopy = useCallback(
    (selectFallback: () => void) => {
      if (!log) return
      const done = (state: CopyState) => {
        setCopyState(state)
        window.setTimeout(() => setCopyState('idle'), 2000)
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(log.text).then(
          () => done('copied'),
          () => {
            selectFallback()
            done('failed')
          },
        )
      } else {
        selectFallback()
        done('failed')
      }
    },
    [log],
  )

  /* ---------------------------------------------------------------- 配件／包裝列 */
  const accRows: CheckRow[] = useMemo(
    () =>
      product
        ? product.config.accessories.map((a) => {
            const st = acc[a.item] ?? { on: a.defaultOn, k: a.k, price: null }
            const p = prices.get(a.item)
            const unit = p?.unit || '個'
            // 「每件用量」乘上訂單數量＝這張單要備多少顆，跟著數量一起跳
            const total = qtyNum && st.k > 0 ? qtyNum * st.k : null
            return {
              item: a.item,
              name: displayNameOf(a.item, prices),
              on: st.on,
              price: p ? p.price : null,
              unit,
              qtyMode: 'k' as const,
              qtyValue: st.k,
              tierPrice: !!a.tierPrices,
              history: a.tierPrices ? ((p?.attrs?.reference_history as CheckRow['history']) ?? null) : null,
              priceOverride: st.price,
              note:
                total !== null && qtyNum !== null
                  ? `共 ${fmtInt(total)} ${unit}${st.k !== 1 ? `（${fmtInt(qtyNum)} × 每件 ${fmtInt(st.k)}）` : ''}`
                  : null,
            }
          })
        : [],
    [product, acc, prices, qtyNum],
  )

  const packRows: CheckRow[] = useMemo(
    () =>
      product
        ? product.config.packing.map((pk) => {
            const st = pack[pk.item] ?? { on: pk.defaultOn ?? true, n: pk.n }
            const p = prices.get(pk.item)
            const n = st.n ?? pk.n ?? 0
            const isBox = /箱/.test(pk.item) || /箱/.test(displayNameOf(pk.item, prices))
            let note: string | null = null
            if (pk.mode === 'per_n_units' && qtyNum && n > 0) {
              const cnt = Math.ceil(qtyNum / n)
              note = `約 ${fmtInt(cnt)} ${isBox ? '箱' : '份'}（${fmtInt(qtyNum)} ÷ ${fmtInt(n)}，無條件進位）`
            } else if (pk.mode === 'per_unit' && qtyNum) {
              const k = pk.k ?? 1
              note = `共 ${fmtInt(qtyNum * k)} ${p?.unit || '個'}${k !== 1 ? `（${fmtInt(qtyNum)} × 每件 ${fmtInt(k)}）` : ''}`
            } else if (pk.mode === 'per_box' && qtyNum) {
              const boxN = product.config.packing.find((x) => x.mode === 'per_n_units' && /箱/.test(x.item))
              const per = pack[boxN?.item ?? '']?.n ?? boxN?.n ?? 0
              if (per > 0) note = `共 ${fmtInt(Math.ceil(qtyNum / per) * (pk.k ?? 1))} ${p?.unit || '張'}（${fmtInt(Math.ceil(qtyNum / per))} 箱 × ${fmtInt(pk.k ?? 1)}）`
            }
            const base = {
              item: pk.item,
              name: displayNameOf(pk.item, prices),
              on: st.on,
              price: p ? p.price : null,
              unit: p?.unit || '個',
              note,
            }
            if (pk.mode === 'per_n_units') return { ...base, qtyMode: 'n' as const, qtyValue: n }
            if (pk.mode === 'per_box') return { ...base, qtyMode: 'fixed' as const, qtyValue: pk.k ?? 1, fixedText: `每箱 ${fmtInt(pk.k ?? 1)}` }
            if (pk.mode === 'fixed') return { ...base, qtyMode: 'fixed' as const, qtyValue: pk.n ?? 1, fixedText: `固定 ${fmtInt(pk.n ?? 1)} 次` }
            return { ...base, qtyMode: 'fixed' as const, qtyValue: pk.k ?? 1, fixedText: `每件 ${fmtInt(pk.k ?? 1)}` }
          })
        : [],
    [product, pack, prices, qtyNum],
  )

  // 區段四右上只報「選了幾項」。原本還有一個本地估算的每件加購金額，
  // 隨「配件區不露成本」一起拿掉了——成本一律看右側五段明細（那才是含報廢的正式數字）。
  const selectedCount = accRows.filter((r) => r.on).length + (eng ? packRows.filter((r) => r.on).length : 0)

  /* ---------------------------------------------------------------- 頁首徽章與摘要句 */
  const fx = catalog?.fx ?? null
  const fxAge = fx ? daysSince(fx.asOf) : null
  const fxStale = fxAge !== null && fxAge > 7
  const fxDead = !fx || (fxAge !== null && fxAge > 30)
  const effectiveFx = fxDead ? null : fx

  const boardLabel = board ? board.label : boardItem ? boardShortLabel(boardItem) : null
  const printText = product
    ? method === 'none'
      ? METHOD_LABEL.none
      : `${sides === 2 ? '雙面' : '單面'} ${METHOD_LABEL[method]}${method === 'koshi' && vNum ? ` ${vNum} 版` : ''}`
    : null
  const summaryLine = [product?.name ?? '—', sizeText ?? '—', boardLabel ?? '—', printText ?? '—', qtyNum ? `${fmtInt(qtyNum)} pcs` : '—'].join(' · ')

  const mainButton = generating
    ? { text: '計算中…', disabled: false, busy: true }
    : blockReason && !fieldErrors.length
      ? { text: blockReason.includes('拼板') && !blockReason.includes('每盤') ? '無法拼板，請調整尺寸或板材' : blockReason, disabled: true, busy: false }
      : { text: '產生報價', disabled: false, busy: false }

  const sectionsDisabled = !product

  /* ---------------------------------------------------------------- 渲染 */
  if (catalogState === 'denied') {
    return (
      <main className="mx-auto max-w-(--q-max) px-(--q-gutter) py-16 max-lg:px-6">
        <h1 className="font-(family-name:--q-font-serif) text-[28px] leading-9 font-semibold">報價計算機</h1>
        <p className="mt-4 text-[14px] leading-[22px] text-(--q-seal)">※ 沒有報價計算機權限</p>
        <Link href="/info-board" className={`${BTN_TEXT} mt-6 inline-block text-[13px] text-(--q-accent)`}>
          ← 回業務資訊看板
        </Link>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-(--q-max) px-(--q-gutter) py-8 max-lg:px-6">
      <a href="#q-panel" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-(--q-radius) focus:bg-(--q-card) focus:px-3 focus:py-2 focus:ring-2 focus:ring-(--q-accent)/25">
        跳到報價單
      </a>

      {/* 頁首 */}
      <header className="flex items-end justify-between gap-6 pb-5 max-md:flex-col max-md:items-start">
        <div>
          <Link href="/info-board" className={`${BTN_TEXT} text-[12px] leading-4 text-(--q-ink-2)`}>
            ← 業務資訊看板
          </Link>
          <h1 className="mt-2 font-(family-name:--q-font-serif) text-[28px] leading-9 font-semibold text-(--q-ink)">報價計算機</h1>
          <p className="mt-1 text-[11px] leading-4 tracking-[0.14em] text-(--q-ink-3)">QUOTATION CALCULATOR</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {catalog && (
            <span className="q-num rounded-(--q-radius) border border-(--q-line) px-2 py-0.5 text-[12px] leading-4 text-(--q-ink-2)">成本參數 {catalog.rateVersion}</span>
          )}
          {catalog &&
            (fxDead ? (
              <span className="rounded-(--q-radius) border border-(--q-warn) px-2 py-0.5 text-[12px] leading-4 text-(--q-warn)">※ 匯率未設定</span>
            ) : fxStale ? (
              <span className="q-num rounded-(--q-radius) border border-(--q-warn) px-2 py-0.5 text-[12px] leading-4 text-(--q-warn)">※ 匯率已 {fxAge} 天未更新</span>
            ) : (
              <span className="q-num rounded-(--q-radius) border border-(--q-line) px-2 py-0.5 text-[12px] leading-4 text-(--q-ink-2)">
                1 RMB = {fx!.rate} NT$ · {fmtMonthDay(fx!.asOf)}
              </span>
            ))}
          {canEngineer && (
            <div role="radiogroup" aria-label="檢視模式" className="inline-flex rounded-(--q-radius) border border-(--q-ink) bg-(--q-card) p-0.5">
              {(
                [
                  ['sales', '業務'],
                  ['engineer', '工程'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={effectiveMode === m}
                  onClick={() => {
                    setMode(m)
                    writeLocal('q.mode', m)
                  }}
                  className={`rounded-[2px] px-3 py-1 text-[12px] leading-4 font-medium transition-colors duration-(--q-dur-fast) ${
                    effectiveMode === m ? 'bg-(--q-ink) text-(--q-paper)' : 'text-(--q-ink-2) hover:text-(--q-ink)'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <span className="q-num text-[12px] leading-4 text-(--q-ink-2)">
            {userName || '—'} · {today}
          </span>
        </div>
      </header>

      {catalog?.devSeed && (
        <div className="mb-4">
          <Banner tone="warn">目前使用開發用 seed 資料，未連接資料庫</Banner>
        </div>
      )}
      {catalogState === 'error' && (
        <div className="mb-4">
          <Banner
            tone="seal"
            action={
              <button type="button" onClick={() => setCatalogTick((t) => t + 1)} className={`${BTN_TEXT} shrink-0 text-[13px]`}>
                重試
              </button>
            }
          >
            {catalogError ?? '費率服務暫時無法連線'}
          </Banner>
        </div>
      )}

      {/* 品類分頁 */}
      <CategoryTabs
        categories={catalog?.categories ?? [{ code: 'acrylic', name: '壓克力', enabled: true }, { code: 'sticker', name: '貼紙', enabled: false }, { code: 'crystal', name: '水晶標', enabled: false }]}
        value={category}
        onChange={(code) => {
          if (code === category) return
          const dirty = productId || size.w || size.h || size.qty
          if (dirty && !window.confirm('切換品類會清除目前輸入，確定切換？')) return
          setCategory(code)
          setProductId('')
          setSize({ id: 's1', w: '', h: '', qty: '' })
          setSubmitted(false)
          setTouched(new Set())
        }}
      />

      {/* 主體 */}
      <div className="mt-8 grid grid-cols-12 gap-6 max-lg:gap-5">
        {/* 左：工作卡 */}
        <div
          className="col-span-12 lg:col-span-7"
          onBlurCapture={(e) => {
            const f = ID_TO_FIELD[(e.target as HTMLElement).id]
            if (f && !touched.has(f)) setTouched((prev) => new Set(prev).add(f))
          }}
        >
          <div className="rounded-(--q-radius-lg) border border-(--q-line) bg-(--q-card)">
            {calc.error && (
              <div className="border-b border-(--q-line) p-4">
                <Banner
                  tone="seal"
                  action={
                    <button type="button" onClick={calc.retry} className={`${BTN_TEXT} shrink-0 text-[13px]`}>
                      重試
                    </button>
                  }
                >
                  {calc.error.kind === 'auth' ? '沒有報價計算機權限' : `費率服務暫時無法連線${calc.error.code ? `（${calc.error.code}）` : ''}`}
                </Banner>
              </div>
            )}

            {/* 一、品項 */}
            <section className="px-6 py-6 max-md:px-4" aria-labelledby="q-sec-1">
              <div id="q-sec-1">
                <SectionHeader title="一、品項" caption="PRODUCT" summary={product ? `${product.name} · ${product.category}` : null} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5">
                <ProductSelect
                  products={products}
                  value={productId}
                  onChange={(id) => {
                    setProductId(id)
                    setTouched((prev) => new Set(prev).add('product'))
                  }}
                  error={showErr('product')}
                  disabled={catalogState !== 'ok'}
                  selectRef={productRef}
                />
              </div>
            </section>

            {/* 二、尺寸與數量 */}
            <section
              className={`border-t border-(--q-line) px-6 py-6 max-md:px-4 ${sectionsDisabled ? 'pointer-events-none opacity-60' : ''}`}
            >
              <SectionHeader
                title="二、尺寸與數量"
                caption="SIZE & QUANTITY"
                summary={sizeText && boardLabel ? `1 款 · ${boardLabel} · ${sizeText}${qtyNum ? ` · 共 ${fmtInt(qtyNum)} pcs` : ''}` : null}
                hasError={fitError || !!showErr('w') || !!showErr('h') || !!showErr('qty')}
              />
              <div className="mt-4">
                <SizeRow
                  size={size}
                  index={0}
                  onChange={(patch) => setSize((s) => ({ ...s, ...patch }))}
                  errors={{ w: showErr('w'), h: showErr('h'), qty: showErr('qty') }}
                  board={
                    <BoardSelect
                      choices={choices}
                      value={boardItem}
                      onChange={(item) => {
                        setBoardItem(item)
                        setBoardManual(true)
                        setBoardAutoPicked(false)
                        setTouched((prev) => new Set(prev).add('board'))
                      }}
                      error={showErr('board')}
                      disabled={sectionsDisabled}
                      selectRef={boardRef}
                      className="w-[220px] max-w-full"
                    />
                  }
                  afterBoard={
                    (
                      <NumberInput
                        id="q-margin"
                        label="毛利率"
                        ariaLabel="毛利率 %"
                        value={marginPct}
                        onChange={setMarginPct}
                        normalize={normalizeDimText}
                        unit="%"
                        placeholder={marginDefault !== null ? formatDimValue(marginDefault) : ''}
                        error={marginErr}
                        hint={marginOverride !== null && marginDefault !== null ? `預設 ${formatDimValue(marginDefault)}%` : null}
                        hideMessage
                        disabled={sectionsDisabled}
                        className="w-[120px]"
                      />
                    )
                  }
                  boardNotice={
                    <>
                    {marginErr && <Msg tone="seal">{marginErr}</Msg>}
                    {marginOverride !== null && marginDefault !== null && !marginErr && (
                      <p className="q-num mt-1.5 text-[12px] leading-4 text-(--q-warn)">※ 毛利率已改為 {formatDimValue(marginOverride)}%（品項預設 {formatDimValue(marginDefault)}%），只影響這張試算</p>
                    )}
                    <BoardNotice
                      choices={choices}
                      value={boardItem}
                      onChange={(item) => {
                        setBoardItem(item)
                        setBoardManual(true)
                        setBoardAutoPicked(false)
                      }}
                      sizeText={sizeText}
                      autoPicked={boardAutoPicked}
                      error={showErr('board')}
                    />
                    </>
                  }
                  sizeMessage={
                    fitError && board && sizeText
                      ? {
                          tone: 'seal',
                          text: `${sizeText} 超過 ${board.label} 板可用範圍${board.layout ? `（扣邊後 ${fmtSize(board.layout.w, board.layout.h)}，旋轉後仍放不下）` : ''}，無法拼板`,
                        }
                      : null
                  }
                  refs={{ w: wRef, h: hRef, qty: qtyRef }}
                  onQtyEnter={() => focusEl(method === 'koshi' ? versionsRef.current : undefined)}
                />
                {/* 「＋新增下一款尺寸」預留位置（MVP 後） */}
              </div>
            </section>

            {/* 三、印刷 */}
            <section
              className={`border-t border-(--q-line) px-6 py-6 max-md:px-4 ${sectionsDisabled ? 'pointer-events-none opacity-60' : ''}`}
            >
              <SectionHeader title="三、印刷" caption="PRINTING" summary={printText} hasError={!!showErr('versions')} />
              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 max-md:grid-cols-1">
                <PrintControls
                  methods={product?.config.printMethods ?? ['7151', 'jingutian', 'koshi', 'none']}
                  sides={sides}
                  method={method}
                  versions={versions}
                  onSides={setSides}
                  onMethod={(m) => {
                    setMethod(m)
                    if (m !== 'koshi') setTouched((prev) => {
                      const next = new Set(prev)
                      next.delete('versions')
                      return next
                    })
                  }}
                  onVersions={setVersions}
                  versionsError={showErr('versions')}
                  versionsRef={versionsRef}
                  disabled={sectionsDisabled}
                />
              </div>
            </section>

            {/* 四、配件與包裝 */}
            <section
              className={`border-t border-(--q-line) px-6 py-6 max-md:px-4 ${sectionsDisabled ? 'pointer-events-none opacity-60' : ''}`}
            >
              <SectionHeader
                title="四、配件與包裝"
                caption="ACCESSORIES & PACKING"
                /* 只報「選了幾項」，不報金額：挑配件的畫面不擺成本，成本一律看右側明細 */
                summary={product ? `已選 ${selectedCount} 項` : null}
              />
              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5">
                <div className="col-span-2">
                  <h3 className="mb-2 text-[12px] leading-4 font-medium tracking-[0.04em] text-(--q-ink-2)">配件（每件用量）</h3>
                  <CheckList
                    rows={accRows}
                    onToggle={(item, on) => setAcc((prev) => ({ ...prev, [item]: { on, k: prev[item]?.k ?? 1, price: prev[item]?.price ?? null } }))}
                    onQty={(item, n) => setAcc((prev) => ({ ...prev, [item]: { on: true, k: n, price: prev[item]?.price ?? null } }))}
                    onPrice={(item, price) => setAcc((prev) => ({ ...prev, [item]: { on: prev[item]?.on ?? true, k: prev[item]?.k ?? 1, price } }))}
                    disabled={sectionsDisabled}
                    emptyText="此品項沒有可選配件"
                    showPrice={eng}
                    collapseAfter={12}
                    searchable
                  />
                </div>
                <div className="col-span-2">
                  <h3 className="mb-2 text-[12px] leading-4 font-medium tracking-[0.04em] text-(--q-ink-2)">包裝</h3>
                  {eng ? (
                    <CheckList
                      rows={packRows}
                      onToggle={(item, on) => setPack((prev) => ({ ...prev, [item]: { ...(prev[item] ?? {}), on } }))}
                      onQty={(item, n) => setPack((prev) => ({ ...prev, [item]: { ...(prev[item] ?? {}), on: true, n } }))}
                      disabled={sectionsDisabled}
                      emptyText="此品項沒有可選包裝"
                      showPrice={eng}
                    />
                  ) : (
                    /* 業務模式：包裝由品項預設決定（伺服器端也只認預設），這裡只讓業務知道「有包含什麼」 */
                    <p className="text-[13px] leading-5 text-(--q-ink-2)">
                      {product && product.config.packing.length
                        ? `已包含：${product.config.packing.filter((pk) => pk.defaultOn !== false).map((pk) => displayNameOf(pk.item, prices)).join('、')}`
                        : '此品項沒有包裝設定'}
                      <span className="ml-2 text-[12px] leading-4 text-(--q-ink-3)">依品項預設自動計入</span>
                    </p>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* 右：結果面板 */}
        <div className="col-span-12 lg:col-span-5">
          <ResultPanel
            mode={calc.result?.mode ?? effectiveMode}
            costRatioOverridden={marginOverride !== null}
            today={today}
            summaryLine={summaryLine}
            status={status}
            size={sizeResult}
            qty={qtyNum && qtyNum > 0 ? qtyNum : null}
            blockReason={blockReason}
            fx={effectiveFx}
            rateVersion={catalog?.rateVersion ?? null}
            stale={calc.stale}
            lastCalcAt={calc.lastCalcAt}
            slow={calc.slow}
            pending={calc.pending}
            showTwd={showTwd}
            onToggleTwd={() => {
              setShowTwd((v) => {
                writeLocal('q.showTwd', !v)
                return !v
              })
            }}
            override={overrideView}
            onOverrideCommit={(value) => {
              setRetired(null)
              setOverride({ value, autoValue: auto, key: overrideKey })
            }}
            onOverrideReset={() => setOverride(null)}
            onOverrideReapply={() => {
              if (!retired) return
              setOverride({ value: retired.value, autoValue: auto, key: overrideKey })
              setRetired(null)
            }}
            mainButton={mainButton}
            onGenerate={() => void generate()}
            logError={logError}
            log={log}
            copyState={copyState}
            onCopy={onCopy}
          />
        </div>
      </div>
    </main>
  )
}
