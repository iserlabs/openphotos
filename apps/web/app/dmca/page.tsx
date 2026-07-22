import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DMCA / Copyright — Luminance",
};

export default function DmcaPage() {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
        DMCA &amp; Copyright Policy
      </h1>

      <div className="mt-6 space-y-4 text-zinc-300">
        <p>
          Luminance indexes photography records that photographers publish
          to their own Personal Data Server (PDS) on the AT Protocol. If you
          believe content indexed on Luminance infringes your copyright, you
          may submit a takedown notice to{" "}
          <a
            href="mailto:dmca@luminance.social"
            className="text-zinc-100 underline underline-offset-2"
          >
            dmca@luminance.social
          </a>
          .
        </p>

        <section>
          <h2 className="mt-8 text-lg font-medium text-zinc-100">
            What a takedown notice must include
          </h2>
          <p className="mt-2">
            To be effective under the Digital Millennium Copyright Act, your
            notice must include:
          </p>
          <ul className="mt-2 list-disc space-y-2 pl-6">
            <li>
              Identification of the copyrighted work you claim has been
              infringed.
            </li>
            <li>
              Identification of the specific material you claim is
              infringing, and information reasonably sufficient to let us
              locate it (e.g. the Luminance URL or the AT-URI of the
              record).
            </li>
            <li>
              Your contact information, including your name, mailing
              address, telephone number, and email address.
            </li>
            <li>
              A statement that you have a good-faith belief that use of the
              material in the manner complained of is not authorized by the
              copyright owner, its agent, or the law.
            </li>
            <li>
              A statement, made under penalty of perjury, that the
              information in the notice is accurate and that you are the
              copyright owner or are authorized to act on the copyright
              owner&apos;s behalf.
            </li>
            <li>A physical or electronic signature.</li>
          </ul>
        </section>

        <section>
          <h2 className="mt-8 text-lg font-medium text-zinc-100">
            Counter-notices
          </h2>
          <p className="mt-2">
            If material you posted was removed in error or misidentification,
            you may submit a counter-notice to the same address above. A
            valid counter-notice must identify the removed material and its
            prior location, include your contact information, and a
            statement under penalty of perjury that you have a good-faith
            belief the material was removed as a result of mistake or
            misidentification, along with a statement consenting to the
            jurisdiction of the appropriate federal court.
          </p>
        </section>

        <section>
          <h2 className="mt-8 text-lg font-medium text-zinc-100">
            Repeat infringers
          </h2>
          <p className="mt-2">
            Accounts and registrations associated with repeat infringement
            are terminated.
          </p>
        </section>
      </div>
    </div>
  );
}
