import { describe, it, expect } from "vitest";
import { createTestDb, photographers } from "@luminance/db";
import { eq } from "drizzle-orm";
import { createFreshnessProbe } from "./freshness-probe.js";

const DID = "did:plc:kevin";
const resolvePds = async () => "https://pds.example.com";
const revResponder = (revs: Record<string, string>) => async (url: string) => {
  const did = new URL(url).searchParams.get("did")!;
  return { cid: "bafy", rev: revs[did] };
};

async function status(db: Awaited<ReturnType<typeof createTestDb>>, did: string) {
  const [row] = await db.select().from(photographers).where(eq(photographers.did, did));
  return row?.backfillStatus;
}

describe("freshness probe", () => {
  it("first sighting only primes the baseline — no re-arm", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "k.test", backfillStatus: "complete" });
    const probe = createFreshnessProbe(db, { fetchJson: revResponder({ [DID]: "rev-1" }), resolvePds });
    await probe.probeOnce();
    expect(await status(db, DID)).toBe("complete");
  });

  it("re-arms when the rev moves", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values({ did: DID, handle: "k.test", backfillStatus: "complete" });
    const revs = { [DID]: "rev-1" };
    const probe = createFreshnessProbe(db, { fetchJson: revResponder(revs), resolvePds });
    await probe.probeOnce();
    revs[DID] = "rev-2";
    await probe.probeOnce();
    expect(await status(db, DID)).toBe("pending");
  });

  it("does not touch an unchanged rev or non-active photographers", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values([
      { did: DID, handle: "k.test", backfillStatus: "complete" },
      { did: "did:plc:gone", handle: "gone.test", status: "deregistered", backfillStatus: "complete" },
    ]);
    const calls: string[] = [];
    const fetchJson = async (url: string) => {
      calls.push(new URL(url).searchParams.get("did")!);
      return { rev: "rev-1" };
    };
    const probe = createFreshnessProbe(db, { fetchJson, resolvePds });
    await probe.probeOnce();
    await probe.probeOnce();
    expect(await status(db, DID)).toBe("complete");
    expect(calls).not.toContain("did:plc:gone");
  });

  it("a failing PDS skips that photographer without stopping the probe", async () => {
    const db = await createTestDb();
    await db.insert(photographers).values([
      { did: "did:plc:broken", handle: "b.test", backfillStatus: "complete" },
      { did: DID, handle: "k.test", backfillStatus: "complete" },
    ]);
    const revs: Record<string, string> = { [DID]: "rev-1" };
    const fetchJson = async (url: string) => {
      const did = new URL(url).searchParams.get("did")!;
      if (did === "did:plc:broken") throw new Error("pds down");
      return { rev: revs[did] };
    };
    const probe = createFreshnessProbe(db, { fetchJson, resolvePds });
    await probe.probeOnce();
    revs[DID] = "rev-2";
    await probe.probeOnce();
    expect(await status(db, DID)).toBe("pending");
  });
});
