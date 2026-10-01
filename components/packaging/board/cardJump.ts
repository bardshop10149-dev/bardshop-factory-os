'use client'

// D113 排程區單號搜尋：「跳到卡片」＝等卡片出現在畫面上 → 捲過去 → 邊框發光（正式工作台與 AI 模擬區共用）。
//
// 為什麼要「等」：跳轉前可能要先換日期（正式工作台要等新視窗的資料回來，D98 佇列沒清空前還不會套用）、
// 打開收起的待排池、展開左欄區塊、多畫幾頁、打開模擬區待排區的 <details>……卡片什麼時候掛上 DOM 不確定。
// 所以 request() 只登記目標，用 MutationObserver（有 DOM 變動就檢查）＋每 250ms 輪詢兜底去找
// [data-placement-id="…"]／[data-pool-card-id="…"]；找到而且真的看得到（getClientRects 非空：display:none、
// 沒展開的 <details> 都是 0）才捲動與發光。15 秒還找不到 → onFail（呼叫端 toast 並重新搜尋一次）。
//
// 換日期的跳轉分兩段（gate，呼叫端提供）：
//   ① 等新視窗的資料「真的套用」（gate＝wait）：舊視窗的 DOM 也可能有這張卡（週檢視的舊週含目標日），不能在舊畫面上就捲——
//      新資料套用後欄位重排、捲動位置留在舊版面，卡片會落到畫面外。這一段受存檔佇列（D98）支配、可能很久，不算逾時；
//      超過 15 秒只通知一次 onSlow（呼叫端說明「存檔還沒完成」），繼續等。使用者自己換到別段（gate＝gone）→ 靜靜放棄。
//   ② 新資料已套用（gate＝ready）才開始找卡，15 秒逾時；新資料裡根本沒有這張（gate＝missing）→ 不必等，立刻 onFail。
//
// 拖曳／拉卡片下緣改工時的時候不能程式捲動（dnd-kit 的插入點、工時換算會算錯）：呼叫端在 onDragStart、onResizing(true) 呼叫 cancel()。
// cancel() 連「已找到卡之後」的補捲與 overflow:hidden 釘選也一起停掉（不然 0.9 秒內開始拖曳，畫面還會被補捲拉走）。

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { JumpGateState, JumpTarget } from '@/lib/packaging/boardSearch'
import { FIND_BASE_CSS, GLOW_MS, cssAttr, findGlowCss, type GlowTarget } from './findGlow'

export const JUMP_TIMEOUT_MS = 15_000
/** smooth 捲動後多久檢查一次「真的捲到了嗎」（巢狀捲動容器搭配 smooth，各瀏覽器行為不一致） */
const RECHECK_MS = 900
/** 保護 overflow:hidden 祖先多久（smooth 捲動期間） */
const PIN_MS = 1500
/** 使用者自己捲動的按鍵（在這些鍵之後不再補捲） */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/** 把卡片外層所有關著的 <details> 打開（模擬區的待排區預設收合；只到 root 為止） */
function openAncestorDetails(el: HTMLElement, root: HTMLElement): void {
  for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
    if (p instanceof HTMLDetailsElement && !p.open) p.open = true
  }
}

function isScrollable(el: Element): boolean {
  const s = getComputedStyle(el)
  return /(auto|scroll)/.test(`${s.overflowY} ${s.overflowX}`)
}

/**
 * scrollIntoView 連 overflow:hidden 的祖先也會捲（它們也是捲動容器）：DayLanesView 的 section、工作台根元素（lg:overflow-hidden）。
 * 平常它們內容剛好放得下、捲不動；萬一內容超出，被捲了畫面會整個錯位且使用者捲不回來 → 記下位置，捲動期間被改就立刻拉回。
 */
function pinHiddenOverflow(el: HTMLElement): () => void {
  const pinned: { node: HTMLElement; top: number; left: number; onScroll: () => void }[] = []
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p)
    // 只釘 hidden 的那個方向：overflow-x-hidden＋overflow-y-auto 的容器，直向本來就該捲（釘死會捲不到卡片）
    const pinY = s.overflowY === 'hidden', pinX = s.overflowX === 'hidden'
    if (!pinX && !pinY) continue
    const node = p
    const top = node.scrollTop, left = node.scrollLeft
    const onScroll = () => {
      if (pinY && node.scrollTop !== top) node.scrollTop = top
      if (pinX && node.scrollLeft !== left) node.scrollLeft = left
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    pinned.push({ node, top, left, onScroll })
  }
  return () => {
    for (const x of pinned) {
      x.node.removeEventListener('scroll', x.onScroll)
      x.onScroll()
    }
  }
}

/** 卡片是否在每一層捲動容器與視窗裡都至少露出一截（24px） */
function isVisibleIn(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.min(a2, b2) - Math.max(a1, b1)
  const need = (len: number) => Math.min(24, Math.max(1, len))
  if (overlap(r.top, r.bottom, 0, window.innerHeight) < need(r.height)) return false
  if (overlap(r.left, r.right, 0, window.innerWidth) < need(r.width)) return false
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (!isScrollable(p)) continue
    const c = p.getBoundingClientRect()
    if (overlap(r.top, r.bottom, c.top, c.bottom) < need(r.height)) return false
    if (overlap(r.left, r.right, c.left, c.right) < need(r.width)) return false
  }
  return true
}

/**
 * 捲到卡片：block center、inline center（週檢視是橫向捲動＋每條線自己直向捲動，兩個方向都要）。
 * 卡片比最近的捲動容器高 60% 以上（日檢視的長卡）→ 改 block start，配合 scroll-margin-top 避開 sticky 線頭。
 * 使用者設定減少動態效果 → 不用 smooth。smooth 模式 900ms 後再檢查，沒捲到就用 auto 補一次——
 * 但這段期間使用者自己捲了（滾輪、觸控、按下滑鼠＝拖曳或拉捲軸、捲動鍵）就不補，尊重使用者。
 * 回傳 stop()：清掉補捲、立刻放開釘選、拿掉監聽（拖曳開始、下一次跳轉、卸載時呼叫）。
 */
export function scrollCardIntoView(el: HTMLElement): () => void {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const behavior: ScrollBehavior = reduce ? 'auto' : 'smooth'
  let sc: HTMLElement | null = null
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (isScrollable(p)) { sc = p; break }
  }
  const tall = !!sc && el.getBoundingClientRect().height > sc.clientHeight * 0.6
  const block: ScrollLogicalPosition = tall ? 'start' : 'center'
  const release = pinHiddenOverflow(el)
  el.scrollIntoView({ behavior, block, inline: 'center' })
  let recheck: number | null = null
  let releaseTimer: number | null = null
  let done = false
  // 使用者自己動了（滾輪、觸控、按下滑鼠＝拖曳或拉捲軸、捲動鍵）→ 不再補捲；釘選照舊到時放開（只擋程式捲動 hidden 祖先）
  const onUser = (e: Event) => {
    if (e.type === 'keydown' && !SCROLL_KEYS.has((e as KeyboardEvent).key)) return
    if (recheck != null) { window.clearTimeout(recheck); recheck = null }
  }
  const USER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  const listen = behavior === 'smooth'
  if (listen) for (const t of USER_EVENTS) window.addEventListener(t, onUser, { capture: true, passive: true })
  const unlisten = () => {
    if (listen) for (const t of USER_EVENTS) window.removeEventListener(t, onUser, { capture: true })
  }
  const stop = () => {
    if (done) return
    done = true
    if (recheck != null) { window.clearTimeout(recheck); recheck = null }
    if (releaseTimer != null) { window.clearTimeout(releaseTimer); releaseTimer = null }
    unlisten()
    release()
  }
  if (behavior === 'smooth') {
    recheck = window.setTimeout(() => {
      recheck = null
      if (el.isConnected && !isVisibleIn(el)) el.scrollIntoView({ behavior: 'auto', block, inline: 'center' })
    }, RECHECK_MS)
  }
  releaseTimer = window.setTimeout(() => { releaseTimer = null; stop() }, behavior === 'smooth' ? PIN_MS : 0)
  return stop
}

export interface CardJumpApi {
  /**
   * 登記要跳的卡（取消前一個）；note＝等待中顯示在搜尋框旁（例「前往 10/15…」）；
   * gate＝換日期時的前提（見檔頭；不傳＝目前畫面就是對的，直接找卡）
   */
  request: (target: JumpTarget, note?: string | null, gate?: () => JumpGateState) => void
  /** 取消等待中的跳轉，連同已開始的補捲／釘選（拖曳開始、拉下緣改工時） */
  cancel: () => void
  /** 等待中的跳轉（顯示「前往 M/D…」） */
  pending: { target: JumpTarget; note: string | null } | null
  /** 頁面根元素要輸出的 <style> 內容（基本 scroll-margin＋目前發光的那張卡） */
  css: string
}

export function useCardJump({ rootRef, onFail, onDone, onSlow }: {
  /** 搜尋範圍（工作台／模擬區的根元素，帶 data-search-root） */
  rootRef: RefObject<HTMLElement | null>
  /** 找不到卡：新資料已套用卻沒有這張（gate＝missing），或看得到的畫面上 15 秒都沒出現 */
  onFail?: (target: JumpTarget) => void
  /** 找到並捲過去了（呼叫端收掉「揭露」用的暫時狀態，例如左欄的 reveal） */
  onDone?: (target: JumpTarget) => void
  /** 換日期等了 15 秒新資料還沒套用（存檔佇列還沒清空等）：只通知一次，繼續等 */
  onSlow?: (target: JumpTarget) => void
}): CardJumpApi {
  const [glow, setGlow] = useState<GlowTarget | null>(null)
  const [pending, setPending] = useState<{ target: JumpTarget; note: string | null } | null>(null)
  const runRef = useRef<(() => void) | null>(null)
  /** 已找到卡之後的捲動（補捲、釘選）：cancel／下一次跳轉／卸載時停掉 */
  const scrollStopRef = useRef<(() => void) | null>(null)
  const glowTimerRef = useRef<number | null>(null)
  const glowNRef = useRef(0)
  const onFailRef = useRef(onFail)
  const onDoneRef = useRef(onDone)
  const onSlowRef = useRef(onSlow)
  useEffect(() => { onFailRef.current = onFail; onDoneRef.current = onDone; onSlowRef.current = onSlow })

  const stopScroll = useCallback(() => {
    const s = scrollStopRef.current
    scrollStopRef.current = null
    s?.()
  }, [])

  const cancel = useCallback(() => {
    stopScroll()
    const stop = runRef.current
    runRef.current = null
    if (stop) { stop(); setPending(null) }
  }, [stopScroll])

  const request = useCallback((target: JumpTarget, note: string | null = null, gate?: () => JumpGateState) => {
    runRef.current?.()
    stopScroll()
    const root = rootRef.current ?? document.body
    const sel = `[${target.attr}="${cssAttr(target.id)}"]`
    let stopped = false
    let raf = 0
    const obs = new MutationObserver(() => check())
    const poll = window.setInterval(() => check(), 250)
    /** ② 找卡的 15 秒逾時：沒有 gate＝現在就開始；有 gate＝新資料套用（ready）才開始 */
    let failTimer: number | null = null
    /** ① 等新資料套用超過 15 秒：通知一次（不停止） */
    let slowTimer: number | null = null
    function stop() {
      stopped = true
      obs.disconnect()
      window.clearInterval(poll)
      if (failTimer != null) window.clearTimeout(failTimer)
      if (slowTimer != null) window.clearTimeout(slowTimer)
      if (raf) window.cancelAnimationFrame(raf)
    }
    /** 結束這次跳轉（fn＝結束後要通知的事） */
    function finish(fn?: () => void) {
      stop()
      if (runRef.current === stop) runRef.current = null
      setPending(null)
      fn?.()
    }
    function armFail() {
      if (failTimer != null) return
      failTimer = window.setTimeout(() => finish(() => onFailRef.current?.(target)), JUMP_TIMEOUT_MS)
    }
    /** gate 的判斷；ready 以外都不找卡（wait 繼續等、gone 放棄、missing 報找不到） */
    function gateReady(): boolean {
      if (!gate) return true
      const g = gate()
      if (g === 'ready') { armFail(); return true }
      if (g === 'gone') finish()
      else if (g === 'missing') finish(() => onFailRef.current?.(target))
      return false
    }
    function check() {
      if (stopped || raf) return
      if (!gateReady()) return
      const el = root.querySelector<HTMLElement>(sel)
      if (!el) return
      openAncestorDetails(el, root)
      // 等一個 frame：<details> 剛打開、區塊剛展開時版面還沒算好
      raf = window.requestAnimationFrame(() => {
        raf = 0
        if (stopped) return
        // 這一個 frame 裡使用者又換了日期（gate 不再是 ready）→ 照 gate 處理
        if (!gateReady()) return
        // 已被換掉（輪詢重畫重新掛載）或還看不到（display:none）→ 等下一次 DOM 變動／輪詢再找
        if (!el.isConnected || el.getClientRects().length === 0) return
        finish()
        scrollStopRef.current = scrollCardIntoView(el)
        glowNRef.current += 1
        setGlow({ attr: target.attr, id: target.id, n: glowNRef.current })
        if (glowTimerRef.current != null) window.clearTimeout(glowTimerRef.current)
        glowTimerRef.current = window.setTimeout(() => { glowTimerRef.current = null; setGlow(null) }, GLOW_MS)
        onDoneRef.current?.(target)
      })
    }
    if (gate) {
      slowTimer = window.setTimeout(() => {
        slowTimer = null
        if (!stopped && gate() === 'wait') onSlowRef.current?.(target)
      }, JUMP_TIMEOUT_MS)
    } else {
      armFail()
    }
    runRef.current = stop
    setPending({ target, note })
    obs.observe(root, { childList: true, subtree: true })
    check()
  }, [rootRef, stopScroll])

  // 卸載：停掉等待、補捲與發光計時器
  useEffect(() => () => {
    runRef.current?.()
    runRef.current = null
    scrollStopRef.current?.()
    scrollStopRef.current = null
    if (glowTimerRef.current != null) window.clearTimeout(glowTimerRef.current)
  }, [])

  const css = useMemo(() => (glow ? `${FIND_BASE_CSS}\n${findGlowCss(glow)}` : FIND_BASE_CSS), [glow])
  return useMemo(() => ({ request, cancel, pending, css }), [request, cancel, pending, css])
}
