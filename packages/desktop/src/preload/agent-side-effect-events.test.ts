import { describe, expect, test } from "bun:test";
import { forwardAgentSideEffectEvent } from "./agent-side-effect-events.js";

describe("worker side-effect notifications", () => {
  test("model catalog changes invalidate mounted settings resources", () => {
    const dispatched: string[] = [];

    const handled = forwardAgentSideEffectEvent("agent/settingsChanged", (eventName) => {
      dispatched.push(eventName);
    });

    expect(handled).toBe(true);
    expect(dispatched).toEqual(["codeshell:settings-changed"]);
  });

  test("unrelated protocol notifications remain on the normal route", () => {
    const dispatched: string[] = [];

    const handled = forwardAgentSideEffectEvent("agent/status", (eventName) => {
      dispatched.push(eventName);
    });

    expect(handled).toBe(false);
    expect(dispatched).toEqual([]);
  });
});
