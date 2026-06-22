import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "./store.js";
import {
  injectCredentialTool,
  isInjectCredentialAvailable,
  __resetInjectCredentialSessionAllowForTests,
} from "./inject-credential-tool.js";
import type { ToolContext } from "../tool-system/context.js";

/**
 * InjectCredential gates a cookie injection into the built-in browser behind a
 * per-credential approval (autoInjectByAI), refuses non-cookie credentials and
 * headless environments, and is only visible when a cookie credential exists.
 * Previously only covered indirectly via use-gate.test.ts — these pin the
 * tool's own contract (approval / refusals / availability).
 */

type InjectArgs = { credentialToBrowser?: (id: string) => Promise<{ ok: boolean; count?: number; error?: string }> };

function ctxWith(
  cwd: string,
  opts: { askResult?: string; inject?: InjectArgs["credentialToBrowser"]; sessionId?: string } = {},
): ToolContext {
  return {
    cwd,
    sessionId: opts.sessionId ?? "test-session",
    askUser: opts.askResult !== undefined ? async () => opts.askResult! : undefined,
    injectCredentialToBrowser: opts.inject,
  } as unknown as ToolContext;
}

function parse(s: string): Record<string, unknown> {
  return JSON.parse(s) as Record<string, unknown>;
}

function saveCookie(cwd: string, id: string, extra: Record<string, unknown> = {}): void {
  new CredentialStore(cwd).save("user", {
    id,
    type: "cookie",
    label: id,
    secret: JSON.stringify([{ name: "SID", value: "x", domain: ".example.com" }]),
    ...extra,
  });
}

describe("InjectCredential tool", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-ic-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-ic-cwd-"));
    process.env.HOME = home;
    __resetInjectCredentialSessionAllowForTests();
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("missing id → error", async () => {
    const out = parse(await injectCredentialTool({}, ctxWith(cwd, { inject: async () => ({ ok: true }) })));
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("id");
  });

  test("no host inject callback (headless) → error, never resolves the store", async () => {
    saveCookie(cwd, "yt");
    const out = parse(await injectCredentialTool({ id: "yt" }, ctxWith(cwd, { askResult: "允许本次" })));
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("无内置浏览器");
  });

  test("non-cookie credential is refused (cannot inject a token into the browser)", async () => {
    new CredentialStore(cwd).save("user", { id: "tok", type: "token", label: "tok", secret: "s" });
    let injected = false;
    const out = parse(
      await injectCredentialTool(
        { id: "tok" },
        ctxWith(cwd, { askResult: "允许本次", inject: async () => { injected = true; return { ok: true }; } }),
      ),
    );
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("不是 cookie");
    expect(injected).toBe(false);
  });

  test("unknown id → error", async () => {
    const out = parse(
      await injectCredentialTool({ id: "ghost" }, ctxWith(cwd, { inject: async () => ({ ok: true }) })),
    );
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("凭证不存在");
  });

  test("approval granted → injects and reports count", async () => {
    saveCookie(cwd, "yt");
    let askedFor = "";
    const out = parse(
      await injectCredentialTool(
        { id: "yt", purpose: "resume login" },
        ctxWith(cwd, { askResult: "允许本次", inject: async (id) => { askedFor = id; return { ok: true, count: 7 }; } }),
      ),
    );
    expect(out).toEqual({ kind: "injected", count: 7 });
    expect(askedFor).toBe("yt");
  });

  test("user denies → no injection", async () => {
    saveCookie(cwd, "yt");
    let injected = false;
    const out = parse(
      await injectCredentialTool(
        { id: "yt" },
        ctxWith(cwd, { askResult: "拒绝", inject: async () => { injected = true; return { ok: true }; } }),
      ),
    );
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("拒绝");
    expect(injected).toBe(false);
  });

  test("autoInjectByAI credential skips the prompt entirely", async () => {
    saveCookie(cwd, "yt", { autoInjectByAI: true });
    let injected = false;
    // No askUser provided — if the gate consulted it this would be headless-denied.
    const out = parse(
      await injectCredentialTool(
        { id: "yt" },
        ctxWith(cwd, { inject: async () => { injected = true; return { ok: true, count: 3 }; } }),
      ),
    );
    expect(out).toEqual({ kind: "injected", count: 3 });
    expect(injected).toBe(true);
  });

  test("headless (no askUser) without auto-inject → no-ui error, no injection", async () => {
    saveCookie(cwd, "yt");
    let injected = false;
    const out = parse(
      await injectCredentialTool(
        { id: "yt" },
        ctxWith(cwd, { inject: async () => { injected = true; return { ok: true }; } }),
      ),
    );
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("无审批 UI");
    expect(injected).toBe(false);
  });

  test("host injection failure surfaces the host error", async () => {
    saveCookie(cwd, "yt");
    const out = parse(
      await injectCredentialTool(
        { id: "yt" },
        ctxWith(cwd, { askResult: "允许本次", inject: async () => ({ ok: false, error: "session locked" }) }),
      ),
    );
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("session locked");
  });

  describe("isInjectCredentialAvailable", () => {
    test("false when no cookie credential exists", () => {
      new CredentialStore(cwd).save("user", { id: "tok", type: "token", label: "tok", secret: "s" });
      expect(isInjectCredentialAvailable(cwd)).toBe(false);
    });
    test("true once a cookie credential exists", () => {
      saveCookie(cwd, "yt");
      expect(isInjectCredentialAvailable(cwd)).toBe(true);
    });
  });
});
