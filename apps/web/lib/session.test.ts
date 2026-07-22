import { describe, it, expect } from "vitest";
import { isAdminDid } from "./session";

// getSession()/getIronSessionData() wire iron-session to Next's request-scoped
// cookie store, so they are only meaningfully exercised in the full OAuth smoke
// test (spec §13). The unit-testable business rule is the admin derivation:
// a session is admin iff it carries a DID that is listed in ADMIN_DIDS.
describe("session admin check", () => {
  it("is not admin without a did", () => {
    expect(isAdminDid(undefined, ["did:plc:a"])).toBe(false);
  });
  it("is admin when the did is in the allow-list", () => {
    expect(isAdminDid("did:plc:a", ["did:plc:a", "did:plc:b"])).toBe(true);
  });
  it("is not admin when the did is absent from the allow-list", () => {
    expect(isAdminDid("did:plc:z", ["did:plc:a"])).toBe(false);
  });
  it("is not admin against an empty allow-list", () => {
    expect(isAdminDid("did:plc:a", [])).toBe(false);
  });
});
