/**
 * Quota (rate-limit / usage) types for external coding-agent CLIs.
 *
 * DESIGN / BOUNDARY NOTE (see project_core_minimal_harness_business_layer):
 * "how to read Claude Code / Codex remaining quota" is provider-specific
 * BUSINESS policy, not core harness mechanism — it pokes a vendor's Keychain
 * entry, an undocumented usage endpoint, and private response headers. It lives
 * in this self-contained `quota/` module (one interface out: `checkQuota`) on
 * purpose, so it can be lifted wholesale into a plugin later without untangling
 * it from the rest of core. Nothing outside this module should know about
 * Keychain / wham endpoints / `anthropic-ratelimit-*` header names.
 */

/** A single rolling limit window (e.g. the 5-hour or 7-day window). */
export interface QuotaWindow {
  /** Which window this is. */
  kind: "5h" | "7d";
  /** Percent of the window's limit already used, 0–100. */
  usedPercent: number;
  /** Unix epoch seconds when this window resets, or null if unknown. */
  resetsAt: number | null;
}

/** Quota for one provider (claude | codex). */
export interface ProviderQuota {
  provider: "claude" | "codex";
  /** Present when the lookup succeeded. */
  windows?: QuotaWindow[];
  /** Subscription tier, when the source exposes it (e.g. "team", "pro"). */
  planType?: string | null;
  /** Human-readable failure reason when the lookup did not succeed. */
  error?: string;
}

export interface QuotaResult {
  claude?: ProviderQuota;
  codex?: ProviderQuota;
}

/**
 * A credential the host supplies so this module can talk to a vendor backend.
 * Core never reads the Keychain / auth.json itself — the host (desktop main /
 * server) resolves the secret and hands it in. This is the seam that makes the
 * whole module portable to a plugin.
 */
export interface QuotaCredentials {
  /** Claude Code OAuth access token (from Keychain "Claude Code-credentials"). */
  claudeAccessToken?: string;
  /** Codex OAuth access token + account id (from ~/.codex/auth.json). */
  codexAccessToken?: string;
  codexAccountId?: string;
}
