import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "./index.js";

describe("public VERSION", () => {
  it("matches package.json version", () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(VERSION).toBe(packageJson.version);
  });
});
