# 更新說明 — 2026-06-11（修復美編天地等頁面的同步/ARGO 功能）

> 對應分支：`fix/argoerp-permission-alignment`

## 給所有同仁：這次改了什麼

### 修復：部分頁面的「同步更新 / ARGO 資料」功能恢復正常
6/10 的安全強化把 ARGO 相關功能**過度限制成只有「生產管理」權限的人能用**，導致下列頁面的一般同仁按了會失敗：

- **美編天地** — 「🔄 同步銷售訂單」按鈕
- **資訊看板 / 訂單記錄** — 讀取每日出單表
- **發料** — 同步備料、標記已發料

現已修復：**能進這些頁面的同仁，就能正常使用上面的同步／讀取功能**，跟過去一樣。

### 安全性維持
- 真正「寫回 ARGO ERP」的匯入動作，仍維持只有管理員能執行。
- 「建立／刪除整張每日出單表」仍維持管理員權限。
- 只放寬了「讀取、同步、標記發料狀態」這類日常操作。

## 你需要做什麼
- 一般同仁：照常使用，先前按不動的同步按鈕現在可以了。
- 不需要任何設定。

有問題請聯絡系統管理員。

---

## 附錄（技術摘要，給維護者）

問題根因：`da7b192` 將整個 ARGO API 系列一律套上 `guardPermission('production_admin')`，但 `design-studio`、`info-board`、`material-issue` 等頁面對任何登入者開放，造成權限不匹配 → 403。

修法（依「動作/方法」分級，ERP 寫入與破壞性操作維持 admin）：
- `app/api/argoerp/route.ts`：POST 改為依 action 分級 —— `import` 仍 `production_admin`，其餘（`sync_*`/`query`/`test`/…）改 `guardAuth`；GET 連線測試維持 `production_admin`。
- `app/api/argoerp/material-issue/route.ts`：GET/POST/DELETE（本地發料狀態旗標，非 ERP 寫入）改 `guardAuth`。
- `app/api/argoerp/daily-order-sheet/route.ts`：GET 改 `guardAuth`；POST/PATCH/DELETE（建立/整表更新/刪除）維持 `production_admin`。

未受影響：`/admin/argoerp/*` 一整批（頁面本就需管理員權限）；`InventorySyncPanel`（位於需 admin 的 `/admin/materials`）。
tsc --noEmit：0 errors。
