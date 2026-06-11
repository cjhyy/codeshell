/**
 * LSP Server Manager — manages lifecycle of language server instances.
 * Lazy initialization: servers start only when needed.
 */

import { LSPClient } from "./client.js";
import { BUILTIN_LSP_SERVERS, type LSPServerConfig } from "./servers.js";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { rootUriToPath } from "./root-path.js";
import { commandCandidateNames } from "../utils/exec.js";

type ServerState = "stopped" | "starting" | "ready" | "error";

interface ManagedServer {
  config: LSPServerConfig;
  client: LSPClient | undefined;
  state: ServerState;
  error?: string;
}

export class LSPServerManager {
  private servers = new Map<string, ManagedServer>();
  private rootUri: string;

  constructor(cwd: string) {
    this.rootUri = pathToFileURL(cwd).href;

    // Register all built-in servers
    for (const config of BUILTIN_LSP_SERVERS) {
      this.servers.set(config.name, { config, client: undefined, state: "stopped" });
    }
  }

  /**
   * Get or start a language server by name.
   */
  async getClient(serverName: string): Promise<LSPClient | undefined> {
    const managed = this.servers.get(serverName);
    if (!managed) return undefined;

    if (managed.state === "ready" && managed.client?.isAlive) {
      return managed.client;
    }

    if (managed.state === "starting") {
      // Wait for it to be ready
      await new Promise((r) => setTimeout(r, 2000));
      return managed.client;
    }

    // Try to start
    return this.startServer(serverName);
  }

  /**
   * Start a specific language server.
   */
  private async startServer(name: string): Promise<LSPClient | undefined> {
    const managed = this.servers.get(name);
    if (!managed) return undefined;

    // Check if command is available
    if (!isCommandAvailable(managed.config.command)) {
      managed.state = "error";
      managed.error = `${managed.config.command} not found. Install: ${managed.config.installHint}`;
      return undefined;
    }

    managed.state = "starting";

    try {
      const client = new LSPClient(managed.config.command, managed.config.args, rootUriToPath(this.rootUri));
      await client.start();
      await client.initialize(this.rootUri);

      managed.client = client;
      managed.state = "ready";
      return client;
    } catch (err) {
      managed.state = "error";
      managed.error = (err as Error).message;
      return undefined;
    }
  }

  /**
   * Check if any LSP server is connected.
   */
  isConnected(): boolean {
    for (const server of this.servers.values()) {
      if (server.state === "ready" && server.client?.isAlive) return true;
    }
    return false;
  }

  /**
   * List server statuses.
   */
  listServers(): Array<{ name: string; language: string; state: ServerState; error?: string }> {
    return [...this.servers.values()].map((s) => ({
      name: s.config.name,
      language: s.config.language,
      state: s.state,
      error: s.error,
    }));
  }

  /**
   * Shutdown all servers.
   */
  async shutdownAll(): Promise<void> {
    for (const server of this.servers.values()) {
      if (server.client?.isAlive) {
        try {
          await server.client.shutdown();
        } catch {
          // Force killed
        }
      }
      server.state = "stopped";
      server.client = undefined;
    }
  }
}

export function isCommandAvailable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const hasPathSeparator = trimmed.includes("/") || trimmed.includes("\\");
  // A bare command with whitespace is not executable via spawn(command, args)
  // anyway. Reject it up front so a configured command can never be interpreted
  // as shell syntax such as `pylsp; touch /tmp/pwned`.
  if (!hasPathSeparator && /\s/.test(trimmed)) return false;

  if (hasPathSeparator) {
    return candidateCommandNames(trimmed, env).some(isExecutableFile);
  }

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of candidateCommandNames(trimmed, env)) {
      if (isExecutableFile(join(dir, name))) return true;
    }
  }
  return false;
}

function candidateCommandNames(command: string, env: NodeJS.ProcessEnv): string[] {
  return commandCandidateNames(command, env);
}

function isExecutableFile(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") {
      accessSync(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

// Singleton
let _manager: LSPServerManager | undefined;

export function initializeLSPManager(cwd: string): LSPServerManager {
  _manager = new LSPServerManager(cwd);
  return _manager;
}

export function getLSPManager(): LSPServerManager | undefined {
  return _manager;
}
