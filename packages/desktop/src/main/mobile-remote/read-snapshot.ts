import type { AgentBridge } from "../agent-bridge.js";
type Snapshot = ReturnType<AgentBridge["getSnapshot"]>;

/** Older in-process bridges still return a synchronous snapshot. A failed Host
 * read must propagate; replaying from another generation can duplicate output. */
export function readMobileSnapshot(
  bridge: Pick<AgentBridge, "getSnapshot"> & {
    readSnapshot?(sessionId: string, sinceSeq?: number): Promise<Snapshot>;
  },
  sessionId: string,
  sinceSeq = 0,
) {
  return bridge.readSnapshot
    ? bridge.readSnapshot(sessionId, sinceSeq)
    : bridge.getSnapshot(sessionId, sinceSeq);
}
