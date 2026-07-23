import { describe, it, expect } from "vitest";
import { encodeAppState, decodeAppState, sanitizeReturnTo } from "./oauth-state";

// encodeAppState/decodeAppState round-trip the "why did we start this OAuth
// flow" info through @atproto/oauth-client's own `state` parameter (see the
// VERIFY-API note in lib/oauth.ts). returnTo is the redirect target after a
// successful viewer sign-in, so it must be re-validated on the way back in
// case the OAuth `state` round-trip is ever fed anything but our own output.
describe("sanitizeReturnTo", () => {
  it("accepts a plain relative path", () => {
    expect(sanitizeReturnTo("/photo/x")).toBe("/photo/x");
  });
  it("accepts the bare root path", () => {
    expect(sanitizeReturnTo("/")).toBe("/");
  });
  it("rejects protocol-relative URLs", () => {
    expect(sanitizeReturnTo("//evil.com")).toBeUndefined();
  });
  it("rejects absolute https URLs", () => {
    expect(sanitizeReturnTo("https://evil.com")).toBeUndefined();
  });
  it("rejects javascript: URLs", () => {
    expect(sanitizeReturnTo("javascript:alert(1)")).toBeUndefined();
  });
  it("rejects backslash protocol-relative tricks", () => {
    expect(sanitizeReturnTo("/\\evil.com")).toBeUndefined();
  });
  it("rejects paths without a leading slash", () => {
    expect(sanitizeReturnTo("photo/x")).toBeUndefined();
  });
  it("rejects control characters that browsers may strip", () => {
    expect(sanitizeReturnTo("/\n/evil.com")).toBeUndefined();
    expect(sanitizeReturnTo("/\t/evil.com")).toBeUndefined();
  });
  it("rejects empty, null, and undefined", () => {
    expect(sanitizeReturnTo("")).toBeUndefined();
    expect(sanitizeReturnTo(null)).toBeUndefined();
    expect(sanitizeReturnTo(undefined)).toBeUndefined();
  });
});

describe("encodeAppState / decodeAppState round-trip", () => {
  it("round-trips mode=viewer with a valid returnTo", () => {
    const encoded = encodeAppState({ mode: "viewer", returnTo: "/photo/x" });
    expect(decodeAppState(encoded)).toEqual({ mode: "viewer", returnTo: "/photo/x" });
  });

  it("round-trips mode=register with no returnTo", () => {
    const encoded = encodeAppState({ mode: "register" });
    expect(decodeAppState(encoded)).toEqual({ mode: "register" });
  });

  it("drops an unsafe returnTo at encode time rather than encoding it", () => {
    const encoded = encodeAppState({ mode: "viewer", returnTo: "//evil.com" });
    expect(decodeAppState(encoded)).toEqual({ mode: "viewer" });
  });

  it("drops an unsafe returnTo at decode time rather than rejecting the whole state", () => {
    const forged = JSON.stringify({ mode: "viewer", returnTo: "javascript:alert(1)" });
    expect(decodeAppState(forged)).toEqual({ mode: "viewer" });
  });
});

describe("decodeAppState invalid input", () => {
  it("returns undefined for null/undefined/empty", () => {
    expect(decodeAppState(null)).toBeUndefined();
    expect(decodeAppState(undefined)).toBeUndefined();
    expect(decodeAppState("")).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(decodeAppState("not json")).toBeUndefined();
  });

  it("returns undefined for a JSON value that isn't an object", () => {
    expect(decodeAppState(JSON.stringify("just a string"))).toBeUndefined();
    expect(decodeAppState(JSON.stringify(42))).toBeUndefined();
    expect(decodeAppState(JSON.stringify(null))).toBeUndefined();
  });

  it("returns undefined for an unrecognized mode", () => {
    expect(decodeAppState(JSON.stringify({ mode: "admin" }))).toBeUndefined();
    expect(decodeAppState(JSON.stringify({}))).toBeUndefined();
  });
});
