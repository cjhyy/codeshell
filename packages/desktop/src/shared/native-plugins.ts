import type { NativePluginStatus } from "@cjhyy/code-shell-core";

/** What Desktop can tell about native plugins at run time. */
export type NativePluginRuntimeView =
  /** The user has not switched native plugins on (`native_plugins`). */
  | { kind: "off" }
  /** No agent worker is running; approved plugins start with the first session. */
  | { kind: "no-worker" }
  /** The running worker started before native plugins were switched on. */
  | { kind: "not-loaded" }
  | { kind: "loaded"; plugins: NativePluginStatus[] };

export type NativePluginRuntimeAction = "status" | "restart";
