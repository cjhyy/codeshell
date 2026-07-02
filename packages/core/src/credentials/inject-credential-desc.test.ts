import { describe, test, expect } from "bun:test";
import { injectCredentialToolDef } from "./inject-credential-tool.js";

/**
 * The model was over-eagerly injecting cookies just to open a site (e.g. "open
 * 小红书" → it logged in unprompted). The tool description MUST state, up front,
 * that injection only happens when the user explicitly wants to act as a
 * logged-in account — plain navigating/browsing must NOT trigger it. Pin that
 * boundary so it can't silently regress.
 */
describe("InjectCredential description states the when-NOT-to boundary", () => {
  const desc = injectCredentialToolDef.description;

  test("mentions it must be explicitly requested / not for plain browsing", () => {
    // Must carry an explicit negative-scope signal.
    expect(desc).toMatch(/only when|do not|don't|不要|仅当|明确/i);
    // Must reference the "just navigating/opening a page" case it should skip.
    expect(desc.toLowerCase()).toMatch(/navigat|open|browse|浏览|打开/);
  });

  test("still explains it restores login state via cookies (unchanged core meaning)", () => {
    expect(desc.toLowerCase()).toContain("cookie");
    expect(desc.toLowerCase()).toContain("login");
  });
});
