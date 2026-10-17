import { expect, test } from "bun:test";
import { resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";

// parseSource is called directly. Its gitOps import is not allowed to spawn,
// clone, resolve a remote, install a plugin, or access an external service.
const deny = () => { throw new Error("owned source-parser audit forbids I/O execution"); };
globalThis.fetch = deny as any;
http.request = deny as any;
http.get = deny as any;
https.request = deny as any;
https.get = deny as any;
net.connect = deny as any;
net.createConnection = deny as any;
tls.connect = deny as any;
childProcess.spawn = deny as any;
childProcess.exec = deny as any;
childProcess.execFile = deny as any;
childProcess.execSync = deny as any;
childProcess.execFileSync = deny as any;

const { parseSource } = await import(
  "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/plugins/installer/parseSource.ts"
);

test("ordinary relative paths and paths with spaces remain local metadata", () => {
  expect(parseSource("./owned-plugin")).toEqual({ kind: "local", path: resolve("./owned-plugin") });
  expect(parseSource("./owned plugin")).toEqual({ kind: "local", path: resolve("./owned plugin") });
});

test("GitHub shorthand retains ordinary ref/subdir metadata and original source", () => {
  expect(parseSource("github:owned/repository@release#plugins/notes")).toEqual({
    kind: "remote", url: "https://github.com/owned/repository.git", ref: "release",
    subdir: "plugins/notes", raw: "github:owned/repository@release#plugins/notes", inferredName: "notes",
  });
});

test("npm exact versions normalize and scoped names infer the final package segment", () => {
  expect(parseSource("npm:@owned/notes@v1.2.3")).toEqual({
    kind: "npm", packageName: "@owned/notes", selector: "1.2.3", selectorKind: "exact",
    raw: "npm:@owned/notes@v1.2.3", inferredName: "notes",
  });
});

test("ordinary npm tags and omitted selectors remain distinct from exact versions", () => {
  expect(parseSource("npm:owned-notes@next.1")).toMatchObject({ selector: "next.1", selectorKind: "tag" });
  expect(parseSource("npm:owned-notes")).toMatchObject({ selector: "latest", selectorKind: "tag" });
});

test("documented SCP-style SSH metadata keeps its transport username separator", () => {
  expect(parseSource("git@example.invalid:owned/notes.git@release")).toEqual({
    kind: "remote", url: "git@example.invalid:owned/notes.git", ref: "release",
    raw: "git@example.invalid:owned/notes.git@release", inferredName: "notes",
  });
});

test("candidate observation: a trailing URL slash keeps .git in the inferred name", () => {
  const plain = parseSource("https://example.invalid/owned/notes.git");
  const trailing = parseSource("https://example.invalid/owned/notes.git/");
  expect(plain).toMatchObject({ kind: "remote", inferredName: "notes" });
  expect(trailing).toMatchObject({ kind: "remote", inferredName: "notes.git", url: "https://example.invalid/owned/notes.git/" });
});

test("candidate observation: an explicit .git in GitHub shorthand is appended again", () => {
  const plain = parseSource("github:owned/notes");
  const suffix = parseSource("github:owned/notes.git");
  expect(plain).toMatchObject({ url: "https://github.com/owned/notes.git", inferredName: "notes" });
  expect(suffix).toMatchObject({ url: "https://github.com/owned/notes.git.git", inferredName: "notes.git" });
});
