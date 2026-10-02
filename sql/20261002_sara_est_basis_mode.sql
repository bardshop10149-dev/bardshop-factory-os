-- 2026-10-02  工時基準開關（app_settings.sara_est_basis_mode）
--
-- 背景：2026-08-24 加了 route_operations.qty_mode（個數/盤數）與維護介面，計畫是
-- 「生管填完設定後，工序產生邏輯改讀這個欄位」，但第三步一直沒做，開關等於唯寫。
-- 本次補上讀取邏輯（lib/sara/estTime.ts），但**刻意先不啟用**。
--
-- 為什麼不直接啟用：用全部出單表資料模擬過，照設定算會讓印刷工時從 6,332 小時
-- 變成 108,144 小時（暴增 17 倍）。全部來自 1,981 道「設定寫個數、但實際有盤數」
-- 的工序，幾乎都是 3mm 壓克力——而 3mm 極可能是漏設（qty_mode 預設就是個數，
-- 生管只切了 150/631 筆；同品類的 2mm 全是盤數，3mm+1mm 貼合也是盤數，只有 3mm
-- 停在預設值）。也就是說目前「錯的」硬寫規則比「對的」設定更接近現實。
--
-- 所以先讓這個值是 legacy-pan-first（＝維持 2026-10-02 之前的行為：盤數有填就用
-- 盤數，沒填退回個數）。等生管把 3mm 的 qty_mode 補完、並確認 4mm 以上維持個數，
-- 再把值改成 route-qty-mode 即可生效，不必改程式。
--
-- 切換（在 Supabase SQL Editor 執行其中一行）：
--   啟用依設定計算： update public.app_settings set value = '"route-qty-mode"'   where key = 'sara_est_basis_mode';
--   回復舊行為：     update public.app_settings set value = '"legacy-pan-first"' where key = 'sara_est_basis_mode';
--
-- 全檔可重複執行（idempotent）。

insert into public.app_settings (key, value, updated_at)
values ('sara_est_basis_mode', '"legacy-pan-first"'::jsonb, now())
on conflict (key) do nothing;
