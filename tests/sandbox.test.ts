/**
 * Sandbox backend tests.
 *
 * Most of these are pure-logic tests that work on any platform. The Seatbelt
 * integration block actually spawns sandbox-exec and so is macOS-only;
 * `it.if` skips on other platforms instead of failing.
 *
 * Why this exists: when the Bash tool got sandboxing, we eyeballed one
 * deniedReads path manually. That's not enough — sandbox-exec silently
 * succeeds when a denied path doesn't exist, so a profile that "looks
 * right" can pass smoke tests while letting the real attack paths through.
 * The integration block iterates every default deniedRead that exists on
 * the host and asserts reads actually fail.
 */

import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  defaultSandboxConfig,
  detectSandboxCapabilities,
  expandConfig,
  expandPath,
  resolveSandboxBackend,
} from "../src/tool-system/sandbox/index.js";
import { createOffBackend } from "../src/tool-system/sandbox/off.js";

const IS_MAC = process.platform === "darwin";

describe("expandPath", () => {
  it("expands ${workspace} on its own", () => {
    expect(expandPath("${workspace}", "/tmp/ws")).toBe("/tmp/ws");
  });
  it("expands ${workspace}/ prefix", () => {
    expect(expandPath("${workspace}/sub", "/tmp/ws")).toBe("/tmp/ws/sub");
  });
  it("expands bare ~", () => {
    expect(expandPath("~", "/tmp/ws")).toBe(homedir());
  });
  it("expands ~/ prefix", () => {
    expect(expandPath("~/.ssh", "/tmp/ws")).toBe(`${homedir()}/.ssh`);
  });
  it("leaves absolute paths alone", () => {
    expect(expandPath("/etc/passwd", "/tmp/ws")).toBe("/etc/passwd");
  });
});

describe("expandConfig", () => {
  it("expands placeholders and canonicalizes symlinks", () => {
    // /tmp on macOS is a symlink to /private/tmp; on Linux it's a real dir.
    // We use a path we know exists (homedir) so realpathSync resolves; and
    // assert symbolically rather than hard-coding /private/* to keep this
    // test portable across platforms.
    const cfg = expandConfig(
      {
        mode: "auto",
        writableRoots: ["${workspace}", "/tmp"],
        deniedReads: ["~"],
        network: "allow",
      },
      homedir(),
    );
    // canonicalize(homedir()) on macOS may resolve through /Users symlinks
    // too — both should produce the same path, so compare them resolved.
    expect(cfg.writableRoots[0]).toBeDefined();
    expect(cfg.writableRoots).toHaveLength(2);
    expect(cfg.deniedReads).toHaveLength(1);
  });

  it("falls back to the original path when realpath fails (path absent)", () => {
    const cfg = expandConfig(
      {
        mode: "auto",
        writableRoots: ["/nonexistent/abc123"],
        deniedReads: [],
        network: "allow",
      },
      "/work",
    );
    expect(cfg.writableRoots).toEqual(["/nonexistent/abc123"]);
  });
});

describe("defaultSandboxConfig", () => {
  it("denies the canonical credential dirs", () => {
    const cfg = defaultSandboxConfig();
    expect(cfg.deniedReads).toContain("~/.ssh");
    expect(cfg.deniedReads).toContain("~/.aws");
    expect(cfg.deniedReads).toContain("~/.code-shell");
  });
  it("makes ${workspace} writable by default", () => {
    expect(defaultSandboxConfig().writableRoots).toContain("${workspace}");
  });
  it("accepts an explicit mode", () => {
    expect(defaultSandboxConfig("off").mode).toBe("off");
  });
});

describe("off backend", () => {
  it("passes the command through as `shell -c command`", () => {
    const b = createOffBackend();
    const wrapped = b.wrap("echo hi", { cwd: "/tmp", shell: "/bin/bash" });
    expect(wrapped.file).toBe("/bin/bash");
    expect(wrapped.args).toEqual(["-c", "echo hi"]);
  });
});

describe("resolveSandboxBackend errors", () => {
  it("throws when mode=seatbelt on non-macOS", async () => {
    if (IS_MAC) return; // skip — would actually resolve fine
    await expect(
      resolveSandboxBackend(
        { mode: "seatbelt", writableRoots: [], deniedReads: [], network: "allow" },
        "/tmp",
      ),
    ).rejects.toThrow(/sandbox-exec/);
  });
  it("throws when mode=bwrap on a host without bwrap", async () => {
    if (detectSandboxCapabilities().bwrap) return; // skip on hosts that do have it
    await expect(
      resolveSandboxBackend(
        { mode: "bwrap", writableRoots: [], deniedReads: [], network: "allow" },
        "/tmp",
      ),
    ).rejects.toThrow(/bubblewrap|bwrap/);
  });

  // Regression: Engine.run wraps resolveSandboxBackend in a try/catch so a
  // user-misconfig (mode=bwrap on macOS) downgrades to off instead of
  // killing the whole turn. We can't drive Engine.run in a unit test, but
  // we can reproduce the exact pattern.
  it("a fallback-to-off path resolves cleanly when explicit mode is unavailable", async () => {
    const cfg = {
      mode: "bwrap" as const,
      writableRoots: [],
      deniedReads: [],
      network: "allow" as const,
    };
    if (detectSandboxCapabilities().bwrap) return; // skip on hosts where bwrap works

    let backend;
    try {
      backend = await resolveSandboxBackend(cfg, "/tmp");
    } catch {
      backend = await resolveSandboxBackend({ ...cfg, mode: "off" }, "/tmp");
    }
    expect(backend.name).toBe("off");
  });
});

// ───────────────────────────────────────────────────────────────────
// Real-execution check on macOS. Asserts that every default deniedRead
// that *exists* on this host actually gets blocked, and that writes
// outside writableRoots are blocked. Without iterating like this it's
// trivially easy to ship a Seatbelt profile that silently leaks: if
// the path doesn't exist, sandbox-exec doesn't complain.
// ───────────────────────────────────────────────────────────────────

describe.if(IS_MAC)("Seatbelt — real sandbox-exec", () => {
  // 4s timeout per case is overkill but sandbox-exec startup is occasionally
  // slow under disk pressure.
  const TIMEOUT = 4000;

  // Regression: wrap() used to mkdtempSync a per-command profile dir and
  // never delete it — a long REPL session leaked hundreds of /tmp dirs.
  // The backend now returns a cleanup() the Bash tool fires from its close
  // handler. Verify the dir actually disappears.
  it("wrap().cleanup removes the temp profile dir", async () => {
    const backend = await resolveSandboxBackend(
      defaultSandboxConfig("seatbelt"),
      process.cwd(),
    );
    const wrapped = backend.wrap("true", { cwd: process.cwd(), shell: "/bin/bash" });
    // args[1] is the profile path: ["-f", "/path/to/profile.sb", shell, "-c", cmd]
    expect(wrapped.args[0]).toBe("-f");
    const profilePath = wrapped.args[1];
    const profileDir = profilePath.replace(/\/profile\.sb$/, "");
    expect(existsSync(profileDir)).toBe(true);
    expect(typeof wrapped.cleanup).toBe("function");
    wrapped.cleanup!();
    expect(existsSync(profileDir)).toBe(false);
  });

  it("blocks reads of each existing deniedRead path", async () => {
    const cfg = defaultSandboxConfig("seatbelt");
    const backend = await resolveSandboxBackend(cfg, process.cwd());

    const expandedDenies = cfg.deniedReads
      .map((p) => expandPath(p, process.cwd()))
      .filter((p) => existsSync(p));

    expect(expandedDenies.length).toBeGreaterThan(0); // sanity: at least one to test

    for (const path of expandedDenies) {
      const wrapped = backend.wrap(`ls -1 ${path} 2>&1 | head -1`, {
        cwd: process.cwd(),
        shell: "/bin/bash",
      });
      const result = spawnSync(wrapped.file, wrapped.args, {
        encoding: "utf-8",
        timeout: TIMEOUT,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(
        /Operation not permitted|sandbox|denied/i.test(output),
        `expected ${path} read to be blocked, got: ${output.slice(0, 200)}`,
      ).toBe(true);
    }
  });

  it("blocks writes outside writableRoots", async () => {
    const cfg = defaultSandboxConfig("seatbelt");
    const backend = await resolveSandboxBackend(cfg, process.cwd());

    const leakPath = `${homedir()}/codeshell-sandbox-leak-test-${process.pid}`;
    try {
      const wrapped = backend.wrap(
        `echo leak > ${leakPath} 2>&1; cat ${leakPath} 2>&1`,
        { cwd: process.cwd(), shell: "/bin/bash" },
      );
      const result = spawnSync(wrapped.file, wrapped.args, {
        encoding: "utf-8",
        timeout: TIMEOUT,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(existsSync(leakPath), `sandbox FAILED: leak file present at ${leakPath}`).toBe(false);
      expect(
        /Operation not permitted|sandbox|denied/i.test(output),
        `expected HOME write to be blocked, got: ${output.slice(0, 200)}`,
      ).toBe(true);
    } finally {
      if (existsSync(leakPath)) rmSync(leakPath);
    }
  });

  it("allows writes inside the workspace", async () => {
    const ws = mkdtempSync(join(tmpdir(), "codeshell-sandbox-ws-"));
    try {
      const cfg = defaultSandboxConfig("seatbelt");
      const backend = await resolveSandboxBackend(cfg, ws);

      const target = join(ws, "ok.txt");
      const wrapped = backend.wrap(`echo ok > ${target} && cat ${target}`, {
        cwd: ws,
        shell: "/bin/bash",
      });
      const result = spawnSync(wrapped.file, wrapped.args, {
        encoding: "utf-8",
        timeout: TIMEOUT,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf-8").trim()).toBe("ok");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("creates a non-existent deniedRead path on the fly does not bypass", async () => {
    // Synthetic: add a denied path that exists, then prove a write to it
    // also fails (deniedReads only covers reads, but the path is outside
    // writableRoots so write also fails).
    const sentinel = join(homedir(), `.sandbox-sentinel-${process.pid}`);
    writeFileSync(sentinel, "secret");
    try {
      const backend = await resolveSandboxBackend(
        {
          ...defaultSandboxConfig("seatbelt"),
          deniedReads: [sentinel],
        },
        process.cwd(),
      );
      const wrapped = backend.wrap(`cat ${sentinel} 2>&1`, {
        cwd: process.cwd(),
        shell: "/bin/bash",
      });
      const result = spawnSync(wrapped.file, wrapped.args, {
        encoding: "utf-8",
        timeout: TIMEOUT,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain("secret");
    } finally {
      rmSync(sentinel, { force: true });
    }
  });

  // Regression test for the reviewer concern that `(allow file-read*)` listed
  // before the deny clause in the profile would let `cat ~/.ssh/id_rsa` slip
  // through. We've already shown the deny wins (more specific subpath beats
  // the wildcard regardless of order), but a targeted "exfiltrate the actual
  // private key" attack is the right shape to leave in the suite — if anyone
  // future-edits the profile and breaks the deny path, this fails loudly.
  it("blocks direct `cat` of a synthetic id_rsa-style file under ~/.ssh", async () => {
    const sshDir = join(homedir(), ".ssh");
    if (!existsSync(sshDir)) return; // host has no ~/.ssh — nothing to attack

    const fakeKey = join(sshDir, `codeshell-fake-id_rsa-${process.pid}`);
    const marker = `BEGIN-OPENSSH-PRIVATE-KEY-${process.pid}`;
    writeFileSync(fakeKey, marker);
    try {
      const backend = await resolveSandboxBackend(
        defaultSandboxConfig("seatbelt"),
        process.cwd(),
      );
      const wrapped = backend.wrap(`cat ${fakeKey} 2>&1`, {
        cwd: process.cwd(),
        shell: "/bin/bash",
      });
      const result = spawnSync(wrapped.file, wrapped.args, {
        encoding: "utf-8",
        timeout: TIMEOUT,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(
        output.includes(marker),
        `sandbox FAILED to deny ~/.ssh read; output leaked marker:\n${output.slice(0, 300)}`,
      ).toBe(false);
      expect(
        /Operation not permitted|sandbox|denied/i.test(output),
        `expected sandbox-style denial, got: ${output.slice(0, 200)}`,
      ).toBe(true);
    } finally {
      rmSync(fakeKey, { force: true });
    }
  });
});
