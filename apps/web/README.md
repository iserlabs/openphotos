# @openphotos/web

Next.js 16 (App Router) hub app for OpenPhotos — the public site, feed,
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

The invariant applies only to **top-level** segments. Nested, file-like
terminal segments may contain dots: the OAuth discovery documents live at
`app/oauth/client-metadata.json/route.ts` and `app/oauth/jwks.json/route.ts`.
Their top-level segment (`oauth`) is dotless and can never collide with a
handle; the dotted `*.json` segments are nested under it, so they're safe and
serve the exact filenames the ATProto authorization server fetches.
