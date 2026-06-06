# 開發指南 — 多機協作 SOP(工廠 / 筆電 / 辦公室 / Mac AIR)

本專案會在多台電腦間切換開發。只要遵守以下規則,就**不會打架**。

## 🧭 核心原則:認清「唯一真相來源」

每台機器都只是雲端的「臨時工作副本」。三朵雲各管一件事:

| 東西 | 唯一真相來源 | 同步方式 |
|------|--------------|----------|
| 程式碼 | GitHub | `git pull --rebase` / `git push` |
| 環境變數 | Vercel | `vercel env pull`(產生 `.env.local`,**不進 git**) |
| 資料 / 資料表 | Supabase 雲端 | 直接連線;schema 改動見下方規則 |

> 最危險的不是 merge conflict,而是**「在 A 機改一半沒 push,跑去 B 機從舊版重開」**。養成「收工必 push」就能避免。

---

## 🆕 第一次在某台新機器設定(只做一次)

```bash
git clone https://github.com/bardshop10149-dev/bardshop-factory-os.git
cd bardshop-factory-os

git config pull.rebase true        # pull 用 rebase,保持線性歷史
git config core.hooksPath .githooks # 啟用 repo 內共用 hook(擋直推 main / 落後)
git config core.autocrlf false      # 換行交給 .gitattributes 控管

npm ci                              # 依 package-lock 精準安裝依賴
vercel env pull                     # 抓環境變數(需先用公司帳號 vercel login,或 --token)
```

---

## 🔁 每日工作 SOP

**🟢 開工(換到任一台機器的第一件事)**
```bash
git pull --rebase     # 先把雲端最新拉下來(最重要的一步)
vercel env pull       # 環境變數偶有變更時
npm ci                # 只有 package.json/lock 變動時才需要
npm run dev           # http://localhost:3000
```

**🔴 收工(離開這台機器前)**
```bash
git add -A
git commit -m "feat: 說明這次改了什麼"
git push              # 推回雲端 ← 沒做就走 = 下次在別台必分岔
```

---

## 🌿 Git 工作流:feature branch + PR

不直接在 `main` 上開發(pre-push hook 會擋直推 main)。

```bash
git switch -c feat/功能名稱        # 從最新 main 開分支
# ...開發、commit...
git push -u origin feat/功能名稱   # 推分支(會自動在 Vercel 產生 preview URL)
```
到 GitHub 開 Pull Request → 自己 review → 合併進 `main`。
合併後 `main` 才會部署到正式站(bardshop-eip.vercel.app),部署節奏完全可控。

---

## 🗄️ 資料庫(Supabase)規則 —— 本專案用「正式站 + 謹慎流程」

四台機器連的是**同一個正式 Supabase**,所以:

- **讀取**:隨意,安全。
- **schema 改動**:寫成 `sql/YYYYMMDD_說明.sql` migration 檔 → commit → **只從一台機器、到 Supabase 後台 SQL Editor 套用一次**。其他機器 pull 到檔案即可,**不要重跑**(雲端已生效)。
- migration 盡量用 `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 等冪等寫法,降低誤觸風險。
- **測試寫入**會碰到真實工廠資料,務必謹慎,並記得清掉測試資料。

---

## 💻 OS 差異(Windows × Mac)

- 換行由 `.gitattributes`(`eol=lf`)統一處理,切換 OS 不會整包假變動。
- `node_modules` 不進 git;每台機器各自 `npm ci`。
- 程式碼不要寫死絕對路徑(如 `C:\...`)。

---

## 🚑 常見狀況

| 狀況 | 解法 |
|------|------|
| push 被 hook 擋:落後 N 個 commit | `git pull --rebase` 後再 push |
| push 被 hook 擋:不能直推 main | 開 feature 分支 + PR |
| rebase 出現衝突 | 解衝突 → `git add` → `git rebase --continue` |
| 頁面一開就崩「Missing Supabase env」 | `.env.local` 沒填 → `vercel env pull` |
| Mac 上整包檔案變 modified | `git add --renormalize . && git commit`(套用 .gitattributes 一次) |
