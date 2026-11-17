import { describe, expect, test } from "bun:test";
import {
  parseLedgerState,
  planLedgerEmission,
  serializeLedgerState,
  type ContextSection,
} from "../context/context-ledger.js";
import { Transcript } from "../session/transcript.js";
import type { Message } from "../types.js";
import { createRunContextLedger } from "./run-context-ledger.js";

const gitStatus = (run: number): ContextSection => ({
  key: "capability-git-status",
  text: `gitStatus: snapshot\nStatus:\nM file-${run}.ts`,
  compare: "snapshot-only",
});
const memory = (text: string): ContextSection => ({ key: "memory", text });

const textOf = (messages: readonly Message[]): string => JSON.stringify(messages);
const ledgerEvents = (transcript: Transcript) =>
  transcript.getEvents("message").filter((event) => event.data.contextLedger !== undefined);

/** One run: the resumed history (or `history`), the task, then the ledger's sync. */
function run(
  transcript: Transcript,
  sections: ContextSection[],
  options: { scope?: string; history?: Message[] } = {},
): Message[] {
  const messages = options.history ?? transcript.toMessages();
  messages.push({ role: "user", content: "task" });
  transcript.appendMessage("user", "task");
  createRunContextLedger({ transcript, sections, scope: options.scope }).sync(messages);
  return messages;
}

describe("snapshot-only context sections", () => {
  test("five runs with a changing git status: only the snapshot carries it", () => {
    const transcript = Transcript.inMemory("ledger-snapshot-only-runs");
    run(transcript, [gitStatus(1), memory("FACT 1")]);
    for (let index = 2; index <= 5; index += 1) {
      run(transcript, [gitStatus(index), memory(`FACT ${index >= 3 ? 3 : 1}`)]);
    }
    const events = ledgerEvents(transcript);
    // The snapshot, and one update for the memory change on run 3.
    expect(events.map((event) => (event.data.contextLedger as { kind: string }).kind)).toEqual([
      "snapshot",
      "update",
    ]);
    expect(String(events[0]!.data.content)).toContain("M file-1.ts");
    expect(String(events[1]!.data.content)).toContain("FACT 3");
    expect(String(events[1]!.data.content)).not.toContain("gitStatus");
    const replay = textOf(transcript.toMessages());
    for (const stale of ["file-2", "file-3", "file-4", "file-5"]) {
      expect(replay).not.toContain(stale);
    }
  });

  test("a fresh snapshot after the context was dropped shows the current status", () => {
    const transcript = Transcript.inMemory("ledger-snapshot-only-compaction");
    run(transcript, [gitStatus(1), memory("FACT")]);
    run(transcript, [gitStatus(2), memory("FACT")]);
    // Compaction dropped every earlier message: the chain is no longer told.
    const messages = run(transcript, [gitStatus(3), memory("FACT")], { history: [] });
    const fresh = messages.at(-1)!;
    expect(textOf([fresh])).toContain("M file-3.ts");
    expect(textOf([fresh])).not.toContain("M file-1.ts");
    expect(ledgerEvents(transcript).at(-1)!.data.contextLedger).toMatchObject({
      kind: "snapshot",
    });
  });

  test("a workspace change takes a fresh snapshot with the current status", () => {
    const transcript = Transcript.inMemory("ledger-snapshot-only-scope");
    run(transcript, [gitStatus(1)], { scope: "workspace-a" });
    const messages = run(transcript, [gitStatus(2)], { scope: "workspace-b" });
    expect(textOf(messages)).toContain("M file-2.ts");
    expect(textOf(messages)).not.toContain("M file-1.ts");
  });

  test("appearing, changing and disappearing are all left for the next snapshot", () => {
    const first = planLedgerEmission([memory("FACT")], undefined);
    // Appears mid-cycle: not sent.
    expect(planLedgerEmission([memory("FACT"), gitStatus(1)], first.state).kind).toBe("none");

    const snapshot = planLedgerEmission([memory("FACT"), gitStatus(1)], undefined);
    expect(snapshot.kind).toBe("snapshot");
    // Changes: not sent, and the state keeps what the snapshot showed.
    const changed = planLedgerEmission([memory("FACT"), gitStatus(2)], snapshot.state);
    expect(changed).toEqual({ kind: "none", state: snapshot.state });
    // Disappears: never announced as removed.
    const gone = planLedgerEmission([memory("FACT")], snapshot.state);
    expect(gone).toEqual({ kind: "none", state: snapshot.state });
    // An ordinary change still updates only its own section.
    const update = planLedgerEmission([memory("FACT 2"), gitStatus(3)], snapshot.state);
    expect(update.kind).toBe("update");
    expect(update.kind === "update" ? update.text : "").not.toContain("gitStatus");
    expect(update.state.sections["capability-git-status"]).toEqual(
      snapshot.state.sections["capability-git-status"],
    );
  });

  test("the snapshot-only mark survives a state round trip", () => {
    const { state } = planLedgerEmission([gitStatus(1)], undefined);
    const parsed = parseLedgerState(serializeLedgerState(state));
    expect(parsed).toEqual(state);
    expect(planLedgerEmission([], parsed).kind).toBe("none");
    expect(
      parseLedgerState({ version: 2, sections: { a: { digest: "x", snapshotOnly: 1 } } }),
    ).toBeUndefined();
  });
});
