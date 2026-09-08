// packages/server/src/serve/cli.ts
//
// `code-shell-serve` boots a single-workspace Hub under Node.js.
// New deployments use one administrator and revocable device sessions.
// --auth passcode preserves the original passcode-only host.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { startHeadlessServer } from "./headless-server.js";
import { startProjectControlServer } from "../project-runtime/control-server.js";

interface CliArgs {
  cwd: string;
  host: string;
  port: number;
  passcode?: string;
  authMode: "hub" | "passcode";
  runtime: "local" | "docker";
  runtimeImage?: string;
  debugLogs?: boolean;
  publicOrigin?: string;
  dataDir: string;
  staticRootDir?: string;
}

const SERVE_HELP = `Usage: code-shell-serve [options]

Run the CodeShell headless Web host for a workspace.

Options:
  --cwd <path>         Workspace root (default: current directory)
  --host <host>        Bind host (default: 127.0.0.1)
  --port <port>        Bind port, 0 selects a free port (default: 8790)
  --auth <mode>        hub (default) or legacy passcode
  --runtime <mode>     local (default) or Docker project sandboxes
  --runtime-image <tag> Prebuilt project image (default: codeshell-project-runtime:local)
  --public-url <url>   External HTTPS origin for reverse-proxy deployments
  --passcode <code>    Set or rotate the legacy passcode (selects passcode mode)
  --data-dir <path>    Persistent server data (auth, uploads and worker sessions)
  --static-root <path> Override the built Web app directory
  --debug-logs        Include raw worker diagnostics (may contain task content)
  -h, --help           Show this help and exit`;

const VALUE_FLAGS = new Set([
  "--cwd",
  "--host",
  "--port",
  "--passcode",
  "--auth",
  "--runtime",
  "--runtime-image",
  "--public-url",
  "--data-dir",
  "--static-root",
]);

export function parseServeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--debug-logs") {
      args["debug-logs"] = "true";
      continue;
    }
    if (!key || !VALUE_FLAGS.has(key)) {
      throw new Error(`unknown argument: ${key ?? ""}\n\n${SERVE_HELP}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${key}\n\n${SERVE_HELP}`);
    }
    args[key.slice(2)] = value;
    i++;
  }
  const home = env.CODE_SHELL_HOME || join(homedir(), ".code-shell");
  const port = Number(args.port ?? "8790");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${args.port}`);
  }
  const authMode = args.auth ?? (args.passcode ? "passcode" : "hub");
  if (authMode !== "hub" && authMode !== "passcode")
    throw new Error("--auth must be hub or passcode");
  if (authMode === "hub" && args.passcode)
    throw new Error("--passcode cannot be combined with --auth hub");
  const runtime = args.runtime ?? "local";
  if (runtime !== "local" && runtime !== "docker")
    throw new Error("--runtime must be local or docker");
  if (runtime === "docker" && authMode !== "hub")
    throw new Error("Docker projects require --auth hub");
  if (args["runtime-image"] && runtime !== "docker")
    throw new Error("--runtime-image requires --runtime docker");
  let publicOrigin: string | undefined;
  const publicUrl = args["public-url"] ?? env.CODE_SHELL_SERVE_PUBLIC_URL;
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    ) {
      throw new Error("--public-url must be an HTTPS origin (HTTP allowed only on loopback)");
    }
    publicOrigin = url.origin;
  }
  return {
    authMode,
    runtime,
    ...(args["runtime-image"] ? { runtimeImage: args["runtime-image"] } : {}),
    ...(args["debug-logs"] ? { debugLogs: true } : {}),
    ...(publicOrigin ? { publicOrigin } : {}),
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
  return require.resolve("@cjhyy/code-shell-core/bin/agent-server-stdio");
}

/**
 * AgentModule spec string for the worker env — headless serve ships the
 * coding module (matches the pre-cutover behavior where the coding bin
 * wrapper registered it; arena/pet stay desktop-only).
 */
export function resolveWorkerCapabilityModules(): string {
  return `${import.meta.resolve("@cjhyy/code-shell-capability-coding")}#createCodingModule`;
}

/** Locate the built browser app (packages/web `app` build), when present. */
export function resolveWebAppRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // package.json is exposed via the web package's exports map exactly so a
    // CJS-style resolve (createRequire) can locate the package root; dist-app
    // is the app build output sibling.
    const pkgJson = require.resolve("@cjhyy/code-shell-web/package.json");
    const candidate = join(pkgJson, "..", "dist-app");
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export async function runServeCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(SERVE_HELP);
    return;
  }
  const parsed = parseServeArgs(argv);
  const staticRootDir = parsed.staticRootDir ?? resolveWebAppRoot();
  const server =
    parsed.runtime === "docker"
      ? await startProjectControlServer({
          host: parsed.host,
          port: parsed.port,
          dataDir: parsed.dataDir,
          publicOrigin: parsed.publicOrigin,
          staticRootDir,
          runtimeImage: parsed.runtimeImage,
        })
      : await startHeadlessServer({
          host: parsed.host,
          port: parsed.port,
          cwd: parsed.cwd,
          dataDir: parsed.dataDir,
          authMode: parsed.authMode,
          debugLogs: parsed.debugLogs,
          ...(parsed.publicOrigin ? { publicOrigin: parsed.publicOrigin } : {}),
          workerEntryPath: resolveWorkerEntry(),
          workerCapabilityModules: resolveWorkerCapabilityModules(),
          ...(staticRootDir ? { staticRootDir } : {}),
          ...(parsed.passcode ? { passcode: parsed.passcode } : {}),
          log: (event, data) =>
            console.error(`[serve] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`),
        });

  console.log(
    `CodeShell ${parsed.authMode === "hub" ? "Hub" : "web host"} listening at ${parsed.publicOrigin ?? server.url}`,
  );
  console.log(
    parsed.runtime === "docker"
      ? "Project sandboxes: Docker (project files persist in separate volumes)"
      : `Workspace: ${parsed.cwd}`,
  );
  if (!staticRootDir) {
    console.log("No web app build found — WS endpoint only (/ws). Build packages/web first.");
  }
  if (server.bootstrapToken) {
    const origin =
      parsed.publicOrigin ?? server.url.replace(/\/\/(0\.0\.0\.0|\[?::\]?)(?=:)/, "//127.0.0.1");
    console.log(
      `Administrator setup (one-time link, save it now): ${origin}/#setup=${server.bootstrapToken}`,
    );
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
