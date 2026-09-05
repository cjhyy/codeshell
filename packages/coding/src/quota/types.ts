/**
 * Coding-agent quota (rate-limit / usage) types.
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

/**
 * A single rolling limit window.
 *
 * `kind` is NOT a closed set. Claude reports whichever windows apply to the
 * account: usually "5h" and "7d", but an account running on overage reports an
 * "overage" window INSTEAD of those (verified 2026-09-06 against a team /
 * default_claude_max_5x account). New window names appear without notice, so
 * the parser discovers them from the header prefix rather than matching a
 * hardcoded list. Renderers must treat `kind` as an opaque label.
 */
export interface QuotaWindow {
  /** Which window this is: "5h" | "7d" | "overage" | any future name. */
  kind: string;
  /** Percent of the window's limit already used, 0–100. */
  usedPercent: number;
  /** Unix epoch seconds when this window resets, or null if unknown. */
  resetsAt: number | null;
  /**
   * True for the window the API named as the binding constraint via
   * `anthropic-ratelimit-unified-representative-claim`. Claude only; a request
   * is throttled on THIS window, so it is the one to act on when several
   * windows disagree.
   */
  representative?: boolean;
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
