import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import MigrationBanner from '../components/MigrationBanner';
import SessionKeeper from '../components/SessionKeeper';
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BARDSHOP EIP",
  description: "啟盛國際企業資訊入口 (Enterprise Information Portal)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* Session 自動續期：token 快到期時用 refresh token 換新，根治「開著的頁面 token 失效鬼打牆」 */}
        <SessionKeeper />
        {process.env.NEXT_PUBLIC_SHOW_MIGRATION_BANNER === 'true'
          ? <MigrationBanner />
          : children
        }

      </body>
    </html>
  );
}