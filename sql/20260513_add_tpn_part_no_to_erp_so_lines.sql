-- 新增 tpn_part_no 欄位到 erp_so_lines（打樣/追加單號）
ALTER TABLE erp_so_lines
  ADD COLUMN IF NOT EXISTS tpn_part_no TEXT;
