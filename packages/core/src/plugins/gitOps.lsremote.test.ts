import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { gitLsRemote } from "./gitOps.js";

describe("gitLsRemote", () => {
  let repo: string;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const run = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-lsr-repo-"));
    mkdirSync(join(repo, "x"), { recursive: true });
    writeFileSync(join(repo, "x", "f.txt"), "hi");
    run(["init", "-q"]);
    run(["config", "user.email", "t@t.t"]);
    run(["config", "user.name", "t"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("returns the HEAD sha matching git rev-parse HEAD", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, env, stdio: "pipe" })
      .toString()
      .trim();
    const r = await gitLsRemote(`file://${repo}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stdout).toBe(head);
  });

  test("a bogus url returns ok:false", async () => {
    const r = await gitLsRemote(`file://${repo}-does-not-exist`);
    expect(r.ok).toBe(false);
  });

  test("SECURITY: a `--upload-pack=<cmd>`-shaped url does NOT execute the command", async () => {
    // Without the `--` end-of-options separator, git parses this URL as the
    // --upload-pack flag and RUNS the command (RCE). The sentinel file must NOT
    // appear — git must treat the whole thing as a (bogus) positional URL.
    const sentinel = join(repo, "pwned");
    const r = await gitLsRemote(`--upload-pack=touch ${sentinel}`);
    expect(r.ok).toBe(false); // bogus url → clean failure
    expect(existsSync(sentinel)).toBe(false); // command did NOT run
  });
});
