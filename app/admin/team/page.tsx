'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../lib/supabaseClient'
import { logSystemAction } from '../../../lib/logger'

// 定義成員資料介面
interface Member {
  id?: number
  auth_user_id?: string | null
  real_name: string
  nickname: string
  department: string
  email: string
  password?: string
  permissions: string[]
  status: string
  is_admin: boolean
  is_pending_approval?: boolean
  last_login?: string
}

// 定義部門介面
interface Department {
  id: number
  name: string
}

const normalizeLegacyPermissions = (rawPermissions: string[] = []) => {
  const normalized = new Set<string>()

  rawPermissions.forEach((permission) => {
    if (permission === 'production') normalized.add('dashboard')
    else if (permission === 'admin') {
      normalized.add('production_admin')
      normalized.add('system_settings')
    } else normalized.add(permission)
  })

  return Array.from(normalized)
}

const isMissingPendingColumnError = (error: { message?: string } | null | undefined) =>
  Boolean(error?.message?.includes("is_pending_approval"))

export default function TeamPage() {
  const [members, setMembers] = useState<Member[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(false)
  const [syncingAuthUsers, setSyncingAuthUsers] = useState(false)
  const [currentUserEmail, setCurrentUserEmail] = useState<string>('')
  const [pendingOnly, setPendingOnly] = useState(false)
  
  // 抽屜與模態框控制
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [isDeptModalOpen, setIsDeptModalOpen] = useState(false)
  
  const [formData, setFormData] = useState<Member>(getEmptyForm())
  const [newDeptName, setNewDeptName] = useState('')

  // 權限模組定義
  const permissionSections = [
    {
      title: '基本權限',
      options: [
        { key: 'dashboard', label: '產線看板 (Dashboard)' },
        { key: 'notice', label: '產期告示/試算/預留 (Notice & Estimator)' },
        { key: 'qa_report', label: '異常單建立/回報 (QA Report)' },
        { key: 'tasks', label: '任務看板 (Task Flow)' },
      ]
    },
    {
      title: '管理權限',
      options: [
        { key: 'qa', label: '品保專區 (QA)' },
        { key: 'production_admin', label: '生產管理 (Production Admin)' },
        { key: 'system_settings', label: '系統設定 (System Settings)' },
        { key: 'argo_db', label: 'ARGO資料庫 (ARGO Database)' },
      ]
    },
    {
      title: '功能專區',
      options: [
        { key: 'design', label: '美編天地 (Design Studio)' },
        { key: 'material', label: '發料/領料 (Material Dispatch)' },
        { key: 'product_dev', label: '商品開發 (Product Dev)' },
        { key: 'info_board', label: '業務資訊看板 (Info Board)' },
        { key: 'argo_tool', label: 'ARGO 外掛區 (ARGO Tool)' },
        { key: 'purchasing', label: '採購專區 (Purchasing)' },
      ]
    }
  ]

  const allPermissionKeys = permissionSections.flatMap(section => section.options.map(option => option.key))

  function getEmptyForm(): Member {
    return {
      real_name: '',
      nickname: '',
      department: '',
      email: '',
      password: '',
      permissions: ['dashboard', 'notice', 'tasks', 'qa_report'], // 預設給予基本權限
      status: 'Active',
      is_admin: false,
      is_pending_approval: false,
    }
  }

  const checkCurrentUser = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user && user.email) setCurrentUserEmail(user.email)
  }, [])

  const fetchData = useCallback(async () => {
    setLoading(true)
    const [membersRes, deptsRes] = await Promise.all([
      supabase
        .from('members')
        .select('id, auth_user_id, real_name, nickname, department, email, password, permissions, status, is_admin, is_pending_approval, last_login')
        .order('is_admin', { ascending: false })
        .order('id', { ascending: true }),
      supabase.from('departments').select('*').order('id', { ascending: true })
    ])

    if (membersRes.error) console.error(membersRes.error)
    else {
      const normalizedMembers = ((membersRes.data as Member[]) || []).map(member => ({
        ...member,
        permissions: normalizeLegacyPermissions(Array.isArray(member.permissions) ? member.permissions : []),
        is_pending_approval:
          Boolean(member.is_pending_approval) ||
          member.status === 'PendingApproval' ||
          (!Boolean(member.is_admin) && normalizeLegacyPermissions(Array.isArray(member.permissions) ? member.permissions : []).length === 0),
      }))
      setMembers(normalizedMembers)
    }

    if (deptsRes.error) console.error(deptsRes.error)
    else setDepartments((deptsRes.data as Department[]) || [])

    setLoading(false)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchData()
      void checkCurrentUser()
    }, 0)
    return () => clearTimeout(timer)
  }, [fetchData, checkCurrentUser])

  // --- 成員儲存邏輯 ---
  const handleSaveMember = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.email || !formData.real_name || !formData.department) return alert('請填寫所有必填欄位')

    // 1. 檢查名稱唯一性 (Task Board 依賴名稱指派)
    const nameDuplicate = members.find(m => m.real_name === formData.real_name && m.id !== formData.id)
    if (nameDuplicate) {
      return alert(`錯誤：已存在名為「${formData.real_name}」的成員，請使用不同名稱以避免任務指派混淆。`)
    }

    // 2. 檢查 Email 唯一性 (系統依賴 Email 辨識身分)
    const emailDuplicate = members.find(m => m.email === formData.email && m.id !== formData.id)
    if (emailDuplicate) {
        return alert(`錯誤：Email「${formData.email}」已被使用。`)
    }

    // 若勾選管理員，強制給予所有權限
    let finalPermissions = formData.permissions
    if (formData.is_admin) {
      finalPermissions = allPermissionKeys
    }

    const isPendingApproval = !formData.is_admin && finalPermissions.length === 0

    const payloadBase = {
      ...formData,
      permissions: finalPermissions,
      status: isPendingApproval ? 'PendingApproval' : (formData.status === 'PendingApproval' ? 'Active' : formData.status),
    }
    const payloadWithPending = {
      ...payloadBase,
      is_pending_approval: isPendingApproval,
    }

    if (formData.id && !formData.password) {
      delete payloadBase.password
      delete payloadWithPending.password
    }

    let error
    if (formData.id) {
      const { error: updateError } = await supabase.from('members').update(payloadWithPending).eq('id', formData.id)
      if (isMissingPendingColumnError(updateError)) {
        const { error: retryError } = await supabase.from('members').update(payloadBase).eq('id', formData.id)
        error = retryError
      } else {
        error = updateError
      }
    } else {
      if (!formData.password) return alert('新增成員請設定密碼 (供備註與登入使用)')
      const response = await fetch('/api/admin/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payloadWithPending,
          password: formData.password,
        }),
      })

      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string }
        error = { message: result.error || `HTTP ${response.status}` }
      }
    }

    // 修正：既有成員若有輸入新密碼，呼叫後端把密碼真正寫進 Supabase Auth。
    // （原本只更新了 members.password，Auth 不會變，導致改了密碼仍登不進去）
    if (!error && formData.id && formData.password) {
      const pwRes = await fetch('/api/admin/members/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: formData.id, password: formData.password }),
      })
      if (!pwRes.ok) {
        const result = await pwRes.json().catch(() => ({})) as { error?: string }
        error = { message: result.error || `更新登入密碼失敗 (HTTP ${pwRes.status})` }
      }
    }

    if (error) {
      alert(`儲存失敗: ${error.message}`)
    } else {
      await logSystemAction({
        actionType: formData.id ? '修改成員' : '新增成員',
        target: `member:${formData.email}`,
        module: '系統設定',
        details: `${formData.real_name} / ${formData.department}`,
        metadata: {
          memberId: formData.id ?? null,
          permissions: finalPermissions,
          isAdmin: formData.is_admin,
        }
      })
      alert('成員儲存成功！資料已同步至任務系統。')
      setIsDrawerOpen(false)
      void fetchData()
    }
  }

  const handleDeleteMember = async (member: Member) => {
    if (member.email === currentUserEmail) return alert('無法刪除自己！')
    if (!confirm(`確定要刪除「${member.real_name}」嗎？\n注意：該成員的歷史任務紀錄將保留，但無法再登入。`)) return
    
    const { error } = await supabase.from('members').delete().eq('id', member.id)
    if (error) alert(error.message)
    else {
      await logSystemAction({
        actionType: '刪除成員',
        target: `member:${member.email}`,
        module: '系統設定',
        details: `${member.real_name} / ${member.department}`,
        metadata: { memberId: member.id ?? null }
      })
      void fetchData()
    }
  }

  // --- 部門管理邏輯 ---
  const handleAddDept = async () => {
    if (!newDeptName.trim()) return
    const { error } = await supabase.from('departments').insert([{ name: newDeptName.trim() }])
    if (error) {
      alert('新增失敗 (名稱可能重複)')
    } else {
      await logSystemAction({
        actionType: '新增部門',
        target: `department:${newDeptName.trim()}`,
        module: '系統設定',
        details: '組織成員管理 > 部門維護',
      })
      setNewDeptName('')
      void fetchData()
    }
  }

  const handleDeleteDept = async (deptName: string, id: number) => {
    // 檢查是否有成員屬於此部門
    const hasMembers = members.some(m => m.department === deptName)
    if (hasMembers) {
        return alert(`無法刪除「${deptName}」：尚有成員屬於此部門。\n請先將成員轉移至其他部門。`)
    }

    if (!confirm(`確定要刪除部門「${deptName}」嗎？`)) return
    const { error } = await supabase.from('departments').delete().eq('id', id)
    if (error) alert(error.message)
    else {
      await logSystemAction({
        actionType: '刪除部門',
        target: `department:${deptName}`,
        module: '系統設定',
        details: '組織成員管理 > 部門維護',
        metadata: { departmentId: id }
      })
      void fetchData()
    }
  }

  // --- UI 控制 ---
  const openEdit = (member: Member) => {
    setFormData({ ...member, permissions: normalizeLegacyPermissions(member.permissions || []), password: '' })
    setIsDrawerOpen(true)
  }

  const openNew = () => {
    const defaultDept = departments.length > 0 ? departments[0].name : ''
    setFormData({ ...getEmptyForm(), department: defaultDept })
    setIsDrawerOpen(true)
  }

  const togglePermission = (key: string) => {
    setFormData(prev => {
      const current = prev.permissions || []
      if (current.includes(key)) {
        return { ...prev, permissions: current.filter(p => p !== key) }
      } else {
        return { ...prev, permissions: [...current, key] }
      }
    })
  }

  const pendingCount = members.filter(member => member.is_pending_approval).length
  const unsyncedCount = members.filter(member => !member.auth_user_id).length
  const visibleMembers = pendingOnly
    ? members.filter(member => member.is_pending_approval)
    : members

  const handleSyncAuthUsers = async () => {
    if (syncingAuthUsers) return
    if (!confirm(`將嘗試補齊 ${unsyncedCount} 筆尚未綁定 auth_user_id 的成員，是否繼續？`)) return

    setSyncingAuthUsers(true)
    try {
      const response = await fetch('/api/admin/members/sync', { method: 'POST' })
      const result = await response.json().catch(() => ({})) as {
        error?: string
        totalCandidates?: number
        updated?: number
        createdAuthUsers?: number
        skipped?: number
        failed?: Array<{ memberId: number; email: string; reason: string }>
      }

      if (!response.ok) {
        alert(result.error || `同步失敗 (HTTP ${response.status})`)
        return
      }

      const failedCount = result.failed?.length || 0
      const failPreview = (result.failed || [])
        .slice(0, 5)
        .map(item => `#${item.memberId} ${item.email}：${item.reason}`)
        .join('\n')

      alert(
        `同步完成\n` +
        `候選筆數：${result.totalCandidates || 0}\n` +
        `成功綁定：${result.updated || 0}\n` +
        `新建 Auth User：${result.createdAuthUsers || 0}\n` +
        `略過：${result.skipped || 0}\n` +
        `失敗：${failedCount}` +
        (failPreview ? `\n\n失敗前 5 筆：\n${failPreview}` : '')
      )

      await logSystemAction({
        actionType: '批次同步帳號',
        target: 'members:auth_user_id_sync',
        module: '系統設定',
        details: `成功 ${result.updated || 0} / 失敗 ${failedCount}`,
        metadata: {
          totalCandidates: result.totalCandidates || 0,
          updated: result.updated || 0,
          createdAuthUsers: result.createdAuthUsers || 0,
          skipped: result.skipped || 0,
          failed: failedCount,
        }
      })

      void fetchData()
    } finally {
      setSyncingAuthUsers(false)
    }
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto text-slate-300 min-h-screen relative font-sans">
      
      {/* 標題區 */}
      <div className="flex flex-col md:flex-row justify-between items-end mb-6 md:mb-8 gap-4">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white tracking-tight">組織成員管理</h1>
          <p className="text-orange-500/80 mt-1 font-mono text-sm uppercase">
            ACCESS CONTROL // 權限設定與成員列表
          </p>
        </div>
        
        <div className="flex gap-3">
          <button
            onClick={handleSyncAuthUsers}
            disabled={syncingAuthUsers}
            className={`px-4 py-2 rounded border transition-all font-bold text-sm ${syncingAuthUsers ? 'bg-slate-900 border-slate-700 text-slate-500 cursor-not-allowed' : 'bg-cyan-900/30 hover:bg-cyan-800/40 border-cyan-600 text-cyan-300'}`}
          >
            {syncingAuthUsers ? '同步中...' : `同步帳號 (${unsyncedCount})`}
          </button>

          <button
            onClick={() => setPendingOnly(prev => !prev)}
            className={`px-4 py-2 rounded border transition-all font-bold text-sm ${pendingOnly ? 'bg-yellow-500/20 border-yellow-400 text-yellow-300' : 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-slate-300'}`}
          >
            {pendingOnly ? `僅看待審核 (${pendingCount})` : `全部成員 (${members.length})`}
          </button>

          <button 
            onClick={() => setIsDeptModalOpen(true)}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded border border-slate-600 flex items-center gap-2 transition-all font-bold text-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
            管理部門
          </button>

          <button 
            onClick={openNew}
            className="bg-orange-600 hover:bg-orange-500 text-white px-6 py-2 rounded shadow-lg shadow-orange-900/50 flex items-center gap-2 transition-all font-bold"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" /></svg>
            建立新成員
          </button>
        </div>
      </div>

      {/* 成員列表 (Grid View) */}
      {loading ? (
        <div className="text-center py-20 text-slate-500 animate-pulse">載入成員資料中...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {visibleMembers.map((member) => (
            <div key={member.id} className={`bg-slate-900/50 rounded-xl border p-6 relative overflow-hidden group hover:border-orange-500/50 transition-all ${member.is_pending_approval ? 'border-yellow-400/90 pending-member-card' : member.is_admin ? 'border-orange-500/30 bg-orange-950/10' : 'border-slate-700'}`}>
              
              {/* 頂部裝飾條 */}
              <div className={`absolute top-0 left-0 w-full h-1 ${member.is_pending_approval ? 'bg-yellow-400' : member.status === 'Active' ? 'bg-orange-500' : 'bg-slate-600'}`}></div>

              {member.is_admin && (
                <div className="absolute top-2 right-2 text-orange-400 opacity-80" title="系統管理員">
                   <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
                </div>
              )}

              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-3">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center text-xl font-bold border ${member.is_admin ? 'bg-orange-600 text-white border-orange-400' : 'bg-slate-800 text-slate-300 border-slate-600'}`}>
                    {member.real_name.charAt(0)}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white leading-none flex items-center gap-2">
                      {member.real_name}
                      {member.is_admin && <span className="text-[10px] bg-red-600 text-white px-1.5 py-0.5 rounded font-bold">ADMIN</span>}
                    </h3>
                    <span className="text-xs text-slate-500 font-mono">{member.nickname || '-'}</span>
                  </div>
                </div>
                {/* 編輯/刪除按鈕 */}
                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                   <button onClick={() => openEdit(member)} className="text-slate-500 hover:text-white" title="編輯"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg></button>
                   <button onClick={() => handleDeleteMember(member)} className="text-slate-500 hover:text-red-400" title="刪除"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>
                </div>
              </div>

              <div className="space-y-3 mb-6">
                <div className="flex justify-between text-sm border-b border-slate-800 pb-2">
                  <span className="text-slate-500">部門</span>
                  <span className="text-slate-300 font-bold">{member.department}</span>
                </div>
                <div className="flex justify-between text-sm border-b border-slate-800 pb-2">
                  <span className="text-slate-500">Email</span>
                  <span className="text-slate-300 font-mono text-xs truncate max-w-[150px]" title={member.email}>{member.email}</span>
                </div>
              </div>

              {/* 權限標籤 */}
              <div className="flex flex-wrap gap-2">
                {member.is_admin ? (
                   <span className="px-2 py-1 rounded bg-red-900/30 text-red-400 text-[10px] border border-red-800 font-bold w-full text-center">
                     ★ 最高權限 (Full Access)
                   </span>
                ) : (
                  <>
                    {member.is_pending_approval && <span className="px-2 py-1 rounded bg-yellow-900/30 text-yellow-300 text-[10px] border border-yellow-600 font-bold">待管理員指派權限</span>}
                    {member.permissions?.includes('tasks') && <span className="px-2 py-1 rounded bg-blue-900/30 text-blue-400 text-[10px] border border-blue-800">任務看板</span>}
                    {member.permissions?.includes('dashboard') && <span className="px-2 py-1 rounded bg-cyan-900/30 text-cyan-400 text-[10px] border border-cyan-800">產線看板</span>}
                    {member.permissions?.includes('notice') && <span className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-[10px] border border-slate-600">產期告示/試算/預留</span>}
                    {member.permissions?.includes('qa_report') && <span className="px-2 py-1 rounded bg-rose-900/30 text-rose-400 text-[10px] border border-rose-800">異常單回報</span>}
                    {member.permissions?.includes('qa') && <span className="px-2 py-1 rounded bg-teal-900/30 text-teal-400 text-[10px] border border-teal-800">品保專區</span>}
                    {member.permissions?.includes('production_admin') && <span className="px-2 py-1 rounded bg-purple-900/30 text-purple-400 text-[10px] border border-purple-800">生產管理</span>}
                    {member.permissions?.includes('system_settings') && <span className="px-2 py-1 rounded bg-orange-900/30 text-orange-400 text-[10px] border border-orange-800">系統設定</span>}
                    {member.permissions?.includes('estimation') && <span className="px-2 py-1 rounded bg-sky-900/30 text-sky-400 text-[10px] border border-sky-800">試算</span>}
                    {member.permissions?.includes('argo_db') && <span className="px-2 py-1 rounded bg-orange-900/30 text-orange-300 text-[10px] border border-orange-700">ARGO資料庫</span>}
                    {member.permissions?.includes('design') && <span className="px-2 py-1 rounded bg-pink-900/30 text-pink-400 text-[10px] border border-pink-800">美編天地</span>}
                    {member.permissions?.includes('material') && <span className="px-2 py-1 rounded bg-yellow-900/30 text-yellow-400 text-[10px] border border-yellow-800">發料/領料</span>}
                    {member.permissions?.includes('product_dev') && <span className="px-2 py-1 rounded bg-green-900/30 text-green-400 text-[10px] border border-green-800">商品開發</span>}
                    {member.permissions?.includes('info_board') && <span className="px-2 py-1 rounded bg-amber-900/30 text-amber-400 text-[10px] border border-amber-800">業務資訊看板</span>}
                    {member.permissions?.includes('argo_tool') && <span className="px-2 py-1 rounded bg-cyan-900/30 text-cyan-300 text-[10px] border border-cyan-700">ARGO外掛區</span>}
                  </>
                )}
              </div>
            </div>
          ))}
          {visibleMembers.length === 0 && (
            <div className="col-span-full text-center text-slate-500 py-16 border border-dashed border-slate-700 rounded-xl">
              {pendingOnly ? '目前沒有待審核帳號' : '目前沒有成員資料'}
            </div>
          )}
        </div>
      )}

      {/* --- 右側滑出抽屜 (Create/Edit Drawer) --- */}
      <div className={`fixed inset-y-0 right-0 w-full md:w-[480px] bg-[#0f172a] shadow-2xl border-l border-slate-700 transform transition-transform duration-300 ease-in-out z-50 flex flex-col ${isDrawerOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-6 border-b border-slate-700 flex justify-between items-center bg-slate-900">
          <h2 className="text-xl font-bold text-white">{formData.id ? '編輯成員資料' : '建立新成員'}</h2>
          <button onClick={() => setIsDrawerOpen(false)} className="text-slate-500 hover:text-white"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <form id="memberForm" onSubmit={handleSaveMember} className="space-y-6">
            
            {/* 基本資料 */}
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-orange-500 uppercase tracking-wider border-b border-slate-700 pb-2">基本資料</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">真實姓名 * (任務指派名稱)</label>
                  <input required type="text" className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white focus:border-orange-500 focus:outline-none" value={formData.real_name} onChange={e => setFormData({...formData, real_name: e.target.value})} />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">暱稱</label>
                  <input type="text" className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white focus:border-orange-500 focus:outline-none" value={formData.nickname} onChange={e => setFormData({...formData, nickname: e.target.value})} />
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">所屬部門 *</label>
                {departments.length > 0 ? (
                  <select required className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white focus:border-orange-500 focus:outline-none" value={formData.department} onChange={e => setFormData({...formData, department: e.target.value})}>
                    <option value="" disabled>請選擇部門...</option>
                    {departments.map(dept => (
                      <option key={dept.id} value={dept.name}>{dept.name}</option>
                    ))}
                  </select>
                ) : (
                  <div className="text-red-400 text-xs p-2 bg-red-900/20 border border-red-800 rounded">請先至「管理部門」新增部門</div>
                )}
              </div>
            </div>

            {/* 帳號安全 */}
            <div className="space-y-4 pt-4">
              <h3 className="text-sm font-bold text-orange-500 uppercase tracking-wider border-b border-slate-700 pb-2">登入設定</h3>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Email * (登入用)</label>
                <input required type="email" className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white focus:border-orange-500 focus:outline-none font-mono" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">登入密碼 {formData.id && <span className="text-slate-500">(若不修改請留空)</span>}</label>
                <input type="password" required={!formData.id} className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white focus:border-orange-500 focus:outline-none font-mono" value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">帳號狀態</label>
                <select className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white focus:border-orange-500 focus:outline-none" value={formData.status} onChange={e => setFormData({...formData, status: e.target.value})}>
                  <option value="Active">啟用 (Active)</option>
                  <option value="Suspended">停權 (Suspended)</option>
                  <option value="PendingApproval">待審核 (PendingApproval)</option>
                </select>
              </div>
            </div>

            {/* 權限設定 */}
            <div className="space-y-4 pt-4">
              <h3 className="text-sm font-bold text-orange-500 uppercase tracking-wider border-b border-slate-700 pb-2">權限設定</h3>
              
              <label className={`flex items-center p-4 rounded border cursor-pointer transition-all ${formData.is_admin ? 'bg-red-900/30 border-red-500' : 'bg-slate-800 border-slate-700'}`}>
                <div className="relative flex items-center">
                  <input type="checkbox" className="sr-only peer" checked={formData.is_admin} onChange={(e) => setFormData({...formData, is_admin: e.target.checked})} />
                  <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
                </div>
                <div className="ml-3">
                  <span className={`block text-sm font-bold ${formData.is_admin ? 'text-red-400' : 'text-slate-400'}`}>設定為「系統管理員」</span>
                  <span className="text-xs text-slate-500">擁有最高權限，可新增/刪除會員</span>
                </div>
              </label>

              <div className={`grid gap-4 transition-opacity ${formData.is_admin ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
                <p className="text-xs text-slate-500 mb-1">一般權限 (若勾選核心管理員則自動包含全部)</p>
                {permissionSections.map(section => (
                  <div key={section.title} className="space-y-2">
                    <p className="text-xs text-slate-400 font-bold">{section.title}</p>
                    {section.options.map(option => (
                      <label key={option.key} className={`flex items-center p-3 rounded border cursor-pointer ${formData.permissions.includes(option.key) ? 'bg-orange-900/20 border-orange-500/50' : 'bg-slate-800 border-slate-700'}`}>
                        <input type="checkbox" className="w-5 h-5 rounded border-slate-600 text-orange-600 bg-slate-900" checked={formData.permissions.includes(option.key) || formData.is_admin} onChange={() => togglePermission(option.key)} disabled={formData.is_admin} />
                        <span className={`ml-3 text-sm font-bold ${formData.permissions.includes(option.key) ? 'text-white' : 'text-slate-400'}`}>{option.label}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>

          </form>
        </div>

        <div className="p-6 border-t border-slate-700 bg-slate-900">
          <button form="memberForm" type="submit" className="w-full bg-orange-600 hover:bg-orange-500 text-white font-bold py-3 rounded shadow-lg transition-all">確認儲存</button>
        </div>
      </div>
      
      {isDrawerOpen && <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" onClick={() => setIsDrawerOpen(false)}></div>}

      {/* --- 部門管理 Modal --- */}
      {isDeptModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setIsDeptModalOpen(false)}></div>
          <div className="relative bg-[#1e293b] w-full max-w-md rounded-xl border border-slate-600 shadow-2xl p-6">
            <h3 className="text-xl font-bold text-white mb-4">部門管理</h3>
            
            <div className="flex gap-2 mb-6">
              <input type="text" placeholder="輸入新部門名稱..." className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white focus:border-blue-500 focus:outline-none" value={newDeptName} onChange={(e) => setNewDeptName(e.target.value)} />
              <button onClick={handleAddDept} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded font-bold">新增</button>
            </div>

            <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
              {departments.length === 0 ? <p className="text-slate-500 text-center text-sm">暫無部門，請新增。</p> : departments.map(dept => (
                <div key={dept.id} className="flex justify-between items-center bg-slate-800/50 p-3 rounded border border-slate-700">
                  <span className="text-slate-300">{dept.name}</span>
                  <button onClick={() => handleDeleteDept(dept.name, dept.id)} className="text-slate-500 hover:text-red-400 p-1"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>
                </div>
              ))}
            </div>

            <div className="mt-6 text-right">
              <button onClick={() => setIsDeptModalOpen(false)} className="text-slate-400 hover:text-white text-sm">關閉視窗</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}