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

export class RemoteBridge {
  private ssh: ChildProcess | undefined;
  private connected = false;

  constructor(private readonly config: BridgeConfig) {}

  /**
   * Connect to the remote host via SSH and start code-shell in NDJSON mode.
   */
  async connect(): Promise<void> {
    const sshArgs = this.buildSSHArgs();
    const remoteCmd = this.config.remoteCommand ?? "code-shell run --output stream-json";

    this.ssh = spawn("ssh", [...sshArgs, remoteCmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("SSH connection timed out"));
        this.disconnect();
      }, 30000);

      this.ssh!.stdout?.once("data", () => {
        clearTimeout(timer);
        this.connected = true;
        resolve();
      });

      this.ssh!.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      this.ssh!.on("exit", (code) => {
        this.connected = false;
        if (!this.connected) {
          clearTimeout(timer);
          reject(new Error(`SSH exited with code ${code}`));
        }
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

  private buildSSHArgs(): string[] {
    const args: string[] = ["-T"]; // No pseudo-terminal
    if (this.config.port) args.push("-p", String(this.config.port));
    if (this.config.identityFile) args.push("-i", this.config.identityFile);
    if (this.config.user) {
      args.push(`${this.config.user}@${this.config.host}`);
    } else {
      args.push(this.config.host);
    }
    return args;
  }
}
