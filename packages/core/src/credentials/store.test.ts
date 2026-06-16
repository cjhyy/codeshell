import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "./store.js";

describe("CredentialStore", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-cred-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-cred-cwd-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("save+list round-trips at user scope", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "s1" });
    expect(store.list().map((c) => c.id)).toContain("tok-a");
  });

  test("writes to ~/.code-shell/credentials.json for user scope", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "s1" });
    const p = join(home, ".code-shell", "credentials.json");
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).credentials[0].id).toBe("tok-a");
  });

  test("project scope overrides user scope on same id", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "dup", type: "token", label: "global", secret: "g" });
    store.save("project", { id: "dup", type: "token", label: "local", secret: "l" });
    const merged = store.list();
    const dup = merged.filter((c) => c.id === "dup");
    expect(dup).toHaveLength(1);
    expect(dup[0].label).toBe("local");
  });

  test("resolve returns the merged credential by id", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "s1" });
    expect(store.resolve("tok-a")?.secret).toBe("s1");
    expect(store.resolve("missing")).toBeUndefined();
  });

  test("remove deletes from the given scope", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "s1" });
    store.remove("user", "tok-a");
    expect(store.resolve("tok-a")).toBeUndefined();
  });

  test("mask hides secret value", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "supersecretvalue" });
    const masked = store.listMasked();
    const m = masked.find((c) => c.id === "tok-a")!;
    expect(m.secret).toBeUndefined();
    expect(m.hasSecret).toBe(true);
    expect(m.secretHint).toMatch(/\*\*\*\*/);
  });

  test("cookie credential round-trips (type + jar secret + meta)", () => {
    const store = new CredentialStore(cwd);
    const jar = JSON.stringify([
      { name: "web_session", value: "abc", domain: ".xiaohongshu.com", secure: true },
    ]);
    store.save("user", {
      id: "xiaohongshu__accountA",
      type: "cookie",
      label: "账号A",
      secret: jar,
      meta: { platform: "xiaohongshu", domain: "xiaohongshu.com" },
    });
    const c = store.resolve("xiaohongshu__accountA")!;
    expect(c.type).toBe("cookie");
    expect(c.meta?.platform).toBe("xiaohongshu");
    expect(c.meta?.domain).toBe("xiaohongshu.com");
    expect(JSON.parse(c.secret!)).toEqual([
      { name: "web_session", value: "abc", domain: ".xiaohongshu.com", secure: true },
    ]);
  });

  test("same domain can hold multiple named accounts (no overwrite)", () => {
    const store = new CredentialStore(cwd);
    const meta = { platform: "xiaohongshu", domain: "xiaohongshu.com" };
    store.save("user", { id: "xiaohongshu__accountA", type: "cookie", label: "A", secret: "[]", meta });
    store.save("user", { id: "xiaohongshu__accountB", type: "cookie", label: "B", secret: "[]", meta });
    const ids = store.list().filter((c) => c.type === "cookie").map((c) => c.id);
    expect(ids).toContain("xiaohongshu__accountA");
    expect(ids).toContain("xiaohongshu__accountB");
    expect(ids).toHaveLength(2);
  });
});
