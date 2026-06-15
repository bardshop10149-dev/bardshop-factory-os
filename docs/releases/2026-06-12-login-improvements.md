# 更新說明 — 2026-06-12（登入頁改善 + 忘記密碼）

## 給所有同仁

### 1. 登入時可以看自己打的密碼
登入頁密碼欄右側多了一個**眼睛圖示**，點一下可以切換「顯示／隱藏」密碼，方便確認有沒有打錯。

### 2. 忘記密碼可以自己重設
登入頁多了「**忘記密碼？**」：
- 先在上方輸入你的 Email → 點「忘記密碼？」
- 系統會寄一封**重設密碼信**到你的信箱
- 點信中的連結 → 進入重設頁 → 設定新密碼 → 用新密碼登入

（為保護帳號，不論 Email 是否存在都會顯示「已寄出」，避免被人試探哪些信箱有註冊。）

### 3. 個人中心
「請假」卡片改為「**線上打卡**」（一樣是即將推出）。

---

## 附錄（技術 / 設定需求）

- 登入頁 `app/login/page.tsx`：密碼顯示切換、「忘記密碼」按鈕（呼叫 `/api/auth/forgot-password`）。
- 新增 `POST /api/auth/forgot-password`：`resetPasswordForEmail`，防帳號列舉（一律回 ok），`redirectTo = <origin>/reset-password`。
- 新增 `app/reset-password/page.tsx`：recovery session → `updateUser({ password })`。
- `proxy.ts`：`/reset-password` 加入公開路徑（未登入可進）。

⚠️ **上線前 Supabase 後台需設定（否則忘記密碼信不會寄達）：**
1. Authentication → URL Configuration → **Redirect URLs** 加入 `<正式站網址>/reset-password`（與本機 `http://localhost:3700/reset-password`）。
2. Authentication → Emails → 設定**自訂 SMTP**（免費方案內建信件量極低、不適合正式使用）。
