import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { parseSource } from "./parseSource.js";

describe("parseSource", () => {
  test("relative path → local, resolved", () => {
    expect(parseSource("./x")).toEqual({ kind: "local", path: resolve("./x") });
  });

  test("absolute path → local, kept", () => {
    expect(parseSource("/abs/path")).toEqual({ kind: "local", path: resolve("/abs/path") });
  });

  test("bare name → local, resolved", () => {
    expect(parseSource("x")).toEqual({ kind: "local", path: resolve("x") });
  });

  test("public npm exact version → immutable npm source", () => {
    expect(parseSource("npm:@acme/video-plugin@1.2.3")).toEqual({
      kind: "npm",
      packageName: "@acme/video-plugin",
      selector: "1.2.3",
      selectorKind: "exact",
      raw: "npm:@acme/video-plugin@1.2.3",
      inferredName: "video-plugin",
    });
  });

  test("public npm dist-tag and omitted selector are accepted", () => {
    expect(parseSource("npm:video-plugin@next")).toMatchObject({
      kind: "npm",
      packageName: "video-plugin",
      selector: "next",
      selectorKind: "tag",
    });
    expect(parseSource("npm:video-plugin")).toMatchObject({
      kind: "npm",
      selector: "latest",
      selectorKind: "tag",
    });
  });

  test("npm Phase A rejects ranges, URLs, malformed scoped names and empty selectors", () => {
    for (const source of [
      "npm:video-plugin@^1.0.0",
      "npm:video-plugin@1.x",
      "npm:video-plugin@",
      "npm:@acme@1.0.0",
      "npm:https://registry.npmjs.org/video-plugin",
    ]) {
      expect(() => parseSource(source)).toThrow();
    }
  });

  test("github:org/repo → remote https url, inferredName=repo", () => {
    expect(parseSource("github:org/repo")).toEqual({
      kind: "remote",
      url: "https://github.com/org/repo.git",
      raw: "github:org/repo",
      inferredName: "repo",
    });
  });

  test("github:org/repo@v1 → ref=v1", () => {
    expect(parseSource("github:org/repo@v1")).toEqual({
      kind: "remote",
      url: "https://github.com/org/repo.git",
      ref: "v1",
      raw: "github:org/repo@v1",
      inferredName: "repo",
    });
  });

  test("github:org/repo#plugins/foo → subdir + inferredName=foo", () => {
    expect(parseSource("github:org/repo#plugins/foo")).toEqual({
      kind: "remote",
      url: "https://github.com/org/repo.git",
      subdir: "plugins/foo",
      raw: "github:org/repo#plugins/foo",
      inferredName: "foo",
    });
  });

  test("github:org/repo@main#plugins/foo → ref + subdir", () => {
    expect(parseSource("github:org/repo@main#plugins/foo")).toEqual({
      kind: "remote",
      url: "https://github.com/org/repo.git",
      ref: "main",
      subdir: "plugins/foo",
      raw: "github:org/repo@main#plugins/foo",
      inferredName: "foo",
    });
  });

  test("full https → url kept, inferredName=repo", () => {
    expect(parseSource("https://github.com/org/repo.git")).toEqual({
      kind: "remote",
      url: "https://github.com/org/repo.git",
      raw: "https://github.com/org/repo.git",
      inferredName: "repo",
    });
  });

  test("https without .git → inferredName strips trailing segment", () => {
    expect(parseSource("https://github.com/org/repo")).toEqual({
      kind: "remote",
      url: "https://github.com/org/repo",
      raw: "https://github.com/org/repo",
      inferredName: "repo",
    });
  });

  test("ssh git@host:org/repo.git → remote, url kept, @ not treated as ref", () => {
    expect(parseSource("git@github.com:org/repo.git")).toEqual({
      kind: "remote",
      url: "git@github.com:org/repo.git",
      raw: "git@github.com:org/repo.git",
      inferredName: "repo",
    });
  });

  test("ssh with @ref → ref split off, ssh @ kept in url", () => {
    expect(parseSource("git@github.com:org/repo.git@v2")).toEqual({
      kind: "remote",
      url: "git@github.com:org/repo.git",
      ref: "v2",
      raw: "git@github.com:org/repo.git@v2",
      inferredName: "repo",
    });
  });

  test("rejects insecure remote transports by default", () => {
    expect(() => parseSource("http://example.com/org/repo.git")).toThrow(
      /unsafe plugin source transport/i,
    );
    expect(() => parseSource("git://example.com/org/repo.git")).toThrow(
      /unsafe plugin source transport/i,
    );
    expect(() => parseSource("file:///tmp/repo")).toThrow(/unsafe plugin source transport/i);
  });

  test("rejects unsafe URL schemes case-insensitively", () => {
    expect(() => parseSource("HTTP://example.com/org/repo.git")).toThrow(
      /unsafe plugin source transport 'http:\/\/'/i,
    );
    expect(() => parseSource("FILE:///tmp/repo")).toThrow(
      /unsafe plugin source transport 'file:\/\/'/i,
    );
    expect(() => parseSource("Git+SSH://example.com/org/repo.git")).toThrow(
      /unsafe plugin source transport 'git\+ssh:\/\/'/i,
    );
  });

  test("allows insecure remote transports only with explicit opt-in", () => {
    expect(parseSource("http://example.com/org/repo.git", { allowUnsafeTransport: true })).toEqual({
      kind: "remote",
      url: "http://example.com/org/repo.git",
      raw: "http://example.com/org/repo.git",
      inferredName: "repo",
    });
  });
});
