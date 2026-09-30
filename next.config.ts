import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // 包裝專區 AI（D112 H6 實驗，預設不設＝現狀）：PACKAGING_AI_SDK_EXTERNAL=1 時 @anthropic-ai/sdk 不打包、改執行期 require——
  //   錯誤類別名稱不會被壓縮成單字母（標籤直接顯示 AnthropicError／APIConnectionError），也排除打包副作用。
  //   ⚠ 這是 build 時決定的（不是執行期），要在 Vercel Preview 設旗標驗證 /api/packaging/ai/health 正常後再考慮正式。
  ...(process.env.PACKAGING_AI_SDK_EXTERNAL === '1' ? { serverExternalPackages: ['@anthropic-ai/sdk'] } : {}),
  turbopack: {
    root: path.resolve(__dirname),
    resolveAlias: {
      tailwindcss: path.resolve(__dirname, "node_modules/tailwindcss"),
    },
  },
  async redirects() {
    return [
      {
        source: "/admin/production/anomaly",
        destination: "/qa",
        permanent: true,
      },
      {
        source: "/admin/production/anomaly/report",
        destination: "/qa/report",
        permanent: true,
      },
      {
        source: "/admin/production/anomaly/records",
        destination: "/qa/records",
        permanent: true,
      },
      {
        source: "/admin/production/anomaly/options",
        destination: "/qa/options",
        permanent: true,
      },
    ]
  },
  async headers() {
    // 全站安全標頭（SEC-11）。
    // 註：CSP（Content-Security-Policy）需配合實際外部來源（Supabase / Google Vision /
    //     SARA / LINE / ArgoERP）逐一測試後再加，貿然加上易破壞功能，故此處先不含 CSP。
    const securityHeaders = [
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    ]
    return [{ source: "/:path*", headers: securityHeaders }]
  },
};

export default nextConfig;
