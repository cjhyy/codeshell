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

  test('project scope hides host user credentials from list/resolve/listMasked', () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "host-tok", type: "token", label: "host", secret: "hs" });
    store.save("project", { id: "proj-tok", type: "token", label: "proj", secret: "ps" });

    // full scope (host app): sees both
    const fullIds = store.list("full").map((c) => c.id).sort();
    expect(fullIds).toEqual(["host-tok", "proj-tok"]);
    expect(store.resolve("host-tok", "full")?.secret).toBe("hs");

    // project scope (isolated/SDK-embedded): only project store, host user hidden
    const projIds = store.list("project").map((c) => c.id);
    expect(projIds).toEqual(["proj-tok"]);
    expect(store.resolve("host-tok", "project")).toBeUndefined();
    expect(store.resolve("proj-tok", "project")?.secret).toBe("ps");
    expect(store.listMasked("project").map((c) => c.id)).toEqual(["proj-tok"]);
  });

  test('list() defaults to full scope (backward compat)', () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "u", type: "token", label: "u", secret: "x" });
    expect(store.list().map((c) => c.id)).toContain("u");
  });

  test("remove deletes from the given scope", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "s1" });
    store.remove("user", "tok-a");
    expect(store.resolve("tok-a")).toBeUndefined();
  });

  // envExposures: the missing wiring for Credential.exposeAsEnv. A credential
  // flagged "expose as env var" must surface { ENV_NAME: secret } so the engine
  // can layer it into the shell env — previously the flag was stored but never
  // consumed, so $FIGMA_TOKEN was always empty.
  describe("envExposures (exposeAsEnv → shell env map)", () => {
    test("returns ENV_NAME→secret for flagged credentials", () => {
      const store = new CredentialStore(cwd);
      store.save("user", {
        id: "figma",
        type: "token",
        label: "Figma",
        secret: "s-mquq0f4p",
        exposeAsEnv: "FIGMA_TOKEN",
      });
      expect(store.envExposures("full")).toEqual({ FIGMA_TOKEN: "s-mquq0f4p" });
    });

    test("ignores credentials without exposeAsEnv or without a secret", () => {
      const store = new CredentialStore(cwd);
      store.save("user", { id: "no-env", type: "token", label: "X", secret: "s1" });
      store.save("user", { id: "no-secret", type: "token", label: "Y", exposeAsEnv: "Y_TOKEN" });
      store.save("user", { id: "blank-name", type: "token", label: "Z", secret: "s2", exposeAsEnv: "  " });
      expect(store.envExposures("full")).toEqual({});
    });

    test("project scope ONLY reads the project store (host isolation)", () => {
      const store = new CredentialStore(cwd);
      store.save("user", { id: "g", type: "token", label: "g", secret: "gs", exposeAsEnv: "G_TOKEN" });
      store.save("project", { id: "p", type: "token", label: "p", secret: "ps", exposeAsEnv: "P_TOKEN" });
      // project scope: user credential must NOT leak
      expect(store.envExposures("project")).toEqual({ P_TOKEN: "ps" });
      // full scope: both, project wins on a name clash
      expect(store.envExposures("full")).toEqual({ G_TOKEN: "gs", P_TOKEN: "ps" });
    });

    test("project credential overrides user on the same env name (full scope)", () => {
      const store = new CredentialStore(cwd);
      store.save("user", { id: "g", type: "token", label: "g", secret: "global", exposeAsEnv: "TOK" });
      store.save("project", { id: "p", type: "token", label: "p", secret: "local", exposeAsEnv: "TOK" });
      expect(store.envExposures("full")).toEqual({ TOK: "local" });
    });
  });

  test("mask hides secret value", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "supersecretvalue" });
    const masked = store.listMasked();
    const m = masked.find((c) => c.id === "tok-a")!;
    // MaskedCredential omits `secret` at the type level; assert it's also absent at runtime.
    expect((m as unknown as Record<string, unknown>).secret).toBeUndefined();
    expect(m.hasSecret).toBe(true);
    expect(m.secretHint).toMatch(/\*\*\*\*/);
    // only the last 4 chars are revealed
    expect(m.secretHint).toBe("****alue");
  });

  // A short secret must NOT leak in full through the hint: `"ab".slice(-4)`
  // returns "ab", so the naive `****${slice(-4)}` exposed the entire secret
  // for secrets ≤4 chars. The hint must never contain the secret's own bytes
  // when the secret is short — show a fixed mask instead.
  test("mask does not leak a short secret in the hint", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "short", type: "token", label: "S", secret: "ab" });
    const m = store.listMasked().find((c) => c.id === "short")!;
    expect(m.hasSecret).toBe(true);
    expect(m.secretHint).toBeDefined();
    expect(m.secretHint).not.toContain("ab"); // must not reveal the short secret
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
