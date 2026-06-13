'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabaseClient'

/**
 * 密碼重設落地頁。
 * 使用者點重設信中的連結進來時，網址 hash 會帶 recovery token，
 * supabaseClient（預設 detectSessionInUrl）會自動建立 recovery session，
 * 此頁讓使用者輸入新密碼並 updateUser。
 */
export default function ResetPasswordPage() {
  const router = useRouter()
  const [checking, setChecking] = useState(true)
  const [ready, setReady] = useState(false)
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    let settled = false
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) { settled = true; setReady(true); setChecking(false) }
    })
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) { settled = true; setReady(true); setChecking(false) }
      // 給 detectSessionInUrl 一點時間解析網址 hash
      setTimeout(() => { if (!settled) setChecking(false) }, 1500)
    })
    return () => subscription.unsubscribe()
  }, [])

  const submit = async () => {
    setMsg('')
    if (newPw.length < 6) { setMsg('❌ 新密碼至少 6 碼'); return }
    if (newPw !== confirmPw) { setMsg('❌ 兩次密碼不一致'); return }
    setSaving(true)
    try {
      const { error } = await supabase.auth.updateUser({ password: newPw })
      if (error) throw error
      setDone(true)
      setMsg('✅ 密碼已重設，即將前往登入頁…')
      await supabase.auth.signOut().catch(() => {})
      setTimeout(() => router.push('/login'), 2500)
    } catch (e) {
      setMsg('❌ ' + (e instanceof Error ? e.message : '重設失敗，連結可能已過期，請重新申請'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#050b14] text-slate-300 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900/60 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 shadow-2xl">
        <h1 className="text-2xl font-black text-white tracking-widest text-center mb-1">重設密碼</h1>
        <p className="text-xs text-cyan-400 font-mono tracking-[0.4em] uppercase text-center mb-8">Reset Password</p>

        {checking ? (
          <p className="text-center text-slate-500 py-8">驗證連結中…</p>
        ) : !ready ? (
          <div className="text-center py-6">
            <p className="text-red-400 text-sm mb-4">連結無效或已過期。</p>
            <button onClick={() => router.push('/login')} className="text-cyan-400 underline underline-offset-4 text-sm">
              返回登入頁重新申請
            </button>
          </div>
        ) : done ? (
          <p className="text-center text-cyan-300 py-8">{msg}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                placeholder="新密碼（至少 6 碼）"
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                className="w-full bg-slate-950/60 border border-slate-700 rounded-lg px-4 py-3 pr-14 text-white font-mono focus:border-cyan-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-cyan-400 text-xs font-mono"
              >
                {showPw ? '隱藏' : '顯示'}
              </button>
            </div>
            <input
              type={showPw ? 'text' : 'password'}
              placeholder="再次輸入新密碼"
              value={confirmPw}
              onChange={e => setConfirmPw(e.target.value)}
              className="w-full bg-slate-950/60 border border-slate-700 rounded-lg px-4 py-3 text-white font-mono focus:border-cyan-500 focus:outline-none"
            />
            <button
              onClick={submit}
              disabled={saving}
              className="w-full py-3 rounded-lg bg-cyan-600 text-white font-bold tracking-widest uppercase hover:bg-cyan-500 disabled:opacity-50 transition-all"
            >
              {saving ? '處理中…' : '設定新密碼'}
            </button>
            {msg && <p className="text-sm text-center text-slate-300">{msg}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
