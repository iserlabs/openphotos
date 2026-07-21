import { getClientMetadata } from "@/lib/oauth";

// Reads env at request time — never prerender/cache this at build (keeps the
// zero-env build working and always reflects the deployed PUBLIC_URL).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(getClientMetadata());
}
