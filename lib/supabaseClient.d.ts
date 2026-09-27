import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * 前端 Supabase client（詳見 supabaseClient.js 的說明）。
 * 只開放 from / storage / auth；channel、rpc 等刻意不在型別上，用到會直接編譯失敗。
 */
export const supabase: Pick<SupabaseClient, 'from' | 'storage' | 'auth'>
