-- 淘汰系統內人工維護的 bom 表，一律以 ERP 同步資料為準（2026-09-01 決策）：
--   BOM 結構         → mm_bom_structure（ARGO MM_BOM_STRUCTURE 同步）
--   品號＋中文品名   → erp_so_lines（mbp_part / description）
--   原物料名稱       → material_inventory_list
-- 程式端所有 bom 表的讀寫已於同日移除（產期詢問自動完成、首頁生產品項下載、
-- 發料清單品名查詢、/admin/materials/bom 管理頁面）。
--
-- ⚠️ 執行前建議先備份：
--   create table bom_backup_20260901 as select * from public.bom;
drop table if exists public.bom;
