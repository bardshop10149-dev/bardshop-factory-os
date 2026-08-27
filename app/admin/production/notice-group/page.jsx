"use client";

import { useState, useEffect } from "react";

export default function ProductionNoticeGroupSettings() {
  // 移動群組順序
  const [groups, setGroups] = useState([]);
  const [newGroup, setNewGroup] = useState({ name: "", sample_days: 0, mass_days: 0, summary: "", mass_qty_standard: 0 });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_editIdx, setEditIdx] = useState(null);
  const [editGroup, setEditGroup] = useState({ name: "", sample_days: 0, mass_days: 0, summary: "", mass_qty_standard: 0 });

  const moveGroup = async (idx, direction) => {
    const newGroups = [...groups];
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= newGroups.length) return;
    [newGroups[idx], newGroups[targetIdx]] = [newGroups[targetIdx], newGroups[idx]];
    setGroups(newGroups);
    await Promise.all(
      newGroups.map((g, i) =>
        fetch("/api/production/notice-group", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: g.id, fields: { order: i } }),
        })
      )
    );
  };

  const deleteGroup = async (idx) => {
    const groupId = groups[idx]?.id;
    if (!groupId) return;
    const res = await fetch("/api/production/notice-group", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: groupId }),
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.success) setGroups(gs => gs.filter((_, i) => i !== idx));
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _saveEdit = async (idx) => {
    if (!editGroup.name) return;
    const groupId = groups[idx]?.id;
    if (!groupId) return;
    const res = await fetch("/api/production/notice-group", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: groupId, fields: editGroup }),
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.success && Array.isArray(json.groups) && json.groups.length > 0) {
      setGroups(gs => gs.map((g, i) => (i === idx ? json.groups[0] : g)));
    }
    setEditIdx(null);
    setEditGroup({ name: "", sample_days: 0, mass_days: 0, summary: "", mass_qty_standard: 0 });
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _cancelEdit = () => {
    setEditIdx(null);
    setEditGroup({ name: "", sample_days: 0, mass_days: 0, summary: "", mass_qty_standard: 0 });
  };

  const startEdit = (idx) => {
    setEditIdx(idx);
    setEditGroup(groups[idx]);
  };

  useEffect(() => {
    const fetchGroups = async () => {
      const res = await fetch("/api/production/notice-group");
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success && Array.isArray(json.groups)) setGroups(json.groups);
    };
    fetchGroups();
  }, []);

  const addGroup = async () => {
    if (!newGroup.name) return;
    const res = await fetch("/api/production/notice-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newGroup),
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.success && Array.isArray(json.groups)) setGroups(gs => [...gs, ...json.groups]);
    setNewGroup({ name: "", sample_days: 0, mass_days: 0, summary: "", mass_qty_standard: 0 });
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold text-white mb-6">產期告示群組設定</h1>
      <div className="mb-8 p-4 bg-slate-900 border border-slate-700 rounded-xl">
        <h2 className="text-xl font-bold text-orange-400 mb-4">新增群組</h2>
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex flex-col w-96">
            <label className="block text-slate-300 mb-1">群組名稱</label>
            <input type="text" className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white w-full" value={newGroup.name} onChange={e => setNewGroup(g => ({ ...g, name: e.target.value }))} />
          </div>
          <div className="flex flex-col flex-1 min-w-[320px]">
            <label className="block text-slate-300 mb-1">工序概述</label>
            <input type="text" className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white w-full" value={newGroup.summary} onChange={e => setNewGroup(g => ({ ...g, summary: e.target.value }))} />
          </div>
          <div className="flex flex-col w-48">
            <label className="block text-slate-300 mb-1">打樣工作天數</label>
            <input type="number" className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white w-full" value={newGroup.sample_days} onChange={e => setNewGroup(g => ({ ...g, sample_days: Number(e.target.value) }))} />
          </div>
          <div className="flex flex-col w-48">
            <label className="block text-slate-300 mb-1">一般大貨工作天數</label>
            <input type="number" className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white w-full" value={newGroup.mass_days} onChange={e => setNewGroup(g => ({ ...g, mass_days: Number(e.target.value) }))} />
          </div>
          <div className="flex flex-col w-56">
            <label className="block text-slate-300 mb-1">大量大貨數量標準</label>
            <input type="number" className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white w-full" value={newGroup.mass_qty_standard} onChange={e => setNewGroup(g => ({ ...g, mass_qty_standard: Number(e.target.value) }))} />
          </div>
          <div className="flex items-end h-full">
            <button className="px-8 py-2 bg-orange-500 text-white rounded hover:bg-orange-600" style={{minWidth:'140px'}} onClick={addGroup}>新增群組</button>
          </div>
        </div>
      </div>
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6">
        <h2 className="text-xl font-bold text-cyan-400 mb-6">群組列表</h2>
        <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-slate-400">
          <thead className="bg-slate-950 text-slate-200 uppercase font-mono text-xs">
            <tr>
              <th className="p-3 w-72 whitespace-nowrap">群組名稱</th>
              <th className="p-3 w-96 whitespace-nowrap">工序概述</th>
              <th className="p-3 w-40 whitespace-nowrap">打樣天數</th>
              <th className="p-3 w-40 whitespace-nowrap">大貨天數</th>
              <th className="p-3 w-56 whitespace-nowrap">大量大貨數量標準</th>
              <th className="p-3 w-40 whitespace-nowrap">操作</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, idx) => (
              <tr key={idx}>
                <td className="p-3 w-72 whitespace-nowrap text-white">{g.name}</td>
                <td className="p-3 w-96 whitespace-nowrap text-slate-300">{g.summary || '-'} </td>
                <td className="p-3 w-40 whitespace-nowrap text-cyan-300">{g.sample_days}</td>
                <td className="p-3 w-40 whitespace-nowrap text-orange-300">{g.mass_days}</td>
                <td className="p-3 w-56 whitespace-nowrap text-yellow-300">{g.mass_qty_standard ?? '-'}</td>
                <td className="p-3 w-40 whitespace-nowrap flex gap-2">
                  <button className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700" onClick={() => startEdit(idx)}>編輯</button>
                  <button className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700" onClick={() => deleteGroup(idx)}>刪除</button>
                  <button className="px-2 py-1 bg-slate-700 text-white rounded hover:bg-slate-800" onClick={() => moveGroup(idx, "up")}>↑</button>
                  <button className="px-2 py-1 bg-slate-700 text-white rounded hover:bg-slate-800" onClick={() => moveGroup(idx, "down")}>↓</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
