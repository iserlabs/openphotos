import { Lexicons, BlobRef, type LexiconDoc, type ValidationResult } from "@atproto/lexicon";
import profile from "../lexicons/social/luminance/actor/profile.json" with { type: "json" };
import strongRef from "../lexicons/com/atproto/repo/strongRef.json" with { type: "json" };
import labelDefs from "../lexicons/com/atproto/label/defs.json" with { type: "json" };

// `social.luminance.portfolio.{photo,series}` were retired 2026-07-28 — zero
// records ever existed in the wild (see docs/runbooks/publish-lexicons.md §7).
// `social.opencontent.*` is the current portfolio vocabulary; its schema is
// authored/owned externally (opencontent.social), so no local copy lives here.
export const LUMINANCE_PROFILE = "social.luminance.actor.profile";
export const BSKY_POST = "app.bsky.feed.post";
export const BSKY_PROFILE = "app.bsky.actor.profile";
export const GRAIN_PREFIX = "social.grain.";
export const OPENCONTENT_PHOTOGRAPH = "social.opencontent.photograph";
export const OPENCONTENT_COLLECTION = "social.opencontent.collection";

export const lexicons = [profile, strongRef, labelDefs] as LexiconDoc[];

/**
 * `@atproto/lexicon`'s blob validator requires an actual `BlobRef` instance
 * (checked via `instanceof`), but records deserialized from JSON (over the
 * wire, from a firehose payload, or in a test fixture) represent blobs as
 * plain `{ $type: "blob", ref, mimeType, size }` objects. Real ATProto
 * pipelines hydrate these via a `jsonToLex`-style pass before validation;
 * this package's callers pass plain JSON, so `lexiconValidator` hydrates
 * blob-shaped values into `BlobRef` instances before delegating to the
 * upstream validator.
 */
function hydrateBlobRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrateBlobRefs);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.$type === "blob" && "ref" in obj && "mimeType" in obj && "size" in obj) {
      // `obj.ref` is the raw JSON ref shape (e.g. `{ $link: string }`), not yet
      // a real `CID` instance; `BlobRef`'s validator only checks
      // `instanceof BlobRef`, so the exact `ref` shape is not load-bearing here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new BlobRef(obj.ref as any, obj.mimeType as string, obj.size as number);
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) out[key] = hydrateBlobRefs(val);
    return out;
  }
  return value;
}

class LuminanceLexicons extends Lexicons {
  override validate(lexUri: string, value: unknown): ValidationResult {
    return super.validate(lexUri, hydrateBlobRefs(value));
  }
}

export const lexiconValidator = new LuminanceLexicons(lexicons);
