/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sentry DSN (public, write-only). Unset disables Sentry. */
  readonly VITE_SENTRY_DSN?: string;
  /** Release identifier reported to Sentry; set to the git SHA in CI. */
  readonly VITE_SENTRY_RELEASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
