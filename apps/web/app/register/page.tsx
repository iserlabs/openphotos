import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { startLogin } from "./actions";

export const metadata: Metadata = {
  title: "Register — OpenPhotos",
};

const ERRORS: Record<string, string> = {
  handle: "Enter your Bluesky handle to continue.",
  login: "We couldn't start the login for that handle. Check it and try again.",
  oauth: "Login didn't complete. Please try again.",
  session: "Your session expired. Please sign in again.",
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await getSession();
  const message = error ? ERRORS[error] : undefined;

  return (
    <div className="mx-auto w-full max-w-md flex-1 px-6 py-20">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
        Register your photography
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-zinc-400">
        OpenPhotos indexes photos straight from your own PDS — nothing is uploaded
        here. Sign in with your AT Protocol account to opt in; you can leave at any
        time.
      </p>

      {message ? (
        <p
          role="alert"
          className="mt-6 rounded-md border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300"
        >
          {message}
        </p>
      ) : null}

      {session.did ? (
        <p className="mt-6 rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-sm text-zinc-300">
          You&apos;re signed in as{" "}
          <span className="font-medium text-zinc-100">
            {session.handle ?? session.did}
          </span>
          . Continue to{" "}
          <a href="/register/sources" className="text-sky-400 hover:text-sky-300">
            choose your sources
          </a>
          .
        </p>
      ) : null}

      <form action={startLogin} className="mt-8 space-y-3">
        <label htmlFor="handle" className="block text-sm font-medium text-zinc-300">
          Bluesky handle
        </label>
        <input
          id="handle"
          name="handle"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="alice.bsky.social"
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
        />
        <button
          type="submit"
          className="w-full rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
        >
          Continue with AT Protocol
        </button>
      </form>
    </div>
  );
}
