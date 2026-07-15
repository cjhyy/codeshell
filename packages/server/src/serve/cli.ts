// packages/server/src/serve/cli.ts
//
// `code-shell-serve` — boot the headless no-account web host from a terminal:
//
//   code-shell-serve --cwd ~/work/repo [--port 8790] [--host 127.0.0.1]
//                    [--passcode <code>] [--data-dir <dir>]
//
// Access control is passcode + remember-cookie only (决策见 TODO 约束边界
// 「服务端部署不做账号体系」). Default bind is loopback; binding 0.0.0.0 is a
// deliberate operator choice.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { startHeadlessServer } from "./headless-server.js";

interface CliArgs {
  cwd: string;
  host: string;
  port: number;
  passcode?: string;
  dataDir: string;
  staticRootDir?: string;
}

export function parseServeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key.slice(2)] = "true";
    } else {
      args[key.slice(2)] = value;
      i++;
    }
  }
  const home = env.CODE_SHELL_HOME || join(homedir(), ".code-shell");
  const port = Number(args.port ?? "8790");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${args.port}`);
  }
  return {
    cwd: resolve(args.cwd ?? process.cwd()),
    host: args.host ?? "127.0.0.1",
    port,
    ...(args.passcode ? { passcode: args.passcode } : {}),
    dataDir: args["data-dir"] ? resolve(args["data-dir"]) : join(home, "serve"),
    ...(args["static-root"] ? { staticRootDir: resolve(args["static-root"]) } : {}),
  };
}

/** Locate the stdio worker entry the same way desktop's AgentBridge does. */
export function resolveWorkerEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("@cjhyy/code-shell-capability-coding/bin/agent-server-stdio");
}

/** Locate the built browser app (packages/web `app` build), when present. */
export function resolveWebAppRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // package.json is always resolvable; dist-app is its build output sibling.
    const pkgJson = require.resolve("@cjhyy/code-shell-web/package.json");
    const candidate = join(pkgJson, "..", "dist-app");
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export async function runServeCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseServeArgs(argv);
  const staticRootDir = parsed.staticRootDir ?? resolveWebAppRoot();
  const server = await startHeadlessServer({
    host: parsed.host,
    port: parsed.port,
    cwd: parsed.cwd,
    dataDir: parsed.dataDir,
    workerEntryPath: resolveWorkerEntry(),
    ...(staticRootDir ? { staticRootDir } : {}),
    ...(parsed.passcode ? { passcode: parsed.passcode } : {}),
    log: (event, data) =>
      console.error(`[serve] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`),
  });

  console.log(`CodeShell web host listening at ${server.url}`);
  console.log(`Workspace: ${parsed.cwd}`);
  if (!staticRootDir) {
    console.log("No web app build found — WS endpoint only (/ws). Build packages/web first.");
  }
  if (server.generatedPasscode) {
    console.log(`Access passcode (generated, save it now): ${server.generatedPasscode}`);
  }

  const shutdown = (): void => {
    console.log("shutting down…");
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
