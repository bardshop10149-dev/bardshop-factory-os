'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../../lib/supabaseClient'

export default function ArgoDBGatePage() {
  const router = useRouter()
  const [checking, setChecking] = useState(true)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    const check = async () => {
      try {
        const { data: authData } = await supabase.auth.getUser()
        const authUserId = authData.user?.id || ''
        const email = authData.user?.email || localStorage.getItem('bardshop_user_email') || ''

        if (!email && !authUserId) {
          router.replace('/login')
          return
        }

        let memberData: { is_admin: boolean | null; permissions: string[] | null } | null = null

        if (authUserId) {
          const { data } = await supabase
            .from('members')
            .select('is_admin, permissions')
            .eq('auth_user_id', authUserId)
            .maybeSingle()
          memberData = data
        }

        if (!memberData && email) {
          const { data } = await supabase
            .from('members')
            .select('is_admin, permissions')
            .eq('email', email)
            .maybeSingle()
          memberData = data
        }

        const isAdmin = Boolean(memberData?.is_admin)
        const permissions: string[] = Array.isArray(memberData?.permissions) ? memberData!.permissions! : []
        const hasAccess = isAdmin || permissions.includes('argo_db')

        if (hasAccess) {
          router.replace('/admin/argoerp/erp-sync')
        } else {
          setDenied(true)
          setChecking(false)
        }
      } catch {
        setDenied(true)
        setChecking(false)
      }
    }
    void check()
  }, [router])

  if (checking) {
    return (
      <div className="min-h-screen bg-[#050b14] flex items-center justify-center">
        <div className="text-cyan-400 font-mono text-sm animate-pulse">驗證權限中...</div>
      </div>
    )
  }

  if (denied) {
    return (
      <div className="min-h-screen bg-[#050b14] flex items-center justify-center font-sans">
        <div className="bg-slate-900 border border-red-800 rounded-2xl p-10 max-w-md w-full text-center shadow-2xl">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-red-400 mb-3">存取被拒絕</h1>
          <p className="text-slate-400 text-sm mb-6 leading-relaxed">
            你沒有 <span className="text-orange-400 font-mono">ARGO資料庫</span> 的存取權限。<br />
            請聯絡核心管理員開通。
          </p>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-2 rounded border border-slate-600 text-slate-300 text-sm font-mono hover:bg-slate-700 transition-all"
          >
            ← 返回首頁
          </button>
        </div>
      </div>
    )
  }

  return null
}
