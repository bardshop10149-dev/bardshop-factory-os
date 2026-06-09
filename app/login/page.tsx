'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const REMEMBER_EMAIL_KEY = 'bardshop_remember_email'

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false)
  const [formData, setFormData] = useState({ email: '', password: '' })
  const [rememberMe, setRememberMe] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const router = useRouter()

  useEffect(() => {
    const rememberedEmail = localStorage.getItem(REMEMBER_EMAIL_KEY)
    if (rememberedEmail) {
      setFormData(prev => ({ ...prev, email: rememberedEmail }))
      setRememberMe(true)
    }
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setErrorMsg('')

    try {
      // 送到 /api/auth/login；伺服器端完成 Supabase Auth 驗證並設定 httpOnly cookies
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formData.email, password: formData.password }),
      })

      const json = await res.json() as { ok?: boolean; error?: string; name?: string; email?: string; role?: string }

      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? '登入失敗')
      }

      // 記住我（僅 email，不存密碼）
      if (rememberMe) {
        localStorage.setItem(REMEMBER_EMAIL_KEY, formData.email)
      } else {
        localStorage.removeItem(REMEMBER_EMAIL_KEY)
      }

      // 儲存使用者基本資訊供前端顯示（非敏感）
      if (json.email) localStorage.setItem('bardshop_user_email', json.email)
      if (json.name)  localStorage.setItem('bardshop_user_name',  json.name)

      // Cookies（bardshop-token, bardshop-role, bardshop-permissions）已由 API 設定
      router.push('/')

    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : '登入失敗')
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#050b14] text-slate-300 font-sans selection:bg-cyan-500 selection:text-white relative flex flex-col items-center justify-center overflow-hidden">
      
      {/* 背景特效 */}
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 brightness-100 contrast-150"></div>
        <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-blue-900/10 via-transparent to-slate-900/90"></div>
        <div className="absolute inset-0 opacity-[0.15]" 
             style={{ backgroundImage: 'linear-gradient(rgba(6, 182, 212, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(6, 182, 212, 0.1) 1px, transparent 1px)', backgroundSize: '40px 40px' }}>
        </div>
      </div>

      {/* 登入卡片 */}
      <div className="relative z-10 w-full max-w-md p-1">
        <div className="absolute inset-0 border border-cyan-500/30 rounded-2xl blur-[2px]"></div>
        <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-cyan-400 rounded-tl-lg"></div>
        <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-cyan-400 rounded-br-lg"></div>

        <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 shadow-2xl">
          
          <div className="text-center mb-10">
            <h1 className="text-3xl font-black text-white tracking-widest mb-2">BARDSHOP</h1>
            <p className="text-xs text-cyan-400 font-mono tracking-[0.4em] uppercase">Enterprise Portal</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-xs font-mono text-slate-500 uppercase tracking-wider mb-2">Email Account</label>
              <div className="relative group">
                <input 
                  type="email" 
                  required
                  className="w-full bg-slate-950/50 border border-slate-700 text-white px-4 py-3 rounded-lg focus:outline-none focus:border-cyan-500 focus:shadow-[0_0_15px_rgba(6,182,212,0.3)] transition-all font-mono"
                  placeholder="admin@bardshop.com"
                  value={formData.email}
                  onChange={e => setFormData({...formData, email: e.target.value})}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-mono text-slate-500 uppercase tracking-wider mb-2">Password</label>
              <input 
                type="password" 
                required
                className="w-full bg-slate-950/50 border border-slate-700 text-white px-4 py-3 rounded-lg focus:outline-none focus:border-cyan-500 focus:shadow-[0_0_15px_rgba(6,182,212,0.3)] transition-all font-mono tracking-widest"
                placeholder="••••••••"
                value={formData.password}
                onChange={e => setFormData({...formData, password: e.target.value})}
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-400 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-500 focus:ring-cyan-500"
              />
              記住我
            </label>

            {errorMsg && (
              <div className="p-3 bg-red-900/20 border border-red-500/50 rounded text-red-400 text-xs text-center font-bold animate-pulse">
                {errorMsg}
              </div>
            )}

            <button 
              type="submit" 
              disabled={isLoading}
              className={`
                w-full py-4 rounded-lg font-bold text-sm tracking-widest uppercase transition-all duration-300 relative overflow-hidden group
                ${isLoading ? 'bg-cyan-900 text-cyan-400 cursor-not-allowed' : 'bg-cyan-600 text-white hover:bg-cyan-500 shadow-lg shadow-cyan-900/50'}
              `}
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                  Verifying...
                </span>
              ) : (
                <span className="relative z-10">Login System</span>
              )}
            </button>

            <div className="text-center">
              <Link
                href="/apply-account"
                className="text-xs font-mono text-cyan-400 hover:text-cyan-300 underline underline-offset-4"
              >
                沒有帳號？申請帳號
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}