import { safeJsonFetch } from "./safe-fetch.js";

type FetchJson = (url: string) => Promise<unknown>;

export async function resolvePdsEndpoint(did: string, fetchJson: FetchJson = safeJsonFetch): Promise<string> {
  let doc: any;
  if (did.startsWith("did:plc:")) {
    doc = await fetchJson(`https://plc.directory/${did}`);
  } else if (did.startsWith("did:web:")) {
    const host = decodeURIComponent(did.slice("did:web:".length));
    doc = await fetchJson(`https://${host}/.well-known/did.json`);
  } else {
    throw new Error(`unsupported did method: ${did}`);
  }
  const svc = (doc.service ?? []).find((s: any) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer");
  if (!svc) throw new Error(`no atproto_pds service in did doc for ${did}`);
  const endpoint = new URL(svc.serviceEndpoint);
  if (endpoint.protocol !== "https:") throw new Error(`pds endpoint not https for ${did}`);
  return endpoint.origin;
}
