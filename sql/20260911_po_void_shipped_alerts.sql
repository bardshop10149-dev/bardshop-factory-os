-- ============================================================================
-- 「採購單作廢卻已出貨」通知節流表
--
-- 搭配 /api/cron/void-shipped-scan：該掃描每次都會重算全庫，這張表只記「已經
-- 通知過哪幾筆」，避免同一筆天天重複發 LINE（免費額度每月 200 則）。
--
-- 不存判定結果本身——判定完全由掃描當下的 ERP 資料決定，若之後補開了採購單、
-- 或作廢被取消，下次掃描自然就不再列入，這張表不需要清理。
-- ============================================================================

create table if not exists public.po_void_shipped_alerts (
  doc_no       text not null,
  sub_no       text not null,
  item_code    text,
  source_order text,                       -- 來源 SO/RO（比對重開單用的鍵）
  shipped_at   timestamptz,                -- 當時的出貨標記時間
  notified_at  timestamptz not null default now(),
  primary key (doc_no, sub_no)
);

-- 僅供排程（service_role）讀寫；前端不需要看，故不開放 anon/authenticated
alter table public.po_void_shipped_alerts enable row level security;
