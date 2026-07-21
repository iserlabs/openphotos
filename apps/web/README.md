# @luminance/web

Next.js 16 (App Router) hub app for Luminance — the public site, feed,
profile/photo pages, registration, OAuth, and the image proxy.

## Development

```bash
pnpm --filter web dev        # start the dev server
pnpm --filter web build      # production build
pnpm --filter web typecheck  # tsc --noEmit
pnpm --filter web test       # vitest
```

Copy `.env.example` to `.env.local` and fill in real values before running
against a live database.

## Route-naming invariant

Every top-level route segment under `app/` must be **dotless** (e.g.
`/about`, `/register`, `/dmca`). Bluesky handles always contain a dot
(`alice.bsky.social`), and the profile route resolves handles directly off
the root path (`/[handle]`) — a dotted top-level route would be ambiguous
with, or could shadow, a handle.
