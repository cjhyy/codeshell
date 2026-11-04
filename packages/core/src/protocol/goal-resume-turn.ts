import { trackRunStart } from "./run-start-claims.js";
import type { GoalConfig } from "../goal/lifecycle.js";
import type { StreamEvent } from "../types.js";
import type { ChatSession, TurnOpts } from "./chat-session.js";
import type { ChatSessionManager } from "./chat-session-manager.js";

/**
 * Queue the synthetic continuation turn of a resumed Goal. A cold Session is
 * rebuilt from disk; it has no resident Host authority, so its workspace is
 * resolved like any other Core-started turn (background wakeups, async
 * answers) before the turn runs. Resolves null when no interactive Session
 * can run it.
 */
export async function queueGoalResumeTurn(input: {
  sessionId: string;
  goal: GoalConfig;
  existing?: ChatSession;
  manager: ChatSessionManager;
  wire(session: ChatSession): void;
  resolveWorkspace(session: ChatSession): Promise<Pick<TurnOpts, "cwd" | "workspaceContext">>;
  onStream(event: StreamEvent): void;
  approvalRouter: TurnOpts["approvalRouter"];
  onEnd(): void;
}): Promise<{ completion: Promise<boolean> } | null> {
  const start = new AbortController();
  const untrack = trackRunStart(input.manager, input.sessionId, start);
  try {
    let session = input.existing;
    if (!session) {
      session =
        (await input.manager.getOrCreatePersisted(
          input.sessionId,
          { projectTrusted: false },
          true,
          { signal: start.signal },
        )) ?? undefined;
      if (!session) return null;
      input.wire(session);
    }
    if (session.engine.isHeadless()) return null;
    const workspace = input.existing ? {} : await input.resolveWorkspace(session);
    start.signal.throwIfAborted();
    if (
      input.manager.isUnavailable(input.sessionId) ||
      input.manager.get(input.sessionId) !== session
    )
      return null;
    return {
      completion: session
        .enqueueGoalResumeTurn(input.goal, {
          ...workspace,
          onStream: input.onStream,
          approvalRouter: input.approvalRouter,
        })
        .finally(input.onEnd),
    };
  } finally {
    untrack();
  }
}
