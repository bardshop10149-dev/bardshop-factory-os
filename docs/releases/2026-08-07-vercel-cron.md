# 同步排程改用 Vercel Cron（不再依賴外部排程服務）

發布日期：2026-08-07
範圍：新增 `vercel.json` 排程設定；`app/api/cron/sync` 改為動態路由 `[mode]` 並支援 GET。

---

## 一句話

把「每 5 分鐘增量、每 30 分鐘庫存、每天 4 次全量對帳」直接寫進程式碼，跟著部署自動生效，不必再到 cron-job.org 手動設定。

## 排程內容（Vercel Cron 時區固定 UTC，以下已換算台灣時間）

| 路徑 | cron 運算式(UTC) | 台灣時間 |
|---|---|---|
| `/api/cron/sync/incremental` | `*/5 1-10 * * 1-5` | 週一～五 09:00–18:55，每 5 分鐘 |
| `/api/cron/sync/heavy` | `*/30 1-11 * * 1-5` | 週一～五 09:00–19:30，每 30 分鐘 |
| `/api/cron/sync/full` | `0 0,5,11,17 * * *` | 每天 08:00 / 13:00 / 19:00 / 01:00 |

增量在 18:55 收尾、19:00 緊接著跑全量對帳，銜接剛好。

## 為什麼這樣拆

- **增量（5 分鐘）**：SO/MO/PO/PR/客戶。只拉近期異動，實測整輪 1.5 秒、通常 0～數十筆。
- **heavy（30 分鐘）**：**庫存**（`MM_BOM_BOH_V` 是 view 沒有 `UPDATE_DATE`）與**批備料**（無可靠自然鍵、寫入為整批覆蓋）只能全量；這兩張變動快又影響缺料判斷與領料，值得高頻。
- **BOM 移出 heavy、只在 full 跑**：BOM 極少變動，但每輪全量約 1 萬筆並不便宜。改成一天 4 次即可，既解決 BOM 單位長期未更新，又不會把總拉取量墊高。
- **full（每天 4 次）**：唯一會**偵測刪除**的模式（增量一律不刪）。

## 技術重點

- **Vercel Cron 以 GET 呼叫**，故路由同時支援 GET 與 POST。
- **模式放在路徑上**（`/incremental`、`/heavy`、`/full`）而非 query string——Vercel 排程以 path 為準，用路徑最穩妥。另保留 `full-orders` / `full-master` 兩個拆批用路徑。
- **驗證**：接受 `CRON_SECRET`（Vercel 自動帶）或 `WEBHOOK_SECRET`（手動測試用）。
- **`maxDuration` 提高到 120 秒**：full 對帳實測約 50 秒，Pro 方案可拉高上限，避免被砍在半途。
- **對漏跑/重複跑都安全**（Vercel 官方明示 cron 遞送為 best-effort）：漏跑由下一輪 20 分鐘的回看窗口補上；重複跑因 upsert 冪等不會產生重複資料。

## 部署後必做一步

在 **Vercel 專案 → Settings → Environment Variables** 新增 `CRON_SECRET`：
把現有 `WEBHOOK_SECRET` 的值複製一份貼上即可（或任意 16 字以上隨機字串）。

**沒設定的話 Vercel 不會帶授權標頭，排程會全部回 401 而不執行。** 設好後重新部署一次生效。

## 回退方式

刪掉 `vercel.json` 裡對應的 `crons` 項目再部署即可；或在 Vercel 的 Cron Jobs 設定頁按 **Disable**。

## 變更檔案

- `vercel.json`（新增）
- `app/api/cron/sync/route.ts` → `app/api/cron/sync/[mode]/route.ts`（改為動態路由、支援 GET、雙密鑰驗證、BOM 移出 heavy）
