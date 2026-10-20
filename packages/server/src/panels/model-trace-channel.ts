import { StringDecoder } from "node:string_decoder";
import { createNativeModelTraceFrameDecoder } from "@cjhyy/code-shell-core/internal";
import {
  PanelModelTraceService,
  panelModelTraceLimits,
  type PanelModelTraceOwner,
} from "./model-traces.js";

/** A dedicated reviewed-child descriptor; ordinary stdout/stderr never become prompts. */
export class PanelModelTraceChannel {
  private readonly decoder = new StringDecoder("utf8");
  private readonly frames = createNativeModelTraceFrameDecoder();
  private buffer = "";
  private readonly calls = new Map<string, string>();
  private tail = Promise.resolve();
  private stopped = false;
  private pending = 0;
  constructor(
    private readonly options: {
      service: PanelModelTraceService;
      owner: PanelModelTraceOwner;
      isAuthorized(): Promise<boolean>;
    },
  ) {}
  write(chunk: Buffer | string): void {
    if (this.stopped) return;
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const physical = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!physical.trim()) continue;
      let line: string | undefined;
      try {
        if (Buffer.byteLength(physical) > panelModelTraceLimits.maxParamsBytes)
          throw new Error("Oversized model observation");
        line = this.frames.read(physical);
      } catch {
        this.abort("failed");
        return;
      }
      if (line === undefined || !line.trim()) continue;
      if (++this.pending > 128) {
        this.abort("failed");
        return;
      }
      this.tail = this.tail.then(async () => {
        try {
          if (this.stopped || !(await this.options.isAuthorized())) {
            this.abort();
            return;
          }
          if (this.stopped) return;
          this.consume(line);
        } catch {
          this.abort("failed");
        } finally {
          this.pending--;
        }
      });
    }
    if (Buffer.byteLength(this.buffer) > panelModelTraceLimits.maxParamsBytes) this.abort("failed");
  }
  async finish(status: "cancelled" | "failed"): Promise<void> {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) this.write("\n");
    await this.tail;
    this.abort(status);
  }
  abort(status: "cancelled" | "failed" = "cancelled"): void {
    this.stopped = true;
    this.buffer = "";
    this.calls.clear();
    this.frames.clear();
    this.options.service.cancelOwner(this.options.owner.ownerKey, status);
  }
  private consume(line: string): void {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.version !== 1 ||
      value.type !== "model_trace" ||
      !["start", "finish"].includes(value.phase) ||
      typeof value.callId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.callId)
    )
      throw new Error("Invalid model observation channel message");
    const { version: _version, type: _type, phase, callId, ...params } = value;
    if (Object.hasOwn(params, "id")) throw new Error("Child cannot select a Host observation id");
    if (phase === "start") {
      if (this.calls.has(callId)) throw new Error("Duplicate model observation call");
      const result = this.options.service.call(this.options.owner, "modelTraces.start", params);
      if (!("id" in result)) throw new Error("Model observation was not started");
      this.calls.set(callId, result.id);
    } else {
      const id = this.calls.get(callId);
      if (!id) throw new Error("Unknown model observation call");
      this.options.service.call(this.options.owner, "modelTraces.finish", { ...params, id });
      this.calls.delete(callId);
    }
  }
}
