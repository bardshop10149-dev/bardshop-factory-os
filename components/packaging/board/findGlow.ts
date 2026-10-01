// D113 排程區單號搜尋：跳到卡片後「邊框發光」的 CSS（純函式，node 可測；正式工作台與 AI 模擬區共用）
//
// 為什麼用「頁面根元素輸出一個 <style>＋屬性選擇器」而不是在卡片上切 className：
//   卡片（LaneCard／PlacementCard／SimplePoolCard）都是 memo 元件、className 由它們自己管；要切 class 就得把 highlightId
//   一路傳過 DayLanesView → LaneColumn → LaneCard、MultiDayView → LaneCol → PlacementCard、ParkingArea、SimplePool → Section…，
//   而且每次發光都會讓整排卡重畫。改用屬性選擇器（沿用模擬區 SIM_CSS 的慣例）：卡片不必知道自己在發光，
//   輪詢重畫、甚至卡片被重新掛載，發光都還在；不動任何 prop。
//
// 只動 box-shadow：預排卡的虛線框顏色有意義（藍＝預排、橘＝要提醒），不能蓋掉 border。
// 黃色（rgb 250 204 21，與 globals.css 的 pendingBorderBlink 同色系），和拖曳用的 sky 藍區分。

/** 發光多久後拿掉 <style>（動畫本身 4.2 秒，留一點餘裕讓淡出跑完） */
export const GLOW_MS = 4500
const RGB = '250 204 21'

export interface GlowTarget {
  attr: 'data-placement-id' | 'data-pool-card-id'
  id: string
  /** 第幾次發光：奇偶交替用兩組相同的 keyframes，同一張卡再跳一次時動畫才會重播（同名動畫不會重新開始） */
  n: number
}

/**
 * CSS 屬性值（雙引號字串）跳脫：\ → \\、" → \"、換行類 → \a 等十六進位跳脫。
 * 瀏覽器有 CSS.escape，但它是給「識別字」用的，而且 node 測試環境沒有；cardId 可能含 #（`${soLineKey}#${block}`）。
 */
export function cssAttr(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ')
    .replace(/\f/g, '\\c ')
}

/**
 * 永遠輸出的基本樣式：捲到卡片時上方留 88px（日檢視的 sticky 線頭 76px＋間距）、下方 16px。
 * 放在固定樣式而不是發光樣式裡：scrollIntoView 在發光的 <style> 掛上去「之前」就執行，那時 scroll-margin 還不存在。
 * （鍵盤 Tab 到卡片時瀏覽器自動捲動也會套用，剛好避開 sticky 線頭，沒有副作用）
 */
export const FIND_BASE_CSS = '[data-placement-id],[data-pool-card-id]{scroll-margin-top:88px;scroll-margin-bottom:16px}'

const solid = `rgb(${RGB})`
// box-shadow 動畫要能內插：每一格都是「外框、外暈、內框」三層、inset 位置相同
const STRONG = `0 0 0 3px ${solid},0 0 22px 6px rgb(${RGB} / 0.65),inset 0 0 0 1px ${solid}`
const WEAK = `0 0 0 2px rgb(${RGB} / 0.7),0 0 10px 2px rgb(${RGB} / 0.3),inset 0 0 0 1px rgb(${RGB} / 0.7)`
const NONE = `0 0 0 0 rgb(${RGB} / 0),0 0 0 0 rgb(${RGB} / 0),inset 0 0 0 0 rgb(${RGB} / 0)`

function keyframes(name: string): string {
  return `@keyframes ${name}{0%{box-shadow:${NONE}}8%,38%,68%{box-shadow:${STRONG}}23%,53%{box-shadow:${WEAK}}85%{box-shadow:${WEAK}}100%{box-shadow:${NONE}}}`
}

/**
 * 目標卡的發光樣式：閃三下（約 4.2 秒）後淡出。
 * - z-index 6：日檢視的 LaneCard 是 absolute，要蓋過鄰卡（右鍵選單開著是 z-[5]），又低於 sticky 線頭（z-10）與時間尺（z-20）。
 *   PlacementCard 是 relative，z-index 同樣有效。
 * - 內框（inset）那一圈：週檢視清單只有 p-1，外暈會被捲動容器裁掉，內框保證一定看得到。
 * - 待排池卡（SimplePoolCard）沒有定位，補 position:relative 才能疊在鄰卡上（它的子元素沒有 absolute，不受影響）；
 *   排定卡不補（LaneCard 本身就是 absolute，蓋成 relative 會跑版）。
 * - 使用者設定「減少動態效果」：不閃，改成靜態黃框，時間到跟著 <style> 一起消失。
 */
export function findGlowCss(g: GlowTarget): string {
  const sel = `[${g.attr}="${cssAttr(g.id)}"]`
  const name = `pkg-find-glow-${g.n % 2 ? 'a' : 'b'}`
  const pos = g.attr === 'data-pool-card-id' ? 'position:relative;' : ''
  return [
    keyframes(name),
    `${sel}{animation:${name} 4.2s ease-out both;${pos}z-index:6}`,
    `@media (prefers-reduced-motion: reduce){${sel}{animation:none;box-shadow:0 0 0 3px ${solid},inset 0 0 0 1px ${solid}}}`,
  ].join('\n')
}
