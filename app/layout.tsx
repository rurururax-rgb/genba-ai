import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "現場AI",
  description: "工務店の現場情報・見積・工程をまとめる業務補助ツール",
  // ブラウザ自動翻訳の抑止（Google Translate は <meta name="google" content="notranslate"> を参照）
  other: { google: "notranslate" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // lang="ja" + translate="no":
    //   以前は lang="en" だったため、日本語環境の Chrome が「英語ページ」と判定して自動翻訳し、
    //   ① 320,000 → 「32万」、「単価」→「炭水化物」などの誤訳表示
    //   ② 翻訳で置き換わったテキストノードを React が更新できず、保存後も旧値のまま表示
    //   が発生していた。業務画面は翻訳させない。
    <html
      lang="ja"
      translate="no"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased notranslate`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
