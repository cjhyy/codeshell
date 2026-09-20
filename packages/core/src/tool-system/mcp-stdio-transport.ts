import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import {
  getDefaultEnvironment,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { groupAlive, killProcessGroup } from "../runtime/spawn-common.js";

/** SDK framing with host-owned process lifetime. Wrappers such as npm must not
 * leave descendants behind when initialization times out and is retried. */
export class ManagedMcpStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcess;
  private buffer = new ReadBuffer();
  private closing?: Promise<void>;
  private closed = false;
  private firstResponse = false;
  private exited?: Promise<void>;

  constructor(
    private readonly params: StdioServerParameters,
    private readonly onStage?: (stage: "spawned" | "first_response") => void,
  ) {}

  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error("MCP transport cannot be started twice");
    const child: ChildProcess = spawn(this.params.command, this.params.args ?? [], {
      env: { ...getDefaultEnvironment(), ...this.params.env },
      cwd: this.params.cwd,
      stdio: ["pipe", "pipe", this.params.stderr ?? "inherit"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.exited = new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
        // Retain the group id even if the wrapper exits before its descendants.
        void this.close().catch((error) => this.onerror?.(error));
      });
    });
    child.stdin?.on("error", (error) => this.onerror?.(error));
    child.stdout?.on("error", (error) => this.onerror?.(error));
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      while (!this.closed) {
        try {
          const message = this.buffer.readMessage();
          if (message === null) break;
          if (!this.firstResponse) {
            this.firstResponse = true;
            this.onStage?.("first_response");
          }
          this.onmessage?.(message);
        } catch (error) {
          this.onerror?.(error as Error);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        this.onStage?.("spawned");
        resolve();
      });
      child.on("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (this.closed || !stdin || stdin.destroyed) throw new Error("MCP transport is closed");
    await new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    return (this.closing ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    const child = this.child;
    try {
      // On Windows taskkill needs the wrapper still alive to walk its children.
      if (process.platform === "win32" && child?.pid) {
        await killProcessGroup(child.pid);
        if (groupAlive(child.pid)) throw new Error("MCP process cleanup did not complete");
        return;
      }
      child?.stdin?.end();
      if (child?.pid) {
        // Let a well-behaved server handle EOF, then terminate its entire group.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          this.exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 100);
          }),
        ]);
        if (timer) clearTimeout(timer);
        await killProcessGroup(child.pid, { graceMs: 300 });
        if (groupAlive(child.pid)) throw new Error("MCP process cleanup did not complete");
      }
    } finally {
      this.buffer.clear();
      this.onclose?.();
    }
  }
}
