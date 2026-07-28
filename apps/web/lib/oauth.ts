import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState } from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import { eq } from "drizzle-orm";
import { oauthStates, oauthSessions, type Db } from "@luminance/db";
import { resolvePdsEndpoint, safeJsonFetch } from "@luminance/atproto";
import { env } from "./env";
import { encodeAppState, type AppState } from "./oauth-state";

/**
 * Build the client metadata document. Derived entirely from `env.PUBLIC_URL` so
 * the `/oauth/client-metadata.json` route and the OAuth client agree byte-for-byte
 * (the ATProto AS fetches `client_id` and validates the returned metadata).
 *
 * `client_id` is, by ATProto convention, the URL of this very document.
 */
function clientMetadata() {
  const base = env.PUBLIC_URL;
  return {
    client_id: `${base}/oauth/client-metadata.json`,
    client_name: "Luminance",
    client_uri: base,
    redirect_uris: [`${base}/oauth/callback`] as [string],
    grant_types: ["authorization_code", "refresh_token"] as ["authorization_code", "refresh_token"],
    response_types: ["code"] as ["code"],
    // "atproto" alone only establishes identity -- @atproto/oauth-scopes'
    // granular ScopePermissionsTransition model (see @atproto/pds's
    // auth-verifier, which enforces it) gates createRecord/deleteRecord/
    // uploadBlob on the additional `transition:generic` scope, and rejects
    // writes from a bare-`atproto` session with ScopeMissingError. Our
    // writes (interactions.ts, photo/actions.ts, register/actions.ts) work
    // today only because granular enforcement is unevenly rolled out across
    // the PDS fleet (bsky Aug-2025 discussion #4118) -- a ticking defect,
    // not a guarantee. `transition:generic` is the same package's
    // documented backward-compat scope restoring the older full-account
    // access a plain scope string used to imply, which is exactly what
    // every write path here needs.
    scope: "atproto transition:generic",
    application_type: "web" as const,
    token_endpoint_auth_method: "private_key_jwt" as const,
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks_uri: `${base}/oauth/jwks.json`,
  };
}

// Memoized client, gated on reference-equality of the `db` argument (not a
// computed key). The state/session stores below close over `db` directly --
// they don't just take it as a one-off parameter, they read through it on
// every call for the client's whole lifetime -- so a cached client is only
// safe to hand back when the *exact same* `db` instance is passed again. In
// production every call site (see apps/web/lib/db.ts's `getDb()`) resolves
// through the same module-level `db ??= createDb(...)` singleton, so this
// reference check hits on effectively every call, same as if we'd keyed on
// nothing at all. It only rebuilds when a genuinely different `db` shows up
// (e.g. a fresh per-test db), which is the correct behavior there too:
// reusing a client built against a stale/different db would silently read
// and write OAuth state through the wrong connection.
let cachedOAuthClient: { db: Db; client: NodeOAuthClient } | undefined;

/**
 * Construct (or reuse) the OAuth client. Built lazily (never at module load)
 * so the app builds with zero env vars — `env.*` and `OAUTH_JWK_1` are only
 * read when a real OAuth request comes in. State/session are persisted in
 * Postgres via the Drizzle-backed SimpleStores below so the flow survives
 * across the stateless serverless requests of the authorize -> callback
 * round-trip.
 *
 * Memoized (see {@link cachedOAuthClient}) rather than rebuilt on every
 * call: `@atproto/oauth-client`'s DPoP-nonce cache lives ON the client
 * instance (an in-memory `SimpleStoreMemory`, per its own source), not in
 * our Postgres stores. A fresh `NodeOAuthClient` per call means a fresh,
 * empty nonce cache every time, forcing a nonce-discovery round trip on
 * every authenticated PDS request instead of just the first (same defect
 * class open-portfolio's `apps/site/lib/oauth.ts` hit and fixed with its own
 * config-keyed cache). This app's client config (env vars) is fixed for the
 * process lifetime, so reusing one client for the process's life is safe.
 */
export async function getOAuthClient(db: Db): Promise<NodeOAuthClient> {
  if (cachedOAuthClient?.db === db) return cachedOAuthClient.client;
  const client = new NodeOAuthClient({
    clientMetadata: clientMetadata(),
    keyset: [await JoseKey.fromImportable(env.OAUTH_JWK_1)],
    stateStore: {
      async set(key: string, state: NodeSavedState) {
        await db
          .insert(oauthStates)
          .values({ key, state })
          .onConflictDoUpdate({ target: oauthStates.key, set: { state } });
      },
      async get(key: string) {
        const [r] = await db.select().from(oauthStates).where(eq(oauthStates.key, key));
        return (r?.state as NodeSavedState | undefined) ?? undefined;
      },
      async del(key: string) {
        await db.delete(oauthStates).where(eq(oauthStates.key, key));
      },
    },
    sessionStore: {
      async set(key: string, session: NodeSavedSession) {
        await db
          .insert(oauthSessions)
          .values({ key, session })
          .onConflictDoUpdate({ target: oauthSessions.key, set: { session, updatedAt: new Date() } });
      },
      async get(key: string) {
        const [r] = await db.select().from(oauthSessions).where(eq(oauthSessions.key, key));
        return (r?.session as NodeSavedSession | undefined) ?? undefined;
      },
      async del(key: string) {
        await db.delete(oauthSessions).where(eq(oauthSessions.key, key));
      },
    },
  });
  cachedOAuthClient = { db, client };
  return client;
}

/**
 * Start the OAuth authorize redirect for `handle`, carrying `appState` (mode +
 * optional returnTo) through the round-trip.
 *
 * VERIFY-API (Task 4): the installed `@atproto/oauth-client-node@0.4.9`
 * (via `@atproto/oauth-client@0.7.11`) natively supports an app-defined
 * `state` string on `authorize(handle, { state })` — see
 * `node_modules/.pnpm/@atproto+oauth-client@0.7.11/node_modules/@atproto/oauth-client/dist/oauth-client.js`:
 * `authorize()` stores our `state` value as `appState` inside the *same*
 * nonce-keyed record it already writes to `stateStore` (backed by the
 * existing `oauthStates` Drizzle/JSONB table below) alongside the PKCE
 * verifier and DPoP key, and `callback()` returns it verbatim as
 * `{ session, state }`. So the encoded `AppState` never leaves our own
 * server and needs no new table, column, or cookie — it rides inside the
 * OAuth library's own state-store row for the lifetime of the flow.
 */
export async function authorizeWithState(
  client: NodeOAuthClient,
  handle: string,
  appState: AppState,
): Promise<URL> {
  return client.authorize(handle, { state: encodeAppState(appState) });
}

/** Public client-metadata document, for the `/oauth/client-metadata.json` route. */
export function getClientMetadata() {
  return clientMetadata();
}

/**
 * Public JWKS derived from the signing keyset, for the `/oauth/jwks.json` route.
 * `publicJwk` strips the private `d` component, so only public key material is
 * ever serialized here.
 */
export async function getPublicJwks() {
  const key = await JoseKey.fromImportable(env.OAUTH_JWK_1);
  return { keys: [key.publicJwk] };
}

/**
 * Resolve a DID's current handle via `com.atproto.repo.describeRepo` on its own
 * PDS (located through the DID document). Uses the SSRF-guarded fetch from
 * `@luminance/atproto`. Used at registration time to fill the photographer's
 * handle column.
 */
export async function resolveHandle(did: string): Promise<string> {
  const pds = await resolvePdsEndpoint(did);
  const data = (await safeJsonFetch(
    `${pds}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`,
  )) as { handle?: string };
  if (!data.handle) throw new Error(`could not resolve handle for ${did}`);
  return data.handle;
}
