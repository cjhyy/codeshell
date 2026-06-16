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
});
