# 報價計算機前台設計規範：紙墨報價單（合成定版 v1.0）

日期：2026-09-13
來源：前台視覺方向評審（4 提案 × 3 評審 + 合成）的定版輸出（`design_spec.json`），由腳本整理成文件，內容未人工改寫。
實作路徑修正：規範原文寫 `/quote`、`app/quote/`，實際落點為 `app/info-board/quote/`；印刷方式 MVP 為 仿柯7151 / 仿柯金谷田 / 柯式 / 無印刷。

---

## 1. 一段話（給老闆）

這個設計把報價計算機做成「一張排得很好的台灣報價單」：整頁是暖紙白底、墨色字、鉛筆灰格線，左邊是業務填寫的工作卡（一、品項／二、尺寸與數量／三、印刷／四、配件與包裝，公文式中文數字章節），右邊是一張永遠釘在視線裡的報價單，報價大數字釘在報價單「頁首」而不是底部，五段明細才是可捲的那一段，所以 1366×768 的業務筆電上永遠一眼看到價錢。色彩只有三個語意色：松綠（郵局綠、茶籽堂綠）負責焦點與完成、朱砂（公司章紅）負責錯誤與「已覆寫」章印、茶金負責警告；其餘全是墨與紙，零陰影、零漸層、圓角不超過 4px。它之所以是台灣風格，不靠符號堆疊，而是借用台灣人每天摸到的印刷品文法：誠品 DM 的明體標題與極簡配色、傳統估價單與會計帳簿的雙線合計、公文的「一、二、三」章節、「※」備註句、蓋章式「已覆寫」標記、台北黑體骨架（Noto Sans TC）的內文、街口／LINE Pay 式的金額排版，以及台灣用字（列印／預設／資料，TWD 取整數元）。比參考截圖高十倍的地方不在皮膚，而在它把「每天報十幾張」的流程做進去了：最近報價一鍵帶入、複製上一張改數量、500／1,000／3,000 數量階梯一次算完、Ctrl+Enter 產生報價、可貼 LINE 的文字摘要、可貼 Excel 的表格、可直接列印的 A4 報價單、螢幕轉給客戶看時一鍵「客戶檢視」藏掉成本、每張報價綁費率版本與匯率日期可追溯——而參考截圖只是一個會算數的深色面板。

## 2. 設計原則

- 紙就是介面：層級靠紙白→紙灰→白卡三階明度與鉛筆線／墨線兩階線條撐起，全頁零陰影、零漸層、零玻璃。
- 色彩只編碼狀態，不拿來裝飾：松綠＝焦點與完成、朱砂＝錯誤與人工覆寫、茶金＝警告；朱砂面積永遠小於畫面 5%。
- 報價數字永遠在視線裡：大數字釘在結果面板頂部，明細才可捲；無法計算時顯示「—」，永遠不顯示 0。
- 錯誤留在原地、訊息以「※」開頭、不用 toast 報錯；缺項在狀態列是可點連結，點了 scroll＋focus。
- 每張報價可追溯：報價編號、費率版本、匯率與日期、業務、產生時間五者同時寫進摘要、列印單與資料庫。
- 為「每天十幾張」而設計：最近報價帶入、數量階梯、Ctrl+Enter、鍵盤走完整張表、客戶檢視一鍵藏成本。
- 只動講好的範圍：token 掛在 .q-page wrapper、字型在 /quote 的 layout 載入、不碰 @theme、不改 body、不動其他頁。

## 3. Design tokens（貼在 `app/globals.css` 最末端，只新增）

```css
/* ============================================================
   報價計算機（/quote）專用設計 token
   貼在 globals.css 最末端。只新增、不改動任何既有規則。
   刻意「不」放進 @theme：token 只掛在 .q-page 這個 wrapper 上，
   其他頁完全看不到。Tailwind v4 直接用變數語法取用：
   bg-(--q-paper)  text-(--q-ink-2)  border-(--q-line)
   ring-(--q-accent)/25  font-(family-name:--q-font-mono)
   ============================================================ */
.q-page {
  /* ---- 紙：三階明度，取代陰影做層級 ---- */
  --q-paper:   #F6F3EC;  /* 頁面底（模造紙） */
  --q-paper-2: #EDE8DE;  /* 結果面板底、明細子列底、skeleton、橫幅底 */
  --q-card:    #FFFDF9;  /* 工作卡底、輸入框底、摘要底（貼上去的白卡） */

  /* ---- 墨 ---- */
  --q-ink:     #1C1A17;  /* 主文字、主鈕底、墨線、選中段填色（非純黑） */
  --q-ink-2:   #5A5650;  /* 次要文字、欄位標籤（對 paper 6.6:1） */
  --q-ink-3:   #6F695F;  /* 輔助字、單位、註腳、算式（對 paper 4.8:1，已由 #7C766C 壓深到過 AA；只用 ≥11px） */
  --q-line:    #D8D2C6;  /* 鉛筆線：格線、分隔線、輸入框邊框 */
  --q-disabled:#C9C3B8;  /* 停用文字、停用鈕底、未開放分頁 */

  /* ---- 語意色：每色一義 ---- */
  --q-accent:      #2F5D50;  /* 松綠：焦點環、勾選、完成點、連結、TWD 切換、進度線 */
  --q-accent-soft: #DDE8E1;  /* 松綠淡底：選取底、數值更新閃底 */
  --q-seal:        #A93B2A;  /* 朱砂：錯誤、必填未填、無法拼板、已覆寫章印、API 錯誤 */
  --q-seal-soft:   #F3E4E0;  /* 朱砂淡底：錯誤列底、覆寫列底 */
  --q-warn:        #8A5E12;  /* 茶金：未發布、匯率過期、接近板材極限（對 paper-2 4.7:1） */
  --q-warn-soft:   #F1E8D3;  /* 茶金淡底 */

  /* ---- 字型：值由 next/font 的 variable class 注入（見 implementation_notes） ---- */
  --q-font-serif: var(--font-noto-serif-tc), "PingFang TC", "Microsoft JhengHei", serif;
  --q-font-sans:  var(--font-noto-sans-tc), "q-sans-fallback", "PingFang TC", "Microsoft JhengHei", sans-serif;
  --q-font-mono:  var(--font-ibm-plex-mono), "Noto Sans TC", "Microsoft JhengHei", ui-monospace, monospace;

  /* ---- 線寬、圓角 ---- */
  --q-hair:   1px;   /* 鉛筆線 */
  --q-rule:   2px;   /* 墨線（分頁指示、表頭） */
  --q-rule-2: 3px;   /* 面板頂線、double 合計線、橫幅左帶 */
  --q-radius: 3px;   /* 輸入框、按鈕、章印 */
  --q-radius-lg: 4px;/* 卡片、面板（上限，不再更大） */

  /* ---- 間距：4px 基底 ---- */
  --q-s1: 4px;  --q-s2: 8px;  --q-s3: 12px; --q-s4: 16px;
  --q-s5: 20px; --q-s6: 24px; --q-s8: 32px; --q-s12: 48px;

  /* ---- 版面 ---- */
  --q-max: 1280px;
  --q-gutter: 32px;
  --q-panel-top: 24px;   /* sticky top */
  --q-control-h: 40px;   /* 輸入／select 高度 */
  --q-control-h-touch: 44px;

  /* ---- 動態 ---- */
  --q-dur-fast: 120ms;   /* 顏色、邊框 */
  --q-dur: 180ms;        /* 展開／收合 */
  --q-dur-flash: 220ms;  /* 數值更新閃底 */
  --q-ease: cubic-bezier(0.2, 0, 0, 1);

  /* ---- wrapper 自身樣式：蓋掉全站深色 body，不動 body ---- */
  color-scheme: light;
  min-height: 100dvh;
  background: var(--q-paper);
  color: var(--q-ink);
  font-family: var(--q-font-sans);
  font-size: 14px;
  line-height: 1.6;
  letter-spacing: 0.01em;
  -webkit-font-smoothing: antialiased;
}

/* 內文後備字型度量：Noto Sans TC 尚未到位時，讓微軟正黑／PingFang 的行高與字寬接近 Noto，
   避免 swap 那一刻整排標籤重排。三個 override 值是起始值，上線前用兩行文字重疊法目測校正。 */
@font-face {
  font-family: "q-sans-fallback";
  src: local("Microsoft JhengHei"), local("微軟正黑體"), local("PingFang TC");
  size-adjust: 100%;
  ascent-override: 88%;
  descent-override: 12%;
  line-gap-override: 0%;
}

/* 數字容器：所有數字一律走等寬＋tabular */
.q-page .q-num {
  font-family: var(--q-font-mono);
  font-variant-numeric: tabular-nums;
}

/* 數值更新閃底：只套在「金額真的變了」的那格 */
@keyframes q-flash {
  from { background-color: var(--q-accent-soft); }
  to   { background-color: transparent; }
}
.q-page .q-flash { animation: q-flash var(--q-dur-flash) var(--q-ease) 1; }

/* 蓋章：已覆寫章印首次出現 */
@keyframes q-stamp {
  from { transform: rotate(-2deg) scale(1.06); }
  to   { transform: rotate(-2deg) scale(1); }
}
.q-page .q-stamp { animation: q-stamp 150ms var(--q-ease) 1; transform: rotate(-2deg); }

/* 重算進度線：只在 API 超過 200ms 才掛上 .q-progress */
@keyframes q-progress {
  from { transform: translateX(-100%); }
  to   { transform: translateX(100%); }
}
.q-page .q-progress { position: relative; overflow: hidden; }
.q-page .q-progress::after {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 2px;
  background: var(--q-accent); animation: q-progress 1.2s linear infinite;
}

/* 展開／收合：grid-rows 技巧，不量 height */
.q-page .q-collapse { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--q-dur) var(--q-ease); }
.q-page .q-collapse[data-open="true"] { grid-template-rows: 1fr; }
.q-page .q-collapse > * { overflow: hidden; min-height: 0; }

/* 淺色捲軸（本頁不用全站 .eip-scrollbar 深色捲軸） */
.q-page .q-scroll { scrollbar-width: thin; scrollbar-color: var(--q-line) transparent; }
.q-page .q-scroll::-webkit-scrollbar { width: 8px; }
.q-page .q-scroll::-webkit-scrollbar-thumb { background: var(--q-line); border-radius: 4px; }

/* 全站把 date input 圖示反白（深色主題用），本頁還原 */
.q-page input[type="date"]::-webkit-calendar-picker-indicator { filter: none; }

/* 減少動態：全部直接跳到終態 */
@media (prefers-reduced-motion: reduce) {
  .q-page *, .q-page *::before, .q-page *::after {
    animation: none !important; transition: none !important;
  }
}

/* 列印：螢幕版藏起來、A4 報價單顯示；全站 @media print 會把底色打平成黑白，
   本頁本來就是紙與墨，列印結果與螢幕一致，不需要 .print-keep-color */
@media print {
  .q-page .q-screen { display: none !important; }
  .q-page .q-print  { display: block !important; }
  .q-page { min-height: auto; }
  @page { size: A4; margin: 18mm 16mm; }
}
```

## 4. 字型與排版

【字型三套，各司其職】
1) 標題（display）：Noto Serif TC — next/font/google `Noto_Serif_TC({ weight:['600'], subsets:['latin'], display:'swap', preload:false, variable:'--font-noto-serif-tc' })`。只用於：頁面標題 28px、面板標題「報價單」20px、區段標題「一、品項」16px、尺寸中間的「×」16px、列印報價單標題。規則：襯線絕不出現在 <16px（Windows ClearType 小字襯線會糊）。
2) 內文（body）：Noto Sans TC — `Noto_Sans_TC({ weight:['400','500','700'], subsets:['latin'], display:'optional', preload:false, variable:'--font-noto-sans-tc' })`。內文、標籤、按鈕、select option、摘要文字。全域 letter-spacing 0.01em、line-height 1.6（台北黑體與 jf open 粉圓都以 Noto Sans CJK 為骨架，字距微開即得台北黑體的舒展）。選 display:'optional' 而非 'swap'：內部工具天天用，第一次載入落系統字、之後全走快取，永遠不會出現中文標籤整排重排；若 Snow 想第一次就看到 Noto，改成 'swap' 並靠 q-sans-fallback 的 override 度量壓住跳動。Windows ClearType 補償：欄位標籤與按鈕一律 500 字重，內文主色 --q-ink #1C1A17。
3) 數字（numeric）：IBM Plex Mono — `IBM_Plex_Mono({ weight:['400','500','600'], subsets:['latin'], display:'swap', variable:'--font-ibm-plex-mono' })`。所有數字一律走它：輸入值、單價、明細金額、報價大數字、日期、報價編號、算式、匯率；容器加 `.q-num`（tabular-nums）。不用 Inter／Geist／DM Sans。

【混排規則】
- 純數字容器直接套 .q-num；「數字＋中文」混排（如「每盤 24 pcs · 42 盤」）容器仍套 .q-num：Plex Mono 沒有漢字，漢字自動落到堆疊裡的 Noto Sans TC，一行不必切 span。
- 數字與單位之間留半形空格：「5 × 5 cm」「1,000 pcs」「2.8 mm」；中文標點一律全形；乘號用「×」（U+00D7）不用 x。
- 幣別規則：報價大數字前用「RMB」全稱；其餘位置人民幣一律「¥」；台幣一律「NT$」；不混用、不寫「RMB ¥」。TWD 一律整數元（Math.round 到 1 元，不顯示小數）。
- 台灣用字白名單寫進文案 lint：列印／預設／資料／品項／設定／確認；禁用 打印／默認／數據／設置。

【字級與行高階梯】（font-size/line-height，全部 px，4 基底）
- 10/14：章印、分頁「尚未開放」小標（tracking 0.08em）
- 11/16：英文小標（tracking 0.14em）、算式（mono）、註腳
- 12/16：欄位標籤（500）、單位、狀態列、錯誤訊息（mono 用於日期、編號）
- 13/20：表格內文、明細列、摘要文字、分段控制
- 14/22：內文基底、select、配件名稱
- 15/22：分頁文字（500）、主鈕（500）、數字輸入值（mono）
- 16/24：區段標題（serif 600）、TWD 換算（mono）
- 20/28：面板標題（serif 600）
- 24/28：報價小數部分（mono 500）
- 28/36：頁面標題（serif 600）
- 40/44：報價整數部分（mono 600，tracking -0.02em）
字重只用 400／500／600／700；不用 300 與 800。

## 5. 版面

【wrapper】`<div class="q-page" lang="zh-Hant-TW">`（根 layout 是 `<html lang="en">`，本頁自帶 lang，Han unification 才會選繁中字形、全形標點斷行才正確）。wrapper 自己鋪滿 `min-h-dvh`（body 是深色 #050b14，短頁底部才不會露出深藍）。頁面最上方放跳轉連結 `<a href="#q-panel" class="sr-only focus:not-sr-only">跳到報價單</a>`。

【容器】`mx-auto max-w-(--q-max) px-(--q-gutter) py-8`。

【垂直結構】
① 頁首 `flex items-end justify-between pb-5`：左「報價計算機」serif 28/36 600，下方 11px tracking 0.14em ink-3「QUOTATION CALCULATOR」；右側一列 `flex items-center gap-4`：費率版本徽章（mono 12px、border line、px-2 py-0.5）「成本參數 2026-09」→ 匯率徽章「1 RMB = 4.55 NT$ · 09/13」→「客戶檢視」開關 → 「最近報價」文字鈕（開 popover）→ 業務姓名＋今日日期（mono 12px ink-2）。
② 品類分頁列，全寬，`border-b border-(--q-line)`。
③ 主體 `mt-8 grid grid-cols-12 gap-6`：
  - 左 `col-span-7`：一張白卡 `rounded-(--q-radius-lg) border border-(--q-line) bg-(--q-card)`，內含四個區段以 `border-t border-(--q-line)` 相隔（不做卡中卡），每區 `px-6 py-6`。區段標題左「一、品項」serif 16 600，右英文小標或即時小計。
  - 右 `col-span-5`：結果面板 `id="q-panel" sticky top-(--q-panel-top) self-start max-h-[calc(100dvh-3rem)] rounded-(--q-radius-lg) border border-(--q-line) border-t-(--q-rule-2) border-t-(--q-ink) bg-(--q-paper-2)`，內部 `flex flex-col`，三個固定分區：
    A. 面板頁首（不捲）`px-6 pt-5 pb-4 border-b border-(--q-ink)`：標題列、摘要句、狀態列、**報價大數字**、每盤／盤數列。
    B. 可捲中段 `q-scroll flex-1 overflow-y-auto px-6 py-4`：款別表（多款時）、數量階梯、五段明細、rounding 註腳。
    C. 面板頁尾（不捲）`px-6 pt-4 pb-5 border-t border-(--q-line) bg-(--q-paper-2)`：主鈕「產生報價」＋停用原因＋報價摘要（產生後展開，摘要本身可捲）。
  這樣五段全展開時，40px 報價數字與主鈕都不會被捲出視野。

【區段內欄位】`mt-4 grid grid-cols-2 gap-x-6 gap-y-5`。
- 一、品項：品項 select（col-span-2）→ 客戶／案名（col-span-2，標「選填」）→ 選中後的預設提示行。
- 二、尺寸與數量：板材厚度 select 放區段最上方 col-span-2（多款尺寸共用板材，所以板材在款列之上）；其下是「款列」容器，每款一列 `grid grid-cols-[28px_1.4fr_1fr_28px] gap-4 items-start`（款序號｜W×H｜數量｜移除鈕）；「＋新增下一款尺寸」虛線鈕 col-span-2；數量快捷 chip 列在每款數量欄下方。
- 三、印刷：單面／雙面（col-span-1）、方式（col-span-1）、版數（柯式時展開，col-span-1）。
- 四、配件與包裝：兩個清單各 col-span-2，標題右側即時小計。

【間距系統】4 基底：標籤到輸入 6px、欄位間 20px、區段內距 24px、欄間 24px、頁緣 32px；面板內距 24px。層級靠 paper→paper-2→card 三階明度與 line／ink 兩階線條；陰影一律不用。

【Tab 順序】DOM 順序＝視覺順序：頁首控制 → 分頁 → 工作卡由上而下（品項 → 客戶 → 板材 → 款 1 W → H → 數量 → 快捷 chip → 款 2 … → 印刷 → 版數 → 配件 → 包裝）→ 面板（覆寫鈕 → 款別表列 → 全部展開 → 五段展開鈕 → TWD 開關 → 主鈕 → 摘要複製鈕）。數字輸入欄按 Enter 跳下一個輸入欄（W→H→數量→下一款 W），最後一欄 Enter 不送出；Ctrl+Enter 在任何位置都觸發「產生報價」。

## 6. 元件規格（樣式 ＋ 狀態）

### 6.1 頁首控制列（費率版本、匯率、客戶檢視、最近報價）

**規格**

`flex items-center gap-4` 靠右。費率版本徽章：`q-num rounded-(--q-radius) border border-(--q-line) px-2 py-0.5 text-[12px] text-(--q-ink-2)`「成本參數 2026-09」，來自 API rateVersion，hover 原生 title「本頁所有金額依此版費率計算」。匯率徽章同樣式：「1 RMB = 4.55 NT$ · 09/13」。客戶檢視：`<button role='switch' aria-checked>` 文字「客戶檢視」＋ 32×18 開關（軌 line／開啟 accent，圓鈕 card），開啟時整頁隱藏成本（見結果面板「客戶檢視」）；快捷鍵 Ctrl+Shift+H；不存 localStorage，每次載入預設關閉（安全預設）。最近報價：文字鈕「最近報價」`text-[13px] text-(--q-ink-2) underline underline-offset-2 decoration-(--q-line) hover:text-(--q-ink)`，開 popover（見「最近報價」元件）。業務姓名＋日期 mono 12px ink-2。

**狀態**

匯率正常：ink-2。匯率 >7 天：徽章文字 warn、前綴「※ 匯率已 12 天未更新」。匯率 >30 天或未設定：徽章顯示「匯率未設定」warn，TWD 功能整頁停用（切換鈕 disabled 並標原因）。客戶檢視開啟：徽章列右側出現朱砂小章印「客戶檢視中」（同「已覆寫」章印樣式），頁首費率徽章隱藏（費率版本屬內部資訊）。載入中：徽章顯示「—」。

### 6.2 品類分頁

**規格**

`<div role='tablist' class='flex items-end gap-8 border-b border-(--q-line)'>`，每頁 `<button role='tab'>`：`relative pb-3 text-[15px] font-medium tracking-[0.02em] text-(--q-ink-2) transition-colors duration-(--q-dur-fast) hover:text-(--q-ink)`。選中：`text-(--q-ink) after:absolute after:inset-x-0 after:-bottom-px after:h-(--q-rule) after:bg-(--q-ink)`（2px 墨線壓在底線上，不用膠囊底色）。灰態（貼紙、水晶標）：`text-(--q-disabled) cursor-not-allowed` + `aria-disabled='true'`，右側 `<span class='ml-1.5 align-middle rounded-[2px] border border-(--q-line) px-1 py-px text-[10px] tracking-[0.08em] text-(--q-ink-3)'>尚未開放</span>`，title「貼紙報價尚未開放」。鍵盤：roving tabindex，← → 跳過灰態，Enter/Space 選取。未來開放時各品類只換 `--q-accent` 一個變數（貼紙＝#3E5F8A 靛青、水晶標＝#8A5E12 茶金），墨與紙不變。

**狀態**

selected／hover／focus-visible（`ring-2 ring-(--q-accent)/25 rounded-[2px]`）／disabled（灰態，不響應 hover 與 click）。切換品類：若表單已有輸入，先跳原生 confirm「切換品類會清空目前輸入，是否繼續？」；確認後清空所有欄位並保留客戶／案名與客戶檢視狀態。

### 6.3 區段標題

**規格**

`<header class='flex items-baseline justify-between'>`：左 `<h2 class='font-(family-name:--q-font-serif) text-[16px] leading-6 font-semibold text-(--q-ink)'>二、尺寸與數量</h2>`（中文數字＋頓號，公文文法），右 `<span class='text-[11px] tracking-[0.14em] text-(--q-ink-3)'>SIZE & QTY</span>`，或在該區有內容時換成即時摘要（13px ink-2）：一、「鑰匙圈 KC-001」；二、「2 款 · 300×400×2.8 · 共 1,500 pcs」；三、「雙面 直噴7151」；四、「已選 3 項 · ¥0.62／pcs」。區段之間 `border-t border-(--q-line)`，不用背景色塊。

**狀態**

預設（英文小標）／已填（右側換摘要句）／該區有錯誤（摘要句前加朱砂圓點 `size-1.5 rounded-full bg-(--q-seal)`，摘要句改「※ 尚缺 數量」）／鎖定（品項未發布時二～四區 `opacity-60 pointer-events-none` 並 `aria-disabled`）。

### 6.4 品項選擇＋客戶／案名

**規格**

品項：原生 `<select>` 樣式化（品項 <40 個時可及性與速度優先）：`h-(--q-control-h) w-full appearance-none rounded-(--q-radius) border border-(--q-line) bg-(--q-card) px-3 pr-9 text-[14px] text-(--q-ink) transition-colors duration-(--q-dur-fast) focus:border-(--q-ink) focus:outline-none focus:ring-2 focus:ring-(--q-accent)/25`，右側 chevron 用 inline SVG data-URI `bg-[position:right_0.75rem_center] bg-no-repeat`。option「鑰匙圈　KC-001」（品名＋全形空格＋品號），只列 status='published'；URL 或最近報價帶入的未發布品項以「（未發布）」後綴保留一次。選中後下方 `mt-1.5 text-[12px] text-(--q-ink-2)`「預設板材 300×400×2.8 · 建議印刷 直噴7151 · 每盤數量依尺寸、板材與拼板間距自動計算」並自動帶入預設板材與印刷方式。客戶／案名：`<input type='text'>` 同輸入框樣式（左對齊、sans 14px），標籤「客戶／案名」旁 `text-(--q-ink-3)`「選填」，maxLength 40；值寫進報價摘要、列印單、最近報價清單。品項 >40 個時再升級為自訂 listbox（含搜尋）。

**狀態**

placeholder「選擇品項」ink-3／hover（border ink-2）／focus（ink 邊框＋松綠 ring）／error（blur 後未選：border seal ＋ `※ 請選擇品項`）／disabled（載入中：bg paper-2、text disabled）／未發布（選項灰字後綴「（未發布）」，選中即進未發布狀態）。

### 6.5 數字輸入（含單位、IME 正規化）

**規格**

外框 `flex items-stretch h-(--q-control-h) rounded-(--q-radius) border border-(--q-line) bg-(--q-card) transition-colors duration-(--q-dur-fast) focus-within:border-(--q-ink) focus-within:ring-2 focus-within:ring-(--q-accent)/25`。`<input type='text' inputMode='decimal' autoComplete='off'>`：`q-num min-w-0 flex-1 bg-transparent px-3 text-right text-[15px] text-(--q-ink) placeholder:text-(--q-ink-3) outline-none`（不用 type=number：滾輪誤改、e 字元）。單位槽 `flex select-none items-center border-l border-(--q-line) px-2.5 text-[12px] text-(--q-ink-3)`（cm／pcs／版／個）。正規化在 `compositionend` 與 `blur` 執行（composition 進行中不動值，Windows 注音 IME 才不會吃字）：全形數字／小數點／逗號→半形；「×」「x」「X」「*」在 W 欄貼上「5x5」「5×5 cm」時拆成 W=5、H=5；剝掉「cm」「mm」「pcs」「,」空白；尺寸保留 1 位小數；數量取整並千分位顯示（state 存數字）；解析失敗保留上一個有效值並顯示錯誤。標籤 `mb-1.5 block text-[12px] font-medium tracking-[0.04em] text-(--q-ink-2)`，不用紅星號。

**狀態**

empty／filled／hover（border ink-2）／focus／error（外框 `border-(--q-seal) ring-2 ring-(--q-seal)/20`，下方 `<p class='mt-1.5 text-[12px] leading-4 text-(--q-seal)'>※ 請輸入 0.1 以上的數值</p>`，`aria-invalid` ＋ `aria-describedby`）／warning（接近板材極限：外框不變，下方 warn 12px「※ 尺寸接近板材極限，扣邊後僅剩 0.5 cm」）／disabled（bg paper-2、text disabled、單位槽同色）／composing（IME 中：不驗證、不格式化）。

### 6.6 尺寸款列＋新增下一款尺寸

**規格**

資料模型：`sizes: [{ id, w, h, qty, perSheetOverride?: { value, autoAtOverride, key:'w|h|sheetId', by, at } }]`；板材、印刷、配件、包裝為整張報價共用。每款一列 `grid grid-cols-[28px_1.4fr_1fr_28px] gap-4 items-start`：款序號 `q-num text-[11px] text-(--q-ink-3) pt-3`「款 1」；W×H `grid grid-cols-[1fr_auto_1fr] items-center`，中間 `<span class='px-2 font-(family-name:--q-font-serif) text-[16px] text-(--q-ink-2)'>×</span>`，placeholder「W」「H」；數量欄（單位 pcs）；移除鈕 16px 線條「×」`size-7 rounded-(--q-radius) text-(--q-ink-3) hover:text-(--q-ink) hover:bg-(--q-paper-2)`（第一款不可移除，改渲染空白）。數量欄下方快捷 chip `mt-1.5 flex gap-1.5`：100／500／1,000／3,000，`h-6 rounded-(--q-radius) border border-(--q-line) px-2 q-num text-[11px] text-(--q-ink-2) hover:border-(--q-ink) hover:text-(--q-ink)`，點一下填入。「＋新增下一款尺寸」：`mt-3 flex h-9 w-full items-center justify-center gap-1.5 rounded-(--q-radius) border border-dashed border-(--q-line) text-[13px] text-(--q-ink-2) hover:border-(--q-ink) hover:text-(--q-ink)`，上限 5 款。多款時結果面板出現「款別表」，大數字顯示「焦點款」（預設款 1，點款別表列切換）。

**狀態**

單款（無序號欄位、無移除鈕，版面留 28px 空欄以免加第二款時重排）／多款（序號＋移除）／某款錯誤（該款整列左側序號變 seal，錯誤訊息掛在對應欄位下）／某款無法拼板（該款 W×H 下方 seal 訊息，款別表該列金額「—」）／達上限（新增鈕 disabled，文字「最多 5 款」）。移除款時該款覆寫一併移除，不需 confirm（可從最近報價復原）。

### 6.7 板材厚度下拉

**規格**

與品項同一套 select 樣式，但整個 select 套 `q-num`。`<optgroup label='2.8 mm'>` 依厚度分組；option 文字固定格式「300 × 400 × 2.8　¥18.50／片」（規格＋全形空格＋單片成本，業務選厚度時就看得到差價）。輸入任一款 W×H 後，若目前板材放不下，該 option 後綴「（尺寸不足）」不隱藏；同時自動預選「所有款都放得下的最小板材」並在欄位下方 12px ink-2「已依 5 × 5 cm 自動選用最小可容納板材，可手動更換」。板材列下方常駐一行 12px ink-3「可用範圍扣邊後 29 × 39 cm（拼板間距 0.3 cm）」。

**狀態**

預設（品項帶入）／自動預選（提示行）／手動選了尺寸不足板材（進無法拼板狀態：border seal、下方「※ 款 2 的 21 × 30 cm 超過此板材，無法拼板」＋文字鈕「改用 400 × 600 × 2.8 →」一鍵切換）／載入中（disabled、顯示「—」）／未發布鎖定。切換板材時每款覆寫依生命週期規則退役（見覆寫元件）。

### 6.8 印刷方式分段控制＋版數

**規格**

兩組 `role='radiogroup'` 內含 `role='radio'`。外框 `inline-flex rounded-(--q-radius) border border-(--q-ink) bg-(--q-card) p-0.5`；段 `rounded-[2px] px-3.5 py-1.5 text-[13px] font-medium text-(--q-ink-2) transition-colors duration-(--q-dur-fast) hover:text-(--q-ink)`；選中 `bg-(--q-ink) text-(--q-paper)`（在表單上把選項塗黑）。第一組 單面／雙面；第二組 直噴7151／金谷田／柯式。選「柯式」時版數欄以 `.q-collapse` 展開：數字輸入（單位「版」，預設 1，min 1，整數，inputMode numeric），標籤旁 12px ink-3「每版計一次製版費」。切離柯式：欄收合，值保留在 state 但不送入計算。雙面時明細印刷段自動出現「× 2 面」算式行。鍵盤 ← → 在段間移動、Space 選取。

**狀態**

unselected／hover／selected／focus-visible（外框 ring）／disabled（整組 border disabled、文字 disabled）／版數 error（同數字輸入 error）。

### 6.9 配件多選／包裝多選（可勾選清單列）

**規格**

容器 `divide-y divide-(--q-line) border-y border-(--q-line)`。每列 `<label class='grid grid-cols-[20px_1fr_auto_104px] items-center gap-3 py-2 cursor-pointer'>`。勾選框 `<button role='checkbox' aria-checked>`：`size-4 rounded-[2px] border border-(--q-ink) bg-(--q-card) transition-colors duration-(--q-dur-fast)`，勾選 `bg-(--q-ink)` 內含 12px 紙色勾 SVG；focus `ring-2 ring-(--q-accent)/25`。名稱 `text-[14px] text-(--q-ink)`（全名，「龍蝦扣」不縮寫）；第三欄單價 `q-num text-[12px] text-(--q-ink-3)`「¥0.35／個」（若單價隨數量階梯變，顯示「¥0.35／個 · 1,000 起 ¥0.30」）；第四欄數量輸入（單位「個」，語意「每件用量」，預設 1，min 1，整數），減到 0 或清空＝取消勾選（杜絕「選了但數量 0」）。包裝清單同元件；每件固定的項目（OPP 袋、紙卡）第四欄顯示固定文字「每件 1」；紙箱顯示「每箱 50 件」可點改（來自品項預設），列下方 12px ink-3「約 20 箱（1,000 ÷ 50，無條件進位）」讓箱數可驗證。區段標題右側「已選 3 項 · ¥0.62／pcs」即時更新；配件清單標題旁 12px ink-3「數量為每件用量」。

**狀態**

unchecked（數量欄 `opacity-40 pointer-events-none`）／checked／hover（列底 paper-2）／focus／disabled（配件停用或缺貨：整列 text disabled、名稱後綴「（停用）」或「（缺貨）」、不可勾選；已勾選的停用項保留並標 warn「※ 此配件已停用，請確認」）／數量 error。

### 6.10 每盤數量覆寫（含生命週期）

**規格**

面板頁首倒數第二列 `flex items-baseline justify-between py-2.5 border-b border-(--q-line)`：左「每盤數量」13px ink-2，右 值 `q-num text-[15px]` ＋ 副註 `q-num text-[11px] text-(--q-ink-3)`「（5 × 12，橫向）」＋ 文字鈕「覆寫」`ml-2 text-[12px] text-(--q-ink-2) underline underline-offset-2 decoration-(--q-line) hover:text-(--q-ink)`（手機 ≥40px 觸控高度）。按覆寫 → 值變 72px 行內輸入 `w-[72px] border-0 border-b border-(--q-ink) bg-transparent text-right q-num text-[15px] outline-none`（只有底線，像在印好的表單上手寫），autofocus 全選、Enter 確認、Esc 取消、blur 視同確認、min 1 整數。生命週期（折衷規則）：覆寫綁定 key = `${w}|${h}|${sheetId}`；key 變（改該款尺寸或換板材）→ 覆寫「退役」：計算改用自動值、該列閃一次 `.q-flash`、2 秒顯示「已依新板材重算」，之後常駐一行 11px ink-3「上次手動 40 · <button class='underline'>套回</button>」，直到套回、新覆寫或改數量以外的第三次變更才消失；改數量不影響覆寫。多款時每款各自覆寫，面板頁首顯示焦點款的覆寫。盤數列緊接其下：`Math.ceil(qty ÷ perSheetUsed)`，副註「（1,000 ÷ 24）」；qty < perSheet 時副註 warn「不足一盤，仍以 1 盤計價」。API payload：`perSheetOverride: { value, autoValue, key, overriddenBy, overriddenAt }`；摘要與列印單標「每盤數量 40（手動覆寫，自動值 48）」。

**狀態**

auto（預設）／editing（底線輸入）／overridden（整列 `bg-(--q-seal-soft)`，值右側章印 `<span class='q-stamp inline-block rounded-[2px] border-[1.5px] border-(--q-seal) px-1.5 py-px text-[11px] font-medium tracking-[0.1em] text-(--q-seal)'>已覆寫</span>`，下方 11px「自動計算 24 · 還原」）／overridden-high（覆寫值 > 自動值：多一行 warn 12px「※ 高於自動計算，請確認排版可行」；> 自動值 1.5 倍升級為 seal 且主鈕停用原因「每盤數量超過拼板上限」）／retired（閃底＋2 秒說明＋「上次手動 40 · 套回」）／invalid（無法拼板時值顯示 `0` seal，覆寫鈕隱藏）／客戶檢視（整列隱藏）。

### 6.11 款別表（多款尺寸時）與數量階梯

**規格**

款別表：可捲中段第一區，`<table class='w-full text-[13px]'>` 表頭單墨線：款｜尺寸｜數量｜每盤／盤數｜單價 RMB。每列可點（`role='row' aria-selected`），選中列 `bg-(--q-accent-soft)` 並成為焦點款：大數字、覆寫列、五段明細都切到該款；列尾若該款覆寫，附小章印「覆寫」。合計列（雙線）：「合計 1,500 pcs · 本單 ¥5,620.00」。數量階梯：五段明細之上一個可展開區「數量階梯（500／1,000／3,000）」，預設收合；展開時對焦點款一次 API 批算三個數量（同一請求 `qtyLadder:[500,1000,3000]`），表格三列：數量｜每盤／盤數｜成本單價｜報價單價｜本單合計；目前數量列加 `font-medium`；點某列文字鈕「套用」把該數量填回款的數量欄。階梯數量可在設定改，預設 [500,1000,3000]。

**狀態**

單款（款別表整區不渲染，但容器保留在 DOM 順序，加款不重排）／多款／某款無法拼板（該列單價「—」seal）／階梯載入中（三列金額「—」＋進度線）／階梯 API 失敗（區塊內 seal 一行「※ 階梯試算失敗 · 重試」，不影響主結果）／客戶檢視（款別表只留 款｜尺寸｜數量｜單價；階梯只留 數量｜單價｜合計）。

### 6.12 五段明細表（含降級）

**規格**

`<table class='w-full text-[13px]'>`，`<thead>` 一列 `border-b border-(--q-ink)`：「項目」左、「金額 ¥／pcs」右 `q-num`；表頭右上角文字鈕「全部展開」／「全部收合」11px ink-2 underline。五段主列 `<tr class='border-b border-(--q-line)'>`：第一格 `<button aria-expanded aria-controls class='flex items-center gap-1.5 py-2 text-left'>` 含 12px 線條 caret（`transition-transform duration-(--q-dur)` 展開 `rotate-90`）＋段名（材料／印刷貼合清洗／切割／包裝人工／包材配件）；右格 `py-2 text-right q-num`，段金額變動時該格套 `.q-flash`；金額為 0 顯示「—」（分得出「沒算到」與「沒有」）。子列（`.q-collapse`）`bg-(--q-paper-2)/60 text-[12px] text-(--q-ink-2)`，三欄 `grid grid-cols-[1fr_auto_88px] gap-3 py-1.5 pl-7`：名稱｜算式 `q-num text-[11px] text-(--q-ink-3)`（用真實數字：「300×400 板 ¥18.50 ÷ 24 pcs × 1.05 損耗」「(¥120 × 2 版) ÷ 1,000」「¥0.80 × 2 面」）｜金額（3 位小數）。合計列 `<tfoot>`：`border-t border-(--q-ink) border-b-[3px] border-double border-(--q-ink) font-medium`「成本單價」＋金額（會計帳簿雙線）。表下方 11px ink-3 註腳「明細取 3 位小數，合計取 2 位；盤數無條件進位」。預設展開狀態：首次載入只展開金額最大的一段；之後以 localStorage `q.breakdown.open`（try/catch）記住業務習慣。降級：API 該段 `lines` 為空或缺 → 主列不渲染 caret 與 aria-expanded、段名後綴 11px ink-3「（無明細）」、「全部展開」只作用於有明細的段；整個 response 都無 lines 時，表頭右上角改顯示「此版費率未提供明細」。

**狀態**

collapsed／expanded／loading（每格「—」，子列以 `h-3 w-24 rounded-[2px] bg-(--q-paper-2) animate-pulse` 佔位）／changed（.q-flash 220ms 只在變動格）／zero（「—」）／no-lines（降級）／stale（API 錯誤保留上次值：整表 `opacity-70`，表頭旁「上次計算 14:32」）／客戶檢視（整表隱藏，改顯示一行 13px「成本明細已隱藏」）。

### 6.13 主按鈕「產生報價」＋報價摘要

**規格**

面板頁尾：`flex h-11 w-full items-center justify-between rounded-(--q-radius) bg-(--q-ink) px-4 text-[15px] font-medium tracking-[0.04em] text-(--q-paper) transition-[background-color,transform] duration-(--q-dur-fast) hover:bg-black active:translate-y-px focus-visible:ring-2 focus-visible:ring-(--q-accent)/40`，右側 `q-num text-[11px] opacity-60`「Ctrl + Enter」（真的綁：document keydown，IME composing 中不觸發）。永遠可點：有缺項 → 捲到第一個錯誤欄位並 focus、狀態列列出缺項；無法拼板 → 按鈕文字變「無法拼板，請調整尺寸或板材」`bg-(--q-disabled) text-(--q-paper)` 且 `aria-disabled`（狀態寫在鈕上不讓人猜）。成功後：POST /api/quotes 持久化取得編號 Q-20260913-03，摘要在頁尾展開 `mt-4 rounded-(--q-radius) border border-(--q-line) bg-(--q-card) p-4 max-h-[40dvh] overflow-y-auto q-scroll`：標頭左 `q-num text-[12px] text-(--q-ink-2)` 報價編號＋產生時間，右三顆次要鈕 `h-8 rounded-(--q-radius) border border-(--q-ink) px-3 text-[13px] transition-colors hover:bg-(--q-ink) hover:text-(--q-paper)`：「複製」（LINE 文字）、「複製表格」（Tab 分隔，貼 Excel 直接分欄：品項｜尺寸｜厚度｜數量｜印刷｜配件｜包裝｜每盤｜盤數｜成本單價｜報價 RMB｜報價 NT$）、「列印報價單」（window.print → A4 版）。內容 `<pre class='mt-3 whitespace-pre-wrap text-[13px] leading-[22px]'>`：【啟盛國際 報價】2026-09-13／報價編號：Q-20260913-03／客戶：○○設計 中秋案／品項：壓克力鑰匙圈／款 1：5 × 5 cm（2.8 mm）1,000 pcs 單價 RMB 3.85（≈ NT$ 18）／款 2：…／印刷：雙面 直噴7151／配件：D字扣 ×1、珠鍊 ×1／包裝：OPP 袋、紙卡／本單合計：RMB 5,620.00（≈ NT$ 25,571）／有效期：至 2026-09-27（14 天）／業務：王小明／費率 2026-09 · 匯率 4.55（09/13）。客戶檢視下摘要不含成本行。

**狀態**

default／hover／active／focus-visible／loading（文字「計算中…」＋ 16px 線條 spinner，aria-busy）／blocked-missing（可點，點了捲到錯誤，鈕下 12px ink-3「尚缺：數量、板材」）／blocked-nest（文字變原因、disabled 樣式）／generated（摘要展開；再次點擊＝重新產生新編號）／copied（鈕文字 2 秒變「已複製 ✓」勾用 SVG，不另起 toast）／copy-failed（鈕文字「複製失敗，請手動選取」seal 2 秒）／print（見列印版）。

### 6.14 最近報價 popover 與「複製上一張」

**規格**

頁首「最近報價」開 popover `absolute right-0 mt-2 w-[520px] rounded-(--q-radius-lg) border border-(--q-line) bg-(--q-card) p-2`（本頁唯一浮層，仍不加陰影，靠 border 與 card 明度浮起）。列表 GET /api/quotes?mine=1&limit=10：每列 `grid grid-cols-[112px_1fr_auto_auto] gap-3 py-2 border-b border-(--q-line) text-[13px]`：編號＋日期（q-num 12px）｜客戶 · 品項 · 尺寸 · 數量（省略）｜單價 RMB（q-num）｜文字鈕「帶入」。「帶入」把整張 payload 填回表單（含覆寫、標明費率版本若與現版不同則 warn 橫幅「※ 此報價用 2026-08 費率，已依現版重算」），不自動產生新報價。popover 第一列固定快捷「複製上一張改數量」：帶入最近一張並 focus 到款 1 數量欄。鍵盤：Esc 關閉、↑↓ 移動、Enter＝帶入；焦點鎖在 popover 內，關閉後回到觸發鈕。

**狀態**

empty（「尚無報價，產生第一張後會出現在這裡」）／loading（三列 skeleton）／error（seal 一行＋重試）／列 hover（paper-2 底）／列 focus／帶入中（該列鈕文字「帶入中…」）／品項已下架（該列品項灰字後綴「（未發布）」，帶入後進未發布狀態）。

### 6.15 客戶檢視模式

**規格**

開關在頁首。開啟時：結果面板隱藏「每盤數量／盤數列的覆寫鈕與副註」「五段明細」「成本單價」「毛利」「費率版本徽章」；面板頁首只留標題、摘要句、報價大數字、本單合計、TWD、有效期；款別表與階梯只留數量與單價；報價摘要不含成本行；工作卡配件單價欄隱藏。面板頂線由墨色改為松綠 3px（給業務自己看的「現在是客戶模式」暗號），頁首出現朱砂章印「客戶檢視中」。所有隱藏用 `hidden` 屬性（不是 opacity），確保 DOM 讀不到成本。快捷鍵 Ctrl+Shift+H；重新整理後回到關閉。

**狀態**

off（預設）／on／on＋列印（列印單本來就不含成本，兩者一致）。

### 6.16 狀態提示

**規格**

原則：錯誤留在原地、不用 toast；面板頁首固定一行狀態列 `flex items-center gap-1.5 text-[12px] text-(--q-ink-2)` `role='status' aria-live='polite'`，前綴 `size-1.5 rounded-full` 圓點 ＋ 固定符號（● 完成、○ 計算中、▲ 錯誤，色弱可分）。(a) 載入中：輸入區可操作但 select 停用，面板數字全「—」，五段以佔位條脈動（1.2s 透明度，不做 shimmer），面板頂線下 2px 松綠進度線（`.q-progress`，只在 API 超過 200ms 才掛上）。(b) 必填未填：首次載入不標紅；欄位 blur 或按主鈕後才標；狀態列「▲ 尚缺：數量、板材」每個缺項是 `<button class='underline'>`，點了 scroll＋focus。(c) 尺寸超過板材：該款 W×H 下方 seal「※ 21 × 30 cm 超過 300×400 板可用範圍（扣邊後 29 × 39 cm，旋轉後仍放不下），無法拼板」＋板材欄旁「改用 400 × 600 →」文字鈕；每盤數量 `0` seal、報價「—」、主鈕文字變原因。(d) 品項未發布：工作區頂端橫幅 `border-l-(--q-rule-2) border-(--q-warn) bg-(--q-warn-soft) px-4 py-3 text-[13px] text-(--q-ink)`「※ 此品項尚未發布，無法報價。請聯絡產品開發。」＋文字鈕「清除品項」；二～四區鎖定。(e) API 錯誤：同橫幅但 `border-l-(--q-seal) bg-(--q-seal-soft)`，訊息「※ 費率服務暫時無法連線」＋「重試」文字鈕＋錯誤碼 `q-num text-[11px] text-(--q-ink-3)`；面板保留上一次成功結果並在狀態列標「上次計算 14:32」，不清空。(f) 計算中（>200ms）：狀態列「○ 計算中」＋進度線，數字不清空。所有訊息「※」開頭、句尾不加驚嘆號、不用 emoji。

**狀態**

idle（狀態列「● 已依 14:32:05 參數計算」）／loading／computing／missing／nest-error／unpublished／api-error（含 stale 保留）／rate-stale（茶金）／override-retired（覆寫列 2 秒訊息）。

### 6.17 A4 列印報價單（q-print）

**規格**

`<section class='q-print hidden'>` 螢幕隱藏、列印顯示；其餘頁面內容包在 `.q-screen`。版面依台灣 B2B 報價單慣例，黑白（全站 @media print 打平底色，與本頁氣質一致）：頁首左「啟盛國際有限公司 Bardshop」serif 18px＋地址／電話（來自設定），右「報價單 QUOTATION」serif 20px；資訊列兩欄表：報價編號、日期、有效期至、業務、客戶／案名、聯絡方式；主表 `border-t-2 border-b-2 border-black` 表頭「品名｜規格｜數量｜單價（RMB）｜金額（RMB）」，每款一列，合計列雙線；備註區「※ 印刷：雙面 直噴7151 ※ 配件：… ※ 包裝：… ※ TWD 換算僅供參考，匯率 4.55（2026-09-13）」；右下 60×60mm 空白框「公司章」與「業務簽名」；頁尾 9pt「費率 2026-09 · 本報價由 EIP 報價計算機產生」。不含任何成本、每盤、明細。列印字型：Noto Serif TC 標題、Noto Sans TC 內文、Plex Mono 數字（print 只用已載入的，缺字落系統字）。

**狀態**

單款／多款（多列）／客戶未填（客戶列留空白底線供手寫）／TWD 未開（省略 TWD 行）／匯率過期（TWD 行仍印但備註「匯率已 12 天未更新」）。

### 6.18 底部條（<1024px，v1 簡化版）

**規格**

v1 不做抽屜／sheet。<1024px 時結果面板不 sticky，直接排在工作卡下方；改在視窗底部固定一條 `fixed inset-x-0 bottom-0 h-14 border-t border-(--q-ink) bg-(--q-paper-2) px-4 flex items-center justify-between`：左「RMB 3.85」`q-num text-[20px] font-semibold`＋11px ink-3「每盤 24 · 42 盤」，右文字鈕「查看報價單 ↓」`<a href='#q-panel'>` 平滑捲到面板。工作卡底部 `pb-20`。輸入高度改 `--q-control-h-touch`、內文 15px、覆寫鈕與快捷 chip 觸控高度 ≥40px。v2 再做底部抽屜，且必須重用同一個面板元件。

**狀態**

idle／缺項（左側文字改「尚缺：數量」seal）／無法拼板（左「—」seal＋「無法拼板」）／計算中（進度線）。

## 7. 結果面板完整規格

【結構】面板 `flex flex-col`，三分區，只有中段可捲；A 頁首與 C 頁尾永遠可見。

【A. 面板頁首（不捲）】
1) 標題列 `flex items-baseline justify-between`：左「報價單」serif 20/28 600 ＋ `ml-2 text-[11px] tracking-[0.14em] text-(--q-ink-3)`「QUOTATION」；右 `q-num text-[12px] text-(--q-ink-2)` 今日日期。
2) 摘要句 `mt-1.5 text-[13px] text-(--q-ink-2)`：「鑰匙圈 · 5 × 5 cm · 300×400×2.8 · 雙面 直噴7151 · 1,000 pcs」（多款：「鑰匙圈 · 2 款 · 300×400×2.8 · 雙面 直噴7151 · 共 1,500 pcs」；未填段落顯示「—」；客戶／案名有填時前綴「○○設計 ·」）。
3) 狀態列（見狀態提示）。
4) 報價大數字區 `mt-4 border-t border-(--q-ink) pt-4`：
   - 第一行 `flex items-baseline justify-between`：左「報價」12px tracking 0.08em ink-2（多款時「款 1 報價」）；右 `<button role='switch' aria-checked>` 純文字「顯示 TWD」12px accent underline-offset-2 hover:underline，開啟後「隱藏 TWD」；設定存 localStorage `q.showTwd`（try/catch）。
   - 第二行 `mt-1 flex items-baseline gap-1.5` `aria-live='polite' aria-atomic`（debounce 後才更新，避免連讀）：`<span class='text-[14px] text-(--q-ink-2)'>RMB</span>` ＋ 整數 `q-num text-[40px] leading-[44px] font-semibold tracking-[-0.02em] text-(--q-ink)`「3」＋ 小數 `q-num text-[24px] leading-[28px] font-medium text-(--q-ink-2)`「.85」（items-baseline，收據金額感）；千分位 toLocaleString('zh-TW')，固定兩位小數。容器 `-mx-2 px-2 rounded-(--q-radius)`，金額變動時套 `.q-flash`；不做 count-up。
   - 第三行 `mt-2 q-num text-[13px] text-(--q-ink-2)`：「本單合計 ¥ 3,850.00 · 1,000 pcs · 毛利 25.7%」（毛利與成本在客戶檢視隱藏）。
   - 第四行（TWD 開）`mt-1 q-num text-[16px] text-(--q-ink-2)`「≈ NT$ 18」（整數元，Math.round）＋ `text-[11px] text-(--q-ink-3)`「匯率 4.55 · 2026-09-13」；>7 天 warn「※ 匯率已 12 天未更新」；>30 天或未設定：TWD 行改「匯率未設定，無法換算」warn，switch disabled。
   - 無法計算時整數顯示「—」`text-(--q-ink-3)`、小數不顯示、第三行改為原因「填妥尺寸與數量後顯示」或「無法拼板」；永遠不顯示 0。
5) 每盤數量列與盤數列（見覆寫元件），`border-b border-(--q-line)`。

【B. 可捲中段】（`q-scroll`，1366×768 時約 260–320px 高）
6) 款別表（多款時）。
7) 數量階梯（可展開，預設收合）。
8) 五段明細表（單墨線表頭、鉛筆線列、雙線合計「成本單價」）＋ rounding 註腳。
9) 成本單價下方一行 `q-num text-[12px] text-(--q-ink-2)`「加價率 32%（依品項預設，成本 ¥2.91 → 報價 ¥3.85）」——讓業務知道報價怎麼來的；客戶檢視隱藏。

【C. 面板頁尾（不捲）】
10) 主鈕「產生報價」＋停用原因行。
11) 報價摘要（產生後展開，自身 max-h-[40dvh] 可捲），三顆次要鈕：複製／複製表格／列印報價單。

【客戶檢視】隱藏 5 的覆寫鈕與副註、8、9、第三行的毛利；面板頂線改松綠；摘要與列印不含成本。

【RMB／TWD 規則】RMB 是計價主幣，永遠顯示；TWD 只做換算顯示、整數元、附匯率與日期；匯率由後台 fx 表維護（asOf 日期），前端絕不自算或讓業務手改匯率（要改請走後台，避免每張報價匯率不同）。

【即時重算邊界】本地立即算：盤數 ceil、本單合計、階梯的乘法、TWD 換算、狀態判定（缺項、尺寸不足）；API 算：每盤數量（拼板）、五段金額與 lines、成本單價、報價單價、毛利。API 150ms debounce；>200ms 才顯示進度線；回應前保留上次數字。

【API 合約】POST /api/quote/calc — request `{ category:'acrylic', itemId, customer?, sheetId, sizes:[{id,w,h,qty,perSheetOverride?:{value,autoValue,key,overriddenBy,overriddenAt}}], print:{sides:'single'|'double',method:'inkjet7151'|'jingutian'|'offset',plates?}, parts:[{id,qtyPerPiece}], packs:[{id,perBox?}], qtyLadder?:[500,1000,3000] }`；response `{ rateVersion:'2026-09', fx:{rate:4.55,asOf:'2026-09-13'}|null, validityDays:14, sizes:[{ id, perSheetAuto, perSheetUsed, nest:{cols,rows,rotated}, sheets, segments:[{key:'material'|'print'|'cut'|'packLabor'|'packMaterial', name, amount, lines?:[{name,formula,amount}] }], costUnit, markupPct, quoteUnit, marginPct, total }], ladder?:[{qty,perSheet,sheets,costUnit,quoteUnit,total}], warnings:[{code,sizeId?,message}], errors:[{code,field?,message}] }`。`lines` 可選，缺時前端降級（見五段明細）。POST /api/quotes 持久化：`{ quoteNo, userId, customer, payload, result, rateVersion, fx, createdAt }`；GET /api/quotes?mine=1&limit=10。

## 8. 動態

全部動態只做五件事，每件都對應「使用者需要知道的資訊」，時值只用 120／180／220ms，緩動 cubic-bezier(0.2,0,0,1)：
(1) 輸入焦點：邊框色 120ms；ring 直接出現不動畫（精確感）。
(2) 結果更新：只有金額真正變動的格子套 `.q-flash`（松綠淡底 → 透明 220ms），告訴業務「這一格改動牽動了哪幾行」；數字本身不做 count-up、不跳動、不 scale。
(3) 展開／收合：明細子列、版數欄、數量階梯、摘要區用 `.q-collapse`（grid-template-rows 0fr→1fr 180ms），caret 同步 rotate 90；不用 max-height hack。
(4) 章印與提示：「已覆寫」章印首次出現 `.q-stamp`（scale 1.06→1 150ms，蓋章手感，只做一次）；覆寫退役時該列 `.q-flash` 一次＋文字 2 秒；「已複製 ✓」在按鈕文字內切換，不另起 toast。
(5) 進度線：API 超過 200ms 才掛 `.q-progress`（2px 松綠由左往右掃 1.2s），低於 200ms 什麼都不顯示，避免每敲一鍵就閃；skeleton 只用 animate-pulse 透明度脈動，不做 shimmer。
其他：主鈕 hover 只變色、active translate-y 1px；sticky 面板不做陰影或縮放；分頁指示線不滑動（直接切換）。全部 transition 走 `motion-safe:` 前綴或包在 .q-page 的 reduced-motion 規則下，`prefers-reduced-motion` 時一律關閉直接跳終態。禁止：hover 浮起、loading shimmer、頁面進場動畫、數字滾動、按鈕漣漪、任何 loop 裝飾動畫。

## 9. 響應式

階段化交付：v1 只做「桌機雙欄＋窄螢幕純堆疊＋簡易底部條」，不做抽屜／sheet／焦點鎖（無 component library 下最貴的元件，且手機不是主戰場）。

≥1280px：12 欄 7／5，面板 sticky top 24px，頁緣 32px，面板內距 24px。
1024–1279px：維持 7／5，頁緣 24px、gap 20px、面板內距 20px；款列改兩行（W×H 一行，數量＋快捷 chip 一行）；報價整數 32px。
768–1023px（平板）：單欄，工作卡全寬，面板排在工作卡下方（不 sticky，仍是同一個元件）；固定底部條（見元件）顯示 RMB 大數字＋「查看報價單 ↓」錨點；工作卡 `pb-20`；輸入高度 44px、內文 15px；分頁列維持一列。
<768px（手機）：同上；分頁列 `overflow-x-auto` 隱藏捲軸；W×H 仍並排、板材與數量各自一行；配件列改 `grid-cols-[20px_1fr_88px]`（單價移到名稱下方 11px）；分段控制允許換行、每段 flex-1；覆寫鈕、快捷 chip、展開鈕觸控高度 ≥40px；報價整數 32px；摘要區的三顆鈕改兩行；最近報價 popover 改全寬 `fixed inset-x-4`。橫向模式不特別處理（依寬度落入對應斷點）。
列印：任何寬度都輸出 A4 q-print 版。
v2（另立需求）：768 以下底部抽屜（重用面板元件、容器切換）、手機單手模式（主鈕與大數字固定頁尾）。

## 10. 可及性

【對比】ink #1C1A17／ink-2 #5A5650（6.6:1）／ink-3 #6F695F（4.8:1，已由原案 #7C766C 壓深）對 paper 全部 ≥AA；ink-3 只用 ≥11px；seal 對 card 5.9:1、warn 對 paper-2 4.7:1、accent 對 paper 6.8:1、paper 字在 ink 主鈕上 14:1、paper 字在 accent 上 7.5:1。所有狀態「顏色＋固定符號（●○▲※）＋文字」三者並存，上線前用 deuteranopia 模擬器確認朱砂／松綠可分（兩者明度差本身就大）。

【焦點】所有可互動元素 `focus-visible:ring-2 ring-(--q-accent)/25`（輸入框另加 border ink）；主鈕 ring /40；分頁與勾選框 ring 加 `rounded-[2px]`；不移除 outline 而不補 ring。焦點永不被 sticky 面板遮住：面板在 DOM 順序之後，捲動時用 `scrollIntoView({block:'center'})`。

【鍵盤】Tab 順序＝DOM 順序（見 layout）；Enter 在數字欄跳下一欄；Ctrl+Enter 產生報價（composing 中不觸發）；Ctrl+Shift+H 客戶檢視；分頁與分段控制 ← → roving tabindex，Space/Enter 選取；勾選框 Space；覆寫輸入 Enter 確認／Esc 取消；popover Esc 關閉、↑↓ 移動、焦點鎖在內、關閉回觸發鈕；跳轉連結「跳到報價單」為頁面第一個可聚焦元素。

【ARIA】分頁 `role=tablist/tab aria-selected aria-disabled`；分段 `role=radiogroup/radio aria-checked`；勾選 `role=checkbox aria-checked`；展開鈕 `aria-expanded aria-controls`；TWD 與客戶檢視 `role=switch aria-checked`；狀態列 `role=status aria-live=polite`；報價大數字容器 `aria-live=polite aria-atomic`（只在 debounce 後更新一次）；API 錯誤與無法拼板橫幅 `role=alert`；載入中主鈕 `aria-busy`。

【表單錯誤宣告】錯誤欄位 `aria-invalid='true'` ＋ `aria-describedby` 指向下方 `※` 訊息 `<p id>`；狀態列的缺項清單同時是可點連結；首次載入不宣告錯誤（blur 或送出後才標）；訊息文字本身說明修法（「請輸入 0.1 以上的數值」而非「格式錯誤」）。

【語言與字形】wrapper `lang="zh-Hant-TW"`，螢幕閱讀器與字形選擇都走繁中；數字用 tabular 對齊，等寬字讓低視力使用者逐位比對。

【觸控】<1024px 所有互動目標 ≥40px；覆寫鈕、快捷 chip、caret 都加 padding 撐高。

## 11. 明確禁止（PR review 對照清單）

- 不做深色結果面板、不做藍金頂欄——參考截圖只借「左填右看」，風格完全不沿用
- 不用任何漸層、玻璃擬態、backdrop-blur、彩色陰影；本案連 hairline 陰影都不用，浮層也靠 border 與明度浮起
- 不用紫色、不用紅金；朱砂只出現在錯誤與覆寫章印，面積永遠小於 5%；松綠不拿來塗大面積底
- 不用 emoji 當圖示；圖示只用 16px 線條 SVG 手刻（chevron、caret、×、勾、spinner），不引入 icon library
- 不做 count-up 數字動畫、不做 skeleton shimmer、不做頁面進場動畫、不做 hover 浮起、不做分頁滑動指示
- 圓角不超過 4px；不用膠囊按鈕與膠囊 chip；不做卡中卡
- 不用純黑 #000 與純白 #FFF 大面積（只有主鈕 hover 短暫 black）
- 不用 toast 報錯；錯誤留在原地，狀態列只做摘要；訊息一律「※」開頭、不加驚嘆號
- 不用紅星號標必填；反向在少數選填欄位標「選填」
- 不用 type=number；一律 type=text inputMode=decimal，並在 compositionend 後正規化全形
- 無法計算永遠顯示「—」，不顯示 0；TWD 不顯示小數；¥ 不用在報價大數字前（那裡用 RMB 全稱）
- 不把 token 加進 @theme、不改 body、不動 globals.css 既有規則；token 只掛 .q-page，用 bg-(--q-paper) 變數語法
- 不引入 component library、headless UI、form library；select 用原生樣式化，品項 >40 個才升級 listbox
- 不用 Inter／Geist／DM Sans／Fraunces／粉圓（Huninn）；襯線不用在 <16px
- 不用簡體用語（打印／默認／數據／設置）；數字與單位間留半形空格、中文標點全形
- 不讓業務手改匯率、不讓前端自算匯率；不把成本明細帶進列印單與客戶檢視
- v1 不做底部抽屜／sheet／焦點鎖；不為手機複製第二套結果面板元件

## 12. 給工程師的落地提醒

- 檔案落點（只動這些）：app/quote/layout.tsx（載字型、包 .q-page wrapper 並掛三個 font variable class）、app/quote/page.tsx 與 app/quote/_components/*、app/api/quote/calc/route.ts、app/api/quotes/route.ts；globals.css 只在最末端追加 tokens_css 那一段。不碰 @theme、不碰 body、不碰既有 .eip-scrollbar 與 print 規則。
- Tailwind v4 變數語法：`bg-(--q-paper)`、`text-(--q-ink-2)`、`border-(--q-line)`、`ring-(--q-accent)/25`、`h-(--q-control-h)`、`font-(family-name:--q-font-serif)`；這些不需要在 @theme 註冊，Tailwind 會直接輸出 var()。字型建議用 .q-num／wrapper 的 font-family 而不是每處寫 font-(family-name:…)。
- next/font：Noto_Sans_TC 與 Noto_Serif_TC 一定 `preload:false`（CJK 會切上百個 unicode-range 片，preload 會爆首屏）；Noto_Sans_TC 用 `display:'optional'`（首次系統字、之後快取零重排），Serif 與 Plex Mono 用 'swap'。next/font 的 adjustFontFallback 對 CJK 不可靠，所以 tokens_css 自帶 q-sans-fallback @font-face，ascent/descent override 是起始值，上線前用同一段文字兩層重疊目測校正。
- wrapper 一定要 `lang="zh-Hant-TW"`（根 layout 是 lang=en）＋ `color-scheme: light`＋ `min-height:100dvh`，否則 Han unification 會挑到日文字形、原生 select 下拉面板會用深色、短頁底部露出深藍 body。
- Windows 注音 IME：所有數字欄監聽 compositionstart/compositionend，composing 期間不驗證不格式化；compositionend 與 blur 才跑正規化（全形→半形、剝單位、拆 5×5）；Ctrl+Enter 的 keydown handler 要檢查 `e.isComposing` 與 `e.keyCode===229`。
- CJK 排版坑：`word-break: keep-all` 不要套在中文內文（中文需要逐字換行）；中文標點用全形時 `text-align: justify` 會拉開，內文一律左對齊；「×」用 U+00D7 不用全形「×」以免寬度不一；千分位用 toLocaleString('zh-TW')。
- 字型堆疊技巧：.q-num 的 font-family 是 Plex Mono → Noto Sans TC → 正黑；Plex Mono 沒漢字，所以「每盤 24 pcs · 42 盤」整行套 .q-num，數字走 mono、漢字自動落 Noto，不必切 span。
- 覆寫生命週期用 key 綁定：`override.key === `${w}|${h}|${sheetId}`` 才生效；key 不符即視為退役（保留在 state 顯示「上次手動 40 · 套回」），API payload 只在生效時送 perSheetOverride，並帶 autoValue／overriddenBy／overriddenAt 供稽核。
- API 150ms debounce；請求帶遞增 requestId，回應時丟棄過期的；>200ms 才掛 .q-progress；錯誤時不清空上次 result，只標 stale。lines 可選，前端必須在 lines 缺失時降級（不渲染 caret）。
- 報價摘要複製用 navigator.clipboard.writeText，失敗（http 或權限）時 fallback 選取 <pre> 文字並提示手動複製；「複製表格」用 \t 與 \n 組字串，Excel 貼上直接分欄。
- 列印：q-print 區塊放在 .q-page 內、螢幕 hidden；全站 print 規則會把所有底色打成白、字打成黑，本頁本來就是紙墨，不需要 .print-keep-color；@page A4 已在 tokens_css；列印前確保 Noto Serif 已載入（document.fonts.ready 後再 window.print）。
- localStorage 只存兩樣（q.showTwd、q.breakdown.open），全部 try/catch；客戶檢視刻意不存（安全預設關閉）。
- 最近報價需要 quotes 表（Supabase）：quote_no（依日期序號 Q-YYYYMMDD-NN，由後端產生）、user_id、customer、payload jsonb、result jsonb、rate_version、fx jsonb、created_at；RLS 只讓本人讀自己的，管理員可讀全部（配合 2026-08 資安審查的 RLS 落地波次）。
- 分頁與分段控制的 roving tabindex：只有選中項 tabIndex=0，其餘 -1；← → 用 keydown 改焦點並 preventDefault，避免頁面捲動。
- 1366×768 實機驗證清單：面板頁首（含大數字、每盤／盤數）高度控制在 ≤300px，中段至少 260px 可捲；五段全展開時主鈕仍可見；13 吋筆電字型不糊（Noto Sans TC 500 標籤、ink 主色）。
- PR review 對照本規範逐項檢查：圓角 ≤4px、零陰影、字型三套、ink-3 只用 ≥11px、幣別規則、「※」訊息、do_not 清單；工程師隨手換 Inter、加 shadow、圓角 8px 就會讓「台灣風格」整個垮掉。
