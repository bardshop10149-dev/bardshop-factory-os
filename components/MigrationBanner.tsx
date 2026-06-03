const NEW_SITE_URL = 'https://factory-scheduler.vercel.app';

export default function MigrationBanner() {
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 99999,
      backgroundColor: '#0f172a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'sans-serif',
    }}>
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '16px',
        padding: '48px 40px',
        maxWidth: '480px',
        width: '90%',
        textAlign: 'center',
        color: '#f1f5f9',
      }}>
        <div style={{ fontSize: '56px', marginBottom: '16px' }}>🏭</div>
        <h1 style={{ fontSize: '22px', fontWeight: 'bold', marginBottom: '12px', color: '#fbbf24' }}>
          網站已搬家
        </h1>
        <p style={{ fontSize: '15px', color: '#94a3b8', lineHeight: 1.7, marginBottom: '8px' }}>
          本站已停止使用，請更新您的書籤。
        </p>
        <p style={{ fontSize: '15px', color: '#94a3b8', lineHeight: 1.7, marginBottom: '32px' }}>
          所有資料與功能已完整移至新網址，請點選下方按鈕前往。
        </p>
        <a
          href={NEW_SITE_URL}
          style={{
            display: 'inline-block',
            backgroundColor: '#f59e0b',
            color: '#1c1917',
            padding: '14px 32px',
            borderRadius: '10px',
            fontWeight: 'bold',
            fontSize: '16px',
            textDecoration: 'none',
          }}
        >
          前往新網站 →
        </a>
        <p style={{ marginTop: '24px', fontSize: '12px', color: '#475569' }}>
          {NEW_SITE_URL}
        </p>
      </div>
    </div>
  );
}
