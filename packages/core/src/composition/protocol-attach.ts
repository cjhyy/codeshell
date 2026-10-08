import type {
  ExtensionQueryHandler,
  ProtocolObserver,
  ProtocolObserverHost,
} from "../tool-system/capability-module.js";
import { activationContext, ownActivationResult } from "./activation.js";
import { LifetimeScope, onceDispose, type Dispose } from "./lifetime.js";
import type { ResolvedComposition } from "./types.js";

export function registerProtocolQuery(
  handlers: Map<string, ExtensionQueryHandler>,
  type: string,
  handler: ExtensionQueryHandler,
): Dispose {
  const registration: ExtensionQueryHandler = (params) => handler(params);
  handlers.set(type, registration);
  return onceDispose(() => {
    if (handlers.get(type) === registration) handlers.delete(type);
  });
}

/** Observer factories stay fail-soft; their partial queries roll back as one module. */
export function attachProtocolContributions(opts: {
  composition: ResolvedComposition;
  scope: LifetimeScope;
  host: Omit<ProtocolObserverHost, "registerQuery">;
  observers: ProtocolObserver[];
  queryHandlers: Map<string, ExtensionQueryHandler>;
  closeObserver: (observer: ProtocolObserver) => void;
  warn: (message: string) => void;
}): Promise<void> {
  const { composition, scope } = opts;
  const modules = new Map<string, LifetimeScope>();
  const failed = new Set<string>();
  for (const module of composition.modules) modules.set(module.id, scope.child("host", module.id));
  for (const factory of composition.protocol.observerFactories) {
    const owner = modules.get(factory.moduleId)!;
    const allowed = new Set(
      composition.protocol.queries.filter((q) => q.moduleId === factory.moduleId).map((q) => q.key),
    );
    try {
      const observer = factory.value(
        Object.freeze({
          ...opts.host,
          registerQuery: (type: string, handler: ExtensionQueryHandler) => {
            if (owner.disposed)
              throw new Error(`Protocol query owner ${factory.moduleId} is disposed`);
            if (!allowed.has(type))
              throw new Error(`Module ${factory.moduleId} registered undeclared query ${type}`);
            const remove = registerProtocolQuery(opts.queryHandlers, type, handler);
            try {
              owner.own(remove);
            } catch (error) {
              void remove();
              throw error;
            }
            return remove;
          },
        }),
      );
      opts.observers.push(observer);
      owner.own(() => {
        try {
          opts.closeObserver(observer);
        } finally {
          const index = opts.observers.indexOf(observer);
          if (index >= 0) opts.observers.splice(index, 1);
        }
      });
    } catch (error) {
      failed.add(factory.moduleId);
      void owner
        .dispose()
        .catch((cleanup) => opts.warn(`protocol observer rollback failed: ${String(cleanup)}`));
      opts.warn(`protocol observer init failed for module ${factory.moduleId}: ${String(error)}`);
    }
  }
  for (const query of composition.protocol.queries) {
    if (!failed.has(query.moduleId) && !opts.queryHandlers.has(query.key)) {
      modules
        .get(query.moduleId)!
        .own(registerProtocolQuery(opts.queryHandlers, query.key, query.value));
    }
  }
  return (async () => {
    try {
      for (const contribution of composition.hostActivators) {
        if (scope.disposed) return;
        if (failed.has(contribution.moduleId)) continue;
        const owner = modules.get(contribution.moduleId)!;
        await ownActivationResult(
          owner,
          await contribution.value(
            activationContext(composition, contribution.moduleId, owner, opts.host),
          ),
        );
      }
    } catch (error) {
      try {
        await scope.dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Host module activation failed", {
          cause: cleanup,
        });
      }
      throw error;
    }
  })();
}
