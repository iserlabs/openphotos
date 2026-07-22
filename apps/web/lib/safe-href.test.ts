import { describe, it, expect } from "vitest";
import { safeExternalHref } from "./safe-href";

describe("safeExternalHref", () => {
  it("passes through https URLs", () => {
    expect(safeExternalHref("https://example.com")).toBe("https://example.com/");
  });
  it("passes through http URLs", () => {
    expect(safeExternalHref("http://example.com")).toBe("http://example.com/");
  });
  it("rejects javascript: URLs", () => {
    expect(safeExternalHref("javascript:alert(1)")).toBeNull();
  });
  it("rejects data: URLs", () => {
    expect(safeExternalHref("data:text/html,x")).toBeNull();
  });
  it("rejects ftp: URLs", () => {
    expect(safeExternalHref("ftp://x")).toBeNull();
  });
  it("rejects garbage input", () => {
    expect(safeExternalHref("not a url")).toBeNull();
  });
  it("rejects null and undefined", () => {
    expect(safeExternalHref(null)).toBeNull();
    expect(safeExternalHref(undefined)).toBeNull();
  });
  it("rejects empty string", () => {
    expect(safeExternalHref("")).toBeNull();
  });
});
