import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { sanitizeReturnTo } from "@/lib/oauth-state";
import { startLogin } from "@/app/register/actions";

export const metadata: Metadata = {
  title: "Sign in — Luminance",
};

const ERRORS: Record<string, string> = {
  handle: "Enter your Bluesky handle to continue.",
  login: "We couldn't start the login for that handle. Check it and try again.",
  oauth: "Login didn't complete. Please try again.",
};

/**
 * Viewer sign-in. Shares `startLogin` with `/register` — this form just adds
 * hidden `mode=viewer` and (validated) `returnTo` fields, so the callback
 * fork in app/oauth/callback/route.ts sends the visitor back here instead of
 * into the photographer registration flow.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const { error, returnTo: returnToParam } = await searchParams;
  const session = await getSession();
  const message = error ? ERRORS[error] : undefined;
  const returnTo = sanitizeReturnTo(returnToParam);

  return (
    <div className="mx-auto w-full max-w-md flex-1 px-6 py-20">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Sign in</h1>
      <p className="mt-4 text-sm leading-relaxed text-zinc-400">
        Sign in with your AT Protocol account to follow photographers and
        personalize your feed. Luminance never sees your password.
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
          You&apos;re already signed in as{" "}
          <span className="font-medium text-zinc-100">
            {session.handle ?? session.did}
          </span>
          .
        </p>
      ) : (
        <form action={startLogin} className="mt-8 space-y-3">
          <input type="hidden" name="mode" value="viewer" />
          {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
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
      )}
    </div>
  );
}
