import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { JoseKey } from "@atproto/jwk-jose";
import type { Db } from "@openphotos/db";
import { getOAuthClient, getClientMetadata } from "./oauth";

// getOAuthClient() (via clientMetadata()) reads env.PUBLIC_URL/env.OAUTH_JWK_1
// lazily -- see lib/env.ts's lazy getters -- so, like lib/env.test.ts, this
// sets process.env directly rather than mocking the module.
beforeAll(async () => {
  process.env.PUBLIC_URL = "https://oauth-test.example";
  // A real, freshly generated ES256 JWK: JoseKey.fromImportable (called
  // inside getOAuthClient) parses and validates the key material, so a
  // placeholder string won't do.
  const key = await JoseKey.generate(["ES256"], `test-${randomUUID()}`);
  process.env.OAUTH_JWK_1 = JSON.stringify({ ...key.privateJwk, alg: "ES256" });
});

describe("clientMetadata scope", () => {
  it("requests both atproto and transition:generic", () => {
    // transition:generic is required for createRecord/deleteRecord/uploadBlob
    // under the reference PDS's granular ScopePermissionsTransition
    // enforcement -- see the doc comment on clientMetadata() in oauth.ts for
    // the full citation. A bare "atproto" scope only establishes identity.
    expect(getClientMetadata().scope).toBe("atproto transition:generic");
  });
});

describe("getOAuthClient memoization", () => {
  it("returns the exact same client instance across calls with the same db instance", async () => {
    const db = {} as unknown as Db;
    const first = await getOAuthClient(db);
    const second = await getOAuthClient(db);
    expect(second).toBe(first);
  });

  it("builds a new client when a different db instance is passed", async () => {
    const dbA = {} as unknown as Db;
    const dbB = {} as unknown as Db;

    const clientA = await getOAuthClient(dbA);
    const clientB = await getOAuthClient(dbB);
    expect(clientB).not.toBe(clientA);

    // The cache only remembers the single most recent db -- going back to
    // dbA after dbB rebuilds again, rather than incorrectly resurrecting the
    // original dbA-bound client.
    const clientA2 = await getOAuthClient(dbA);
    expect(clientA2).not.toBe(clientA);
  });
});
