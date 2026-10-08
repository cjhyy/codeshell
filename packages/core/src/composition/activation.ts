import type { CapabilityToolServiceHost } from "../capabilities/index.js";
import type { DisposableLike } from "./lifetime.js";
import { LifetimeScope } from "./lifetime.js";
import type {
  AgentModulePrivateServiceContribution,
  EngineModuleActivationContext,
  ModuleServiceHost,
  ResolvedComposition,
  ResolvedContribution,
} from "./types.js";

export async function ownActivationResult(
  scope: LifetimeScope,
  result: DisposableLike,
): Promise<void> {
  if (!scope.disposed) {
    scope.own(result);
    return;
  }
  // Closing while an async factory is pending must not orphan its late resource.
  if (typeof result === "function") await result();
  else if (result) await result.dispose();
}

export function activationContext<THost>(
  composition: ResolvedComposition,
  moduleId: string,
  scope: LifetimeScope,
  host: THost,
) {
  return Object.freeze({
    moduleId,
    resolved: composition.modules.find((module) => module.id === moduleId)!,
    scope,
    host: Object.freeze(host),
    own: (resource: DisposableLike) => scope.own(resource),
  });
}

/** A failed factory unwinds the owner's whole partially acquired composition. */
export async function activateEngineModules(
  composition: ResolvedComposition,
  scope: LifetimeScope,
  host: CapabilityToolServiceHost,
): Promise<void> {
  try {
    for (const contribution of composition.engineActivators) {
      if (scope.disposed) return;
      await ownActivationResult(
        scope,
        await contribution.value(
          activationContext(
            composition,
            contribution.moduleId,
            scope,
            host,
          ) as EngineModuleActivationContext,
        ),
      );
    }
  } catch (error) {
    try {
      await scope.dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Engine module activation failed", {
        cause: cleanup,
      });
    }
    throw error;
  }
}

export function createPrivateServices(
  contributions: readonly ResolvedContribution<AgentModulePrivateServiceContribution>[],
  kind: "engine" | "session",
  scope: LifetimeScope,
  host: ModuleServiceHost,
  values: Record<string, unknown>,
): Promise<void> {
  const pending: Promise<void>[] = [];
  let rollback: Promise<void> | undefined;
  const beginRollback = (): void => {
    rollback ??= scope.dispose();
    void rollback.catch(() => {});
  };
  const fail = (error: unknown): never => {
    beginRollback();
    throw error;
  };
  const install = (
    moduleId: string,
    declaration: AgentModulePrivateServiceContribution,
    value: unknown,
  ) => {
    const release = () => declaration.dispose?.(value);
    if (scope.disposed) {
      return Promise.resolve(release());
    }
    values[moduleId] = value;
    scope.own(() => {
      delete values[moduleId];
      return release();
    });
  };
  try {
    for (const { moduleId, value: declaration } of contributions) {
      if (declaration.scope !== kind) continue;
      const value = declaration.create(host);
      if (value && typeof (value as Promise<unknown>).then === "function") {
        pending.push(
          Promise.resolve(value)
            .then((result) => install(moduleId, declaration, result))
            .catch(fail),
        );
      } else {
        const installed = install(moduleId, declaration, value);
        if (installed) pending.push(installed.catch(fail));
      }
    }
  } catch (error) {
    beginRollback();
    pending.push(Promise.reject(error));
  }
  return Promise.allSettled(pending).then(async (results) => {
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      try {
        await (rollback ?? scope.dispose());
      } catch (error) {
        errors.push(error);
      }
      throw new AggregateError(errors, "Private service activation failed");
    }
  });
}
