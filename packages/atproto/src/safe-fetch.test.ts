import { describe, it, expect } from "vitest";
import {
  isPrivateIp,
  assertPublicHttps,
  safeFetch,
  createGuardedLookup,
  UnsafeUrlError,
} from "./safe-fetch.js";

describe("SSRF guard", () => {
  it.each(["127.0.0.1", "10.0.0.8", "172.16.5.5", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "0.0.0.0"])(
    "flags private/reserved ip %s", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("allows public ip %s", (ip) => expect(isPrivateIp(ip)).toBe(false));
  it("rejects http:// URLs", async () => {
    await expect(assertPublicHttps("http://example.com/x")).rejects.toThrow(UnsafeUrlError);
  });
  it("rejects hosts that resolve to private ranges", async () => {
    await expect(assertPublicHttps("https://localhost/x")).rejects.toThrow(UnsafeUrlError);
  });
  it("rejects a literal private/link-local IP without ever touching DNS", async () => {
    await expect(assertPublicHttps("https://169.254.169.254/x")).rejects.toThrow(UnsafeUrlError);
  });
  it("accepts a public IPv6 literal in bracket notation", async () => {
    await expect(assertPublicHttps("https://[2606:4700:4700::1111]/x")).resolves.toBeInstanceOf(URL);
  });
  it("rejects the IPv6 loopback literal in bracket notation", async () => {
    await expect(assertPublicHttps("https://[::1]/x")).rejects.toThrow(UnsafeUrlError);
  });
});

describe("safeFetch guard path", () => {
  it("rejects non-https urls before making any request", async () => {
    await expect(safeFetch("http://example.com/x")).rejects.toThrow(UnsafeUrlError);
  });
  it("rejects hosts that resolve to private ranges before making any request", async () => {
    await expect(safeFetch("https://localhost/x")).rejects.toThrow(UnsafeUrlError);
  });
});

describe("guardedLookup (DNS-rebinding pin)", () => {
  it("fails when any resolved address is private, even if others are public", async () => {
    const stubBaseLookup = (
      _hostname: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void
    ) => {
      cb(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ]);
    };
    const lookup = createGuardedLookup(stubBaseLookup as never);

    const err = await new Promise<unknown>((resolve) => {
      lookup("mixed.example.com", {}, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(UnsafeUrlError);
  });
});
