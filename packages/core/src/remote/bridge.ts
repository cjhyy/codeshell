/**
 * Remote bridge — NDJSON over SSH for remote code-shell sessions.
 *
 * Architecture:
 *   Local terminal ←→ SSH ←→ Remote code-shell (NDJSON stdio mode)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

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
  private readonly transportErrors = new WeakMap<ChildProcess, Error>();
  private readonly readers = new Set<Interface>();
  private readonly spawnFn: SpawnFn;

  constructor(
    private readonly config: BridgeConfig,
    spawnFn?: SpawnFn,
  ) {
    this.spawnFn =
      spawnFn ?? ((cmd, args) => spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }));
  }

  /**
   * Connect to the remote host via SSH and start code-shell in NDJSON mode.
   */
  async connect(): Promise<void> {
    const sshArgs = buildSSHArgs(this.config);
    const remoteCmd = this.config.remoteCommand ?? "code-shell run --output stream-json";

    const ssh = this.spawnFn("ssh", [...sshArgs, remoteCmd]);
    this.ssh = ssh;

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

      ssh.stdout?.once("data", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        resolve();
      });

      const onError = (err: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        this.failTransport(ssh, err);
      };
      ssh.on("error", onError);
      // A write callback does not consume the writable's error event.
      ssh.stdin?.on("error", onError);

      ssh.on("exit", (code) => {
        if (this.ssh !== ssh) return;
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
      throw (this.ssh && this.transportErrors.get(this.ssh)) ?? new Error("Not connected");
    }
    const ssh = this.ssh;
    const payload = JSON.stringify(message) + "\n";
    try {
      ssh.stdin!.write(payload, (err) => {
        if (err) this.failTransport(ssh, err);
      });
    } catch (error) {
      this.failTransport(ssh, error as Error);
      throw error;
    }
  }

  private failTransport(ssh: ChildProcess, error: Error): void {
    if (this.ssh !== ssh || this.transportErrors.has(ssh)) return;
    this.transportErrors.set(ssh, error);
    this.connected = false;
    ssh.kill();
    // Wake a pending messages() reader; it reports the transport error below.
    for (const reader of this.readers) reader.close();
    ssh.stdout?.destroy();
  }

  /**
   * Async iterator for messages from the remote code-shell.
   */
  async *messages(): AsyncGenerator<Record<string, unknown>> {
    const ssh = this.ssh;
    if (!ssh?.stdout) return;
    if (this.transportErrors.has(ssh)) throw this.transportErrors.get(ssh);

    const rl = createInterface({ input: ssh.stdout, crlfDelay: Infinity });
    this.readers.add(rl);
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
          // Skip malformed
        }
      }
      if (this.transportErrors.has(ssh)) throw this.transportErrors.get(ssh);
    } finally {
      // Close the interface if the consumer breaks/returns early — otherwise
      // it (and its stdout listener) leaks.
      rl.close();
      this.readers.delete(rl);
    }
  }

  /**
   * Disconnect from the remote host.
   */
  disconnect(): void {
    this.connected = false;
    for (const reader of this.readers) reader.close();
    if (this.ssh) {
      this.ssh.kill();
      this.ssh = undefined;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
