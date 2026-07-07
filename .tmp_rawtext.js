const fs = require("fs");
function env(p){const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<=0)continue;let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);o[t.slice(0,i).trim()]=v;}return o;}
const e=env(".env.local");
const {createClient}=require("@supabase/supabase-js");
const sb=createClient(e.NEXT_PUBLIC_SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY);
(async()=>{
  // 查最近有資料的幾張 sheet 的 raw_text，看裡面有沒有常平/委外
  const {data}=await sb.from("daily_order_sheets").select("sheet_date,raw_text,rows").order("sheet_date",{ascending:false}).limit(6);
  for(const d of data||[]){
    const rows=Array.isArray(d.rows)?d.rows:[];
    const rawLen=d.raw_text?d.raw_text.length:0;
    const hasCP=d.raw_text&&(d.raw_text.includes("常平")||d.raw_text.includes("委外"));
    const rowsC=rows.filter(r=>r&&r.factory==="C").length;
    const rowsO=rows.filter(r=>r&&r.factory==="O").length;
    console.log(d.sheet_date+": raw_text="+rawLen+"chars hasCP="+hasCP+" saved_C="+rowsC+" saved_O="+rowsO);
    if(hasCP && rows.length>0){
      // 看有沒有 doc_type 含常平/委外 的行
      const cpRows=rows.filter(r=>r&&((r.doc_type||"").includes("常平")||(r.doc_type||"").includes("委外")));
      console.log("  -> rows with 常平/委外 doc_type: "+cpRows.length);
      if(cpRows.length===0){
        // 看 raw_text 裡前幾行含常平/委外的
        const lines=(d.raw_text||"").split("\n").filter(l=>l.includes("常平")||l.includes("委外")).slice(0,3);
        console.log("  -> raw_text sample lines: "+JSON.stringify(lines.map(l=>l.slice(0,80))));
      }
    }
  }
})();
