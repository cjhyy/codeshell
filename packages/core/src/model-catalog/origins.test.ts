import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { catalogEntryOrigins, BUILTIN_CATALOG } from "./index.js";

describe("catalogEntryOrigins", () => {
  let home: string; let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cat-orig-"));
    prevHome = process.env.HOME; process.env.HOME = home;
    mkdirSync(join(home, ".code-shell"), { recursive: true });
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });
  const userFile = () => join(home, ".code-shell", "model-catalog.user.json");

  it("marks a builtin id as builtin when no user override", () => {
    const o = catalogEntryOrigins();
    expect(o[BUILTIN_CATALOG[0].id]).toBe("builtin");
  });

  it("marks a user-only id as user", () => {
    writeFileSync(userFile(), JSON.stringify([{ id: "my-custom", tag: "text", adapterKind: "openai", displayName: "Mine", description: "", defaultBaseUrl: "u" }]));
    expect(catalogEntryOrigins()["my-custom"]).toBe("user");
  });

  it("marks an overridden builtin id as user-override-of-builtin", () => {
    const builtinId = BUILTIN_CATALOG[0].id;
    writeFileSync(userFile(), JSON.stringify([{ id: builtinId, tag: "text", adapterKind: "openai", displayName: "Overridden", description: "", defaultBaseUrl: "u" }]));
    expect(catalogEntryOrigins()[builtinId]).toBe("user-override-of-builtin");
  });
});
