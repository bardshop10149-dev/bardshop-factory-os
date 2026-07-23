 'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { NavButton } from '../../../components/NavButton';
import { supabase } from '../../../lib/supabaseClient';

interface QaReport {
  id: number;
  created_at: string;
  order_number: string;
  item_code: string | null;
  item_name: string | null;
  qa_category: string | null;
  qa_department: string | null;
  qa_reporter: string | null;
  handler_department: string | null;
  qa_handlers: string[] | string | null;
  reason: string;
  handler_record: string | null;
  immediate_action: string | null;
  attachments: string[] | null;
}

export default function QaHandlePage() {
  const [pendingReports, setPendingReports] = useState<QaReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<number | null>(null);
  const [handlerRecord, setHandlerRecord] = useState('');
  const [immediateAction, setImmediateAction] = useState('');
  const [saving, setSaving] = useState(false);
  const [editAttachFiles, setEditAttachFiles] = useState<File[]>([]);
  const [editPreviewUrls, setEditPreviewUrls] = useState<string[]>([]);
  const [editExistingAttachments, setEditExistingAttachments] = useState<string[]>([]);
  const [mobileSessionId, setMobileSessionId] = useState('');
  const [showQrModal, setShowQrModal] = useState(false);
  const [mobileUrls, setMobileUrls] = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [notifyPreview, setNotifyPreview] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const startMobileSession = useCallback(() => {
    const sid = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    setMobileSessionId(sid);
    setShowQrModal(true);
    setMobileUrls([]);
  }, []);

  useEffect(() => {
    if (!mobileSessionId || !showQrModal) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    const poll = async () => {
      const { data } = await supabase.storage
        .from('anomaly-attachments')
        .list(`mobile/${mobileSessionId}`);
      if (data && data.length > 0) {
        const urls = data
          .filter((f) => f.name !== '.emptyFolderPlaceholder')
          .map((f) => {
            const { data: urlData } = supabase.storage
              .from('anomaly-attachments')
              .getPublicUrl(`mobile/${mobileSessionId}/${f.name}`);
            return urlData.publicUrl;
          });
        setMobileUrls(urls);
      }
    };
    void poll();
    pollRef.current = setInterval(() => void poll(), 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [mobileSessionId, showQrModal]);

  const confirmMobilePhotos = () => {
    setEditExistingAttachments((prev) => [...prev, ...mobileUrls]);
    setShowQrModal(false);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  useEffect(() => {
    const fetchPending = async () => {
      setLoading(true);
      const { data } = await supabase
        .from('schedule_anomaly_reports')
        .select('*')
        .eq('report_type', 'qa')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      setPendingReports((data as QaReport[]) || []);
      setLoading(false);
    };
    fetchPending();
  }, []);

  const handleEdit = (report: QaReport) => {
    setEditId(report.id);
    setHandlerRecord(report.handler_record || '');
    setImmediateAction(report.immediate_action || '');
    setEditAttachFiles([]);
    setEditPreviewUrls([]);
    setEditExistingAttachments(Array.isArray(report.attachments) ? report.attachments : []);
  };

  const buildLineMessage = (report: QaReport, handlingText: string) => {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const handlers = Array.isArray(report.qa_handlers) ? report.qa_handlers : [];
    const lines = [
      '✅ 【異常單處理完成】',
      '',
      `📋 工單編號：${report.order_number || '-'}`,
      `🔢 品項編碼：${report.item_code || '-'}`,
      `📦 品名/名稱：${report.item_name || '-'}`,
      `⚠️ 異常原因：${report.reason || '-'}`,
      `🏷️ 分類：${report.qa_category || '-'}`,
      `🏢 回報部門：${report.qa_department || '-'}`,
      `👤 回報人員：${report.qa_reporter || '-'}`,
      `🏭 處理部門：${report.handler_department || '-'}`,
      `🔧 處理人員：${handlers.join('、') || '-'}`,
      `📝 處理紀錄：${handlingText || '-'}`,
      `📌 狀態：🟢 已完成`,
      `🕐 通知時間：${now}`,
    ];
    return lines.join('\n');
  };

  const handleCopyNotify = async () => {
    if (!notifyPreview) return;
    try {
      await navigator.clipboard.writeText(notifyPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = notifyPreview;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSave = async () => {
    if (!handlerRecord.trim()) {
      alert('請填寫異常處理');
      return;
    }
    setSaving(true);
    try {
      const currentReport = pendingReports.find((r) => r.id === editId);
      const uploadedUrls: string[] = [...editExistingAttachments];
      for (const file of editAttachFiles) {
        const ext = file.name.split('.').pop() || 'jpg';
        const filePath = `handling/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from('anomaly-attachments')
          .upload(filePath, file);
        if (uploadError) { console.error('Upload error:', uploadError); continue; }
        const { data: urlData } = supabase.storage
          .from('anomaly-attachments')
          .getPublicUrl(filePath);
        if (urlData?.publicUrl) uploadedUrls.push(urlData.publicUrl);
      }

      const { error } = await supabase
        .from('schedule_anomaly_reports')
        .update({ handler_record: handlerRecord, immediate_action: immediateAction.trim() || null, status: 'confirmed', attachments: uploadedUrls })
        .eq('id', editId);
      if (error) throw error;
      if (currentReport) {
        const msg = buildLineMessage(currentReport, handlerRecord.trim());
        setNotifyPreview(msg);
        setCopied(false);
      }
      setEditId(null);
      setHandlerRecord('');
      setImmediateAction('');
      // 重新載入
      const { data } = await supabase
        .from('schedule_anomaly_reports')
        .select('*')
        .eq('report_type', 'qa')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      setPendingReports((data as QaReport[]) || []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      alert('儲存失敗：' + message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex justify-end mb-4">
        <NavButton href="/" direction="home" title="回到首頁" />
      </div>
      <h1 className="text-2xl font-bold text-white mb-4">異常單處理</h1>
      {loading ? (
        <div className="text-slate-400">載入中...</div>
      ) : pendingReports.length === 0 ? (
        <div className="text-slate-400">目前沒有待處理的異常單</div>
      ) : (
        <table className="w-full text-left text-sm text-slate-300 mb-6">
          <thead className="bg-slate-950 text-slate-200 uppercase text-xs font-mono">
            <tr>
              <th className="p-3">日期</th>
              <th className="p-3">相關單號</th>
              <th className="p-3">品項</th>
              <th className="p-3">異常分類</th>
              <th className="p-3">異常回報</th>
              <th className="p-3">異常處理</th>
              <th className="p-3">異常原因</th>
              <th className="p-3">附件</th>
              <th className="p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {pendingReports.map((report) => (
              <tr key={report.id}>
                <td className="p-3">{new Date(report.created_at).toLocaleDateString()}</td>
                <td className="p-3">{report.order_number}</td>
                <td className="p-3">
                  <div className="text-xs">{report.item_code || '-'}</div>
                  <div className="text-xs text-slate-100">{report.item_name || '-'}</div>
                </td>
                <td className="p-3">{report.qa_category || '-'}</td>
                <td className="p-3">
                  <div>{report.qa_department || '-'}</div>
                  <div className="text-xs text-cyan-300">{report.qa_reporter || '-'}</div>
                </td>
                <td className="p-3">
                  <div>{report.handler_department || '-'}</div>
                  <div className="text-xs text-cyan-300">{Array.isArray(report.qa_handlers) ? report.qa_handlers.join(', ') : (report.qa_handlers || '-')}</div>
                </td>
                <td className="p-3">{report.reason}</td>
                <td className="p-3">
                  {Array.isArray(report.attachments) && report.attachments.length > 0 ? (
                    <div className="flex gap-1 flex-wrap">
                      {report.attachments.map((url, i) => (
                        <button key={i} type="button" onClick={() => setLightboxUrl(url)}>
                          <img src={url} alt={`附件${i + 1}`} className="w-10 h-10 object-cover rounded border border-slate-600 hover:border-cyan-400 transition-colors cursor-pointer" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-500">-</span>
                  )}
                </td>
                <td className="p-3">
                  <button
                    className="px-3 py-1 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-900/30 text-xs"
                    onClick={() => handleEdit(report)}
                  >
                    填寫處理
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editId && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-bold text-white">填寫異常處理</h2>
          <textarea
            rows={4}
            value={handlerRecord}
            onChange={(e) => setHandlerRecord(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
            placeholder="請填寫異常處理內容..."
          />

          <div>
            <label className="text-xs text-slate-400">即時處理方式（選填，缺失單列印用）</label>
            <textarea
              rows={3}
              value={immediateAction}
              onChange={(e) => setImmediateAction(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white"
              placeholder="請填寫即時處理方式..."
            />
          </div>

          <div>
            <label className="text-xs text-slate-400">附件圖片</label>
            {editExistingAttachments.length > 0 && (
              <div className="mt-1 flex gap-2 flex-wrap">
                {editExistingAttachments.map((url, idx) => (
                  <div key={`existing-${idx}`} className="relative group">
                    <button type="button" onClick={() => setLightboxUrl(url)}>
                      <img src={url} alt={`existing-${idx}`} className="w-16 h-16 object-cover rounded border border-slate-600 cursor-pointer hover:border-cyan-400" />
                    </button>
                    <button
                      type="button"
                      className="absolute -top-1 -right-1 w-5 h-5 bg-rose-600 text-white rounded-full text-xs hidden group-hover:flex items-center justify-center"
                      onClick={() => setEditExistingAttachments((prev) => prev.filter((_, i) => i !== idx))}
                    >×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1 flex gap-2">
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (!files.length) return;
                  setEditAttachFiles((prev) => [...prev, ...files]);
                  const urls = files.map((f) => URL.createObjectURL(f));
                  setEditPreviewUrls((prev) => [...prev, ...urls]);
                  e.target.value = '';
                }}
                className="flex-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white text-sm file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:bg-cyan-900 file:text-cyan-200 file:text-xs"
              />
              <button
                type="button"
                onClick={startMobileSession}
                className="px-3 py-2 rounded border border-violet-600 text-violet-300 hover:bg-violet-900/30 text-sm whitespace-nowrap"
              >
                📱 手機拍照
              </button>
            </div>
            {editPreviewUrls.length > 0 && (
              <div className="mt-2 flex gap-2 flex-wrap">
                {editPreviewUrls.map((url, idx) => (
                  <div key={`new-${idx}`} className="relative group">
                    <img src={url} alt={`preview-${idx}`} className="w-16 h-16 object-cover rounded border border-cyan-700" />
                    <button
                      type="button"
                      className="absolute -top-1 -right-1 w-5 h-5 bg-rose-600 text-white rounded-full text-xs hidden group-hover:flex items-center justify-center"
                      onClick={() => {
                        setEditAttachFiles((prev) => prev.filter((_, i) => i !== idx));
                        setEditPreviewUrls((prev) => prev.filter((_, i) => i !== idx));
                      }}
                    >×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2 justify-end">
            <button
              className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
              onClick={() => { setEditId(null); setHandlerRecord(''); setImmediateAction(''); }}
            >取消</button>
            <button
              className="px-4 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-bold disabled:bg-slate-700 disabled:text-slate-400"
              onClick={handleSave}
              disabled={saving}
            >{saving ? '儲存中...' : '儲存處理'}</button>
          </div>
        </div>
      )}

      {showQrModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-sm w-full space-y-4">
            <h2 className="text-lg font-bold text-white text-center">📱 手機掃碼上傳圖片</h2>
            <p className="text-xs text-slate-400 text-center">用手機掃描下方 QR Code 拍照上傳，照片會自動同步到表單</p>
            <p className="text-sm text-amber-400 font-bold text-center bg-amber-900/30 border border-amber-700 rounded-lg px-3 py-2">⚠️ 照片全部上傳完成前請勿關閉此視窗</p>
            <div className="flex justify-center bg-white rounded-xl p-4">
              <QRCodeSVG
                value={`${window.location.origin}/upload-photo?sid=${mobileSessionId}`}
                size={200}
                level="M"
              />
            </div>
            {mobileUrls.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-emerald-400 text-center">已收到 {mobileUrls.length} 張圖片</p>
                <div className="flex gap-2 flex-wrap justify-center">
                  {mobileUrls.map((url, i) => (
                    <img key={i} src={url} alt={`mobile-${i}`} className="w-14 h-14 object-cover rounded border border-slate-600" />
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => { setShowQrModal(false); if (pollRef.current) clearInterval(pollRef.current); }}
                className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm"
              >
                取消
              </button>
              {mobileUrls.length > 0 && (
                <button
                  onClick={confirmMobilePhotos}
                  className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm"
                >
                  確認使用 ({mobileUrls.length} 張)
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {notifyPreview && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-lg w-full space-y-4">
            <h2 className="text-lg font-bold text-white text-center">📨 通知訊息預覽</h2>
            <p className="text-xs text-slate-400 text-center">此訊息與 LINE Bot 推播內容相同，可複製後手動貼到 LINE 群組</p>
            <pre className="bg-slate-950 border border-slate-700 rounded-lg p-4 text-sm text-slate-200 whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto select-all">{notifyPreview}</pre>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => { if (confirm('確定關閉？關閉後訊息將無法再次查看。')) setNotifyPreview(null) }}
                className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm"
              >
                關閉
              </button>
              <button
                onClick={() => void handleCopyNotify()}
                className={`px-4 py-2 rounded font-bold text-sm transition-colors ${
                  copied
                    ? 'bg-emerald-600 text-white'
                    : 'bg-cyan-600 hover:bg-cyan-500 text-white'
                }`}
              >
                {copied ? '✅ 已複製！' : '📋 複製訊息'}
              </button>
            </div>
          </div>
        </div>
      )}

      {lightboxUrl && (
        <div className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4" onClick={() => setLightboxUrl(null)}>
          <div className="relative max-w-4xl max-h-[90vh]">
            <img src={lightboxUrl} alt="附件大圖" className="max-w-full max-h-[90vh] object-contain rounded-lg" />
            <button
              className="absolute top-2 right-2 w-8 h-8 bg-slate-900/80 text-white rounded-full flex items-center justify-center hover:bg-slate-700"
              onClick={() => setLightboxUrl(null)}
            >✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
