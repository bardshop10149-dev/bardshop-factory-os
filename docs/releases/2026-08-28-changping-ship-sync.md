# 常平訂單資料區 + 出貨燈自動同步(2026-08-28)

## 公告欄白話版

> **新功能:常平出貨自動回報**
> 常平那邊每天在「訂單工作表」把已出貨的訂單塗黃底、填出貨日。
> 現在系統每天早上 7 點會自動讀這張表:
> 1. 黃底訂單整理進新的「**常平訂單資料區**」(首頁新卡片),出貨日、運送方式一目了然
> 2. **採購專區的出貨燈自動亮起**,不用手動點
> 3. 出貨日資訊自動加進該筆採購明細的備註(原本打的備註不會被蓋掉)
> 有權限需求請找管理員在「團隊管理」勾選「常平訂單資料區」。

## 技術版

### 新增
- `app/changping-ship/page.tsx` — 常平訂單資料區(唯讀快照,搜尋/篩選)
- `app/api/changping-ship/list/route.ts` — 列表 API(guardPermission `changping_ship`)
- `app/api/changping-ship/import/route.ts` — 匯入 API(Bearer WEBHOOK_SECRET,
  供本機排程 `changping_ship_sync.py` 呼叫;支援 dry_run / only_po)
- `sql/20260828_changping_ship_marks.sql` — 快照表(service_role only)
- 首頁新卡片(amber,order-15)+ 團隊管理權限鍵 `changping_ship`

### 資料流
```
釘釘 團隊文件/訂單工作表(space 26471226558)
  → 本機排程 ChangpingShipSync 07:00(changping_ship_sync.py,storage API 下載)
  → 掃「NNN年生產訂單」分頁黃底列(排除表格底色 FFC000/FCC102)
  → POST /api/changping-ship/import
      ├─ changping_ship_marks upsert(快照+下架偵測 still_marked)
      ├─ erp_pj_sync (doc_no+item_code) 對出 sub_no
      ├─ po_line_tracking.shipped_at 亮出貨燈(已有值不動)
      └─ note 附加「【常平出貨】…」行(只管理自己的行,永不覆蓋使用者內容,總長壓 500)
```

### 上線前置(缺一不可)
1. Supabase SQL Editor 執行 `sql/20260828_changping_ship_marks.sql`
   (沒跑之前 import 會 fail-fast、不會動到出貨燈;list 回 500)——**2026-08-29 已執行**
2. 團隊管理勾「常平訂單資料區」權限給需要的人(管理員自動可見)
3. PR 合併部署後,啟用本機排程:`schtasks /Change /TN ChangpingShipSync /ENABLE`

### 下載方式(2026-08-29 Snow 拍板改版)
- **桌面釘釘 UI 自動化下載**(`changping_ship_download_ui.py`,沿用上傳同一套 UIA 機制):
  釘雲碟→團隊文件→訂單工作表→檔案列右鍵→下載→「另存新檔」對話框填目標路徑。
  實測全程約 15 秒,冪等可重跑;需互動桌面(與 ChangpingUiDaily 相同限制)。
- 原 storage API 下載留作備援(`CHANGPING_SHIP_DOWNLOAD_METHOD=api`),但需應用開通
  `Storage.DownloadInfo.Read` scope——Snow 決定不開,故預設 ui。
- 2026-08-29 已完成單張真實訂單端對端測試(POC2026062502#11:出貨燈亮+備註附加+快照入庫+重跑冪等)。

### 設計決策
- 只掃「NNN年生產訂單」分頁:中轉/外發分頁的淺金(F2C150/FFD966)是表格格式非標記(2026-08-04 盤點驗證)
- 黃底判定深淺皆算(r≥200、g≥180、b 明顯低於 r/g),但排除底色家族 FFC000/FCC102
- 欄位用標題列文字對應(不寫死欄號),常平端調欄序不會壞
- mark_key 用工作表「明细ID」(穩定),無 ID 的列退回內容雜湊——列號會因排序漂移,不能當鍵
- 同單同品號多行(如 POC2026062301 三行 CPACARC250-KZ)無法分辨哪行,黃底時全部套用並標註
- shipped_at 已有值(採購手動點過)一律不動;備註只增改「【常平出貨】」開頭的行
