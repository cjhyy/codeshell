import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearSessionInstructionContext } from "./engine-instruction-context.js";
import { contextMessageMark } from "../session/context-messages.js";
import { SessionManager } from "../session/session-manager.js";
import type { Message } from "../types.js";

const textOf = (message: Message): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

describe("clearing a revoked instruction context", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the conversation and leaves engine context out of the checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-instruction-context-"));
    dirs.push(dir);
    const sessionManager = new SessionManager(join(dir, "sessions"));
    const session = sessionManager.create(dir, "model", "provider", "revocation");
    const { transcript } = session;
    const ledgerState = JSON.stringify({ version: 1, sections: {} });

    const first = transcript.appendMessage("user", "before the instruction");
    transcript.appendMessage("user", "<system-reminder>\nRULES\n</system-reminder>", {
      hookReminder: { beforeEventId: first.id, sessionStart: ["RULES"] },
    });
    transcript.appendMessage("user", "<system-reminder>\nSNAPSHOT\n</system-reminder>", {
      contextLedger: { kind: "snapshot", state: ledgerState },
    });
    transcript.appendMessage("assistant", "earlier answer");
    const start = transcript.appendMessage("user", "with the instruction");
    transcript.appendMessage("user", "<system-reminder>\nUPDATE\n</system-reminder>", {
      contextLedger: { kind: "update", state: ledgerState },
    });
    transcript.appendMessage("assistant", "derived answer");
    session.state.instructionContextStartEventId = start.id;
    sessionManager.saveState(session.state);

    const cleared = clearSessionInstructionContext({
      session,
      sessionManager,
      expectedRunId: sessionManager.readSessionState(session.state.sessionId)?.runId,
      bindings: [],
      retainedSnapshots: [],
    });
    expect(cleared).toBe(true);

    const replay = transcript.toMessages();
    expect(replay.map(textOf)).toEqual([
      "before the instruction",
      "earlier answer",
      "with the instruction",
    ]);
    // Nothing unmarked is left to pass as user input, and no ledger message
    // survives: the next run sends one fresh snapshot.
    expect(replay.some((message) => contextMessageMark(message) !== undefined)).toBe(false);
    expect(transcript.toConversationMessages()).toEqual(replay);
  });
});
