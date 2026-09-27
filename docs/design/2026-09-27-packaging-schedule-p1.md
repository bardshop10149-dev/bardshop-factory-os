# 包裝專區 P1：拖曳排程工作台（技術規格）

規格書 · 2026-09-27 · 分支 `feat/packaging-schedule`（P0 = `4ceb37f`）· 依據 `包裝排程計畫/需求決策紀錄.md` D1~D54

> 這份是 **P1 實作規格**（D42：拖曳工作台、日期欄、拆卡、每日產能、自動儲存、Undo、快照）。
> 需求以決策紀錄為唯一權威；P0 規格 `docs/design/2026-09-27-packaging-schedule.md`（§十一、§十二為驗證後修正）描述待排池本身，本文件只描述「在待排池之上」加的東西。
> 型別契約：`lib/packaging/scheduleTypes.ts`（實作者照它 import，不另定義同名型別）。
> Migration：`sql/20260927_packaging_schedule.sql`（**只寫成檔案，由 Snow 備份後手動套用**；套用前 `packaging_*` 表不存在）。

---

## 〇、範圍、硬限制與對應決策

| 做（P1） | 不做 |
| --- | --- |
| `/packaging/schedule` 工作台：左待排池＋待排區、右 10 個台灣工作日日期欄（D21、D51） | AI 排程、規則區、提醒區（P2；D29、D34） |
| 拖曳排定、預排虛線（D22）、拆卡／合併（D7）、放回待排池／待排區 | 排到「人」或「時段」（D5 只排到日） |
| 手動完成勾選（D24、D26） | 回寫塔台報工（D4、D24） |
| 自動順延＋延誤標籤（D50） | 發布制（D52 即時版）、現場裝置版（D54） |
| 每日產能表、週六加班欄（D48、D49）、欄頭已排／可用（D51） | 卡片簡化（延後細節第 40 題，**卡片樣式不動**） |
| 自動儲存、Undo 50 步、版本快照＋還原（D33） | D16「不需包裝」、D28「需完整包裝」手動開關（見 §9.2） |
| 編輯鎖＋接手（D53）、唯讀模式（D30、D52） | 任何既有表寫入、ARGO 查詢 |
| D46／D47 待排池資料修正（§六，改 P0 classify／pool） | |

**硬限制（寫在程式註解與 code review 檢查表）**

1. **只寫 `packaging_*` 新表**：P1 所有寫入 API 只碰 `packaging_placements`、`packaging_daily_capacity`、`packaging_schedule_versions`、`packaging_edit_lock`、`packaging_op_log`。絕不寫任何既有表、不回寫塔台（D4／D24）。
2. **瀏覽器不直接查表**：前端是 anon key，所有讀寫走 `/api/packaging/*`（`guardAuth` → 權限 → `getSupabaseAdminClient()`）。
3. **權限（D30）**：讀＝`packaging` 或 `packaging_admin`（admin 自動通過）；寫＝`packaging_admin`（admin 自動通過）。**所有寫入 API 另外必須持有編輯鎖**（§3.7）。
4. **GET 不寫入**：D50 自動順延、D7 數量調和都是「讀取時推導」，不在 GET 裡改 DB（唯讀使用者也會呼叫 GET）。
5. 套用 migration 前，P1 API 會因找不到表回 500；驗證只能做型別檢查＋純函式測試（§8.3）。

---

## 一、資料模型

完整 DDL 見 `sql/20260927_packaging_schedule.sql`。五張表：

| 表 | 一列代表 | 主要欄位 |
| --- | --- | --- |
| `packaging_placements` | 一張排定（子）卡 | `id uuid`（前端產生）、`so_line_key`、`qty`、`plan_date`（null＝待排區）、`original_date`、`source`（manual／ai）、`origin_card_id`、`completed_at/by/by_name`、`completed_pool_qty`、`version`、稽核欄 |
| `packaging_daily_capacity` | 一天的產能 | `date` PK、`headcount`、`regular_hours`、`overtime_hours_max`、`is_saturday_open`、`note`、`updated_by/at` |
| `packaging_schedule_versions` | 一份快照 | `id`、`label`、`source`（manual／auto_before_ai／auto_after_ai／auto_before_restore）、`snapshot jsonb`、`placement_count`、`created_by/at` |
| `packaging_edit_lock` | 唯一一把鎖（id＝1） | `holder_email/name`、`token`、`acquired_at`、`heartbeat_at`、`last_action_at`、`prev_holder_*`、`taken_over_at` |
| `packaging_op_log` | 一次成功寫入 | `created_at`、`actor_email/name`、`kind`、`label`、`ops jsonb` |

RLS 全開、只有 `service_role` policy，並 `revoke all ... from anon, authenticated`（比照 `20260913_quote_system.sql`）。

### 1.1 為什麼「一張卡一列」而不是整份排程存成一個 JSON 草稿

| 面向 | 每張卡一列（採用） | 整份 JSON 草稿（淘汰） |
| --- | --- | --- |
| 自動儲存粒度（D33） | 一次拖曳＝改 1 列（幾十 bytes），失敗只影響那張卡 | 每次拖曳都要重寫整份 300 張卡的 JSON；兩個請求交錯時後寫的整份蓋掉前一份 |
| 樂觀檢查 | 每列 `version`，只衝突在「同一張卡」 | 只能整份比對版本，任何一張卡變動都讓其他所有操作衝突 |
| 編輯鎖（D53） | 鎖保證單一寫者，`version` 再擋「同一人兩個分頁」與「接手前的殘留請求」 | 同樣需要鎖，但失敗時整份丟失的代價大 |
| 拆卡守恆（D7） | 依 `so_line_key` 聚合即可算已排量，DB 端可查 | 每次都要解析整份 JSON |
| 完成紀錄 | 完成是「事實」，還原快照時保留已完成列、只換未完成列 | 還原整份 JSON 會把完成紀錄一起倒回去 |
| 快照（D33） | 快照＝把「當下的列」複製成 jsonb（快照本身不可變，用 JSON 正合適） | 草稿與快照格式相同是唯一優點 |
| P2 AI | AI 產生的是一批 `place` 操作，跟人工拖曳走同一條驗證路徑 | 需另寫整份合併邏輯 |

結論：**可變的現況用列，不可變的歷史（快照）用 JSON**。

### 1.2 剩餘量不存、讀取時推導

`packaging_placements` 只存「排了多少到哪天」，**不存待排池剩餘量**。剩餘量＝該 SO 行目前的可排供給（由 P0 待排池即時算出）−未反映的完成量−擺放有效數量（§3.3）。好處：

- 待排池數量變動（到貨、塔台報工、ERP 改量）不需要任何同步程式去改排程表。
- 多列寫入沒有交易（PostgREST 一個請求一個敘述）：只要寫入順序「先減後增」（§3.8），任何中途失敗都只會讓數量**回到待排池**，不會重複排或憑空消失。

### 1.3 為什麼沒有 `packaging_card_state`

原構想把完成勾選與延誤起算放在以 SO 行為鍵的 `packaging_card_state`。改為：

- **完成勾選放在擺放列上**：拆卡後每張子卡各自完成（例：今天包 300、明天包 200），以 SO 行為鍵只能表達「整行完成」。待排池裡還沒排的卡要直接勾完成，就在同一批送 `place`（排到今天）＋`complete`，完成仍是一張擺放列（§4.3）。
- **延誤起算不必存**：`plan_date` 本身就是起算點（GET 不改寫它，§3.5）；`original_date` 另存第一次排定日供 P2。
- 以 SO 行為鍵的「手動覆寫」（D16 不需包裝、D28 需完整包裝、D46 延伸的包裝單說明）將來需要時再開 `packaging_line_overrides`，P1 不建空表。

---

## 二、卡片身分與待排池的對應

### 2.1 身分

- **卡片身分＝`soLineKey`（`${SO}-${項次}`）**，D6「一張卡＝一個 ARGO 品項行」。
- P0 的 `cardId` **不穩定**：同一 SO 行拆在不同區塊時會變成 `${soLineKey}#${區塊}`，貨一到台就從 `#1` 變 `#2`、甚至合併回無後綴。所以擺放列**不以 cardId 為鍵**，只把拖出來時的 cardId 記在 `origin_card_id` 供顯示。
- 無法解析項次的卡（P0 `so_line_unresolved`，soLineKey 形如 `SO…-?POC…-n`）照樣可排，鍵一樣穩定（只要採購行不變）。
- **子卡序**（「拆 2/3」）不存 DB：讀取時對同一 SO 行的擺放依（顯示日期、未排在最後、`created_at`）排序編號，待排池剩餘卡排在最後（§3.6）。

### 2.2 可排區塊（D22）

`PLACEABLE_BLOCKS = ['2','5b','4','4x','1b','1','5a','ns']`：

| 區塊 | 可排？ | 就緒程度 |
| --- | --- | --- |
| 2 常平已入庫、5b 委外已入庫 | 可 | 可包（`qtyReady`） |
| 4 製令前站已完工 | 可 | 可包 |
| 4 製令前站進行中／暫停 | 可 | `qtyReady` 部分可包，其餘預排（D23），預估可包日＝前站計畫完工 |
| 4x 無前站 | 可 | 依 P0 `qtyReady` |
| 1b 品檢中、1 常平運送中、5a 委外已出貨 | 可 | 全部預排（虛線），預估可包日＝`estReadyDate` |
| ns 已發單・未上塔台 | 可（D44「可正常排程」） | 預排、可包日未知（`pre_unknown`） |
| **3 常平未寄且緊張** | **不可**（D22 明文「不預排，僅提醒」） | — |
| **5c 委外出貨待確認** | **不可**（本規格解讀：出貨與否不明，比照 3；待 Snow 確認 §9.3） | — |

不可排卡照常顯示在待排池，拖曳時游標顯示禁止；API 回 `not_placeable`。

### 2.3 供給片段（supply segment）

每張可排的待排池卡拆成最多兩片：

```
ready   片：qty = card.qtyReady,                  estReadyDate = null
pending 片：qty = card.qtyCard − card.qtyReady,   estReadyDate = card.estReadyDate
```

同一 SO 行所有片段依「可包片在前（`PLACEABLE_BLOCKS` 順序、再 cardId）→ 未就緒片依 `estReadyDate` 升冪、null 最後」排序，形成 `LineSupply.segments`。`S = Σ qty`。

### 2.4 池內卡消失時（D43／D45／SO 結案）

某 SO 行在待排池已經沒有任何卡（塔台批結案 D43、包裝站人工報完工 D45、ERP SO 結案、D12 改判非實體…）：

- **不刪擺放資料**（還可能回來：塔台誤結案後重開、同步暫時漏抓）。
- 讀取時略過，不顯示在日期欄與待排區，計數回傳 `skipped.lineGoneOpen`／`skipped.lineGoneCompleted`，頁尾顯示「N 張已排的卡因訂單已完成或結案而隱藏」。
- 版本快照還原時照樣寫入，讀取時一樣略過（`RestorePlan.lineGoneCount` 事先告知）。

只剩不可排區塊（3／5c）的 SO 行：擺放照常分配，但供給 0 → 有效數量被扣到 0，標 `not_placeable_now`（例：常平改判未寄出）。

---

## 三、規則演算法（純函式規格）

所有函式放在 `lib/packaging/schedule*.ts`，**不 import supabase、不讀時鐘**（today／now 由參數傳入），前後端共用（前端用同一套函式做樂觀更新）。檔內一律相對路徑 import，才能用 `node --experimental-strip-types` 跑單元測試（§8.3）。日期運算一律用 `lib/packaging/workdays.ts`。

### 3.1 行事曆與顯示範圍（D48、D51）— `lib/packaging/scheduleCalendar.ts`

```ts
openSaturdaysOf(rows: DailyCapacity[]): Set<YMD>            // is_saturday_open && overtimeHoursMax > 0 的週六
isBoardDay(d: YMD, openSats: ReadonlySet<YMD>): boolean       // isWorkday(d) || openSats.has(d)
boardWindow(from: YMD, workdays: number, openSats): YMD[]
rollTarget(today: YMD, openSats): YMD                         // 第一個 d ≥ today 且 isBoardDay(d)
nextBoardDay(d: YMD, openSats): YMD                           // 第一個 > d 的工作台日期
displayDateOf(p: Pick<Placement,'planDate'|'completed'>, today, openSats): { date: YMD | null; rolled: boolean; offBoard: boolean }
delayWorkdays(planDate: YMD, today: YMD): number
```

- **工作台日期**＝台灣行政日曆工作日（週一～五扣國定假日，同交期計算，`isWorkday`）＋**已開加班的週六**。週日、國定假日不出現（D48 未定義假日加班 → §9.3）；**國定假日落在週六**（例：2026-10-10 國慶日）同樣不能開加班欄：`isHolidaySaturday(d)`（週六、非補班、`dayInfo` 原因不是單純「週末」）→ `validateCapacityInput` 對開加班回 `date_not_workday`，`openSaturdaysOf`／`resolveCapacity` 也忽略這天既有的開加班列。
- `boardWindow`：從 `from` 起逐日走，工作日計入名額，開加班的週六插入但不佔名額，湊滿 `workdays` 個工作日為止（安全上限 90 個日曆天）。

  ```
  d = from; out = []; n = 0
  while n < workdays:
    if isWorkday(d): out.push(d); n++
    else if openSats.has(d): out.push(d)
    d = d + 1 日曆天
  ```
  例：from＝2026-09-24（四），workdays＝3，無加班 → `[09-24, 09-29, 09-30]`（9/25 中秋、9/28 教師節）。週六 10/3 開加班、from＝10/1、workdays＝3 → `[10-01, 10-02, 10-03, 10-05]`。
- `displayDateOf`（D50 的核心）：
  1. 已完成 → `plan_date` 原樣（過去就不在視窗內）；
  2. `plan_date = null` → null（待排區）；
  3. `plan_date < today` → `rollTarget(today)`，`rolled = true`；
  4. `plan_date` 不是工作台日期（週六取消加班、行事曆更新）→ `nextBoardDay(plan_date)`，`offBoard = true`；
  5. 其餘 → `plan_date`。
- `delayWorkdays(planDate, today) = max(1, workdaysBetween(planDate, today))`（只在 `planDate < today` 時呼叫）。例：排 9/24（四）、今天 9/29（二）→ `workdaysBetween = 1`（只數 9/29）→ 延誤 1 天；排週六 10/3 加班、今天週日 10/4 → 0 → 取 1。

### 3.2 產能（D49）— `lib/packaging/scheduleCapacity.ts`

```ts
resolveCapacity(date: YMD, rows: DailyCapacity[] /* 依 date 升冪 */): EffectiveCapacity
resolveCapacityRange(dates: YMD[], rows): EffectiveCapacity[]
dayLoad(usedMinutes: number, cap: EffectiveCapacity): DayLoad
validateCapacityInput(input: CapacityInput, ctx: { today: YMD; openCardCountOn(date): number }): { ok: true } | { ok: false; code; message }
```

`resolveCapacity`：

| 情況 | 結果 |
| --- | --- |
| 週六，有列且 `isSaturdayOpen` | `kind:'saturday'`、`regularMinutes: 0`、`overtimeMinutes = overtimeHoursMax×60`、`source:'explicit'` |
| 週六，沒列或沒開 | `regularMinutes: 0`、`overtimeMinutes: 0`、`source:'saturday_default'`（D49「週六預設 0」；也不會出現在工作台） |
| 平日，當天有列 | `explicit`：`regularMinutes = regularHours×60`、`overtimeMinutes = overtimeHoursMax×60`、`headcount` |
| 平日，當天沒列 | 找 **date 早於當天、且為週一～五** 的最近一列 → `inherited`（三欄全部沿用），`inheritedFrom = 該列日期` |
| 平日，之前沒有任何平日列 | `unset`：`regularMinutes: null`、`overtimeMinutes: 0` |

> 「最近一次填的平日值」本規格解讀為**日期上最近的較早平日**（而不是「最後被編輯的那一列」）：結果只取決於日期，重填過去的值不會改變未來的預設，較好預測。副作用：某天因請假填得特別低，之後沒填的平日都會沿用那個低值 → 產能對話框對 `inherited` 的欄位以灰字顯示「沿用 10/5」提醒；是否改成另設「平日預設值」待 Snow 確認（§9.3）。

`dayLoad`（D51 欄頭顏色）：

```
regularMinutes == null            → 'unset'（灰，進度條只顯示已排分鐘）
used ≤ regular                    → 'ok'
used ≤ regular + overtime         → 'over_regular'（橘）
否則                              → 'over_overtime'（紅）
```
週六 regular＝0，所以有排卡就是橘（本來就是加班日），超過加班上限變紅。

`validateCapacityInput`（PUT 用）：日期格式合法；`today − 30 ≤ date ≤ today + 120`；週日拒絕；平日必須 `isWorkday`（國定假日拒絕 `date_not_workday`）；週六 `regularHours` 必須 0、開加班時 `overtimeHoursMax > 0`；平日 `isSaturdayOpen` 必須 false；`headcount` 為 0~500 整數或 null；工時 0~5000、最多 2 位小數。**關閉一個週六加班**（`clear`、`isSaturdayOpen=false` 或加班 0）而該日還有未完成的卡 → `saturday_has_cards`（附張數），請主管先把卡移走。

### 3.3 供給、分配與拆卡守恆（D7、D22、D23）— `lib/packaging/scheduleAllocate.ts`

```ts
lineSupply(soLineKey: string, cards: PackagingCard[] /* 該行所有待排池卡 */): LineSupply
unreflectedCompletedQty(completed: Placement[], supplyTotal: number): number     // §3.4
allocateLine(input: {
  supply: LineSupply
  placements: Placement[]        // 該行所有擺放（含已完成）
  today: YMD
  openSats: ReadonlySet<YMD>
}): LineAllocation
minutesForQty(perUnit: number | null, qty: number): number | null
```

`lineSupply`：依 §2.3 產生片段；`perUnit` ＝可排卡 `work.perUnit` 以 `qtyCard` 加權平均（忽略 null；全 null → null）；`nonPlaceableQty` ＝區塊 3／5c 的 `qtyCard` 合計。

`allocateLine` 步驟：

```
1. open      = placements 中未完成者
   completed = placements 中已完成者
2. U = unreflectedCompletedQty(completed, S)            // 已勾完成、待排池還沒扣掉的量
   E = max(0, S − U)                                     // 有效可排供給
   片段依序先扣掉 U（可包片先扣——完成的東西一定是已就緒的）
3. open 依 (displayDate 升冪, 待排區最後, created_at, id) 排序
   over = Σ open.qty − E
   若 over > 0：從排序最前面（最早的卡）開始扣，effectiveQty = qty − 扣掉的量，trimmedQty 記下
     理由：待排池變少最常見的原因是塔台已報包裝完工（D45 部分報工），實際被包掉的是最早排的卡；
           D50 也把「塔台已報完工」視為完成。ERP 改量等其他原因同樣從最早扣，旗標文字中性。
4. 依同一順序，把剩下的片段（扣完 U 後）分配給各卡的 effectiveQty（先可包片，再依 estReadyDate 的未就緒片）
   readyQty   = 分到的可包片量
   pendingQty = 分到的未就緒片量
   preReadyDate = 分到的未就緒片中最晚的 estReadyDate；任一片為 null → null
   readiness  = pendingQty = 0 ? 'ready' : preReadyDate == null ? 'pre_unknown' : 'pre'
   baseCardId = 分到最多數量的片段所屬卡（全 0 時用該行第一張可排卡）
5. 片段剩下的量 → remainingByCard（依片段的 cardId 加總），remainingTotal = Σ
```

**守恆不變式（單元測試必測）**：`Σ open.effectiveQty + U_consumed + remainingTotal = S`，且每個 `effectiveQty ≥ 0`、`remainingByCard[c] ≤ card.qtyCard`。

**旗標**（`PlacementFlag`，由 §3.6 組裝時加）：

| code | 條件 | level | 文字 |
| --- | --- | --- | --- |
| `pre_due` | readiness ≠ ready 且 displayDate ≠ null 且 displayDate ≤ today | warn（橘） | 「到期仍未就緒（未入庫／前站未完工），請挪移」（D22 橘燈） |
| `before_est_ready` | readiness = pre 且 displayDate < preReadyDate | warn | 「排在預估可包日 M/D 之前」（資料變動造成，只警示不自動移） |
| `trimmed` | 0 < trimmedQty 且 effectiveQty > 0 | info | 「待排池減少 N（可能塔台已報包裝完工或訂單／採購量變更）」 |
| `pool_consumed` | effectiveQty = 0 且該行供給 > 0 | info | 「已由待排池扣完（多半是塔台已報包裝完工）」 |
| `not_placeable_now` | effectiveQty = 0 且該行可排供給 = 0、但仍有 3／5c 的量 | warn | 「目前只剩未寄出／待確認的量，不能排」 |
| `line_eta_passed` | 底卡 flags 含 `eta_passed` | warn | 轉貼 P0 文字 |
| `delayed`、`off_board_day` | §3.5 | warn／info | 「延誤 N 天」／「原排 M/D 已非工作日」 |

`pool_consumed` 的卡：displayDate ≥ today 時灰色顯示（可按「移除」＝`unplace`），已過去則不顯示並計入 `skipped.consumedPast`。

`minutesForQty(perUnit, qty)`：`perUnit == null → null`；`qty ≤ 0 → 0`；否則 `max(MIN_CARD_MINUTES, round1(perUnit × qty))`（每張子卡最少 10 分，沿用 P0 `calcEst`；拆越多張，最少值的影響越大，屬已知誤差）。

**例（守恆＋預排）**：SO260827004-1 的供給：5b 已入庫 11,146（可包）、1b 品檢中 5,854（est 10/2）。擺放 A＝9/30 8,000、B＝10/1 6,000、待排區 C＝2,000。
→ S＝17,000、U＝0、E＝17,000、Σ＝16,000 不修剪。A 分可包 8,000（ready）；B 分可包 3,146＋未就緒 2,854（pre，preReadyDate 10/2，且 10/1 < 10/2 → `before_est_ready`）；C 分未就緒 2,000（pre）；待排池剩 1b 卡 1,000。

### 3.4 完成（D24、D26、D45）與「未反映的完成量」

- 完成＝擺放列 `completed_at` 有值。已完成卡不能移動／拆／併（`completed_locked`），要先取消完成。
- 勾完成時伺服器同時：
  - `plan_date` 若已過（延誤卡）或為 null（待排區）→ 改為 `rollTarget(today)`（記錄「實際在今天完成」；舊值由反向操作 `uncomplete.prevPlanDate` 保存）；
  - 若該卡 `effectiveQty < qty`（被修剪過）→ `qty` 改為 `effectiveQty`（舊值存 `uncomplete.prevQty`）；`effectiveQty = 0` 的卡拒絕（`qty_invalid`：「已由待排池扣完，不需勾完成」，請用「移除」）；
  - `completed_pool_qty` ＝勾選當下該行 `S`（待排池原始可排供給）。
- **為什麼要算「未反映的完成量」U**：不同來源在「勾完成之後」待排池的反應不同——
  - 委外（5b）：塔台沒有包裝工序，勾完成後待排池數量**永遠不會減少**，直到塔台結案（D43）。不扣掉，剩餘量會馬上冒回待排池。
  - 常平 POC／自製製令：之後有人在塔台報包裝完工，待排池會減少同樣的量（P0 §11.1 第 11 條只認人工報工）。這時再扣一次就重複扣了。
- `unreflectedCompletedQty(completed, S)`：
  ```
  若 completed 為空 → 0
  C = Σ completed.qty
  B = 最早完成（completed_at 最小）那列的 completed_pool_qty（null 視為 S）
  drop = max(0, B − S)             // 從第一次勾完成到現在，待排池減少了多少
  U = clamp(C − drop, 0, C)
  ```
  例：委外 500，勾完成 200（B＝500），之後池不變 → U＝200，剩 300 ✓。製令 500，勾完成 200（B＝500），之後塔台報工 200 → S＝300、drop＝200 → U＝0 ✓。兩次完成（100@500、100@400，中間塔台報了 100）且現在 S＝400 → C＝200、drop＝100 → U＝100 ✓。
  已知誤差：勾完成後訂單量又增加（S 上升）再被報工，drop 會低估 → U 偏大（剩餘量偏少）；很少見，列入限制（§9.1）。
- 已完成卡的顯示：**留在當天欄、變灰、計入當天已排工時**（延後細節「完成的卡留在當天變灰 vs 直接消失」尚未定案；P1 先採「變灰」保留排 vs 實際的紀錄，工具列提供「隱藏已完成」切換，偏好存 localStorage）。日期已過的完成卡不在視窗內。
- D26：委外卡只能靠勾完成消失——剩餘量 0 且所有擺放都完成 → 待排池與日期欄（過了當天）都看不到。

### 3.5 自動順延（D50）

- 條件：`plan_date < today` 且未完成（未勾完成；塔台已報完工的部分已由 §3.3 修剪掉，`effectiveQty = 0` 的卡不順延）。
- 呈現：顯示在 `rollTarget(today)` 欄（今天是週末／假日時為下一個工作台日期），加 `delayed` 旗標「延誤 N 天」，`N = delayWorkdays(plan_date, today)`（台灣工作日，**累計**：DB 的 `plan_date` 不動，所以天數會一天天累加）。計入該欄已排工時。欄頭顯示「含順延 k 張」。
- **不寫回 DB**：GET 不寫入（唯讀者也在呼叫）、不需排程工作、規則只取決於（plan_date, today），誰算都一樣；P2 AI 也用同一個函式看到同樣的結果。
- 主管手動處理：把延誤卡拖到任何一天（含今天）＝一般 `move`，`plan_date` 改成新日期、延誤標籤消失，`source` 變 `manual`；「主管手動挪過的卡以主管安排為準」——P1 系統本來就不會自動改日期，P2 AI 重排時不得動 `source='manual'` 的卡（P2 規格再定細節）。`original_date` 不變，詳情顯示「原排 9/24」。
- 延誤卡在今天欄的排序：延誤天數多的在最上面（§3.6）。

### 3.6 工作台組裝 — `lib/packaging/scheduleBoard.ts`

```ts
assembleBoard(input: {
  pool: PoolOk                   // P0 buildPackagingPool 結果（含 blocks）
  placements: Placement[]        // 未完成全部 + 已完成中 so_line_key 仍在池內或 plan_date ≥ from 者
  capacityRows: DailyCapacity[]  // date ≥ today − 400 天
  today: YMD
  from: YMD
  workdays: number
}): Omit<Extract<BoardResponse, { success: true; unchanged?: false }>, 'lock' | 'me' | 'serverTime' | 'revision'>
boardRevision(parts: { poolGeneratedAt: string; opLogMaxId: number; placementsMaxUpdatedAt: string | null; placementCount: number; today: YMD }): string
```

步驟：
1. 待排池卡依 `soLineKey` 分組；擺放依 `soLineKey` 分組。
2. 擺放所屬行不在池內 → 計入 `skipped`，略過。
3. 每行 `lineSupply` → `allocateLine`。
4. 每張擺放組 `BoardCard`：`card` 以 `baseCardId` 那張待排池卡深拷貝，改 `qtyCard = effectiveQty`、`qtyReady = readyQty`、`split`、`work = { ...work, qtyBasis: effectiveQty, minutes: minutesForQty(perUnit, effectiveQty) }`（**只換數值，元件與樣式沿用 P0 `PackagingCard`**）。
5. 依 `displayDateOf` 放進日期欄／待排區／`later`（視窗之後）。
6. 每欄：`usedMinutes`（含已完成、不含 null）、`openMinutes`、`unknownMinutesCards`、`capacity = resolveCapacity`、`load = dayLoad`、`rolledInCount`。欄內排序：延誤天數降冪 → `pre_due` → 打樣類 → 交期升冪 → `created_at`（D5 不排時段，欄內順序沒有意義，固定排序即可，不存順序）。
7. 待排池：每張卡改 `qtyCard = remainingByCard[cardId]`（不可排卡原樣）、`work.minutes` 重算，剩 0 的不列；區塊合計（`cardCount`、`totalMinutes`…）重算；`cardMeta[cardId] = { originalQty, placedQty, remainingQty, placeable }`。
8. 子卡序：同一行的「顯示中擺放」依（displayDate、待排區最後、created_at）編號 1..k，剩餘的待排池卡依區塊順序接在後面；`total = k + 剩餘卡數`。只有 `total ≥ 2` 才覆寫 `split`，否則 `null`。
9. `boardRevision`：`sha1(poolGeneratedAt | opLogMaxId | placementsMaxUpdatedAt | placementCount | today)` 取前 16 碼。**不含鎖**（心跳每 30 秒改 `last_action_at`，含進去就永遠不會 unchanged；鎖狀態在 unchanged 回應裡另外帶）。

### 3.7 編輯鎖（D53）— `lib/packaging/scheduleLock.ts`

```ts
evaluateLock(row: EditLockRow | null, nowMs: number, caller: { email: string; token: string | null }): LockState
planLockAction(action: LockAction, row: EditLockRow, caller: { email: string; name: string | null; token: string | null; active?: boolean }, nowMs: number, newToken: () => string): LockPlan
```

- **有效持有**：`holder_email != null` 且 `now − last_action_at ≤ LOCK_IDLE_MS`（5 分鐘）。逾時＝視為已釋放，**不需要清鎖排程**。
- `isMine`＝有效持有 且 `holder_email = caller.email`（不分大小寫）且 `token = caller.token`。用 token 而非只比 email：同一個人開兩個分頁，只有一個能寫；接手自己另一台電腦的鎖也走同一流程。
- `takenOverBy`：`caller.email = prev_holder_email` 且 `taken_over_at` 在 10 分鐘內且目前持有者不是 caller → 帶入現持有者。
- `planLockAction`：

| action | 條件 | 結果（patch） |
| --- | --- | --- |
| acquire | 無有效持有者，或 `isMine`（重整後帶舊 token 續用） | 無有效持有者：新 token、`holder_*`、`acquired_at = heartbeat_at = last_action_at = now`；isMine：只更新時間、token 不變 |
| acquire | 別人有效持有 | `reject: held_by_other` |
| heartbeat | `isMine` | `heartbeat_at = now`；`active` 為 true 才 `last_action_at = now` |
| heartbeat | 不是 isMine | `reject: lock_lost`（被接手或已逾時） |
| release | `isMine` | `holder_* = null`、`token = null` |
| release | 不是 isMine | `noop`（回目前狀態，不報錯） |
| takeover | 任何 `packaging_admin` | 新 token、`holder_* = caller`、`prev_holder_* = 原持有者`（有效時）、`taken_over_at = now` |

- **執行（I/O，`lib/packaging/scheduleDb.ts`）**：讀鎖列 → `planLockAction` → `update packaging_edit_lock set … where id = 1 and token is not distinct from :expectToken returning *`（PostgREST：`expectToken` 為 null 用 `.is('token', null)`，否則 `.eq('token', t)`）。0 列＝期間有人搶先 → 重讀重算一次，仍失敗回 `held_by_other`。**單一 UPDATE 敘述＝原子 compare-and-set**，不需要資料庫函式。
- **寫入 API 的鎖驗證＝同時續命**：每個寫入請求第一步執行

  ```
  update packaging_edit_lock
     set last_action_at = now, heartbeat_at = now, updated_at = now
   where id = 1 and token = :lockToken and holder_email = :callerEmail and last_action_at >= :now − 5 分
  returning *
  ```
  回 0 列 → 重讀鎖列 → `evaluateLock` → 別人持有回 `lock_lost`（409），否則 `lock_required`（409）。驗鎖與寫入之間仍有毫秒級空窗（沒有交易）：接手恰好發生在這瞬間時，舊持有者的這一筆寫入會生效——人工操作速度下可接受，接手者下一次輪詢就會看到。
- 時間一律用**伺服器時鐘**（`Date.now()`，Vercel 各實例 NTP 同步）；前端顯示的倒數以回應的 `serverTime` 校正本機時差。
- 被接手的一方：下一次心跳（≤ 30 秒）或下一次寫入收到 `lock_lost` → 立刻轉唯讀、清空 Undo／Redo、橫幅顯示「已由 XXX 接手編輯（HH:mm）」，佇列中尚未送出的操作丟棄並提示張數。

### 3.8 操作、驗證與 Undo（D7、D22、D33）— `lib/packaging/scheduleOps.ts`、`scheduleUndo.ts`

```ts
applyOps(state: OpsState, ops: PlacementOp[], ctx: OpsContext):
  | { ok: true; next: Map<string, Placement>; inserts: Placement[]; updates: { before: Placement; after: Placement }[]; deletes: Placement[]; inverse: PlacementOp[] }
  | { ok: false; code: ApplyErrorCode; opIndex: number; message: string; current?: Placement | null }

interface OpsState { byId: Map<string, Placement> }              // 至少包含 ops 觸及的 SO 行的全部擺放
interface OpsContext {
  today: YMD; nowIso: string; actor: { email: string; name: string | null }
  openSats: ReadonlySet<YMD>
  supplyOf(soLineKey: string): LineSupply | null                   // 由待排池算；null＝行不在池內
  cards: Map<string, PackagingCard>                                // cardId → 卡（驗 originCardId 用）
  maxDate: YMD                                                     // today + 120 日曆天
}
```

逐一模擬（後一個操作看得到前一個的結果），任何一步失敗整批不寫。

| op | 驗證 | 效果 | 反向操作（inverse） |
| --- | --- | --- | --- |
| `place` | id 為 uuid 且不存在；行在池內；`originCardId` 若給須在池內且可排；qty > 0、≤ 3 位小數、**≤ 該行 remainingTotal**；toDate 見下 | 新列 `version 1`、`source manual`、`original_date = toDate` | `unplace {id, version:1}` |
| `move` | 列存在、版本相符、未完成；toDate 見下 | `plan_date = toDate`；`original_date` 為 null 且 toDate 非 null 時補上；`source → manual`；version+1 | `move` 回原日期 |
| `split` | 同上；`keepQty > 0`；parts 1~9 個、各 qty > 0、id 不重複；**keepQty + Σparts = 原 qty**（`split_sum_mismatch`）；part.toDate 省略＝同原卡 | 原列 qty＝keepQty；各 part 新列（同 `original_date`、`source`） | `merge {targetId:id, sources: parts}` |
| `merge` | target 與 sources 皆存在、版本相符、未完成、**同一 so_line_key**、target ∉ sources（`merge_mismatch`） | target qty += Σ；刪除 sources | `setQty(target, 原 qty)` ＋ 各 source 的 `restore` |
| `unplace` | 存在、版本相符、未完成 | 刪除 | `restore {row}` |
| `setQty` | 存在、版本相符、未完成、qty > 0；增加時 **≤ remainingTotal＋原 qty** | qty 改變 | `setQty` 回原值 |
| `restore` | id 不存在；**行必須在池內**（`line_not_in_pool`）；planDate 同 move 的日期規則（允許 400 天內的過去日期）、originalDate ≤ maxDate；守恆 | 以原 id 重建（version 1） | `unplace` |
| `complete` | 存在、版本相符、未完成、effectiveQty > 0 | §3.4 | `uncomplete {prevPlanDate, prevQty}` |
| `uncomplete` | 存在、版本相符、已完成；**行必須在池內**；prevPlanDate 同 move 的日期規則；守恆 | 清除完成欄；帶 prevPlanDate／prevQty 時還原 | `complete` |

**toDate 規則**（place／move／split part）：null（待排區）一律允許；否則 `today ≤ toDate ≤ maxDate`（`date_past`、`date_invalid`）、`isBoardDay`（`date_not_board_day`）；**D22**：以操作後狀態重跑 `allocateLine`，本卡 `readiness = 'pre'` 且 `toDate < preReadyDate` → `before_est_ready`（`pre_unknown` 允許）。只檢查「被操作的那張卡」；其他卡因重新分配而變成預排的，只在讀取時加 `before_est_ready` 警示。

**守恆檢查**：會讓該行 Σ open.qty 增加的操作（place、setQty 增加、restore、uncomplete）要求 ① 行仍在待排池（否則 `line_not_in_pool`：行已離開待排池就不能 Undo／加量，避免寫出讀取時會被略過、卻永久留在表與快照裡的幽靈列）② 操作後 `Σ open.qty ≤ max(E, 本批開始前的 Σ open.qty)`。取 max 是實作的放寬（§9.2 第 9 條）：讓已被修剪的行也能 Undo 或同批「先放回再排出」；不會讓超排更嚴重，但已超排的行在同一批內可以維持超排。move／split／merge 不改總量，已被修剪的行也允許挪動。

**數量與張數上限**（防灌表，錯誤碼 `bad_request`）：`so_line_key` 白名單 `^[A-Za-z0-9][A-Za-z0-9?\-_./]{2,79}$`（D6 的 `${SO}-${項次}`，實測 306 行全符合；另容許 classify 缺項次時的 `${SO}-?${單號}`；擋掉 `, ( ) "` 空白等 PostgREST 保留字元，因為 supabase-js 的 `in()` 不轉義字串內的引號）；`originCardId` ≤ 64 字；每個 SO 行未完成子卡 ≤ 30 張（`MAX_OPEN_PER_LINE`，place／split／restore／uncomplete 後檢查，已超過的歷史行只擋再變多）；全表未完成擺放 ≤ 5000 張（`MAX_OPEN_PLACEMENTS`，寫入 API 在本批淨增加時多查一次 count）。

**寫入順序（無交易，「先減後增」）**：伺服器依 `applyOps` 結果分三步：
1. **刪除**：一個請求 `delete … or=(and(id.eq.A,version.eq.1),and(id.eq.B,version.eq.3))`，回傳筆數不符 → `version_conflict`；
2. **減量／不變量的更新**（move、split 的原卡、complete、uncomplete、setQty 減少）：逐列 `update … eq(id).eq(version, 舊版) returning *`，0 列 → `version_conflict`；
3. **新增與增量**（place、split parts、restore、merge target、setQty 增加）：新增用一個 bulk insert（主鍵衝突 → `id_exists`），增量逐列條件更新。

任何一步失敗：已完成的步驟不回滾，回 `partial: true`（前端重新載入、清空 Undo／Redo）。因為先刪／先減，中途失敗的結果只會是「數量回到待排池」，永遠不會超排。寫入成功後 `insert packaging_op_log`（失敗只 `console.error`，不影響回應）。

> 為什麼不用 Postgres 函式包成交易：本期 migration 範圍限定「只新增 packaging_* 表與索引」，而且函式預設 `EXECUTE` 權限給 PUBLIC，漏 `revoke` 就等於開後門給 anon key。單一寫者（編輯鎖）＋每列 version 條件更新＋「先減後增」已足夠；P2 AI 一次寫上百張卡時若要原子性，再另開 migration 評估。

**Undo（D33，前端）**：`scheduleUndo.ts` 純 reducer。

```ts
pushUndo(s: UndoState, e: UndoEntry): UndoState      // undo = [...undo, e].slice(-UNDO_LIMIT)，redo = []
takeUndo(s): { entry: UndoEntry | null; state: UndoState }
takeRedo(s): { entry: UndoEntry | null; state: UndoState }
clearUndo(): UndoState
```
- 每次成功寫入：把回應的 `inverse` 推進 undo（標籤＝請求 `label`）。
- 按 Undo：送出 entry.ops（仍是一般 `POST /api/packaging/placements`，一樣驗鎖、驗版本）；成功後把**這次回應的 inverse** 推進 redo。Redo 對稱。
- `version_conflict`／`not_found` → 丟掉該格、重新載入、提示「這一步已被其他變更覆蓋，無法復原」。
- 清空時機：取得／失去鎖、快照還原、`partial` 錯誤、重新整理頁面（Undo 只保留「當次」，D33）。
- 產能修改、快照建立不進 Undo（產能是事實輸入，有自己的表單；快照不改排程）。

### 3.9 版本快照（D33）— `lib/packaging/scheduleSnapshot.ts`

```ts
buildSnapshot(placements: Placement[], today: YMD, nowIso: string): ScheduleSnapshot   // 只收未完成
parseSnapshot(json: unknown): ScheduleSnapshot | null                                  // schemaVersion 檢查
planRestore(current: Placement[], snap: ScheduleSnapshot, ctx: { today: YMD; poolLines: ReadonlySet<string>; newId: () => string }):
  { plan: RestorePlan; deleteIds: string[]; inserts: PlacementSnapshotRow[] }
```

- 還原＝刪除目前**所有未完成**擺放，寫入快照中的擺放；**已完成列不動**。
- 快照列以**新 id** 寫入（舊 id 可能已是別的已完成列），`version 1`，保留 `original_date`、`source`。
- 還原前一定先自動存一份 `auto_before_restore`（讓還原本身可以反悔），並清空雙方 Undo。
- `RestorePlan`：`pastDateCount`（快照日期已過 → 還原後會順延到今天並標延誤）、`lineGoneCount`（行已不在池內 → 照寫但讀取時略過）、`removeCount`、`insertCount`。畫面先 GET 預覽再按確認。
- 快照日期已過、數量超過目前供給等情形不在還原時修正，全交給讀取時的 §3.3／§3.5（同一套規則，不另寫特例）。
- 保留 90 天：`POST /api/packaging/versions` 與還原時順手 `delete … where created_at < now − 90 天`。`auto_before_ai`／`auto_after_ai` 由 P2 寫入。

### 3.10 D46／D47 解碼 — `lib/packaging/saraKeys.ts`（詳見 §六）

```ts
isNonScheduleDocType(docType: string | null | undefined): boolean
decodeSaraMo(mo: string | null | undefined, lot: string | null | undefined): { soDigits: string; line: string; soGuess: string; rule: 'mot' | 'mos' | 'legacy' } | null
soLineDigitsKey(so: string, line: string | null): string | null
decodedTowerKeys(rows: { mo_nbr: string | null; lot_nbr: string | null }[]): Set<string>
```

---

## 四、API 契約

共同：`export const dynamic = 'force-dynamic'`；回應 `Cache-Control: no-store`；成功 `{ success: true, … }`、失敗 `{ success: false, error, code? }`。守門用新檔 `lib/packaging/guard.ts`：

```ts
export async function guardPackaging(level: 'read' | 'write'): Promise<Guarded>
// guardAuth() → admin 通過；read：permissions 含 packaging 或 packaging_admin；write：含 packaging_admin；否則 403
```

寫入 API 另外：
- 只收 `Content-Type: application/json`（否則 415）——擋掉跨站表單的「簡單請求」CSRF（cookie 驗證的 API 必備）。
- 第一步驗鎖（§3.7），錯誤碼 409 `lock_required`／`lock_lost`（附 `lock`）。
- 需要待排池時用共用快取 `getPool({ maxAgeMs: 10 * 60_000 })`（見 §7.1），避免每次拖曳都冷啟動重算 3~6 秒。

HTTP 狀態對照：401 未登入、403 `forbidden`、409 `lock_*`／`version_conflict`／`id_exists`／`held_by_other`／`saturday_has_cards`、422 其他驗證錯誤、400 `bad_request`、500 `db_error`／`pool_unavailable`。

### 4.1 `GET /api/packaging/board` — 讀（packaging／packaging_admin）

- 參數：`from`（預設 today；早於 today 一律當 today）、`workdays`（預設 10，1~30）、`rev`（上次的 revision）、`fresh=1`（待排池略過快取；**同一實例 30 秒內最多一次**，期間內視同一般讀取——唯讀者也能送，重算一次 3～9 秒、數十個 ERP／SARA 查詢）。
- 標頭：`x-packaging-lock: <token>`（選用；編輯者帶上才能算出 `lock.isMine`）。
- 流程分兩段（讓「沒變」的 60 秒輪詢幾乎不花資料庫）：
  1. **便宜指紋**（並行）：`getPool({ fresh })`、擺放表 `count=exact`＋最大 `updated_at`（一個請求）、鎖列、`packaging_op_log` 最大 id → `boardRevision({ poolDigest, opLogMaxId, placementsMaxUpdatedAt, placementCount, today, window: from/workdays })`；`rev` 相同時回 `{ success: true, unchanged: true, serverTime, revision, lock }`。
  2. **完整讀取**（指紋不同才做）：`packaging_placements` 未完成全部＋已完成且 `plan_date ≥ from`＋已完成且 `so_line_key in (池內各行)`（每 100 個一塊）、`packaging_daily_capacity`（`date ≥ today − 400 天`）→ `assembleBoard`。
- `poolDigest`：待排池**內容**（blocks、freshness、excluded、notes、staleUnsynced 張數、today）的 sha1，**不含 `generatedAt`／`cached`**——讀取快取每 120 秒重算，內容沒變時指紋不該變。代價：內容沒變時畫面上的「待排池生成時間」不跟著更新。`window` 讓前端換顯示天數時沿用舊 rev 也不會誤回 unchanged。
- 回應：`BoardResponse`（`scheduleTypes.ts`）。要點：`days[]`（每欄 `capacity`、`cards`、`usedMinutes`、`load`）、`holding`、`later`、`pool.blocks`（已扣排出量）、`pool.cardMeta`、`skipped`、`lock`、`me.canEdit`、`freshness`、`excluded`、`notes`、`staleUnsyncedCount`。
- 回應大小：待排池約 550KB（P0 §12.3）＋擺放數百張的卡片拷貝約 200~400KB；遠低於 Vercel 4.5MB。

### 4.2 `POST /api/packaging/placements` — 寫（packaging_admin＋鎖）

- 請求 `PlacementsRequest { lockToken, ops: PlacementOp[] (1~50), label? }`。
- 流程：守門 → 驗鎖續命 → 取觸及的 `so_line_key`（ops 內直接帶的＋以 id 查出來的）→ 讀這些行的全部擺放 → `getPool` → `applyOps` → 「先減後增」寫入 → op_log → 回應。
- 回應 `ApplyResponse`：成功帶 `rows`（寫入後的列）、`deletedIds`、`inverse`、`revision`、`lock`；失敗帶 `code`、`opIndex`、`current`、`partial`。
- 典型操作：拖曳待排池卡到 9/30 ＝ `[{op:'place', id, soLineKey, qty: cardMeta.remainingQty, toDate:'2026-09-30', originCardId}]`；拖曳擺放卡 ＝ `move`；拖回待排池 ＝ `unplace`；拖進待排區 ＝ `move toDate:null`（擺放卡）或 `place toDate:null`（待排池卡）。

### 4.3 `POST /api/packaging/cards/complete` — 寫（packaging_admin＋鎖）

- 請求 `CompleteRequest { lockToken, ops, label? }`，ops 只允許 `complete`、`uncomplete`、`place`（待排池卡直接勾完成＝`[place{toDate: rollTarget, qty: 剩餘}, complete{version:1}]`）。
- 內部與 4.2 共用 `applyOps`；`op_log.kind = 'complete'`。回應同 `ApplyResponse`（inverse 可 Undo）。
- 獨立成一支 API 的理由：權限與稽核上「勾完成」是獨立動作（P3 接塔台報工時只要改這一支），也方便日後單獨限流或加確認。

### 4.4 `GET / PUT /api/packaging/capacity`

- `GET ?from=&to=`（讀；預設 today ~ today+60，最長 180 天）→ `CapacityResponse { rows, effective }`；`effective` 只含區間內的工作台日期（工作日＋已開加班的週六）＋**區間內所有週六**（產能對話框要能開關週六）。
- `PUT`（packaging_admin＋鎖）請求 `CapacityPutRequest { lockToken, rows: CapacityInput[] (1~60) }` → 每列 `validateCapacityInput` → upsert（`clear` 者 delete）→ op_log `capacity` → 回應同 GET（區間＝請求日期的最小～最大）。
- 錯誤：`date_not_workday`（422）、`weekend_has_cards`（409，附 `date`、`cardCount`；D63 前名為 `saturday_has_cards`）、`migration_required`（409，D63，見 §十一）。
- 不進 Undo。

### 4.5 `GET / POST /api/packaging/versions`、`GET / POST /api/packaging/versions/[id]/restore`

- `GET /api/packaging/versions`（讀）→ `VersionsListResponse`，只回 meta（不含 snapshot），近 90 天、新到舊、最多 200 筆。
- `POST /api/packaging/versions`（packaging_admin＋鎖）`VersionCreateRequest { lockToken, label (1~80 字) }` → 同一人 30 秒內只能建一次（429，`code: bad_request`）→ 讀全部未完成擺放 → `buildSnapshot` → `snapshotTooLarge`（> 5000 列或 JSON > 2MB → 422；migration 另有 `octet_length(snapshot::text) < 5MB` 的 check）→ insert（`source: 'manual'`）→ 順手刪 90 天前 → `VersionCreateResponse`。
- `GET /api/packaging/versions/[id]/restore`（packaging_admin，不需鎖）→ `RestorePreviewResponse { version, plan }`（還原預覽，不寫入）。
- `POST /api/packaging/versions/[id]/restore`（packaging_admin＋鎖）`RestoreRequest { lockToken }` → 存 `auto_before_restore` 備份 → `planRestore` → 刪除未完成擺放 → bulk insert 快照列 → op_log `version_restore` → `RestoreResponse { plan, backup, revision }`。刪除後、insert 前失敗＝排程清空但有備份版本，回 `db_error` 並在訊息寫明「請從版本 #N 還原」。

### 4.6 `POST /api/packaging/lock`

- 請求 `LockRequest { action, token?, active? }`；回應 `LockResponse`。
- `acquire`／`takeover`／`release`：packaging_admin；`heartbeat`：packaging_admin（token 不符就回 `lock_lost`）。
- 成功的 `acquire`／`takeover` 才回 `token`（只給本人；其他人從 GET board 只看得到持有者名字與時間）。
- `release` 由頁面 `pagehide` 以 `navigator.sendBeacon('/api/packaging/lock', new Blob([json], { type: 'application/json' }))` 送出（同源、帶 cookie）；送不到也無妨，5 分鐘後自然逾時。
- `takeover`／`acquire`／`release` 寫 op_log（`kind: 'lock'`）；`heartbeat` 不記。

---

## 五、畫面規格：`/packaging/schedule`

### 5.1 檔案

| 檔案 | 內容 |
| --- | --- |
| `app/packaging/schedule/page.tsx` | 頁面殼：`/api/auth/me` 自查權限（無 packaging 權限顯示無權限）、載入 `useScheduleBoard` |
| `components/packaging/schedule/ScheduleBoard.tsx` | `DndContext`、左右分欄、DragOverlay、拖放 → op 轉換 |
| `components/packaging/schedule/PoolPanel.tsx` | 左欄：沿用 `PoolBlock`（區塊順序、收合、4x 複製清單），每張卡用 `DraggableCard` 包起來；底部「待排區」 |
| `components/packaging/schedule/HoldingArea.tsx` | 待排區（droppable `holding`） |
| `components/packaging/schedule/DayColumn.tsx` | 日期欄（droppable `day:YYYY-MM-DD`）＋欄頭 |
| `components/packaging/schedule/DayHeader.tsx` | 日期、星期、人數、已排／可用工時條、延誤張數、點擊開產能編輯 |
| `components/packaging/schedule/DraggableCard.tsx` | **外框包裝**：拖曳把手、虛線框、延誤標籤、完成勾選、「拆 i/n」、選單；內部原樣渲染 P0 `PackagingCard` |
| `components/packaging/schedule/SplitDialog.tsx` | 拆卡 |
| `components/packaging/schedule/PlaceQtyDialog.tsx` | 「排部分數量…」（從待排池排出指定數量與日期） |
| `components/packaging/schedule/CapacityDialog.tsx` | 產能表（多日表格）＋單日快速編輯 popover |
| `components/packaging/schedule/VersionsDrawer.tsx` | 版本面板 |
| `components/packaging/schedule/LockBanner.tsx` | 編輯鎖橫幅 |
| `lib/packaging/useScheduleBoard.ts` | 資料 hook：輪詢、操作佇列、樂觀更新、Undo |
| `lib/packaging/useEditLock.ts` | 鎖 hook：取得／心跳／活動偵測／釋放 |
| `components/packaging/PoolBlock.tsx`（小改） | 新增選用 prop `renderCard?: (card) => ReactNode`；不傳時行為與畫面完全不變（P0 待排池頁不受影響） |
| `app/packaging/page.tsx`（小改） | 「排程工作台」「每日產能」「版本歷史」格子改為可用（後兩者連到工作台並開對應對話框：`/packaging/schedule?panel=capacity|versions`） |

### 5.2 版面（桌機 ≥ 1280px 為主，D54 先不處理現場裝置）

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ 包裝排程工作台   資料更新：ERP 10:32 · 塔台 10:30 · 常平 昨 23:30     [重新整理]       │
│ [LockBanner：林主管 正在編輯中（最後動作 2 分鐘前） [接手編輯] ]                        │
│ [↶ Undo] [↷ Redo]  [產能表] [版本] [□ 隱藏已完成]  尚未儲存 0 · 已儲存 10:41           │
├───────────────────────┬────────────────────────────────────────────────────────────┤
│ 待排池（可捲動）        │ ← 9/29(二) │ 9/30(三) │ 10/1(四) │ 10/2(五) │ 10/3(六加班) │ … → │
│  ▸ 3 常平未寄緊張 (18)  │ 6人 已排 38.5/42h ▓▓▓▓▓▓░ │ …                               │
│  ▸ ns 已發單未上塔台    │ ┌延誤2天┐                                                     │
│  ▸ 2 常平已入庫 (58)    │ │ 卡片  │ ┆預排卡（虛線）┆                                     │
│  …                    │ └───────┘                                                    │
│ ───────────────────── │                                                            │
│ 待排區（主管擱置）(3)   │                                                            │
└───────────────────────┴────────────────────────────────────────────────────────────┘
```

- 左欄固定寬 400px、獨立縱向捲動；右欄 `overflow-x: auto`，每欄寬 280px、欄內獨立縱向捲動；欄頭 sticky。捲到最右時出現「再載入 10 個工作日」按鈕（`from` = 最後一欄的下一個工作日）。
- 寬度 < 1024px：不提供拖曳（`canDrag = false`），日期欄改為上下堆疊、待排池收合，頂端提示「請用電腦編輯」；頁面不可橫向捲動（整頁 16px 邊距，日期區自己捲）。

### 5.3 卡片外框（`DraggableCard`；**`PackagingCard` 本體不改**）

| 狀態 | 外框表現（只加在外框） |
| --- | --- |
| ready | 實線（沿用卡片自己的框） |
| pre／pre_unknown（D22） | 外層 2px **虛線**框（`outline-dashed`），角標「預排 10/2 可包」或「可包日未知」 |
| pre_due、before_est_ready、line_eta_passed | 虛線改**橘色**＋角標文字 |
| delayed（D50） | 頂部橘色標籤「延誤 N 天」 |
| completed | 整張 `opacity-50`＋綠色勾；「隱藏已完成」時不顯示 |
| pool_consumed | 灰色、角標「已由待排池扣完」＋「移除」按鈕 |
| 子卡 | 右上「拆 i/n」 |
| 待排池卡已部分排出 | 角標「已排 300／500」（`cardMeta`） |

外框左側有完成勾選框（D24；唯讀模式 disabled）、右上 `⋯` 選單：「拆卡…」「移到日期…」（日期挑選器，拖曳的鍵盤替代）「移到待排區」「放回待排池」「合併同行子卡」（同欄同行 ≥ 2 張時）「訂單詳情」（沿用 `PackagingOrderModal`）。待排池卡的選單：「排部分數量…」「直接勾完成」。

### 5.4 拖曳（`@dnd-kit/core`，參考 `git show fc3a92d^:components/ProductionScheduler.tsx`）

- sensors：`PointerSensor { activationConstraint: { distance: 5 } }`＋`TouchSensor { delay: 250, tolerance: 5 }`；`collisionDetection = pointerWithin`；`DragOverlay` 顯示被拖的卡（沿用 ProductionScheduler 的 `isOverlay` 寫法，避免原位置跟著捲動抖動）。
- draggable id：待排池卡 `pool:${cardId}`、擺放卡 `pl:${placementId}`；`data` 帶卡片物件。
- droppable id：`day:${date}`、`holding`、`pool`（整個左欄；擺放卡拖回＝`unplace`）。
- 拖曳開始時算「允許的欄」：不可排區塊 → 全部禁止；預排卡 → `date ≥ max(today, 預估可包日)`（`estReadyDate` 為 null 不限制）。不允許的欄 `useDroppable({ disabled: true })` 並顯示斜線底紋＋「預估 10/2 才可包」。伺服器仍會再驗一次（§3.8）。
- 拖放對應：

| 拖 → 放 | 操作 |
| --- | --- |
| 待排池卡 → 日期欄 | `place`（qty＝該卡剩餘量） |
| 待排池卡 → 待排區 | `place toDate:null` |
| 擺放卡 → 另一欄／待排區 | `move` |
| 擺放卡 → 待排池 | `unplace` |
| 已完成卡 | 不可拖（`useDraggable({ disabled })`） |

### 5.5 拆卡對話框（D7）

- 顯示原卡數量 Q（`BoardCard.qty`；被修剪過時同時顯示有效數量並提示「以儲存數量拆分」）。
- 預設拆 2 張（可加到 10 張），每列：數量、日期（預設同原卡，可選待排區）；即時顯示「合計 X／Q」，不等於 Q 時確定鍵 disabled；「平均分配」「剩餘全給最後一張」按鈕。
- 送出 `split`（新 id 前端產生）。
- 待排池卡的「排部分數量…」：數量（≤ 剩餘）＋日期 → `place`。

### 5.6 產能編輯（D49）

- **欄頭點擊** → popover：人數、正常工時（小時，至 19:00）、可加班工時上限；若是 `inherited` 顯示灰字「沿用 10/5」、`unset` 顯示「尚未設定」；「清除（回到沿用）」。
- **產能表對話框**：今天起 20 個工作日＋其間所有週六的表格，可一次改多列後「儲存」（一個 PUT）。週六列只有「開加班」開關＋加班工時＋人數；開啟後該週六出現在工作台（D51）。關閉有卡的週六會收到 `saturday_has_cards`，提示先移卡。
- 欄頭工時條：`已排 X / 正常 R（+加班 O）h`，條內三段（正常、加班、超出）；顏色依 `load`：一般、橘（超過正常）、紅（超過加班上限）；`unknownMinutesCards > 0` 時加「另有 k 張工時未知」。

### 5.7 版本面板（D33）

右側抽屜：清單（名稱、來源徽章：手動／AI 前／AI 後／還原前備份、時間、建立者、卡數、到期日）；上方「存成版本」（輸入名稱，預設「M/D HH:mm 手動存檔」）。每列「還原」→ 先 GET 預覽 → 確認對話框列出 `RestorePlan`（「將移除目前 N 張未完成的卡、寫入 M 張；其中 P 張日期已過會標延誤、K 張訂單已不在待排池會隱藏；已勾完成的卡不受影響；還原前會自動備份」）→ POST。唯讀模式隱藏「存成版本／還原」。

### 5.8 編輯鎖與唯讀模式（D30、D52、D53）

| 狀況 | 橫幅 | 可操作 |
| --- | --- | --- |
| 沒權限寫（packaging 唯讀） | 「唯讀檢視（每 60 秒自動更新）」 | 只能看、開訂單詳情 |
| 可寫、無人編輯 | 「目前沒有人在編輯」 [開始編輯] | 按下才取得鎖（**不自動取得**：Snow 等 admin 只是看也會佔住鎖） |
| 可寫、別人編輯中 | 「林主管 正在編輯中（最後動作 2 分鐘前）」 [接手編輯] | 接手前確認對話框「對方未儲存的操作會遺失」 |
| 自己持有 | 「你正在編輯 · 5 分鐘無動作會自動釋放」 [結束編輯] | 全部 |
| 被接手 | 紅色「已由 王主管 於 14:05 接手編輯，你已轉為唯讀」 | 同唯讀 |

`useEditLock`：持有時每 30 秒 `heartbeat`，`active` ＝ 這段期間有 pointerdown／keydown／拖曳；分頁隱藏時照送（`active=false`），5 分鐘後自然釋放；`pagehide` 送 `release`（sendBeacon）。剩 1 分鐘逾時時橫幅倒數「1 分鐘後自動釋放 [繼續編輯]」。

### 5.9 資料 hook（`useScheduleBoard`）

- 載入：`GET /api/packaging/board`（編輯者帶 `x-packaging-lock`）。
- 輪詢（D52）：每 `BOARD_POLL_MS` 帶 `rev`；`document.visibilityState === 'hidden'` 暫停，回到前景立即補抓；**操作佇列非空時不套用輪詢結果**（避免蓋掉樂觀更新），佇列清空後再抓一次。
- 操作佇列：一次只送一個請求（版本號才會連續）；送出前先用同一個 `applyOps` 在本機套用（樂觀更新，拖曳手感即時），成功後以回應 `rows`／`deletedIds` 校正；失敗依 §7.3 處理。
- 顯示「尚未儲存 N · 已儲存 HH:mm」；佇列非空時 `beforeunload` 提示。

---

## 六、D46／D47 待排池資料修正（改 P0 `classify.ts`／`pool.ts`）

> 這兩條在 P1 一併做，因為工作台直接吃待排池：ns 區塊的誤判卡（其實已上塔台並結案）若被排上日期，會永遠卡在工作台上。

### 6.1 D46：素材單／包裝單不列入

- 出單表 `doc_type` 實測值為 **`素材單/包裝單`**（2026-09-27 唯讀查詢：`rows @> [{"doc_type":"素材單/包裝單"}]` 命中 33 張出單表；單獨的「素材單」「包裝單」0 張）。判定用子字串以防日後改名：
  ```ts
  export const isNonScheduleDocType = (t: string | null | undefined) => /素材單|包裝單/.test(t ?? '')
  ```
- 套用點（`classify.ts` → `classifyPool` 尾段建 `sheetLines` 的迴圈）：`if (isNonScheduleDocType(r.doc_type)) { bump('sheet_non_schedule_doc'); continue }`。效果：
  - 不產生 ns 卡、不進 `staleUnsynced` 異常清單（D46「不算未上塔台」）；
  - 不刷新該 SO 行的「最新出單日」（包裝單晚發時不會把 30 天窗口重新起算）；
  - 同一 SO 行若另有正常出單列，照正常列判定。
- **不影響**：`sheetSampleSo`（打樣判定只看「打樣單」）、示意圖索引（包裝單的示意圖仍可在訂單詳情看到）、`unresolvedSheetMoRefs`（也要略過這類列，避免無謂補查）。
- `POOL_NOTES` 加一條：「出單表『素材單／包裝單』本來就不上塔台，不列入待排池與異常清單（D46）」。
- 延伸（延後細節）：包裝單會指向其中一張已發訂單 → 把說明掛到被指向那張卡上，**P1 不做**。

### 6.2 D47：製令號解碼判定「上過塔台」

**規則**（與原 session 驗證腳本 `keys_from_mo()` 一致，比對時以「SO 數字＋項次」為鍵，不分 SO／SOB 前綴）：

```ts
decodeSaraMo(mo, lot):
  m = normMo(mo)
  ① /^(MOT|MOS)(\d{9})(\d{2,3})(?:-|$)/          → soDigits = $2, line = String(Number($3))
     rule = 'mot' | 'mos'；soGuess = (MOT → 'SO' | MOS → 'SOB') + $2
     例：MOT26082502107 → (260825021, 7)；MOS26090250402-3MM-0915 → (260902504, 2)
  ② /^(SOB|SO|RO)(\d+)$/ 且 lot 有值              → soDigits = $2, line = String(Number(lot))，rule = 'legacy'
     例：RO25080441 + lot "3" → (25080441, 3)
  其餘（MOM 集單合併流水號、POC、MPO、SOA 格式 MOT260806-120202-73801…）→ null（寧可不判斷，同 lib/moLineMatch.ts）

soLineDigitsKey(so, line) = so 去掉開頭英文字母 + '|' + String(Number(line))     // line 無法解析 → null
decodedTowerKeys(rows) = { soLineDigitsKey(d.soDigits, d.line) | d = decodeSaraMo(r.mo_nbr, r.lot_nbr) ≠ null }
```

> 為什麼 ① 只接受 9 碼 SO：MOT 還有 SOA 訂單的長格式（`lib/moLineMatch.ts` 註解），那種格式的 SO 號無法從製令號還原；項次規則與 `moToSoLine` 對這類「9＋2 碼」一致。為什麼比數字不比前綴：驗證腳本就是這樣做（15/16 命中），SO（0xx 流水）與 SOB（5xx 流水）的 9 碼實務上不會撞號。

**資料來源**（`pool.ts` 新增一波，並把結果放進 `PoolRawData.saraDecodedMos: { mo_nbr, lot_nbr }[]`）：

| 查詢 | 條件 | 實測列數（9/27） |
| --- | --- | --- |
| `sara_wip_records` MOT／MOS | `mo_nbr like 'MO%'`，只取 `mo_nbr, lot_nbr`，分頁 | MOT 7,270＋MOS 249（＋少量 MOM）≈ 8 頁、並行 |
| `sara_wip_records` 舊式 | `mo_nbr in (候選 SO／RO 號)`，候選＝出單表中經既有規則仍判為「未上塔台」的 SO 行的 SO 號，每 100 個一塊 | 候選約 1,000 個 SO 以內 → ≤ 10 塊 |
| 已載入的 `lots ∪ schedule` | 直接解碼（未結案批） | — |

**套用點**（`classifyPool` 判定「已上塔台」處，ns 與異常清單共用）：

```ts
if (openLotLines.has(k) || refsOnSara([...e.refs], saraIdx) || lineOnSaraByPo(e.so, e.line, sl)
    || towerDigitKeys.has(soLineDigitsKey(e.so, e.line))) continue   // ← 新增：D47
```

效果：這些 SO 行視為「上過塔台」，交給 D43 範圍判定——批已結案（只剩 records）→ 其卡計入 `excluded.saraClosedOrAbsent`、不出 ns 卡、不進異常清單。**不**用解碼結果擴大 D43 範圍 (A)（未結案批的 SO 行本來就由 `doc_nbr／lot_nbr`、`so_line_no` 認得）。

**預期影響與限制**：原 session 以**塔台官方全量**報工 201,356 筆驗證：ns 16 張中 15 張已上塔台並結案；異常清單 955 行＝已結案 276＋包裝單／素材單 18＋查無 661。但 EIP 的 `sara_wip_records` 只有 **44,918 筆**（2026-07-01 起匯入，最早完工 2025-08），**不是全量** → EIP 內能解碼命中的會少於驗證結果，尤其 5~6 月的舊單。實作後要重跑 §十 的對照並把實際數字補進本節；要拿到全量需 D40（P3 伺服器端同步）或一次性補匯入塔台歷史報工（屬既有表寫入，**不在 P1 範圍**，需 Snow 另行決定）。

---

## 七、效能、輪詢與錯誤處理

### 7.1 待排池快取共用

- 把 `app/api/packaging/pool/route.ts` 的模組快取搬到 `lib/packaging/poolCache.ts`：
  ```ts
  export async function getPool(opts?: { fresh?: boolean; maxAgeMs?: number }): Promise<PoolOk>   // 預設 maxAgeMs = 120_000
  ```
  `/api/packaging/pool`、`/api/packaging/board`、所有寫入 API 共用同一份（同一個 Vercel 實例內），並保留「進行中的 Promise 共用」防雪崩。
- 寫入 API 用 `maxAgeMs = 10 分`：驗證只需要「這一行大概有多少可排量、預估可包日」，10 分鐘內的待排池足夠，換來拖曳不會碰到 3~6 秒冷啟動。冷實例仍可能慢，前端顯示「儲存中…」。
- D47 新增的 records 查詢約增加 1 秒冷啟動（8 頁並行＋候選 in 查詢）。

### 7.2 讀取量（一次 GET board，快取命中時）

| 查詢 | 量 |
| --- | --- |
| placements 未完成 | 數百列，1 頁 |
| placements 已完成（池內各行） | `in()` 每 100 行一塊，約 4 塊 |
| capacity | ≤ 400 列，1 頁 |
| 鎖、op_log max id | 各 1 |

組裝為 O(卡數＋擺放數)，毫秒級。所有列表查詢照 P0 慣例分頁（PostgREST 單次上限 1000 列）＋固定排序。

### 7.3 錯誤處理（前端）

| 錯誤 | 處理 |
| --- | --- |
| 網路錯誤／5xx | 操作留在佇列，指數退避重試 3 次（1s、3s、9s）；仍失敗顯示紅色「N 個操作未儲存 [重試] [放棄並重新載入]」 |
| `version_conflict`、`not_found`、`id_exists` | 丟棄該操作與其後佇列、重新載入工作台、toast 說明 |
| `partial: true` | 重新載入、清空 Undo／Redo、toast「部分操作未完成，已重新載入最新狀態」 |
| `lock_lost` | 轉唯讀、清佇列與 Undo、橫幅顯示接手者 |
| `lock_required`（逾時） | 顯示「編輯權已逾時釋放」[重新取得]；若沒人拿走，重新取得後可重送佇列（版本沒變就會成功） |
| 驗證錯誤（422） | 還原樂觀更新、toast 顯示伺服器訊息（例：「10/1 早於預估可包日 10/2」） |
| `pool_unavailable` | 保留樂觀更新前狀態、提示稍後再試 |
| GET 失敗 | 保留上一份資料，頂端黃條「資料更新失敗（HH:mm），顯示的是較舊資料」 |

伺服器端錯誤：完整內容（`describeError`）只寫伺服器 log；回應一律用 `publicDbError`（`lib/packaging/scheduleDb.ts`）給固定中文＋錯誤碼，例「資料庫存取失敗（23505），請稍後再試」，**不回 PostgREST 的 message／details／hint**（details 可能是 `Failing row contains (...)`，會帶出 email 等列內容；表名、constraint 名也不外露）。資料表不存在時訊息為「找不到資料表（PGRST205），請先套用 migration」，前端 `isMissingTableMessage` 靠這個字樣提示。`pool_unavailable` 同樣只回固定訊息。產能 PUT 的 op_log 只記正規化後的欄位，不寫原始請求 body。

---

## 八、檔案清單、實作順序與測試

### 8.1 新增

| 檔案 | 類型 |
| --- | --- |
| `lib/packaging/scheduleTypes.ts` | 型別契約（本次已建立） |
| `lib/packaging/scheduleCalendar.ts` | 純函式 §3.1 |
| `lib/packaging/scheduleCapacity.ts` | 純函式 §3.2 |
| `lib/packaging/scheduleAllocate.ts` | 純函式 §3.3／§3.4 |
| `lib/packaging/scheduleBoard.ts` | 純函式 §3.6 |
| `lib/packaging/scheduleOps.ts` | 純函式 §3.8 |
| `lib/packaging/scheduleUndo.ts` | 純函式 §3.8（`pushUndo`／`pushRedo`／`pushUndoKeepRedo`／`takeUndo`／`takeRedo`／`clearUndo`；`components/packaging/board/useUndo.ts` 目前仍自帶同規則的實作，待改為呼叫本檔） |
| `lib/packaging/scheduleLock.ts` | 純函式 §3.7 |
| `lib/packaging/scheduleSnapshot.ts` | 純函式 §3.9 |
| `lib/packaging/scheduleMap.ts` | 純函式：`rowToPlacement`、`placementToRow`、`rowToCapacity`、`lockRowToState` 的欄位轉換 |
| `lib/packaging/saraKeys.ts` | 純函式 §3.10／§六 |
| `lib/packaging/guard.ts` | `guardPackaging('read' \| 'write')` |
| `lib/packaging/poolCache.ts` | §7.1 |
| `lib/packaging/scheduleDb.ts` | I/O：讀擺放／產能／鎖、鎖 CAS、「先減後增」寫入、op_log、快照讀寫 |
| `app/api/packaging/board/route.ts` 等 7 支 route | §四 |
| 畫面 §5.1 各檔 | |
| `scripts/packaging-schedule-test.mjs` | node:test 單元測試 |
| `sql/20260927_packaging_schedule.sql` | migration（本次已建立，Snow 套用） |

### 8.2 修改（小改、不改卡片樣式）

`lib/packaging/classify.ts`（D46／D47）、`lib/packaging/pool.ts`（D47 查詢、`POOL_NOTES`）、`app/api/packaging/pool/route.ts`（改用 `poolCache`）、`components/packaging/PoolBlock.tsx`（`renderCard` 選用 prop）、`app/packaging/page.tsx`（開放子功能格）。

### 8.3 驗證方式（migration 未套用前）

- `npx tsc --noEmit`（全專案）與 `npm run lint`。
- 純函式單元測試：`node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/packaging-schedule-test.mjs`。注意現有 `ts-resolve.mjs` 只處理 `_quote_wt` 路徑的相對匯入 → 需把條件放寬為「專案 `lib/` 底下」（不處理 `@/`，所以純函式檔一律相對匯入）；strip-types 不支援 enum／namespace／參數屬性，純函式檔不可使用。
- **禁止**對正式站建表或寫入測試資料。需要 DB 的 API 只做型別檢查；migration 套用後再由 Snow 在本機實際操作驗收（D42「每期交付給 Snow 實際操作」）。
- D46／D47 屬唯讀，可在本機以正式站資料跑 `buildPackagingPool` 比對前後數字。

### 8.4 必測案例（節錄）

| 函式 | 案例 |
| --- | --- |
| `boardWindow` | 跨中秋＋週末＋教師節（9/24 起 3 天 → 9/24、9/29、9/30）；開加班週六插入但不佔名額；from 是假日 |
| `rollTarget`／`displayDateOf` | 今天週日 → 下週一；plan_date 為取消加班的週六 → 下一工作日＋offBoard；已完成的過去卡不順延 |
| `delayWorkdays` | 9/24 → 9/29 ＝ 1；週六 → 週日 ＝ 1（下限） |
| `resolveCapacity` | 當天有列；沿用較早平日（跳過週六列）；從沒填 → unset；週六未開 → 0；週六開 → 只有加班 |
| `dayLoad` | 等於正常工時 → ok；超過正常未超加班 → over_regular；週六有排 → over_regular；unset |
| `lineSupply`／`allocateLine` | §3.3 例；池減少從最早卡修剪；U 先扣可包片；守恆不變式；只剩 3／5c → not_placeable_now；est null → pre_unknown |
| `unreflectedCompletedQty` | §3.4 三個例子；completed_pool_qty 為 null |
| `applyOps` | place 超過剩餘 → qty_exceeds_remaining；split 合計不符；merge 不同行；已完成卡 move → completed_locked；D22 before_est_ready；同批 place＋complete；每個 op 的 inverse 套回去後狀態與原狀態相同（性質測試：隨機 op 序列 → apply → apply(inverse) = 原狀態） |
| `planLockAction` | 空鎖 acquire；別人有效持有 → held_by_other；逾時可 acquire；heartbeat active=false 不延長；takeover 記 prev；release 非持有者 noop |
| `pushUndo` | 第 51 格擠掉最舊；push 清空 redo |
| `planRestore` | 已完成列保留；新 id；pastDateCount、lineGoneCount |
| `decodeSaraMo` | MOT26082502107 → (260825021, 7)；MOS26090250402-3MM-0915 → (260902504, 2)；RO25080441＋lot 3；MOM2026061802 → null；MOT260806-120202-73801 → null；lot 空的舊式 → null |
| `isNonScheduleDocType` | 「素材單/包裝單」「包裝單」→ true；「打樣單」「急件/常平」→ false |

---

## 九、已知限制與待 Snow 確認

### 9.1 已知限制

1. **無交易**：多列寫入以「先減後增」＋每列 version 條件更新保護，中途失敗只會讓數量回到待排池（`partial`）；快照還原在刪除後、寫入前失敗會讓排程暫時清空（有自動備份版本可救）。
2. **編輯鎖驗證與寫入之間有毫秒空窗**，接手恰好發生時舊持有者的最後一筆會生效。
3. **待排池數量減少一律從最早的卡扣**：塔台報完工（最常見）正確；ERP 砍量／採購結案的情況會扣錯卡（總量仍正確），旗標文字保持中性。
4. **未反映完成量 U 的近似**：勾完成後訂單量又增加再被報工，會多扣（§3.4）。
5. **子卡最少 10 分鐘**：拆越多張，工時合計越偏高。
6. **一行多種來源的每件工時取加權平均**（例：常平換箱 0.2 與製令混在同一行時），子卡工時是近似值。
7. **週日與國定假日不能開加班欄**（D48 只定義週六）。
8. **寫入驗證用最多 10 分鐘前的待排池**；到貨／報工後 10 分鐘內，伺服器可能以舊的可排量拒絕或允許一筆操作，讀取時會再依最新資料修剪／標示。
9. **D47 只能用 EIP 內 4.5 萬筆塔台報工解碼**，不是全量（§6.2）；沒報過工就結案的批仍會被當成未上塔台（P0 §12.4 第 1 條不變）。
10. **現場裝置（D54）**：手機／平板只能看不能拖。
11. **同一持有者同時送出兩個寫入請求**（例如兩個分頁共用 token、或腳本並行）：兩者都以同一個前狀態通過守恆檢查，insert 沒有版本條件，可能超排（讀取時 `allocateLine` 會修剪掉超量，畫面不會顯示超排，但列會留著）。前端寫入佇列是逐筆送出，正常操作不會發生；要完全擋住需在鎖列加「寫入中」序列化，留待 P2。
12. **`/api/packaging/pool`（P0 待排池頁）仍用自己的模組快取**，未改用 `poolCache.ts`（§8.2 已列為要改，屬該 route 的修改）：同一實例會有兩份待排池、冷啟動各算一次，`fresh=1` 在該頁也沒有節流。

### 9.2 本規格的解讀（Snow 未明講，實作前請確認或事後修正）

1. 區塊 **5c 委外出貨待確認不可預排**（D22 只列了三種可預排來源）。
2. **「最近一次填的平日值」＝日期上最近的較早平日**，不是最後被編輯的那一列；請假造成的低值會被之後沒填的平日沿用（§3.2）。
3. **完成的卡留在當天變灰**（延後細節未定案；另有「隱藏已完成」切換）。
4. **勾完成時把延誤卡／待排區卡的日期改成今天**（記錄實際完成日）。
5. **ns 卡可排但一律視為預排、可包日未知**（虛線）。
6. **編輯鎖不自動取得**，要按「開始編輯」。
7. D16「不需包裝」、D28「需完整包裝」手動開關 P1 不做（不在 P1 決策清單；做的話需要以 SO 行為鍵的覆寫表＋工時重算）。
8. **move 允許移到過去日期（today − 400 天內，過去日期不驗 isBoardDay）**：給 Undo 把延誤卡移回原排定日。伺服器分不出請求是不是 Undo，所以持鎖主管手動送也會被接受，等於可以人為造出 D50 的「延誤 N 天」（只影響顯示，不影響數量守恆）。restore、uncomplete 的 prevPlanDate 同規則。若不接受：改為過去日期只能等於該列的 `original_date`（但「排 9/20 → 挪 9/22 → 今天挪走」的 Undo 會失敗），或改由 op_log 查最近一次的排定日。
9. **D7 守恆上限放寬為 `max(E, 本批開始前的 Σ)`**（見 §3.8 守恆檢查）：不違反 D7「加總等於原數量」，也不會讓超排更嚴重。

### 9.3 待問

1. ~~週日~~（D63 已定案：比照週六，見 §十一）／國定假日加班要不要能開欄？（目前國定假日一律不能，含落在週六、週日，例 10/10 國慶、10/25 光復節；若可以，放寬 `isHolidayWeekend` 相關檢查並改 §3.1、§9.1 第 7 條）
2. 平日產能要不要改成「平日預設值」＋單日覆寫（避免請假值被沿用）？
3. 要不要補匯入塔台歷史報工讓 D47 解碼完整（寫入既有表 `sara_wip_records`，需 Snow 另外決定）？
4. P0 §12.6 仍待確認的 4 題（`packagedDone` 保留與否等）照舊。

---

## 十、驗收重點（migration 套用後，Snow 在本機操作）

- 兩個帳號（一個 packaging_admin、一個 packaging）同時開工作台：唯讀者看不到拖曳與勾選；編輯者拖曳後唯讀者 60 秒內看到。
- 主管 A 編輯中，主管 B 按「接手編輯」→ A 在 30 秒內轉唯讀並看到「已由 B 接手」；A 放著 5 分鐘不動 → 鎖自動釋放、B 可直接「開始編輯」。
- 把 5b 一張 500 件的卡拖到後天 → 待排池該卡消失；拆成 300／200 分兩天 → 兩張子卡「拆 1/2、2/2」；合計不符無法送出；Undo 兩次回到原狀。
- 1 常平運送中的卡只能放在預估可包日當天或之後（之前的欄不能放）；把預排卡的日期留到到期 → 亮橘。
- 把卡排在昨天（以測試資料的 plan_date 模擬）→ 今天欄出現「延誤 N 天」並計入今天工時；拖到明天 → 延誤標籤消失。
- 欄頭：填 6 人／42 小時／加班 12 小時，排到 45 小時 → 橘；排到 55 小時 → 紅；隔天沒填 → 灰字「沿用」。
- 開 10/3 週六加班 → 工作台出現週六欄；有卡時關閉 → 被擋。
- 存版本 → 改動 → 還原 → 預覽數字正確、已勾完成的卡不受影響、版本清單多一筆「還原前備份」。
- 勾完成委外卡 → 待排池不再出現該量；塔台報工的常平卡勾完成後，塔台再報工 → 不重複扣（§3.4）。
- 待排池 ns 區塊張數明顯下降（D47）、「素材單/包裝單」不再出現在異常清單（D46）；把實際數字補進 §6.2。
- 回傳 JSON 不得出現 `customer_vendor`、廠商名稱、`changping_ship_marks` 原文、採購手打備註、鎖 token（token 只出現在 acquire／takeover 給本人的回應）。

---

## 十一、D63～D65 產能修正（2026-09-27，Snow 試用 P1 後回饋）

> 權威：需求決策紀錄 D63（週日加班）、D64（產能「套用全部」）、D65（改填總時數）。取代 D48「週日未定義」、D49 的人數欄。

### 11.1 D63 週日加班＝比照週六

- 週六、週日統稱「週末」：只有「開加班」旗標＋**加班總時數**，正常總時數恆為 0；開了（且加班 > 0、不是國定假日）才出現在工作台。
- 程式：`scheduleCalendar.ts` 新增 `isWeekend`／`weekendName`／`isHolidayWeekend`／`openWeekendDaysOf`（取代 `isHolidaySaturday`／`openSaturdaysOf`）；`boardWindow`／`nextBoardDay`／`rollTarget`／`displayDateOf`（D50 順延）、`applyOps` 的合法日期、`validateCapacityInput`（週末不能有正常工時、關閉有卡的週末要先移卡）、前端 `boardView`（◀ ▶、`listViewDays`、`resolveViewDay`）與 `useOpenWeekends`（原 `useOpenSaturdays`）全部改用「開加班的週末日」集合（變數 `openWeekends`）。
- API 契約改名（前後端同一個 commit，型別在 `scheduleTypes.ts`）：`BoardDay.kind` `'saturday_ot'`→`'weekend_ot'`；`EffectiveCapacity.kind` `'saturday'`→`'weekend'`；`CapacitySource` `'saturday_default'`→`'weekend_default'`；錯誤碼 `saturday_has_cards`→`weekend_has_cards`；新增 `migration_required`。DB 欄 `is_saturday_open`／型別 `isSaturdayOpen` **名稱不改**，語意改為「週末開加班」。
- `GET /api/packaging/capacity` 的 `effective` 改列出區間內所有週六**與週日**（國定假日的週末也列出，產能表顯示「國定假日不能開加班」）。
- 國定假日落在週末：**不能開加班、不出現在工作台**（同既有週六規則；例 10/10 國慶日逢週六、10/25 光復節逢週日）。補行上班的週末本來就是工作日（115、116 年日曆沒有）。

### 11.2 Migration：`sql/20260927b_packaging_capacity_weekend.sql`

> **2026-09-27 分線輪更新**：這份 migration 從未套用，已刪除並**併入** `sql/20260927b_packaging_p1_extend.sql` 第 1 段（內容不變），同一份檔再加上分線、工時覆寫、手動加入的新表（見 `docs/design/2026-09-27-packaging-lines.md` §一、§九）。下面描述的 constraint 規則照舊有效；`app/api/packaging/capacity/route.ts` 的 `migration_required` 訊息內的檔名由實作輪改為新檔名。

- 只替換 `packaging_daily_capacity` 的 check constraint（交易內、冪等、不動資料）：刪 `packaging_daily_capacity_no_sunday`；`..._saturday_overtime_only`→`..._weekend_overtime_only`（isodow 6、7 時 `regular_hours = 0`）；`..._open_only_saturday`→`..._open_only_weekend`（`is_saturday_open` 只能用在 isodow 6、7）；並以 `comment on column` 註明 `is_saturday_open` 語意＝週末開加班、`headcount` 不再使用。
- **套用順序：先套 migration，再開始使用週日加班。** 程式可以先部署——沒套之前週六照常；若有人儲存週日加班，DB 用舊 constraint 拒絕整批 upsert（單一語句，沒有寫入任何一天），API 把 Postgres `23514` 轉成 409 `migration_required`「週日加班需要先套用資料庫更新…這次沒有儲存任何一天」，不是 500。
- 套用前請先備份（正式站無自動備份）；還原方式寫在 migration 檔頭。

### 11.3 D64 產能表「批次填寫 → 套用到全部平日」

- 產能表（CapacityEditor 表格模式、持有編輯鎖時）上方一列：正常總時數、加班總時數兩欄（空白＝該欄不變）＋「套用到全部平日」。
- 流程：按鈕 → **預覽**（表內將改變的格子加橘框、顯示「→ 新值」，並列出「幾個平日、幾格會變、幾天原本已設定會被覆蓋」）→「確認套用並儲存」→ 以既有 `PUT /api/packaging/capacity` 一次送出（20 個平日＋其他手動修改，在 1～60 筆限制內）。預覽中手動改表格或改批次值 → 預覽作廢。
- 套用對象＝表內的平日工作日（`isBulkFillTarget`：非週末、`isWorkday`）；**週六、週日不套用**（逐日決定），國定假日的平日本來就不在表內、純函式也再擋一次。
- 只填加班、但有平日從沒設定過正常總時數 → 擋下並提示一併填寫。
- 規則在 `lib/packaging/capacityForm.ts`（`planBulkFill`／`applyBulkFill`／`bulkFillRowsError`，連同表單 `toFormRow`／`formRowError`／`formRowToInput`），元件只負責顯示。

### 11.4 D65 改填總時數、拿掉人數

- 產能表、單日產能設定、日檢視卡片牆頂部、週／兩週欄頭：**不再輸入或顯示人數**；欄位名稱改為「正常總時數」「加班總時數」，並註明「由組長直接填寫當天總時數」（工讀生出席時數不一，人×時不準）。
- DB `headcount` 欄保留（不刪、不改）；新畫面送 `headcount: null`（`CapacityInput.headcount` 改為選填，舊客戶端送值仍照範圍驗證）。`EffectiveCapacity.headcount` 仍回傳舊資料，但畫面不用。
- 工時計算不變：正常／加班「總時數」就是原本的 `regular_hours`／`overtime_hours_max`（小時），進度條與 D51 顏色規則照舊。

### 11.5 測試

- 新增 `scratchpad/p1-cap2/p1-cap2.test.mjs`：週日開加班的工作台視窗（日／週／兩週）、◀ ▶、D50 順延目標與 offBoard、週末不能填正常工時、國定假日週末、applyOps 合法日期、assembleBoard 週日欄、批次填寫只影響平日、國定假日平日不被套用、20 筆在 PUT 限制內。
- 既有 `p1-logic`／`p1-cards`／`p1-views` 隨改名調整（`openWeekendDaysOf`、`weekend_ot`、`weekend_default`、`weekend_has_cards`、`weekend` 旗標）；語意改變的只有「週日填產能」由 `date_not_workday` 改為「週日有正常工時 → `bad_request`、只填加班 → ok」，以及進度條提示「週六加班上限」改為「週末加班上限」。
