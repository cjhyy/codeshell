import { describe, it, expect } from "bun:test";
import {
  parseMarketplaceInput,
  deriveMarketplaceName,
} from "../packages/core/src/plugins/parseMarketplaceInput.js";

describe("parseMarketplaceInput", () => {
  it("github shorthand owner/repo", () => {
    expect(parseMarketplaceInput("anthropics/skills")).toEqual({
      source: "github",
      repo: "anthropics/skills",
    });
  });

  it("github shorthand strips .git", () => {
    expect(parseMarketplaceInput("anthropics/skills.git")).toEqual({
      source: "github",
      repo: "anthropics/skills",
    });
  });

  it("https github url adds .git when missing", () => {
    expect(parseMarketplaceInput("https://github.com/anthropics/skills")).toEqual({
      source: "git",
      url: "https://github.com/anthropics/skills.git",
    });
  });

  it("https github url preserves .git suffix", () => {
    expect(parseMarketplaceInput("https://github.com/anthropics/skills.git")).toEqual({
      source: "git",
      url: "https://github.com/anthropics/skills.git",
    });
  });

  it("https non-github with .git is accepted", () => {
    expect(parseMarketplaceInput("https://gitlab.com/group/repo.git")).toEqual({
      source: "git",
      url: "https://gitlab.com/group/repo.git",
    });
  });

  it("https non-github without .git is rejected", () => {
    expect(parseMarketplaceInput("https://example.com/something")).toBeNull();
  });

  it("ssh git@host:owner/repo.git", () => {
    expect(parseMarketplaceInput("git@github.com:anthropics/skills.git")).toEqual({
      source: "git",
      url: "git@github.com:anthropics/skills.git",
    });
  });

  it("ssh deploy@gitlab.com:group/project", () => {
    expect(parseMarketplaceInput("deploy@gitlab.com:group/project")).toEqual({
      source: "git",
      url: "deploy@gitlab.com:group/project",
    });
  });

  it("blank input is null", () => {
    expect(parseMarketplaceInput("   ")).toBeNull();
  });

  it("single path segment is null", () => {
    expect(parseMarketplaceInput("anthropics")).toBeNull();
  });

  it("too many slashes is null", () => {
    expect(parseMarketplaceInput("a/b/c")).toBeNull();
  });

  it("malformed https returns null", () => {
    expect(parseMarketplaceInput("https://not a url at all")).toBeNull();
  });
});

describe("deriveMarketplaceName", () => {
  it("github source uses repo last segment", () => {
    expect(deriveMarketplaceName({ source: "github", repo: "anthropics/skills" })).toBe("skills");
  });

  it("github source lowercases", () => {
    expect(deriveMarketplaceName({ source: "github", repo: "Anthropics/Skills" })).toBe("skills");
  });

  it("git https url last segment without .git", () => {
    expect(
      deriveMarketplaceName({ source: "git", url: "https://github.com/anthropics/skills.git" }),
    ).toBe("skills");
  });

  it("git ssh url last segment", () => {
    expect(
      deriveMarketplaceName({ source: "git", url: "git@github.com:anthropics/skills.git" }),
    ).toBe("skills");
  });

  it("git url without .git", () => {
    expect(deriveMarketplaceName({ source: "git", url: "https://example.com/foo/bar" })).toBe(
      "bar",
    );
  });
});

describe("parseMarketplaceInput - local path", () => {
  it("accepts an absolute path ending in .git", () => {
    expect(parseMarketplaceInput("/tmp/fixture/src.git")).toEqual({
      source: "git",
      url: "/tmp/fixture/src.git",
    });
  });

  it("rejects an absolute path without .git suffix", () => {
    expect(parseMarketplaceInput("/tmp/fixture/src")).toBeNull();
  });

  it("rejects a relative path even with .git", () => {
    expect(parseMarketplaceInput("./repo.git")).toBeNull();
  });

  it("Windows-style absolute paths with .git", () => {
    expect(parseMarketplaceInput("C:\\repo.git")).toEqual({
      source: "git",
      url: "C:\\repo.git",
    });
  });
});

describe("deriveMarketplaceName - local path", () => {
  it("derives name from /abs/path/to/repo.git", () => {
    expect(
      deriveMarketplaceName({ source: "git", url: "/tmp/fixture/src.git" }),
    ).toBe("src");
  });
});
