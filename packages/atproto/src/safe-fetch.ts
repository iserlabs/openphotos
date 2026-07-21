import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export class UnsafeUrlError extends Error {}

export function isPrivateIp(ip: string): boolean {
  const addr = ipaddr.parse(ip);
  const range = addr.range();
  return range !== "unicast"; // loopback, private, linkLocal, uniqueLocal, unspecified, reserved…
}

export async function assertPublicHttps(url: string): Promise<URL> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new UnsafeUrlError(`non-https url: ${url}`);
  const host = u.hostname;
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new UnsafeUrlError(`private address for ${host}`);
  }
  return u;
}

export async function safeJsonFetch(url: string): Promise<unknown> {
  await assertPublicHttps(url);
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
}
