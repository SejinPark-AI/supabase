import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Supabase DB 복사",
  description: "원본 Supabase 프로젝트의 public 스키마 테이블과 데이터를 대상 프로젝트로 복사합니다.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
