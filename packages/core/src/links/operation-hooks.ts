import { HookRegistry } from "../hooks/registry.js";
import type { ConfiguredToolHook } from "../hooks/configured-tool-hooks.js";
import { validateHookResult } from "../hooks/hook-output.js";
import type { HookResult } from "../hooks/events.js";
import type {
  ConstrainedProcessHost,
  ConstrainedProcessPermit,
  ConstrainedProcessResources,
  ConstrainedProcessScope,
} from "../runtime/constrained-process/types.js";

/** Actual Host authorization and a complete finite code closure, never renderer data. */
export interface OperationHookProcesses {
  host: ConstrainedProcessHost;
  /** A missing manifest/authority remains unavailable; there is no inferred file grant. */
  resolveClosure(hook: Readonly<ConfiguredToolHook>):
    | {
        resources?: ConstrainedProcessResources;
      }
    | undefined;
}

function pluginResult(parsed: unknown): HookResult | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, any>;
  const nested = value.hookSpecificOutput;
  if (nested !== undefined && (!nested || typeof nested !== "object" || Array.isArray(nested)))
    return null;
  for (const record of [value, ...(nested ? [nested] : [])]) {
    for (const key of ["decision", "permissionDecision"]) {
      if (Object.hasOwn(record, key) && !["allow", "ask", "deny", "reject"].includes(record[key]))
        return null;
    }
    for (const key of [
      "additionalContext",
      "additional_context",
      "reason",
      "message",
      "permissionDecisionReason",
      "hookEventName",
    ]) {
      if (Object.hasOwn(record, key) && typeof record[key] !== "string") return null;
    }
  }
  const decision =
    value.decision ?? value.permissionDecision ?? nested?.decision ?? nested?.permissionDecision;
  if (decision === "deny" || decision === "reject") return { decision: "deny" };
  // The current plugin protocol has explicit-deny/additional-context semantics,
  // not native HookResult input rewriting or permission-allow authority.
  return {};
}

/** Fresh short-lived registry; failure and denial survive swallowed errors/data/stop. */
export function createOperationHookRegistry(options: {
  descriptors: readonly ConfiguredToolHook[];
  processes: OperationHookProcesses;
  signal: AbortSignal;
  assertAuthorized(): void;
}) {
  const planned = options.descriptors.map((hook) => {
    const closure = options.processes.resolveClosure(Object.freeze({ ...hook }));
    if (!closure) throw new Error("Configured Hook closure is unavailable");
    return { hook: { ...hook }, resources: closure.resources };
  });
  const registry = new HookRegistry();
  let owner:
    | {
        scope: ConstrainedProcessScope;
        issue: ReturnType<ConstrainedProcessHost["createScope"]>["issue"];
      }
    | undefined;
  const permits = new Map<string, ConstrainedProcessPermit>();
  let failure: "permission_denied" | "hooks_unavailable" | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let pinnedInput: string | undefined;
  const eventInputs = new Map<string, string>();
  const protectedFields = [
    "toolName",
    "args",
    "toolCallId",
    "result",
    "error",
    "isError",
    "classifierDecision",
  ];
  const protectedInput = (data: Record<string, unknown>) =>
    JSON.stringify(protectedFields.map((key) => [key, Object.hasOwn(data, key), data[key]]));
  const check = () => {
    options.assertAuthorized();
    if (closed || options.signal.aborted) throw new Error("Operation Hook scope cancelled");
  };
  const latch = (result: "permission_denied" | "hooks_unavailable") => {
    if (failure !== "hooks_unavailable") failure = result;
  };
  for (const { hook, resources } of planned) {
    registry.register(
      hook.event,
      async (context) => {
        if (failure) return { decision: "deny", stop: true };
        try {
          check();
          if (!pinnedInput) throw new Error("Operation Hook input is unbound");
          owner ??= options.processes.host.createScope({
            signal: options.signal,
            assertAuthorized: options.assertAuthorized,
          });
          let permit = permits.get(hook.id);
          if (!permit) {
            permit = owner.issue({
              command: hook.command,
              timeoutMs: hook.timeoutMs,
              event: hook.event,
              resources,
              plugin: hook.protocol === "plugin",
            });
            permits.set(hook.id, permit);
          }
          // Cancellation and authority are closure-owned. Even data.signal from
          // a preceding child is detached and omitted from the wire envelope.
          const { signal: _signal, ...data } = context.data;
          const eventKey = `${context.eventName}:${data.toolCallId}`;
          const eventInput = protectedInput(data);
          const expected = eventInputs.get(eventKey);
          if (expected === undefined) eventInputs.set(eventKey, eventInput);
          else if (expected !== eventInput) throw new Error("Operation Hook context changed");
          if (
            data.toolName !== "LinkAction" ||
            (Object.hasOwn(data, "args") && JSON.stringify(data.args) !== pinnedInput)
          )
            throw new Error("Operation Hook input changed");
          const output = await owner.scope.run(
            permit,
            JSON.stringify({ eventName: context.eventName, data }),
          );
          check();
          let result: HookResult;
          if (output.receipt.exitCode === 2) result = { decision: "deny" };
          else {
            if (output.receipt.exitCode !== 0) throw new Error("Configured Hook failed");
            const text = output.stdout.trim();
            const decoded = text ? JSON.parse(text) : {};
            const validated =
              hook.protocol === "settings" ? validateHookResult(decoded) : pluginResult(decoded);
            if (!validated) throw new Error("Configured Hook output is invalid");
            result = validated;
          }
          if (
            (result.updatedInput !== undefined &&
              JSON.stringify(result.updatedInput) !== pinnedInput) ||
            (result.data && protectedInput({ ...data, ...result.data }) !== eventInput)
          ) {
            latch("permission_denied");
            return { decision: "deny", stop: true };
          }
          if (result.decision === "deny") latch("permission_denied");
          // Hook prose is policy context, never provider evidence. Do not send
          // arbitrary child output into the operation ledger or UI prompt.
          return {
            ...(result.data ? { data: result.data } : {}),
            ...(result.decision ? { decision: result.decision } : {}),
            ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
            ...(result.stop ? { stop: true } : {}),
          };
        } catch {
          latch("hooks_unavailable");
          return { decision: "deny", stop: true };
        }
      },
      hook.priority,
      `operation:${hook.id}`,
    );
  }
  return {
    registry,
    assertResourcesCurrent() {
      for (const item of planned)
        if (item.resources) options.processes.host.assertResourcesCurrent(item.resources);
    },
    bind(input: string) {
      check();
      if (failure) return;
      pinnedInput = input;
    },
    result() {
      return failure;
    },
    assertBeforeProvider() {
      check();
      if (failure) throw new Error("Configured Hook policy rejected the read");
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        try {
          await owner?.scope.terminateAndWait();
        } catch {
          latch("hooks_unavailable");
          throw new Error("Configured Hook cleanup unavailable");
        } finally {
          registry.clear();
        }
      })();
      return closing;
    },
  };
}
