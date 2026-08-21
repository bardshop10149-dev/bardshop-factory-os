export interface DirectItem {
  name: string
  path: string
  icon?: string
  locked?: boolean
}

export interface SubMenuItem {
  name: string
  path?: never
  icon?: string
  children: DirectItem[]
}

export type MenuEntry = DirectItem | SubMenuItem

export const NAV_GROUPS: Array<{ title: string; theme: string; items: MenuEntry[] }> = [
  {
    title: '發單作業區',
    theme: 'cyan',
    items: [
      {
        name: '每日出單表',
        path: '/admin/argoerp/daily-order-sheet',
        icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
      },
      {
        name: '追蹤清單',
        icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
        children: [
          { name: '大量訂單追蹤', path: '/admin/argoerp/bulk-order-tracking', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
          { name: '缺料追蹤',     path: '/admin/argoerp/shortage-tracking',   icon: 'M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 17h.01' },
        ],
      },
      {
        name: '製令工單生成',
        icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
        children: [
          { name: '出單表→製令工單', path: '/admin/argoerp/order-batch-export',   icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
          { name: '集單→製令工單',   path: '/admin/argoerp/group-order-export',   icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
          { name: '瑕疵補印→製令工單', path: '/admin/argoerp/ng-order-export',   icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z' },
        ],
      },
      {
        name: '請購單生成',
        icon: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z',
        children: [
          { name: '出單表→委外請購', path: '/admin/argoerp/order-batch-export-pr',  icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
          { name: '單獨開立→請購單', path: '/admin/argoerp/standalone-pr-create', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
        ],
      },
      {
        name: '採購單生成',
        icon: 'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z',
        children: [
          { name: '出單表→常平採購', path: '/admin/argoerp/order-batch-export-c',   icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
          { name: '單獨開立→採購單',   path: '/admin/argoerp/standalone-po-create', icon: 'M12 4v16m8-8H4' },
        ],
      },
      {
        name: '批備料單生成',
        icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
        children: [
          { name: '製令工單→批備料', path: '/admin/argoerp/material-prep',    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
          { name: '瑕疵補印→批備料', path: '/admin/argoerp/ng-material-prep', icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z' },
        ],
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
        name: 'MRP 測試區',
        path: '/admin/argoerp/mrp-test',
        icon: 'M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z'
      },

    ]
  },
  {
    title: '塔台SARA',
    theme: 'emerald',
    items: [
      {
        name: 'SARA 同步區',
        path: '/admin/sara/sync',
        icon: 'M13 10V3L4 14h7v7l9-11h-7z'
      },
      {
        name: 'SARA 工序格式產生器',
        path: '/admin/sara/process-gen',
        icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2'
      },
      {
        name: '塔台報工紀錄',
        path: '/admin/sara/wip-records',
        icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01'
      },
      {
        name: 'SARA 資料交換區',
        path: '/admin/sara/exchange',
        icon: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4'
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
      },
      {
        name: '各機台每日產出',
        path: '/admin/production/daily-machine-output',
        icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z'
      },
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
    title: '系統資料庫',
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
      { name: '工序總表查詢', path: '/admin/database', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4' },
      { name: '工序總表更新', path: '/admin/upload', icon: 'M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12' },
      { name: '工序/BOM補登表', path: '/admin/database/item-route-bom-gaps', icon: 'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z' },
    ]
  },
]