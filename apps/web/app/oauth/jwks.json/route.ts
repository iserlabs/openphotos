import { getPublicJwks } from "@/lib/oauth";

// Reads the signing key from env at request time — do not prerender at build.
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getPublicJwks());
}
