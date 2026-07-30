import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { eq } from "drizzle-orm";
import { photographers, unreadCount } from "@openphotos/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";
import { Bell } from "@/components/bell";
import { signOut } from "./actions";
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
  title: "OpenPhotos",
  description: "An open, ATProto-native hub for photography.",
};

/**
 * A photographer session is any session whose DID has a row in
 * `photographers` (i.e. completed registration) — as opposed to a viewer
 * session, which only carries a signed-in DID. One lookup per request,
 * skipped entirely when signed out.
 */
async function isPhotographer(did: string | undefined): Promise<boolean> {
  if (!did) return false;
  const db = getDb();
  const [row] = await db
    .select({ did: photographers.did })
    .from(photographers)
    .where(eq(photographers.did, did));
  return row != null;
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getSession();
  const photographer = await isPhotographer(session.did);
  // Notifications only exist for photographer recipients, so skip the query
  // entirely for viewer/anon sessions rather than always fetching a zero.
  const unread = photographer && session.did ? await unreadCount(getDb(), session.did) : 0;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[#0a0a0a] text-zinc-100">
        <header className="border-b border-zinc-800">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight text-zinc-100">
              OpenPhotos
            </Link>
            <nav className="flex items-center gap-6 text-sm text-zinc-400">
              <Link href="/about" className="transition-colors hover:text-zinc-100">
                About
              </Link>
              {!photographer ? (
                <Link href="/register" className="transition-colors hover:text-zinc-100">
                  Register
                </Link>
              ) : null}
              {session.did ? (
                <>
                  <span className="text-zinc-300">{session.handle ?? session.did}</span>
                  {photographer ? (
                    <>
                      <Bell unreadCount={unread} />
                      <Link href="/settings" className="transition-colors hover:text-zinc-100">
                        Settings
                      </Link>
                    </>
                  ) : null}
                  <form action={signOut}>
                    <button
                      type="submit"
                      className="transition-colors hover:text-zinc-100"
                    >
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <Link href="/login" className="transition-colors hover:text-zinc-100">
                  Sign in
                </Link>
              )}
            </nav>
          </div>
        </header>

        <main className="flex flex-1 flex-col">{children}</main>

        <footer className="border-t border-zinc-800">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6 text-sm text-zinc-500">
            <span>&copy; {new Date().getFullYear()} OpenPhotos</span>
            <Link href="/dmca" className="transition-colors hover:text-zinc-100">
              DMCA
            </Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
