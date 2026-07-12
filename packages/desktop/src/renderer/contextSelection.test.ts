import { describe, expect, it } from "bun:test";
import type { RawTranscriptEvent } from "../preload/types";
import {
  buildSelectableContextTurns,
  copyContextPackageOverrides,
  selectedTurnRange,
} from "./contextSelection";

const event = (
  id: string,
  type: string,
  turnNumber: number,
  data: Record<string, unknown> = {},
): RawTranscriptEvent => ({ id, type, turnNumber, timestamp: turnNumber, data });

describe("MessageStream context selection", () => {
  it("groups complete turns, keeps tool cards with their turn and excludes a streaming tail", () => {
    const turns = buildSelectableContextTurns(
      [
        event("meta", "session_meta", 0),
        event("u1", "message", 0, { role: "user", content: "first" }),
        event("a1", "message", 0, { role: "assistant", content: "answer" }),
        event("tu1", "tool_use", 0, { toolCallId: "call-1" }),
        event("tr1", "tool_result", 0, { toolCallId: "call-1", result: "ok" }),
        event("b1", "turn_boundary", 1),
        event("u2", "message", 1, { role: "user", content: "streaming" }),
      ],
      true,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turnNumber: 0,
      fromEventId: "u1",
      toEventId: "b1",
      eventIds: ["u1", "a1", "tu1", "tr1", "b1"],
    });
  });

  it("returns one closed event range for a continuous turn selection", () => {
    const turns = buildSelectableContextTurns(
      [
        event("u1", "message", 0, { role: "user", content: "one" }),
        event("b1", "turn_boundary", 1),
        event("u2", "message", 1, { role: "user", content: "two" }),
        event("b2", "turn_boundary", 2),
        event("u3", "message", 2, { role: "user", content: "three" }),
        event("b3", "turn_boundary", 3),
      ],
      false,
    );

    expect(selectedTurnRange(turns, 0, 1)).toEqual({ fromEventId: "u1", toEventId: "b2" });
    expect(() => selectedTurnRange(turns, 2, 1)).toThrow(/order/i);
  });

  it("pins the source model and permission/plan mode onto the target without inheriting goal", () => {
    expect(
      copyContextPackageOverrides({
        sourceBucket: "repo::source",
        targetBucket: "repo::target",
        modelOverrides: {},
        permissionOverrides: {},
        goalOverrides: { "repo::source": true },
        defaultModel: "global-model",
        defaultPermission: "plan",
      }),
    ).toEqual({
      modelOverrides: { "repo::target": "global-model" },
      permissionOverrides: { "repo::target": "plan" },
      goalOverrides: { "repo::source": true, "repo::target": false },
    });
  });
});
