import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState } from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import { eq } from "drizzle-orm";
import { oauthStates, oauthSessions, type Db } from "@luminance/db";
import { resolvePdsEndpoint, safeJsonFetch } from "@luminance/atproto";
import { env } from "./env";

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
    scope: "atproto",
    application_type: "web" as const,
    token_endpoint_auth_method: "private_key_jwt" as const,
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks_uri: `${base}/oauth/jwks.json`,
  };
}

/**
 * Construct a per-request OAuth client. Built lazily (never at module load) so
 * the app builds with zero env vars — `env.*` and `OAUTH_JWK_1` are only read
 * when a real OAuth request comes in. State/session are persisted in Postgres
 * via the Drizzle-backed SimpleStores below so the flow survives across the
 * stateless serverless requests of the authorize -> callback round-trip.
 */
export async function getOAuthClient(db: Db): Promise<NodeOAuthClient> {
  return new NodeOAuthClient({
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
