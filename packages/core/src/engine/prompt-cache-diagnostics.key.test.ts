import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
const previous = process.env.CODE_SHELL_HOME;
afterEach(() => {
  if (previous === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previous;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("fingerprints use one persisted local key, so they survive a process restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "cache-diag-key-"));
  dirs.push(home);
  process.env.CODE_SHELL_HOME = home;
  // A fresh module instance stands for a fresh process.
  const first = await import(`./prompt-cache-diagnostics.ts?first=${Date.now()}`);
  const fingerprint = first.hashSystemPrompt("You are a helpful agent.");
  const key = readFileSync(join(home, "prompt-cache-diagnostics.key"));
  expect(key.length).toBe(32);
  expect(statSync(join(home, "prompt-cache-diagnostics.key")).mode & 0o077).toBe(0);
  const second = await import(`./prompt-cache-diagnostics.ts?second=${Date.now()}`);
  expect(second.hashSystemPrompt("You are a helpful agent.")).toBe(fingerprint);
  expect(second.hashSystemPrompt("Another prompt.")).not.toBe(fingerprint);
});
