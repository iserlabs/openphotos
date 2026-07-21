import { feedPage } from "@luminance/db";
import { getDb } from "@/lib/db";

// Live DB per request; JSON mirror of the same keyset feed the homepage
// renders, for programmatic/future client consumption (e.g. a JS-enhanced
// "Load more" that fetches instead of navigating — not wired up in v1).
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const did = searchParams.get("did") ?? undefined;
  const requested = Number(searchParams.get("limit"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

  const page = await feedPage(getDb(), { limit, cursor, did });
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
  });
}
