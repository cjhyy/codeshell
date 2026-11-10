import type { Engine } from "../../engine/engine.js";
import type { ChatSessionManager } from "../chat-session-manager.js";
import type { Transport } from "../transport.js";
import type { QueryParams, RpcRequest } from "../types.js";

/** Only query routing dependencies; each handler selects its own subset. */
export interface BuiltinQueryContext {
  engine: Engine | null;
  send: Transport["send"];
  resolveEngine: (
    req: RpcRequest,
    sessionId: string | undefined,
    fallback: Engine | null | undefined,
    label: string,
  ) => Promise<Engine | null>;
  readonly chatManager: ChatSessionManager | null;
  hiddenSessionKinds: readonly string[];
  allowUsageAggregation: boolean;
  notify: (method: string, params: Record<string, unknown>) => void;
}
export type BuiltinQueryHandler = (
  context: BuiltinQueryContext,
  req: RpcRequest,
  params: QueryParams,
) => Promise<void>;
