// Regression (PROFILE-R5-01): the cache key used to lowercase `owner/repo` and
// replace the slash with "-", which already occurs inside both names, so
// `acme-labs/agents` and `acme/labs-agents` shared one cache directory and
// removing one deleted the other's catalog. Caches written under that legacy
// key must stay readable and must only be removed for the source they belong to.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testables,
  humanRepoDir,
  humanReposRoot,
  listHumanRepoDetails,
  listHumanRepos,
  readAllHumanRepoEntries,
  removeHumanRepo,
} from "./catalog-store.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-catalog-key-"));
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const FIRST = "acme-labs/agents";
const SECOND = "acme/labs-agents";
/** Directory both sources mapped to before the fix. */
const legacyDir = () => join(humanReposRoot(), "acme-labs-agents");

function seedTree(dir: string, human: string, origin?: string): void {
  mkdirSync(join(dir, "humans", human), { recursive: true });
  writeFileSync(join(dir, "humans.json"), JSON.stringify({ humans: [{ name: human }] }));
  writeFileSync(
    join(dir, "humans", human, "profile.json"),
    JSON.stringify({ name: human, label: human, basePreset: "general" }),
  );
  if (origin) {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(
      join(dir, ".git", "config"),
      `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/${origin}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
  }
}

function register(repos: string[]): void {
  writeFileSync(
    join(home, "human-repos.json"),
    JSON.stringify({ repos: repos.map((repo, index) => ({ repo, addedAt: index + 1 })) }),
  );
}

const provenance = () =>
  readAllHumanRepoEntries().entries.map(({ profile, sourceRepo }) => ({
    name: profile.name,
    sourceRepo,
  }));

describe("digital-human repo cache keys", () => {
  test("distinct sources get distinct caches and removing one keeps the other", () => {
    expect(humanRepoDir(FIRST)).not.toBe(humanRepoDir(SECOND));
    expect(humanRepoDir("Acme/Labs-Agents")).toBe(humanRepoDir(SECOND));
    seedTree(humanRepoDir(FIRST), "first-human");
    seedTree(humanRepoDir(SECOND), "second-human");
    register([FIRST, SECOND]);

    expect(provenance()).toEqual([
      { name: "first-human", sourceRepo: FIRST },
      { name: "second-human", sourceRepo: SECOND },
    ]);

    removeHumanRepo(SECOND);

    expect(listHumanRepos().map((entry) => entry.repo)).toEqual([FIRST]);
    expect(existsSync(humanRepoDir(FIRST))).toBe(true);
    expect(provenance()).toEqual([{ name: "first-human", sourceRepo: FIRST }]);
  });
});

describe("legacy digital-human repo caches", () => {
  test("a legacy cache of the only registered source stays readable and is removed with it", () => {
    seedTree(join(humanReposRoot(), "owner-repo"), "legacy-human");
    register(["owner/repo"]);

    expect(listHumanRepoDetails()).toEqual([
      { repo: "owner/repo", addedAt: 1, count: 1, errors: [], cloned: true },
    ]);
    expect(provenance()).toEqual([{ name: "legacy-human", sourceRepo: "owner/repo" }]);

    removeHumanRepo("owner/repo");

    expect(existsSync(join(humanReposRoot(), "owner-repo"))).toBe(false);
  });

  test("a colliding legacy clone is attributed by its git origin only", () => {
    seedTree(legacyDir(), "second-human", SECOND);
    register([FIRST, SECOND]);

    expect(provenance()).toEqual([{ name: "second-human", sourceRepo: SECOND }]);
    expect(listHumanRepoDetails().map(({ repo, cloned }) => ({ repo, cloned }))).toEqual([
      { repo: FIRST, cloned: false },
      { repo: SECOND, cloned: true },
    ]);

    removeHumanRepo(FIRST);
    expect(existsSync(legacyDir())).toBe(true);
    expect(provenance()).toEqual([{ name: "second-human", sourceRepo: SECOND }]);

    removeHumanRepo(SECOND);
    expect(existsSync(legacyDir())).toBe(false);
  });

  test("an unattributable colliding legacy tree is neither read nor deleted", () => {
    seedTree(legacyDir(), "unknown-human");
    register([FIRST, SECOND]);

    expect(provenance()).toEqual([]);
    removeHumanRepo(FIRST);
    expect(existsSync(join(legacyDir(), "humans.json"))).toBe(true);
  });

  test("an update adopts the source's legacy cache into the current layout", () => {
    seedTree(legacyDir(), "second-human", SECOND);
    register([FIRST, SECOND]);

    __testables.adoptLegacyRepoDir(SECOND, listHumanRepos());

    expect(existsSync(legacyDir())).toBe(false);
    expect(existsSync(join(humanRepoDir(SECOND), "humans.json"))).toBe(true);
    expect(provenance()).toEqual([{ name: "second-human", sourceRepo: SECOND }]);
  });
});
