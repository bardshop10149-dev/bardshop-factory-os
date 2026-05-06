-- ============================================================
-- 2026-05-05  ArgoERP 相關資料表 (一次執行全部)
-- 包含：
--   1. argoerp_mo_summary 新增 machine 欄位
--   2. argoerp_mo_summary 新增 plate_count 欄位
--   3. mo_machines — 機台選單表
--   4. argoerp_mo_print_log — 製令列印紀錄
--   5. argoerp_staging — 訂單暫緩區
--   6. argoerp_mo_upload_log — 製令上傳至 ARGO 歷程
--   7. argoerp_material_prep_log — 批備料上傳歷程
-- ============================================================

-- ── 1. argoerp_mo_summary 新增 machine 欄位 ─────────────────
ALTER TABLE public.argoerp_mo_summary
  ADD COLUMN IF NOT EXISTS machine text;

COMMENT ON COLUMN public.argoerp_mo_summary.machine
  IS '印刷機台，對應列印工單右上角印刷機台欄位';

-- ── 2. argoerp_mo_summary 新增 plate_count 欄位 ─────────────
ALTER TABLE public.argoerp_mo_summary
  ADD COLUMN IF NOT EXISTS plate_count text;

COMMENT ON COLUMN public.argoerp_mo_summary.plate_count
  IS '盤數，來自工單批量上傳原始資料，供批備料計算需求量使用';

-- ── 3. 機台選單表 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.argoerp_machines (
  id          serial      PRIMARY KEY,
  name        text        NOT NULL UNIQUE,
  sort_order  int         NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.argoerp_machines       IS '製令印刷機台選單';
COMMENT ON COLUMN public.argoerp_machines.name  IS '機台名稱，顯示於製令總表下拉選單及工單右上角';

ALTER TABLE public.argoerp_machines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_read  ON public.argoerp_machines;
DROP POLICY IF EXISTS allow_write ON public.argoerp_machines;
CREATE POLICY allow_read  ON public.argoerp_machines FOR SELECT USING (true);
CREATE POLICY allow_write ON public.argoerp_machines FOR ALL    USING (true) WITH CHECK (true);

-- ── 4. 製令列印紀錄 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.argoerp_mo_print_log (
  id         serial      PRIMARY KEY,
  mo_number  text        NOT NULL,
  printed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS argoerp_mo_print_log_mo_number_idx
  ON public.argoerp_mo_print_log (mo_number);

COMMENT ON TABLE  public.argoerp_mo_print_log            IS '製令工單列印歷程';
COMMENT ON COLUMN public.argoerp_mo_print_log.mo_number  IS '製令單號';
COMMENT ON COLUMN public.argoerp_mo_print_log.printed_at IS '列印時間';

ALTER TABLE public.argoerp_mo_print_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_read  ON public.argoerp_mo_print_log;
DROP POLICY IF EXISTS allow_write ON public.argoerp_mo_print_log;
CREATE POLICY allow_read  ON public.argoerp_mo_print_log FOR SELECT USING (true);
CREATE POLICY allow_write ON public.argoerp_mo_print_log FOR ALL    USING (true) WITH CHECK (true);

-- ── 5. 訂單暫緩區 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.argoerp_staging (
  id            serial      PRIMARY KEY,
  order_number  text,
  doc_type      text,
  factory       text,
  receiver      text,
  is_sample     text,
  has_material  text,
  designer      text,
  customer      text,
  line_nickname text,
  handler       text,
  issuer        text,
  item_code     text,
  item_name     text,
  note          text,
  quantity      text,
  delivery_date text,
  plate_count   text,
  upload_ro     text,
  order_status  text,
  pm_note       text,
  hold_reason   text        NOT NULL DEFAULT '',
  staged_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS argoerp_staging_staged_at_idx
  ON public.argoerp_staging (staged_at);

COMMENT ON TABLE  public.argoerp_staging             IS '訂單暫緩區，從批量匯出區移入';
COMMENT ON COLUMN public.argoerp_staging.hold_reason IS '暫緩原因（人工填寫）';
COMMENT ON COLUMN public.argoerp_staging.staged_at   IS '移入暫緩區時間';

ALTER TABLE public.argoerp_staging ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_read  ON public.argoerp_staging;
DROP POLICY IF EXISTS allow_write ON public.argoerp_staging;
CREATE POLICY allow_read  ON public.argoerp_staging FOR SELECT USING (true);
CREATE POLICY allow_write ON public.argoerp_staging FOR ALL    USING (true) WITH CHECK (true);

-- ── 6. 製令上傳至 ARGO 歷程 ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.argoerp_mo_upload_log (
  id                 serial      PRIMARY KEY,
  mo_number          text        NOT NULL,
  factory            text        NOT NULL DEFAULT 'T',
  product_code       text,
  planned_qty        text,
  source_order       text,
  lot_number         text,
  mo_note            text,
  planned_start_date text,
  planned_end_date   text,
  create_date        text,
  interface_id       text,
  uploaded_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS argoerp_mo_upload_log_mo_number_idx
  ON public.argoerp_mo_upload_log (mo_number);
CREATE INDEX IF NOT EXISTS argoerp_mo_upload_log_uploaded_at_idx
  ON public.argoerp_mo_upload_log (uploaded_at DESC);

COMMENT ON TABLE  public.argoerp_mo_upload_log           IS '製令匯入 ARGO ERP 的逐筆歷程紀錄';
COMMENT ON COLUMN public.argoerp_mo_upload_log.interface_id IS 'ARGO 匯入介面編號（如 IFAF028）';

ALTER TABLE public.argoerp_mo_upload_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_read  ON public.argoerp_mo_upload_log;
DROP POLICY IF EXISTS allow_write ON public.argoerp_mo_upload_log;
CREATE POLICY allow_read  ON public.argoerp_mo_upload_log FOR SELECT USING (true);
CREATE POLICY allow_write ON public.argoerp_mo_upload_log FOR ALL    USING (true) WITH CHECK (true);

-- ── 7. 批備料上傳歷程 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.argoerp_material_prep_log (
  id           serial      PRIMARY KEY,
  mo_number    text        NOT NULL,
  factory      text,
  product_code text,
  planned_qty  text,
  status       text        NOT NULL CHECK (status IN ('已備料', '無需備料')),
  lines_count  int         NOT NULL DEFAULT 0,
  interface_id text,
  logged_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS argoerp_material_prep_log_mo_number_idx
  ON public.argoerp_material_prep_log (mo_number);
CREATE INDEX IF NOT EXISTS argoerp_material_prep_log_logged_at_idx
  ON public.argoerp_material_prep_log (logged_at DESC);

COMMENT ON TABLE  public.argoerp_material_prep_log        IS '批備料上傳至 ARGO ERP 及無需備料標記的逐筆歷程';
COMMENT ON COLUMN public.argoerp_material_prep_log.status IS '已備料（有上傳 ARGO）| 無需備料（人工標記）';

ALTER TABLE public.argoerp_material_prep_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_read  ON public.argoerp_material_prep_log;
DROP POLICY IF EXISTS allow_write ON public.argoerp_material_prep_log;
CREATE POLICY allow_read  ON public.argoerp_material_prep_log FOR SELECT USING (true);
CREATE POLICY allow_write ON public.argoerp_material_prep_log FOR ALL    USING (true) WITH CHECK (true);
