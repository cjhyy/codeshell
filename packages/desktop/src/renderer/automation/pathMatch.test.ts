import { describe, it, expect } from "bun:test";
import {
  normalizeCwd,
  matchProjectIdForCwd,
  isCaseInsensitivePlatform,
  isNoRepoCwd,
} from "./pathMatch";

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
  it("treats ephemeral/temp dirs as no-project (test/tool scratch, never a real project)", () => {
    expect(isNoRepoCwd("/tmp/claude-501/rm-usage-2-mGU6oL")).toBe(true);
    expect(isNoRepoCwd("/private/tmp/x")).toBe(true);
    expect(isNoRepoCwd("/var/folders/1d/abc/T/rm-usage-4-aDF2GO")).toBe(true);
    expect(isNoRepoCwd("/private/var/folders/1d/abc/T/codeshell-sandbox-xyz")).toBe(true);
  });
  it("does NOT match a real project that merely contains the substring", () => {
    expect(isNoRepoCwd("/Users/admin/Documents/codeshell")).toBe(false);
    expect(isNoRepoCwd("/Users/admin/.code-shell/no-repo-clone")).toBe(false); // not the exact dir
    expect(isNoRepoCwd("/Users/admin/Documents/tmp-project")).toBe(false); // not under /tmp
    expect(isNoRepoCwd("/Users/admin/Documents/var/app")).toBe(false); // not /var/folders
  });
});

const projects = [
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

describe("matchProjectIdForCwd", () => {
  it("matches exact path", () => {
    expect(matchProjectIdForCwd("/Users/me/alpha", projects, false)).toBe("r1");
  });
  it("matches despite trailing slash on either side", () => {
    expect(matchProjectIdForCwd("/Users/me/beta", projects, false)).toBe("r2");
    expect(matchProjectIdForCwd("/Users/me/alpha/", projects, false)).toBe("r1");
  });
  it("matches case-insensitively when requested", () => {
    expect(matchProjectIdForCwd("/users/me/ALPHA", projects, true)).toBe("r1");
  });
  it("returns null on no match", () => {
    expect(matchProjectIdForCwd("/somewhere/else", projects, false)).toBeNull();
  });
});

describe("isCaseInsensitivePlatform", () => {
  it("defaults to insensitive when navigator.platform is unavailable", () => {
    // In the bun test environment navigator is undefined → safe default true.
    expect(isCaseInsensitivePlatform()).toBe(true);
  });
});
