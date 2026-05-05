-- ============================================================
-- 將機台清單、機台分配、列印紀錄、訂單暫緩區 從 localStorage 遷移至 Supabase
-- ============================================================

-- 1. 機台名稱清單（共用）
CREATE TABLE IF NOT EXISTS public.argoerp_machines (
  id         bigserial PRIMARY KEY,
  name       text      NOT NULL UNIQUE,
  sort_order int       NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.argoerp_machines ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='argoerp_machines' AND policyname='allow_read') THEN
    EXECUTE 'CREATE POLICY allow_read ON public.argoerp_machines FOR SELECT USING (true)';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='argoerp_machines' AND policyname='allow_write') THEN
    EXECUTE 'CREATE POLICY allow_write ON public.argoerp_machines USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- 2. 製令列印紀錄（audit log）
CREATE TABLE IF NOT EXISTS public.argoerp_mo_print_log (
  id         bigserial PRIMARY KEY,
  mo_number  text        NOT NULL,
  printed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS argoerp_mo_print_log_mo_idx ON public.argoerp_mo_print_log (mo_number);
ALTER TABLE public.argoerp_mo_print_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='argoerp_mo_print_log' AND policyname='allow_read') THEN
    EXECUTE 'CREATE POLICY allow_read ON public.argoerp_mo_print_log FOR SELECT USING (true)';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='argoerp_mo_print_log' AND policyname='allow_write') THEN
    EXECUTE 'CREATE POLICY allow_write ON public.argoerp_mo_print_log USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- 3. 訂單暫緩區
CREATE TABLE IF NOT EXISTS public.argoerp_staging (
  id            bigserial PRIMARY KEY,
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
  hold_reason   text    NOT NULL DEFAULT '',
  staged_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.argoerp_staging ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='argoerp_staging' AND policyname='allow_read') THEN
    EXECUTE 'CREATE POLICY allow_read ON public.argoerp_staging FOR SELECT USING (true)';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='argoerp_staging' AND policyname='allow_write') THEN
    EXECUTE 'CREATE POLICY allow_write ON public.argoerp_staging USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- 4. 確保 argoerp_mo_summary 有 machine 欄位（供機台分配儲存）
ALTER TABLE public.argoerp_mo_summary ADD COLUMN IF NOT EXISTS machine text;
