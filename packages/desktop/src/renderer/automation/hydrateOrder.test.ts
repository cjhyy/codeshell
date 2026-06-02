import { describe, it, expect } from "bun:test";
import { chooseHydrateBase } from "./hydrateOrder";
import { INITIAL_STATE, type Message, type MessagesReducerState } from "../types";

const stateOf = (m: Message[]): MessagesReducerState => ({ ...INITIAL_STATE, messages: m });
const user = (id: string, text: string): Message => ({ kind: "user", id, text });
const tool = (id: string, n: string, a: string): Message => ({ kind: "tool", id, toolName: n, args: a, status: "ok", startedAt: 0 });

describe("chooseHydrateBase", () => {
  it("uses disk (merged) when disk has messages — local-only redundant tools don't tail", () => {
    const disk = stateOf([user("d1", "汇总"), tool("d2", "WebSearch", "{}")]);
    const local = stateOf([user("l1", "汇总"), tool("l2", "WebSearch", "{}")]); // same content
    const out = chooseHydrateBase(disk, local);
    expect(out.messages.filter((m) => m.kind === "tool")).toHaveLength(1);
    expect(out.messages.map((m) => m.kind)).toEqual(["user", "tool"]);
  });

  it("falls back to local when disk is empty", () => {
    const local = stateOf([user("l1", "hi")]);
    expect(chooseHydrateBase(INITIAL_STATE, local)).toBe(local);
  });
});
