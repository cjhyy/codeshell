import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHumansManifest, readCatalogFromDir, sourceToRepoKey } from "./catalog.js";

function seedRepo(root: string, manifest: unknown, humans: Record<string, unknown>): void {
  writeFileSync(join(root, "humans.json"), JSON.stringify(manifest));
  for (const [name, profile] of Object.entries(humans)) {
    mkdirSync(join(root, "humans", name), { recursive: true });
    writeFileSync(join(root, "humans", name, "profile.json"), JSON.stringify(profile));
  }
}

const validProfile = (name: string) => ({
  name,
  label: `Label ${name}`,
  basePreset: "general",
});

describe("sourceToRepoKey", () => {
  test("derives a stable, path-safe directory name", () => {
    expect(sourceToRepoKey("cjhyy/mimi-humans")).toBe("cjhyy-mimi-humans");
    expect(sourceToRepoKey("CJHYY/Mimi-Humans")).toBe("cjhyy-mimi-humans");
  });

  test("rejects anything that is not owner/repo", () => {
    for (const bad of ["../evil", "--flag", "owner", "a/b/c", "", "owner/repo;rm -rf /"]) {
      expect(() => sourceToRepoKey(bad)).toThrow();
    }
  });
});

describe("parseHumansManifest", () => {
  test("keeps only entries that name a human", () => {
    const parsed = parseHumansManifest(
      JSON.stringify({
        name: "mimi-humans",
        humans: [
          { name: "a", label: "A", description: "d", category: "design", tags: ["x"] },
          { label: "missing name" },
          "not an object",
        ],
      }),
    );
    expect(parsed.humans.map((h) => h.name)).toEqual(["a"]);
    expect(parsed.humans[0].tags).toEqual(["x"]);
  });

  test("tolerates a missing humans array rather than throwing", () => {
    expect(parseHumansManifest(JSON.stringify({ name: "x" })).humans).toEqual([]);
  });

  test("throws on malformed JSON so the caller can report a bad repo", () => {
    expect(() => parseHumansManifest("{ not json")).toThrow();
  });
});

describe("readCatalogFromDir", () => {
  test("reads each manifest entry's profile.json and validates it", () => {
    const root = mkdtempSync(join(tmpdir(), "dh-catalog-"));
    try {
      seedRepo(
        root,
        {
          name: "r",
          humans: [
            { name: "alpha", label: "Alpha" },
            { name: "beta", label: "Beta" },
          ],
        },
        { alpha: validProfile("alpha"), beta: validProfile("beta") },
      );
      const result = readCatalogFromDir(root, "cjhyy/mimi-humans");
      expect(result.entries.map((e) => e.profile.name)).toEqual(["alpha", "beta"]);
      expect(result.entries[0].sourceRepo).toBe("cjhyy/mimi-humans");
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a broken entry instead of failing the whole repo", () => {
    const root = mkdtempSync(join(tmpdir(), "dh-catalog-bad-"));
    try {
      seedRepo(
        root,
        {
          name: "r",
          humans: [
            { name: "good", label: "Good" },
            { name: "bad", label: "Bad" },
          ],
        },
        // `bad` has no basePreset → schema rejects it.
        { good: validProfile("good"), bad: { name: "bad", label: "Bad" } },
      );
      const result = readCatalogFromDir(root, "o/r");
      expect(result.entries.map((e) => e.profile.name)).toEqual(["good"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("bad");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a manifest entry whose name would escape the repo directory", () => {
    const root = mkdtempSync(join(tmpdir(), "dh-catalog-escape-"));
    try {
      seedRepo(root, { name: "r", humans: [{ name: "../../etc", label: "Escape" }] }, {});
      const result = readCatalogFromDir(root, "o/r");
      expect(result.entries).toEqual([]);
      expect(result.errors).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repo with no manifest yields an error, not a crash", () => {
    const root = mkdtempSync(join(tmpdir(), "dh-catalog-empty-"));
    try {
      const result = readCatalogFromDir(root, "o/r");
      expect(result.entries).toEqual([]);
      expect(result.errors).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects linked and oversized files from an untrusted cloned repo", () => {
    const root = mkdtempSync(join(tmpdir(), "dh-catalog-files-"));
    const outside = join(root, "outside.json");
    try {
      writeFileSync(outside, JSON.stringify({ humans: [] }));
      symlinkSync(outside, join(root, "humans.json"));
      expect(readCatalogFromDir(root, "o/r").errors.join(" ")).toContain("bounded regular file");

      rmSync(join(root, "humans.json"));
      seedRepo(
        root,
        { humans: [{ name: "large" }] },
        { large: validProfile("large") },
      );
      writeFileSync(join(root, "humans", "large", "profile.json"), "x".repeat(256 * 1024 + 1));
      const result = readCatalogFromDir(root, "o/r");
      expect(result.entries).toEqual([]);
      expect(result.errors.join(" ")).toContain("bounded regular file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("human repo registry", () => {
  test("round-trips repos and reads their entries, flagging duplicates", async () => {
    const home = mkdtempSync(join(tmpdir(), "dh-repo-home-"));
    const prev = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
    try {
      const { listHumanRepos, readAllHumanRepoEntries, humanRepoDir, removeHumanRepo } =
        await import("./catalog-store.js");

      expect(listHumanRepos()).toEqual([]);

      // Seed two "cloned" repos directly; cloning itself needs the network.
      for (const [repo, name] of [
        ["owner/one", "alpha"],
        ["owner/two", "alpha"],
      ] as const) {
        const dir = humanRepoDir(repo);
        mkdirSync(dir, { recursive: true });
        seedRepo(
          dir,
          { name: repo, humans: [{ name, label: name }] },
          { [name]: validProfile(name) },
        );
      }
      writeFileSync(
        join(home, "human-repos.json"),
        JSON.stringify({
          repos: [
            { repo: "owner/one", addedAt: 1 },
            { repo: "owner/two", addedAt: 2 },
          ],
        }),
      );

      const all = readAllHumanRepoEntries();
      // First registration wins; the clash is reported rather than silent.
      expect(all.entries).toHaveLength(1);
      expect(all.entries[0].sourceRepo).toBe("owner/one");
      expect(all.errors.join(" ")).toContain("owner/two");

      removeHumanRepo("owner/two");
      expect(listHumanRepos().map((r) => r.repo)).toEqual(["owner/one"]);
    } finally {
      if (prev === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("addHumanRepo error messages", () => {
  test("a missing repo yields a name hint, not a git command line", async () => {
    const home = mkdtempSync(join(tmpdir(), "dh-repo-err-"));
    const prev = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
    try {
      const { addHumanRepo } = await import("./catalog-store.js");
      const result = await addHumanRepo("cjhyy/definitely-not-a-real-repo-xyz");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The raw failure is `git clone --depth 1 --filter=blob:none … exited 128`.
      // Pasting argv into an "add a repo" box explains nothing.
      expect(result.error).not.toContain("git clone");
      expect(result.error).not.toContain("--filter=blob:none");
      expect(result.error).toContain("cjhyy/definitely-not-a-real-repo-xyz");
    } finally {
      if (prev === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("teams in a digital-human repo", () => {
  test("reads teams alongside humans", () => {
    const root = mkdtempSync(join(tmpdir(), "dh-catalog-teams-"));
    try {
      seedRepo(
        root,
        {
          name: "r",
          humans: [
            { name: "alpha", label: "Alpha" },
            { name: "beta", label: "Beta" },
          ],
          teams: [
            {
              id: "squad",
              name: "Squad",
              description: "two-person crew",
              members: ["alpha", "beta"],
              lead: "alpha",
              playbook: "alpha drafts, beta reviews",
            },
          ],
        },
        { alpha: validProfile("alpha"), beta: validProfile("beta") },
      );
      const result = readCatalogFromDir(root, "o/r");
      expect(result.teams).toHaveLength(1);
      expect(result.teams[0].id).toBe("squad");
      expect(result.teams[0].lead).toBe("alpha");
      expect(result.teams[0].playbook).toContain("alpha drafts");
      expect(result.teams[0].sourceRepo).toBe("o/r");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("drops a team whose members are not all in the repo", () => {
    const root = mkdtempSync(join(tmpdir(), "dh-catalog-teams-bad-"));
    try {
      seedRepo(
        root,
        {
          name: "r",
          humans: [{ name: "alpha", label: "Alpha" }],
          // `ghost` is not shipped here, so the team could never be summoned.
          teams: [{ id: "squad", name: "Squad", members: ["alpha", "ghost"] }],
        },
        { alpha: validProfile("alpha") },
      );
      const result = readCatalogFromDir(root, "o/r");
      expect(result.teams).toEqual([]);
      expect(result.errors.join(" ")).toContain("ghost");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("drops a team with a lead outside its own members", () => {
    const root = mkdtempSync(join(tmpdir(), "dh-catalog-teams-lead-"));
    try {
      seedRepo(
        root,
        {
          name: "r",
          humans: [
            { name: "alpha", label: "Alpha" },
            { name: "beta", label: "Beta" },
          ],
          teams: [{ id: "squad", name: "Squad", members: ["alpha", "beta"], lead: "alpha2" }],
        },
        { alpha: validProfile("alpha"), beta: validProfile("beta") },
      );
      const result = readCatalogFromDir(root, "o/r");
      expect(result.teams).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repo with no teams key is fine", () => {
    const root = mkdtempSync(join(tmpdir(), "dh-catalog-teams-none-"));
    try {
      seedRepo(
        root,
        { name: "r", humans: [{ name: "alpha", label: "Alpha" }] },
        {
          alpha: validProfile("alpha"),
        },
      );
      expect(readCatalogFromDir(root, "o/r").teams).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
