/**
 * Provider auth/header resolution for custom model providers (TODO 7.2).
 *
 * - `authCommand`: a shell command whose stdout is an auth token. Used for
 *   short-lived tokens vended by an external tool (gcloud, aws, vault…). The
 *   result is cached briefly so we don't re-run the command on every request.
 * - `httpHeaders`: extra headers; a `$ENV_VAR` value is resolved from the
 *   environment at build time so secrets stay out of settings.json.
 *
 * The token-running side is isolated behind a `runCommand` injection so the
 * env-var + caching logic is unit-testable without spawning a shell.
 */

/** Resolve `$ENV` / `${ENV}` placeholders in a header value against `env`. */
export function resolveHeaderValue(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim());
  if (m) return env[m[1]] ?? "";
  return value;
}

/** Resolve every header value's env placeholders, dropping empties. */
export function resolveHeaders(
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    const resolved = resolveHeaderValue(v, env);
    if (resolved) out[k] = resolved;
  }
  return out;
}

type RunCommand = (cmd: string) => string;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
/** Token cache TTL — short, since external tokens are usually short-lived. */
const TOKEN_TTL_MS = 60_000;

/**
 * Run an auth command and return its trimmed first line as the token. Caches
 * by command string for {@link TOKEN_TTL_MS}. `now`/`runCommand` are injectable
 * for tests. Returns "" if the command yields no output.
 */
export function resolveAuthCommand(
  command: string,
  opts: { runCommand?: RunCommand; now?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const cached = tokenCache.get(command);
  if (cached && cached.expiresAt > now) return cached.token;

  const run =
    opts.runCommand ??
    ((cmd: string) => {
      // Lazy require so the pure helpers above don't pull in child_process.
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      return execSync(cmd, { encoding: "utf8", timeout: 30_000 });
    });

  const out = run(command) ?? "";
  const token = out.split("\n")[0]?.trim() ?? "";
  tokenCache.set(command, { token, expiresAt: now + TOKEN_TTL_MS });
  return token;
}

/** Test seam: clear the token cache. */
export function __clearAuthTokenCache(): void {
  tokenCache.clear();
}

/**
 * Resolve the effective API key for a client: an explicit `apiKey` wins;
 * otherwise run `authCommand` if present; otherwise fall back to `envKey`
 * (e.g. process.env.OPENAI_API_KEY). Returns undefined when nothing resolves.
 */
export function resolveApiKey(
  config: { apiKey?: string; authCommand?: string },
  envKey?: string,
  opts: { runCommand?: RunCommand; now?: number } = {},
): string | undefined {
  if (config.apiKey) return config.apiKey;
  if (config.authCommand) {
    const token = resolveAuthCommand(config.authCommand, opts);
    if (token) return token;
  }
  return envKey;
}
