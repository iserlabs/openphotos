import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { fetch as undiciFetch, Agent, type RequestInit as UndiciRequestInit } from "undici";

export class UnsafeUrlError extends Error {}

export function isPrivateIp(ip: string): boolean {
  const addr = ipaddr.parse(ip);
  const range = addr.range();
  return range !== "unicast"; // loopback, private, linkLocal, uniqueLocal, unspecified, reserved…
}

export async function assertPublicHttps(url: string): Promise<URL> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new UnsafeUrlError(`non-https url: ${url}`);
  // Strip IPv6 bracket notation (`[::1]` -> `::1`) so the literal-IP branch
  // below (isIP) recognizes bracketed IPv6 hosts instead of falling through
  // to a doomed DNS lookup on a string containing "[" and "]".
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await dnsLookupAsync(host, { all: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new UnsafeUrlError(`private address for ${host}`);
  }
  return u;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  addresses: LookupAddress[],
) => void;
type BaseLookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void;

/**
 * Factory for the guarded DNS lookup, parameterized on the underlying
 * resolver so tests can stub it without touching real DNS. Production code
 * uses the default (Node's `dns.lookup`) via the `guardedLookup` export
 * below.
 */
export function createGuardedLookup(baseLookup: BaseLookupFn = dnsLookup as unknown as BaseLookupFn): BaseLookupFn {
  return function guardedLookup(hostname, opts, callback) {
    baseLookup(hostname, { all: true, ...opts }, (err, addresses) => {
      if (err) return callback(err, []);
      for (const a of addresses) {
        if (isPrivateIp(a.address)) {
          return callback(new UnsafeUrlError(`private address resolved for ${hostname}: ${a.address}`), []);
        }
      }
      callback(null, addresses);
    });
  };
}

// Threat model: `assertPublicHttps` is a fast pre-check — it also rejects
// literal-IP hosts outright, which never reach DNS at all and so can't be
// re-resolved to something else. For hostname targets, though, a check-then-
// fetch design is a classic DNS-rebinding TOCTOU: the attacker's resolver can
// answer the pre-check's lookup with a public IP and then answer the actual
// connection's lookup with a private one. Pinning the connection through
// this guarded undici Agent means the SAME lookup result that gets inspected
// for private/reserved ranges is the one the socket actually connects to,
// closing that window.
export const guardedLookup = createGuardedLookup();
const guardedAgent = new Agent({ connect: { lookup: guardedLookup } });

export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  await assertPublicHttps(url);
  const signal = init?.signal ?? AbortSignal.timeout(10_000);
  const res = await undiciFetch(url, {
    ...(init as UndiciRequestInit | undefined),
    redirect: "error",
    dispatcher: guardedAgent,
    signal,
  });
  return res as unknown as Response;
}

export async function safeJsonFetch(url: string): Promise<unknown> {
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
}
