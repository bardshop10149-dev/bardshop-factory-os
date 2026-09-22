-- 2026-09-21  塔台異常回報
--
-- 需求：印刷現場在塔台（SARA）上發現工序不對——途程錯、站點錯、數量對不上——
--   目前只能口頭或用通訊軟體回報生管，沒有紀錄也追不到有沒有處理。
--   做成一張單：前台由現場填（不設權限，誰發現誰回報），後台由生管處理完點「已完成」。
--   設計比照產期詢問記錄（schedule_inquiries）：前台登記、後台結案、狀態一目了然。
--
-- 為什麼要把交換區當下的工序快照存起來（snapshot 欄位）：
--   生管處理的方式通常就是「改單」——把這個品項的工序整組換掉。一旦改完，
--   交換區裡的舊工序就沒了，事後回頭看這張異常單會不知道當初現場看到的是什麼。
--   回報當下拍一份快照存著，之後對照「當初長這樣 → 現在改成這樣」才有依據。
--
-- 全檔可重複執行（idempotent）。

create table if not exists public.sara_anomaly_reports (
  id bigserial primary key,

  -- 現場輸入的識別：銷售單號 + 序號
  order_no text not null,
  line_seq text,

  -- 由交換區自動帶出（回報當下的狀態）
  mfg_order_number text,                       -- 工單號（製令／採購／請購）
  product_name text,                           -- 品號
  product_desc text,                           -- 品名規格
  factory text,                                -- 廠區 T/C/O
  -- 回報當下這個品項在交換區的完整工序列，格式同 CSV：
  -- [{ seq, workcenter, job_name, job_qty, est_time }, ...]
  snapshot jsonb not null default '[]'::jsonb,

  -- 現場回報內容
  reason text not null,                        -- 異常原因

  -- 處理狀態
  status text not null default '待處理',        -- 待處理 / 已完成
  handled_note text,                           -- 生管處理說明（選填）
  resolved_at timestamptz,
  resolved_by text,
  resolved_by_name text,

  -- 回報人（一律由伺服器依登入身分帶入，不信任前端）
  reporter_email text,
  reporter_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 後台最常問的是「還有哪些沒處理」；列表預設新到舊
create index if not exists sara_anomaly_reports_status_idx
  on public.sara_anomaly_reports (status, created_at desc);
-- 「這張單之前被回報過幾次」是回頭查的主要條件
create index if not exists sara_anomaly_reports_order_idx
  on public.sara_anomaly_reports (order_no, created_at desc);

-- RLS 比照 schedule_inquiries：不啟用，改由 API 層的 guardAuth() 保護。
-- 前提一樣：只能經由 /api/sara/anomaly 存取，不要在瀏覽器端用 anon key 直接讀寫。
alter table public.sara_anomaly_reports disable row level security;
