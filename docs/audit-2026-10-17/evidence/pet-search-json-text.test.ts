import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchSessionTranscripts } from "../../../packages/pet/src/disclosure/search";

async function withSession(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "codeshell-pet-search-audit-"));
  try {
    const directory = join(root, "ordinary-session");
    await mkdir(directory);
    await writeFile(join(directory, "state.json"), JSON.stringify({ kind: "work", title: "Searchable code conversation", cwd: "/fixture/repo" }));
    const content = 'Use console.log("hello") and file C:\\work\\notes.txt';
    await writeFile(join(directory, "transcript.jsonl"), JSON.stringify({ id: "message-1", type: "message", timestamp: 1000, turnNumber: 0, data: { role: "user", content } }) + "\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Pet disclosure raw JSON prefilter rejects valid quoted code query", async () => {
  await withSession(async root => {
    const query = 'console.log("hello")';
    const result = await searchSessionTranscripts(root, query, {});
    expect(result.scannedSessions).toBe(1);
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
    console.log(JSON.stringify({ observation: "quoted-content-search-false-negative", query, result }));
  });
});

test("Pet disclosure raw JSON prefilter rejects valid path with backslashes", async () => {
  await withSession(async root => {
    const query = "C:\\work\\notes.txt";
    const result = await searchSessionTranscripts(root, query, {});
    expect(result.matches).toEqual([]);
    console.log(JSON.stringify({ observation: "backslash-content-search-false-negative", query, result }));
  });
});

test("Pet disclosure plain substring normal control locates decoded message", async () => {
  await withSession(async root => {
    const result = await searchSessionTranscripts(root, "hello", {});
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.sessionId).toBe("ordinary-session");
    expect(result.matches[0]?.snippets[0]?.text).toContain('console.log("hello")');
  });
});
