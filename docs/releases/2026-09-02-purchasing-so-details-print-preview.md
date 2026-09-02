# 採購專區：SO/請購可點看詳情、示意圖內嵌預覽、下單日排序等七項

發布日期：2026-09-02
範圍：採購專區（`/purchasing`）。本次同時把先前的「已結案排除＋出貨篩選」分支併入。

---

## 一句話

採購追蹤列表的單號都變成可以點了：SO 點開是「訂單詳情＋示意圖」一次看完，請購單號點開明細；示意圖直接顯示在視窗裡（從公司 NAS 即時取縮圖，圖不存雲端）。

## 公告欄白話版

> 🛒 **採購專區更新**
> 1. **點 SO 單號** → 訂單詳情＋該單所有示意圖縮圖，點縮圖看大圖
> 2. SO 旁的 **📷 徽章** → 只看示意圖的快速視窗
> 3. **點請購單號** → 請購單明細
> 4. 狀態列右邊新增 **只看已出貨／只看未出貨**
> 5. **下單日**表頭也能點擊排序（與交期擇一）
> 6. SO 單號完整顯示不再被截斷；日期欄的小日曆圖示改亮色看得見
>
> 示意圖需要美編把資料夾照「訂單號＋客戶名」命名放在 ro排單圖庫，8 月以後的單才有。

---

## 示意圖是怎麼接的（重點）

**前提**：EIP 部署在 Vercel（雲端），示意圖在內網 NAS（`\192.168.1.141\RO排單圖庫`），
且 Snow 拍板**設計圖不出內網**（不上傳雲端儲存）。

**做法**：沿用 argo-tool 既有基礎設施，零新服務——
- argo-tool（`bardshop-argo.com`，Cloudflare Tunnel → 公司常開機）本來就有
  `GET /api/nas/diagrams`（示意圖清單，支援月份夾/歷年庫）與
  `GET /api/nas/diagram_thumbnail`（縮圖 JPEG，特准 `?token=` 供 `<img>` 使用）
- 新 EIP 路由 `/api/purchasing/print-preview`：guardAuth → 簽 EIP↔ARGO 既有格式的
  SSO 票證 → 換 argo token → 抓清單回傳；瀏覽器拿 token 直接 `<img>` 縮圖端點
  （HTTPS→HTTPS 無 Mixed Content；`<img>` 不受 CORS 限制）
- 機密性：圖不落地雲端；傳輸走 Cloudflare Tunnel 加密通道，與現場操作員每天列印
  示意圖是同一條路。附帶效果：外網也能看（需 EIP 登入才拿得到 token）

**📷 徽章張數**來自新索引表 `print_asset_index`：內網掃描器
`tools/print_index_scanner.py` 每小時掃 NAS 寫入（603+ 張單、9,300+ 檔）。
清單頁不逐一打 argo，只查一次索引。

## 介面調整明細

- SO 欄：可點（訂單詳情視窗掛共用 `SoOrderModal`，下方新增示意圖區塊——用新的
  可選插槽 `extraContent`，**其他使用該視窗的頁面不受影響**）；單號完整顯示（斷行取代截斷）
- 請購單號：可點開 `PoOrderModal`；其請購判斷從只認 `MPO` 擴充為 `MPO/MP+數字/PR`
  （原本 `MP260701004` 會被誤標成「採購單」）
- 下單日排序：伺服器端 `start_date`，與交期擇一，表頭循環 升冪→降冪→取消
- 全域 CSS：`input[type=date]` 的原生日曆圖示深色主題反白（整站受惠）

## 上線前需要做的事

1. **執行 SQL**：`sql/20260831_print_asset_index.sql`（已於 2026-09-01 執行過，若換環境才需重跑）
2. **Vercel 環境變數**：`ARGO_SSO_SECRET`、`ARGO_BASE_URL`（ARGO 外掛區既有，無新增）
3. **掃描器排程**：公司常開機每小時跑 `python tools/print_index_scanner.py`
   （需連得到 NAS 與 Supabase；`--dry-run` 可先驗）

## 踩過的坑（留給後人）

- NAS 月初歸檔會**搬移/改名資料夾**（八月→2608、舊單移 2號倉），索引每小時重掃自癒；
  掃描器同時支援「訂單直下」與「月份夾下」兩層
- Python 正則 `\w` 會吃中文——單號抓取用 `[\d-]`，否則「SO260604032捷旭電子」整串變單號
- UNC 共享根目錄的 `Path.name` 是空字串（`\host\share` 整段是錨點）
- Cloudflare bot 防護會擋非瀏覽器 UA，server-to-server 呼叫要帶 UA
- PostgREST query string 的時間戳要 URL 編碼（`+00:00` 的 `+` 會變空格）

## 驗證

`npx tsc --noEmit` 0 errors；`npm run build` 通過；SSO→清單→縮圖鏈路實測
（SO260828012：2 張示意圖、縮圖 HTTP 200 JPEG）；索引 dry-run 與正式掃描各多輪。
