import { SessionManager } from "../../packages/core/src/session/session-manager.js";
import { SessionContextNotes } from "../../packages/core/src/context/notes.js";

export const CONTEXT_CANARY = "LOCAL_ONLY_CONTEXT_CANARY_D672";
export const PUBLIC_PROMPT = "Original public user wording";
export const PUBLIC_ANSWER = "Ordinary public assistant answer";

/** Real rewrite -> NewContext snapshot; leaves original events intact on disk. */
export function contextPrivacySession(root: string, cwd: string, id = "context-privacy") {
  const manager = new SessionManager(root);
  const bundle = manager.create(cwd, "fixture", "fixture", id);
  const transcript = bundle.transcript;
  transcript.appendMessage("user", "Earlier public request");
  transcript.appendMessage("assistant", "Earlier public answer. ".repeat(500));
  const notes = new SessionContextNotes(transcript);
  notes.markModelBoundary();
  notes.save("Continue the existing task.");
  const user = transcript.appendMessage("user", PUBLIC_PROMPT, { clientMessageId: "public-input" });
  transcript.appendMessage("user", `${CONTEXT_CANARY}:ledger`, {
    contextLedger: { kind: "snapshot", state: JSON.stringify({ secret: CONTEXT_CANARY }) },
  });
  transcript.appendMessage("user", `${CONTEXT_CANARY}:hook`, {
    hookReminder: { beforeEventId: user.id, promptSubmit: [CONTEXT_CANARY] },
  });
  transcript.appendPromptRewrite({ messageEventId: user.id, content: `${CONTEXT_CANARY}:rewrite` });
  transcript.appendMessage("assistant", PUBLIC_ANSWER);
  notes.requestRollover();
  if (!notes.applyRollover())
    throw new Error("Fixture failed to commit a real NewContext checkpoint");
  const checkpoint = transcript.getEvents("context_checkpoint").at(-1)!;
  if (!JSON.stringify(checkpoint.data.messages).includes(`${CONTEXT_CANARY}:rewrite`)) {
    throw new Error("Fixture checkpoint did not absorb the rewritten prompt");
  }
  bundle.state.promptSubmitHookMessages = [CONTEXT_CANARY];
  bundle.state.status = "completed";
  manager.updateSessionState(id, {
    promptSubmitHookMessages: [CONTEXT_CANARY],
    status: "completed",
  });
  return { manager, bundle, checkpoint };
}
