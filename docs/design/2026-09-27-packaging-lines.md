# 包裝專區 P1 擴充：分線、時間尺、工時覆寫、手動加入（技術規格）

規格書 · 2026-09-27 · 分支 `feat/packaging-schedule`（基礎＝`c6b6097`＋工作目錄內未 commit 的「產能表 v2」D63～D65）· 依據 `包裝排程計畫/需求決策紀錄.md` **D66～D72**

> 本文件只描述「在 P1 工作台之上」這一輪要加的東西；P1 本體見 `docs/design/2026-09-27-packaging-schedule-p1.md`（下稱 **p1.md**，§十一為 D63～D65）。
> 需求以決策紀錄為唯一權威；本文件標「**解讀**」的地方是 Snow 未明講、由規格自行決定，集中列在 §十一 待確認。
> 型別契約：`lib/packaging/scheduleTypes.ts`（本輪已更新，實作者照它 import，不另定義同名型別）。
> Migration：`sql/20260927b_packaging_p1_extend.sql`（**單一合併檔**，只寫成檔案，由 Snow 備份後手動套用；套用前新表／新欄位不存在）。原 `sql/20260927b_packaging_capacity_weekend.sql` 從未套用，已刪除並併入。
> 範圍提醒：本輪屬 P1 擴充，**不含** P2 AI 排程、P3 上線同步（`app/api/cron`、`vercel.json`、`lib/saraSync.ts` 由 P3 session 負責，本輪一律不碰）。

---

## 〇、範圍與對應決策

| 決策 | 本輪要做的事 | 取代／修正 |
| --- | --- | --- |
| D66 手動加入 | 待排池「＋加入訂單」：輸入單號 → 列出 ERP 全部品項行＋逐行「不在池內的原因」→ 勾選品項行、改數量、填原因 → 新區塊「手動加入」（`'mn'`），可正常排程 | 新增 |
| D67 A/B/C 產線 | 排程粒度由「日」改為「日 × 線」；產能表分線填 | 修正 D5 |
| D68 日檢視時間尺回歸 | 日檢視＝左側時間尺＋每條線一欄，卡片長度＝工時，沿時間往下疊；太短精簡顯示 | 取代 D62 卡片牆 |
| D69 主管改工時＋學習紀錄 | 拉卡片下緣或在詳情輸入改工時；每次修改寫一筆學習紀錄 | 新增 |
| D70 時間軸 00～24 | 模型＝一天 00:00～24:00，畫面顯示 10:00～24:00；正常 10～19、加班 19～24 | 修正 D55 起點 09:00 |
| D71 線別設定 | 預設 A/B/C、主管可加線與停用；總時數＝各線加總（唯讀） | 修正 D49／D65 的「每日一個總時數」 |
| D72 卡片必屬某線 | 排進日期的卡一定有線；週／兩週拖到日期欄頭 → 自動放到剩餘工時最多的線 | 新增 |

既有規則照舊、只是「帶上線別」：D5（→日×線）、D7 拆卡、D22 預排、D24 完成、D33 Undo／快照、D48／D63 週末加班、D49 沿用最近平日值（→**各線各自沿用**）、D50 順延、D53 編輯鎖、D56 三檢視、D58／D60／D61 簡化卡片與點擊詳情、D59 分隔線、D64 批次填寫、D65 總時數。

**硬限制（沿用 p1.md §〇，本輪再強調）**

1. 只寫 `packaging_*` 表；絕不寫既有表、不回寫塔台、不查 ARGO（D66 資料一律用 EIP 鏡像：`erp_so_lines`、`erp_pj_sync`、`po_line_tracking`、`sara_*`、`daily_order_sheets`）。
2. 瀏覽器不直接查表；API 用 `guardPackaging('read'|'write')`＋service role；寫入 API 需 `packaging_admin`＋持有編輯鎖＋`Content-Type: application/json`。
3. GET 不寫入（D50 順延、D7 修剪、D72 線別回退、D66 消失判定全部是「讀取時推導」）。
4. 不改 `components/packaging/PackagingCard.tsx`、`components/packaging/PoolBlock.tsx`（P0 待排池頁不受影響）。

---

## 一、資料模型

完整 DDL 見 `sql/20260927b_packaging_p1_extend.sql`。

| 表 | 異動 | 一列代表 |
| --- | --- | --- |
| `packaging_lines` | **新表** | 一條產線：`id smallint identity`、`code`（唯一，A/B/C…）、`name`、`sort_order`、`active`、稽核欄。種子 A/B/C＝id 1/2/3 |
| `packaging_line_capacity` | **新表** | 一天 × 一條線的產能：PK(`date`,`line_id`)、`regular_hours`、`overtime_hours_max`、`note`、稽核欄；週末 `regular_hours＝0` |
| `packaging_daily_capacity` | 保留、改語意 | 一天一列：**週末開加班旗標**（`is_saturday_open`）＋**相容用**的總時數（＝各線加總，由 API 同步寫入） |
| `packaging_placements` | 加欄 | `line_id`（排進日期時必填）、`est_minutes_override`、`minutes_override_by/by_name/at` |
| `packaging_time_adjustments` | **新表** | D69 一次改工時（學習紀錄，只增不改） |
| `packaging_manual_inclusions` | **新表** | D66 一個手動加入的 SO 品項行（移出＝軟刪除） |
| `packaging_op_log` | 放寬 check | `kind` 加 `'lines'`、`'manual'` |

四張新表 RLS 全開、只有 `service_role` policy，並 `revoke all ... from anon, authenticated`（含 identity／bigserial 序列）。

### 1.1 `packaging_lines`

- **為什麼有 id 又有 code**：`id` 是外鍵（產能、擺放都指向它），`code` 是人看的代碼。改名只改 `name`，`code` 建立後不改，匯出與日後 AI 提示詞都用 code，不會因改名錯亂。
- **線不能刪、只能停用**：擺放與產能列用 `on delete restrict` 指向它；停用後不出現在工作台、產能表、不計入總時數，歷史照樣查得到。
- 上限（API 擋）：含停用最多 `MAX_LINES＝12` 條、同時啟用最多 `MAX_ACTIVE_LINES＝6` 條（日檢視一欄至少 220px，6 條已是 1366 寬螢幕的極限）。
- 預設線（`defaultLineId`）＝啟用中 `sort_order` 最小（平手看 id）的線，種子下就是 A。用途：停用線上殘留卡的顯示位置、v1 快照還原、待排區卡直接勾完成時沒指定線。

### 1.2 `packaging_line_capacity`

- 一天 × 一線一列；沒填的不存列，由程式推導（§3.2）。
- **為什麼不把各線時數塞進 daily 表的 jsonb**：D49 的「沿用最近一次填的平日值」要**各線各自**沿用（B 線今天沒填、A 線有填 → B 沿用 B 自己上次的值），用正規化的列最直接；新增 D 線也不用改任何欄位。
- 回填：migration 把既有 `packaging_daily_capacity` 每一列（分線前填的總時數）複製成 **A 線**的列（只補「該日還沒有任何線列」的日期，重跑不重複）。2026-09-27 唯讀查詢：正式站 daily 表 1 列（9/29 正常 56h）→ 回填後 A 線 9/29＝56h，B／C 未設定。

### 1.3 `packaging_daily_capacity` 保留的理由與新語意

| 欄 | 分線後 |
| --- | --- |
| `is_saturday_open` | **仍是權威值**：週末開不開加班是「一天」一個決定，不分線（D63）。 |
| `regular_hours`、`overtime_hours_max` | **相容欄**：PUT 產能時由伺服器寫成「當天各啟用線有效值加總」（含沿用值）。新程式讀取一律以各線表為準，不讀這兩欄。 |
| `headcount` | D65 起不用（保留）。 |

保留並同步總時數的理由：Snow 的穩定測試站（`wt-packaging-stable`，舊程式、連同一個資料庫）只看 daily 表；同步寫入後它顯示的總時數仍正確。反過來舊程式存的產能不會進各線表 → **套用 migration 後請只用新版編輯產能**（§九）。

### 1.4 `packaging_placements` 新欄

| 欄 | 規則 |
| --- | --- |
| `line_id smallint references packaging_lines` | `plan_date` 非 null 時必填（check `packaging_placements_line_required`）。**DB 預設 1（A 線）**，migration 把既有所有 null 的列（含待排區）補成 1；新程式寫入待排區的卡也填 1（`PARKED_ROW_LINE_ID`，不寫 null）→ 每列都有 `line_id`，舊程式插入不帶此欄、或把待排區的卡 UPDATE 進日期／勾完成（只改 `plan_date`）都符合約束。讀取時「`plan_date` 為 null 就忽略 `line_id`」，待排區的卡語意上仍不屬於任何線。 |
| `est_minutes_override numeric(8,1)` | D69 主管覆寫的工時（分鐘），**以本列 `qty` 為準**；null＝用標準估計。範圍 (0, 6000]。 |
| `minutes_override_by/by_name/at` | 誰何時改的；`by`、`at` 與覆寫值同有同無（check `packaging_placements_minutes_override_meta`；`by_name` 可為 null）。 |

回填：既有排進日期的列（含已完成）全部 `line_id = 1`，之後才加約束。2026-09-27 唯讀查詢：正式站 6 列、皆有排定日、皆未完成 → 全數回填 A 線。

**為什麼覆寫存在擺放列上、不存以 SO 行為鍵的表**：D69 改的是「這張卡」的工時（例：今天這 300 件主管估 2 小時）；拆卡後每張子卡可能不同。存在列上可沿用 `version` 樂觀檢查、編輯鎖、Undo（`setMinutes` 是一般的 placements 操作）與快照。

### 1.5 `packaging_time_adjustments`（D69 學習紀錄）

欄位＝D69 要求的全部：品號、品名（前 80 字）、數量、PACKING、途程類型與工時來源（`work_source`、`work_explain`）、標準每件分鐘、標準工時、改前、改後、改後每件分鐘、是否清除、原因、方式（`drag`／`dialog`／`undo`）、排定日、線、誰、何時。

- `placement_id` **不設 FK**：擺放之後可能被合併、放回待排池、快照還原刪掉，學習紀錄要留著。
- 不存客戶名稱（學習用不到，減少個資）。
- 由伺服器在 `setMinutes` 寫入擺放成功後插入（不在 `applyOps` 純函式裡；見 §3.6）。

### 1.6 `packaging_manual_inclusions`（D66）

- 顆粒度＝SO 品項行（`so_line_key`，Snow 確認），`qty` 預設 ERP 訂單量可改，`route_type`（自製／常平／委外，估工時用），`reason` 選填，`added_*`、`removed_*`（軟刪除）、`updated_*`。
- 部分唯一索引：同一個 `so_line_key` 同時只能有一筆未移出的紀錄；移出後可再加入（新列）。
- **為什麼不把手動加入做成「擺放」**：手動加入的是「供給」（待排池的卡），不是「排定」。做成供給後，排定、拆卡、預排、完成、快照全部沿用既有路徑，不用寫特例。

### 1.7 單一合併 migration

`sql/20260927b_packaging_p1_extend.sql`＝原 20260927b（週末 constraint）＋本輪全部新表／新欄位／回填／約束／RLS／種子；整份包在一個交易；冪等；檔頭寫「套用前先備份」「需先已套用 20260927_packaging_schedule.sql」與還原步驟；檔尾附唯讀自我檢查 SQL。已用 PostgreSQL 官方 parser（`libpg-query`）驗過語法（61 個敘述）。

---

## 二、身分與關係速覽

```
packaging_lines (A,B,C,…) ──< packaging_line_capacity (date × line)
        │
        └──< packaging_placements.line_id   （plan_date 非 null 才有意義）
                    │ est_minutes_override ──> 每次 setMinutes 另寫 packaging_time_adjustments（無 FK）
packaging_manual_inclusions (so_line_key) ──> 讀取時組成待排池區塊 'mn' 的卡 ──> 供給給 placements（同一套 allocateLine）
packaging_daily_capacity (date)：週末開加班旗標＋相容總時數
```

---

## 三、規則演算法（純函式規格）

一律放 `lib/packaging/*.ts`，**不 import supabase、不讀時鐘**、相對路徑 import、不用 enum（`node --experimental-strip-types` 可測），前後端共用。

### 3.1 線別基本 — 新檔 `lib/packaging/scheduleLines.ts`

```ts
activeLinesOf(lines: readonly PackagingLine[]): PackagingLine[]          // active，依 sortOrder、id
defaultLineIdOf(lines: readonly PackagingLine[]): number | null          // activeLinesOf(lines)[0]?.id ?? null
resolveLaneId(lineId: number | null | undefined, planDate: YMD | null,
              lines: readonly PackagingLine[], defaultId: number | null): { laneId: number | null; fallback: boolean }
nextLineCode(lines: readonly PackagingLine[]): string | null            // 第一個沒用過的 A～Z；全用完 null
validateLineName(name: unknown): string | null                          // 1～LINE_NAME_MAX 字（trim 後）；錯誤回中文
pickAutoLane(...)                                                        // §3.4
laneRemaining(...)                                                       // §3.4
```

`resolveLaneId`：`planDate == null` → `{ laneId: null }`；`lineId` 指向啟用中的線 → 原樣；否則（null、停用、不存在）→ `{ laneId: defaultId, fallback: true }`（組裝時加 `line_inactive` 旗標「原屬 B 線（已停用），暫顯示在 A 線，請改排」）。

### 3.2 各線產能沿用與總時數（D49 分線、D71）— `lib/packaging/scheduleCapacity.ts`

```ts
resolveLineCapacity(date: YMD, lineId: number, rows: readonly LineCapacity[] /* 該線、date 升冪 */,
                    weekendOpen: boolean): EffectiveLineCapacity
resolveDayCapacity(date: YMD, input: {
  daily: readonly DailyCapacity[]            // date 升冪（取週末旗標、舊 headcount）
  lineRows: readonly LineCapacity[]          // 全部線、date 升冪
  lines: readonly PackagingLine[]
}): EffectiveCapacity                        // 含 lines[]、unsetLineCount
```

`resolveLineCapacity`（一條線）：

| 情況 | 結果 |
| --- | --- |
| 週末，當天沒開加班（`is_saturday_open` false、或國定假日的週末） | `regular 0、overtime 0、weekend_default` |
| 週末，已開加班，該線有列 | `regular 0、overtime＝該列×60、explicit` |
| 週末，已開加班，該線沒列 | `regular 0、overtime 0、weekend_default`（週末不沿用，D49） |
| 平日，該線當天有列 | `explicit` |
| 平日，該線當天沒列 | 該線「日期上最近的較早平日列」→ `inherited`（`inheritedFrom`） |
| 平日，該線之前從沒填過 | `unset`（regular null、overtime 0） |

`resolveDayCapacity`（一天，D71 總時數＝各線加總，只算**啟用中**的線）：

- `regularMinutes`＝全部啟用線都 `unset` → `null`；否則 Σ(`regular ?? 0`)。`overtimeMinutes`＝Σ。
- `source`：週末 → 當天開加班且 Σ加班 > 0 為 `explicit`，否則 `weekend_default`；平日 → 任一線 `explicit` 為 `explicit`，否則任一線 `inherited` 為 `inherited`（`inheritedFrom`＝各線中最晚的那天），否則 `unset`。
- `unsetLineCount`＝平日中 `unset` 的啟用線數（畫面提示「B 線尚未設定」）。
- `headcount`：沿用 daily 列（畫面不用）。

`openWeekendDaysOf`（`scheduleCalendar.ts`）改簽名：`openWeekendDaysOf(daily, lineRows?, activeLineIds?)`——給了 `lineRows` 時「開加班」＝`is_saturday_open` 且**啟用線當天加班列加總 > 0** 且非國定假日；沒給時沿用舊規則（daily 列的 `overtime_hours_max > 0`）。

`dayLoad`（D51 顏色）參數放寬為 `Pick<EffectiveCapacity, 'regularMinutes' | 'overtimeMinutes'>`，每條線（lane）與整天各算一次。整天可能 ok、但某條線已爆 → 畫面以**線**的顏色為主（§五）。

**產能輸入驗證** `validateCapacityDayInput(input, ctx)`（取代 `validateCapacityInput`；舊函式保留給沒帶 `lines` 的舊請求回 `bad_request`）：

- 日期規則同 p1.md §3.2＋§11（today−30～today+120、國定假日平日不能填、國定假日週末不能開）。
- 必須帶 `lines`（非 `clear`）；`lineId` 不可重複；非 `clear` 的線須存在且啟用（否則 `line_invalid`）；`clear` 可針對任何存在的線。
- 各線時數 0～5000、最多 2 位小數；週末各線 `regularHours` 必須 0。
- 寫入後當天各線合計（含沿用值；正常、加班分開計）也不可超過 5000（daily 相容欄的 check 上限）；在任何寫入之前擋下（`bad_request`），避免「各線已寫、daily 失敗」。
- 週末開加班 → 「本次輸入與既有列合併後，啟用線加班加總 > 0」。
- **關閉週末**（`clear`、`isSaturdayOpen=false`、或合併後加總 0）而該日還有未完成的卡 → `weekend_has_cards`（附張數），同 p1.md。
- 單線加班降到 0 而那條線當天有卡：**允許**（只是那條線變紅超載，§3.7），不擋。

**PUT 寫入**（`app/api/packaging/capacity/route.ts`）：逐日驗證 → upsert 非 clear 的線列、delete clear 的線列 → 以寫入後資料重算當天各啟用線有效值 → upsert daily 列（`regular_hours／overtime_hours_max＝加總`、`is_saturday_open`、`headcount: null`）；`{ date, clear: true }` 刪該日 daily 列與全部線列。**多列無交易**：順序「先線列、後 daily」，daily 只是相容欄，中途失敗不影響新程式判讀（週末旗標除外——旗標在 daily，開週末時順序改為「先線列、後旗標」，關週末時「先旗標、後線列」，任何中途失敗都偏向「沒開」，不會出現沒有產能卻開著的週末）。

### 3.3 線別停用

- **停用前該線不能有「未完成、已排進日期」的卡**（不分日期；過去日期的延誤卡會順延到今天，也算）→ `line_has_cards`（409，附 `cardCount`）。畫面提示「B 線還有 N 張卡，請先移到其他線」。
  - 理由：停用後自動把卡搬到別條線會悄悄改掉主管的安排，而且不在 Undo 裡；擋下來讓主管自己搬最清楚。
- 已完成的卡不擋（歷史紀錄，停用後照樣顯示在…見下）。
- 不能停用最後一條啟用中的線（`last_active_line`）。
- **讀取時的防呆**（萬一有：停用與寫入的毫秒空窗、快照還原、舊程式寫入）：`resolveLaneId` 回退到預設線並加 `line_inactive` 旗標；已完成卡同樣回退到預設線顯示（灰色）。
- 停用線的產能列保留；重新啟用後原本填的值照舊生效（沿用規則照舊）。
- 停用不進 Undo（同產能、快照，p1.md §3.8）。

### 3.4 D72 自動選線 — `pickAutoLane`

```ts
laneRemaining(cap: EffectiveLineCapacity, usedMinutes: number): number | null
  // 平日：regularMinutes == null ? null : regularMinutes − used
  // 週末：overtimeMinutes − used
pickAutoLane(lanes: readonly { lineId: number; sortOrder: number; remainingMinutes: number | null }[],
             opts?: { deltaByLane?: ReadonlyMap<number, number> }): number | null
```

- 取 `remaining + delta` 最大的線；排序層級：有值且沒停工的線 ＞ `remaining == null`（該線 unset）＞ 停工的線（`stopped`＝`laneStopped(capacity)`：當天明確填 0 h，同 `laneScale` 的 nominal／zero）；平手依 `sortOrder`、再依 `lineId`；沒有任何線回 null。
  - 修正輪：停工的線原本會因「有值勝過 unset」被選中（例：A 超排剩 −60、B unset、C 填 0h → 選 C）。`stopped` 是選填欄位，前端 `autoLaneFor` 要傳 `stopped: laneStopped(l.capacity)` 才生效（UI (a) 範圍）。**待 Snow 確認**：「有值但已超排（剩餘 ≤ 0）的線」是否也該排在 unset 之後（目前仍優先於 unset）。
- **為什麼平日只看「正常工時剩餘」**：用「正常＋加班」剩餘會把卡放到一條正常已滿、只剩加班額度的線，等於在別線還有正常工時時就排加班。週末本來就只有加班額度。
- `deltaByLane`：同一天內從欄頭重新放下已在這天的卡時，把它自己的工時從原線加回（`+minutes`），避免「因為自己佔著所以跳到別線」。
- 使用點：
  1. 週／兩週把卡拖到**日期欄頭**（droppable `day:${date}`）；
  2. 日檢視拖到「前一天／後一天」放置區；
  3. 「移到日期…」「排部分數量…」對話框的線別預設「自動」；
  4. 伺服器不自動選線：`place`／`move` 排進日期而沒有可沿用的線 → `line_required`（前端一律送明確的 `lineId`，樂觀更新與伺服器結果才會一致）。唯一例外：待排區卡直接勾完成 `complete` 沒帶 `lineId` → 預設線。

### 3.5 守恆、順延、預排帶線別（D7、D50、D22）

- **守恆（D7）與分配（`allocateLine`）完全不看線**：線只是「同一天內放在哪一欄」，數量守恆以 SO 行為單位，照 p1.md §3.3。
- **順延（D50）**：延誤卡顯示在 `rollTarget(today)` 那天、**保留原線**（`laneId` 照 `line_id`），計入那條線當天的已排工時。不自動換線（D50「主管挪過的以主管安排為準」同精神）。
- **預排（D22）**：`before_est_ready` 等檢查只看日期，與線無關；預排卡照樣屬於某條線。
- **勾完成**：卡留在原線；待排區卡勾完成（`plan_date` 改 `rollTarget`）時用 `complete.lineId` 或預設線，反向操作 `uncomplete.prevLineId＝null`。
- **子卡序（`split`）**：照舊以 SO 行編號，不分線。

### 3.6 D69 工時覆寫 — 新檔 `lib/packaging/scheduleMinutes.ts`

```ts
stdMinutesFor(perUnit: number | null, qty: number): number | null                 // ＝minutesForQty（最少 10 分）
effectiveMinutes(p: { qty: number; effectiveQty: number; override: number | null; perUnit: number | null }): number | null
  // override != null → round1(override × effectiveQty / qty)（被修剪時等比縮小；effectiveQty = 0 → 0）
  // 否則 stdMinutesFor(perUnit, effectiveQty)
splitOverride(override: number | null, qty: number, keepQty: number, partQtys: number[]): { keep: number | null; parts: (number | null)[] }
  // null → 全 null；否則各張 round1(override × q / qty)，捨入差補到原卡；任一張 < MINUTES_OVERRIDE_MIN 時取 MIN
mergeOverride(target: { qty; override }, sources: { qty; override }[], perUnit: number | null): number | null
  // 全部 override 都是 null → null；否則 Σ(各張 override ?? stdMinutesFor(perUnit, 該張 qty))，上限 MINUTES_OVERRIDE_MAX
overrideFromEffective(newEffMinutes: number, qty: number, effectiveQty: number): number
  // 畫面上改的是「有效數量的工時」，存回以 qty 為準：round1(newEff × qty / effectiveQty)
snapMinutes(m: number, snap = MINUTES_SNAP): number                                 // 四捨五入到 5 分、下限 MINUTES_SNAP
isValidOverride(m: unknown): m is number                                            // (0, 6000]、最多 1 位小數、≥ MINUTES_OVERRIDE_MIN
buildAdjustment(input: {...}): Omit<TimeAdjustmentRow, 'id' | 'created_at'>        // 伺服器組學習紀錄用
```

**規則**

1. 覆寫的顆粒度＝擺放列（子卡），值以該列 `qty` 為準。畫面顯示的工時＝`effectiveMinutes`（`BoardCard.minutes`），同時帶 `minutesStd`（標準估計，依有效數量）與 `minutesOverride`（已等比換算）。
2. **拆卡**：原卡有覆寫 → 依數量比例分給原卡與各新卡（`splitOverride`）；沒有覆寫 → 全部沿用標準估計。理由：主管說「這 500 件要 5 小時」，拆成 300／200 各佔 3／2 小時最符合直覺。
3. **合併**：任一張有覆寫 → 合併後覆寫＝各張「有效覆寫或標準值」加總（`mergeOverride`）；都沒有 → 仍無覆寫。
4. **setQty**（只用於 Undo 合併）：可帶 `minutesOverride`（含 null）一併還原 target 原本的覆寫；合併的反向操作＝`[setQty(target, 原 qty, minutesOverride: 原覆寫), restore(各來源，row 帶 lineId／estMinutesOverride)]`。
5. **setMinutes 操作**（`PlacementOp`）：`{ op:'setMinutes', id, version, minutes: number | null, reason?, via? }`
   - 驗證：列存在、版本相符；`minutes` 為 null 或 `isValidOverride`（否則 `minutes_invalid`）；`reason` ≤ `ADJUST_REASON_MAX` 字。
   - **已完成的卡也可以改**（記下實際花的時間，學習價值最高）；未完成卡的其他限制不變。
   - 效果：`est_minutes_override`、`minutes_override_by/by_name/at`（null 時四欄全清）；version+1。
   - 反向操作：`setMinutes` 回原值、`via: 'undo'`、不帶 reason。
   - 與舊值相同（含都 null）→ 仍算成功但不寫學習紀錄（避免雜訊）。
6. **學習紀錄**：伺服器在 `writeApplied` 成功後，對本批每個 `setMinutes`（值有變）插入一列 `packaging_time_adjustments`：品號、品名、PACKING、途程、`work.source／explain` 取自該行待排池底卡（`BoardCard.card` 同一張），`qty`＝有效數量，`std_minutes`＝`stdMinutesFor(perUnit, effQty)`，`before/after`＝改前／改後的**有效**工時，`per_unit_after＝after ÷ qty`，`cleared`、`via`、`reason`、`plan_date`、`line_id`、actor。插入失敗只 `console.error`，回應 `adjustmentLogFailed: true`（工時已改成功，前端 toast「修改紀錄未存到」）。
   - 為什麼不先寫紀錄再改工時：先寫紀錄、後改失敗會留下「沒發生的修改」誤導學習；先改後記，失敗時至少畫面有提示。
7. Undo／Redo 產生的 `setMinutes`（`via: 'undo'`）照樣記一列，學習端要排除或抵銷時看 `via`。
8. 快照（D33）帶覆寫值（`PlacementSnapshotRow.estMinutesOverride`），還原時照寫（§八）。
9. 沒有工時資料的卡（`minutesStd = null`）也能覆寫：覆寫後 `minutes` 有值、不再算「工時未知」。

### 3.7 D68／D70 日檢視時間尺 — 新檔 `lib/packaging/laneTimeline.ts`（前端用，也可單測）

**座標**：鐘面一律用「從 00:00 起的分鐘」（D70 一天＝00:00～24:00 模型）。顯示區間 `[RULER_DISPLAY_START_HOUR, RULER_DISPLAY_END_HOUR]`＝10:00～24:00（可調，換算邏輯不變）。`px = (clock − displayStart×60) × DAY_RULER_PX_PER_HOUR / 60`。

```ts
laneScale(cap: Pick<EffectiveLineCapacity, 'kind' | 'regularMinutes' | 'overtimeMinutes'>): LaneScale
workToClock(workMin: number, s: LaneScale): number                 // 累計工時 → 鐘面分鐘
clockToWork(clockMin: number, s: LaneScale): number                // 反函數（拉下緣用）
layoutLane(cards: readonly { placementId: string; minutes: number | null }[], s: LaneScale, opts?: {
  pxPerHour?: number; displayStartHour?: number; minPx?: number; compactPx?: number
}): LaneCardLayout[]
resizeToMinutes(layout: LaneCardLayout, newBottomPx: number, s: LaneScale, opts?): number   // 新的有效工時（已吸附 5 分、≥ 5）
clockText(clockMin: number): string                                 // '13:30'；≥ 24:00 顯示 '24:00+'
```

**換算（每條線各自比例，D68）**

| 該線產能 | `LaneScale` |
| --- | --- |
| 平日 R > 0、O > 0 | 工時 [0, R] → 10:00～19:00；(R, R+O] → 19:00～24:00；超過 R+O 以加班段比例往下延伸（over，紅） |
| 平日 R > 0、O = 0 | [0, R] → 10:00～19:00；超過以正常段比例延伸（over） |
| 週末（或平日 R = 0）且 O > 0 | `allOvertime`：[0, O] → 10:00～19:00；超過延伸（over）。**解讀**：週末加班像一個白天班，排滿＝19:00（沿用 D55 實作的週末做法，起點改 10:00；待確認 §十一） |
| unset（從沒填） | `nominal / unset`：1 工時分鐘＝1 鐘面分鐘，從 10:00 起；線頭灰字「未設定產能」 |
| R = O = 0 | `nominal / zero`：同上比例，但有卡就整段標 over（紅），線頭「未排班（0 h）」 |

超過上限的延伸比例一律取 `min(最後一段比例, 1)`（修正輪）：產能很小的線超排時（例 R＝1h 排 6h＝9 倍、R＝0.1h 排 4h＝90 倍）日檢視不會被撐到數千～數萬 px（所有線共用同一個 bodyHeight）；超出段本來就標 over，位置只需大致正確。

例：A 線正常 27h（1620 分）、加班 10h（600 分）→ 正常段每 1 工時分鐘＝540/1620＝0.333 鐘面分鐘；一張 3h（180 分）的卡長度＝60 鐘面分鐘＝72px。B 線正常 9h → 同一張 3h 的卡＝180 鐘面分鐘＝216px。**同一個時刻在不同線代表的累計工時不同**，這是 D68「每條線各自換算」的本意（每條線都是「排滿＝19:00」）。

**`layoutLane`（卡片沿時間往下疊、長度＝工時）**

```
cursorWork = 0; prevBottomPx = 0
for card in cards（順序＝day.cards 依 laneId 篩出；D74 起為線內順序，見 §十三.2）:
  w = card.minutes ?? 0                                  // 工時未知 → 0，只佔最小高度
  naturalTop = px(workToClock(cursorWork)); naturalBottom = px(workToClock(cursorWork + w))
  top = max(naturalTop, prevBottomPx)                    // 被前一張的最小高度推下去 → shifted
  height = max(naturalBottom − naturalTop, minPx)        // LANE_CARD_MIN_PX = 28
  compact = height < compactPx                            // LANE_CARD_COMPACT_PX = 56：只顯示單號＋品名（D68）
  zone = w 未知 ? 'unknown' : 結束點 ≤ R ? 'regular' : ≤ R+O ? 'overtime' : 'over'（allOvertime 時 ≤ O 為 overtime）
  cursorWork += w; prevBottomPx = top + height
```

- 已完成的卡照樣佔位（計入已排工時，p1.md §3.4 變灰），「隱藏已完成」時**不**從累計中扣掉（位置不跳動），只是不畫；**解讀**，待確認。
- 欄高＝max(24:00 的 px, 最後一張卡底部)；超過 24:00 的區域畫紅色斜線底紋與「超出上限 X h」。
- 卡片「順序」決定位置、長度＝工時（仍不排時段，D5）。D74 起順序可由主管在日檢視上下拖曳調整；從別處拖進某條線＝放在該線最後（§十三.2）。

**拉卡片下緣改工時（D69）**

- 只有持有編輯鎖、未完成、非迷你卡（日檢視）才顯示下緣把手（6px）；已完成卡改工時走卡片詳情。
- 拖動中：預覽高度、浮動提示「工時 2.5 h（標準 2.0 h）· 約 14:30 結束」；`Esc` 取消。
- 放開：`newEff = resizeToMinutes(layout, newBottomPx, scale)`＝`clockToWork(新底部) − layout.workStart`，**以工時分鐘吸附 5 分**（`MINUTES_SNAP`；不是鐘面分鐘——每條線比例不同，吸附在存下來的量上才一致），下限 5 分。
  - `|newEff − minutesStd| < MINUTES_SNAP / 2` → 視為回到標準值，送 `minutes: null`（**解讀**）。
  - 否則送 `overrideFromEffective(newEff, qty, effectiveQty)`，`via: 'drag'`。
- 把手事件要 `stopPropagation`，不能觸發 dnd-kit 拖曳（拖曳監聽只掛在卡片本體）。

**D70 起點修正**：`lib/packaging/boardView.ts` 的 `RULER_START_HOUR 9 → 10`（負荷進度條的 09:00 刻度改 10:00；`rulerMode`／`loadBarScale` 換算不變）。

### 3.8 `applyOps` 變更（`lib/packaging/scheduleOps.ts`）

`OpsContext` 新增：

```ts
lines: ReadonlyMap<number, PackagingLine>     // 全部線（含停用）
defaultLineId: number | null
/** 以 SO 行查待排池底卡的每件分鐘（merge 算覆寫加總用）；沿用 supplyOf(key)?.perUnit 即可 */
```

| op | 本輪變更 | 反向操作 |
| --- | --- | --- |
| `place` | `toDate` 非 null：`lineId` 必填且為啟用線（`line_required`／`line_invalid`）；`toDate` null：寫 `lineId null` | `unplace`（不變） |
| `move` | `toDate` 非 null：`lineId` 省略＝沿用原線（原線無效或原本在待排區 → `line_required`）；給了須啟用；`toDate` null → `lineId null`。同日換線＝一般 move，但**不做 D22 預排檢查**（日期沒變；修正輪） | `move` 回原日期＋原線 |
| `split` | 各 part `lineId` 省略＝原卡的線（原卡在待排區而 part 排進日期 → 必填）；覆寫依 §3.6 規則 2 | `merge`；原卡有覆寫時再接 `setQty(原卡, 原 qty, minutesOverride: 原覆寫)` 精確還原（各張被補到下限 1 分時 merge 加總會變大；修正輪） |
| `merge` | target 保留自己的日期與線；覆寫依 §3.6 規則 3 | `setQty(target, 原 qty, minutesOverride: 原覆寫)`＋各來源 `restore` |
| `setQty` | 可帶 `minutesOverride` | `setQty` 回原值（含原覆寫） |
| `restore` | `row.lineId`：`planDate` 非 null 時須存在（停用線允許——Undo 要能還原到原線；讀取時回退顯示）；缺 → 預設線；`row.estMinutesOverride` 照寫 | `unplace` |
| `complete` | 待排區卡：`lineId` 或預設線；其餘不動線 | `uncomplete {prevPlanDate, prevQty, prevLineId}` |
| `uncomplete` | 帶 `prevLineId` 時一併還原 | `complete` |
| `setMinutes` | **新** §3.6 規則 5；`via:'undo'` 時可帶 `restoreMeta {by, byName, at}` 沿用原修改者 | `setMinutes` 回原值（`via:'undo'`；原本有覆寫時帶 `restoreMeta`＝原「誰何時改的」，卡片詳情不會顯示成按 Undo 的人；學習紀錄仍記實際操作者） |

- `parseOps`、`touchedKeys`（`setMinutes` 走 `ids`）、`rebaseVersions` 加 `setMinutes`（version+1 一類）。
- **前端 `components/packaging/board/boardLocal.ts` 的 `rebaseOpVersions` 沒有 default 分支**：不加 `case 'setMinutes'` 的話 Undo 會**悄悄丟掉**這個操作（UI (a) 必改，§五）。
- `Placement`／`PlacementRow` 映射（`scheduleMap.ts`）：`line_id ↔ lineId`（`plan_date` null 時一律回 `lineId: null`）、覆寫四欄 ↔ `minutesOverride`。`scheduleDb.ts` 的 `mutablePatch` 要加 `line_id`、覆寫四欄（否則 move／setMinutes 寫不進去）。

### 3.9 工作台組裝（`lib/packaging/scheduleBoard.ts`）

`assembleBoard` 輸入新增 `lines: PackagingLine[]`、`lineRows: LineCapacity[]`、`manual`（§六.4 組好的手動區塊已併進 `pool.blocks`，另給 `manualMeta: Record<soLineKey, ManualInclusionMeta>`）。

1. `defaultLineId = defaultLineIdOf(lines)`；每張擺放 `resolveLaneId` → `BoardCard.lineId`、`laneId`，回退時加 `line_inactive` 旗標（info）。
2. `BoardCard.minutes = effectiveMinutes(...)`、`minutesStd`、`minutesOverride`（等比換算後）、`manual`（該行有有效手動加入且卡片底卡是 `'mn'` 時）。
3. 每天：`capacity = resolveDayCapacity(...)`；`lanes`＝每條啟用線：`capacity = resolveLineCapacity`、`cardCount`、`usedMinutes`（含已完成、不含未知）、`openMinutes`、`unknownMinutesCards`、`load = dayLoad(used, laneCap)`、`remainingMinutes = laneRemaining`。
4. 整天 `usedMinutes`＝Σ lanes；`load` 用整天加總（相容），畫面以各線顏色為主。
5. 回應加 `lines`（全部，含停用）、`defaultLineId`。
6. `SCHEDULE_NOTES` 加兩條：「排進日期的卡一定屬於某條線；週／兩週拖到日期欄頭會自動放到當天正常工時剩餘最多的線（D72）」「卡片工時可由主管修改，每次修改都會記錄供日後校正（D69）」。
7. `boardRevision` 不變：線別、產能、手動加入的寫入都會寫 `op_log`（`kind` 'lines'／'capacity'／'manual'），`opLogMaxId` 會變；手動區塊併在 `pool.blocks` 裡，`poolDigest` 也會變。

---

## 四、API 契約

共同規則同 p1.md §四（`force-dynamic`、`no-store`、`publicDbError`、415／401／403／409／422）。新錯誤碼：`line_required`、`line_invalid`、`minutes_invalid`（422）；`line_has_cards`、`last_active_line`、`code_exists`、`manual_has_placements`、`already_manual`、`already_in_pool`（409）；`migration_required`（409：新表不存在，訊息「請先套用 sql/20260927b_packaging_p1_extend.sql」）。

### 4.1 `GET /api/packaging/board`

- 完整讀取多查：`packaging_lines`（全部）、`packaging_line_capacity`（`date ≥ today − 400 天`）、手動區塊（§六.4，有快取）。
- 回應：`lines`、`defaultLineId`、`days[].lanes`、`BoardCard.lineId／laneId／minutesStd／minutesOverride／manual`、`pool.cardMeta[*].manual`、`skipped.manualSoGone／manualBackInPool`。
- 新表不存在（migration 未套用）→ 回 `{ success:false, error:'…請先套用 sql/20260927b_packaging_p1_extend.sql' }`（沿用前端 `isMissingTableMessage` 的「找不到資料表」字樣）。**不做**「沒有線表時假裝只有一條線」的降級：placements 的 `line_id` 欄同樣不存在，降級只會讓寫入各自失敗，不如明確提示。

### 4.2 `POST /api/packaging/placements`、`POST /api/packaging/cards/complete`

- 請求形狀不變（`ops` 多了 `lineId`、`setMinutes`）；`/cards/complete` 仍只收 `complete／uncomplete／place`（place 須帶 `lineId`）。
- `handleApplyRequest` 多讀：線別（小表，可與鎖驗證並行）、手動區塊（併進 pool 再算 `supplyOf`）。
- 寫入後：本批有 `setMinutes` 的，插學習紀錄（§3.6 規則 6），回應可帶 `adjustmentLogFailed`。
- label 例：「改工時 SO260924020-1 2.0→2.5h」「移到 B 線 SO…」。

### 4.3 `GET / PUT /api/packaging/capacity`

- GET 回應加 `lines`（全部）、`lineRows`（區間內各線列）、`effective[].lines`／`unsetLineCount`。
- PUT：每列必須帶 `lines`（§3.2）；沒帶 → `bad_request`「產能表已改為分線填寫，請重新整理頁面」。驗證與寫入順序見 §3.2。
- `CapacityInput.regularHours／overtimeHoursMax` 仍是必填欄位（型別相容），新前端送各線加總，伺服器**忽略**並自己重算。
- 批次填寫（D64）仍是前端展開成逐日請求，一次 PUT 最多 60 天（每天含各線）。

### 4.4 `GET / POST / PATCH /api/packaging/lines`（新）

| 方法 | 權限 | 請求 → 回應 |
| --- | --- | --- |
| GET | read | → `LinesResponse { lines, defaultLineId }` |
| POST | admin＋鎖 | `LineCreateRequest { lockToken, name, code? }` → `LineMutationResponse`。`code` 省略＝`nextLineCode`；`code` 須 `^[A-Z0-9]{1,4}$`、不重複（`code_exists`）；總數 ≤ 12（`too_many_lines`）、啟用 ≤ 6（`too_many_active`）；`sort_order`＝目前最大＋10 |
| PATCH | admin＋鎖 | `LinePatchRequest { lockToken, id, name?, active?, sortOrder? }` → `LineMutationResponse`。停用規則 §3.3（`line_has_cards` 附 `cardCount`、`last_active_line`）；重新啟用檢查啟用上限 |

- 寫 `op_log`（`kind: 'lines'`）；不進 Undo。
- 停用檢查的 count：`packaging_placements where line_id = :id and completed_at is null and plan_date is not null`（有部分索引）。

### 4.5 `/api/packaging/manual`（新，§六）

| 方法 | 權限 | 請求 → 回應 |
| --- | --- | --- |
| `GET ?so=SO260924020` | read | → `ManualLookupResponse`（該 SO 全部品項行＋逐行原因）。`so` 白名單 `^(SO|SOB|RO)[A-Z0-9-]{4,30}$`（不分大小寫，轉大寫） |
| POST | admin＋鎖 | `ManualAddRequest { lockToken, items[1..50] }` → `ManualMutationResponse`（逐行驗證，不合格的放 `skipped`、其餘照常加入） |
| PATCH | admin＋鎖 | `ManualUpdateRequest { lockToken, soLineKey, qty?, routeType?, reason? }` → `ManualMutationResponse` |
| `POST /api/packaging/manual/remove` | admin＋鎖 | `ManualRemoveRequest { lockToken, soLineKey, reason? }` → `ManualMutationResponse` |

- 寫入後：清手動區塊快取（同一實例）、寫 `op_log`（`kind: 'manual'`）。不進 Undo（同產能：是「供給」的事實輸入；誤加可移出、誤移出可再加）。
- 為什麼移出用 POST 子路徑、不用 DELETE：與既有寫入 API 一致只收 JSON body（DELETE 帶 body 在部分代理會被丟），且移出是軟刪除。

### 4.6 `GET /api/packaging/adjustments?placementId=&itemCode=`（新，read）

- 回 `AdjustmentsResponse`：這張卡的修改歷程（新到舊，最多 100 筆）＋同品號歷史摘要（排除 `via='undo'`：筆數、`per_unit_after` 平均、最近 10 筆）。卡片詳情（UI (b)）用。
- 只回 `actorName`，不回 email。

### 4.7 `/api/packaging/versions`（D33）

- 建立：`buildSnapshot` 改產 **schemaVersion 2**（列多 `lineId`、`estMinutesOverride`）。
- 還原：`planRestore` 多吃 `lines`／`defaultLineId`：排進日期的列 `lineId` 缺（v1）、不存在或停用 → 改預設線，計入 `RestorePlan.lineRemappedCount`；預覽對話框多一行「K 張會改放到 A 線（原線已停用或舊版快照沒有線別）」。
- 已完成列不動（不變）。

### 4.8 `/api/packaging/lock`

不變。

---

## 五、畫面規格與分工（兩個 UI 代理）

### 5.0 實作順序與分工總表

1. **資料層（先行，一個代理）**：型別（本輪已完成）→ 純函式 → I/O 與 API。完成後 `npx tsc --noEmit` 綠燈，UI 代理才開工（或並行時 UI 先以型別契約寫、最後整合編譯）。
2. **UI (a) 工作台分線檢視** 與 **UI (b) 產能／線別／手動加入／工時詳情** 並行，**兩者不得改同一檔**。

| 負責 | 檔案 |
| --- | --- |
| 資料層 | `lib/packaging/types.ts`（`PoolBlockId` 加 `'mn'`、`POOL_BLOCK_META`、`POOL_BLOCK_ORDER` 開頭加 `'mn'`）、`components/packaging/poolStyles.ts`（`BLOCK_TONE.mn`、`POOL_WIDE_BLOCKS` 加 `'mn'`，編譯期防呆需要）、`lib/packaging/scheduleTypes.ts`（`PLACEABLE_BLOCKS` 加 `'mn'`）、新 `scheduleLines.ts`、`scheduleMinutes.ts`、`laneTimeline.ts`、`manualPool.ts`、`manualLookup.ts`、`manualDb.ts`、`manualCache.ts`；改 `scheduleCapacity.ts`、`scheduleCalendar.ts`、`scheduleOps.ts`、`scheduleBoard.ts`、`scheduleSnapshot.ts`、`scheduleMap.ts`、`scheduleDb.ts`、`scheduleWrite.ts`、`scheduleAllocate.ts`（`blockRank` 納入 'mn'）；API：`board`、`capacity`、`placements`（經 scheduleWrite）、`cards/complete`、`versions/**`、新 `lines`、`manual`、`manual/remove`、`adjustments`；單元測試 |
| UI (a) | `components/packaging/board/BoardLayout.tsx`、`DayCardWall.tsx`（改為不再使用或刪除）、**新** `DayLanesView.tsx`、`LaneColumn.tsx`、`TimeRuler.tsx`、`LaneCard.tsx`；`MultiDayView.tsx`、`CapacityBar.tsx`、`PlacementCard.tsx`、`cardParts.tsx`、`cardMenu.tsx`、`QtyDateDialog.tsx`、`SplitDialog.tsx`、`ParkingArea.tsx`、`useBoard.ts`、`boardLocal.ts`、`useUndo.ts`、`useOpenWeekends.ts`、`ViewSwitcher.tsx`、`lib/packaging/boardView.ts` |
| UI (b) | `components/packaging/board/CapacityEditor.tsx`、`lib/packaging/capacityForm.ts`、**新** `LinesManager.tsx`、`ManualAddDialog.tsx`、`MinutesEditor.tsx`、`MinutesHistory.tsx`；`CardDetailDialog.tsx`、`PoolSidebar.tsx`、`SimplePool.tsx`、`SimplePoolCard.tsx`、`boardApi.ts`、`VersionsPanel.tsx`（還原預覽多一行 `lineRemappedCount`） |
| 都不改 | `components/packaging/PackagingCard.tsx`、`PoolBlock.tsx`、`CardFace.tsx`、`Modal.tsx`、`LockBanner.tsx`、`useEditLock.ts`、`PaneResizer.tsx`、`app/packaging/**`、`app/api/cron`、`vercel.json`、`lib/saraSync.ts` |

`CardFace.tsx` 兩邊都會用、但都不改：手動標記、線名等新資訊由各自的外框元件加（(b) 在 `SimplePoolCard`，(a) 在 `LaneCard`／`PlacementCard`）。

### 5.1 (b) 提供給 (a) 引用的元件介面（**全部是選填新 prop，舊呼叫照樣編譯**）

```tsx
// components/packaging/board/CardDetailDialog.tsx（(b) 改）
export default function CardDetailDialog(props: {
  card: PackagingCard
  meta?: PoolCardMeta
  placement?: BoardCard | null
  today: string
  onClose: () => void
  onOpenOrder: (so: string) => void
  /** 分線：顯示「所屬線」用（BoardOk.lines） */
  lines?: PackagingLine[]
  /**
   * D69：排定卡的工時編輯（(a) 在 BoardLayout 傳入；待排池卡不傳）。
   * editable＝持有編輯鎖；onSubmit 的 minutes＝「以本列 qty 為準」的覆寫值（(b) 已用 overrideFromEffective 換算），null＝回到標準值。
   * (a) 收到後送 setMinutes（via 'dialog'），成功與否由 useBoard 的 toast 顯示；對話框送出後自行關閉。
   */
  minutesEdit?: {
    editable: boolean
    busy?: boolean
    onSubmit: (minutes: number | null, reason: string | null) => void
  } | null
}): JSX.Element

// components/packaging/board/CapacityEditor.tsx（(b) 改）
export default function CapacityEditor(props: {
  /** day 模式可指定 lineId：從日檢視某條線的線頭 ⚙ 打開時，該線欄位自動聚焦 */
  mode: { kind: 'day'; date: YMD; lineId?: number } | { kind: 'table' }
  today: YMD
  editable: boolean
  getLockToken: () => string | null
  onClose: () => void
  /** 產能或線別有任何儲存成功都呼叫（(a) 據此重新載入工作台） */
  onSaved: () => void
}): JSX.Element

// components/packaging/board/PoolSidebar.tsx（(b) 改）
export default function PoolSidebar(props: {
  /* …既有 props 不變… */
  /**
   * D66：傳了才顯示「＋加入訂單」與手動卡的「改數量／移出待排池」選單。
   * 對話框與 API 呼叫都在 (b) 內部完成；成功後呼叫 onChanged，(a) 重新載入工作台。
   */
  manual?: {
    editable: boolean
    /** 寫入佇列忙碌中（useBoard.pending > 0）時停用加入／移出，避免與拖曳交錯 */
    busy: boolean
    getLockToken: () => string | null
    today: YMD
    onChanged: () => void
  }
}): JSX.Element

// components/packaging/board/LinesManager.tsx（(b) 新；CapacityEditor 內「線別管理」按鈕開啟。(a) 若要在工具列開，照此 props）
export default function LinesManager(props: {
  editable: boolean
  getLockToken: () => string | null
  onClose: () => void
  /** 新增／改名／停用成功 */
  onChanged: () => void
}): JSX.Element
```

(a) 不提供元件給 (b)。(b) 不改 `BoardLayout`；(a) 不改上列 (b) 的檔案與 `boardApi.ts`（(a) 需要的寫入仍走既有 `postPlacements`）。

### 5.2 (a) 工作台分線檢視

**日檢視 `DayLanesView`（取代 D62 卡片牆）**

```
┌ ◀ 9/29（二） ▶   總計 已排 38.5 / 正常 45（+加班 15）h   [設定產能]                           ┐
│        │ A 線  已排 20/27h ▓▓▓▓░ ⚙ │ B 線  已排 12/9h ▓▓▓▓▓▓(橘) ⚙ │ C 線 未設定產能 ⚙         │
│ 10:00 ─┼──────────────────────────┼─────────────────────────────┼───────────────────────── │
│        │ ┌SO…-1 壓克力鑰匙圈 3.0h┐ │ ┌SO…-3 …┐                    │                           │
│ 12:00 ─┤ │ 客戶／數量／PACKING   │ │ │       │                    │                           │
│        │ └──────────────下緣把手┘ │ └───────┘                    │                           │
│ 19:00 ═╪══════════（正常/加班分界，每線各自換算）═══════════════════════════════════════════ │
│ 24:00 ─┴──────────────────────────┴─────────────── 超出上限 1.5h（紅斜線）                    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- 左側 `TimeRuler`：10:00～24:00 每小時一條線，19:00 粗線；10～19 底色一般、19～24 淡橘（D48／D70）。
- 每條啟用線一欄（`LaneColumn`，min-width 220px，線多時橫向捲動）：線頭＝線名、`CapacityBar`（該線）、「已排 X／正常 R（+加班 O）h」、unset 灰字、`⚙` → `CapacityEditor({ kind:'day', date, lineId })`。
- 卡片 `LaneCard`：以 `layoutLane` 絕對定位；內容沿用 `CardFace`（D58 7 項），`compact` 時只剩單號＋品名；左上角時間「10:40–13:40」（`shifted` 時淡色）；`zone` over 時右側紅條；`line_inactive` 旗標顯示角標。
- droppable：每條線 `lane:${date}:${lineId}`（放下＝排到／移到這條線）；「前一天／後一天」放置區保留（`day:${date}` → 自動選線）。
- 下緣把手改工時：§3.7；送 `setMinutes`（via 'drag'）。
- 卡片點擊＝詳情（傳 `minutesEdit`、`lines`）、點單號＝訂單詳情（D61 不變）。
- 頂部整天進度條保留（總計），刻度起點改 10:00。

**週／兩週 `MultiDayView`**

- 每天一欄，欄內再分「各線小欄」：週＝每線 min 150px（3 線＝450px／天）、兩週＝每線 min 64px（迷你卡）；整個區域 `overflow-x: auto`（D67「縮成週／兩週時單日的線顯示範圍要加寬」）。
- 欄頭（droppable `day:${date}`）：日期、整天負荷條、各線迷你負荷條；拖到欄頭 → `pickAutoLane(day.lanes, { deltaByLane })`。欄頭在拖曳中高亮並提示「放開＝自動放到 B 線（剩 3.5h）」。
- 小欄（droppable `lane:${date}:${lineId}`）：卡片由上往下排（不畫時間尺）。
- 點日期 → 跳日檢視（不變）。

**拖放解析（`BoardLayout.onDragEnd`）**

| over.id | 目的 |
| --- | --- |
| `lane:${date}:${lineId}` | toDate＝date、lineId＝該線 |
| `day:${date}` | toDate＝date、lineId＝`pickAutoLane`（排除被拖的卡自己，§3.4） |
| `holding` | toDate＝null、lineId＝null |
| `pool` | 擺放卡 → `unplace` |

同一天同一線放回原處＝不送操作。預排／不可排的禁止規則（`dropBlockedReason`）照舊只看日期。

**其他 (a) 項目**

- `QtyDateDialog`（排部分數量／移到日期）與 `SplitDialog`（各張）加「線」選擇：預設「自動（剩餘最多）」＝送出時用 `pickAutoLane` 算好的明確 lineId；拆卡預設「同原卡」。
- `cardMenu`：排定卡加「移到線 ▸ A／B／C」（同一天換線）、「調整工時…」（開詳情）。
- `useBoard`：`setMinutes(bc, minutes, reason, via)`；樂觀更新：`boardLocal.applyLocal` 新增 `setMinutes`、`place／move` 帶 `lineId`，`recomputeDay` 同時重算 `lanes`（`usedMinutes`、`load`、`remainingMinutes`、`cardCount`）。`rebaseOpVersions` 加 `setMinutes`。
- `BoardLayout` 傳 `PoolSidebar.manual`、`CardDetailDialog.minutesEdit／lines`、`CapacityEditor.mode.lineId`。
- `hideCompleted` 在日檢視：已完成卡不畫但仍佔工時（§3.7）。
- 寬度 < 1024px（不可拖）時日檢視改為各線上下堆疊、不畫時間尺。

### 5.3 (b) 產能、線別、手動加入、工時詳情

**產能表（`CapacityEditor` 表格模式）**

```
日期      │ A 正常 │ A 加班 │ B 正常 │ B 加班 │ C 正常 │ C 加班 ║ 合計正常 │ 合計加班 │ 備註
9/29（二）│  27   │   10  │   9   │   5   │ (沿用) │       ║  45（唯讀）│ 15（唯讀）│
10/3（六）│ [開加班] │   8  │  —   │   4   │  —    │   0   ║   0      │ 12       │
```

- 每日期一列；欄＝各啟用線「正常／加班」兩格＋**合計（唯讀，即時加總）**（D71）。沿用值灰字顯示並標「沿用 9/26」；unset 空白。
- 週末列：「開加班」開關（一天一個）＋各線只有加班格；國定假日週末停用。
- 批次填寫（D64）：選「全部線」或某一條線，填正常／加班 → 套用到表內全部平日（預覽與確認流程同 p1.md §11.3，改為以「日×線」為格）。純函式放 `capacityForm.ts`：`CapacityFormRow` 改為 `{ date, kind, weekendOpen, lines: Record<lineId, { regular, ot, source, inheritedFrom, explicit, clear }>, note, dirty }`，`planBulkFill(rows, values, lineIds)`、`applyBulkFill(...)`、`formRowToInput(row) → CapacityInput（帶 lines）`、`rowTotals(row)`。
- 單日模式（欄頭 ⚙）：同一列的精簡版；`mode.lineId` 聚焦該線。
- 「線別管理」按鈕 → `LinesManager`。

**線別管理（`LinesManager`）**：清單（代碼、名稱、排序 ↑↓、啟用開關）＋「新增一條線」（名稱必填、代碼自動）；停用失敗（`line_has_cards`）顯示「B 線還有 N 張卡，請先移到其他線」。

**手動加入（`PoolSidebar`＋`ManualAddDialog`）**

- 待排池頂端「＋加入訂單」（持有編輯鎖才可按）。
- 對話框：輸入單號 →「查詢」→ `GET /api/packaging/manual?so=` → 表格列出全部品項行：項次、品號、品名、PACKING、訂單量、交期、**狀態／原因**（多個原因以小標籤列出）、勾選框（`selectable` 才能勾）、數量（預設 `suggestedQty`）、途程類型（預設 `suggestedRouteType`）、原因（選填，全部勾選行共用一欄即可，也可逐行）。已在池內的行顯示所在區塊、已手動加入的行顯示「手動・誰・何時」。
- 送出 → `POST /api/packaging/manual` → 顯示結果（加入 N 行、略過 M 行與原因）→ `onChanged()`。
- 「手動加入」區塊（`'mn'`）在待排池最上面；卡片沿用 `SimplePoolCard`，外框角標「手動・王主管・9/27 14:05」；右鍵選單多「改手動加入數量…」「移出待排池」（有未完成排定卡時顯示後端訊息）。

**工時詳情（`CardDetailDialog`＋`MinutesEditor`＋`MinutesHistory`）**

- 排定卡詳情多「工時」段：標準估計 X h（`work.explain`）；目前 Y h（「主管改：王主管 9/27 14:05」或「標準」）；輸入框（小時，最多 2 位小數；內部換分鐘一位小數）＋原因（選填）＋「儲存」「回到標準值」。`minutesEdit.editable` 為 false 時唯讀。
- 「修改歷程」：`GET /api/packaging/adjustments?placementId=&itemCode=`，列出時間、誰、改前→改後、方式、原因；下方「同品號過去 N 次修改，改後平均每件 x 分（標準 y 分）」。
- 所屬線：`lines` 找名稱；`line_inactive` 時顯示說明。

---

## 六、D66 手動加入

### 6.1 查詢（`GET /api/packaging/manual?so=`）

I/O（新 `lib/packaging/manualDb.ts` `loadManualLookupData(sb, so)`，全部唯讀、單張 SO 的小查詢並行）：

| 資料 | 來源 |
| --- | --- |
| 該 SO 全部品項行 | `erp_so_lines where project_id = :so`（`SO_SELECT` 同 pool.ts）；查不到＝ERP 已結案（結案 SO 會被同步刪除）或單號錯 → `found: false` |
| 待排池現況 | `getPool()`（快取）中 `soLineKey` 以 `${so}-` 開頭的卡＋手動區塊 |
| 有效手動加入 | `packaging_manual_inclusions where so = :so and removed_at is null` |
| 出單表 | `daily_order_sheets`（近 365 天，jsonb 含這張 SO 的列；沿用 pool.ts `trimSheetRows`） |
| 塔台 | `sara_lot_progress where doc_nbr = :so`（未結案批）、`sara_wip_schedule`（這些批的包裝站工序狀態）、`sara_wip_records`（`mo_nbr like 'MOT' + SO 數字 + '%'`／`'MOS…%'`／`= :so`，只取 `mo_nbr, lot_nbr, job_name, status, workcenter_name`） |
| 採購 | `erp_pj_sync`（採購單、來源單＝這張 SO）：只在伺服器端用來判斷「有無來源」與建議途程類型（常平 C01510 → 常平、其他 → 委外），**廠商代碼與名稱不回前端** |

純函式（新 `lib/packaging/manualLookup.ts`）`explainManualLines(input): ManualLookupLine[]`，**重用** `classify.ts` 的 `isNonPhysicalLine`、`normDate`、`NOT_ON_SARA_WINDOW_DAYS`、`CHANGPING_VENDOR`，`saraKeys.ts` 的 `isNonScheduleDocType`、`decodeSaraMo`、`soLineDigitsKey`。

### 6.2 原因判定（依序檢查，可多個）

| 順序 | code | 條件 | 可勾選 |
| --- | --- | --- | --- |
| 1 | `in_pool` | 待排池正常區塊有這行的卡（列出區塊與數量） | 否（`already_in_pool`） |
| 2 | `manual_active` | 已有有效手動加入 | 否（改用「改數量」） |
| 3 | `non_physical` | D12 費用行 | 否 |
| 4 | `zero_qty` | 訂單量 ≤ 0 | 否 |
| 5 | `non_schedule_doc` | 出單表上這行只出現在「素材單／包裝單」（D46） | 是 |
| 6 | `tower_closed` | 塔台報工解碼（D47）或批號對到這行，但沒有未結案批（D43） | 是 |
| 7 | `packaged_done` | 未結案批的包裝站（非 QC）工序已報完工（D45） | 是 |
| 8 | `sheet_stale` | 出單日超過 30 天且塔台查無（D44） | 是 |
| 9 | `waiting_source` | 有採購或製令來源、但以上都不是（常平未寄且不緊張、委外未到交期、前站未開工…） | 是 |
| 10 | `unknown` | 以上皆非 | 是 |

- 判定只為了「讓主管看懂」，不影響加入後的行為（加入後一律進 `'mn'`）。
- **解讀**：塔台未結案批、但前站未開工的行歸在 `waiting_source`（P0 只列前站已開工，p1.md 不變）。

### 6.3 加入、改數量、移出

- **加入**（逐行驗證，不合格者進 `skipped`）：`soLineKey` 白名單（同 `isLineKey`）且屬於查到的 SO 行（伺服器重查 `erp_so_lines`，不信任前端）；不在待排池正常區塊（`already_in_pool`）；沒有有效手動加入（`already_manual`；DB 部分唯一索引兜底）；非費用行、訂單量 > 0（`not_selectable`）；`qty` > 0、最多 3 位小數（**可超過訂單量**——**解讀**：訂單量單位與包裝數量可能不同，例 SO 30 張 vs 2100 件，p0 已知問題；畫面超過時黃字提醒不擋）；`reason` ≤ 200 字；有效筆數 ≤ `MAX_ACTIVE_MANUAL`。
- **改數量**：新 `qty` 不得小於該行未完成擺放合計（`qty_below_placed`）——**解讀**：比照「待排池減少從最早卡修剪」會悄悄改掉已排的卡，手動輸入的量直接擋下比較清楚。
  - **D103（Snow 確認）**：手動加入的 `qty` 是**這筆訂單的總量（含已完成）**，不是剩餘量。例：手動 100、已完成 50，改成 50 → 總共 50、剩 0，卡片從待排池消失、進「已全數完成」清單；改成 80 → 剩 30。
  - 剩餘量（工作台 `cardMeta.remainingQty`／待排池頁 `remainingQty`／AI 可動量三處同一個算法）：沒有銷貨時＝`max(0, 總量 − 已完成 − 未完成擺放)`；有 D73 銷貨封頂時照舊封頂。實作：`manualCardOf` 在卡上帶 `manualTotalQty`＝`qty`，`lineSupply` 對「唯一可排卡是 `'mn'`」的行帶 `LineSupply.manualTotal`，`unreflectedCompletedQty` 把完成快照 B 封頂成 `min(B, 總量)`（p1.md §3.4）。非手動行不帶這兩個欄位，行為逐位不變。
  - 下限（`manualQtyFloorError`，PATCH 寫前檢查與寫後回讀共用；**數量有變就檢查**，含改高——只有 D103 前把數量當剩餘量改低過的舊資料會被擋，訊息說明最少要填多少）：
    - 總量 < 已完成 → `qty_below_completed`「已完成 X，總量不能少於 X」；
    - 總量 < 已完成＋未完成擺放 → `qty_below_placed`「已完成 X、已排出 P（未完成），總量不能少於 X+P；請先到排程工作台把排定卡拖回待排池」（已完成 0 時訊息與 D102 相同）；
    - 總量＝已完成（沒有未完成擺放）→ 允許。
    - 「已完成」＝這一行全部已勾完成擺放（含舊紀錄時期完成的，與 U 公式看的範圍相同）。
  - **加入（POST）不設下限**，但「已完成」同樣不分何時完成：加入前就有的完成量（這行還在正常區塊時完成的、或舊手動紀錄移出前完成的）**全數算進新總量**。
    與 D103 前**不同**：舊公式會把「最早完成時的池量 B0 − 總量 T」當成已反映而少扣；新公式 `B′＝min(B0, T)` 不會。只有 T ≥ B0 時新舊結果相同。
    例：正常區塊時期池 500、完成 200（B0＝500），行離開待排池後手動加入：填 100 → 舊版剩 100、新版剩 0（加入即「已全數完成」）；填 300 → 舊 300、新 100；填 500 → 兩者都 300。
    因此查詢（GET）各行帶 `completedQty`（已勾完成擺放合計，0 省略），加入對話框在數量欄下顯示「此行已完成 X（會算進總量）」，數量 ≤ X 時黃字提醒「加入後立刻算包完、不出卡；還要再包 N 請填 X＋N」（不擋，誤加可移出）。
    **待 Snow 確認**：加入前（正常區塊時期／舊紀錄）的完成量要不要算進總量；若不要，得改成「只算本筆紀錄加入後的完成」，U 公式與下限都要跟著改。
  - 工作台那一半的寫後回讀（`manualReconcile.ts`→`planManualReconcile` 第三參數）也改成「總量要蓋住已完成＋未完成」；已完成量取自寫入後的 `res.next`，不多查 DB。
  - 畫面：待排池頁改數量對話框欄位是「總量（含已完成）」，預警分兩段、與伺服器同條件；手動卡色條「手動量」改稱「總量」；工作台卡片詳情（`ManualInfo`）、移出對話框、查詢對話框的手動量都標「總量」。
  - 手動行的排定卡被修剪／扣完時（總量 < 已完成＋已排，例：D103 前把數量當剩餘量改低過的舊紀錄），旗標原因不再寫「塔台已報包裝完工」，改成「手動總量 T 少於已完成＋已排 F；要照排請到待排池頁把總量改到至少 F」（`scheduleBoard.manualShortfallWhy`；有部分銷貨時先寫「ARGO 已部分銷貨出貨」）；勾完成被擋的訊息同樣寫出 F。非手動行文字不變。
  - 已知限制（D103 前就有）：D73 部分銷貨且總量 > 訂單量時是比例封頂（可排＝總量 × 未出貨 ÷ 訂單量），改低總量過了下限仍可能修剪已排的卡（見 §十 第 11 條）。
- **移出**：該行在正常區塊沒有卡、且還有未完成擺放 → `manual_has_placements`（附張數，請先放回待排池）；已完成擺放不擋（留在當天欄，行不在池內後依 p1.md §2.4 計入 `lineGoneCompleted`）。
- 都寫 `op_log`（`kind: 'manual'`）。
- **紀錄的終點（修正輪）**：`manualRecordEnded(inc, placements, soLineExists)`（純函式，讀取時推導、不寫 DB）——`'done'`＝已完成擺放合計 ≥ 手動數量且沒有未完成擺放（`'mn'` 卡剩 0 已不出卡）；`'so_gone'`＝ERP 查無此行。
  - 加入時 `MAX_ACTIVE_MANUAL` 名額只算作用中的紀錄（`done`／`so_gone` 不佔位；只有可能超額時才多查 SO 行與擺放）。
  - 查詢 `GET ?so=` 對 `done` 的行回 `manualDone: true`，原因標籤改為「已手動加入且已全數完成…待排池已無此卡」。
  - `done` 的紀錄仍是有效紀錄：`POST /manual/remove` 可移出（沒有未完成擺放 → 不會被擋）。**畫面入口待 UI (b)**：`ManualAddDialog` 對 `state==='manual'` 的行直接提供「改數量／移出」（沿用 ManualEditDialog／ManualRemoveDialog），不再只靠待排池卡片右鍵。
  - **待 Snow 決定**：已全數完成的行要不要允許「再加一次」（目前仍回 `already_manual`；若允許，需決定新數量是「追加」還是「總量」——舊的已完成擺放會照樣扣新紀錄的量）。

### 6.4 待排池組裝：區塊 `'mn'`

- 新 `lib/packaging/manualPool.ts`（純函式）：

  ```ts
  buildManualBlock(input: {
    inclusions: ManualInclusion[]              // 有效（未移出）
    soLines: RawSoLine[]                       // 這些 SO 在 erp_so_lines 的行
    normalLineKeys: ReadonlySet<string>        // 正常區塊（含不可排的 3／5c）已有卡的 soLineKey
    estimate: WorkEstimator                    // 同 pool.ts：computeStdTime(input, tables).work
    today: YMD
  }): { block: PoolBlock; meta: Record<string /* soLineKey */, ManualInclusionMeta>; skipped: { soGone: number; backInPool: number } }
  mergeManualIntoPool(pool: PoolOk, block: PoolBlock): PoolOk   // 依 POOL_BLOCK_ORDER 插入 blocks（不改原物件）
  ```
- 每筆有效手動加入 → 一張卡：`cardId = ${soLineKey}#mn`、`block 'mn'`、`status 'ready'`、`statusLabel '手動加入'`（**不新增 `CardStatus`**，避免牽動不能改的 `PackagingCard.tsx`）、`qtyCard = qtyReady = qty`（**解讀**：主管手動加入＝可包，實線不預排）、`estReadyDate null`、客戶／品號／品名／PACKING／單位／交期取自 `erp_so_lines`、`work = estimate({ routeType, itemCode, itemName, packing, qty, cpShipNote: null })`、`sources []`、`sample` 依品名（`nameSaysSample`）、`flags` 依交期（`overdue`／`due_soon` 同 classify 規則）、`hasSketch false`（訂單詳情照樣可查示意圖）。
- `PLACEABLE_BLOCKS` 加 `'mn'`（排序最後：`blockRank` 只影響同一行多片段的分配順序，手動行只有一片）。
- I/O 與快取（新 `lib/packaging/manualCache.ts`）：`getManualBlock(pool, { maxAgeMs })`——讀有效手動加入（≤ 300 列）＋其 SO 的 `erp_so_lines`（每 100 個 SO 一塊）＋工時表（`loadStdTimeTables`，模組快取 10 分鐘）→ `buildManualBlock`；結果以「有效紀錄指紋（筆數＋最大 `updated_at`）＋ pool.generatedAt」為鍵快取 120 秒，寫入 API 成功後清掉。
- 使用點：`GET board`（組裝前 merge）、`handleApplyRequest`（`supplyOf`、`cards`）、`versions restore`（`poolLines`）、手動查詢（`in_pool` 判定用正常區塊，不含 'mn'）。
- `/api/packaging/pool`（P0 待排池頁）**不**加手動區塊（`PoolBlock.tsx` 不能改；P0 頁是唯讀總覽）。

### 6.5 消失條件（讀取時判斷，GET 不寫）

| 情況 | 效果 |
| --- | --- |
| 勾完成 | 手動供給永遠不會自己減少（同委外 5b）→ §3.4 的 U＝已完成量，剩餘＝qty − 已完成 − 已排；剩 0 → 待排池不再出卡；已完成排定卡留在當天欄變灰。紀錄仍有效（查詢顯示「手動加入（已全數完成）」） |
| 該 SO 行已不在 `erp_so_lines`（ERP 結案） | 不出卡，`skipped.manualSoGone`；該行擺放依 p1.md §2.4 略過（`lineGone*`）。紀錄保留，ERP 重開時自動回來 |
| 手動移出 | 紀錄 `removed_at` → 不出卡 |

### 6.6 與既有區塊重複

- 加入時已在正常區塊 → 擋（`already_in_pool`）。
- 加入後，該行**又進入**正常區塊（例：塔台重開、補上塔台）→ 不出手動卡（`skipped.manualBackInPool`），以正常區塊的供給為準，避免同一批貨算兩次；紀錄保留（正常區塊再次消失時手動卡自動回來）。已排的卡照樣有效（守恆以 SO 行計，供給換成正常區塊，數量差異依 §3.3 修剪）。
- 手動卡與正常卡**不會同時出現**，所以 `PlacementFlagCode 'manual_in_pool'` 只在「該行有有效手動紀錄但目前供給來自正常區塊」時加在排定卡上（info：「已回到正常區塊（手動加入紀錄保留）」）。

---

## 七、效能

| 項目 | 量 |
| --- | --- |
| 線別 | ≤ 12 列，每次 GET board／寫入各一個查詢（可與鎖驗證並行） |
| 各線產能 | `date ≥ today − 400` × 線數 ≤ 400 × 3～6 列，1～3 頁 |
| 手動區塊 | 有效紀錄 ≤ 300 列＋其 SO 的 `erp_so_lines`（通常 < 50 張 SO，1 塊）；120 秒快取，冷時多約 0.3～0.8 秒（工時表另有 10 分快取） |
| 回應大小 | `lanes` 只帶彙總（不重複卡片），每天多約 0.5KB；`BoardCard` 多 5 個小欄位 |
| 前端 | `layoutLane` O(卡數)；拉下緣時只重算該線 |
| 手動查詢 | 單張 SO 6～7 個小查詢並行，約 0.5～1 秒 |

---

## 八、快照（D33）與既有資料相容

- `buildSnapshot` 產 `schemaVersion: 2`，列多 `lineId`（待排區 null）、`estMinutesOverride`；`parseSnapshot` 收 1 與 2（1 的列視為 `lineId: null、estMinutesOverride: null`）。
- 還原：排進日期但 `lineId` 缺／不存在／停用 → 預設線（`lineRemappedCount`）。覆寫值照寫。
- 既有資料：migration 回填後所有排定卡屬 A 線、所有產能歸 A 線；**套用後第一次打開工作台，日檢視會看到全部卡都在 A 線、B／C 線「未設定產能」**，這是預期結果，主管在產能表補上 B／C 並把卡拖到各線即可。
- 已存在的 v1 版本快照（正式站目前 0 份）：照常可還原，全部落 A 線。
- `op_log` 舊紀錄不動。

---

## 九、相容、套用順序與驗證

**相容策略（型別）**：`scheduleTypes.ts` 對既有型別新增的欄位一律選填，現有程式在實作輪前仍可編譯（本輪已驗 `npx tsc --noEmit` 通過）。實作輪完成後伺服器一律帶齊，前端可當必有。`PoolBlockId` 的 `'mn'` 由資料層在實作輪加（會觸發 `POOL_BLOCK_META`、`POOL_BLOCK_ORDER`、`BLOCK_TONE`、`POOL_WIDE_BLOCKS` 的編譯期防呆，一起改）。

**套用順序**

1. Snow 備份 → 套用 `sql/20260927b_packaging_p1_extend.sql`（一個交易；失敗整份不生效）→ 跑檔尾自我檢查 (a)～(e)。
2. 再切到新版程式（本機 dev server）。**反過來（新程式先跑、未套 migration）**：工作台顯示「請先套用 sql/20260927b_packaging_p1_extend.sql」，不會寫壞資料。
3. 套用後舊版穩定站（3711）仍可讀寫排程（每列都有 `line_id`、預設 A；`plan_date` null 忽略 `line_id`；舊版排進日期的卡一律落在 A 線），但**不要再用舊版改產能**（只改 daily 表，新版看不到）。
4. **套用後第一步：先拆產能**。9/29 的 56h 是分線前的全廠總時數，會整筆回填到 A 線；依 D49 各線各自沿用，之後所有平日 A 線都沿用 56h、B／C 未設定。不先處理的話：A 線時間尺被壓成 56 工時對應 9 小時（約 145 分鐘以下的卡全被撐到最小高度 28px、層層標 shifted，看起來像壞掉），且拖到日期欄頭的卡一律進 A 線。→ 打開產能表，用「批次填寫」選全部線，從 9/29 起填好 A／B／C 各線正常／加班時數（覆蓋 A 線的 56h），再開始排卡與驗收日檢視。
5. `app/api/packaging/capacity/route.ts` 的 `migration_required` 訊息檔名改為新檔名（實作輪）。
6. migration 設計為**套用一次**：若主管已用新版把某天各線逐一清空（線列全刪、daily 列保留），重跑會把該日 daily 總時數再回填到 A 線。

**驗證（migration 未套用前）**：`npx tsc --noEmit`、`npm run lint`、純函式單元測試（`scratchpad` 下 node:test，用 `--experimental-strip-types`）。**禁止**對正式站寫入；需要 DB 的 API 只做型別檢查，migration 套用後由 Snow 本機實際操作驗收。`npm run build` 若因資源不足（1450）失敗，結束殘留建置程序後重跑；不要關 3711／3111。

---

## 十、已知限制

1. **無交易**：產能 PUT「先線列、後 daily」、學習紀錄在工時寫入之後，中途失敗的影響已設計成偏安全（週末偏「沒開」、紀錄失敗有提示），但不是原子。
2. **自動選線只看當下剩餘**：D72 是「放下那一刻」的選擇，之後別的卡移動不會重新分配（主管安排為準）。
3. **每條線各自換算時間尺**：同一條橫線在不同線代表不同的累計工時；跨線比對「誰先做完」要看線頭的已排／可用數字，不是看卡片高低。
4. ~~卡片位置由固定排序決定~~ → D74 已開放線內上下排序（§十三.2）；拖到別條線／別天仍一律放在該線最後，放下的 y 座標只在「同一條線內重排」時有意義。
5. **覆寫工時在被修剪時等比縮小**：待排池減少（塔台報工）時，主管改過的工時跟著數量等比例變小，可能與主管原意不同。
6. **手動卡一律視為可包（實線）**，沒有預估可包日；未到貨的東西也能被手動加入並排在今天。
7. **舊版穩定站改產能不會進各線表**（§九）。
8. **停用線要先移卡**：卡多時主管要逐張拖；未提供「整條線的卡一次移到另一條線」（可列入下一輪）。
9. **學習紀錄的標準工時取自當下的待排池底卡**；同一行多種來源時是加權平均（p1.md §9.1 第 6 條同源誤差）。
10. **`setMinutes.restoreMeta` 由前端原樣送回**（伺服器產生、前端保存在 Undo 堆疊）：只在 `via:'undo'` 時採用、有格式驗證，但持有編輯鎖的 packaging_admin 理論上可偽造卡片上顯示的「誰改的」。學習紀錄（`packaging_time_adjustments.actor_*`）一律記伺服器端的實際操作者，不受影響。
11. **手動改總量的下限只看「已完成＋未完成擺放」**（D103，§6.3）：D73 部分銷貨、且總量 > 訂單量（單位不同的單）時，`salesAlloc` 改用比例封頂（可排＝總量 × 未出貨 ÷ 訂單量），改低總量會把可排壓到比未完成擺放還少 → 過了下限，已排的卡仍被修剪（例：訂單量 60、已銷 19、已排 68，總量 100→75 → 可排 51.25、修剪 16.75）。D102 起就有（已完成 0 時新舊下限相同），不是 D103 回歸；要擋住得在 PATCH 用新總量重建卡片、跑 `allocateLine` 再比。沒有銷貨、或總量 ≤ 訂單量時，過了下限保證不修剪。

---

## 十一、待 Snow 確認（本規格的解讀）

1. **D70 起點**：正常段改為 10:00～19:00（決策紀錄已註「待確認非筆誤」）；若其實是 09:00，只改常數 `WORK_START_HOUR`／`RULER_DISPLAY_START_HOUR`。
2. **週末時間尺**：週末加班額度排滿＝19:00（10:00～19:00 對應加班上限），還是 10:00～24:00 整段對應？（沿用 p1 版面待決第 3 題）
3. **D72 剩餘工時的定義**：平日只看「正常工時剩餘」（避免在別線還有正常工時時就排加班），週末看加班剩餘。
4. **拉下緣回到接近標準值（±2.5 分內）自動清除覆寫**。
5. **隱藏已完成時，已完成卡仍佔時間尺位置**（位置不跳動）。
6. **停用線前要先把卡移走**（不自動搬）。
7. **手動加入的卡一律視為「可包」**（實線、不預排）。
8. **手動加入數量可以超過 ERP 訂單量**（只黃字提醒），**改數量不可低於已排量**。
9. **手動加入／移出不進 Undo**（同產能）；誤操作用「移出／再加入」。
10. **已完成的卡也可以改工時**（記實際花費時間）；拉下緣只給未完成卡，已完成走詳情。
11. **同品號學習摘要**排除 Undo 產生的紀錄。
12. **D103 手動總量的「已完成」不分何時完成**：加入前（這行在正常區塊時期、或舊手動紀錄移出前）勾完成的量也算進新紀錄的總量（§6.3；加入對話框會顯示並黃字提醒）。改數量「改高也檢查下限」；已全數完成清單不給改數量按鈕（按錯只能移出再加入）。

---

## 十二、必測案例（節錄）

| 函式 | 案例 |
| --- | --- |
| `resolveLineCapacity`／`resolveDayCapacity` | A 當天有列、B 沿用自己 3 天前的值、C 從沒填 → A explicit、B inherited、C unset，整天 regular＝A+B、`unsetLineCount 1`；A、B 都沒填 → 整天 inherited、`inheritedFrom`＝較晚者；全 unset → regular null；週末開加班、B 沒列 → B 0；停用線不計入；回填後結果與分線前相同 |
| `openWeekendDaysOf`（lineRows） | 旗標開但各線加班加總 0 → 不開；國定假日週末 → 不開 |
| `validateCapacityDayInput` | 沒帶 lines → bad_request；重複 lineId；停用線非 clear → line_invalid；週末某線正常 > 0；關週末有卡 → weekend_has_cards；只降一條線加班到 0 → ok |
| `pickAutoLane` | 最大剩餘；unset 排最後；平手看 sortOrder；`deltaByLane` 讓同日重放留在原線；全 unset → 第一條 |
| `resolveLaneId` | 待排區 → null；停用線 → 預設線＋fallback；線不存在 → 預設線 |
| `applyOps` | place 無 lineId → line_required；停用線 → line_invalid；move 省略 lineId 沿用；holding→日期省略 lineId → line_required；split part 沿用原線；setMinutes 範圍、null 清除、已完成卡可改；merge 覆寫加總與 Undo 精確還原；complete 待排區卡用 lineId／預設線，Undo 回 null；性質測試：隨機序列（含 setMinutes、換線）apply → apply(inverse) ＝原狀態 |
| `effectiveMinutes`／`splitOverride`／`mergeOverride` | 修剪時等比；拆 500→300/200 覆寫 300 分 → 180/120；捨入差補原卡；合併一有一無覆寫 |
| `laneScale`／`workToClock`／`clockToWork` | R=1620、O=600：0→10:00、1620→19:00、2220→24:00、超過延伸；週末 O=480：480→19:00；unset／zero nominal；`clockToWork(workToClock(w)) = w` |
| `layoutLane` | 長度＝工時；最小高度推擠 → shifted；compact 門檻；未知工時佔最小高度不前進；zone 判定 |
| `resizeToMinutes` | 吸附 5 分、下限 5；跨 19:00 分段換算；接近標準值 → null（由呼叫端判斷） |
| `buildSnapshot`／`parseSnapshot`／`planRestore` | v2 帶線與覆寫；v1 → 預設線、`lineRemappedCount`；停用線 → 預設線 |
| `explainManualLines` | 費用行不可勾；在池內顯示區塊；只在素材單/包裝單 → non_schedule_doc；D47 解碼命中已結案 → tower_closed；包裝站已報完工 → packaged_done；出單 31 天未上塔台 → sheet_stale；建議途程類型不外露廠商 |
| `buildManualBlock` | 正常區塊已有 → 不出卡（backInPool）；ERP 查無 → soGone；工時用 routeType 估；cardId `#mn` |
| `assembleBoard` | lanes 彙總與 day 加總一致；延誤卡保留原線；停用線卡回退預設線＋line_inactive；手動卡排定後待排池剩餘正確、勾完成後剩 0 不出卡 |

---

## 十三、D73 待排池排除已銷貨／D74 線內上下排序（2026-09-28）

依據 `包裝排程計畫/需求決策紀錄.md` **D73、D74**。Migration：`sql/20260928_packaging_sales_and_order.sql`（冪等、單一交易；前提＝已套用 20260927 與 20260927b；套用前先備份）。

### 13.1 D73 待排池排除已銷貨

**資料模型**

| 表 | 一列代表 | 欄位 |
| --- | --- | --- |
| `erp_so_sales`（新） | 一張 SO × 一個品號在 ARGO 的銷貨合計 | PK(`so`,`item_code`)、`sold_qty numeric(14,3)`（Σ QTY，QTY 空或 0 用 PRICE_QTY）、`last_sale_date`、`slip_count`（不重複銷貨單數）、`synced_at` |
| `erp_so_sales_sync`（新，單列 id＝1） | 同步狀態 | `last_incremental_at`、`last_full_at`、`last_ok_at`、`last_error`（中文摘要 ≤ 500 字）、`rows_upserted`、`updated_at` |

兩表 RLS 開、只有 `service_role` policy、`revoke all … from anon, authenticated`（同 20260927b 第 8 段）。

**同步（`lib/packaging/salesSync.ts`，server-only；ARGO 只讀）**

- 來源：ARGO `IV_INVENTORYIODETAIL`，`IO_TYPE='O'`、`IO_ACTION='SELL'`，欄 `SLIP_NO,IO_DATE,PDL_PJT_PROJECT_ID（來源 SO）,ISM_MBP_PART（品號）,QTY,PRICE_QTY`（同 argo-tool `sales_data.fetch_shipment_lines`）。
- **整張 SO 重算覆蓋**：ARGO 作廢銷貨單會連明細一起刪除 → 每次把一批 SO（≤ 60 張，Oracle 動態 WHERE 4000 字上限）的全部銷貨重新彙總（`aggregateSalesDetail`），先 upsert、再刪掉 ARGO 已不存在的（SO, 品號）；整張 SO 已無任何銷貨 → 刪掉該 SO 全部列（純函式 `planMirrorWrite`）。先寫後刪：中途失敗寧可留舊列，不讓已銷貨的卡跑回待排池。
- `mode=full`：`erp_so_lines` 全部 SO（2026-09-28 約 2,386 張＝40 批）。完整跑完（未分片）才清掉「已不在 `erp_so_lines`」（結案）SO 的鏡像列；`erp_so_lines` 讀到 0 列時不清（同步異常保護）。一次跑不完可用 `shard／shards` 分片。
- `mode=incremental`（預設 `days=3`）：ARGO 近 N 天（IO_DATE）有銷貨的 SO ∪ **鏡像裡** `last_sale_date` 在近 N 天的 SO（近期作廢的單在 ARGO 已查不到，要靠鏡像找回來重算）∩ 未結案 SO。較舊的作廢由每晚 full 補。
- ARGO 很慢（2026-09-28 實測 S_APIKEY 27 秒，另有整段無回應）：`argoQueryStrict`（`lib/argoQuery.ts` 新增）每次查詢有逾時（min(90 秒, 剩餘時間)），網路／逾時／5xx 最多試 3 次，整體預算 250 秒（route `maxDuration 300`），時間不夠的批略過並回 `partial`。
- **「查無資料」與「ARGO 回錯誤」一定分開**：回應必須有 `RESULT` 陣列（可為空），有 `ERROR`／`STATUS` 失敗／缺 `RESULT` 一律當錯誤——若把錯誤當成空結果，整批 SO 的鏡像會被清掉、已出貨的卡全部跑回待排池。
- SO 號拼進 Oracle `IN (…)` 前先過白名單 `^[A-Z0-9][A-Z0-9-]{2,39}$` 並把單引號加倍。
- 狀態：完整成功才寫 `last_ok_at` 與 `last_incremental_at`／`last_full_at`（分片的 full 不更新 `last_full_at`）；未完成寫 `last_error`。

**API `GET /api/packaging/sales-sync`**（`maxDuration 300`）

- 驗證二擇一：`Authorization: Bearer <CRON_SECRET>`（或 `<WEBHOOK_SECRET>`，比照 `app/api/cron/*`；以 sha256＋`timingSafeEqual` 比對）；或已登入且具 `packaging_admin`（手動觸發，不需編輯鎖，同一實例 60 秒一次）。同一實例同時只跑一個同步（`busy` 409）。
- 參數：`mode=full|incremental`、`days=1..31`、`shard`/`shards`（≤ 12）、`dry=1`（只查 ARGO 不寫，回前 50 列預覽）。
- 回應 `SalesSyncResponse`：`{ success, partial, errors[], mode, days, shard, shards, soCount, batches, batchesDone, argoRows, upserted, deleted, clearedSos, closedSosPurged, skippedBatches, elapsedMs }`；錯誤碼 `unauthorized`（401）、`bad_request`（400）、`busy`（409／429）、`migration_required`（409）、`argo_unconfigured`（503）、`argo_error`（502）、`db_error`（500）。
- GET 會寫入：Vercel Cron 只發 GET；寫的是 ARGO 鏡像、冪等，被跨站觸發也只是多同步一次。

**待排池套用（純函式 `lib/packaging/salesAlloc.ts`）**

1. `allocateSoldToLines(erp_so_lines, erp_so_sales)`：同一張 SO、同品號（不分大小寫）的行依項次由小到大扣，每行最多扣到自己的訂單量；超出全部訂單量（超額銷貨）算在最後一行。訂單量 ≤ 0 的行不分配。對不到任何行的銷貨（SO 上沒有這個品號）略過（`stats.sold_unmatched_rows`）。
2. `applySoldToCards(cards, byLine, reestimate)`（`classifyPool` 在 D43 範圍之後、拆卡標示之前呼叫；D66 手動區塊 `buildManualBlock` 同樣呼叫）：
   - 未出貨量 ≤ 0 → 整行不出卡，`excluded.soldOut`＋1（以 SO 品項行計；P0 頁尾「已全數銷貨」、工作台頁尾說明）。
   - 部分銷貨 → 該行卡片合計以**上限**封頂：卡片合計 ≤ 訂單量時上限＝`min(卡片合計, 未出貨量)`；卡片合計 > 訂單量（包裝數量與訂單單位不同，例 30 張 vs 2100 件）時＝`卡片合計 × 未出貨量 ÷ 訂單量`。超出的量先扣可包量（區塊 2／5b／4／4x／mn…，出貨的一定是已就緒的貨），再扣未就緒量（預估可包日最晚／未知的先扣）；扣到 0 的卡不出；該行剩下的卡加 `partial_sold`（warn）「部分已出貨 X/Y」；數量有變的卡用同一個估算器重算工時。
   - **為什麼封頂而不是相減**：待排池的數量可能已反映同一批貨（塔台已報包裝完工的量會先扣；採購只開了部分數量），相減會重複扣。
3. 與分配守恆的交互（§3.3／§3.4 不改）：供給 S 變小 → 未完成卡依既有規則從最早修剪（旗標說明改為「ARGO 已部分銷貨出貨，或塔台已報包裝完工」）；已勾完成的量 U＝`clamp(C − (B − S))` 自動變小（已完成又出貨的不會重複扣）；整行不出卡時擺放計入 `skipped.lineGone*`。
4. 鏡像表不存在（migration 未套用）或讀取失敗 → **不排除**、`notes` 最前面加說明（「銷貨同步尚未啟用」／「這次讀取失敗」）；表在但從沒成功同步過 → 照用已寫入的列（每張 SO 都是整張重算過的），另提示「尚未完整成功跑過一次」。
5. 新鮮度：`PoolFreshness.soSales`＝`last_ok_at`。P0 頁「資料更新」列「ARGO 銷貨」（超過 180 分鐘變橘）；工作台標題列「銷貨資料更新於 xx:xx」（超過 3 小時變橘；null 顯示「銷貨同步未啟用」）。
6. D66 手動查詢：新原因 `sold_out`（不可勾選；加入後也會被排除）。

**上線排程建議（P3 設定 vercel.json；時間為 UTC）**

| 路徑 | 建議 | 說明 |
| --- | --- | --- |
| `/api/packaging/sales-sync?mode=incremental&days=3` | `10,40 0-11 * * 1-6`（台北週一～六 08:10～19:40 每 30 分） | 白天出貨後 30 分內反映 |
| `/api/packaging/sales-sync?mode=full` | `40 18 * * *`（台北每天 02:40） | 抓較舊的作廢、清結案 SO；若 ARGO 太慢跑不完，改成 `&shards=2&shard=0`／`&shard=1` 兩個時段 |

**已知限制**：銷貨退回（銷退）不回補；同 SO 同品號多行時依項次分配，實際出的是哪一行 ARGO 銷貨明細看不出來；銷貨同步最多延遲一個排程週期（加上待排池快取 120 秒）；部分銷貨時扣的是「哪幾張卡」是推定（先扣可包量）。

### 13.2 D74 線內上下排序

**資料**：`packaging_placements.sort_index numeric(12,4)`（可 null；待排區一律 null）。只影響顯示順序，不影響數量守恆、分配、順延、預排。

**排序規則（伺服器 `assembleBoard`、前端樂觀更新共用 `lib/packaging/laneOrder.ts`）**

同一天同一條線內，由上往下：

1. 「固定排序群組」：`sort_index` 為 null 的卡，**以及延誤卡**（D50 順延到今天、主管還沒重排的卡；它的 `sort_index` 是原本那天的值，不採用），依既有固定排序（延誤天數多 → 預排到期 → 打樣 → 交期 → 建立時間）→ 延誤卡一定在最上面；
2. 其後是有 `sort_index` 的卡，由小到大（平手再用固定排序）。

`day.cards` 整天一起依此排序，依 `laneId` 篩出就是各線順序；週／兩週檢視顯示順序與日檢視一致；待排區只用固定排序。

**為什麼延誤卡不看 sort_index**：順延進來的卡帶著「原本那天」的順序值，和今天這條線的值比大小沒有意義（昨天的第 2 張會插在今天的第 2 張後面）；延誤＝該先處理的舊工作，釘在最上面最直覺。延誤卡被主管拖動時＝`move` 到它目前顯示的那天（解除延誤，同 D50「拖到任何一天即解除」）並帶指定位置的 `sortIndex`；別的卡不能插到延誤卡上面（插入點夾到延誤卡之後）。

**為什麼 null 放上面（與需求提示的「null 放後面」不同，Snow 請確認）**：需求要求「新排入的卡預設放在該線最後」。若 null 放最後，在「從沒調整過順序、全是 null」的線上，新卡（有 sort_index）反而會跑到所有舊卡上面；null 放上面時新卡一律在最後，調整過的線也一樣。舊資料（migration 前的卡、舊版穩定站新增的卡）都是 null → 維持原本固定排序、排在最上面。

**sort_index 的值**

- 新排入（`place` 排進日期、`move` 換到別的「天×線」、`split` 拆出的新卡、待排區卡 `complete`）＝`appendSortIndex(now)`＝2026-01-01 起的分鐘數（同批每張 +0.001），一定大於既有值 → 在該線最後。
- 顯示位置沒變的操作保留原值：同一天同一條線的 `move`（例：延誤卡移到它目前顯示的今天）、延誤卡勾完成、`merge` 的 target、`setQty`、`setMinutes`。移到待排區（`move toDate null`、`uncomplete` 回待排區）清成 null。
- 主管上下拖曳：該線其他（非延誤）卡都有值 → 只改被拖的那張＝前後兩張的中間值（第一張非延誤＝下一張 − 1、最下＝上一張 + 1）；還有 null 的卡或間距不夠（平手、< 0.0001）→ 非延誤卡依新順序重新編號 1、2、3…（只送值有變的卡）。被拖的是延誤卡 → 那一筆送 `move`（見上）。

**操作 `reorder`**（`PlacementOp`）：`{ op: 'reorder', id, version, sortIndex: number | null }`

- 只改 `sort_index`（version＋1）→ 必定同日同線、守恆不受影響；已完成的卡也可以（仍佔時間尺位置）；待排區的卡 → `bad_request`；超出 numeric(12,4) → `bad_request`。需編輯鎖（同 `/api/packaging/placements`）。
- 反向操作＝`reorder` 回原值（含 null）。一次拖曳可能送多個 reorder（重新編號），同一批送出＝一步 Undo；`parseOps`、`touchedKeys`（走 ids）、`rebaseVersions`、前端 `rebaseOpVersions` 都已納入。
- `move` 可帶 `sortIndex`（有帶含 null＝直接用）：`move` 的反向操作一律帶原 `sortIndex`，Undo「換線／換天」會回到原本的上下位置。

**畫面**：日檢視把排定卡拖回「它自己的那條線」＝重排：拖曳中追蹤游標 y，`laneDropPlan` 以卡片垂直中線算插入點（隱藏的已完成卡照樣佔位、不當插入點），`LaneColumn` 畫藍色插入線「放在這裡」；從待排池／別條線／別天拖進來畫在最後「放到最後」。放下送 `reorder`，Ctrl+Z 可還原。同線重排不改日期 → 不套 D22 日期限制（預排卡在自己的線也能重排）。卡片長度仍依工時（時間尺換算不變）。拉下緣改工時的把手 `stopPropagation`，不會觸發拖曳。延誤卡釘在最上面；拖動延誤卡＝排到今天（解除延誤）並放到指定位置。週／兩週不支援重排。一次最多送 `MAX_OPS_PER_REQUEST`（50）個 reorder，超過提示。

**快照（D33）**：`schemaVersion 3`（列多 `sortIndex`）；`parseSnapshot` 收 1／2／3（v1／v2 → null）；還原時改放預設線的列清成 null。

**Migration 未套用時**：讀取沒有這欄＝null；寫入遇到「找不到欄位 sort_index」（PGRST204／42703）→ 拿掉該欄重送一次（PostgREST 在欄位不存在時整個請求都不執行，重送安全），之後 60 秒內直接略過；只有 `reorder` 本身回「請先套用 sql/20260928…」。

**已知限制**：延誤卡釘在最上面，想把今天的新卡排到延誤卡上面，要先拖動延誤卡（會解除延誤）；拆卡拆出的新卡放在最後而不是原卡正下方；舊版穩定站新增的卡為 null（排最上面）。

---

## 十四、D104 主管結案／D105 每日通知信（2026-09-28）

依據 `需求決策紀錄.md` **D104**（＋Snow 補充 D107：不需編輯鎖、同時清模擬區）。Migration：`sql/20260928d_packaging_closures.sql`（冪等、單一交易；前提＝已依序套用 20260927 → 20260927b → 20260928 → 20260928b；套用前先備份）。
- **資料**：新表 `packaging_closures`（一列＝主管對「SO-項次」按結案：結案當下的品名／數量／交期／原區塊／已銷貨量快照、備註、誰何時；復原＝寫 `restored_*`，紀錄保留；部分唯一索引＝同一行同時只有一筆未復原）；`packaging_op_log.kind` 加 `'closure'`；RLS 只給 service_role。
- **待排池**：讀取層 `manualCache.getManualMergedPool` 併入手動區塊後套 `closures.applyClosuresToPool`——未復原的結案行在所有區塊（含 `'mn'`）不出卡、`excluded.closed` 以 SO 行計（待排池頁尾「主管已結案」）；每次讀都重查結案表（不吃待排池 120 秒快取，結案後下一次讀取就消失、寫入驗證立刻擋「行已不在待排池」）；結案表未建 → 不排除、notes 最前面說明。D66 查詢對已結案行標 `closed`、不可勾選；加入 API 略過（`not_selectable`）。
- **API** `POST /api/packaging/closures` `{ action: 'close' | 'restore', soLineKey, note? }`（packaging_admin；**不需編輯鎖**、只收 JSON）→ `{ success, closure, unplaced, simRemoved }`；close 同時以 id＋version 條件刪該行未完成排定卡（撞到重讀再刪一輪）、以 version CAS 從各人 `packaging_sim_sessions.placements` 移除該行（`locks.placementIds` 同步清；undo 堆疊不動）、記 op_log `closure`；不進 Undo。錯誤碼：`already_closed`（409）、`not_found`（404）、`pool_unavailable`、`migration_required`（409）、`db_error`。`GET ?from=&to=`（packaging 讀權；台北日、預設近 30 天、含已復原）→ `{ closures[] }`。
- **畫面**：工作台待排池卡與排定卡右鍵「結案（不再拉回待排池）」（`me.canEdit` 即可、不看鎖）→ `ClosureDialog` 確認（單號-項次、客戶、品名、數量、交期、原區塊、會放回的排定卡張數、備註）→ 成功後清 Undo（有放回時）、重新載入。**延後**：「已結案清單／復原」面板（先只有 GET／restore API）、D66 對話框已結案標示的樣式微調。
- **D105 每日通知信**（`app/api/cron/packaging-closure-email/route.ts`＋純函式 `lib/packaging/closureEmail.ts`；`vercel.json` cron `0 10 * * *`＝台北 18:00）：
  - **觸發**：GET／POST，`Authorization: Bearer <CRON_SECRET 或 WEBHOOK_SECRET>`（同 daily-machine-output-email）。參數 `dry=1`（或 POST `{ dry: true }`）＝組好內容回 `{ html, subject, counts, recipients, attachment }` 不寄、不寫 op_log、不檢查寄信變數；`date=YYYY-MM-DD` 指定台北日（預設今天）。
  - **資料**：`listClosures(date, date)` 取 closed_at 落在台北當日的結案列（含當日又復原的，信裡標「已於 … 復原」）；**當日 0 筆 → `{ success: true, skipped: true, reason: 'no_closures' }` 不寄**。本月（1 日～當日）結案列算累計（只計未復原）與原區塊分布。「結案後 ARGO 仍未銷貨」＝本月未復原結案列 ×（`loadSalesForSos` 只查這些 SO 的）`erp_so_sales`：同 SO＋品號（不分大小寫）的 `sold_qty` 累計 < `qty_at_close` 的列出（差額、現在已銷、結案時已銷、無銷貨紀錄標示；沒有品號的略過並計數）。同一 SO 同品號多行各自拿同一累計比（不做行別分配——通知信只是提醒，結案行常已被 ERP 結案／刪行、拿不到 erp_so_lines）。鏡像表未建／讀取失敗 → 信裡寫明「無法對照」；信尾標 `erp_so_sales_sync.last_ok_at`。
  - **信件**：HTML 繁中三段（①當日明細：單號-項次、客戶、品號／品名、結案時數量、交期、原區塊、誰、時間、備註 ②本月累計＋區塊分布 ③「請補銷貨或改交期」對照表）＋ Excel 附件 `包裝結案_<日期>.xlsx`（`xlsx` 套件 → base64 → Resend `attachments`；分頁「當日結案」「ARGO 未銷貨對照」）。
  - **收件人**：`app_settings` key `packaging_closure_email_recipients`（JSON 陣列或逗號分隔字串，唯讀查）；沒有或解析後為空 → `Snow@bardshoptw.com`。
  - **不重寄**：寄出後 `packaging_op_log` 記 kind `'closure'`、label `結案通知信已寄 <日期>`、ops `[{ action: 'email_sent', date, recipients, counts, resendId }]`；寄前以 kind＋label 查到就回 `skipped: 'already_sent'`。op_log 寫失敗只 log（信已寄出，同日再觸發會重寄一次）。
  - **前提（Vercel 正式站）**：環境變數 `RESEND_API_KEY`、`DAILY_MACHINE_OUTPUT_FROM`（沿用機台產出通知信的寄件人變數；專案沒有更通用的寄件人變數，不另設），未設 → 非 dry 觸發回 500「未設定寄信服務」不靜默；`CRON_SECRET` 已有。migration `sql/20260928d` 未套用 → 409 `migration_required`。只寫 `packaging_op_log`，其餘唯讀、不查 ARGO。

## 附：本輪（規格輪）產出

- `docs/design/2026-09-27-packaging-lines.md`（本文件）
- `sql/20260927b_packaging_p1_extend.sql`（單一合併 migration；刪除 `sql/20260927b_packaging_capacity_weekend.sql`）
- `lib/packaging/scheduleTypes.ts`（型別契約：線別、各線產能、lanes、PlacementOp `lineId`／`setMinutes`、Lines／Manual／Adjustments API、時間尺型別；既有型別新增欄位皆選填，`npx tsc --noEmit` 通過）
- `docs/design/2026-09-27-packaging-schedule-p1.md` §11.2 加註 migration 已併入新檔
