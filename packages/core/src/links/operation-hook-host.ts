import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isClosedInlineHook, type ConfiguredToolHook } from "../hooks/configured-tool-hooks.js";
import { createConstrainedDockerProcessHost } from "../runtime/constrained-process/docker.js";
import { sha256 } from "../runtime/constrained-process/resources.js";
import type { ConstrainedProcessResources } from "../runtime/constrained-process/types.js";
import { userHome } from "../settings/manager.js";
import {
  assertHookResourceNotCredential,
  createHookCredentialPolicy,
  type HookCredentialPolicy,
} from "./operation-hook-credentials.js";
import { createHookSourceCustody, sourceMatches } from "./operation-hook-custody.js";
import { parseOperationHookHost, type NativeHookResourcePlan } from "./operation-hook-plans.js";
import type { OperationHookContext, OperationHookProcesses } from "./operation-hooks.js";

type CapturedPlan = {
  state: "captured" | "invalid";
  resources: ConstrainedProcessResources;
  assertCustody(): void;
};

/**
 * Native Host startup configuration, never merged project Settings/env and
 * never accepted by IPC. The explicit command hashes approve finite literal
 * inline code. Optional finite plans explicitly authorize individual resources;
 * installed-plugin trust alone never authorizes reads.
 */
export function createOperationHookHost(
  configuration: string | undefined,
  options: {
    nativeHome?: string;
    sensitiveRoots?: readonly string[];
    stateRoot?: string;
    /** Trusted native writer-root custody, never a current-review callback. */
    assertStateRootCurrent?(): void;
  } = {},
):
  | {
      hookProcesses: OperationHookProcesses;
      dispose(): Promise<void>;
    }
  | undefined {
  if (configuration === undefined) return undefined;
  options = Object.freeze({
    ...options,
    sensitiveRoots: Object.freeze([...(options.sensitiveRoots ?? [])]),
  });
  const parsed = parseOperationHookHost(configuration);
  const host = createConstrainedDockerProcessHost(parsed.runtime);
  let credentialPolicy: HookCredentialPolicy | undefined;
  try {
    credentialPolicy = createHookCredentialPolicy({
      nativeHome: resolve(options.nativeHome ?? userHome()),
      temporaryRoot: resolve(tmpdir()),
      sensitiveRoots: Object.freeze((options.sensitiveRoots ?? []).map((path) => resolve(path))),
      stateRoot:
        options.stateRoot ?? (process.env.CODE_SHELL_HOME || join(userHome(), ".code-shell")),
    });
  } catch {
    // Unsafe known roots disable only the opt-in resource authority for this
    // native lifetime. Existing approved closed-inline execution needs no files.
  }
  const cache = new Map<NativeHookResourcePlan, CapturedPlan | "invalid" | "capturing">();
  let disposed = false;
  let nativeStateInvalid = credentialPolicy === undefined;
  const originalStateEnvironment = process.env.CODE_SHELL_HOME;
  const assertNativeState = () => {
    if (nativeStateInvalid || !credentialPolicy)
      throw new Error("Native Hook state custody unavailable");
    try {
      credentialPolicy.assertCurrent();
      if (
        options.stateRoot === undefined &&
        process.env.CODE_SHELL_HOME !== originalStateEnvironment
      )
        throw new Error("Native Hook state root changed");
      options.assertStateRootCurrent?.();
    } catch (error) {
      nativeStateInvalid = true;
      throw error;
    }
  };
  const match = (hook: Readonly<ConfiguredToolHook>, context: Readonly<OperationHookContext>) => {
    if (disposed) throw new Error("Operation Hook Host disposed");
    const commandSha256 = sha256(hook.command);
    if (parsed.inline.has(commandSha256)) {
      if (hook.cwd !== undefined || !isClosedInlineHook(hook.command)) return undefined;
      return "inline";
    }
    assertNativeState();
    const plans = parsed.plans.filter(
      (plan) =>
        plan.commandSha256 === commandSha256 &&
        plan.event === hook.event &&
        plan.definitionCwd === (hook.cwd ?? null) &&
        plan.context.cwd === context.cwd &&
        plan.context.settingsScope === context.settingsScope &&
        plan.context.profileName === context.profileName &&
        sourceMatches(
          plan.source as unknown as Record<string, unknown>,
          hook.source as unknown as Record<string, unknown> | undefined,
        ),
    );
    if (plans.length !== 1) return undefined;
    return plans[0];
  };
  const checkCachedCustody = (record: CapturedPlan) => {
    if (disposed || record.state === "invalid") throw new Error("Hook plan custody unavailable");
    try {
      record.assertCustody();
    } catch (error) {
      record.state = "invalid";
      throw error;
    }
  };
  return {
    hookProcesses: {
      host,
      assertApplicable(hooks, context) {
        // Config/install checks are resource-free and independent of a review.
        for (const hook of hooks) {
          // A source change can prevent a match. Check the previously selected
          // source's custody before rejecting, so restoring bytes cannot repair it.
          for (const [plan, record] of cache)
            if (
              typeof record === "object" &&
              plan.commandSha256 === sha256(hook.command) &&
              plan.event === hook.event &&
              plan.context.cwd === context.cwd &&
              plan.context.settingsScope === context.settingsScope &&
              plan.context.profileName === context.profileName
            ) {
              try {
                checkCachedCustody(record);
              } catch {
                /* Sticky state remains on this plan. */
              }
            }
          const plan = match(hook, context);
          if (
            !plan ||
            (plan !== "inline" &&
              (cache.get(plan) === "invalid" ||
                (typeof cache.get(plan) === "object" &&
                  (cache.get(plan) as CapturedPlan).state === "invalid")))
          )
            throw new Error("Configured Hook plan unavailable");
        }
      },
      resolveClosure(hook, context) {
        const plan = match(hook, context);
        if (!plan) return undefined;
        if (plan === "inline") return {};
        let record = cache.get(plan);
        if (record === "invalid" || record === "capturing")
          throw new Error("Hook plan custody unavailable");
        if (!record) {
          cache.set(plan, "capturing");
          try {
            const assertSourceCustody = createHookSourceCustody(hook);
            const assertCustody = () => {
              assertNativeState();
              assertSourceCustody();
            };
            const grants = plan.files.map((file) => {
              const path =
                plan.source.kind === "plugin"
                  ? join(plan.source.installPath, file.source)
                  : file.source;
              if (!credentialPolicy) throw new Error("Native Hook state custody unavailable");
              assertHookResourceNotCredential(path, credentialPolicy);
              if (resolve(path) !== path || realpathSync(path) !== path)
                throw new Error("Hook resource path is not canonical");
              return {
                path,
                name: file.name,
                expectedBytes: file.bytes,
                expectedSha256: file.sha256,
                assertReadable: () => {
                  if (disposed || cache.get(plan) === "invalid")
                    throw new Error("Hook plan custody unavailable");
                  try {
                    assertCustody();
                  } catch (error) {
                    cache.set(plan, "invalid");
                    throw error;
                  }
                },
              };
            });
            const resources = host.capture(grants, { directories: plan.directories });
            record = { state: "captured", resources, assertCustody };
            cache.set(plan, record);
          } catch (error) {
            cache.set(plan, "invalid");
            throw error;
          }
        }
        checkCachedCustody(record);
        host.assertResourcesCurrent(record.resources);
        return {
          resources: record.resources,
          launch: { ...plan.launch, argv: [...plan.launch.argv], planSha256: plan.planSha256 },
        };
      },
    },
    async dispose() {
      disposed = true;
      await host.dispose();
      cache.clear();
    },
  };
}
