'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

type Profile = {
  real_name: string
  nickname: string
  department: string
  email: string
  last_login: string | null
}

// 之後要逐一接上的功能（先佔位）
const COMING_SOON = [
  { icon: '🎮', title: '我的點數', desc: '工作績效遊戲化' },
  { icon: '🔗', title: 'ERP 快速連結', desc: '以員工編碼直連' },
  { icon: '⭐', title: '打卡之星', desc: '出勤打卡' },
  { icon: '🕒', title: '線上打卡', desc: '上下班打卡' },
]

export default function ProfilePage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  const [nickname, setNickname] = useState('')
  const [savingNick, setSavingNick] = useState(false)
  const [nickMsg, setNickMsg] = useState('')

  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [savingPw, setSavingPw] = useState(false)
  const [pwMsg, setPwMsg] = useState('')

  useEffect(() => {
    fetch('/api/profile')
      .then(r => r.json())
      .then((d: Profile & { error?: string }) => {
        if (d && d.email) {
          setProfile(d)
          setNickname(d.nickname || '')
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const saveNickname = async () => {
    setSavingNick(true); setNickMsg('')
    try {
      const r = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || '儲存失敗')
      setNickMsg('✅ 已儲存')
    } catch (e) {
      setNickMsg('❌ ' + (e instanceof Error ? e.message : '儲存失敗'))
    } finally {
      setSavingNick(false)
      setTimeout(() => setNickMsg(''), 4000)
    }
  }

  const changePassword = async () => {
    setPwMsg('')
    if (!curPw || !newPw) { setPwMsg('❌ 請輸入目前密碼與新密碼'); return }
    if (newPw.length < 6) { setPwMsg('❌ 新密碼至少 6 碼'); return }
    if (newPw !== confirmPw) { setPwMsg('❌ 兩次新密碼不一致'); return }
    setSavingPw(true)
    try {
      const r = await fetch('/api/profile/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: curPw, new_password: newPw }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || '更新失敗')
      setPwMsg('✅ 密碼已更新')
      setCurPw(''); setNewPw(''); setConfirmPw('')
    } catch (e) {
      setPwMsg('❌ ' + (e instanceof Error ? e.message : '更新失敗'))
    } finally {
      setSavingPw(false)
    }
  }

  const inputCls = 'w-full bg-slate-950/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-cyan-500 focus:outline-none'
  const cardCls = 'bg-slate-900/50 border border-slate-700 rounded-2xl p-5 md:p-6 backdrop-blur-sm'

  return (
    <div className="min-h-screen bg-[#050b14] text-slate-300 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 text-sm text-slate-400 hover:text-cyan-400 transition-colors"
          >
            <span className="text-lg">←</span> 返回首頁
          </button>
          <h1 className="text-xl md:text-2xl font-bold text-white">個人中心</h1>
        </div>

        {loading ? (
          <div className="text-center text-slate-500 py-20">載入中…</div>
        ) : !profile ? (
          <div className="text-center text-red-400 py-20">無法載入個人資料，請重新登入後再試。</div>
        ) : (
          <div className="flex flex-col gap-5">
            {/* 基本資料 */}
            <section className={cardCls}>
              <h2 className="text-white font-bold mb-4 flex items-center gap-2">
                <span className="w-2 h-5 bg-cyan-500 rounded-full" /> 基本資料
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <ReadOnly label="姓名" value={profile.real_name || '—'} />
                <ReadOnly label="部門" value={profile.department || '—'} />
                <ReadOnly label="Email（登入帳號）" value={profile.email} hint="如需修改請洽管理員" />
                <ReadOnly
                  label="最後登入"
                  value={profile.last_login ? new Date(profile.last_login).toLocaleString() : '—'}
                />
              </div>

              <div className="mt-5 pt-5 border-t border-slate-800">
                <label className="block text-xs text-slate-400 mb-1">暱稱（可自行修改）</label>
                <div className="flex gap-2">
                  <input
                    value={nickname}
                    onChange={e => setNickname(e.target.value)}
                    placeholder="輸入暱稱"
                    className={inputCls}
                  />
                  <button
                    onClick={saveNickname}
                    disabled={savingNick}
                    className="shrink-0 px-4 py-2 rounded-lg bg-cyan-900/40 border border-cyan-600 text-cyan-300 text-sm font-bold hover:bg-cyan-800/50 disabled:opacity-50"
                  >
                    {savingNick ? '儲存中…' : '儲存'}
                  </button>
                </div>
                {nickMsg && <p className="text-xs mt-2 text-slate-300">{nickMsg}</p>}
              </div>
            </section>

            {/* 修改密碼 */}
            <section className={cardCls}>
              <h2 className="text-white font-bold mb-4 flex items-center gap-2">
                <span className="w-2 h-5 bg-amber-500 rounded-full" /> 修改密碼
              </h2>
              <div className="flex flex-col gap-3 max-w-md">
                <input type="password" autoComplete="current-password" placeholder="目前密碼"
                  value={curPw} onChange={e => setCurPw(e.target.value)} className={inputCls} />
                <input type="password" autoComplete="new-password" placeholder="新密碼（至少 6 碼）"
                  value={newPw} onChange={e => setNewPw(e.target.value)} className={inputCls} />
                <input type="password" autoComplete="new-password" placeholder="再次輸入新密碼"
                  value={confirmPw} onChange={e => setConfirmPw(e.target.value)} className={inputCls} />
                <button
                  onClick={changePassword}
                  disabled={savingPw}
                  className="self-start px-5 py-2 rounded-lg bg-amber-900/40 border border-amber-600 text-amber-300 text-sm font-bold hover:bg-amber-800/50 disabled:opacity-50"
                >
                  {savingPw ? '更新中…' : '更新密碼'}
                </button>
                {pwMsg && <p className="text-sm text-slate-300">{pwMsg}</p>}
              </div>
            </section>

            {/* 預留功能 */}
            <section className={cardCls}>
              <h2 className="text-white font-bold mb-4 flex items-center gap-2">
                <span className="w-2 h-5 bg-slate-500 rounded-full" /> 更多功能
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {COMING_SOON.map(f => (
                  <div key={f.title}
                    className="relative bg-slate-950/40 border border-slate-800 rounded-xl p-4 text-center opacity-70">
                    <div className="text-2xl mb-1">{f.icon}</div>
                    <div className="text-sm font-bold text-slate-200">{f.title}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{f.desc}</div>
                    <span className="inline-block mt-2 text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                      即將推出
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function ReadOnly({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm text-white font-medium break-all">{value}</div>
      {hint && <div className="text-[10px] text-slate-600 mt-0.5">{hint}</div>}
    </div>
  )
}
