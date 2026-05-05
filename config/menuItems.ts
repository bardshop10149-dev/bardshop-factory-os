export const NAV_GROUPS = [
  {
    title: '發單作業區',
    theme: 'cyan',
    items: [
      {
        name: '訂單批量轉製令匯出',
        path: '/admin/argoerp/order-batch-export',
        icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
      },
      {
        name: '訂單暫緩區',
        path: '/admin/argoerp/staging',
        icon: 'M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z'
      },
      {
        name: '生產機台分配/列印',
        path: '/admin/argoerp/mo-summary',
        icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01'
      },
      {
        name: '生產批備料',
        path: '/admin/argoerp/material-prep',
        icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4'
      },
    ]
  },
  {
    title: 'ARGO資料庫',
    theme: 'indigo',
    items: [
      {
        name: 'ERP 同步區',
        path: '/admin/argoerp/erp-sync',
        icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15'
      },
      {
        name: '銷售訂單表',
        path: '/admin/argoerp/erp-db/sales',
        icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
      },
      {
        name: '生產製令表',
        path: '/admin/argoerp/erp-db/mo',
        icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z'
      },
      {
        name: '採購訂單表',
        path: '/admin/argoerp/erp-db/po',
        icon: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z'
      },
      {
        name: '委外製令表',
        path: '/admin/argoerp/erp-db/subcontract',
        icon: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4'
      },
      {
        name: '倉庫庫存表',
        path: '/admin/argoerp/erp-db/inventory',
        icon: 'M20 7H4a2 2 0 00-2 2v8a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM7 11h10M7 15h6'
      },
    ]
  },
  {
    title: '生產管理入口',
    theme: 'blue',
    items: [
      {
        name: '開單異常統計',
        path: '/admin/production/order-anomaly',
        icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'
      },
    ]
  },
  {
    title: '產期告示',
    theme: 'orange',
    items: [
      {
        name: '告示設定',
        path: '/admin/production/notice',
        icon: 'M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z'
      },
      {
        name: '群組設定',
        path: '/admin/production/notice-group',
        icon: 'M12 6v6l4 2'
      },
      {
        name: '產期詢問記錄',
        path: '/admin/production/notice/schedule-confirm',
        icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'
      }
    ]
  },
  {
    title: '產線排程看板',
    theme: 'purple',
    items: [
      { name: '印刷排程', path: '/admin/production/printing', icon: '...' },
      { name: '雷切排程', path: '/admin/production/laser', icon: '...' },
      { name: '後加工排程', path: '/admin/production/post', icon: '...' },
      { name: '包裝排程', path: '/admin/production/packaging', icon: '...' },
      { name: '委外排程', path: '/admin/production/outsourced', icon: '...' },
      { name: '常平排程', path: '/admin/production/changping', icon: '...' },
   ]
  },
  {
    title: '物料管理',
    theme: 'cyan',
    items: [
      {
        name: 'BOM表',
        path: '/admin/materials/bom',
        icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
      },
      {
        name: '替代料號設定',
        path: '/admin/materials/substitute',
        icon: 'M4 7h16M4 12h10m-10 5h16'
      },
    ]
  },
  {
    title: '工序資料庫',
    theme: 'green',
    items: [
      { name: '工序總表查詢', path: '/admin/database', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4' },
      { name: '工序總表更新', path: '/admin/upload', icon: 'M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12' },
    ]
  },
]