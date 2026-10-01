'use client'

// D113 排程區單號搜尋：「找卡」輸入框＋結果清單（正式工作台與 AI 模擬區共用，D100 兩邊一致）。
//
// 行為：
//   打字（debounce 350ms、至少 3 碼）→ 清單列出所有符合的卡：排定日、線、線內第幾張、數量、延誤／完成／預排、待排區、待排池、
//   隱藏或結案的原因。Enter＝跳到下一筆（第一次＝第一筆；還沒搜完就等結果回來再跳）、Shift+Enter／▲＝上一筆、↑↓＝只移動選取、
//   點一列＝跳那筆、Esc＝先關清單再清空。跳過去之後清單收起來（不然會蓋住剛捲到的卡），旁邊留「2/5 ▲▼」可以接著切換。
//   手機：跳完就 blur，讓鍵盤收起來看得到卡片。
// 資料來源由呼叫端決定：
//   local  ＝在畫面資料裡找（同步；資料一變就重算，拖過的卡位置立刻是新的）
//   remote ＝伺服器找全部日期（正式工作台才有；依查詢快取 30 秒，跳轉找不到卡時 refreshToken +1 強制重搜）
//   merge  ＝把兩份合併（正式工作台：同一張卡以畫面為準，見 boardSearch.mergeBoardHits）
// 伺服器結果會過期（使用者剛把卡排到／移到畫面外的日期，畫面上看不到、只能靠伺服器）——三個地方讓它跟上：
//   ① epoch（正式工作台傳 board.lastSavedAt）：每次寫入成功就變 → 快取作廢；清單開著就立刻重搜，收著就等打開清單或按 Enter 時再搜
//      （不必每次存檔都打一次伺服器——伺服器搜尋要重組整個工作台）；
//   ② 合併結果出現「位置剛變更」（伺服器說在已載入的那天、畫面上卻沒有）→ 強制重搜一次（同一個查詢＋epoch 只一次，存檔還沒完成時不會一直重打）；
//   ③ 查詢沒變、但伺服器結果已超過 30 秒時按 Enter／▲▼ → 先重搜再跳（不沿用打字當下的結果）。
// 和左欄待排池自己的過濾框分工：那個只過濾左欄；這個是「找卡 → 跳過去」，所以 placeholder 寫「找卡：」。
//
// 鍵盤注意：輸入框是 INPUT，工作台的 Ctrl+Z 處理本來就會略過；下拉清單不帶 data-board-dialog（帶了會停掉 Ctrl+Z）。
//   注音／倉頡輸入法組字中按 Enter 是「選字」，不能當成搜尋（isComposing）。
//   Esc 用掉時 stopPropagation：模擬區的抽屜、對話框在 window 上聽 Esc，不然會一起被關掉。

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  SEARCH_MAX_HITS,
  SEARCH_QUERY_HINT,
  capHits,
  enterTargetKey,
  hasStaleRemote,
  hitNotes,
  hitPlaceText,
  jumpAnnounce,
  navPosition,
  parseSearchQuery,
  sortHits,
  type SearchHit,
  type SearchQuery,
} from '@/lib/packaging/boardSearch'
import { fmtQty } from '@/components/packaging/poolStyles'

const DEBOUNCE_MS = 350
const REMOTE_TTL_MS = 30_000

export type RemoteSearchResult = { ok: true; hits: SearchHit[]; truncated: number } | { ok: false; error: string }

type Epoch = number | string | null
/** epoch＝送出當下的資料世代（快取依它作廢） */
type Req = { sq: SearchQuery; n: number; force: boolean; epoch: Epoch }
/** at＝伺服器結果取得的時間（快取命中＝當初取得的時間）：超過 TTL 時 Enter 先重搜 */
type RemoteEntry = { n: number; q: string; at: number; hits: SearchHit[]; truncated: number; error: string | null }
type Mode = 'enter' | 'next' | 'prev'

export interface OrderSearchProps {
  local: (sq: SearchQuery) => SearchHit[]
  remote?: (sq: SearchQuery, signal: AbortSignal) => Promise<RemoteSearchResult>
  merge?: (remote: SearchHit[], local: SearchHit[]) => SearchHit[]
  /** +1＝強制重新搜尋（略過快取）：跳轉 15 秒找不到卡時 */
  refreshToken?: number
  /** 資料世代（正式工作台＝最後一次存檔成功的時間）：一變就作廢伺服器結果的快取，有查詢時強制重搜 */
  epoch?: Epoch
  /** 跳轉失敗（呼叫端已 toast）：n 一變就把報讀文字改成 text（原本在發出跳轉時就寫了「已跳到…」） */
  jumpFail?: { n: number; text: string } | null
  /** 回 false＝這筆跳不過去（呼叫端已用 toast 說明原因，例如結案處理中、拖曳中）：不記成「已跳到」 */
  onJump: (hit: SearchHit) => boolean | void
  /** 「隱藏已完成」開著：第幾張改用不含已完成的順序（和畫面一致） */
  hideCompleted: boolean
  /** 標頭說明搜尋範圍 */
  scopeNote: string
  /** 拖曳中停用 */
  disabled?: boolean
  isDesktop: boolean
  /** 跳轉等待中（例「前往 10/15…」） */
  pendingNote?: string | null
  /** 已結案的列提供「開結案池」 */
  onOpenClosures?: () => void
}

export default function OrderSearch(props: OrderSearchProps) {
  const { local, remote, merge, refreshToken = 0, epoch = null, jumpFail = null, hideCompleted, scopeNote, disabled = false, pendingNote, onOpenClosures } = props
  const [text, setText] = useState('')
  const [req, setReq] = useState<Req | null>(null)
  const [remoteEntry, setRemoteEntry] = useState<RemoteEntry | null>(null)
  const [open, setOpen] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [jumpedKey, setJumpedKey] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const cacheRef = useRef(new Map<string, { at: number; epoch: Epoch; hits: SearchHit[]; truncated: number }>())
  /** 還沒搜完（或正在重搜）就按了 Enter／▲▼：結果回來後要跳的方向，以及按下當時的選取／已跳位置 */
  const pendingRef = useRef<{ mode: Mode; active: string | null; jumped: string | null } | null>(null)
  /** 最新的 props（非同步回呼裡用；render 期間不讀） */
  const propsRef = useRef(props)
  useEffect(() => { propsRef.current = props })
  const listId = useId()

  // 跳轉找不到卡 → 呼叫端 refreshToken +1 → 強制重搜（React 建議的「依 prop 變化調整 state」：render 中比對前值）
  const [seenRefresh, setSeenRefresh] = useState(refreshToken)
  if (seenRefresh !== refreshToken) {
    setSeenRefresh(refreshToken)
    if (req) setReq({ sq: req.sq, n: req.n + 1, force: true, epoch })
  }
  const parsed = parseSearchQuery(text)
  // ① 寫入成功過（epoch 變了）＝伺服器結果可能過期：清單開著、框裡還是同一個查詢就立刻強制重搜
  //    （setReq 後 req.epoch＝epoch，不會再進來；正在打新的單號時不重搜舊的，等 debounce 搜新的）
  const remoteOutdated = !!remote && !!req && req.epoch !== epoch
  if (remoteOutdated && open && req && parsed?.q === req.sq.q) setReq({ sq: req.sq, n: req.n + 1, force: true, epoch })
  // 跳轉失敗：報讀文字改成失敗原因
  const [seenFail, setSeenFail] = useState(jumpFail?.n ?? 0)
  if (jumpFail && jumpFail.n !== seenFail) {
    setSeenFail(jumpFail.n)
    setAnnounce(jumpFail.text)
  }

  const sq = req?.sq ?? null
  const remoteView = remote && remoteEntry && sq && remoteEntry.q === sq.q ? remoteEntry : null
  const loading = !!remote && !!req && (!remoteEntry || remoteEntry.n !== req.n)
  const localHits = useMemo(() => (sq ? local(sq) : []), [sq, local])
  const result = useMemo(() => {
    if (!sq) return { hits: [] as SearchHit[], truncated: 0, stale: false }
    const all = merge ? merge(remoteView?.hits ?? [], localHits) : sortHits(localHits)
    const c = capHits(all, SEARCH_MAX_HITS)
    return { hits: c.hits, truncated: c.truncated + (remoteView?.truncated ?? 0), stale: hasStaleRemote(all) }
  }, [sq, merge, remoteView, localHits])
  const hits = result.hits
  // ② 伺服器結果比畫面舊（合併出現「位置剛變更」）：強制重搜一次。同一個查詢＋epoch 只重搜一次——
  //    自己剛移動、還沒存完時伺服器也還是舊的，再打也一樣；存完 epoch 一變，①會再搜
  const [staleTried, setStaleTried] = useState<string | null>(null)
  const staleKey = req && remoteView && !loading && result.stale ? `${req.sq.q}|${String(req.epoch)}` : null
  if (staleKey && req && staleKey !== staleTried) {
    setStaleTried(staleKey)
    setReq({ sq: req.sq, n: req.n + 1, force: true, epoch })
  }
  /** 打字中（debounce 還沒到）：清單是上一個查詢的結果 */
  const typing = !!parsed && (!sq || sq.q !== parsed.q)
  const nav = navPosition(hits, jumpedKey)

  // 伺服器搜尋：只在查詢（req）變了才打；回應只在非同步回呼裡 setState
  useEffect(() => {
    if (!req || !remote) return
    const ac = new AbortController()
    let live = true
    const deliver = (e: Omit<RemoteEntry, 'n'>) => {
      if (!live) return
      setRemoteEntry({ ...e, n: req.n })
      const pend = pendingRef.current
      if (pend) {
        pendingRef.current = null
        const p = propsRef.current
        const l = p.local(req.sq)
        const all = p.merge ? p.merge(e.hits, l) : sortHits(l)
        // 接著按下 Enter 當時的位置往下跳（重搜不會讓「下一張」回到第一張）；新查詢時 active／jumped 本來就是 null
        jumpIn(capHits(all, SEARCH_MAX_HITS).hits, pend.mode, pend.active, pend.jumped)
      }
    }
    const cached = cacheRef.current.get(req.sq.q)
    if (!req.force && cached && cached.epoch === req.epoch && Date.now() - cached.at < REMOTE_TTL_MS) {
      void Promise.resolve().then(() => deliver({ q: req.sq.q, at: cached.at, hits: cached.hits, truncated: cached.truncated, error: null }))
    } else {
      void remote(req.sq, ac.signal).then(r => {
        if (!live || ac.signal.aborted) return
        const at = Date.now()
        if (r.ok) {
          cacheRef.current.set(req.sq.q, { at, epoch: req.epoch, hits: r.hits, truncated: r.truncated })
          deliver({ q: req.sq.q, at, hits: r.hits, truncated: r.truncated, error: null })
        } else {
          // 伺服器失敗：照樣用畫面上的結果（只少了畫面外的日期），標頭寫出原因
          deliver({ q: req.sq.q, at, hits: [], truncated: 0, error: r.error })
        }
      })
    }
    return () => { live = false; ac.abort() }
    // jumpIn 只用 setter 與 ref，刻意不放進相依（放了每次 render 都會重打伺服器）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, remote])

  // 卸載：清掉 debounce
  useEffect(() => () => { if (timerRef.current != null) window.clearTimeout(timerRef.current) }, [])

  function clearTimer() {
    if (timerRef.current != null) { window.clearTimeout(timerRef.current); timerRef.current = null }
  }

  function startSearch(p: SearchQuery) {
    // epoch 取最新的 props（debounce 計時器裡呼叫時，閉包裡的 epoch 可能已過期）
    const ep = propsRef.current.epoch ?? null
    setReq(r => ({ sq: p, n: (r?.n ?? 0) + 1, force: false, epoch: ep }))
    setActiveKey(null)
    setJumpedKey(null)
  }

  function computeNow(p: SearchQuery, remoteHits: SearchHit[]): SearchHit[] {
    const cur = propsRef.current
    const l = cur.local(p)
    return capHits(cur.merge ? cur.merge(remoteHits, l) : sortHits(l), SEARCH_MAX_HITS).hits
  }

  /** 跳到指定的那一筆 */
  function doJump(list: SearchHit[], key: string) {
    const hit = list.find(h => h.key === key)
    if (!hit) return
    const cur = propsRef.current
    setActiveKey(key)
    if (cur.onJump(hit) === false) {
      setAnnounce(`無法跳到 ${hit.label}`)
      return
    }
    setJumpedKey(key)
    setOpen(false)
    setAnnounce(jumpAnnounce(hit, cur.hideCompleted, navPosition(list, key)))
    // 手機：收起鍵盤才看得到卡片；桌機：焦點留在輸入框，下一次 Enter 接著跳下一筆（不聚焦卡片，否則 Enter 會開卡片詳情）
    if (!cur.isDesktop) inputRef.current?.blur()
  }

  function jumpIn(list: SearchHit[], mode: Mode, active: string | null, jumped: string | null) {
    const key = mode === 'enter' ? enterTargetKey(list, active, jumped) : enterTargetKey(list, null, jumped, mode === 'prev')
    if (!key) {
      setAnnounce(list.length > 0 ? '符合的卡目前都無法跳過去（原因見清單）' : '找不到符合的卡')
      setOpen(true)
      return
    }
    doJump(list, key)
  }

  /** Enter、▲、▼ */
  function go(mode: Mode) {
    const p = parseSearchQuery(text)
    if (!p) { setAnnounce(SEARCH_QUERY_HINT); setOpen(true); return }
    clearTimer()
    if (!req || req.sq.q !== p.q) {
      // 還沒搜（或 debounce 還沒到）：立刻搜；沒有伺服器搜尋（模擬區）就地算完直接跳，否則等結果回來再跳
      startSearch(p)
      if (!remote) jumpIn(computeNow(p, []), mode, null, null)
      else { pendingRef.current = { mode, active: null, jumped: null }; setOpen(true) }
      return
    }
    if (loading) { pendingRef.current = { mode, active: activeKey, jumped: jumpedKey }; return }
    // ①③ 存檔過（epoch 變了）或伺服器結果已超過 30 秒：先重搜（剛排到／移到畫面外日期的卡只有伺服器知道），結果回來再跳
    if (remoteOutdated || (remoteView && Date.now() - remoteView.at >= REMOTE_TTL_MS)) {
      setReq({ sq: req.sq, n: req.n + 1, force: true, epoch })
      pendingRef.current = { mode, active: activeKey, jumped: jumpedKey }
      return
    }
    jumpIn(hits, mode, activeKey, jumpedKey)
  }

  function onChange(v: string) {
    setText(v)
    setOpen(true)
    clearTimer()
    pendingRef.current = null
    const p = parseSearchQuery(v)
    if (!p) { setReq(null); setActiveKey(null); setJumpedKey(null); return }
    if (req && req.sq.q === p.q) return // 只差空白、大小寫、全形：同一個查詢
    timerRef.current = window.setTimeout(() => { timerRef.current = null; startSearch(p) }, DEBOUNCE_MS)
  }

  function clearAll() {
    clearTimer()
    pendingRef.current = null
    setText('')
    setReq(null)
    setActiveKey(null)
    setJumpedKey(null)
    setOpen(false)
    setAnnounce('')
  }

  /** ↑↓：只移動清單選取（不跳），並把選到的列捲進清單可視範圍（只捲清單本身，不動整頁） */
  function moveActive(dir: 1 | -1) {
    if (hits.length === 0) return
    const i = hits.findIndex(h => h.key === activeKey)
    const next = i < 0 ? (dir === 1 ? 0 : hits.length - 1) : (i + dir + hits.length) % hits.length
    setActiveKey(hits[next].key)
    setOpen(true)
    const list = listRef.current
    const opt = list?.querySelector<HTMLElement>(`[data-hit-index="${next}"]`)
    if (list && opt) {
      if (opt.offsetTop < list.scrollTop) list.scrollTop = opt.offsetTop
      else if (opt.offsetTop + opt.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = opt.offsetTop + opt.offsetHeight - list.clientHeight
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? 'prev' : 'enter'); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); return }
    if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false) }
      else if (text) { e.preventDefault(); e.stopPropagation(); clearAll() }
    }
  }

  const activeIndex = hits.findIndex(h => h.key === activeKey)
  const navCount = nav.total
  const showList = open && text.trim().length > 0
  const remoteError = remoteView?.error ?? null

  return (
    // 寬度固定（sm 以上 26rem；手機滿寬）：打字後才出現的 ▲▼／計數／✕ 擠的是輸入框本身，整個框不會因此換行跳位；
    // 下拉清單和這個框同寬、靠左對齊 → 框在工具列中段時清單也不會超出視窗右緣（根元素 lg:overflow-hidden 會把超出的部分裁掉）
    <div className="relative flex w-full items-center gap-1 sm:w-[26rem]" data-order-search="">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="找卡：輸入單號或製令號，跳到那張卡"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-o${activeIndex}` : undefined}
        value={text}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => { if (text.trim()) setOpen(true) }}
        onBlur={() => setOpen(false)}
        placeholder="找卡：單號（例 917005-1）或製令號"
        title="輸入 SO／SOB 單號（可省略 SO、可只打後幾碼，例 917005-1）或製令號；Enter＝跳到下一張、Shift+Enter＝上一張"
        className="min-w-0 flex-1 rounded border border-amber-700/60 bg-slate-900 px-2.5 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none disabled:opacity-50"
      />
      {(hits.length > 0 || loading) && text.trim() && (
        <span className="flex shrink-0 items-center gap-0.5">
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => go('prev')} disabled={disabled || navCount === 0}
            title="上一張（Shift+Enter）" aria-label="上一張"
            className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40">▲</button>
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => go('next')} disabled={disabled || navCount === 0}
            title="下一張（Enter）" aria-label="下一張"
            className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40">▼</button>
          <span className="min-w-[2.5rem] text-center text-[11px] tabular-nums text-slate-400">
            {/* 重搜中（存檔後、結果過期、按 Enter 等結果）也顯示「搜尋中…」：清單收著時這是唯一的回饋 */}
            {loading ? '搜尋中…' : nav.pos > 0 ? `${nav.pos}/${navCount}` : `${navCount} 張`}
          </span>
        </span>
      )}
      {text && (
        <button type="button" onMouseDown={e => e.preventDefault()} onClick={clearAll} aria-label="清除搜尋" title="清除（Esc）"
          className="shrink-0 rounded px-1 text-sm leading-none text-slate-400 hover:bg-slate-800 hover:text-white">✕</button>
      )}
      {pendingNote && <span className="shrink-0 animate-pulse text-[11px] text-amber-300">{pendingNote}</span>}
      <span className="sr-only" aria-live="polite">{announce}</span>

      {showList && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="搜尋結果"
          // z-[45]：高於排程區的載入遮罩（z-40），低於對話框（Modal z-50／60）。不可帶 data-board-dialog（會停掉 Ctrl+Z）
          className="eip-scrollbar absolute left-0 top-full z-[45] mt-1 max-h-[60vh] w-full overflow-y-auto rounded-lg border border-slate-600 bg-slate-950 text-xs shadow-2xl"
          onMouseDown={e => e.preventDefault()}
        >
          {!parsed ? (
            <p className="px-3 py-2 text-slate-400">{SEARCH_QUERY_HINT}</p>
          ) : (
            <>
              <div className="sticky top-0 z-10 flex flex-wrap items-baseline gap-x-2 border-b border-slate-800 bg-slate-950/95 px-3 py-1.5 text-[11px] text-slate-400">
                <span className="font-semibold text-slate-200">
                  {typing ? '輸入中…' : `符合 ${hits.length + result.truncated} 張（可跳 ${navCount}）`}
                </span>
                <span>{scopeNote}</span>
                {loading && !typing && <span className="animate-pulse text-amber-300">搜尋全部日期中…</span>}
                {remoteError && <span className="text-orange-300">全部日期搜尋失敗（{remoteError}），只列出畫面上的卡</span>}
              </div>
              {!typing && !loading && hits.length === 0 && (
                <p className="px-3 py-3 text-slate-400">找不到符合的卡（已排、待排區、待排池都沒有）</p>
              )}
              <ul className={typing ? 'opacity-50' : ''}>
                {hits.map((h, i) => (
                  <HitRow
                    key={h.key}
                    hit={h}
                    id={`${listId}-o${i}`}
                    index={i}
                    active={h.key === activeKey}
                    jumped={h.key === jumpedKey}
                    hideCompleted={hideCompleted}
                    onPick={() => {
                      if (h.navigable) { doJump(hits, h.key); if (propsRef.current.isDesktop) inputRef.current?.focus({ preventScroll: true }) }
                      else setActiveKey(h.key)
                    }}
                    onOpenClosures={h.kind === 'closed' && onOpenClosures ? () => { setOpen(false); onOpenClosures() } : undefined}
                  />
                ))}
              </ul>
              {result.truncated > 0 && (
                <p className="border-t border-slate-800 px-3 py-1.5 text-[11px] text-slate-400">另有 {result.truncated} 筆，請輸入更完整的單號</p>
              )}
              <p className="border-t border-slate-800 px-3 py-1 text-[10px] text-slate-500">Enter 跳到下一張・Shift+Enter 上一張・↑↓ 選擇・點一列直接跳・Esc 關閉</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function HitRow({ hit, id, index, active, jumped, hideCompleted, onPick, onOpenClosures }: {
  hit: SearchHit
  id: string
  index: number
  active: boolean
  jumped: boolean
  hideCompleted: boolean
  onPick: () => void
  onOpenClosures?: () => void
}) {
  const notes = hitNotes(hit)
  const place = hitPlaceText(hit, hideCompleted, fmtQty)
  const tone = hit.kind === 'pool' ? 'text-emerald-300' : hit.kind === 'holding' ? 'text-sky-300' : hit.navigable ? 'text-amber-200' : 'text-slate-400'
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={!hit.navigable || undefined}
      data-hit-index={index}
      onClick={onPick}
      title={hit.navigable ? '點一下跳到這張卡' : place}
      className={`cursor-pointer border-b border-slate-900 px-3 py-1.5 last:border-b-0 ${
        active ? 'bg-slate-800' : 'hover:bg-slate-900'
      } ${hit.navigable ? '' : 'opacity-60'} ${jumped ? 'border-l-2 border-l-amber-400' : ''}`}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-mono font-semibold text-slate-100">{hit.label}</span>
        <span className="min-w-0 flex-1 truncate text-slate-300">{hit.itemName ?? ''}{hit.customer ? <span className="text-slate-500">・{hit.customer}</span> : null}</span>
        {hit.qty != null && <span className="shrink-0 tabular-nums text-slate-200">{fmtQty(hit.qty)}{hit.unit ? <span className="ml-0.5 text-[10px] text-slate-500">{hit.unit}</span> : null}</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        <span className={`text-[11px] ${tone}`}>{place}</span>
        {notes.map(n => (
          <span key={n} className={`rounded px-1 text-[10px] ${n.startsWith('延誤') ? 'bg-orange-900/60 text-orange-200' : n.startsWith('✓') ? 'bg-slate-800 text-slate-300' : 'bg-slate-800/70 text-slate-400'}`}>{n}</span>
        ))}
        {onOpenClosures && (
          <button type="button" onClick={e => { e.stopPropagation(); onOpenClosures() }}
            className="rounded border border-rose-800/70 px-1 text-[10px] text-rose-200 hover:bg-rose-900/40">開結案池</button>
        )}
      </div>
    </li>
  )
}
