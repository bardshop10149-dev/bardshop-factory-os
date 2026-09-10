-- =====================================================================
-- 20260910_item_code_requests.sql
-- 商品開發專區 —「新品項編碼建立申請」
-- 建立日期：2026-09-10
--
-- 用途：商品開發人員在 EIP 填申請單，送出後由建檔人員在 ARGO ERP
--       （IFAF007 料件主檔 / BOMF027）實際建立品項編碼，再回填單號結案。
--       本表只存「申請」與「處理結果」，不直接寫入 ARGO。
--
-- 欄位命名刻意對齊 ARGO MM_BOM_PART 的欄位名（part_name / unit_of_measure /
-- product_category …），建檔人員拿到申請單可以逐欄照抄進 ERP，不必再翻譯。
--
-- 安全：比照 20260620_order_inspection —— 只開 service_role policy，
--       前端一律走 /api/product-dev/* 後端 API（已 guardPermission('product_dev')）。
-- =====================================================================

create table if not exists public.item_code_requests (
  id                 bigserial    primary key,
  request_no         text         not null unique,          -- 申請單號 IR + yyMMdd + 3 碼流水
  status             text         not null default 'pending', -- pending 待建檔 | created 已建檔 | rejected 退回

  -- ── 申請人（由後端從登入身分寫入，前端不可竄改）──
  requester_email    text         not null,
  requester_name     text,
  requested_at       timestamptz  not null default now(),

  -- ── 引用來源：申請時參照的既有品項編碼（可空＝從零填寫）──
  template_part      text,

  -- ── 品項核心（商開必填）──
  part_name          text         not null,   -- PART_NAME       品項名稱
  part_desc          text,                    -- PART_DESC       規格 / 顏色 / 尺寸
  unit_of_measure    text         not null,   -- UNIT_OF_MEASURE 單位
  product_category   text         not null,   -- PRODUCT_CATEGORY   大類 M/W/P/C/S/A/O
  product_category_2 text         not null,   -- PRODUCT_CATEGORY_2 次類別 MACR/W3C/…

  -- ── ERP 設定（引用範本帶入，可調整；建檔時照抄）──
  source_type        text,                    -- SOURCE_TYPE
  inventory_type     text,                    -- INVENTORY_TYPE
  cost_category      text,                    -- COST_CATEGORY
  leadtime_flag      text,                    -- LEADTIME_FLAG    PURCHASE / MANUFACTURE
  bom_warehouse_id   text,                    -- BOM_WAREHOUSE_ID 預設倉
  lot_no_flag        text,                    -- LOT_NO_FLAG      批號控管 Y/N
  expense_flag       text,                    -- EXPENSE_FLAG     費用類 Y/N
  level_code_inv     text,                    -- LEVEL_CODE_INV   存貨科目層級
  account_no_inv     text,                    -- ACCOUNT_NO_INV   存貨會計科目
  safety_qty         numeric,                 -- SAFETY_QTY       安全庫存
  validdate          text,                    -- VALIDDATE        生效日（YYYY/MM/DD，比照 ARGO 斜線字串）

  -- ── 申請補充 ──
  suggested_part     text,                    -- 商開建議編碼（最終仍由建檔人員決定）
  note               text         not null,   -- 用途說明：誰要用、哪張單、為何需要新編碼
  reference_url      text,                    -- 參考連結 / 圖片位置

  -- ── 處理結果 ──
  assigned_part      text,                    -- 實際在 ARGO 建立的品項編碼
  handled_by         text,                    -- 處理人 email
  handled_at         timestamptz,
  reject_reason      text,

  updated_at         timestamptz  not null default now()
);

comment on table public.item_code_requests is '商品開發：新品項編碼建立申請單（人工在 ARGO 建檔後回填 assigned_part 結案）';

create index if not exists icr_status_idx    on public.item_code_requests (status, requested_at desc);
create index if not exists icr_requester_idx on public.item_code_requests (requester_email, requested_at desc);

alter table public.item_code_requests enable row level security;
drop policy if exists "service_role full access" on public.item_code_requests;
create policy "service_role full access" on public.item_code_requests
  for all to service_role using (true) with check (true);
