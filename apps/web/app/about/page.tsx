import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About — Luminance",
};

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
        About Luminance
      </h1>
      <div className="mt-6 space-y-4 text-zinc-300">
        <p>
          Luminance is an opt-in photography hub built on the AT Protocol, the
          open network behind Bluesky. It is not a place to upload photos —
          it is an index. Photographers keep publishing to their own
          Personal Data Server (PDS) exactly as they already do, and
          Luminance reads those public records to assemble a dedicated feed,
          profile, and photo-detail experience for photography.
        </p>
        <p>
          Because every photo stays hosted at the photographer&apos;s own
          PDS, nothing about how their data is owned or controlled changes
          by appearing here. Photographers can register their handle to be
          indexed, and can leave at any time; removing or editing a record
          at the source is reflected the same way it always would be on the
          open network.
        </p>
        <p>
          Luminance indexes public posts and records — mainly image posts
          from Bluesky and dedicated photography lexicons — and never writes
          to anyone else&apos;s repository. The goal is a fast, focused,
          gallery-style way to browse photography on ATProto, not a walled
          garden.
        </p>
      </div>
    </div>
  );
}
