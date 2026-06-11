import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath } from "./path-policy.js";

// Regression for the sensitive-file over-match bug: the old patterns used
// bare substrings (/auth/i, /token/i, /credential/i, /secret/i) tested against
// the basename, so any SOURCE file whose name merely CONTAINED one of those
// words (authController.ts, token-counter.ts, oauth-handler.ts, …) was
// classified sensitive and had its WRITE denied — breaking the agent's core
// ability to edit ordinary code. Real credential FILES (credentials.json,
// secrets.yaml, .env, id_rsa, *.pem) must still be protected.

const dirs: string[] = [];
function tmpWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), "cs-sensfile-"));
  dirs.push(d);
  return d;
}
function cleanup() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

describe("classifyPath — sensitive-file matching is not a source-code substring", () => {
  test("ordinary source files containing auth/token/credential/secret are writable", () => {
    const ws = tmpWorkspace();
    const writableCode = [
      "authController.ts",
      "useAuth.tsx",
      "auth.ts",
      "refreshToken.ts",
      "token-counter.ts",
      "tokenizer.ts",
      "oauth-handler.ts",
      "credentials.service.ts",
      "secretSanta.js",
      "AuthProvider.tsx",
    ];
    for (const name of writableCode) {
      const c = classifyPath(join(ws, name), { workspaceRoot: ws, operation: "write" });
      expect(c.decision).toBe("allow"); // in-workspace, not a real secret file
    }
    cleanup();
  });

  test("real credential/secret artifact files are still write-denied", () => {
    const ws = tmpWorkspace();
    const protectedFiles = [
      ".env",
      ".env.local",
      ".env.production",
      "id_rsa",
      "id_ed25519",
      "server.pem",
      "cert.p12",
      "store.pfx",
      "credentials.json",
      "secrets.yaml",
      "secrets.yml",
      "auth.json",
      "token.json",
    ];
    for (const name of protectedFiles) {
      const c = classifyPath(join(ws, name), { workspaceRoot: ws, operation: "write" });
      expect(c.decision).toBe("deny"); // genuine secret-bearing file
    }
    cleanup();
  });

  test("real credential files ask (not allow) on read even inside workspace", () => {
    const ws = tmpWorkspace();
    for (const name of ["credentials.json", ".env", "secrets.yaml"]) {
      const c = classifyPath(join(ws, name), { workspaceRoot: ws, operation: "read" });
      expect(c.decision).toBe("ask");
    }
    cleanup();
  });

  test("source files containing the words are readable without prompting", () => {
    const ws = tmpWorkspace();
    for (const name of ["auth.ts", "token-counter.ts", "credentials.service.ts"]) {
      const c = classifyPath(join(ws, name), { workspaceRoot: ws, operation: "read" });
      expect(c.decision).toBe("allow");
    }
    cleanup();
  });
});
