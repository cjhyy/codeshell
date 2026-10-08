import type { ToolResult } from "../types.js";

const snapshots = new WeakMap<ToolResult, Readonly<ToolResult>>();

/** Executor-private evidence, kept off wire/model/transcript objects. */
export function rememberBoundToolResult(result: ToolResult, snapshot: Readonly<ToolResult>): void {
  snapshots.set(result, snapshot);
}

/** Trusted adapters inspect executed output, independently of display-only hook decoration. */
export function boundToolResult(result: ToolResult): Readonly<ToolResult> {
  return result.isError ? result : (snapshots.get(result) ?? result);
}
