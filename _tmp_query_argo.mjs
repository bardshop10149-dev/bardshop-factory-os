const API_BASE = 'http://140.245.91.36/ords/workstation/ArgoAPI';
const USERNAME = 'ARGOIFAF', PASSWORD = 'ARGOIFAF', SEGMENT = 'BARDSHOP';

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { console.error('RAW:', text.slice(0, 300)); return null; }
}

const keyData = await post(API_BASE + '/S_APIKEY', { username: USERNAME, password: PASSWORD });
if (!keyData) process.exit(1);
const { APIKEY1: k1, APIKEY2: k2, APIKEY3: k3 } = keyData.RESULT;
console.log('Keys OK');

// 抓特定採購單 PO26042836 的明細，看所有欄位
const d = await post(API_BASE + '/S_QUERY', {
  sparam: JSON.stringify({
    APIKEY1: k1, APIKEY2: k2, APIKEY3: k3,
    SEGMENT, TABLE: 'PJ_PROJECTDETAIL',
    SHOWNULLCOLUMN: 'Y',
    PJT_PROJECT_ID: "= 'PO26042836'",
    LINE_NO: '>= 1',
  }),
});
const rows = d && Array.isArray(d.RESULT) ? d.RESULT : [];
console.log(`Rows: ${rows.length}`);
if (rows.length > 0) {
  console.log('\nAll columns:', Object.keys(rows[0]).join(', '));
  console.log('\nFull row[0]:', JSON.stringify(rows[0], null, 2));
} else {
  console.log('Error/empty:', JSON.stringify(d)?.slice(0, 500));
}
