import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables')
}

// ── 資料表查詢改走同源代查閘門（2026-09-27 資安修復）─────────────────────────
// anon key 隨 JS bundle 送到每個瀏覽器，等於公開；以前 `.from()` 直連 Supabase 代表
// 任何人不登入就能 dump 生產資料表。現在把 supabase-js 的 base URL 指到我們自己的
// /api/db，它會自動接成 /api/db/rest/v1/<table>?select=...，由
// app/api/db/rest/v1/[table]/route.ts 驗過登入 cookie、對照白名單後再以 service role 代查。
// 查詢語法（.select/.eq/.range/.order/count…）完全不變，因為那些本來就只是查詢字串。
//
// SSR 時（client component 首次在伺服器渲染）window 不存在，這裡給個占位網址就好：
// 所有查詢都在 useEffect / 事件裡跑，伺服器端不會真的打出去。
const apiBase = typeof window !== 'undefined' ? `${window.location.origin}/api/db` : 'http://localhost/api/db'

const viaApi = createClient(apiBase, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

// Storage（附件上傳／公開網址）與 Auth（重設密碼頁的 recovery session、signOut）仍直連 Supabase：
// 這兩個服務靠 storage policy / Auth 自身把關，不經 PostgREST。
const direct = createClient(supabaseUrl, supabaseKey)

/**
 * 刻意只暴露這四個成員——
 *   - 沒有 channel / removeChannel：資料表鎖上 RLS 後，anon 的 postgres_changes 訂閱收不到
 *     任何事件，需要即時更新的頁面請改輪詢（見 app/tasks/page.tsx）。
 *   - 沒有 rpc：不開放前端直接呼叫資料庫函式。
 */
export const supabase = {
  from: (table) => viaApi.from(table),
  storage: direct.storage,
  auth: direct.auth,
}
