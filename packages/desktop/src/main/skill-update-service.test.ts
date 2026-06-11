/**
 * Tests for the GitHub skill update-check backend.
 *
 * The services use the global `fetch`. We stub `globalThis.fetch` per-test
 * to return a canned `{ sha }` for the commits endpoint and restore it
 * after. No real network is ever touched. The skill + sidecar live in a
 * temp dir which is removed in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkSkillUpdate,
  updateSkillFromSource,
  type SkillSourceMeta,
  type SkillUpdateDeps,
} from "./github-skill-service.js";
import { checkSkillUpdateEntry } from "./skill-update-entry.js";

const realFetch = globalThis.fetch;

let tmpDir: string;
let skillFile: string;

async function writeSidecar(meta: SkillSourceMeta): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, ".cs-skill-meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
}

function baseMeta(overrides: Partial<SkillSourceMeta> = {}): SkillSourceMeta {
  return {
    kind: "github",
    owner: "anthropics",
    repo: "skills",
    ref: "main",
    dirInRepo: "skills/foo",
    commit: "abc123def456",
    installedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Stub fetch to return a commits response with the given sha. */
function stubCommitSha(sha: string): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ sha }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-update-test-"));
  skillFile = path.join(tmpDir, "SKILL.md");
  await fs.writeFile(skillFile, "---\nname: foo\n---\nbody\n", "utf8");
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("checkSkillUpdate", () => {
  it("returns updateAvailable false when remote commit matches meta.commit", async () => {
    await writeSidecar(baseMeta({ commit: "abc123def456" }));
    stubCommitSha("abc123def456");

    const res = await checkSkillUpdate(skillFile);
    expect(res.updateAvailable).toBe(false);
    expect(res.currentCommit).toBe("abc123def456");
    expect(res.latestCommit).toBe("abc123def456");
  });

  it("returns updateAvailable true when remote commit differs", async () => {
    await writeSidecar(baseMeta({ commit: "old000000000" }));
    stubCommitSha("new111111111");

    const res = await checkSkillUpdate(skillFile);
    expect(res.updateAvailable).toBe(true);
    expect(res.currentCommit).toBe("old000000000");
    expect(res.latestCommit).toBe("new111111111");
  });

  it("returns updateAvailable false with a no-metadata reason when sidecar is missing", async () => {
    // No sidecar written — just the SKILL.md.
    const res = await checkSkillUpdate(skillFile);
    expect(res.updateAvailable).toBe(false);
    expect(res.reason).toMatch(/no source metadata/i);
  });

  it("returns updateAvailable false preserving currentCommit when fetch fails", async () => {
    await writeSidecar(baseMeta({ commit: "abc123def456" }));
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const res = await checkSkillUpdate(skillFile);
    expect(res.updateAvailable).toBe(false);
    expect(res.currentCommit).toBe("abc123def456");
    expect(res.reason).toMatch(/network down/i);
  });

  it("returns updateAvailable false preserving currentCommit on a non-ok response", async () => {
    await writeSidecar(baseMeta({ commit: "abc123def456" }));
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as typeof fetch;

    const res = await checkSkillUpdate(skillFile);
    expect(res.updateAvailable).toBe(false);
    expect(res.currentCommit).toBe("abc123def456");
    expect(res.reason).toBeTruthy();
  });

  it("ignores non-github sidecar kinds", async () => {
    // @ts-expect-error — exercising a defensive runtime path with a bad kind.
    await writeSidecar(baseMeta({ kind: "local" }));
    stubCommitSha("whatever");

    const res = await checkSkillUpdate(skillFile);
    expect(res.updateAvailable).toBe(false);
  });
});

describe("updateSkillFromSource", () => {
  /** Build an injected deps pair: canned latest sha + a fake download that
   * writes a SKILL.md with the given body into the dest dir. */
  function makeDeps(
    latestSha: string,
    downloadBody: string,
    opts: { failDownload?: boolean } = {},
  ): SkillUpdateDeps {
    return {
      getRefCommit: async () => latestSha,
      downloadSkillTree: async (_info, _ref, _dirInRepo, destDir) => {
        if (opts.failDownload) throw new Error("download exploded");
        await fs.writeFile(
          path.join(destDir, "SKILL.md"),
          downloadBody,
          "utf8",
        );
      },
    };
  }

  async function readSidecar(): Promise<SkillSourceMeta> {
    const raw = await fs.readFile(
      path.join(tmpDir, ".cs-skill-meta.json"),
      "utf8",
    );
    return JSON.parse(raw) as SkillSourceMeta;
  }

  it("does nothing and reports up-to-date when remote sha matches", async () => {
    await writeSidecar(baseMeta({ commit: "samesha000" }));
    let downloaded = false;
    const deps: SkillUpdateDeps = {
      getRefCommit: async () => "SAMESHA000", // case-insensitive match
      downloadSkillTree: async () => {
        downloaded = true;
      },
    };

    const res = await updateSkillFromSource(skillFile, deps);
    expect(res).toEqual({ updated: false, reason: "already up to date" });
    expect(downloaded).toBe(false);
    // SKILL.md + sidecar untouched.
    expect(await fs.readFile(skillFile, "utf8")).toBe(
      "---\nname: foo\n---\nbody\n",
    );
    expect((await readSidecar()).commit).toBe("samesha000");
  });

  it("replaces the skill and rewrites the sidecar when remote differs", async () => {
    await writeSidecar(baseMeta({ commit: "oldsha111" }));
    const deps = makeDeps("newsha222", "---\nname: foo\n---\nUPDATED\n");

    const res = await updateSkillFromSource(skillFile, deps);
    expect(res).toEqual({ updated: true, reason: "updated" });

    // New content is in place.
    expect(await fs.readFile(skillFile, "utf8")).toBe(
      "---\nname: foo\n---\nUPDATED\n",
    );
    // Sidecar carries the new commit, same owner/repo/ref/dirInRepo.
    const meta = await readSidecar();
    expect(meta.commit).toBe("newsha222");
    expect(meta.owner).toBe("anthropics");
    expect(meta.dirInRepo).toBe("skills/foo");
    // No leftover backup dir.
    const siblings = await fs.readdir(path.dirname(tmpDir));
    expect(siblings.some((n) => n.includes(".bak-"))).toBe(false);
  });

  it("rolls back atomically when the download fails, keeping the old skill", async () => {
    await writeSidecar(baseMeta({ commit: "oldsha111" }));
    const deps = makeDeps("newsha222", "", { failDownload: true });

    await expect(updateSkillFromSource(skillFile, deps)).rejects.toThrow();

    // Old SKILL.md + old sidecar intact.
    expect(await fs.readFile(skillFile, "utf8")).toBe(
      "---\nname: foo\n---\nbody\n",
    );
    expect((await readSidecar()).commit).toBe("oldsha111");
  });

  it("rolls back and reports the old version was kept when the swap fails", async () => {
    await writeSidecar(baseMeta({ commit: "oldsha111" }));
    // Download succeeds but produces no SKILL.md → the post-download verify
    // throws, exercising the rollback path with a partial swap risk.
    const deps: SkillUpdateDeps = {
      getRefCommit: async () => "newsha222",
      downloadSkillTree: async (_info, _ref, _dirInRepo, destDir) => {
        await fs.writeFile(path.join(destDir, "OTHER.md"), "x", "utf8");
      },
    };

    await expect(updateSkillFromSource(skillFile, deps)).rejects.toThrow(
      /SKILL\.md/,
    );

    // Old content intact (verify threw before any rename).
    expect(await fs.readFile(skillFile, "utf8")).toBe(
      "---\nname: foo\n---\nbody\n",
    );
    expect((await readSidecar()).commit).toBe("oldsha111");
  });

  it("rolls back with a kept/restored message when the copy step fails", async () => {
    await writeSidecar(baseMeta({ commit: "oldsha111" }));
    // Download writes SKILL.md fine, but we sabotage fs.cp so the swap fails
    // AFTER the live dir was renamed to backup — this is the true atomic path.
    const realCp = fs.cp;
    const deps = makeDeps("newsha222", "---\nname: foo\n---\nUPDATED\n");
    // @ts-expect-error — override for the test.
    fs.cp = async () => {
      throw new Error("copy exploded");
    };
    try {
      await expect(updateSkillFromSource(skillFile, deps)).rejects.toThrow(
        /restored|kept|保留/,
      );
    } finally {
      // @ts-expect-error — restore.
      fs.cp = realCp;
    }

    // Old dir restored from backup; content + sidecar intact.
    expect(await fs.readFile(skillFile, "utf8")).toBe(
      "---\nname: foo\n---\nbody\n",
    );
    expect((await readSidecar()).commit).toBe("oldsha111");
    const siblings = await fs.readdir(path.dirname(tmpDir));
    expect(siblings.some((n) => n.includes(".bak-"))).toBe(false);
  });

  it("returns no-metadata when the sidecar is missing", async () => {
    const deps = makeDeps("newsha222", "x");
    const res = await updateSkillFromSource(skillFile, deps);
    expect(res.updated).toBe(false);
    expect(res.reason).toMatch(/metadata/i);
  });

  it("returns not-a-github-skill for a foreign sidecar kind", async () => {
    // @ts-expect-error — defensive runtime path.
    await writeSidecar(baseMeta({ kind: "local" }));
    const deps = makeDeps("newsha222", "x");
    const res = await updateSkillFromSource(skillFile, deps);
    expect(res.updated).toBe(false);
    expect(res.reason).toMatch(/github/i);
  });
});

describe("checkSkillUpdateEntry", () => {
  it("never throws and returns a safe result on success", async () => {
    await writeSidecar(baseMeta({ commit: "abc123def456" }));
    stubCommitSha("abc123def456");

    const res = await checkSkillUpdateEntry(skillFile);
    expect(res.updateAvailable).toBe(false);
    expect(res.filePath).toBe(skillFile);
  });

  it("never throws even when given a bogus filePath", async () => {
    // Force checkSkillUpdate to blow up by passing a non-string filePath.
    const res = await checkSkillUpdateEntry(
      undefined as unknown as string,
    );
    expect(res.updateAvailable).toBe(false);
    expect(res.reason).toBeTruthy();
  });
});
