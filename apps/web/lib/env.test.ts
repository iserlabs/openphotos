import { describe, expect, it } from "vitest";

describe("env", () => {
  it("does not read process.env at import time", async () => {
    // Importing must never throw, even with zero env vars set — the getters
    // are lazy and only validate when a property is actually accessed.
    await expect(import("./env")).resolves.toBeDefined();
  });

  it("throws when a required var is accessed but unset", async () => {
    const { env } = await import("./env");
    delete process.env.PUBLIC_URL;
    expect(() => env.PUBLIC_URL).toThrow(/missing env PUBLIC_URL/);
  });

  it("splits ADMIN_DIDS on commas and drops empty entries", async () => {
    const { env } = await import("./env");
    process.env.ADMIN_DIDS = "did:plc:a,did:plc:b,";
    expect(env.ADMIN_DIDS).toEqual(["did:plc:a", "did:plc:b"]);
  });
});
