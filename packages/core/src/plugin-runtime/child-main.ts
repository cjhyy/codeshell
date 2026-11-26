/**
 * Entry of a native plugin process. This file, not the plugin's own entry, is
 * what the agent worker starts: it waits for `init`, imports the plugin from
 * its verified snapshot, hands `setup` a `ctx`, reports what was registered
 * and then serves calls until the channel closes.
 *
 * It deliberately imports nothing from core beyond the protocol definitions:
 * a plugin process holds no engine, no settings and no credentials.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginContext } from "../plugin-sdk.js";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  fitsPluginMessage,
  MAX_HOOK_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_MS,
  PLUGIN_PROTOCOL_VERSION,
  type NativeDeclarations,
  type PluginInvocationKind,
  type PluginProcessInit,
  type PluginToWorkerMessage,
  type WorkerToPluginMessage,
} from "./protocol.js";

type Handler = (payload: unknown, options: { signal: AbortSignal }) => unknown;
type Effect = (signal: AbortSignal) => unknown;

class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const handlers: Record<PluginInvocationKind, Map<string, Handler>> = {
  hook: new Map(),
  tool: new Map(),
  context: new Map(),
};
const declarations: NativeDeclarations = {
  hooks: [],
  tools: [],
  presets: [],
  presetExtensions: [],
  promptSections: [],
  context: [],
  background: false,
};
const effects: Effect[] = [];
const running = new Map<number, AbortController>();
let registering = false;
let background: { controller: AbortController; cleanups: unknown[] } | undefined;

function send(message: PluginToWorkerMessage): void {
  // The worker going away closes the channel; there is nobody left to tell.
  if (process.connected) process.send?.(message);
}

function log(level: "debug" | "info" | "warn" | "error", parts: unknown[]): void {
  const message = parts
    .map((part) => (typeof part === "string" ? part : (JSON.stringify(part) ?? String(part))))
    .join(" ")
    .slice(0, 8_192);
  send({ t: "log", level, message });
}

function requireRegistering(what: string): void {
  if (!registering) {
    throw new PluginError("NOT_REGISTERING", `${what} can only be called during setup`);
  }
}

function requireName(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginError("INVALID_REGISTRATION", `${what} needs a name`);
  }
  return value;
}

function requireFunction(value: unknown, what: string): Handler {
  if (typeof value !== "function") {
    throw new PluginError("INVALID_REGISTRATION", `${what} needs a function`);
  }
  return value as Handler;
}

function boundedTimeout(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), max)
    : fallback;
}

/** What a plugin passed, as a record to read fields from; it may be anything. */
function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function denied(capability: string): Promise<never> {
  return Promise.reject(
    new PluginError("PERMISSION_DENIED", `${capability} is not available to this plugin`),
  );
}

function buildContext(init: PluginProcessInit): PluginContext {
  return Object.freeze({
    plugin: Object.freeze({
      name: init.plugin.name,
      installKey: init.plugin.installKey,
      root: init.plugin.root,
      dataDir: init.plugin.dataDir,
      apiVersion: init.apiVersion,
    }),
    log: Object.freeze({
      debug: (...parts: unknown[]) => log("debug", parts),
      info: (...parts: unknown[]) => log("info", parts),
      warn: (...parts: unknown[]) => log("warn", parts),
      error: (...parts: unknown[]) => log("error", parts),
    }),
    hooks: Object.freeze({
      on(event: unknown, handler: unknown, rawOptions?: unknown) {
        requireRegistering("ctx.hooks.on");
        const options = fields(rawOptions);
        const name = requireName(event, "a hook");
        if (handlers.hook.has(name)) {
          throw new PluginError("INVALID_REGISTRATION", `hook "${name}" is already registered`);
        }
        handlers.hook.set(name, requireFunction(handler, `hook "${name}"`));
        declarations.hooks.push({
          event: name,
          timeoutMs: boundedTimeout(
            options.timeoutMs,
            DEFAULT_HOOK_TIMEOUT_MS,
            MAX_HOOK_TIMEOUT_MS,
          ),
          onError: options.onError === "deny" ? "deny" : "ignore",
        });
      },
    }),
    tools: Object.freeze({
      register(rawTool: unknown) {
        requireRegistering("ctx.tools.register");
        const tool = fields(rawTool);
        const name = requireName(tool.name, "a tool");
        if (handlers.tool.has(name)) {
          throw new PluginError("INVALID_REGISTRATION", `tool "${name}" is already registered`);
        }
        handlers.tool.set(name, requireFunction(tool.execute, `tool "${name}"`));
        declarations.tools.push({
          name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? (tool.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
          readOnly: tool.readOnly === true,
          concurrencySafe: tool.concurrencySafe === true,
          timeoutMs: boundedTimeout(tool.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS),
          exposure: tool.exposure === "always" ? "always" : "preset",
        });
      },
    }),
    presets: Object.freeze({
      add(rawPreset: unknown) {
        requireRegistering("ctx.presets.add");
        const preset = fields(rawPreset);
        const name = requireName(preset.name, "a preset");
        declarations.presets.push({
          name,
          label: typeof preset.label === "string" ? preset.label : name,
          description: typeof preset.description === "string" ? preset.description : "",
          promptSections: strings(preset.promptSections),
          builtinTools: strings(preset.builtinTools),
          defaultPermissionRules: (Array.isArray(preset.defaultPermissionRules)
            ? preset.defaultPermissionRules
            : []
          ).flatMap((rule: Record<string, unknown>) =>
            typeof rule?.tool === "string" &&
            (rule.decision === "allow" || rule.decision === "deny" || rule.decision === "ask")
              ? [
                  {
                    tool: rule.tool,
                    decision: rule.decision,
                    ...(typeof rule.reason === "string" ? { reason: rule.reason } : {}),
                  },
                ]
              : [],
          ),
        });
      },
      extend(target: unknown, tools: unknown) {
        requireRegistering("ctx.presets.extend");
        const names = strings(typeof target === "string" ? [target] : target);
        const except =
          target && typeof target === "object" && !Array.isArray(target)
            ? strings((target as { allExcept?: unknown }).allExcept)
            : undefined;
        declarations.presetExtensions.push({
          target: except && names.length === 0 ? { allExcept: except } : { presets: names },
          tools: strings(tools),
        });
      },
    }),
    prompt: Object.freeze({
      section(name: unknown, text: unknown) {
        requireRegistering("ctx.prompt.section");
        declarations.promptSections.push({
          name: requireName(name, "a prompt section"),
          text: typeof text === "string" ? text : "",
        });
      },
    }),
    context: Object.freeze({
      provide(name: unknown, provider: unknown) {
        requireRegistering("ctx.context.provide");
        const key = requireName(name, "a context provider");
        if (handlers.context.has(key)) {
          throw new PluginError("INVALID_REGISTRATION", `context "${key}" is already registered`);
        }
        handlers.context.set(key, requireFunction(provider, `context "${key}"`));
        declarations.context.push({ name: key });
      },
    }),
    effect(effect: unknown) {
      requireRegistering("ctx.effect");
      effects.push(requireFunction(effect, "ctx.effect") as unknown as Effect);
      declarations.background = true;
    },
    // Core and host capabilities are declared in the manifest today so that
    // they can be reviewed; the calls themselves arrive with a later API version.
    core: Object.freeze({
      has: (_name: string) => false,
      llm: Object.freeze({ complete: () => denied("core.llm") }),
      tools: Object.freeze({ call: () => denied("core.tools.call") }),
      session: Object.freeze({ inject: () => denied("core.session.inject") }),
      sessions: Object.freeze({
        list: () => denied("core.sessions.read"),
        read: () => denied("core.sessions.read"),
      }),
    }),
    host: Object.freeze({
      kind: init.host.kind,
      has: (_name: string) => false,
      use: (name: string) => denied(`host.${name}`),
    }),
  });
}

async function startUp(init: PluginProcessInit): Promise<void> {
  if (init.protocol !== PLUGIN_PROTOCOL_VERSION) {
    throw new PluginError("PROTOCOL_MISMATCH", `unsupported plugin protocol ${init.protocol}`);
  }
  const loaded = (await import(pathToFileURL(join(init.plugin.root, init.plugin.main)).href)) as {
    default?: unknown;
  };
  const entry = loaded.default;
  const setup =
    typeof entry === "function" ? entry : (entry as { setup?: unknown } | undefined)?.setup;
  if (typeof setup !== "function") {
    throw new PluginError(
      "INVALID_ENTRY",
      "the plugin's default export must be a setup function or an object with setup(ctx)",
    );
  }
  registering = true;
  try {
    await (setup as (ctx: unknown) => unknown).call(entry, buildContext(init));
  } finally {
    registering = false;
  }
}

async function invoke(message: Extract<WorkerToPluginMessage, { t: "invoke" }>): Promise<void> {
  const controller = new AbortController();
  running.set(message.id, controller);
  try {
    const handler = handlers[message.kind]?.get(message.name);
    if (!handler) {
      throw new PluginError("NOT_REGISTERED", `no ${message.kind} named "${message.name}"`);
    }
    const value = (await handler(message.payload, { signal: controller.signal })) ?? null;
    if (!fitsPluginMessage(value)) {
      throw new PluginError("RESULT_TOO_LARGE", "the result does not fit in one message");
    }
    send({ t: "result", id: message.id, ok: true, value });
  } catch (error) {
    send({
      t: "result",
      id: message.id,
      ok: false,
      error: {
        code: error instanceof PluginError ? error.code : "HANDLER_ERROR",
        message: String((error as Error)?.message ?? error).slice(0, 2_000),
      },
    });
  } finally {
    running.delete(message.id);
  }
}

async function setBackground(run: boolean): Promise<void> {
  if (run === (background !== undefined)) return;
  if (!run) {
    const stopping = background!;
    background = undefined;
    stopping.controller.abort();
    for (const cleanup of stopping.cleanups) {
      try {
        if (typeof cleanup === "function") await cleanup();
      } catch (error) {
        log("warn", ["effect cleanup failed:", String(error)]);
      }
    }
    return;
  }
  const started = { controller: new AbortController(), cleanups: [] as unknown[] };
  background = started;
  for (const effect of effects) {
    try {
      started.cleanups.push(await effect(started.controller.signal));
    } catch (error) {
      log("error", ["effect failed to start:", String(error)]);
    }
  }
}

process.on("message", (raw: WorkerToPluginMessage) => {
  switch (raw?.t) {
    case "init":
      startUp(raw).then(
        () => send({ t: "ready", declarations }),
        (error) =>
          send({ t: "failed", error: String((error as Error)?.stack ?? error).slice(0, 4_000) }),
      );
      break;
    case "invoke":
      void invoke(raw);
      break;
    case "cancel":
      running.get(raw.id)?.abort();
      break;
    case "background":
      void setBackground(raw.run);
      break;
    case "ping":
      send({ t: "pong", id: raw.id });
      break;
  }
});

// The worker is gone, whether it exited or crashed: nothing is left to serve.
process.on("disconnect", () => process.exit(0));

// A plugin that breaks itself is restarted by the worker on its next call;
// say why before going, because the worker only sees an exit code.
process.on("uncaughtException", (error) => {
  log("error", ["uncaught exception:", String(error?.stack ?? error)]);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log("error", ["unhandled rejection:", String((reason as Error)?.stack ?? reason)]);
  process.exit(1);
});
