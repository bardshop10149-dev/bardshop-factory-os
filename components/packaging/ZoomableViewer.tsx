'use client'

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { createPortal } from 'react-dom'

// ─────────────────────────────────────────────────────────────────────────────
// 示意圖縮放檢視器(包裝專區 需求 9 / D42 P0「示意圖縮放」)
//
// 用途:全螢幕看出單表示意圖原檔(約 4961×7017 PNG、2~5MB),包裝站要能放大看
//       細節(刀模線、貼紙位置、包裝方式小字)。
//
// 互動設計:
//   ・開啟時預設「適合視窗」(整張圖完整放進畫面)。
//   ・滑鼠滾輪 → 以游標為中心縮放(游標底下那個像素縮放前後不動,跟地圖一樣)。
//     觸控板雙指捏合在 Chrome/Edge 會變成「ctrlKey + wheel」,給較高靈敏度。
//   ・拖曳 → 平移;手機雙指捏合 → 以兩指中點縮放,同時可雙指平移。
//   ・雙擊/雙點 → 在「適合視窗」與「100%(1:1 原始像素)」之間切換,
//     放大時以點擊位置為中心。
//   ・按鈕:放大、縮小、適合視窗、1:1、上一張/下一張、全螢幕、新分頁開原圖、關閉(觸控目標 ≥ 44px)。
//     全螢幕用 Fullscreen API(瀏覽器不支援時隱藏按鈕;本元件本來就是 fixed inset-0 蓋滿視窗)。
//   ・鍵盤:Esc 關閉、← → 切換、+ / - 縮放、0 重設為適合視窗;Tab 只在檢視器內循環(焦點圈限)。
//   ・縮放範圍 0.1x~8x(以原圖像素為 1x)。例外:手機上「適合視窗」可能小於 0.1x
//     (7017px 高塞進 ~650px 螢幕 ≈ 0.09x),此時下限放寬到適合視窗,
//     否則手機上永遠看不到整張圖。
//
// 效能設計(巨圖關鍵):
//   ・<img> 以「原圖尺寸」擺放,只用 CSS transform(translate + scale)改變位置與
//     大小,並設 will-change: transform → 瀏覽器把圖放在獨立合成層交給 GPU 搬移縮放,
//     不觸發版面重排(reflow)也不重新解碼/重新下載;縮放時 src 完全不變。
//   ・decoding="async" + img.decode():解碼完才顯示,避免 35MP 巨圖「先白一下」或
//     卡住主執行緒;期間顯示 loading。
//   ・滾輪/拖曳/捏合時關閉 CSS transition(跟手),只有按鈕/鍵盤/雙擊才有 200ms 動畫。
//
// 為何不用第三方套件(react-zoom-pan-pinch、PhotoSwipe、OpenSeadragon…):
//   ・需求只有「單張圖縮放平移 + 切換」,核心數學就是一條公式:
//       新位移 = 錨點 − (錨點 − 舊位移) × (新倍率 / 舊倍率)
//     自己寫約 400 行,沒有額外 bundle 體積,也不必追套件的 React 19 相容性。
//   ・EIP 慣例是少依賴、好維護(沿用既有 Tailwind 彈窗樣式);OpenSeadragon 這類
//     需要伺服器切圖磚(tile)的方案對 2~5MB 的 PNG 是殺雞用牛刀。
//   ・互動細節(Esc 不要連帶關掉底下的訂單詳情彈窗、手機最小倍率放寬)能照包裝站
//     現場需求微調,不被套件行為綁住。
//
// 巢狀彈窗注意:本元件以 window「捕獲階段」監聽鍵盤並 stopPropagation,
//   所以從訂單詳情彈窗(如 SoOrderModal,window 冒泡階段監聽 Esc)裡開啟時,
//   按 Esc 只會關掉檢視器,不會連同底下的彈窗一起關。
//   也用 createPortal 掛到 <body>,避免父層 transform/backdrop-filter 讓 fixed 定位失效。
//
// 配色:圖片檢視器慣例一律深色背幕(讓圖成為焦點),EIP 本身也是固定深色主題;
//   不論系統深/淺色模式,文字與按鈕對比都清楚。圖片底下墊白色,避免透明背景的
//   PNG 黑線條在深色背幕上看不見。
// ─────────────────────────────────────────────────────────────────────────────

export interface ZoomableViewerImage {
  url: string
  label?: string
}

export interface ZoomableViewerProps {
  images: ZoomableViewerImage[]
  initialIndex?: number
  open: boolean
  onClose: () => void
}

// ── 常數 ────────────────────────────────────────────────────────────────────
const MIN_SCALE = 0.1 // 名目下限(1 = 原圖 1:1 像素)
const MAX_SCALE = 8
const ZOOM_STEP = 1.4 // 按鈕/鍵盤每次縮放倍數
const PAN_KEEP = 96 // 平移時至少保留多少 px 的圖在畫面內,避免把圖拖丟
const TAP_SLOP = 6 // 移動超過這個 px 就不算「點一下」
const TAP_MAX_MS = 300 // 按住超過這個時間就不算「點一下」
const DOUBLE_TAP_MS = 320 // 兩次點擊間隔上限
const DOUBLE_TAP_DIST = 30 // 兩次點擊距離上限(px)

// ── 型別與純函式 ────────────────────────────────────────────────────────────
interface Pt { x: number; y: number }
interface Size { w: number; h: number }
/** 目前檢視狀態:圖片左上角位於舞台 (x, y),縮放倍率 s;fit = 是否處於「適合視窗」模式 */
interface View { s: number; x: number; y: number; fit: boolean }
/** 量測結果:舞台尺寸、原圖尺寸、適合視窗倍率、實際可用的最小倍率 */
interface Geo { w: number; h: number; nat: Size; fitS: number; minS: number }
type Gesture =
  | { kind: 'pan'; p0: Pt; v0: View }
  | { kind: 'pinch'; d0: number; m0: Pt; v0: View }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** 適合視窗:整張圖置中放進舞台 */
function fitView(g: Geo): View {
  return { s: g.fitS, x: (g.w - g.nat.w * g.fitS) / 2, y: (g.h - g.nat.h * g.fitS) / 2, fit: true }
}

/** 限制平移範圍:每個方向至少留 PAN_KEEP px(或整張圖,若圖更小)在畫面內 */
function clampPan(v: View, g: Geo): View {
  const dw = g.nat.w * v.s
  const dh = g.nat.h * v.s
  const kx = Math.min(PAN_KEEP, dw)
  const ky = Math.min(PAN_KEEP, dh)
  return { ...v, x: clamp(v.x, kx - dw, g.w - kx), y: clamp(v.y, ky - dh, g.h - ky) }
}

// SSR 時回 false、瀏覽器端回 true;用來安全地 createPortal(document 只存在於瀏覽器)
const noopSubscribe = () => () => {}
const useIsClient = () => useSyncExternalStore(noopSubscribe, () => true, () => false)

// ── 對外元件 ────────────────────────────────────────────────────────────────
export default function ZoomableViewer({ images, initialIndex = 0, open, onClose }: ZoomableViewerProps) {
  const isClient = useIsClient()
  if (!open || !isClient) return null
  // 關閉時整棵卸載 → 下次開啟時索引、縮放狀態自然重置為 initialIndex / 適合視窗
  return createPortal(
    <ViewerShell images={images} initialIndex={initialIndex} onClose={onClose} />,
    document.body,
  )
}

/** 可接收 Tab 焦點的元素(焦點圈限用) */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 全螢幕控制:supported=false 時按鈕不顯示 */
interface FullscreenCtl { supported: boolean; active: boolean; toggle: () => void }

// ── 外殼:負責換張、Esc/←→、Tab 圈限、全螢幕、背景鎖捲動、焦點 ─────────────
function ViewerShell({ images, initialIndex, onClose }: Omit<ZoomableViewerProps, 'open'> & { initialIndex: number }) {
  const count = images.length
  const [index, setIndex] = useState(() => clamp(Math.trunc(initialIndex) || 0, 0, Math.max(0, count - 1)))
  const rootRef = useRef<HTMLDivElement>(null)
  // 本元件只在瀏覽器端掛載(createPortal),可以直接讀 document
  const [fsSupported] = useState(() => Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen))
  const [fsActive, setFsActive] = useState(false)

  const toggleFullscreen = () => {
    const root = rootRef.current
    if (!root) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void root.requestFullscreen?.().catch(() => {})
  }

  // images 若在開啟期間變短,索引仍要落在範圍內
  const safeIndex = count === 0 ? -1 : Math.min(index, count - 1)
  const current = safeIndex >= 0 ? images[safeIndex] : null
  const go = (delta: number) => setIndex((i) => clamp(Math.min(i, count - 1) + delta, 0, Math.max(0, count - 1)))

  const onNavKey = useEffectEvent((e: KeyboardEvent) => {
    // 焦點圈限:aria-modal 只是告訴讀螢幕軟體,Tab 仍會跑到底下的彈窗與頁面,要自己攔
    if (e.key === 'Tab') {
      const root = rootRef.current
      if (!root) return
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement)
      e.preventDefault()
      e.stopPropagation()
      if (items.length === 0) { root.focus({ preventScroll: true }); return }
      const at = items.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey
        ? (at <= 0 ? items.length - 1 : at - 1)
        : (at < 0 || at >= items.length - 1 ? 0 : at + 1)
      items[next].focus()
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowLeft') go(-1)
    else if (e.key === 'ArrowRight') go(1)
    else return
    e.preventDefault()
    e.stopPropagation() // 捕獲階段就攔下:底下的彈窗收不到這個 Esc
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onNavKey(e)
    window.addEventListener('keydown', onKey, true)

    // 背景鎖捲動(巢狀彈窗時記住原值再還原)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // 焦點移進檢視器(讓觸發按鈕失焦,避免 Enter/空白鍵重複觸發),關閉時還原
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = rootRef.current
    root?.focus({ preventScroll: true })

    // iOS Safari 的整頁捏合縮放(非標準 gesture* 事件)一律擋掉,只縮放圖片
    const stopGesture = (e: Event) => e.preventDefault()
    root?.addEventListener('gesturestart', stopGesture)
    root?.addEventListener('gesturechange', stopGesture)

    const onFs = () => setFsActive(document.fullscreenElement != null && document.fullscreenElement === root)
    document.addEventListener('fullscreenchange', onFs)

    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('fullscreenchange', onFs)
      // 關閉檢視器時若還在全螢幕,一起退出(否則瀏覽器會停在全螢幕的空白畫面)
      if (root && document.fullscreenElement === root) void document.exitFullscreen().catch(() => {})
      document.body.style.overflow = prevOverflow
      root?.removeEventListener('gesturestart', stopGesture)
      root?.removeEventListener('gesturechange', stopGesture)
      prevFocus?.focus({ preventScroll: true })
    }
  }, [])

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="示意圖檢視器"
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex flex-col bg-slate-950/95 text-slate-100 outline-none overscroll-contain touch-manipulation"
    >
      {current ? (
        // key 含索引與網址:換張時整個圖片區重新掛載 → 載入狀態、縮放自動重置
        <ImagePane
          key={`${safeIndex}|${current.url}`}
          image={current}
          index={safeIndex}
          count={count}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onClose={onClose}
          fullscreen={{ supported: fsSupported, active: fsActive, toggle: toggleFullscreen }}
        />
      ) : (
        <>
          <TopBar title="示意圖" onClose={onClose} />
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-slate-400">沒有可顯示的示意圖。</div>
        </>
      )}
    </div>
  )
}

// ── 單張圖片區:載入、縮放、平移、捏合、雙擊 ─────────────────────────────
function ImagePane({
  image,
  index,
  count,
  onPrev,
  onNext,
  onClose,
  fullscreen,
}: {
  image: ZoomableViewerImage
  index: number
  count: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  fullscreen: FullscreenCtl
}) {
  const label = image.label?.trim() || `示意圖 ${index + 1}`

  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0, fit: true })
  const [fitS, setFitS] = useState(1)
  const [animate, setAnimate] = useState(false)
  const [dragging, setDragging] = useState(false)

  const stageRef = useRef<HTMLDivElement>(null)
  // 事件處理用 ref 讀「最新值」:連續的 wheel/pointermove 可能在 React 重繪前連發,
  // 若讀 state 會拿到舊值而累積誤差
  const viewRef = useRef<View>(view)
  const naturalRef = useRef<Size | null>(null)
  const aliveRef = useRef(true)
  const pointersRef = useRef<Map<number, Pt>>(new Map())
  const gestureRef = useRef<Gesture | null>(null)
  const tapRef = useRef<{ t: number; x: number; y: number; moved: boolean; multi: boolean } | null>(null)
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null)

  const minS = Math.min(MIN_SCALE, fitS)

  // ── 核心操作 ──
  const commit = (v: View, withAnimation = false) => {
    viewRef.current = v
    setView(v)
    setAnimate(withAnimation)
  }

  const measure = (): Geo | null => {
    const el = stageRef.current
    const nat = naturalRef.current
    if (!el || !nat) return null
    const w = el.clientWidth
    const h = el.clientHeight
    if (w < 1 || h < 1) return null
    const pad = w < 640 ? 8 : 24
    // 適合視窗不放大超過 1:1(小圖不硬撐滿畫面)
    const fit = Math.max(0.01, Math.min(1, (w - pad * 2) / nat.w, (h - pad * 2) / nat.h))
    return { w, h, nat, fitS: fit, minS: Math.min(MIN_SCALE, fit) }
  }

  /** 縮放到 targetS,錨點 (cx, cy) 在舞台座標中保持不動;未給錨點則用舞台中心 */
  const zoomTo = (targetS: number, cx?: number, cy?: number, withAnimation = false) => {
    const g = measure()
    if (!g) return
    const v0 = viewRef.current
    const s = clamp(targetS, g.minS, MAX_SCALE)
    const ax = cx ?? g.w / 2
    const ay = cy ?? g.h / 2
    const r = s / v0.s
    commit(clampPan({ s, x: ax - (ax - v0.x) * r, y: ay - (ay - v0.y) * r, fit: false }, g), withAnimation)
  }

  const zoomBy = (factor: number) => zoomTo(viewRef.current.s * factor, undefined, undefined, true)

  const applyFit = (withAnimation = true) => {
    const g = measure()
    if (!g) return
    setFitS(g.fitS)
    commit(fitView(g), withAnimation)
  }

  /** 雙擊:在「適合視窗」與「1:1」之間切換 */
  const toggleFitActual = (x: number, y: number) => {
    const g = measure()
    if (!g) return
    const v = viewRef.current
    const atFit = v.fit || Math.abs(v.s - g.fitS) <= g.fitS * 0.02
    if (!atFit) {
      setFitS(g.fitS)
      commit(fitView(g), true)
      return
    }
    // 小圖的適合視窗本來就是 1:1 時,改放大到 2x,雙擊才有反應
    zoomTo(g.fitS >= 0.999 ? 2 : 1, x, y, true)
  }

  // ── 圖片載入 ──
  const handleLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const reveal = () => {
      if (!aliveRef.current) return
      naturalRef.current = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 }
      const g = measure()
      if (g) {
        setFitS(g.fitS)
        commit(fitView(g))
      }
      setStatus('ok')
    }
    // 等解碼完成再顯示;部分瀏覽器對超大圖 decode() 會 reject,照樣顯示即可
    if (typeof img.decode === 'function') img.decode().then(reveal, reveal)
    else reveal()
  }

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // ── 滾輪縮放(必須用原生 listener + passive:false 才能 preventDefault 擋掉頁面捲動)──
  const onWheel = useEffectEvent((e: WheelEvent) => {
    e.preventDefault()
    if (status !== 'ok') return
    const el = stageRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let dy = e.deltaY
    if (e.deltaMode === 1) dy *= 16 // 以「行」為單位(Firefox 舊行為)
    else if (e.deltaMode === 2) dy *= rect.height // 以「頁」為單位
    dy = clamp(dy, -400, 400) // 防止一次滾太多直接飛到極限
    const k = e.ctrlKey ? 0.01 : 0.0015 // ctrlKey = 觸控板捏合,delta 小、要較靈敏
    zoomTo(viewRef.current.s * Math.exp(-dy * k), e.clientX - rect.left, e.clientY - rect.top)
  })

  // ── 視窗尺寸改變:適合視窗模式就重新適合,否則只校正平移範圍 ──
  const onStageResize = useEffectEvent(() => {
    if (status !== 'ok') return
    const g = measure()
    if (!g) return
    setFitS(g.fitS)
    const v = viewRef.current
    commit(v.fit ? fitView(g) : clampPan({ ...v, s: Math.max(v.s, g.minS) }, g))
  })

  // ── 縮放鍵盤(Esc/←→ 由外殼處理)──
  const onZoomKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || status !== 'ok') return // Ctrl+± 留給瀏覽器
    if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP) // '=' 是美式鍵盤不按 Shift 的 '+'
    else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_STEP)
    else if (e.key === '0') applyFit(true)
    else return
    e.preventDefault()
    e.stopPropagation()
  })

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const wheel = (e: WheelEvent) => onWheel(e)
    const key = (e: KeyboardEvent) => onZoomKey(e)
    el.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('keydown', key, true)
    const ro = new ResizeObserver(() => onStageResize())
    ro.observe(el)
    return () => {
      el.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', key, true)
      ro.disconnect()
    }
  }, [])

  // ── Pointer events:一指/滑鼠拖曳平移、兩指捏合縮放、雙擊偵測 ──
  const localPt = (e: ReactPointerEvent): Pt => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  /** 依目前按住的指頭數重新起算手勢(從 2 指變 1 指時不會跳動) */
  const beginGesture = () => {
    const pts = [...pointersRef.current.values()]
    const v0 = viewRef.current
    if (pts.length >= 2) gestureRef.current = { kind: 'pinch', d0: Math.max(1, dist(pts[0], pts[1])), m0: mid(pts[0], pts[1]), v0 }
    else if (pts.length === 1) gestureRef.current = { kind: 'pan', p0: pts[0], v0 }
    else gestureRef.current = null
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (status !== 'ok') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // 拖出舞台/視窗外仍持續收到事件;指標已失效時瀏覽器會丟例外,忽略即可
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 無作用中指標 */ }
    const p = localPt(e)
    pointersRef.current.set(e.pointerId, p)
    if (pointersRef.current.size === 1) tapRef.current = { t: e.timeStamp, x: p.x, y: p.y, moved: false, multi: false }
    else if (tapRef.current) tapRef.current.multi = true
    beginGesture()
    setDragging(true)
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return
    const p = localPt(e)
    pointersRef.current.set(e.pointerId, p)
    const tap = tapRef.current
    if (tap && !tap.moved && Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP) tap.moved = true

    const gst = gestureRef.current
    const g = measure()
    if (!gst || !g) return
    if (gst.kind === 'pan') {
      const { v0, p0 } = gst
      commit(clampPan({ s: v0.s, x: v0.x + p.x - p0.x, y: v0.y + p.y - p0.y, fit: false }, g))
      return
    }
    // 捏合:起始中點底下的圖片座標,要跟著「目前中點」走 → 同時處理縮放與雙指平移
    const pts = [...pointersRef.current.values()]
    if (pts.length < 2) return
    const { v0, d0, m0 } = gst
    const s = clamp(v0.s * (dist(pts[0], pts[1]) / d0), g.minS, MAX_SCALE)
    const m = mid(pts[0], pts[1])
    const ix = (m0.x - v0.x) / v0.s
    const iy = (m0.y - v0.y) / v0.s
    commit(clampPan({ s, x: m.x - ix * s, y: m.y - iy * s, fit: false }, g))
  }

  const handlePointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.delete(e.pointerId)) return
    if (pointersRef.current.size > 0) {
      beginGesture()
      return
    }
    gestureRef.current = null
    setDragging(false)

    // 雙擊/雙點偵測(不用 onDoubleClick:手機上 dblclick 不可靠,且與 pointer 手勢打架)
    const tap = tapRef.current
    tapRef.current = null
    if (e.type !== 'pointerup' || !tap || tap.moved || tap.multi || e.timeStamp - tap.t > TAP_MAX_MS) return
    const last = lastTapRef.current
    if (last && tap.t - last.t < DOUBLE_TAP_MS && Math.hypot(tap.x - last.x, tap.y - last.y) < DOUBLE_TAP_DIST) {
      lastTapRef.current = null
      toggleFitActual(tap.x, tap.y)
    } else {
      lastTapRef.current = { t: e.timeStamp, x: tap.x, y: tap.y }
    }
  }

  const pct = Math.round(view.s * 100)
  const atMin = view.s <= minS * 1.001
  const atMax = view.s >= MAX_SCALE * 0.999
  const isActual = Math.abs(view.s - 1) < 0.001
  const hasMany = count > 1

  return (
    <>
      <TopBar
        title={label}
        counter={hasMany ? `${index + 1} / ${count}` : undefined}
        hint="滾輪縮放・拖曳平移・雙擊切換適合視窗/100%"
        onClose={onClose}
        url={image.url}
        fullscreen={fullscreen}
      />

      <div className="relative min-h-0 flex-1">
        {/* 舞台:touch-none 讓瀏覽器不處理觸控捲動/縮放,全部交給 pointer events */}
        <div
          ref={stageRef}
          className="absolute inset-0 touch-none select-none overflow-hidden"
          style={{ cursor: status === 'ok' ? (dragging ? 'grabbing' : 'grab') : 'default' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={handlePointerEnd}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- 需原圖原尺寸 + transform,next/image 不適用 */}
          <img
            src={image.url}
            alt={label}
            decoding="async"
            draggable={false}
            onLoad={handleLoad}
            onError={() => setStatus('error')}
            className={`absolute left-0 top-0 max-w-none origin-top-left select-none bg-white ${
              status === 'ok' ? 'opacity-100' : 'opacity-0'
            } ${animate ? 'transition-transform duration-200 ease-out' : ''}`}
            style={{
              // 只改 transform:不重排、不重新載入;位移取整數 px 避免次像素模糊
              transform: `translate3d(${Math.round(view.x)}px, ${Math.round(view.y)}px, 0) scale(${view.s})`,
              willChange: 'transform',
              WebkitTouchCallout: 'none',
            }}
          />
        </div>

        {status === 'loading' && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-700 border-t-sky-400" />
            <p className="text-sm text-slate-200">原圖載入中…</p>
            <p className="text-xs text-slate-400">示意圖原檔較大(約 2~5MB),請稍候</p>
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="w-full max-w-sm rounded-xl border border-red-800/60 bg-slate-900 px-6 py-5 text-center shadow-2xl">
              <p className="font-medium text-red-300">⚠ 圖片載入失敗</p>
              <p className="mt-2 text-sm text-slate-400">可能是網路中斷、網址已過期或檔案不存在。</p>
              <a
                href={image.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex h-11 items-center justify-center rounded-lg bg-sky-700 px-4 text-sm font-medium text-white transition-colors hover:bg-sky-600"
              >
                在新分頁開啟原圖 ↗
              </a>
            </div>
          </div>
        )}

        {/* 左右切換(大按鈕,手機好點) */}
        {hasMany && (
          <>
            <RoundButton label="上一張 (←)" onClick={onPrev} disabled={index <= 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 sm:left-4 h-12 w-12 border border-slate-700 bg-slate-900/85 shadow-lg">
              <Icon d="M15 18l-6-6 6-6" />
            </RoundButton>
            <RoundButton label="下一張 (→)" onClick={onNext} disabled={index >= count - 1}
              className="absolute right-2 top-1/2 -translate-y-1/2 sm:right-4 h-12 w-12 border border-slate-700 bg-slate-900/85 shadow-lg">
              <Icon d="M9 18l6-6-6-6" />
            </RoundButton>
          </>
        )}

        {/* 底部縮放工具列 */}
        {status === 'ok' && (
          <div className="absolute bottom-[calc(env(safe-area-inset-bottom)_+_0.75rem)] left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-slate-700 bg-slate-900/90 px-1.5 py-1 shadow-xl">
            <RoundButton label="縮小 (-)" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={atMin}>
              <Icon d="M5 12h14" />
            </RoundButton>
            <span className="w-14 text-center font-mono text-sm tabular-nums text-slate-300" aria-live="polite">
              {pct}%
            </span>
            <RoundButton label="放大 (+)" onClick={() => zoomBy(ZOOM_STEP)} disabled={atMax}>
              <Icon d="M12 5v14M5 12h14" />
            </RoundButton>
            <span className="mx-0.5 h-6 w-px bg-slate-700" aria-hidden="true" />
            <RoundButton label="適合視窗 (0)" onClick={() => applyFit(true)} active={view.fit}>
              <Icon d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </RoundButton>
            <RoundButton label="1:1 原始大小" onClick={() => zoomTo(1, undefined, undefined, true)} active={isActual}>
              <span className="text-sm font-semibold">1:1</span>
            </RoundButton>
          </div>
        )}
      </div>
    </>
  )
}

// ── 小元件 ──────────────────────────────────────────────────────────────────
function TopBar({ title, counter, hint, onClose, url, fullscreen }: {
  title: string
  counter?: string
  hint?: string
  onClose: () => void
  /** 有給就顯示「在新分頁開原圖」(網址一律用 API 給的,前端不自行拼接) */
  url?: string
  fullscreen?: FullscreenCtl
}) {
  return (
    <div className="flex min-h-14 flex-shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-900/90 pl-4 pr-2 pt-[env(safe-area-inset-top)]">
      <div className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100 sm:text-base" title={title}>
        {title}
      </div>
      {counter && <span className="flex-shrink-0 font-mono text-xs tabular-nums text-slate-400 sm:text-sm">{counter}</span>}
      {hint && <span className="hidden flex-shrink-0 text-xs text-slate-400 lg:block">{hint}</span>}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="在新分頁開原圖"
          title="在新分頁開原圖(可另存下載)"
          className="inline-flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center rounded-full text-slate-200 transition-colors hover:bg-slate-700 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          <Icon d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </a>
      )}
      {fullscreen?.supported && (
        <RoundButton
          label={fullscreen.active ? '離開全螢幕' : '全螢幕'}
          onClick={fullscreen.toggle}
          active={fullscreen.active}
          className="flex-shrink-0"
        >
          <Icon d={fullscreen.active ? 'M4 14h6v6M10 14l-7 7M20 10h-6V4M14 10l7-7' : 'M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7'} />
        </RoundButton>
      )}
      <RoundButton label="關閉 (Esc)" onClick={onClose} className="flex-shrink-0">
        <Icon d="M6 6l12 12M18 6L6 18" />
      </RoundButton>
    </div>
  )
}

function RoundButton({
  label,
  onClick,
  disabled,
  active,
  className = 'h-11 w-11',
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full transition-colors hover:bg-slate-700 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:pointer-events-none disabled:opacity-30 ${
        active ? 'bg-slate-700 text-sky-300' : 'text-slate-200'
      } ${className}`}
    >
      {children}
    </button>
  )
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
