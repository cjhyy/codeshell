import { describe, expect, test } from "bun:test";
import type { SessionOrigin } from "../types.js";

describe("SessionOrigin host extension boundary", () => {
  test("accepts first-party and externally contributed host names", () => {
    const origins: SessionOrigin[] = ["desktop", "tui", "automation", "subagent", "acme-cloud"];
    expect(origins.at(-1)).toBe("acme-cloud");
  });
});
