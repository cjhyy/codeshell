import type {
  ExtensionQueryHandler,
  ProtocolObserver,
  ProtocolObserverHost,
} from "../tool-system/capability-module.js";
import type { ResolvedComposition } from "./types.js";

/**
 * Wire a resolved protocol composition into an AgentServer's observer list
 * and query dispatch table. Observer factories run first (isolated per
 * module — a throwing factory only loses its own observer); declared
 * queries never clobber a handler an observer registered at create time.
 */
export function attachProtocolContributions(opts: {
  protocol: ResolvedComposition["protocol"];
  host: ProtocolObserverHost;
  observers: ProtocolObserver[];
  queryHandlers: Map<string, ExtensionQueryHandler>;
  warn: (message: string) => void;
}): void {
  for (const factory of opts.protocol.observerFactories) {
    try {
      opts.observers.push(factory.value(opts.host));
    } catch (err) {
      opts.warn(
        `protocol observer init failed for module ${factory.moduleId}: ${(err as Error).message}`,
      );
    }
  }
  for (const query of opts.protocol.queries) {
    if (!opts.queryHandlers.has(query.key)) {
      opts.queryHandlers.set(query.key, query.value);
    }
  }
}
