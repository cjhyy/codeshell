/** Round 5 audit: ordinary catalog data semantics; only owned temporary files. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHumansManifest,
  readCatalogFromDir,
  sourceToRepoKey,
} from "../../../packages/core/src/profile/catalog.js";
import {
  humanRepoDir,
  listHumanRepoDetails,
  listHumanRepos,
  readAllHumanRepoEntries,
  removeHumanRepo,
} from "../../../packages/core/src/profile/catalog-store.js";

let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codeshell-profile-round5-"));
  previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function seed(repo: string, profileName: string) {
  const dir = humanRepoDir(repo);
  mkdirSync(join(dir, "humans", profileName), { recursive: true });
  writeFileSync(join(dir, "humans.json"), JSON.stringify({ humans: [{ name: profileName }] }));
  writeFileSync(
    join(dir, "humans", profileName, "profile.json"),
    JSON.stringify({ name: profileName, label: profileName, basePreset: "general" }),
  );
}

function register(repos: string[]) {
  writeFileSync(
    join(root, "human-repos.json"),
    JSON.stringify({ repos: repos.map((repo, index) => ({ repo, addedAt: index + 1 })) }),
  );
}

test("observed: hyphen placement collapses distinct sources and attributes the cached definition to the first source", () => {
  const first = "acme-labs/agents";
  const second = "acme/labs-agents";
  expect(first).not.toBe(second);
  expect(sourceToRepoKey(first)).toBe("acme-labs-agents");
  expect(sourceToRepoKey(second)).toBe("acme-labs-agents");
  expect(humanRepoDir(first)).toBe(humanRepoDir(second));

  // Seed the single shared cache with the second source's current tree. This is
  // a local reader fixture, not an execution of addHumanRepo or a simulated git.
  seed(second, "second-human");
  register([first, second]);

  expect(listHumanRepos().map((entry) => entry.repo)).toEqual([first, second]);
  expect(listHumanRepoDetails().map(({ repo, count, cloned }) => ({ repo, count, cloned }))).toEqual([
    { repo: first, count: 1, cloned: true },
    { repo: second, count: 1, cloned: true },
  ]);
  const all = readAllHumanRepoEntries();
  expect(all.entries.map(({ profile, sourceRepo }) => ({ name: profile.name, sourceRepo }))).toEqual([
    { name: "second-human", sourceRepo: first },
  ]);
  expect(all.errors).toEqual([
    '"second-human" 同时存在于 acme-labs/agents 与 acme/labs-agents，已采用前者',
  ]);
  console.log(JSON.stringify({ observation: "catalog-key-collision", first, second, key: sourceToRepoKey(first), entries: all.entries.map(({ profile, sourceRepo }) => ({ name: profile.name, sourceRepo })), errors: all.errors }));
});

test("observed: removing the second colliding source removes the first still-registered source's cached catalog", () => {
  const first = "acme-labs/agents";
  const second = "acme/labs-agents";
  seed(first, "first-human");
  register([first, second]);

  removeHumanRepo(second);

  expect(listHumanRepos().map((entry) => entry.repo)).toEqual([first]);
  expect(existsSync(humanRepoDir(first))).toBe(false);
  expect(listHumanRepoDetails()).toEqual([
    { repo: first, addedAt: 1, count: 0, errors: ["尚未克隆"], cloned: false },
  ]);
  console.log(JSON.stringify({ observation: "catalog-colliding-remove", remaining: listHumanRepoDetails() }));
});

test("control: distinct noncolliding sources retain independent caches and provenance after one removal", () => {
  const first = "acme/alpha";
  const second = "acme/beta";
  seed(first, "alpha-human");
  seed(second, "beta-human");
  register([first, second]);
  expect(humanRepoDir(first)).not.toBe(humanRepoDir(second));
  expect(readAllHumanRepoEntries().entries.map(({ profile, sourceRepo }) => ({ name: profile.name, sourceRepo }))).toEqual([
    { name: "alpha-human", sourceRepo: first },
    { name: "beta-human", sourceRepo: second },
  ]);
  removeHumanRepo(second);
  expect(existsSync(humanRepoDir(first))).toBe(true);
  expect(readAllHumanRepoEntries().entries.map((entry) => entry.profile.name)).toEqual(["alpha-human"]);
});

test("control: malformed individual catalog definitions are isolated and valid team members resolve within the same directory", () => {
  const repo = "acme/teams";
  seed(repo, "alpha");
  seed(repo, "beta");
  const dir = humanRepoDir(repo);
  mkdirSync(join(dir, "humans", "broken"), { recursive: true });
  writeFileSync(join(dir, "humans", "broken", "profile.json"), "{}");
  writeFileSync(join(dir, "humans.json"), JSON.stringify({
    humans: [{ name: "alpha" }, { name: "broken" }, { name: "beta" }],
    teams: [
      { id: "pair", name: "Pair", members: ["alpha", "beta"], lead: "alpha" },
      { id: "missing", name: "Missing", members: ["alpha", "ghost"] },
    ],
  }));
  const read = readCatalogFromDir(dir, repo);
  expect(read.entries.map((entry) => entry.profile.name)).toEqual(["alpha", "beta"]);
  expect(read.teams.map((team) => team.id)).toEqual(["pair"]);
  expect(read.errors).toHaveLength(2);
  expect(read.errors[0]).toContain('"broken" is invalid');
  expect(read.errors[1]).toContain('team "missing" references missing ghost');
  expect(parseHumansManifest('{"humans":[]}').teams).toEqual([]);
});
