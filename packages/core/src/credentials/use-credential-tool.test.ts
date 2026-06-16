import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "./store.js";
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
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("no id → masked list with type, no secret", async () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "figma", type: "token", label: "Figma", secret: "secretval" });
    const out = parse(await useCredentialTool({}, ctxWith(cwd, "允许本次")));
    expect(out.kind).toBe("list");
    const creds = out.credentials as { id: string; type: string }[];
    expect(creds).toEqual([{ id: "figma", label: "Figma", type: "token" }]);
    expect(JSON.stringify(out)).not.toContain("secretval");
  });

  test("id → token returns value (after approval)", async () => {
    new CredentialStore(cwd).save("user", { id: "figma", type: "token", label: "Figma", secret: "tok-123" });
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
    const out = parse(await useCredentialTool({ id: "xiaohongshu__accountA" }, ctxWith(cwd, "允许本次")));
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
    new CredentialStore(cwd).save("user", { id: "figma", type: "token", label: "Figma", secret: "tok-123" });
    const out = parse(await useCredentialTool({ id: "figma" }, ctxWith(cwd, "拒绝")));
    expect(out.kind).toBe("error");
    expect(JSON.stringify(out)).not.toContain("tok-123");
  });

  test("headless (no askUser) and no autoApprove → no-ui error", async () => {
    new CredentialStore(cwd).save("user", { id: "figma", type: "token", label: "Figma", secret: "tok-123" });
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
    new CredentialStore(cwd).save("user", { id: "figma", type: "token", label: "Figma", secret: "tok-123" });
    const out = parse(await useCredentialTool({ id: "figma" }, ctxWith(cwd))); // no ask
    expect(out).toEqual({ kind: "value", value: "tok-123" });
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
    new CredentialStore(cwd).save("user", { id: "figma", type: "token", label: "Figma", secret: "s" });
    const d = useCredentialToolDefFor(cwd).description;
    expect(d).toContain("figma (token)");
  });
});
