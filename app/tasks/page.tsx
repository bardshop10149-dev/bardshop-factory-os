'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useEffect, useCallback } from 'react' // 引入 useCallback
import { supabase } from '../../lib/supabaseClient'

// --- 定義資料介面 ---
interface Member {
  id: number
  real_name: string
  department: string
  email: string
  is_admin: boolean 
}

interface Department {
  id: number
  name: string
}

interface TaskItem {
  id: number
  title: string
  content: string
  sender_id?: number
  sender_name: string
  target_dept: string
  assigned_to: string[]
  status: string
  transfer_count?: number
  is_read?: boolean
  updated_at: string
}

interface TaskMessage {
  id: number
  task_id: number
  user_name: string
  content: string
  type: string
  created_at: string
}

export default function TaskBoardPage() {
  const router = useRouter()
  
  // --- 系統資料狀態 ---
  const [dbDepartments, setDbDepartments] = useState<Department[]>([])
  const [dbMembers, setDbMembers] = useState<Member[]>([])
  
  const [currentUser, setCurrentUser] = useState<{ id: string, name: string, dept: string, email?: string, is_admin: boolean } | null>(null)

  // --- 任務狀態 ---
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [filter, setFilter] = useState<'all' | 'mine' | 'sent'>('all')
  const [deptFilter, setDeptFilter] = useState<string>('ALL')
  
  // 搜尋狀態
  const [searchTerm, setSearchTerm] = useState('')
  const [isSearching, setIsSearching] = useState(false) // 搜尋讀取動畫用

  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  
  const [newTask, setNewTask] = useState({ title: '', content: '', targetDept: '', targetUsers: [] as string[] })
  const [activeUserSelectTab, setActiveUserSelectTab] = useState<string>('') 
  
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState<TaskMessage[]>([])

  const fetchTasks = useCallback(async (query = '') => {
    setIsSearching(true)
    let taskData: TaskItem[] = []

    if (!query.trim()) {
      const { data } = await supabase.from('tasks').select('*').order('updated_at', { ascending: false }).limit(50)
      if (data) taskData = data as TaskItem[]
    } else {
      const term = `%${query.trim()}%`

      const { data: tasksByMeta } = await supabase
        .from('tasks')
        .select('*')
        .or(`title.ilike.${term},content.ilike.${term},sender_name.ilike.${term}`)

      const { data: msgs } = await supabase
        .from('task_messages')
        .select('task_id')
        .ilike('content', term)

      const msgTaskIds = Array.from(new Set((msgs || []).map(m => m.task_id)))

      let tasksByMsg: TaskItem[] = []
      if (msgTaskIds.length > 0) {
        const { data } = await supabase
          .from('tasks')
          .select('*')
          .in('id', msgTaskIds)
        if (data) tasksByMsg = data as TaskItem[]
      }

      const combined = new Map<number, TaskItem>()
      tasksByMeta?.forEach(t => combined.set(t.id, t as TaskItem))
      tasksByMsg.forEach(t => combined.set(t.id, t))

      taskData = Array.from(combined.values())
      taskData.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    }

    setTasks(taskData)
    setIsSearching(false)
  }, [])

  const fetchMessages = useCallback(async (taskId: number) => {
    const { data } = await supabase.from('task_messages').select('*').eq('task_id', taskId).order('created_at', { ascending: true })
    if (data) setMessages(data as TaskMessage[])
    else setMessages([])
  }, [])

  // --- 1. 初始化 ---
  useEffect(() => {
    const initData = async () => {
      console.log("🚀 正在讀取登入資訊 (LocalStorage)...")

      const storedEmail = localStorage.getItem('bardshop_user_email')
      const storedName = localStorage.getItem('bardshop_user_name')
      
      if (!storedEmail) {
        alert("尚未登入或憑證過期，請重新登入！")
        router.replace('/login')
        return
      }

      const myProfile = {
        id: 'temp_id',
        name: storedName || storedEmail, 
        dept: '讀取中...',
        email: storedEmail,
        is_admin: false
      }
      setCurrentUser(myProfile)

      // SEC 修復：員工名冊改走後端 /api/members/roster（guardAuth，不含 password），
      // 不再用 anon key 直讀 members。departments 仍走 anon（不在本次止血範圍）。
      const [deptRes, memberJson] = await Promise.all([
        supabase.from('departments').select('*').order('id', { ascending: true }),
        fetch('/api/members/roster', { cache: 'no-store' })
          .then(r => r.json())
          .catch(() => ({ members: [] })) as Promise<{ members?: Member[] }>,
      ])
      const memberData = Array.isArray(memberJson.members) ? memberJson.members : null

      if (deptRes.data) {
        setDbDepartments(deptRes.data)
        if (deptRes.data.length > 0) setActiveUserSelectTab(deptRes.data[0].name)
      }

      if (memberData) {
        setDbMembers(memberData as Member[])
        
        const myEmailClean = storedEmail.trim().toLowerCase()
        const matchedMember = memberData.find(m =>
          m.email?.trim().toLowerCase() === myEmailClean
        )

        if (matchedMember) {
          console.log(`✅ 身分確認: ${matchedMember.real_name} (Admin: ${matchedMember.is_admin})`)
          setCurrentUser({
            id: String(matchedMember.id),
            name: matchedMember.real_name,
            dept: matchedMember.department,
            email: storedEmail,
            is_admin: matchedMember.is_admin
          })
        } else {
          console.warn("⚠️ 資料庫找不到您的 Email，使用暫存身分")
        }
      }
    }

    initData()
    // 初始載入任務 (無搜尋關鍵字)
    const initFetchTimer = setTimeout(() => {
      void fetchTasks('')
    }, 0)

    // 訂閱任務更新 (當有人新增任務時自動更新列表)
    const taskChannel = supabase.channel('tasks-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
         // 只有在「沒有搜尋」的時候才自動更新，避免搜尋到一半列表亂跳
        if (!searchTerm) void fetchTasks('')
      })
      .subscribe()

    // 訂閱訊息更新
    const msgChannel = supabase.channel('messages-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'task_messages' }, (payload) => {
        if (selectedTask && payload.new.task_id === selectedTask.id) {
           void fetchMessages(selectedTask.id)
        }
      })
      .subscribe()

    return () => { 
      clearTimeout(initFetchTimer)
      supabase.removeChannel(taskChannel) 
      supabase.removeChannel(msgChannel)
    }
  }, [router, selectedTask, searchTerm, fetchTasks, fetchMessages]) // 注意依賴項

  // 🔥 自動防抖搜尋 (Debounce)
  // 當 searchTerm 改變時，設定一個 500ms 的計時器，時間到才執行 fetchTasks
  useEffect(() => {
    const delaySearch = setTimeout(() => {
      void fetchTasks(searchTerm)
    }, 500)

    return () => clearTimeout(delaySearch)
  }, [searchTerm, fetchTasks])

  const handleSelectTask = (task: TaskItem) => {
    setSelectedTask(task)
    void fetchMessages(task.id)
  }

  const handleSendMessage = async () => {
    if (!chatInput.trim() || !selectedTask || !currentUser) return
    const { error } = await supabase.from('task_messages').insert({
      task_id: selectedTask.id,
      user_name: currentUser.name,
      content: chatInput,
      type: 'text'
    })
    if (!error) {
      setChatInput('')
      void fetchMessages(selectedTask.id)
    } else {
      alert("訊息發送失敗")
    }
  }

  // --- 選人邏輯 Helper ---
  const handleToggleUser = (userName: string) => {
    setNewTask(prev => {
      const exists = prev.targetUsers.includes(userName)
      return { ...prev, targetUsers: exists ? prev.targetUsers.filter(u => u !== userName) : [...prev.targetUsers, userName] }
    })
  }
  const handleToggleDeptAll = (deptName: string) => {
    const deptMembers = dbMembers.filter(m => m.department === deptName).map(m => m.real_name)
    if (deptMembers.length === 0) return
    setNewTask(prev => {
      const allSelected = deptMembers.every(name => prev.targetUsers.includes(name))
      let newUsers = [...prev.targetUsers]
      if (allSelected) { newUsers = newUsers.filter(name => !deptMembers.includes(name)) } 
      else { deptMembers.forEach(name => { if (!newUsers.includes(name)) newUsers.push(name) }) }
      return { ...prev, targetUsers: newUsers }
    })
  }

  // --- 任務操作邏輯 ---
  const handleCreateTask = async () => {
    if (!newTask.title || !newTask.targetDept) return alert('請填寫標題與主要歸屬部門')
    if (!currentUser) return alert('系統正在讀取您的身分，請稍後再試...')
    const senderId = currentUser.id === 'temp' || currentUser.id === 'temp_id' ? 0 : parseInt(currentUser.id)
    const { error } = await supabase.from('tasks').insert({
      title: newTask.title, content: newTask.content, sender_id: senderId, sender_name: currentUser.name, 
      target_dept: newTask.targetDept, assigned_to: newTask.targetUsers, status: 'pending', transfer_count: 0
    })
    if (!error) { setIsCreateModalOpen(false); setNewTask({ title: '', content: '', targetDept: '', targetUsers: [] }); void fetchTasks(searchTerm) } else { alert('發送失敗：' + error.message) }
  }

  const handleAcceptTask = async () => {
    if (!selectedTask) return
    await supabase.from('tasks').update({ status: 'accepted' }).eq('id', selectedTask.id)
    await supabase.from('task_messages').insert({ task_id: selectedTask.id, user_name: 'System', content: `任務已被 ${currentUser?.name} 接收`, type: 'system' })
    setSelectedTask({ ...selectedTask, status: 'accepted' }); void fetchMessages(selectedTask.id)
  }

  const handleTransferTask = async () => {
    if (!selectedTask) return
    const defaultDept = dbDepartments.length > 0 ? dbDepartments[0].name : ''
    const newDept = prompt('請輸入要轉移的部門名稱:', defaultDept)
    if (!newDept) return
    const deptExists = dbDepartments.some(d => d.name === newDept)
    if (!deptExists) return alert('找不到此部門，請確認名稱是否正確。')
    const newCount = (selectedTask.transfer_count || 0) + 1
    if (newCount > 2) {
      await supabase.from('tasks').update({ status: 'returned', target_dept: '退回', assigned_to: [selectedTask.sender_name], transfer_count: 0, is_read: false }).eq('id', selectedTask.id)
      alert('任務流轉次數過多，已退回給發送人！')
    } else {
      await supabase.from('tasks').update({ target_dept: newDept, assigned_to: [], status: 'pending', transfer_count: newCount, is_read: false }).eq('id', selectedTask.id)
      await supabase.from('task_messages').insert({ task_id: selectedTask.id, user_name: 'System', content: `任務轉移至 [${newDept}]`, type: 'system' })
    }
    void fetchTasks(searchTerm); setSelectedTask(null)
  }

  // --- 🔥 權限過濾邏輯 (Security Gate) ---
  const filteredTasks = tasks.filter(task => {
    if (!currentUser) return false 

    // 1. 權限判斷
    const isMe = task.sender_name === currentUser.name 
    const isAssignedToMe = task.assigned_to?.includes(currentUser.name) 
    const isMyDeptBroadcast = currentUser.dept !== '未綁定' && task.target_dept === currentUser.dept && (!task.assigned_to || task.assigned_to.length === 0)

    if (!currentUser.is_admin) {
        if (!isMe && !isAssignedToMe && !isMyDeptBroadcast) return false
    }

    // 2. 左側欄位過濾
    if (filter === 'sent' && task.sender_name !== currentUser.name) return false
    if (filter === 'mine') {
       if (!isAssignedToMe && !isMyDeptBroadcast) return false
    }

    // 3. 上方部門快篩
    if (deptFilter !== 'ALL') {
        if (task.target_dept !== deptFilter) return false
    }

    // 4. (已移除舊的本地搜尋，改用 Server-Side)

    return true
  })

  const isSender = currentUser && selectedTask && selectedTask.sender_name === currentUser.name
  const isReceiver = currentUser && selectedTask && (
    selectedTask.assigned_to?.includes(currentUser.name) || 
    (selectedTask.target_dept === currentUser.dept && (!selectedTask.assigned_to || selectedTask.assigned_to.length === 0))
  )

  return (
    <div className="min-h-screen bg-[#050b14] text-slate-300 flex flex-col md:flex-row font-sans relative">
      
      {/* 左側邊欄 */}
      <div className="w-full md:w-64 bg-slate-950 border-r border-slate-800 flex flex-col p-4 shrink-0">
        <div className="flex gap-2 mb-6">
           <Link href="/" className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1 transition-colors">回首頁</Link>
           <button onClick={() => router.back()} className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1 transition-colors">上一頁</button>
        </div>

        <div className="mb-8">
            <h1 className="text-2xl font-black text-white flex items-center gap-2">
               <span className="w-3 h-8 bg-blue-600 rounded-sm"></span>
               任務看板
            </h1>
            <p className="text-xs text-slate-500 mt-1 font-mono">TASK MANAGEMENT</p>
            
            <div className="mt-4 p-3 bg-slate-900 rounded-lg border border-slate-800">
              <div className="text-[10px] text-slate-500 mb-1">CURRENT USER:</div>
              {currentUser ? (
                <>
                  <div className="text-sm font-bold text-blue-400 truncate" title={currentUser.name}>
                    {currentUser.name} 
                    {currentUser.is_admin && <span className="ml-2 text-[10px] bg-red-600 text-white px-1 rounded">ADMIN</span>}
                  </div>
                  <div className="text-xs text-slate-400">{currentUser.dept}</div>
                </>
              ) : (
                <div className="text-xs text-slate-500 animate-pulse">載入身分中...</div>
              )}
            </div>
        </div>

        <button onClick={() => setIsCreateModalOpen(true)} className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl shadow-lg shadow-blue-900/20 mb-6 transition-all active:scale-95 flex items-center justify-center gap-2">建立新任務</button>

        <nav className="space-y-1">
           {(['all', 'mine', 'sent'] as const).map((f) => (
             <button key={f} onClick={() => setFilter(f)} className={`w-full text-left px-4 py-3 rounded-lg text-sm font-bold transition-colors ${filter === f ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900'}`}>
               {f === 'all' && '📌 所有任務'}
               {f === 'mine' && '📥 指派給我'}
               {f === 'sent' && '📤 我發出的'}
             </button>
           ))}
        </nav>
      </div>

      {/* 中間：任務列表 */}
      <div className="flex-1 bg-[#0a101a] flex flex-col border-r border-slate-800 max-w-md min-w-[320px]">
         
         <div className="p-4 border-b border-slate-800 bg-slate-950/50 backdrop-blur z-10 sticky top-0">
            {/* 搜尋框 */}
            <div className="relative mb-3">
               <input 
                  type="text" 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="🔍 搜尋內容/對話/人員..." 
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:border-blue-500 outline-none transition-colors"
               />
               <svg className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
               </svg>
               {isSearching && <div className="absolute right-3 top-2.5 animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full"></div>}
            </div>

            {/* 部門按鈕 */}
            <div className="flex flex-wrap gap-2">
               <button 
                 onClick={() => setDeptFilter('ALL')}
                 className={`px-3 py-1 text-xs font-bold rounded-full transition-colors border ${deptFilter === 'ALL' ? 'bg-white text-black border-white' : 'bg-transparent text-slate-500 border-slate-700 hover:border-slate-500'}`}
               >
                 ALL
               </button>
               {dbDepartments.map(dept => (
                 <button 
                   key={dept.id}
                   onClick={() => setDeptFilter(dept.name)}
                   className={`px-3 py-1 text-xs font-bold rounded-full transition-colors border ${deptFilter === dept.name ? 'bg-blue-600 text-white border-blue-500' : 'bg-transparent text-slate-500 border-slate-700 hover:border-slate-500'}`}
                 >
                   {dept.name}
                 </button>
               ))}
            </div>
         </div>

         <div className="p-3 border-b border-slate-800 flex justify-between items-center bg-[#0a101a]">
            <h2 className="font-bold text-white text-sm">任務列表</h2>
            <span className="text-xs text-slate-500">{filteredTasks.length} 筆資料</span>
         </div>
         
         <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2">
            {filteredTasks.length === 0 ? (
               <div className="p-8 text-center text-slate-600 text-sm">
                 {isSearching ? '搜尋中...' : (searchTerm ? '找不到相關對話或任務' : '目前沒有任務')}
               </div>
            ) : filteredTasks.map(task => (
               <div key={task.id} onClick={() => handleSelectTask(task)} className={`p-4 rounded-xl border cursor-pointer transition-all ${selectedTask?.id === task.id ? 'bg-blue-900/20 border-blue-500' : 'bg-slate-900 border-slate-800 hover:border-slate-600'}`}>
                  <div className="flex justify-between items-start mb-2">
                     <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${task.status === 'returned' ? 'bg-red-900/30 text-red-400' : 'bg-slate-800 text-blue-400'}`}>
                        {task.status.toUpperCase()}
                     </span>
                     <span className="text-[10px] text-slate-500 font-mono">{new Date(task.updated_at).toLocaleDateString()}</span>
                  </div>
                  <h3 className="font-bold text-white mb-1 truncate">{task.title}</h3>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                     <span>{task.sender_name}</span> <span>➔</span> <span className="font-bold text-slate-300">{task.target_dept}</span>
                  </div>
               </div>
            ))}
         </div>
      </div>

      {/* 右側：任務詳情 (不變，省略細節) */}
      <div className="flex-[2] bg-[#050b14] flex flex-col relative min-w-[300px]">
         {selectedTask ? (
            <>
               <div className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-slate-950/50 backdrop-blur">
                  <div>
                     <h2 className="text-lg font-bold text-white">{selectedTask.title}</h2>
                     <div className="text-xs text-slate-500 flex gap-2">
                        <span>From: {selectedTask.sender_name}</span>
                        {isSender && <span className="text-blue-400">(Me)</span>}
                     </div>
                  </div>
                  
                  <div className="flex gap-2">
                     {selectedTask.status === 'pending' && !isSender && isReceiver && (
                        <button onClick={handleAcceptTask} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-full transition-colors animate-pulse shadow-[0_0_15px_rgba(16,185,129,0.4)]">接收任務</button>
                     )}
                     {(isReceiver || isSender || currentUser?.is_admin) && (
                       <button onClick={handleTransferTask} className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-full border border-slate-600 transition-colors">轉移任務</button>
                     )}
                     {selectedTask.status === 'pending' && isSender && (
                        <span className="text-xs text-slate-500 italic py-1.5 px-2 bg-slate-900/50 rounded">等待對方接收...</span>
                     )}
                  </div>
               </div>

               <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
                  <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-800 mb-8">
                     <h4 className="text-xs font-bold text-slate-500 uppercase mb-2">Description</h4>
                     <p className="text-slate-300 leading-relaxed">{selectedTask.content}</p>
                     {selectedTask.assigned_to && selectedTask.assigned_to.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-slate-800/50">
                           <span className="text-xs text-slate-500 mr-2">Assigned:</span>
                           {selectedTask.assigned_to.map((name: string, i: number) => (
                              <span key={i} className="text-xs bg-blue-900/30 text-blue-400 px-2 py-1 rounded mr-1 border border-blue-500/20">{name}</span>
                           ))}
                        </div>
                     )}
                  </div>

                  <div className="flex items-center gap-4 py-4"><div className="h-px bg-slate-800 flex-1"></div><span className="text-xs text-slate-600 font-mono">HISTORY</span><div className="h-px bg-slate-800 flex-1"></div></div>

                  {messages.map(msg => (
                     <div key={msg.id} className={`flex flex-col ${msg.type === 'system' ? 'items-center' : msg.user_name === currentUser?.name ? 'items-end' : 'items-start'}`}>
                        {msg.type === 'system' ? (
                           <span className="text-[10px] bg-slate-800 text-slate-400 px-3 py-1 rounded-full">{msg.content}</span>
                        ) : (
                           <div className={`max-w-[70%] p-3 rounded-2xl text-sm ${msg.user_name === currentUser?.name ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-slate-800 text-slate-300 rounded-tl-sm'}`}>
                              {msg.content}
                           </div>
                        )}
                        {msg.type !== 'system' && <span className="text-[10px] text-slate-600 mt-1 mx-1">{msg.user_name} • {new Date(msg.created_at).toLocaleTimeString()}</span>}
                     </div>
                  ))}
               </div>

               {(isSender || isReceiver || currentUser?.is_admin) && (
                 <div className="p-4 bg-slate-950 border-t border-slate-800">
                    <div className="flex gap-2">
                       <input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendMessage()} placeholder="輸入回覆訊息..." className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:border-blue-500 outline-none" />
                       <button onClick={handleSendMessage} className="px-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg></button>
                    </div>
                 </div>
               )}
            </>
         ) : <div className="flex-1 flex flex-col items-center justify-center text-slate-600"><p>選擇一個任務以檢視詳情</p></div>}
      </div>

      {/* Modal: 建立任務 (省略部分重複代碼，邏輯與前版相同) */}
      {isCreateModalOpen && (
         <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-slate-900 w-full max-w-2xl rounded-2xl border border-slate-700 shadow-2xl overflow-hidden animate-fade-in-up max-h-[90vh] flex flex-col">
               <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-950">
                  <h3 className="text-xl font-bold text-white">指派新任務</h3>
                  <button onClick={() => setIsCreateModalOpen(false)} className="text-slate-500 hover:text-white">✕</button>
               </div>
               
               <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                     <div className="md:col-span-2">
                        <label className="text-xs font-bold text-slate-500 block mb-1">任務標題</label>
                        <input type="text" value={newTask.title} onChange={e => setNewTask({...newTask, title: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:border-blue-500 outline-none" />
                     </div>
                     <div className="md:col-span-2">
                        <label className="text-xs font-bold text-slate-500 block mb-1">任務內容</label>
                        <textarea rows={3} value={newTask.content} onChange={e => setNewTask({...newTask, content: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:border-blue-500 outline-none resize-none" />
                     </div>
                  </div>

                  <div className="h-px bg-slate-800 w-full"></div>

                  <div>
                     <label className="text-xs font-bold text-blue-400 block mb-2 uppercase">1. 設定主要歸屬部門 (Primary Dept)</label>
                     <div className="flex flex-wrap gap-2">
                        {dbDepartments.map(dept => (
                           <button key={dept.id} onClick={() => setNewTask({ ...newTask, targetDept: dept.name })} className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${newTask.targetDept === dept.name ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'}`}>{dept.name}</button>
                        ))}
                     </div>
                  </div>

                  <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-800">
                     <label className="text-xs font-bold text-emerald-400 block mb-3 uppercase">2. 指派執行人員 (複選 / 跨部門)</label>
                     <div className="flex border-b border-slate-700 mb-3 overflow-x-auto custom-scrollbar">{dbDepartments.map(dept => (<button key={dept.id} onClick={() => setActiveUserSelectTab(dept.name)} className={`px-4 py-2 text-xs font-bold whitespace-nowrap border-b-2 transition-colors ${activeUserSelectTab === dept.name ? 'border-emerald-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>{dept.name}</button>))}</div>
                     <div className="min-h-[100px]"><div className="flex justify-between items-center mb-2"><span className="text-xs text-slate-500">部門成員:</span><button onClick={() => handleToggleDeptAll(activeUserSelectTab)} className="text-[10px] bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded text-white">全選/取消</button></div>
                        <div className="flex flex-wrap gap-2">{dbMembers.filter(m => m.department === activeUserSelectTab).length > 0 ? (dbMembers.filter(m => m.department === activeUserSelectTab).map(u => (<button key={u.id} onClick={() => handleToggleUser(u.real_name)} className={`px-3 py-1.5 rounded-full text-xs border transition-all flex items-center gap-1 ${newTask.targetUsers.includes(u.real_name) ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500' : 'bg-slate-800 border-slate-600 text-slate-400 hover:border-slate-500'}`}>{u.real_name} {newTask.targetUsers.includes(u.real_name) && '✓'}</button>))) : (<span className="text-xs text-slate-600 italic py-2">此部門尚無成員</span>)}</div>
                     </div>
                  </div>

                  {newTask.targetUsers.length > 0 && (
                     <div className="animate-fade-in">
                        <label className="text-xs font-bold text-slate-500 block mb-2">已選擇人員 ({newTask.targetUsers.length})</label>
                        <div className="flex flex-wrap gap-2 p-3 bg-black/20 rounded-xl border border-slate-800">
                           {newTask.targetUsers.map(user => (<button key={user} onClick={() => handleToggleUser(user)} className="group flex items-center gap-1 bg-blue-900/30 text-blue-300 border border-blue-500/30 px-2 py-1 rounded text-xs hover:bg-red-900/30 hover:text-red-300 hover:border-red-500/30 transition-colors">{user}<span className="text-[10px] opacity-50 group-hover:opacity-100">✕</span></button>))}
                        </div>
                     </div>
                  )}
               </div>

               <div className="p-4 bg-slate-950 flex justify-end gap-3 border-t border-slate-800">
                  <button onClick={() => setIsCreateModalOpen(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white">取消</button>
                  <button onClick={handleCreateTask} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-lg shadow-lg">確認發送 ({newTask.targetUsers.length}人)</button>
               </div>
            </div>
         </div>
      )}

    </div>
  )
}