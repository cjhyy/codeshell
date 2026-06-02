import { describe, it, expect } from "bun:test";
import { normalizeCwd, matchRepoIdForCwd, isCaseInsensitivePlatform, isNoRepoCwd } from "./pathMatch";

describe("isNoRepoCwd", () => {
  it("treats the internal no-repo sandbox dir as no-project (chat)", () => {
    expect(isNoRepoCwd("/Users/admin/.code-shell/no-repo")).toBe(true);
    expect(isNoRepoCwd("/Users/admin/.code-shell/no-repo/")).toBe(true); // trailing slash
    expect(isNoRepoCwd("/home/x/.code-shell/no-repo")).toBe(true); // any home
  });
  it("treats empty/missing cwd as no-project", () => {
    expect(isNoRepoCwd("")).toBe(true);
    expect(isNoRepoCwd(undefined as unknown as string)).toBe(true);
  });
  it("does NOT match a real project that merely contains the substring", () => {
    expect(isNoRepoCwd("/Users/admin/Documents/codeshell")).toBe(false);
    expect(isNoRepoCwd("/Users/admin/.code-shell/no-repo-clone")).toBe(false); // not the exact dir
  });
});

const repos = [
  { id: "r1", name: "alpha", path: "/Users/me/alpha" },
  { id: "r2", name: "beta", path: "/Users/me/beta/" },
];

describe("normalizeCwd", () => {
  it("strips trailing slash", () => {
    expect(normalizeCwd("/a/b/", false)).toBe("/a/b");
    expect(normalizeCwd("/a/b", false)).toBe("/a/b");
  });
  it("lowercases when case-insensitive", () => {
    expect(normalizeCwd("/A/B", true)).toBe("/a/b");
  });
  it("keeps a bare root", () => {
    expect(normalizeCwd("/", false)).toBe("/");
  });
});

describe("matchRepoIdForCwd", () => {
  it("matches exact path", () => {
    expect(matchRepoIdForCwd("/Users/me/alpha", repos, false)).toBe("r1");
  });
  it("matches despite trailing slash on either side", () => {
    expect(matchRepoIdForCwd("/Users/me/beta", repos, false)).toBe("r2");
    expect(matchRepoIdForCwd("/Users/me/alpha/", repos, false)).toBe("r1");
  });
  it("matches case-insensitively when requested", () => {
    expect(matchRepoIdForCwd("/users/me/ALPHA", repos, true)).toBe("r1");
  });
  it("returns null on no match", () => {
    expect(matchRepoIdForCwd("/somewhere/else", repos, false)).toBeNull();
  });
});

describe("isCaseInsensitivePlatform", () => {
  it("defaults to insensitive when navigator.platform is unavailable", () => {
    // In the bun test environment navigator is undefined → safe default true.
    expect(isCaseInsensitivePlatform()).toBe(true);
  });
});
