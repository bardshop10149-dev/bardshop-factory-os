-- =====================================================================
-- 20260707_purchasing_indexes.sql
-- 採購專區查詢加速：為 enrich（PR/MO 比對、下單日收斂）所需的 join / filter 欄位建索引
-- 建立日期：2026-07-07
--
-- 這些 .in() / 範圍查詢原本走全表掃描（erp_so_lines 7k、erp_mo_lines 34k、
-- erp_pj_sync 請購列 jsonb 展開），加索引後改走索引查找，列表載入大幅變快。
-- 索引為 schema 物件，不受 erp_pj_sync 每小時整批重建影響（重建只換資料列）。
-- 全部 IF NOT EXISTS，可重複執行。
-- =====================================================================

-- 主列表過濾：OPEN 採購單 + 下單日區間
create index if not exists erp_pj_sync_type_status_start_idx
  on public.erp_pj_sync (doc_type, status, start_date);

-- 請購比對：以 extra 內的來源單號 jsonb 展開值查找
create index if not exists erp_pj_sync_so_project_id_idx
  on public.erp_pj_sync ((extra->>'SO_PROJECT_ID'));
create index if not exists erp_pj_sync_project_id_idx
  on public.erp_pj_sync ((extra->>'PROJECT_ID'));
create index if not exists erp_pj_sync_mbp_lot_no_idx
  on public.erp_pj_sync ((extra->>'MBP_LOT_NO'));

-- 製令比對：source_order = 來源 SO
create index if not exists erp_mo_lines_source_order_idx
  on public.erp_mo_lines (source_order);

-- RO 橋接：SO → erp_so_lines
create index if not exists erp_so_lines_project_id_idx
  on public.erp_so_lines (project_id);

-- =====================================================================
-- 完
-- =====================================================================
