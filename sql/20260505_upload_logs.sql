-- ============================================================
-- 2026-05-05  上傳紀錄表 x 2
--   1. argoerp_mo_upload_log      — 製令上傳至 ARGO ERP 的歷程
--   2. argoerp_material_prep_log  — 批備料上傳 / 無需備料標記歷程
-- ============================================================

-- ── 1. 製令上傳紀錄 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.argoerp_mo_upload_log (
  id                 serial        PRIMARY KEY,
  mo_number          text          NOT NULL,
  factory            text          NOT NULL DEFAULT 'T',
  product_code       text,
  planned_qty        text,
  source_order       text,
  lot_number         text,
  mo_note            text,
  planned_start_date text,
  planned_end_date   text,
  create_date        text,
  interface_id       text,
  uploaded_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS argoerp_mo_upload_log_mo_number_idx
  ON public.argoerp_mo_upload_log (mo_number);

CREATE INDEX IF NOT EXISTS argoerp_mo_upload_log_uploaded_at_idx
  ON public.argoerp_mo_upload_log (uploaded_at DESC);

COMMENT ON TABLE  public.argoerp_mo_upload_log                    IS '製令匯入 ARGO ERP 的逐筆歷程紀錄';
COMMENT ON COLUMN public.argoerp_mo_upload_log.mo_number          IS '製令單號';
COMMENT ON COLUMN public.argoerp_mo_upload_log.factory            IS '廠別：T 台北 / C 常平 / O 委外';
COMMENT ON COLUMN public.argoerp_mo_upload_log.product_code       IS '生產貨號';
COMMENT ON COLUMN public.argoerp_mo_upload_log.planned_qty        IS '計畫生產數量';
COMMENT ON COLUMN public.argoerp_mo_upload_log.source_order       IS '來源訂單號';
COMMENT ON COLUMN public.argoerp_mo_upload_log.lot_number         IS '批號 / 客戶名（顯示用）';
COMMENT ON COLUMN public.argoerp_mo_upload_log.mo_note            IS '製令說明';
COMMENT ON COLUMN public.argoerp_mo_upload_log.planned_start_date IS '預定開始日';
COMMENT ON COLUMN public.argoerp_mo_upload_log.planned_end_date   IS '預定結案日';
COMMENT ON COLUMN public.argoerp_mo_upload_log.create_date        IS '製令建立日（ERP 欄位）';
COMMENT ON COLUMN public.argoerp_mo_upload_log.interface_id       IS 'ARGO 匯入介面編號（如 IFAF028）';
COMMENT ON COLUMN public.argoerp_mo_upload_log.uploaded_at        IS '上傳時間（自動填入）';

-- RLS：允許所有認證用戶讀寫（與其他 argoerp 表一致）
ALTER TABLE public.argoerp_mo_upload_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_read   ON public.argoerp_mo_upload_log;
DROP POLICY IF EXISTS allow_write  ON public.argoerp_mo_upload_log;

CREATE POLICY allow_read  ON public.argoerp_mo_upload_log FOR SELECT USING (true);
CREATE POLICY allow_write ON public.argoerp_mo_upload_log FOR ALL    USING (true) WITH CHECK (true);


-- ── 2. 批備料上傳紀錄 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.argoerp_material_prep_log (
  id             serial        PRIMARY KEY,
  mo_number      text          NOT NULL,
  factory        text,
  product_code   text,
  planned_qty    text,
  status         text          NOT NULL CHECK (status IN ('已備料', '無需備料')),
  lines_count    int           NOT NULL DEFAULT 0,
  interface_id   text,
  logged_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS argoerp_material_prep_log_mo_number_idx
  ON public.argoerp_material_prep_log (mo_number);

CREATE INDEX IF NOT EXISTS argoerp_material_prep_log_logged_at_idx
  ON public.argoerp_material_prep_log (logged_at DESC);

COMMENT ON TABLE  public.argoerp_material_prep_log               IS '批備料上傳至 ARGO ERP 及無需備料標記的逐筆歷程';
COMMENT ON COLUMN public.argoerp_material_prep_log.mo_number     IS '製令單號';
COMMENT ON COLUMN public.argoerp_material_prep_log.factory       IS '廠別：T / C / O';
COMMENT ON COLUMN public.argoerp_material_prep_log.product_code  IS '生產貨號';
COMMENT ON COLUMN public.argoerp_material_prep_log.planned_qty   IS '計畫生產數量';
COMMENT ON COLUMN public.argoerp_material_prep_log.status        IS '操作結果：已備料（有上傳 ARGO）| 無需備料（人工標記）';
COMMENT ON COLUMN public.argoerp_material_prep_log.lines_count   IS '批備料行數；無需備料時為 0';
COMMENT ON COLUMN public.argoerp_material_prep_log.interface_id  IS 'ARGO 批備料介面編號；無需備料時為空';
COMMENT ON COLUMN public.argoerp_material_prep_log.logged_at     IS '操作時間（自動填入）';

-- RLS
ALTER TABLE public.argoerp_material_prep_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_read   ON public.argoerp_material_prep_log;
DROP POLICY IF EXISTS allow_write  ON public.argoerp_material_prep_log;

CREATE POLICY allow_read  ON public.argoerp_material_prep_log FOR SELECT USING (true);
CREATE POLICY allow_write ON public.argoerp_material_prep_log FOR ALL    USING (true) WITH CHECK (true);
