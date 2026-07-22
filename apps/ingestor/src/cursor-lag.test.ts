import { describe, it, expect } from "vitest";
import { cursorLagSeconds } from "./cursor-lag.js";

describe("cursorLagSeconds", () => {
  it("is ~0 for a cursor timestamped at now", () => {
    const nowMs = 1_700_000_000_000;
    const timeUs = BigInt(nowMs) * 1000n;
    expect(cursorLagSeconds(timeUs, nowMs)).toBeCloseTo(0, 6);
  });

  it("is positive for a cursor lagging behind now", () => {
    const nowMs = 1_700_000_000_000;
    const timeUs = BigInt(nowMs - 300_000) * 1000n; // 300s behind
    expect(cursorLagSeconds(timeUs, nowMs)).toBeCloseTo(300, 6);
  });

  it("crosses the 300s alert threshold correctly", () => {
    const nowMs = 1_700_000_000_000;
    const justUnder = BigInt(nowMs - 299_000) * 1000n;
    const justOver = BigInt(nowMs - 301_000) * 1000n;
    expect(cursorLagSeconds(justUnder, nowMs)).toBeLessThan(300);
    expect(cursorLagSeconds(justOver, nowMs)).toBeGreaterThan(300);
  });

  it("is negative when the cursor is ahead of now (clock skew)", () => {
    const nowMs = 1_700_000_000_000;
    const timeUs = BigInt(nowMs + 1000) * 1000n;
    expect(cursorLagSeconds(timeUs, nowMs)).toBeCloseTo(-1, 6);
  });
});
