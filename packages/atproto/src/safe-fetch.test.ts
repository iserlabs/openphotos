import { describe, it, expect } from "vitest";
import { isPrivateIp, assertPublicHttps, UnsafeUrlError } from "./safe-fetch.js";

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
});
