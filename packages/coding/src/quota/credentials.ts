/**
 * Coding capability resolver for the tokens `quota/` needs.
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
import type { QuotaCredentials, QuotaProvider } from "./types.js";
import { selectedQuotaProviders } from "./providers.js";

interface QuotaCredentialSources {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readTextFile?: (path: string) => Promise<string>;
  readClaudeKeychain?: () => Promise<string | null>;
}

/** Read the Codex OAuth token + account id from the selected Codex home. */
async function readCodexCreds(
  path: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<Pick<QuotaCredentials, "codexAccessToken" | "codexAccountId">> {
  try {
    const raw = await readTextFile(path);
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
 * Other platforms: use the selected config directory's .credentials.json.
 * A custom config directory must never fall back to the default account's
 * Keychain entry; no custom Keychain service name is inferred here.
 */
async function readClaudeCreds(
  path: string,
  useKeychain: boolean,
  readTextFile: (path: string) => Promise<string>,
  readKeychain: () => Promise<string | null>,
): Promise<Pick<QuotaCredentials, "claudeAccessToken">> {
  if (useKeychain) {
    try {
      const token = parseClaudeToken(await readKeychain());
      if (token) return { claudeAccessToken: token };
    } catch {
      /* An unavailable Keychain may still have a file-based credential. */
    }
  }
  // Cross-platform fallback: some installs keep a plaintext credentials file.
  try {
    const raw = await readTextFile(path);
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

/** Resolve only selected providers. Source failures are missing credentials; invalid selections throw. */
export async function resolveQuotaCredentials(
  providers?: readonly QuotaProvider[],
  sources: QuotaCredentialSources = {},
): Promise<QuotaCredentials> {
  const selected = selectedQuotaProviders(providers);
  if (selected.length === 0) return {};
  const env = sources.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || homedir();
  const readTextFile = sources.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const resolved = await Promise.all(
    selected.map((provider) =>
      provider === "codex"
        ? readCodexCreds(join(env.CODEX_HOME || join(home, ".codex"), "auth.json"), readTextFile)
        : readClaudeCreds(
            join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json"),
            (sources.platform ?? process.platform) === "darwin" &&
              env.CLAUDE_CONFIG_DIR === undefined,
            readTextFile,
            sources.readClaudeKeychain ?? runSecurity,
          ),
    ),
  );
  return Object.assign({}, ...resolved);
}
