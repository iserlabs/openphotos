import type { Metadata } from "next";
import Link from "next/link";
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
  title: "Luminance",
  description: "An open, ATProto-native hub for photography.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[#0a0a0a] text-zinc-100">
        <header className="border-b border-zinc-800">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight text-zinc-100">
              Luminance
            </Link>
            <nav className="flex gap-6 text-sm text-zinc-400">
              <Link href="/about" className="transition-colors hover:text-zinc-100">
                About
              </Link>
              <Link href="/register" className="transition-colors hover:text-zinc-100">
                Register
              </Link>
              <Link href="/settings" className="transition-colors hover:text-zinc-100">
                Settings
              </Link>
            </nav>
          </div>
        </header>

        <main className="flex flex-1 flex-col">{children}</main>

        <footer className="border-t border-zinc-800">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6 text-sm text-zinc-500">
            <span>&copy; {new Date().getFullYear()} Luminance</span>
            <Link href="/dmca" className="transition-colors hover:text-zinc-100">
              DMCA
            </Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
