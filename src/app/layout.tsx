import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { LocaleProvider } from "@/contexts/locale-context";
import { ThemeProvider } from "@/components/theme-provider";
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
  title: {
    default: "Chorus",
    template: "%s | Chorus",
  },
  description: "AI Agent & Human collaboration platform for the AI-Driven Development Lifecycle",
  openGraph: {
    title: "Chorus",
    description: "AI Agent & Human collaboration platform for the AI-Driven Development Lifecycle",
    type: "website",
    siteName: "Chorus",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: next-themes' pre-hydration script mutates the
    // <html> class before React hydrates, which would otherwise trip a
    // hydration mismatch on the class attribute. This suppresses that one
    // expected diff (it does not silence real mismatches on descendants).
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>
          <LocaleProvider>{children}</LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
