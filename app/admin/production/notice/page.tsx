"use client";

import { useEffect, useState } from "react";

// 群組清單改用輪詢刷新（取代原本的 postgres_changes 即時訂閱），
// 因為前端已不再直接連線 Supabase，RLS 鎖定後 realtime 訂閱也無法運作。
const GROUPS_POLL_INTERVAL_MS = 25000;

interface BomItem {
  id: number;
  product_code: string;
  product_name: string;
  group_name?: string;
  sample_days?: number;
  mass_days?: number;
}

export default function ProductionNoticeSettings() {
    const PAGE_SIZE = 50;
    const [page, setPage] = useState(1);
  const [bomItems, setBomItems] = useState<BomItem[]>([]);
  const [search, setSearch] = useState(""); // 預設搜尋為空
  const [groups, setGroups] = useState<{ id: number; name: string; sample_days: number; mass_days: number; summary?: string; mass_qty_standard?: number }[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [batchGroup, setBatchGroup] = useState("");
  const [showUngrouped, setShowUngrouped] = useState(false); // 預設顯示全部

  useEffect(() => {
    // 取得所有 BOM 資料與群組清單（改走後端 API，需先登入）
    const fetchBomAndGroups = async () => {
      try {
        const res = await fetch("/api/production/notice");
        const json = await res.json();
        if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
        setBomItems(Array.isArray(json.items) ? json.items : []);
        if (Array.isArray(json.groups)) setGroups(json.groups);
      } catch (e) {
        console.error("[產期告示設定] 載入資料失敗：", e);
      }
    };
    // 只刷新群組清單（輪詢用，避免每次都重撈整張 bom 表）
    const fetchGroups = async () => {
      try {
        const res = await fetch("/api/production/notice-group");
        const json = await res.json();
        if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
        if (Array.isArray(json.groups)) setGroups(json.groups);
      } catch (e) {
        console.error("[產期告示設定] 刷新群組清單失敗：", e);
      }
    };
    fetchBomAndGroups();

    // 群組清單改用輪詢刷新，取代原本的 postgres_changes 即時訂閱
    const pollId = setInterval(fetchGroups, GROUPS_POLL_INTERVAL_MS);
    return () => {
      clearInterval(pollId);
    };
  }, []);
  const setItemGroup = async (itemId: number, groupName: string) => {
    // 更新本地狀態
    setBomItems(items => items.map(item => item.id === itemId ? { ...item, group_name: groupName } : item));
    // 更新後端
    try {
      const res = await fetch("/api/production/notice", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, group_name: groupName }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
    } catch (e) {
      console.error("[產期告示設定] 更新品項群組失敗：", e);
    }
  };

  // 取得群組設定
  const getGroupConfig = (groupName: string) => groups.find(g => g.name === groupName);

  // 勾選切換
  const toggleSelect = (id: number) => {
    setSelected(sel => sel.includes(id) ? sel.filter(i => i !== id) : [...sel, id]);
  };

  // 全選/全不選
  const toggleSelectAll = (ids: number[]) => {
    setSelected(sel => sel.length === ids.length ? [] : ids);
  };

  // 批量設定群組
  const batchSetGroup = async () => {
    if (!batchGroup) return;
    // 更新本地狀態
    setBomItems(items => items.map(item => selected.includes(item.id) ? { ...item, group_name: batchGroup } : item));
    // 批量更新後端
    try {
      const res = await fetch("/api/production/notice", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selected, group_name: batchGroup }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
    } catch (e) {
      console.error("[產期告示設定] 批量更新品項群組失敗：", e);
    }
    setSelected([]);
    setBatchGroup("");
  };
  // 分頁顯示（只顯示當前頁資料）
  // 本地搜尋與分頁
  let filtered = bomItems;
  if (search.trim()) {
    filtered = filtered.filter(item =>
      item.product_code.includes(search.trim()) ||
      item.product_name.includes(search.trim())
    );
  }
  if (showUngrouped) {
    filtered = filtered.filter(item => !item.group_name);
  }
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const allIds = paged.map(item => item.id);
  // 分頁顯示邏輯
  const PAGE_BLOCK_SIZE = 10;
  const currentBlock = Math.floor((page - 1) / PAGE_BLOCK_SIZE);
  const blockStart = currentBlock * PAGE_BLOCK_SIZE + 1;
  const blockEnd = Math.min(blockStart + PAGE_BLOCK_SIZE - 1, totalPages);
  const hasPrevBlock = blockStart > 1;
  const hasNextBlock = blockEnd < totalPages;

  return (
    <div className="p-8 max-w-full mx-auto">
      <h1 className="text-3xl font-bold text-white mb-6">產期告示設定</h1>
      {/* ...existing code... */}
      <div className="flex items-center mb-4 gap-4">
        <input
          type="text"
          className="bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-white w-64"
          placeholder="搜尋編碼或名稱..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button
          className={`px-3 py-1.5 rounded font-bold ${showUngrouped ? 'bg-orange-600 text-white' : 'bg-slate-700 text-orange-200 hover:bg-orange-500 hover:text-white'}`}
          onClick={() => setShowUngrouped(v => !v)}
        >
          顯示未設定群組品項
        </button>
        <select className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-white" value={batchGroup} onChange={e => setBatchGroup(e.target.value)}>
          <option value="">批量設定群組...</option>
          {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
        </select>
        <button className="px-3 py-1.5 rounded bg-orange-500 text-white font-bold hover:bg-orange-600 disabled:bg-slate-700" onClick={batchSetGroup} disabled={!batchGroup || selected.length === 0}>套用</button>
      </div>
      {/* 分頁控制區塊（搜尋欄下方、表格上方，block 樣式） */}
      <div style={{margin:'16px 0', textAlign:'center', background:'#f59e42', padding:'8px', borderRadius:'8px'}}>
        <button
          style={{margin:'0 4px', padding:'6px 12px', borderRadius:'4px', background:'#334155', color:'#fff', fontWeight:'bold'}}
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page === 1}
        >上一頁</button>
        {hasPrevBlock && (
          <button
            style={{margin:'0 2px', padding:'4px 8px', borderRadius:'4px', background:'#1e293b', color:'#cbd5e1', fontWeight:'bold'}}
            onClick={() => setPage(blockStart - PAGE_BLOCK_SIZE)}
          >前10頁</button>
        )}
        {Array.from({ length: blockEnd - blockStart + 1 }, (_, i) => blockStart + i).map(pn => (
          <button
            key={pn}
            style={{margin:'0 2px', padding:'4px 8px', borderRadius:'4px', background: pn === page ? '#06b6d4' : '#1e293b', color: pn === page ? '#fff' : '#cbd5e1', fontWeight:'bold'}}
            onClick={() => setPage(pn)}
            disabled={pn === page}
          >{pn}</button>
        ))}
        {hasNextBlock && (
          <button
            style={{margin:'0 2px', padding:'4px 8px', borderRadius:'4px', background:'#1e293b', color:'#cbd5e1', fontWeight:'bold'}}
            onClick={() => setPage(blockStart + PAGE_BLOCK_SIZE)}
          >後10頁</button>
        )}
        <button
          style={{margin:'0 4px', padding:'6px 12px', borderRadius:'4px', background:'#334155', color:'#fff', fontWeight:'bold'}}
          onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
        >下一頁</button>
          <div style={{marginTop:'8px', color:'#334155', fontSize:'14px'}}>
            Debug: paged.length={paged.length}, totalPages={totalPages}, page={page}, blockStart={blockStart}, blockEnd={blockEnd}
          </div>
      </div>
      <table className="w-full text-left text-sm text-slate-400">
        <thead className="bg-slate-950 text-slate-200 uppercase font-mono text-xs">
          <tr>
            <th className="p-3 w-32 whitespace-nowrap">
              <input type="checkbox" checked={selected.length === allIds.length && allIds.length > 0} onChange={() => toggleSelectAll(allIds)} />
            </th>
            <th className="p-3 w-80 whitespace-nowrap">編碼</th>
            <th className="p-3 w-128 whitespace-nowrap">名稱</th>
            <th className="p-3 w-128 whitespace-nowrap">群組</th>
            <th className="p-3 w-96 whitespace-nowrap">BOM群組</th>
            <th className="p-3 w-192 whitespace-nowrap">工序概述</th>
            <th className="p-3 w-56 whitespace-nowrap">打樣天數</th>
            <th className="p-3 w-56 whitespace-nowrap">大貨天數</th>
            <th className="p-3 w-72 whitespace-nowrap">大量大貨數量</th>
          </tr>
        </thead>
        <tbody>
          {paged.map(item => {
            const group = getGroupConfig(item.group_name || "");
            return (
              <tr key={item.id}>
                <td className="p-3 w-32 whitespace-nowrap">
                  <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggleSelect(item.id)} />
                </td>
                <td className="p-3 w-80 whitespace-nowrap font-mono text-slate-300">{item.product_code}</td>
                <td className="p-3 w-128 whitespace-nowrap text-white" style={{maxWidth:'16rem', overflow:'hidden', textOverflow:'ellipsis'}}>{item.product_name}</td>
                <td className="p-3 w-128 whitespace-nowrap">
                  <select className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-white w-full" value={item.group_name || ""} onChange={e => setItemGroup(item.id, e.target.value)}>
                    <option value="">未設定</option>
                    {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                  </select>
                </td>
                <td className="p-3 w-96 whitespace-nowrap text-cyan-200">{item.group_name ?? '-'} </td>
                <td className="p-3 w-192 whitespace-nowrap overflow-x-auto text-slate-300" style={{maxWidth:'64rem'}}>{group?.summary ?? "-"}</td>
                <td className="p-3 w-56 whitespace-nowrap text-cyan-300">{group?.sample_days ?? "-"}</td>
                <td className="p-3 w-56 whitespace-nowrap text-cyan-300">{group?.mass_days ?? "-"}</td>
                <td className="p-3 w-72 whitespace-nowrap text-yellow-300">500</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}