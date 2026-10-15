import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const node = realpathSync(Bun.which("node")!);
async function actualNode(scenario: string, sourceRoot = root) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "candidate-pdf-argv-")));
  chmodSync(home, 0o700);
  const temporary = join(home, "tmp");
  mkdirSync(temporary, { mode: 0o700 });
  let child: ReturnType<typeof spawn> | undefined;
  let closed = false;
  try {
    child = spawn(
      node,
      [
        "--preserve-symlinks-main",
        join(sourceRoot, "tests/fixtures/docker-candidate-pdf-argv-case.mjs"),
        scenario,
      ],
      {
        cwd: home,
        env: {
          PATH: dirname(node),
          HOME: home,
          USERPROFILE: home,
          CODE_SHELL_HOME: join(home, ".code-shell"),
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child!.kill("SIGKILL"), 10000);
    const [code, signal] = await once(child, "close").finally(() => clearTimeout(timer));
    closed = true;
    expect(signal).toBeNull();
    expect(code, stderr).toBe(0);
    expect(stderr).toBe("");
    const receipt = JSON.parse(stdout.trim());
    expect(receipt.scenario).toBe(scenario);
    expect(receipt.nativeChildStarts).toBe(0);
    expect(receipt.argvCount).toBe(12);
    expect(receipt.sourceHash).toBe(
      "fa5277ab082278f3db128fadc08d5c9b40d56bdb163aa3ccfcc3d47b40999f7e",
    );
    return receipt;
  } finally {
    if (child && !closed) {
      child.kill("SIGKILL");
      await once(child, "close");
      closed = true;
    }
    if (!child || closed) rmSync(home, { recursive: true, force: true });
  }
}

test("frozen Job PDF argv accepts the Hub task layout in an owned filesystem mapping", async () => {
  expect((await actualNode("consumer")).cases).toBe(1);
});

test("Hub PDF scope rejects other jobs, non-work paths, unsafe custody and changed flags", async () => {
  expect((await actualNode("boundaries")).cases).toBe(18);
});

test("existing workspace and home PDF consumers retain their original cwd contract", async () => {
  expect((await actualNode("legacy")).cases).toBe(9);
});

test("real Node executes all frozen PDF boundaries through a Unicode and space-containing source entry", async () => {
  const alias = mkdtempSync(join(tmpdir(), "中文 fixture with spaces-"));
  try {
    // Only aliases to the two source directories, never a replacement checkout.
    symlinkSync(join(root, "tests"), join(alias, "tests"), "dir");
    symlinkSync(join(root, "scripts"), join(alias, "scripts"), "dir");
    const receipt = await actualNode("boundaries", alias);
    expect(receipt.cases).toBe(18);
    expect(receipt.fixturePath).toBe(
      join(alias, "tests/fixtures/docker-candidate-pdf-argv-case.mjs"),
    );
  } finally {
    rmSync(alias, { recursive: true, force: true });
  }
});
