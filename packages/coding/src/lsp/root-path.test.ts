import { describe, test, expect } from "bun:test";
import { pathToFileURL } from "node:url";
import { rootUriToPath } from "./root-path.js";

// Regression: LSPServerManager derived the workspace path with
// `rootUri.replace("file://", "")` (review-2026-05-30, high). That only strips
// the first "file://" and mangles Windows URLs: file:///C:/x → /C:/x (invalid).
// fileURLToPath handles platform paths and percent-decoding correctly.

describe("coding rootUriToPath", () => {
  test("round-trips a posix path through file:// URL", () => {
    const p = "/Users/me/proj";
    expect(rootUriToPath(pathToFileURL(p).href)).toBe(p);
  });

  test("decodes percent-encoded spaces (replace() would leave %20)", () => {
    const p = "/Users/me/my project";
    const uri = pathToFileURL(p).href; // .../my%20project
    expect(uri).toContain("%20");
    expect(rootUriToPath(uri)).toBe(p);
  });

  test("differs from the naive replace() on a percent-encoded path", () => {
    // The concrete bug the fix removes (verifiable on any platform): naive
    // replace() leaves %20 in the path, fileURLToPath decodes it.
    const p = "/Users/me/a b/proj";
    const uri = pathToFileURL(p).href;
    const naive = uri.replace("file://", "");
    expect(naive).toContain("%20"); // buggy: still encoded
    expect(rootUriToPath(uri)).toBe(p); // fixed: decoded, equals original
    expect(rootUriToPath(uri)).not.toBe(naive);
  });
});
