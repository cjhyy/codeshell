import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import { createReusableSessionResolver } from "./reusable-session-resolver";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pet-resolver-"));
  roots.push(root);
  return root;
}

async function writeSession(
  root: string,
  sessionId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const dir = join(root, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("createReusableSessionResolver", () => {
  test("resolves a plain desktop work session by its selector", async () => {
    const root = makeRoot();
    await writeSession(root, "old-session", {
      parentSessionId: null,
      origin: "desktop",
      title: "old work",
      cwd: "/repo/a",
    });

    const resolve = createReusableSessionResolver(root);
    expect(await resolve(sessionSelectorId("old-session"))).toMatchObject({
      sessionId: "old-session",
      workspacePath: "/repo/a",
      title: "old work",
    });
  });

  test("rejects an archived session even though the disclosure catalog lists it", async () => {
    const root = makeRoot();
    // Same pool boundary as listReusableSessions: listDiskSessions hides rows
    // whose state.archivedAt is a number unless includeArchived is passed.
    await writeSession(root, "archived-session", {
      parentSessionId: null,
      origin: "desktop",
      title: "archived work",
      cwd: "/repo/a",
      archivedAt: 1_700_000_000_000,
    });

    const resolve = createReusableSessionResolver(root);
    expect(await resolve(sessionSelectorId("archived-session"))).toBeNull();
  });

  test("rejects sessions not created by this desktop, including legacy missing origin", async () => {
    const root = makeRoot();
    await writeSession(root, "tui-session", {
      parentSessionId: null,
      origin: "tui",
      title: "tui work",
      cwd: "/repo/a",
    });
    // Legacy state without an origin field is excluded from the in-list pool
    // (listDiskSessions skips missing origin), so the resolver must match.
    await writeSession(root, "legacy-session", {
      parentSessionId: null,
      title: "legacy work",
      cwd: "/repo/a",
    });

    const resolve = createReusableSessionResolver(root);
    expect(await resolve(sessionSelectorId("tui-session"))).toBeNull();
    expect(await resolve(sessionSelectorId("legacy-session"))).toBeNull();
  });

  test("returns null when no on-disk session matches the selector", async () => {
    const root = makeRoot();
    await writeSession(root, "old-session", {
      parentSessionId: null,
      origin: "desktop",
      title: "old work",
      cwd: "/repo/a",
    });

    const resolve = createReusableSessionResolver(root);
    expect(await resolve(sessionSelectorId("never-existed"))).toBeNull();
  });
});
