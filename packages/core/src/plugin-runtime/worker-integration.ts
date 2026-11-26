/**
 * Wires the native plugin runtime into an agent worker.
 *
 * The worker asks for this before it compiles its composition: plugin modules
 * are part of that compile, and they only exist once each plugin's process is
 * past `setup`. Sessions come later, so the per-session answers (which plugins
 * are switched off, where a session works) are bound once they exist.
 *
 * It also adds the one trusted module that lets the host ask how the plugins
 * are doing. That module is the host's own code; plugin modules never
 * contribute protocol surface.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { AgentModule, PluginAgentModule } from "../composition/types.js";
import { logger } from "../logging/logger.js";
import {
  NATIVE_PLUGINS_LOG_QUERY,
  NATIVE_PLUGINS_MODULE_ID,
  NATIVE_PLUGINS_RESTART_QUERY,
  NATIVE_PLUGINS_STATUS_QUERY,
  type NativePluginsLogReply,
  type NativePluginsRestartReply,
  type NativePluginsStatusReply,
} from "./queries.js";
import { NativePluginRuntime, type NativePluginStatus } from "./runtime.js";

export * from "./queries.js";

/** Set to "host" by a host that wants approved native plugins loaded. */
export const NATIVE_PLUGINS_ENV = "CODE_SHELL_NATIVE_PLUGINS";

const LOG_TAIL_BYTES = 32 * 1024;
/** How long one session's answer is reused; a hook can ask many times per turn. */
const SESSION_ANSWER_TTL_MS = 2_000;
const MAX_SESSION_ANSWERS = 256;

export function nativePluginsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NATIVE_PLUGINS_ENV] === "host";
}

/** What the runtime needs to know about a session. Always asked for the top-level one. */
export interface NativePluginSessions {
  disabledPlugins(sessionId: string | undefined): readonly string[];
  cwd(sessionId: string | undefined): string | undefined;
  /** Settings changed: answer from scratch next time. */
  forget?(): void;
}

export interface NativePluginSessionSource {
  /** The live top-level session, if there is one. */
  session(
    sessionId: string,
  ): { cwd: string | undefined; disabledPlugins(): readonly string[] } | undefined;
  /** The user-level list, for calls that belong to no live session. */
  userDisabledPlugins(): readonly string[];
  now?(): number;
}

/**
 * Per-session answers with a short memory. Working out which plugins a session
 * has switched off reads settings; a tool gate would otherwise do that on
 * every tool call.
 */
export function createNativePluginSessions(
  source: NativePluginSessionSource,
): NativePluginSessions {
  const answers = new Map<string, { at: number; disabled: readonly string[] }>();
  const now = source.now ?? Date.now;
  return {
    disabledPlugins(sessionId) {
      const key = sessionId ?? "";
      const at = now();
      const known = answers.get(key);
      if (known && at - known.at < SESSION_ANSWER_TTL_MS) return known.disabled;
      let disabled: readonly string[];
      try {
        disabled =
          (sessionId ? source.session(sessionId)?.disabledPlugins() : undefined) ??
          source.userDisabledPlugins();
      } catch {
        // Settings that cannot be read right now: keep the last answer.
        disabled = known?.disabled ?? [];
      }
      if (answers.size >= MAX_SESSION_ANSWERS) answers.clear();
      answers.set(key, { at, disabled });
      return disabled;
    },
    cwd(sessionId) {
      return sessionId ? source.session(sessionId)?.cwd : undefined;
    },
    forget() {
      answers.clear();
    },
  };
}

function tail(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // The first line of a cut is half a line.
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

export interface WorkerNativePlugins {
  /** The host's modules plus the one that answers the status queries. */
  readonly modules: AgentModule[];
  /** One module per loaded plugin, for `compileComposition`. */
  readonly pluginModules: PluginAgentModule[];
  bindSessions(sessions: NativePluginSessions): void;
  /** The install registry or the settings may have changed. Never throws. */
  refresh(): void;
  status(): NativePluginStatus[];
  close(): Promise<void>;
}

export interface WorkerNativePluginsOptions {
  hostKind: string;
  /** The host's own modules; the plugin modules have to compile next to them. */
  modules: readonly AgentModule[];
  /** Test seams, passed through to the runtime. */
  setupTimeoutMs?: number;
  pingTimeoutMs?: number;
}

/**
 * Load every approved native plugin. Resolves once each of them has finished
 * `setup` or been given up on; no plugin can make this reject.
 */
export async function startWorkerNativePlugins(
  options: WorkerNativePluginsOptions,
): Promise<WorkerNativePlugins> {
  let sessions: NativePluginSessions | undefined;

  const installKeyOf = (params: Readonly<Record<string, unknown>>): string => {
    const installKey = params.installKey;
    if (typeof installKey !== "string" || !installKey || installKey.length > 512) {
      throw new Error("installKey is required");
    }
    return installKey;
  };
  const bridge: AgentModule = {
    id: NATIVE_PLUGINS_MODULE_ID,
    protocol: {
      queries: {
        [NATIVE_PLUGINS_STATUS_QUERY]: (): NativePluginsStatusReply => ({
          plugins: runtime.status(),
        }),
        [NATIVE_PLUGINS_RESTART_QUERY]: async (params): Promise<NativePluginsRestartReply> => {
          const restarted = await runtime.restart(installKeyOf(params));
          return { restarted, plugins: runtime.status() };
        },
        [NATIVE_PLUGINS_LOG_QUERY]: (params): NativePluginsLogReply => {
          const installKey = installKeyOf(params);
          // Only a log this runtime knows about: the caller never names a path.
          const known = runtime.status().find((plugin) => plugin.installKey === installKey);
          return { text: known ? tail(known.logFile) : "" };
        },
      },
    },
  };
  const modules = [...options.modules, bridge];

  // The queries above only run once the worker serves requests.
  const runtime = new NativePluginRuntime({
    hostKind: options.hostKind,
    baseModules: modules,
    disabledPlugins: (sessionId) => sessions?.disabledPlugins(sessionId) ?? [],
    sessionCwd: (sessionId) => sessions?.cwd(sessionId),
    log: (event, fields) => logger.info(event, fields),
    ...(options.setupTimeoutMs !== undefined ? { setupTimeoutMs: options.setupTimeoutMs } : {}),
    ...(options.pingTimeoutMs !== undefined ? { pingTimeoutMs: options.pingTimeoutMs } : {}),
  });
  try {
    await runtime.start();
  } catch (error) {
    // The worker has to come up without plugins rather than not at all.
    logger.warn("native_plugin.start_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    modules,
    pluginModules: runtime.pluginModules(),
    bindSessions(next) {
      sessions = next;
    },
    refresh() {
      sessions?.forget?.();
      runtime.refresh().catch((error: unknown) => {
        logger.warn("native_plugin.refresh_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    status: () => runtime.status(),
    close: () => runtime.close(),
  };
}
