import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mobileAssetPath, mobileEntryRedirect, resolveSafe } from "./mobile-static";

test("mobileEntryRedirect canonicalizes the bare entry to a trailing slash", () => {
  // The pairing URL (/mobile?pairing=...) has no trailing slash → must redirect
  // to /mobile/ so the served HTML loads its /mobile/-based assets correctly.
  expect(mobileEntryRedirect("/mobile")).toBe("/mobile/");
  expect(mobileEntryRedirect("/mobile?pairing=tok")).toBe("/mobile/?pairing=tok");
  expect(mobileEntryRedirect("/mobile#frag")).toBe("/mobile/#frag");
});

test("mobileEntryRedirect leaves /mobile/ and sub-paths untouched", () => {
  // With vite base "/mobile/", all assets (prod + vite dev HMR/module URLs) are
  // /mobile-prefixed, so only the bare entry needs the trailing-slash redirect.
  expect(mobileEntryRedirect("/mobile/")).toBeNull();
  expect(mobileEntryRedirect("/mobile/?pairing=tok")).toBeNull();
  expect(mobileEntryRedirect("/mobile/assets/app.js")).toBeNull();
  // A sibling route that merely shares the prefix is not the mobile entry.
  expect(mobileEntryRedirect("/mobilexyz")).toBeNull();
});

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mobile-static-"));
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("mobileAssetPath strips /mobile prefix + query", () => {
  expect(mobileAssetPath("/mobile")).toBe("");
  expect(mobileAssetPath("/mobile/")).toBe("");
  expect(mobileAssetPath("/mobile/assets/app.js")).toBe("assets/app.js");
  expect(mobileAssetPath("/mobile?pairing=tok")).toBe("");
  expect(mobileAssetPath("/mobile/assets/app.js?v=1")).toBe("assets/app.js");
});

test("resolveSafe maps empty path → index.html", () => {
  expect(resolveSafe(root, "")).toBe(join(root, "index.html"));
});

test("resolveSafe serves a real nested asset", () => {
  expect(resolveSafe(root, "assets/app.js")).toBe(join(root, "assets", "app.js"));
});

test("resolveSafe returns null for missing files", () => {
  expect(resolveSafe(root, "nope.js")).toBeNull();
});

test("resolveSafe rejects path traversal", () => {
  expect(resolveSafe(root, "../secret")).toBeNull();
  expect(resolveSafe(root, "../../etc/passwd")).toBeNull();
  expect(resolveSafe(root, "assets/../../escape")).toBeNull();
  expect(resolveSafe(root, "/etc/passwd")).toBeNull();
});
