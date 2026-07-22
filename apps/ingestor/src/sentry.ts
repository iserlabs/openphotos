import * as Sentry from "@sentry/node";

/**
 * Gate for every Sentry call site in the ingestor: with no DSN configured,
 * `init` is never called and this stays `false`, so callers skip Sentry
 * entirely — zero behavior change with no env set.
 */
export const sentryEnabled = Boolean(process.env.SENTRY_DSN);

if (sentryEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0,
  });
}

export { Sentry };
