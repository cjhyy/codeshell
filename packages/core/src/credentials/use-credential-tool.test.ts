import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "./store.js";
import { setDefaultCredentialAccess, type CredentialAccess } from "./access.js";
import {
  useCredentialTool,
  useCredentialToolDef,
  useCredentialToolDefFor,
  __resetCredentialSessionAllowForTests,
} from "./use-credential-tool.js";
import type { ToolContext } from "../tool-system/context.js";

// Minimal ToolContext stub — tools tolerate most fields being absent.
function ctxWith(cwd: string, askResult?: string): ToolContext {
  return {
    cwd,
    sessionId: "test-session",
    askUser: askResult !== undefined ? async () => askResult : undefined,
  } as unknown as ToolContext;
}

function parse(s: string): Record<string, unknown> {
  return JSON.parse(s) as Record<string, unknown>;
}

describe("UseCredential tool", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-uc-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-uc-cwd-"));
    process.env.HOME = home;
    __resetCredentialSessionAllowForTests();
  });
  afterEach(() => {
    setDefaultCredentialAccess(null);
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("no id → masked list with type, no secret", async () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "figma", type: "token", label: "Figma", secret: "secretval" });
    const out = parse(await useCredentialTool({}, ctxWith(cwd, "允许本次")));
    expect(out.kind).toBe("list");
    const creds = out.credentials as { id: string; label: string; type: string }[];
    expect(creds).toEqual([{ id: "figma", label: "Figma", type: "token" }]);
    expect(JSON.stringify(out)).not.toContain("secretval");
  });

  test("id → token returns value (after approval)", async () => {
    new CredentialStore(cwd).save("user", {
      id: "figma",
      type: "token",
      label: "Figma",
      secret: "tok-123",
    });
    const out = parse(await useCredentialTool({ id: "figma" }, ctxWith(cwd, "允许本次")));
    expect(out).toEqual({ kind: "value", value: "tok-123" });
  });

  test("id → cookie writes a Netscape cookies.txt and returns its path", async () => {
    const jar = JSON.stringify([
      { name: "web_session", value: "abc", domain: ".xiaohongshu.com", secure: true, path: "/" },
    ]);
    new CredentialStore(cwd).save("user", {
      id: "xiaohongshu__accountA",
      type: "cookie",
      label: "账号A",
      secret: jar,
      meta: { platform: "xiaohongshu", domain: "xiaohongshu.com" },
    });
    const out = parse(
      await useCredentialTool({ id: "xiaohongshu__accountA" }, ctxWith(cwd, "允许本次")),
    );
    expect(out.kind).toBe("cookie");
    expect(out.count).toBe(1);
    const file = out.cookiesFile as string;
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("# Netscape HTTP Cookie File");
    expect(content).toContain("web_session");
    expect(content).toContain(".xiaohongshu.com");
    rmSync(file, { force: true });
  });

  test("denied approval → error result, no value leaked", async () => {
    new CredentialStore(cwd).save("user", {
      id: "figma",
      type: "token",
      label: "Figma",
      secret: "tok-123",
    });
    const out = parse(await useCredentialTool({ id: "figma" }, ctxWith(cwd, "拒绝")));
    expect(out.kind).toBe("error");
    expect(JSON.stringify(out)).not.toContain("tok-123");
  });

  test("headless (no askUser) and no autoApprove → no-ui error", async () => {
    new CredentialStore(cwd).save("user", {
      id: "figma",
      type: "token",
      label: "Figma",
      secret: "tok-123",
    });
    const out = parse(await useCredentialTool({ id: "figma" }, ctxWith(cwd))); // no ask
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("headless");
  });

  test("autoApprove=true skips prompt even headless", async () => {
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    writeFileSync(
      join(cwd, ".code-shell", "settings.json"),
      JSON.stringify({ credentialUse: { autoApprove: true } }),
    );
    new CredentialStore(cwd).save("user", {
      id: "figma",
      type: "token",
      label: "Figma",
      secret: "tok-123",
    });
    const out = parse(await useCredentialTool({ id: "figma" }, ctxWith(cwd))); // no ask
    expect(out).toEqual({ kind: "value", value: "tok-123" });
  });

  test("foreign safeStorage ciphertext is unavailable, never returned as a token", async () => {
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    writeFileSync(
      join(cwd, ".code-shell", "settings.json"),
      JSON.stringify({ credentialUse: { autoApprove: true } }),
    );
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [
          {
            id: "figma",
            type: "token",
            label: "Figma",
            secret: "enc:safeStorage:dG9rLTEyMw==",
            autoUseByAI: true,
          },
        ],
      }),
    );

    const out = parse(await useCredentialTool({ id: "figma" }, ctxWith(cwd)));
    expect(out.kind).toBe("error");
    expect(JSON.stringify(out)).not.toContain("enc:safeStorage");
  });

  test("host credential access resolves token plaintext without reading disk", async () => {
    const access: CredentialAccess = {
      listMasked: () => [
        { id: "figma", type: "token", label: "Figma", autoUseByAI: true, hasSecret: true },
      ],
      resolveMeta: () => ({
        id: "figma",
        type: "token",
        label: "Figma",
        autoUseByAI: true,
        hasSecret: true,
      }),
      envExposures: () => ({}),
      async resolveValue(req) {
        expect(req).toMatchObject({ cwd, id: "figma", scope: "full", purpose: "use" });
        return "tok-from-host";
      },
    };
    setDefaultCredentialAccess(access);

    const out = parse(await useCredentialTool({ id: "figma" }, ctxWith(cwd)));
    expect(out).toEqual({ kind: "value", value: "tok-from-host" });
  });

  test("host credential access materializes cookie without exposing jar secret to worker tool", async () => {
    const access: CredentialAccess = {
      listMasked: () => [
        { id: "xhs", type: "cookie", label: "XHS", autoUseByAI: true, hasSecret: true },
      ],
      resolveMeta: () => ({
        id: "xhs",
        type: "cookie",
        label: "XHS",
        autoUseByAI: true,
        hasSecret: true,
      }),
      envExposures: () => ({}),
      async materializeCookie(req) {
        expect(req).toMatchObject({ cwd, id: "xhs", scope: "full" });
        return { cookiesFile: "/tmp/host-cookies.txt", count: 2 };
      },
    };
    setDefaultCredentialAccess(access);

    const out = parse(await useCredentialTool({ id: "xhs" }, ctxWith(cwd)));
    expect(out).toEqual({ kind: "cookie", cookiesFile: "/tmp/host-cookies.txt", count: 2 });
  });

  test("missing id → friendly error", async () => {
    const out = parse(await useCredentialTool({ id: "nope" }, ctxWith(cwd, "允许本次")));
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("不存在");
  });

  test("empty cookie jar → guidance to re-pull", async () => {
    new CredentialStore(cwd).save("user", {
      id: "xhs__empty",
      type: "cookie",
      label: "空账号",
      secret: "[]",
      meta: { platform: "xhs", domain: "xiaohongshu.com" },
    });
    const out = parse(await useCredentialTool({ id: "xhs__empty" }, ctxWith(cwd, "允许本次")));
    expect(out.kind).toBe("error");
    expect(String(out.error)).toContain("重拓");
  });

  test("dynamic def lists available credentials; base when empty", () => {
    expect(useCredentialToolDefFor(cwd).description).toBe(useCredentialToolDef.description);
    new CredentialStore(cwd).save("user", {
      id: "figma",
      type: "token",
      label: "Figma",
      secret: "s",
    });
    const d = useCredentialToolDefFor(cwd).description;
    expect(d).toContain("figma (token)");
  });

  test("two cookie materializations of the same credential get distinct files (no clobber)", async () => {
    const jar = JSON.stringify([
      { name: "web_session", value: "abc", domain: ".xiaohongshu.com", secure: true, path: "/" },
    ]);
    new CredentialStore(cwd).save("user", {
      id: "xhs__accountA",
      type: "cookie",
      label: "账号A",
      secret: jar,
      meta: { platform: "xhs", domain: "xiaohongshu.com" },
    });
    const a = parse(await useCredentialTool({ id: "xhs__accountA" }, ctxWith(cwd, "允许本次")));
    const b = parse(await useCredentialTool({ id: "xhs__accountA" }, ctxWith(cwd, "允许本次")));
    expect(a.kind).toBe("cookie");
    expect(b.kind).toBe("cookie");
    // Same credential + same pid must NOT collide on one path.
    expect(a.cookiesFile).not.toBe(b.cookiesFile);
    expect(existsSync(a.cookiesFile as string)).toBe(true);
    expect(existsSync(b.cookiesFile as string)).toBe(true);
    rmSync(a.cookiesFile as string, { force: true });
    rmSync(b.cookiesFile as string, { force: true });
  });
});

describe("UseCredential session-allow isolation (no sessionId must not share)", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-uc-iso-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-uc-iso-cwd-"));
    process.env.HOME = home;
    __resetCredentialSessionAllowForTests();
  });
  afterEach(() => {
    setDefaultCredentialAccess(null);
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  // ctx with NO sessionId, and an ask that records how many times it was asked
  // and returns "本会话都允许" (session-remember) each time.
  function ctxNoSession(asks: { n: number }): ToolContext {
    return {
      cwd,
      askUser: async () => {
        asks.n++;
        return "本会话都允许";
      },
    } as unknown as ToolContext;
  }

  test("session-remember in one no-session context does NOT auto-approve a later no-session context", async () => {
    new CredentialStore(cwd).save("user", {
      id: "figma",
      type: "token",
      label: "Figma",
      secret: "tok-123",
    });

    const asks = { n: 0 };
    // First no-session call: user picks "本会话都允许".
    const out1 = parse(await useCredentialTool({ id: "figma" }, ctxNoSession(asks)));
    expect(out1).toEqual({ kind: "value", value: "tok-123" });
    expect(asks.n).toBe(1);

    // Second independent no-session call MUST be asked again — the prior
    // approval must NOT leak across contexts via a shared "__nosession__" bucket.
    const out2 = parse(await useCredentialTool({ id: "figma" }, ctxNoSession(asks)));
    expect(out2).toEqual({ kind: "value", value: "tok-123" });
    expect(asks.n).toBe(2);
  });
});
