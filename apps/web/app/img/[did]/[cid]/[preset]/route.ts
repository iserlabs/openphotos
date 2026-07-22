import { getDb } from "@/lib/db";
import { proxyImage, type Preset } from "@/lib/image-proxy";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ did: string; cid: string; preset: string }> },
) {
  const { did, cid, preset } = await params;
  // `did` arrives URL-decoded from the Next router; decoding again would
  // corrupt did:web ports (%3A).
  const r = await proxyImage(getDb(), {
    did,
    cid,
    preset: preset as Preset,
    accept: req.headers.get("accept") ?? "",
  });
  // Buffer's backing ArrayBufferLike isn't structurally assignable to the DOM
  // lib's BodyInit (which wants a concrete ArrayBuffer) — re-view as Uint8Array<ArrayBuffer>.
  const body = r.body ? new Uint8Array(r.body) : null;
  return new Response(body, {
    status: r.status,
    headers: {
      "Cache-Control": r.cacheControl,
      ...(r.contentType ? { "Content-Type": r.contentType } : {}),
    },
  });
}
