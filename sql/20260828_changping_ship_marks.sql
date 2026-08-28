-- =====================================================================
-- 20260828_changping_ship_marks.sql
-- 常平訂單資料區 — 訂單工作表黃底(常平已出貨)標記快照
-- 建立日期:2026-08-28
--
-- 資料來源:每天 07:00 本機排程 ChangpingShipSync 從釘釘下載
-- 「訂單工作表.xlsx」,掃「NNN年生產訂單」分頁的黃底列後
-- POST /api/changping-ship/import 寫入。
-- service_role 專用:前端一律走 /api/changping-ship/* 後端 API 讀寫。
-- =====================================================================

create table if not exists public.changping_ship_marks (
  mark_key       text         primary key,  -- 明細ID(id:ORD-115-xxxx) 或內容雜湊(h:xxxx)
  sheet          text         not null,     -- 來源分頁(如 115年生產訂單)
  row_no         int,                       -- 最近一次掃到的列號(排序會漂移,僅參考)
  detail_id      text,                      -- 工作表明細ID(可空)
  po_no          text         not null,     -- 採購單號(POC/PO)
  pr_no          text,
  so_no          text,                      -- RO單號欄原文(可能含雜註)
  vendor         text,
  item_code      text,
  item_name      text,
  qty            numeric,
  order_date     text,                      -- 發單日期(原文)
  hope_date      text,                      -- 希望到貨日(原文)
  transport      text,                      -- 運輸方式欄原文
  expected_ship  text,                      -- 预计出货日原文
  ship_date_text text,                      -- 常平出貨日欄原文(核心資訊:幾月幾號+方式)
  ship_date      date,                      -- 解析出的出貨日(解析不出為 null)
  fill_color     text,                      -- 標記色 ARGB(黃底深淺)
  still_marked   boolean      not null default true,  -- 最近一次掃描仍為黃底
  first_seen_at  timestamptz  not null default now(),
  last_seen_at   timestamptz  not null default now(),
  -- 套用結果(出貨燈+備註)
  matched_lines  jsonb,                     -- 對到的採購行 [{doc_no,sub_no}]
  match_status   text,                      -- matched / no_line / multi_line
  applied_at     timestamptz,               -- 出貨燈/備註實際套用時間(null=尚未)
  apply_note     text                       -- 套用摘要或錯誤訊息
);

create index if not exists changping_ship_marks_po_idx
  on public.changping_ship_marks (po_no);
create index if not exists changping_ship_marks_last_seen_idx
  on public.changping_ship_marks (last_seen_at desc);

alter table public.changping_ship_marks enable row level security;
drop policy if exists "service_role full access" on public.changping_ship_marks;
create policy "service_role full access" on public.changping_ship_marks
  for all to service_role using (true) with check (true);

-- =====================================================================
-- 完
-- =====================================================================
