import { describe, expect, test } from "bun:test";
import { resolveOpenCliSessionBucket } from "./openCliSession";

describe("resolveOpenCliSessionBucket", () => {
  test("routes all-session background jobs to their owner bucket", () => {
    const routes = new Map([["engine-b", "repo-b::ui-b"]]);
    expect(resolveOpenCliSessionBucket("engine-b", routes, "repo-a::ui-a")).toBe("repo-b::ui-b");
  });

  test("falls back to the active bucket when an old session has no route", () => {
    expect(resolveOpenCliSessionBucket("old-engine", new Map(), "repo-a::ui-a")).toBe(
      "repo-a::ui-a",
    );
  });
});
