import * as Sentry from "@sentry/nextjs";
import { type Instrumentation } from "next";

// Sentry is only wired up when a DSN is configured — no DSN, no init, zero
// behavior change. Kept intentionally minimal: no sourcemap upload config.
export async function register(): Promise<void> {
  if (!process.env.SENTRY_DSN) return;

  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0,
    });
  }
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureRequestError(...args);
};
