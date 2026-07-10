import { describe, expect, test } from "bun:test";
import { resolveOpenCliSessionBucket } from "./openCliSession";

describe("resolveOpenCliSessionBucket", () => {
  test("routes all-session background jobs to their owner bucket", () => {
    const routes = new Map([["engine-b", "repo-b::ui-b"]]);
    expect(resolveOpenCliSessionBucket("engine-b", routes, {})).toBe("repo-b::ui-b");
  });

  test("recovers an owner bucket from persisted session indices", () => {
    expect(
      resolveOpenCliSessionBucket("old-engine", new Map(), {
        "repo-b": {
          activeSessionId: "ui-b",
          sessions: [{ id: "ui-b", engineSessionId: "old-engine" }],
        },
      }),
    ).toBe("repo-b::ui-b");
  });

  test("returns null instead of contaminating the active bucket when owner is unknown", () => {
    expect(resolveOpenCliSessionBucket("missing-engine", new Map(), {})).toBeNull();
  });
});
