-- 2026-07-03  增量同步第二階段：自然鍵唯一索引
-- 供 SO / MO / PO / PR / 委外(sync_pj) / 庫存 同步改「增量比對 upsert」使用（onConflict 需要）。
--
-- ⚠️ 執行順序很重要：先在 Supabase 跑本檔，再合併/部署程式。
--    （新程式的 upsert 需要這些索引；索引先建好對舊程式無任何影響。）
--
-- 2026-07-03 實機稽核結果（read-only）：
--   erp_so_lines           6,918 列，(project_id,line_no)    零重複
--   erp_mo_lines          34,054 列，(project_id,line_no)    零重複
--   erp_pj_sync           21,771 列，(doc_type,doc_no,sub_no) 零重複
--   material_inventory_list 7,570 列，(item_code)             零重複
--   erp_material_prep_lines 2,216 列 → 8 組重複、且同 (slip_no,line_no) 可有不同料號
--     ＝【沒有可靠自然鍵，不建索引、同步維持整批覆蓋】
--
-- 去重語句為防禦性（稽核為零重複，但保留以防執行前又跑了一次舊版同步產生重複）；
-- 同鍵保留 id 最大（最新寫入）那筆。全檔可重複執行（idempotent）。

-- ── 1. erp_so_lines (project_id, line_no) ─────────────────────
DELETE FROM public.erp_so_lines a
USING public.erp_so_lines b
WHERE a.project_id = b.project_id
  AND a.line_no    = b.line_no
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS erp_so_lines_project_line_uidx
  ON public.erp_so_lines (project_id, line_no);

-- ── 2. erp_mo_lines (project_id, line_no) ─────────────────────
DELETE FROM public.erp_mo_lines a
USING public.erp_mo_lines b
WHERE a.project_id = b.project_id
  AND a.line_no    = b.line_no
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS erp_mo_lines_project_line_uidx
  ON public.erp_mo_lines (project_id, line_no);

-- ── 3. erp_pj_sync (doc_type, doc_no, sub_no) ─────────────────
DELETE FROM public.erp_pj_sync a
USING public.erp_pj_sync b
WHERE a.doc_type = b.doc_type
  AND a.doc_no   = b.doc_no
  AND a.sub_no   = b.sub_no
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS erp_pj_sync_doc_key_uidx
  ON public.erp_pj_sync (doc_type, doc_no, sub_no);

-- ── 4. material_inventory_list (item_code) ────────────────────
DELETE FROM public.material_inventory_list a
USING public.material_inventory_list b
WHERE a.item_code = b.item_code
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS material_inventory_list_item_code_uidx
  ON public.material_inventory_list (item_code);

-- ── 5. erp_material_prep_lines：刻意不建 ───────────────────────
-- 同一 (slip_no, line_no) 實測存在多筆不同料號（例 MOT26061101401 line 1），
-- 亦有完全相同的重複列，語意未明。該表同步維持整批覆蓋，等與 ARGO 端確認後再議。
