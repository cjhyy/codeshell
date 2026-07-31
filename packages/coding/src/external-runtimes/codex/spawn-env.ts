/**
 * Environment for a spawned Codex process.
 *
 * The one non-obvious entry is `NO_PROXY`. Codex's Rust MCP client (reqwest)
 * honours `HTTP_PROXY`/`HTTPS_PROXY`, and on a corporate network or behind a PAC
 * file it will route even a `127.0.0.1` request through the upstream proxy. The
 * proxy does not understand localhost, answers with an HTML error page, and every
 * MCP transport dies with `UnexpectedContentType`. The user-visible symptom is
 * "Codex cannot see any CodeShell tools" with nothing in the bridge log, because
 * the request never arrives.
 *
 * Learned from the `makecindy/cindy` reference implementation (design §16)
 * rather than the hard way.
 */

const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"] as const;

export interface CodexSpawnEnvOptions {
  /** Base environment; defaults to the current process env. */
  base?: NodeJS.ProcessEnv;
  /** Bearer token env var name and value for the loopback MCP bridge. */
  bridgeToken?: { name: string; value: string };
}

/**
 * Merge the loopback hosts into `NO_PROXY`, preserving whatever the user already
 * set. The lowercase `no_proxy` twin is deleted rather than also updated: Rust
 * and Go read both, and leaving two spellings behind lets one silently override
 * the other depending on which library looks first.
 */
export function buildCodexSpawnEnv(options: CodexSpawnEnvOptions = {}): NodeJS.ProcessEnv {
  const base = options.base ?? process.env;
  const env: NodeJS.ProcessEnv = { ...base };

  const existing = [env.NO_PROXY, env.no_proxy]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .flatMap((value) => value.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);

  const merged = [...existing];
  for (const host of LOOPBACK_NO_PROXY) {
    if (!merged.some((entry) => entry.toLowerCase() === host)) merged.push(host);
  }
  env.NO_PROXY = merged.join(",");
  delete env.no_proxy;

  if (options.bridgeToken) {
    env[options.bridgeToken.name] = options.bridgeToken.value;
  }
  return env;
}
