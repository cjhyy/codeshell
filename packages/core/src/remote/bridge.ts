/**
 * Remote bridge — NDJSON over SSH for remote code-shell sessions.
 *
 * Architecture:
 *   Local terminal ←→ SSH ←→ Remote code-shell (NDJSON stdio mode)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface BridgeConfig {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  remoteCommand?: string;
}

/** A spawn function (injectable for tests). Defaults to child_process.spawn. */
export type SpawnFn = (command: string, args: string[]) => ChildProcess;

/**
 * Build the ssh argv. Each value is a discrete element — spawn runs ssh
 * without a shell, so identityFile/port/host are never shell-interpreted
 * (there is no local command-injection surface here).
 */
export function buildSSHArgs(config: BridgeConfig): string[] {
  const args: string[] = ["-T"]; // No pseudo-terminal
  if (config.port) args.push("-p", String(config.port));
  if (config.identityFile) args.push("-i", config.identityFile);
  args.push(config.user ? `${config.user}@${config.host}` : config.host);
  return args;
}

export class RemoteBridge {
  private ssh: ChildProcess | undefined;
  private connected = false;
  private readonly spawnFn: SpawnFn;

  constructor(
    private readonly config: BridgeConfig,
    spawnFn?: SpawnFn,
  ) {
    this.spawnFn = spawnFn ?? ((cmd, args) => spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }));
  }

  /**
   * Connect to the remote host via SSH and start code-shell in NDJSON mode.
   */
  async connect(): Promise<void> {
    const sshArgs = buildSSHArgs(this.config);
    const remoteCmd = this.config.remoteCommand ?? "code-shell run --output stream-json";

    this.ssh = this.spawnFn("ssh", [...sshArgs, remoteCmd]);

    return new Promise((resolve, reject) => {
      // Settle exactly once: the first stdout resolves; an error/early-exit
      // before that rejects. Events after settlement are ignored (the old
      // code re-rejected an already-settled promise and used a dead
      // `if (!this.connected)` guard that was always true).
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("SSH connection timed out"));
        this.disconnect();
      }, 30000);

      this.ssh!.stdout?.once("data", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        resolve();
      });

      this.ssh!.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      this.ssh!.on("exit", (code) => {
        this.connected = false;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`SSH exited with code ${code}`));
      });
    });
  }

  /**
   * Send a message to the remote code-shell.
   */
  send(message: Record<string, unknown>): void {
    if (!this.connected || !this.ssh?.stdin) {
      throw new Error("Not connected");
    }
    this.ssh.stdin.write(JSON.stringify(message) + "\n");
  }

  /**
   * Async iterator for messages from the remote code-shell.
   */
  async *messages(): AsyncGenerator<Record<string, unknown>> {
    if (!this.ssh?.stdout) return;

    const rl = createInterface({ input: this.ssh.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Skip malformed
      }
    }
  }

  /**
   * Disconnect from the remote host.
   */
  disconnect(): void {
    this.connected = false;
    if (this.ssh) {
      this.ssh.kill();
      this.ssh = undefined;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
