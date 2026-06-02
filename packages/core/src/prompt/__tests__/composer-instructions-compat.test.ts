import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptComposer } from "../composer.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-compat-"));
  writeFileSync(join(dir, "CODESHELL.md"), "PRIMARY_INSTR");
  writeFileSync(join(dir, "CLAUDE.md"), "CLAUDE_INSTR");
  writeFileSync(join(dir, "AGENTS.md"), "AGENTS_INSTR");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function userCtx(opts: Record<string, unknown>) {
  const c = new PromptComposer({ cwd: dir, model: "test", ...opts } as any);
  return c.buildUserContextMessage()?.content ?? "";
}

describe("instruction compat toggles", () => {
  it("reads CODESHELL.md always", () => {
    expect(userCtx({ instructionOptions: { compatFileNames: [] } })).toContain("PRIMARY_INSTR");
  });
  it("reads CLAUDE.md only when CLAUDE.md in compatFileNames", () => {
    expect(userCtx({ instructionOptions: { compatFileNames: ["CLAUDE.md"] } })).toContain("CLAUDE_INSTR");
    expect(userCtx({ instructionOptions: { compatFileNames: ["AGENTS.md"] } })).not.toContain("CLAUDE_INSTR");
  });
  it("reads AGENTS.md only when AGENTS.md in compatFileNames", () => {
    expect(userCtx({ instructionOptions: { compatFileNames: ["AGENTS.md"] } })).toContain("AGENTS_INSTR");
  });
});
