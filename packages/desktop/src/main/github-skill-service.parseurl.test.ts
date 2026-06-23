import { describe, test, expect } from "bun:test";
import { parseGithubUrl } from "./github-skill-service.js";

/**
 * parseGithubUrl is the entry point for user-pasted GitHub URLs (skill install).
 * Pure (no network), so its branches are cheaply pinned here. Covers the happy
 * shapes plus the reject paths a fat-fingered / hostile paste hits — none of
 * which may throw a raw error (they throw friendly Chinese messages the IPC
 * layer surfaces; a malformed URL must NOT escape as a raw TypeError).
 */
describe("parseGithubUrl", () => {
  test("plain repo URL", () => {
    expect(parseGithubUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: undefined,
      subpath: undefined,
    });
  });

  test("strips a trailing .git", () => {
    expect(parseGithubUrl("https://github.com/o/r.git").repo).toBe("r");
  });

  test("/tree/<ref>/<subpath> captures ref + subpath", () => {
    expect(parseGithubUrl("https://github.com/o/r/tree/main/skills/foo")).toEqual({
      owner: "o",
      repo: "r",
      ref: "main",
      subpath: "skills/foo",
    });
  });

  test("trims whitespace and tolerates trailing slashes", () => {
    expect(parseGithubUrl("  https://github.com/o/r/  ").owner).toBe("o");
  });

  test("rejects a non-github host with a friendly message (not raw error)", () => {
    expect(() => parseGithubUrl("https://gitlab.com/o/r")).toThrow(/github\.com/);
  });

  test("rejects a malformed URL with a friendly message (no raw TypeError escapes)", () => {
    expect(() => parseGithubUrl("not a url")).toThrow(/有效的 URL/);
  });

  test("rejects empty input", () => {
    expect(() => parseGithubUrl("")).toThrow(/不能为空/);
  });

  test("rejects a URL missing owner/repo", () => {
    expect(() => parseGithubUrl("https://github.com/onlyowner")).toThrow(/owner\/repo/);
  });

  test("rejects an unsupported marker (e.g. /releases/)", () => {
    expect(() => parseGithubUrl("https://github.com/o/r/releases/tag/v1")).toThrow(/不支持/);
  });
});
