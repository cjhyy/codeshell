/**
 * Default resolver for the tokens `quota/` needs.
 *
 * This is the ONE platform-specific file in the module — it reads a vendor's
 * Keychain entry / auth.json. A host that stores secrets differently (or a
 * future plugin) can bypass this and build QuotaCredentials itself; core logic
 * in index.ts only depends on the QuotaCredentials shape.
 *
 * All reads are best-effort: a missing token yields `undefined`, never a throw,
 * so a machine without Codex or without Keychain access degrades to "quota
 * unavailable for that provider" instead of failing the whole call.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QuotaCredentials } from "./types.js";

function userHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/** Read the Codex OAuth token + account id from ~/.codex/auth.json. */
async function readCodexCreds(): Promise<Pick<QuotaCredentials, "codexAccessToken" | "codexAccountId">> {
  try {
    const raw = await readFile(join(userHome(), ".codex", "auth.json"), "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const tokens = (j.tokens ?? {}) as Record<string, unknown>;
    const token = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
    const acct = typeof tokens.account_id === "string" ? tokens.account_id : undefined;
    return { codexAccessToken: token, codexAccountId: acct };
  } catch {
    return {};
  }
}

/**
 * Read the Claude Code OAuth access token.
 * macOS: Keychain generic-password "Claude Code-credentials".
 * Other platforms: fall back to a plaintext ~/.claude/.credentials.json if present.
 */
async function readClaudeCreds(): Promise<Pick<QuotaCredentials, "claudeAccessToken">> {
  // macOS Keychain first.
  if (process.platform === "darwin") {
    const raw = await runSecurity();
    const token = parseClaudeToken(raw);
    if (token) return { claudeAccessToken: token };
  }
  // Cross-platform fallback: some installs keep a plaintext credentials file.
  try {
    const raw = await readFile(join(userHome(), ".claude", ".credentials.json"), "utf8");
    const token = parseClaudeToken(raw);
    if (token) return { claudeAccessToken: token };
  } catch {
    /* not present */
  }
  return {};
}

function parseClaudeToken(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const oauth = (j.claudeAiOauth ?? {}) as Record<string, unknown>;
    return typeof oauth.accessToken === "string" ? oauth.accessToken : undefined;
  } catch {
    return undefined;
  }
}

function runSecurity(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 4000 },
      (err, stdout) => resolve(err ? null : stdout.toString().trim()),
    );
  });
}

/** Resolve all tokens from their standard local locations. Never throws. */
export async function resolveQuotaCredentials(): Promise<QuotaCredentials> {
  const [codex, claude] = await Promise.all([readCodexCreds(), readClaudeCreds()]);
  return { ...codex, ...claude };
}
