import { describe, it, expect } from "vitest";
import { relativeTime } from "./relative-time";

const NOW = new Date("2026-07-23T12:00:00.000Z");

describe("relativeTime", () => {
  it("renders sub-minute gaps as \"now\"", () => {
    expect(relativeTime(new Date(NOW.getTime() - 30_000), NOW)).toBe("now");
    expect(relativeTime(NOW, NOW)).toBe("now");
  });

  it("renders minutes", () => {
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe("5m");
    expect(relativeTime(new Date(NOW.getTime() - 59 * 60_000), NOW)).toBe("59m");
  });

  it("renders hours", () => {
    expect(relativeTime(new Date(NOW.getTime() - 3 * 60 * 60_000), NOW)).toBe("3h");
    expect(relativeTime(new Date(NOW.getTime() - 23 * 60 * 60_000), NOW)).toBe("23h");
  });

  it("renders days", () => {
    expect(relativeTime(new Date(NOW.getTime() - 2 * 24 * 60 * 60_000), NOW)).toBe("2d");
    expect(relativeTime(new Date(NOW.getTime() - 30 * 24 * 60 * 60_000), NOW)).toBe("30d");
  });

  it("clamps a future date (clock skew) to \"now\" rather than going negative", () => {
    expect(relativeTime(new Date(NOW.getTime() + 60_000), NOW)).toBe("now");
  });
});
