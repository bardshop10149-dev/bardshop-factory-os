
'use client'

import React from 'react';

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'

interface Announcement {
  id: number
  title: string
  content: string | null
  is_active: boolean
  created_at: string
}

interface PrepLog {
  id: number
  mo_number: string
  factory: string | null
  product_code: string | null
  planned_qty: string | null
  status: '已備料' | '無需備料'
  lines_count: number
  interface_id: string | null
  logged_at: string
}

type MemberDataType = {
  real_name: string | null;
  department: string | null;
  email: string | null;
  permissions: string[] | null;
  is_admin: boolean | null;
};


function normalizeLegacyPermissions(perms: string[]): string[] {
  // 權限轉換邏輯：null/undefined 預設空陣列
  if (!Array.isArray(perms)) return [];
  // 範例：去除重複、過濾空字串
  return Array.from(new Set(perms.filter(p => typeof p === 'string' && p.trim() !== '')));
}

export default function HomePage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<MemberDataType | null>(null);
  const [memberPermissions, setMemberPermissions] = useState<string[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [currentAnnoIndex, setCurrentAnnoIndex] = useState(0);
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  const [showModal, setShowModal] = useState(false);
  const [showQaModal, setShowQaModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [isHovered, setIsHovered] = useState<'none' | 'production' | 'estimation' | 'qa' | 'admin' | 'settings' | 'notice' | 'finance' | 'product_dev' | 'design' | 'dispensing'>('none');
  const [showProductDevModal, setShowProductDevModal] = useState(false);
  const [downloadingBom, setDownloadingBom] = useState(false);
  const [downloadingProducts, setDownloadingProducts] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const fetchCurrentUser = async () => {
      const { data: authData } = await supabase.auth.getUser();
      const authUserId = authData.user?.id || '';
      const email = authData.user?.email || localStorage.getItem('bardshop_user_email') || '';
      if (!email) {
        setMemberPermissions([]);
        setCurrentUser({
          real_name: '-',
          department: '-',
          email: '',
          permissions: [],
          is_admin: false,
        });
        return;
      }

      let memberData: MemberDataType | null = null;

      if (authUserId) {
        const { data } = await supabase
          .from('members')
          .select('real_name, department, email, permissions, is_admin')
          .eq('auth_user_id', authUserId)
          .maybeSingle();
        memberData = data;
      }

      if (!memberData) {
        const { data } = await supabase
          .from('members')
          .select('real_name, department, email, permissions, is_admin')
          .eq('email', email)
          .maybeSingle();
        memberData = data;
      }

      if (memberData) {
        const normalizedPermissions = Boolean(memberData.is_admin)
          ? ['dashboard', 'notice', 'estimation', 'tasks', 'qa_report', 'qa', 'production_admin', 'system_settings']
          : normalizeLegacyPermissions(memberData.permissions ?? []);
        setMemberPermissions(normalizedPermissions);
        setCurrentUser({
          real_name: memberData.real_name || '-',
          department: memberData.department || '-',
          email: memberData.email || email,
          permissions: normalizedPermissions,
          is_admin: !!memberData.is_admin,
        });

        // 同步更新 cookie，確保 middleware 使用最新權限
        const isAdminRole = Boolean(memberData.is_admin) || normalizedPermissions.includes('production_admin');
        const role = isAdminRole ? 'admin' : 'ops';
        document.cookie = `bardshop-role=${role}; path=/; max-age=86400; SameSite=Lax;`;
        document.cookie = `bardshop-permissions=${encodeURIComponent(normalizedPermissions.join(','))}; path=/; max-age=86400; SameSite=Lax;`;
        return;
      }
      setMemberPermissions([]);
      setCurrentUser({
        real_name: '-',
        department: '-',
        email,
        permissions: [],
        is_admin: false,
      });
    };
    void fetchCurrentUser();
  }, []);



  useEffect(() => {
    const fetchAnnouncements = async () => {
      try {
        const { data, error } = await supabase
          .from('system_announcements')
          .select('*')
          .eq('is_active', true)
          .order('created_at', { ascending: false });
        if (error) {
          // 可加強：顯示錯誤訊息
          console.error('公告查詢失敗:', error.message);
        }
        if (data && data.length > 0) {
          setAnnouncements(data as Announcement[]);
        }
      } catch (err) {
        console.error('fetchAnnouncements error:', err);
      }
    };
    fetchAnnouncements();
  }, []);

  useEffect(() => {
    if (announcements.length <= 1 || showModal) return;
    const interval = setInterval(() => {
      setCurrentAnnoIndex((prev) => (prev + 1) % announcements.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [announcements, showModal]);

  const handleLogout = () => {
    document.cookie = "bardshop-token=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    document.cookie = "bardshop-role=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    document.cookie = "bardshop-permissions=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    supabase.auth.signOut().finally(() => {
      router.push('/login');
    });
  }

  const currentAnnouncement = announcements[currentAnnoIndex]
  const hasFeaturePermission = (permissionKey: string) => {
    if (currentUser?.is_admin) return true
    return memberPermissions.includes(permissionKey)
  }

  const downloadMaterialList = async () => {
    setDownloadingBom(true);
    try {
      const PAGE = 1000;
      let allRows: { item_code: string; item_name: string; spec: string }[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('material_inventory_list')
          .select('item_code, item_name, spec')
          .order('sequence_no', { ascending: true, nullsFirst: false })
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const chunk = (data ?? []) as { item_code: string; item_name: string; spec: string }[];
        allRows = allRows.concat(chunk);
        if (chunk.length < PAGE) break;
        from += PAGE;
      }
      const rows = allRows;
      const header = '品項編碼,品項名稱,規格';
      const csvContent = [
        header,
        ...rows.map(r =>
          [r.item_code, r.item_name, r.spec]
            .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
            .join(',')
        ),
      ].join('\n');
      const bom = '\uFEFF';
      const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `物料清單_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`下載失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDownloadingBom(false);
    }
  };

  const downloadProductList = async () => {
    setDownloadingProducts(true);
    try {
      const PAGE = 1000;
      const seen = new Set<string>();
      const allRows: { product_code: string; product_name: string }[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('bom')
          .select('product_code, product_name')
          .order('product_code', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const chunk = (data ?? []) as { product_code: string; product_name: string }[];
        for (const row of chunk) {
          if (!seen.has(row.product_code)) {
            seen.add(row.product_code);
            allRows.push(row);
          }
        }
        if (chunk.length < PAGE) break;
        from += PAGE;
      }
      const header = '生產品項編碼,生產品項名稱';
      const csvContent = [
        header,
        ...allRows.map(r =>
          [r.product_code, r.product_name]
            .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
            .join(',')
        ),
      ].join('\n');
      const bom = '\uFEFF';
      const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `生產品項_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`下載失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDownloadingProducts(false);
    }
  };

  const guardFeatureAccess = (permissionKey: string, featureName: string) => {
    if (hasFeaturePermission(permissionKey)) return undefined;
    return (event: React.MouseEvent<HTMLAnchorElement | HTMLDivElement>) => {
      event.preventDefault();
      alert(`你目前沒有「${featureName}」權限，請聯絡核心管理員。`);
    };
  }

  const canDashboard = hasFeaturePermission('dashboard')
  const canNotice = hasFeaturePermission('notice')
  const canEstimation = hasFeaturePermission('estimation')
  const canProductionAdmin = hasFeaturePermission('production_admin')
  const canSystemSettings = hasFeaturePermission('system_settings')
  const canQa = hasFeaturePermission('qa')
  const canArgoDB = hasFeaturePermission('argo_db')
  const canDesign = hasFeaturePermission('design')
  const canMaterial = hasFeaturePermission('material')
  const canArgoTool = hasFeaturePermission('argo_tool')
  const canProductDev = hasFeaturePermission('product_dev')
  const canInfoBoard = hasFeaturePermission('info_board')
  const canPurchasing = hasFeaturePermission('purchasing')
  // 採購到期徽章：僅具權限者抓計數（API 端亦有 guardPermission 把關）
  const [purchasingDue, setPurchasingDue] = useState(0)
  useEffect(() => {
    if (!canPurchasing) return
    fetch('/api/purchasing/list?count=1')
      .then(res => (res.ok ? res.json() : null))
      .then(json => { if (json?.success) setPurchasingDue(Number(json.counts?.total) || 0) })
      .catch(() => {})
  }, [canPurchasing])

  return (
    <div className="min-h-screen bg-[#050b14] text-slate-300 font-sans selection:bg-cyan-500 selection:text-white relative overflow-y-auto flex flex-col items-center justify-start md:justify-center py-4 md:py-0">
      
      {/* --- 背景特效 --- */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 brightness-100 contrast-150"></div>
        <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-blue-900/10 via-transparent to-slate-900/80"></div>
        <div className="absolute inset-0 opacity-20" 
             style={{ 
               backgroundImage: 'linear-gradient(rgba(6, 182, 212, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(6, 182, 212, 0.1) 1px, transparent 1px)', 
               backgroundSize: '50px 50px' 
             }}>
        </div>

      </div>

      {/* --- 左上角：公告顯示區 --- */}
      {currentAnnouncement && (
        <div className="hidden md:block absolute top-6 left-6 z-40 max-w-[280px] md:max-w-sm animate-fade-in-right">
          <div 
            onClick={() => setShowModal(true)}
            className="group cursor-pointer bg-slate-900/60 backdrop-blur-md border border-orange-500/30 rounded-xl p-4 shadow-[0_4px_20px_rgba(0,0,0,0.3)] hover:border-orange-500/60 transition-all hover:translate-x-1"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
              </span>
              <span className="text-[10px] font-bold text-orange-400 uppercase tracking-wider">System Notice</span>
              {announcements.length > 1 && (
                <span className="text-[10px] text-slate-500 ml-auto font-mono">
                  {currentAnnoIndex + 1}/{announcements.length}
                </span>
              )}
            </div>
            
            <h3 className="text-white font-bold text-sm mb-1 truncate group-hover:text-orange-300 transition-colors">
              {currentAnnouncement.title}
            </h3>
            
            <p className="text-xs text-slate-400 font-mono leading-relaxed line-clamp-2">
              {currentAnnouncement.content || '點擊查看詳情...'}
            </p>

            <div className="mt-2 text-[10px] text-slate-600 group-hover:text-slate-500">
              Click to expand &rarr;
            </div>
          </div>
        </div>
      )}

      {/* 手機版頂部：公告 + 使用者 */}
      <div className="md:hidden relative z-40 w-full px-4 pt-4 pb-2 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-mono text-lg text-cyan-500/80 font-bold tabular-nums tracking-wider">
            {time}
          </div>
          <button 
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-700 rounded-full text-xs font-mono text-slate-500 hover:text-red-400 hover:border-red-500/50 transition-all bg-slate-900/30"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            LOGOUT
          </button>
        </div>
        {currentUser && (
          <div
            onClick={() => router.push('/profile')}
            title="個人中心"
            className="cursor-pointer bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2 backdrop-blur-sm flex items-center justify-between hover:border-cyan-500/60 hover:bg-slate-800/60 transition-all"
          >
            <div>
              <span className="text-sm font-bold text-white">{currentUser.real_name}</span>
              <span className="text-xs text-cyan-400 ml-2">{currentUser.department}</span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono">{currentUser.email}</span>
          </div>
        )}
        {currentAnnouncement && (
          <div 
            onClick={() => setShowModal(true)}
            className="cursor-pointer bg-slate-900/60 backdrop-blur-md border border-orange-500/30 rounded-xl px-3 py-2.5 flex items-center gap-3"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
            </span>
            <span className="text-white text-sm font-bold truncate flex-1">{currentAnnouncement.title}</span>
            <span className="text-[10px] text-slate-500 shrink-0">&rarr;</span>
          </div>
        )}
      </div>

      {/* 右上角：時間 + 登出 (桌面版) */}
      <div className="hidden md:flex absolute top-6 right-6 z-40 flex-col items-end gap-3">
        <div className="font-mono text-2xl md:text-3xl text-cyan-500/80 font-bold tabular-nums tracking-wider">
          {time}
        </div>
        {currentUser && (
          <div
            onClick={() => router.push('/profile')}
            title="個人中心"
            className="cursor-pointer bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2 text-right backdrop-blur-sm min-w-[220px] hover:border-cyan-500/60 hover:bg-slate-800/60 transition-all"
          >
            <div className="text-sm font-bold text-white leading-tight">{currentUser.real_name}</div>
            <div className="text-xs text-cyan-400 leading-tight">{currentUser.department}</div>
            <div className="text-[11px] text-slate-400 font-mono leading-tight mt-1">{currentUser.email}</div>
          </div>
        )}
        <button 
          onClick={handleLogout}
          className="flex items-center gap-2 px-4 py-2 border border-slate-700 rounded-full text-xs font-mono text-slate-500 hover:text-red-400 hover:border-red-500/50 hover:bg-red-950/20 transition-all backdrop-blur-sm bg-slate-900/30"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
          LOGOUT
        </button>
      </div>

      {/* --- 中央內容區 --- */}
      <div className="relative z-10 w-full max-w-[1400px] px-4 md:px-6 flex flex-col items-center">
        
        {/* LOGO & Header */}
        <div className="text-center mb-4 md:mb-8 animate-fade-in-down flex flex-col items-center">
          <div className="hidden md:inline-block px-4 py-1 border border-cyan-500/30 rounded-full bg-cyan-950/30 text-cyan-400 text-xs tracking-[0.3em] uppercase mb-6 shadow-[0_0_10px_rgba(6,182,212,0.2)]">
            Authorized Access
          </div>
          
          <h1 className="flex flex-col items-center font-black text-white tracking-tight leading-none mb-3 md:mb-6">
            <span className="text-2xl md:text-6xl mb-1 md:mb-2 tracking-widest text-slate-500">BARDSHOP</span>
            <div className="relative text-3xl md:text-7xl">
              EIP<span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-600">.SYSTEM</span>
              <span className="absolute -top-1 -right-3 md:-right-4 w-3 h-3 md:w-4 md:h-4 bg-green-500 rounded-full animate-pulse shadow-[0_0_10px_#22c55e]"></span>
            </div>
          </h1>

          <p className="text-slate-500 text-[10px] md:text-base font-mono tracking-[0.2em] uppercase mb-2 md:mb-4">
            Enterprise Information Portal
          </p>
        </div>

        {/* 🔥 四入口選擇器 (Grid 調整為 2x2 或 4欄) */}
        <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-6 w-full">
          
          {/* 1. 產線看板 (Cyan) */}
          <Link href="/dashboard" 
            onClick={guardFeatureAccess('dashboard', '產線看板')}
            onMouseEnter={() => setIsHovered('production')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-1 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-cyan-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(6,182,212,0.15)]
              ${canDashboard ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'production' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-cyan-500/10 rounded border border-cyan-500/20">
              <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">Dashboard</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-cyan-900/50 text-slate-400 group-hover:text-cyan-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-cyan-400 transition-colors">產線看板</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              即時生產進度與狀態。<br/>(Dashboard)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-cyan-600 group-hover:border-cyan-600 group-hover:text-white transition-all">
              ENTER SYSTEM &rarr;
            </span>
          </Link>


          {/* 2. 業務資訊看板 (Amber) */}
          <div
            onClick={hasFeaturePermission('info_board') ? () => setShowInfoModal(true) : guardFeatureAccess('info_board', '業務資訊看板')}
            onMouseEnter={() => setIsHovered('estimation')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-3 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-amber-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(245,158,11,0.15)]
              ${canInfoBoard ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'estimation' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-amber-500/10 rounded border border-amber-500/20">
              <span className="text-[10px] text-amber-400 font-bold uppercase tracking-wider">Info Board</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-amber-900/50 text-slate-400 group-hover:text-amber-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-amber-400 transition-colors">業務資訊看板</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              各部門訊息交流與公告。<br/>(Info Board)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-amber-600 group-hover:border-amber-600 group-hover:text-white transition-all">
              OPEN BOARD &rarr;
            </span>
          </div>

          {/* 3. 建立異常單 (Teal) - 新增方塊 */}
          <div
            onClick={hasFeaturePermission('qa_report') ? () => setShowQaModal(true) : guardFeatureAccess('qa_report', '異常單建立/回報')}
            onMouseEnter={() => setIsHovered('qa')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-5 h-40 md:h-60 lg:h-64 rounded-2xl border border-teal-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-teal-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(20,184,166,0.15)]
              ${hasFeaturePermission('qa_report') ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'qa' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-teal-500/10 rounded border border-teal-500/20">
              <span className="text-[10px] text-teal-400 font-bold uppercase tracking-wider">Report</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-teal-900/50 text-slate-400 group-hover:text-teal-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-teal-400 transition-colors">異常單回報</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              手動填寫品質異常，建立或回報待處理異常單。<br/>(QA Report)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-teal-600 text-teal-300 text-xs font-mono group-hover:bg-teal-600 group-hover:border-teal-600 group-hover:text-white transition-all">
              OPEN FORM &rarr;
            </span>
          </div>

          {/* 4. 生產管理 (Purple) */}
          <Link href="/admin"
            onClick={guardFeatureAccess('production_admin', '生產管理')}
            onMouseEnter={() => setIsHovered('admin')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-4 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-purple-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(168,85,247,0.15)]
              ${canProductionAdmin ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'admin' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-purple-500/10 rounded border border-purple-500/20">
              <span className="text-[10px] text-purple-400 font-bold uppercase tracking-wider">Production</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-purple-900/50 text-slate-400 group-hover:text-purple-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-purple-400 transition-colors">生產管理</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              生產流程與資料管理。<br/>(Production Admin)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-purple-600 group-hover:border-purple-600 group-hover:text-white transition-all">
              ACCESS &rarr;
            </span>
          </Link>

          {/* 5. 系統設定 (Orange) */}
          <Link href="/admin/settings"
            onClick={guardFeatureAccess('system_settings', '系統設定')}
            onMouseEnter={() => setIsHovered('settings')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-8 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-orange-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(249,115,22,0.15)]
              ${canSystemSettings ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'settings' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-orange-500/10 rounded border border-orange-500/20">
              <span className="text-[10px] text-orange-400 font-bold uppercase tracking-wider">Settings</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-orange-900/50 text-slate-400 group-hover:text-orange-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-orange-400 transition-colors">系統設定</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              組織與公告管理。<br/>(System Settings)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-orange-600 group-hover:border-orange-600 group-hover:text-white transition-all">
              OPEN SETTINGS &rarr;
            </span>
          </Link>

          {/* 5. 系統設定 (Orange) */}
          {/* 系統設定入口已移除 */}

          {/* 6. 品保專區 (Teal) */}
          <Link href="/qa"
            onClick={guardFeatureAccess('qa', '品保專區')}
            onMouseEnter={() => setIsHovered('qa')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-6 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-teal-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(20,184,166,0.15)]
              ${canQa ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'qa' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-teal-500/10 rounded border border-teal-500/20">
              <span className="text-[10px] text-teal-400 font-bold uppercase tracking-wider">Quality</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-teal-900/50 text-slate-400 group-hover:text-teal-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-teal-400 transition-colors">品保專區</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              異常回報與品質追蹤。<br/>(Quality Assurance)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-teal-600 group-hover:border-teal-600 group-hover:text-white transition-all">
              OPEN QA &rarr;
            </span>
          </Link>


          {/* 7. 產期告示 (可點擊連結) */}
          <Link
            href="/notice-board"
            onClick={guardFeatureAccess('notice', '產期告示')}
            onMouseEnter={() => setIsHovered('notice')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-2 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-cyan-500 hover:bg-cyan-900/40 hover:shadow-[0_0_30px_rgba(34,211,238,0.15)]
              ${canNotice ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'notice' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-cyan-500/10 rounded border border-cyan-500/20">
              <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">Notice</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 text-slate-400 group-hover:bg-cyan-900/50 group-hover:text-cyan-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10m-11 9h12a2 2 0 002-2V7a2 2 0 00-2-2H6a2 2 0 00-2 2v11a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-cyan-400 transition-colors">產期告示 / 試算</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 px-1 md:px-2 hidden md:block">
              交期公告查詢與生產週期試算。<br/>(Notice / Estimator)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-cyan-700 text-cyan-400 text-xs font-mono group-hover:bg-cyan-700/20 group-hover:text-white group-hover:border-cyan-600 group-hover:bg-cyan-600 transition-all">
              NOTICE BOARD &rarr;
            </span>
          </Link>

          {/* 9. 美編天地 (Pink) — CRM × 訂單交叉比對 */}
          <Link
            href="/design-studio"
            onClick={guardFeatureAccess('design', '美編天地')}
            onMouseEnter={() => setIsHovered('design')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-9 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-pink-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(236,72,153,0.15)]
              ${canDesign ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'design' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-pink-500/10 rounded border border-pink-500/20">
              <span className="text-[10px] text-pink-400 font-bold uppercase tracking-wider">Design</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-pink-900/50 text-slate-400 group-hover:text-pink-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-pink-400 transition-colors">美編天地</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              CRM × 訂單交叉比對，依品項編碼批次整理。<br/>(Design Studio)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-pink-600 group-hover:border-pink-600 group-hover:text-white transition-all">
              OPEN STUDIO &rarr;
            </span>
          </Link>

          {/* 10. 商品開發 (Green) */}
          <div
            onClick={hasFeaturePermission('product_dev') ? () => setShowProductDevModal(true) : guardFeatureAccess('product_dev', '商品開發')}
            onMouseEnter={() => setIsHovered('product_dev')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-10 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-green-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(34,197,94,0.15)]
              ${canProductDev ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'product_dev' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-green-500/10 rounded border border-green-500/20">
              <span className="text-[10px] text-green-400 font-bold uppercase tracking-wider">Product Dev</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-green-900/50 text-slate-400 group-hover:text-green-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-green-400 transition-colors">商品開發</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              商品開發相關作業。<br/>(Product Development)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-green-600 group-hover:border-green-600 group-hover:text-white transition-all">
              OPEN &rarr;
            </span>
          </div>

          {/* 8. 財會專區 (Slate / Disabled) - 黑霧特效 */}
          <div
            onMouseEnter={() => setIsHovered('finance')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-7 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-not-allowed select-none
              opacity-50 grayscale
              ${isHovered !== 'none' && isHovered !== 'finance' ? 'scale-95 blur-[2px]' : ''}
            `}
            style={{ pointerEvents: 'none' }}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-slate-500/10 rounded border border-slate-500/20">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Soon</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 text-slate-400">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-10V6m0 12v-2m9-4a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2">財會專區</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 px-1 md:px-2 hidden md:block">
              財務與會計相關作業。<br/>(Finance Center)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-700 text-slate-500 text-xs font-mono">
              COMING SOON
            </span>
          </div>

          {/* 11. 發料/領料專區 (Yellow) */}
          <Link
            href="/material-issue"
            onClick={guardFeatureAccess('material', '發料 / 領料')}
            onMouseEnter={() => setIsHovered('dispensing')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-11 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-yellow-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(234,179,8,0.15)]
              ${canMaterial ? '' : 'opacity-50 grayscale'}
              ${isHovered !== 'none' && isHovered !== 'dispensing' ? 'opacity-50 scale-95 blur-[2px]' : 'opacity-100'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-yellow-500/10 rounded border border-yellow-500/20">
              <span className="text-[10px] text-yellow-400 font-bold uppercase tracking-wider">Material</span>
            </div>

            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-yellow-900/50 text-slate-400 group-hover:text-yellow-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-yellow-400 transition-colors">發料 / 領料</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              批備料上傳紀錄查詢。<br/>(Material Dispatch)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-yellow-600 group-hover:border-yellow-600 group-hover:text-white transition-all">
              VIEW RECORDS &rarr;
            </span>
          </Link>

          {/* ARGO資料庫 (Orange-Red) */}
          <Link href="/argo-db"
            onClick={guardFeatureAccess('argo_db', 'ARGO資料庫')}
            onMouseEnter={() => setIsHovered('none')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-12 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm 
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-orange-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(249,115,22,0.15)]
              ${canArgoDB ? '' : 'opacity-50 grayscale'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-orange-500/10 rounded border border-orange-500/20">
              <span className="text-[10px] text-orange-400 font-bold uppercase tracking-wider">ARGO ERP</span>
            </div>
            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-orange-900/50 text-slate-400 group-hover:text-orange-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7zm0 5h16M9 4v16" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-orange-400 transition-colors">ARGO資料庫</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              ArgoERP 資料同步與管理。<br/>(ARGO Database)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-orange-600 group-hover:border-orange-600 group-hover:text-white transition-all">
              OPEN DB &rarr;
            </span>
          </Link>

          {/* ARGO 外掛區 (Cyan) — iframe 嵌入 bardshop-argo，SSO 不重登 */}
          <Link href="/argo"
            onClick={guardFeatureAccess('argo_tool', 'ARGO 外掛區')}
            onMouseEnter={() => setIsHovered('none')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-13 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-cyan-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(6,182,212,0.15)]
              ${canArgoTool ? '' : 'opacity-50 grayscale'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-cyan-500/10 rounded border border-cyan-500/20">
              <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">ARGO Tool</span>
            </div>
            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-cyan-900/50 text-slate-400 group-hover:text-cyan-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-cyan-400 transition-colors">ARGO 外掛區</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              拍照繳庫／報工等 ARGO 工具。<br/>(ARGO Tool)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-cyan-600 group-hover:border-cyan-600 group-hover:text-white transition-all">
              OPEN &rarr;
            </span>
          </Link>

          {/* 採購專區 (Indigo) — OPEN 採購單追蹤 / 到期提醒，僅開放採購人員 */}
          <Link href="/purchasing"
            onClick={guardFeatureAccess('purchasing', '採購專區')}
            onMouseEnter={() => setIsHovered('none')}
            onMouseLeave={() => setIsHovered('none')}
            className={`
              group relative order-14 h-40 md:h-60 lg:h-64 rounded-2xl border border-slate-700 bg-slate-900/40 backdrop-blur-sm
              flex flex-col items-center justify-center text-center p-3 md:p-6 transition-all duration-500 cursor-pointer
              hover:border-indigo-500 hover:bg-slate-800/60 hover:shadow-[0_0_30px_rgba(99,102,241,0.15)]
              ${canPurchasing ? '' : 'opacity-50 grayscale'}
            `}
          >
            <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-1 bg-indigo-500/10 rounded border border-indigo-500/20">
              <span className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">Purchasing</span>
            </div>
            {canPurchasing && purchasingDue > 0 && (
              <div className="absolute top-4 left-4 px-2 py-1 rounded-full bg-rose-600 text-white text-[10px] font-bold" title={`${purchasingDue} 筆採購明細 10 天內到期且未出貨`}>
                {purchasingDue}
              </div>
            )}
            <div className="mb-3 md:mb-6 p-3 md:p-4 rounded-full bg-slate-800 group-hover:bg-indigo-900/50 text-slate-400 group-hover:text-indigo-400 transition-colors">
              <svg className="w-7 h-7 md:w-10 md:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white mb-1 md:mb-2 group-hover:text-indigo-400 transition-colors">採購專區</h2>
            <p className="text-slate-500 text-[10px] md:text-xs mb-3 md:mb-6 group-hover:text-slate-300 px-1 md:px-2 hidden md:block">
              OPEN 採購單追蹤與到期提醒。<br/>(Purchasing)
            </p>
            <span className="hidden md:inline-block px-4 py-2 rounded border border-slate-600 text-slate-300 text-xs font-mono group-hover:bg-indigo-600 group-hover:border-indigo-600 group-hover:text-white transition-all">
              OPEN &rarr;
            </span>
          </Link>

        </div>

        <div className="mt-4 md:mt-8 text-center opacity-40 hover:opacity-100 transition-opacity pb-4 md:pb-0">
           <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-2">BARDSHOP INC. • INTERNAL USE ONLY</p>
           <div className="h-0.5 w-24 bg-gradient-to-r from-transparent via-slate-600 to-transparent mx-auto"></div>
        </div>

      </div>

      {/* --- 公告詳情 Modal --- */}
      {showModal && currentAnnouncement && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden relative">
            <div className="bg-slate-800 p-4 flex justify-between items-center border-b border-slate-700">
              <h3 className="text-white font-bold flex items-center gap-2">
                <span className="w-2 h-6 bg-orange-500 rounded-full"></span>
                系統公告
              </h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-white transition-colors">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-6 max-h-[60vh] overflow-y-auto custom-scrollbar">
              <div className="text-xs text-slate-500 font-mono mb-4">
                發布時間: {new Date(currentAnnouncement.created_at).toLocaleString()}
              </div>
              <h2 className="text-2xl font-bold text-orange-400 mb-4">{currentAnnouncement.title}</h2>
              <div className="text-slate-300 whitespace-pre-wrap leading-relaxed text-sm">
                {currentAnnouncement.content || "無詳細內容"}
              </div>
            </div>
            {announcements.length > 1 && (
              <div className="bg-slate-800/50 p-3 flex justify-between border-t border-slate-700">
                <button onClick={() => setCurrentAnnoIndex(prev => (prev - 1 + announcements.length) % announcements.length)} className="text-xs text-slate-400 hover:text-white px-3 py-1 hover:bg-slate-700 rounded">&larr; Prev</button>
                <span className="text-xs text-slate-500 font-mono py-1">{currentAnnoIndex + 1} / {announcements.length}</span>
                <button onClick={() => setCurrentAnnoIndex(prev => (prev + 1) % announcements.length)} className="text-xs text-slate-400 hover:text-white px-3 py-1 hover:bg-slate-700 rounded">Next &rarr;</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- Info Board Modal --- */}
      {showInfoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-amber-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden relative">
            <div className="bg-amber-800 p-4 flex justify-between items-center border-b border-amber-700">
              <h3 className="text-white font-bold flex items-center gap-2">
                <span className="w-2 h-6 bg-amber-400 rounded-full"></span>
                業務資訊看板
              </h3>
              <button onClick={() => setShowInfoModal(false)} className="text-amber-400 hover:text-white transition-colors">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-6 flex flex-col gap-4">
              {/* 發單記錄查詢 */}
              <div
                className="bg-amber-500/10 border border-amber-400 rounded-xl p-5 cursor-pointer hover:bg-amber-500/20 transition-all flex items-center gap-4"
                onClick={() => { setShowInfoModal(false); router.push('/info-board/order-records'); }}
              >
                <div className="text-3xl">🔍</div>
                <div className="flex-1">
                  <div className="text-amber-300 font-bold text-lg mb-1">發單記錄查詢</div>
                  <div className="text-xs text-slate-300">依工單／品項查詢歷史發單紀錄</div>
                </div>
                <span className="px-3 py-1 rounded border border-amber-500 text-amber-300 text-xs font-mono bg-amber-900/30">前往 →</span>
              </div>

              {/* 維修中 — 業務改單表 */}
              <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-5 flex items-center gap-4 opacity-50 cursor-not-allowed select-none">
                <div className="text-3xl grayscale">✏️</div>
                <div className="flex-1">
                  <div className="text-slate-400 font-bold text-lg mb-1">業務改單表</div>
                  <div className="text-xs text-slate-500">業務改單請求、變更紀錄</div>
                </div>
                <span className="px-3 py-1 rounded border border-slate-600 text-slate-500 text-xs font-mono bg-slate-800">🔧 維修中</span>
              </div>

              {/* 維修中 — 產期詢問/預留 */}
              <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-5 flex items-center gap-4 opacity-50 cursor-not-allowed select-none">
                <div className="text-3xl grayscale">📅</div>
                <div className="flex-1">
                  <div className="text-slate-400 font-bold text-lg mb-1">產期詢問/預留</div>
                  <div className="text-xs text-slate-500">產期詢問登記及預留產程</div>
                </div>
                <span className="px-3 py-1 rounded border border-slate-600 text-slate-500 text-xs font-mono bg-slate-800">🔧 維修中</span>
              </div>

              {/* 維修中 — 常平訂單 */}
              <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-5 flex items-center gap-4 opacity-50 cursor-not-allowed select-none">
                <div className="text-3xl grayscale">📦</div>
                <div className="flex-1">
                  <div className="text-slate-400 font-bold text-lg mb-1">常平訂單</div>
                  <div className="text-xs text-slate-500">常平訂單處理與追蹤</div>
                </div>
                <span className="px-3 py-1 rounded border border-slate-600 text-slate-500 text-xs font-mono bg-slate-800">🔧 維修中</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- 商品開發 Modal --- */}
      {showProductDevModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-green-700 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative">
            <div className="bg-green-900/60 p-4 flex justify-between items-center border-b border-green-700">
              <h3 className="text-white font-bold flex items-center gap-2">
                <span className="w-2 h-6 bg-green-400 rounded-full"></span>
                商品開發
              </h3>
              <button onClick={() => setShowProductDevModal(false)} className="text-green-400 hover:text-white transition-colors">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-6 flex flex-col gap-4">
              <button
                onClick={downloadMaterialList}
                disabled={downloadingBom}
                className="bg-green-700/20 border border-green-600 rounded-xl p-5 cursor-pointer hover:bg-green-700/40 transition-all flex items-center gap-4 w-full text-left disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="text-3xl">{downloadingBom ? '⏳' : '📥'}</div>
                <div className="flex-1">
                  <div className="text-green-400 font-bold text-lg mb-1">下載物料清單</div>
                  <div className="text-xs text-slate-300">匯出品項編碼、品項名稱、規格（CSV）</div>
                </div>
                <span className="px-3 py-1 rounded border border-green-600 text-green-300 text-xs font-mono bg-green-900/30">
                  {downloadingBom ? '下載中...' : '下載 →'}
                </span>
              </button>
              <button
                onClick={downloadProductList}
                disabled={downloadingProducts}
                className="bg-green-700/20 border border-green-600 rounded-xl p-5 cursor-pointer hover:bg-green-700/40 transition-all flex items-center gap-4 w-full text-left disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="text-3xl">{downloadingProducts ? '⏳' : '📦'}</div>
                <div className="flex-1">
                  <div className="text-green-400 font-bold text-lg mb-1">下載生產品項</div>
                  <div className="text-xs text-slate-300">匯出生產品項編碼、生產品項名稱（CSV）</div>
                </div>
                <span className="px-3 py-1 rounded border border-green-600 text-green-300 text-xs font-mono bg-green-900/30">
                  {downloadingProducts ? '下載中...' : '下載 →'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- QA Modal --- */}
      {showQaModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-teal-700 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative">
            <div className="bg-teal-800 p-4 flex justify-between items-center border-b border-teal-700">
              <h3 className="text-white font-bold flex items-center gap-2">
                <span className="w-2 h-6 bg-teal-400 rounded-full"></span>
                異常單建立/回報
              </h3>
              <button onClick={() => setShowQaModal(false)} className="text-teal-400 hover:text-white transition-colors">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-6 flex flex-col gap-6">
              <div className="flex gap-4">
                <div
                  className="flex-1 bg-teal-700/20 border border-teal-600 rounded-xl p-4 cursor-pointer hover:bg-teal-700/40 transition-all text-center"
                  onClick={() => { setShowQaModal(false); router.push('/qa/report'); }}
                >
                  <div className="mb-2 text-teal-400 font-bold text-lg">建立異常單</div>
                  <div className="text-xs text-slate-300 mb-2">負責建立新的異常單</div>
                  <span className="px-3 py-1 rounded border border-teal-600 text-teal-300 text-xs font-mono bg-teal-900/30">前往建立</span>
                </div>
                <div
                  className="flex-1 bg-teal-700/20 border border-teal-600 rounded-xl p-4 cursor-pointer hover:bg-teal-700/40 transition-all text-center"
                  onClick={() => { setShowQaModal(false); router.push('/qa/handling'); }}
                >
                  <div className="mb-2 text-teal-400 font-bold text-lg">異常單處理</div>
                  <div className="text-xs text-slate-300 mb-2">處理已建立的異常單</div>
                  <span className="px-3 py-1 rounded border border-teal-600 text-teal-300 text-xs font-mono bg-teal-900/30">前往處理</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- 發料/領料 Modal --- */}

    </div>
  )
}
