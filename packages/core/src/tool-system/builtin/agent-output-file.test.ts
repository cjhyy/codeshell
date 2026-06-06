import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentOutputDir,
  agentOutputPath,
  writeAgentOutputFile,
  removeAgentOutputFile,
  clearAgentOutputFiles,
} from "./agent-output-file.js";

let prevHome: string | undefined;
let home: string;

beforeEach(async () => {
  prevHome = process.env.HOME;
  // Isolate HOME so we write into a throwaway ~/.code-shell/agents.
  home = await mkdtemp(join(tmpdir(), "agentout-"));
  process.env.HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe("agent-output-file", () => {
  it("resolves the path under ~/.code-shell/agents", () => {
    expect(agentOutputDir()).toBe(join(home, ".code-shell", "agents"));
    expect(agentOutputPath("agent-1")).toBe(
      join(home, ".code-shell", "agents", "agent-1.txt"),
    );
  });

  it("sanitizes a hostile agentId so it can't escape the dir", () => {
    const p = agentOutputPath("../../etc/passwd");
    // Stays directly inside the agents dir — the separators were replaced, so
    // the basename has no path traversal even though "_.._" survives as text.
    expect(p.startsWith(agentOutputDir() + "/")).toBe(true);
    const rel = p.slice(agentOutputDir().length + 1);
    expect(rel).not.toContain("/");
  });

  it("writes the final text with a header", async () => {
    await writeAgentOutputFile("agent-7", {
      status: "completed",
      body: "the result",
      description: "do a thing",
      name: "Explore",
    });
    const text = await readFile(agentOutputPath("agent-7"), "utf8");
    expect(text).toContain("# agent agent-7 (Explore)");
    expect(text).toContain("# status: completed");
    expect(text).toContain("# task: do a thing");
    expect(text).toContain("the result");
  });

  it("overwrites on a second write", async () => {
    await writeAgentOutputFile("a", { status: "completed", body: "first" });
    await writeAgentOutputFile("a", { status: "failed", body: "second" });
    const text = await readFile(agentOutputPath("a"), "utf8");
    expect(text).toContain("second");
    expect(text).not.toContain("first");
    expect(text).toContain("# status: failed");
  });

  it("never throws on write failure (reports via onError)", async () => {
    // Point HOME at a path whose parent can't be created (a file, not a dir).
    let errored = false;
    process.env.HOME = "/dev/null/nope";
    await writeAgentOutputFile("x", {
      status: "completed",
      body: "y",
      onError: () => {
        errored = true;
      },
    });
    expect(errored).toBe(true);
  });

  it("removes a single file and clears all files", async () => {
    await writeAgentOutputFile("a", { status: "completed", body: "1" });
    await writeAgentOutputFile("b", { status: "completed", body: "2" });
    await removeAgentOutputFile("a");
    expect(await readdir(agentOutputDir())).toEqual(["b.txt"]);
    await clearAgentOutputFiles();
    expect(await readdir(agentOutputDir())).toEqual([]);
  });
});
