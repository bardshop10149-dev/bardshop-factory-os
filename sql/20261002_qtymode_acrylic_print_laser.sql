-- 2026-10-02  壓克力途程的印刷站／雷切站工序改用「盤數」計算工時
--
-- 依據：生管確認「所有壓克力的印刷與雷切都要用盤數計算工時，4mm 以上也一樣」。
--
-- 為什麼原本不是盤數：route_operations.qty_mode 的欄位預設就是「個數」，2026-08-24
-- 建欄位後生管只切了 150/631 筆，剩下的停在預設值。可以看出是漏設而非刻意——
-- 同品類的其他厚度都已經是盤數（2mm 壓克力片／畫板＝盤數，3mm 同品類＝個數；
-- 3mm+1mm 貼合＝盤數，3mm 片＝個數），而且「3mm 壓克力串3串鑰匙圈」同一品類內部
-- 就個數／盤數混用。
--
-- 影響：191 筆（印刷 126 筆、雷切 65 筆）。套用後重新模擬，工時總量 330,223 →
-- 329,669 小時，因缺盤數被擋下的列佔 2.6%。
--
-- 回復：見 sql/20261002_qtymode_rollback.sql（逐筆還原成改動前的值）。
--
-- 全檔可重複執行（idempotent）。

update public.route_operations ro
   set qty_mode = '盤數'
 where ro.route_id like '%壓克力%'
   and ro.qty_mode <> '盤數'
   and exists (
     select 1 from public.operation_times ot
      where ot.op_name = ro.op_name
        and (ot.station like '%印刷%' or ot.station like '%雷切%')
   );
