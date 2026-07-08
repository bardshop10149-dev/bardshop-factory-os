-- =====================================================================
-- 20260703_purchasing_tracking.sql
-- 採購專區（Purchasing Zone）— 採購單追蹤覆蓋層 + 供應商主檔
-- 建立日期：2026-07-03
--
-- 三張表皆為「後端 service_role 專用」：
--   erp_pj_sync 每小時整批 delete+insert 重建、無穩定 id，
--   故使用者點選的狀態放獨立覆蓋表，以自然鍵 (doc_no, sub_no) 連結。
--   前端一律走 /api/purchasing/* 後端 API 讀寫，不直接 from() 這些表。
--   erp_vendors 特別注意：供應商資料不可外流 → 不給 authenticated read。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. po_line_tracking — 每條採購明細的執行/出貨追蹤（明細層級）
--    shipped_at 為 null = 排程製作中；有值 = 已出貨（不再進到期提醒）
-- ---------------------------------------------------------------------
create table if not exists public.po_line_tracking (
  doc_no             text         not null,   -- 採購單號（erp_pj_sync.doc_no）
  sub_no             text         not null,   -- 序號（erp_pj_sync.sub_no）
  shipped_at         timestamptz,             -- 已出貨時間（null = 排程製作中）
  ship_method        text         check (ship_method in ('順豐','空運','海特快','一般海運')),
  expected_ship_date date,                    -- 預計出貨日
  updated_by         text,                    -- 操作人（member 姓名/email）
  updated_at         timestamptz  not null default now(),
  primary key (doc_no, sub_no)
);

alter table public.po_line_tracking enable row level security;
drop policy if exists "service_role full access" on public.po_line_tracking;
create policy "service_role full access" on public.po_line_tracking
  for all to service_role using (true) with check (true);


-- ---------------------------------------------------------------------
-- 2. po_payment — 付款進度（表頭層級）
--    30/50/70/100% 是整張 PO 金額的比例，放明細會產生重複與不一致
-- ---------------------------------------------------------------------
create table if not exists public.po_payment (
  doc_no      text         primary key,       -- 採購單號
  payment_pct smallint     not null default 0 check (payment_pct in (0,30,50,70,100)),
  updated_by  text,
  updated_at  timestamptz  not null default now()
);

alter table public.po_payment enable row level security;
drop policy if exists "service_role full access" on public.po_payment;
create policy "service_role full access" on public.po_payment
  for all to service_role using (true) with check (true);


-- ---------------------------------------------------------------------
-- 3. erp_vendors — 供應商主檔（sync_vendor 由 ARGO GL_TRADINGPARTNER 同步）
--    與 erp_customers 不同：不開 authenticated read，
--    供應商名稱只經 guardPermission('purchasing') 的 API 流出。
-- ---------------------------------------------------------------------
create table if not exists public.erp_vendors (
  id         bigserial    primary key,
  partner_id text         not null,           -- TPN_PARTNER_ID（廠商代碼）
  cname      text         not null,           -- 簡稱
  full_cname text,                            -- 全名
  synced_at  timestamptz  not null default now()
);

create unique index if not exists erp_vendors_partner_id_idx
  on public.erp_vendors (partner_id);

alter table public.erp_vendors enable row level security;
drop policy if exists "service_role full access" on public.erp_vendors;
create policy "service_role full access" on public.erp_vendors
  for all to service_role using (true) with check (true);

-- =====================================================================
-- 完
-- =====================================================================
