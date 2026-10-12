import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const node = realpathSync(Bun.which("node")!);
async function controlledSetup(cut: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "candidate-setup-")));
  const initialHome = join(root, "initial-home");
  mkdirSync(initialHome, { mode: 0o700 });
  let child,
    closed = false,
    custodyClosed = false;
  try {
    child = spawn(
      node,
      [resolve(import.meta.dir, "fixtures/docker-candidate-setup-case.mjs"), root, cut],
      {
        env: { PATH: dirname(node), HOME: initialHome, USERPROFILE: initialHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => (stdout += part));
    child.stderr.on("data", (part) => (stderr += part));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const [code, signal] = await once(child, "close").finally(() => clearTimeout(timer));
    closed = true;
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(signal).toBeNull();
    const value = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(value.custodyClosed).toBe(true);
    custodyClosed = true;
    return value;
  } finally {
    if (child && !closed) {
      child.kill("SIGKILL");
      await once(child, "close");
      closed = true;
    }
    if (!child || (closed && custodyClosed)) rmSync(root, { recursive: true, force: true });
  }
}

test("controlled setup installs actual Node guards, captures CLI children and confirms cleanup before success", async () => {
  const value = await controlledSetup("success");
  expect(value.failed).toBe(false);
  expect(value.state.removed).toBe(true);
  expect(
    value.receipt.some(
      (row) => row.event === "pre-core" && row.negativeProbes === 6 && row.dnsNegativeProbes === 4,
    ),
  ).toBe(true);
  expect(value.receipt.at(-1).event).toBe("driver-closed");
  for (const row of value.receipt.filter((row) => row.event === "child-started"))
    expect(
      value.receipt.some(
        (closed) => closed.event === "child-closed" && closed.childPid === row.childPid,
      ),
    ).toBe(true);
});
test("controlled failed helper build cleans only its captured iid and preserves original failure", async () => {
  const value = await controlledSetup("build-fails");
  expect(value.failed).toBe(true);
  expect(value.state.removed).toBe(true);
  expect(value.errors.join(" ")).toContain("Candidate native command failed (3)");
});
test("controlled cleanup refusal cannot become a passed fixture", async () => {
  const value = await controlledSetup("cleanup-fails");
  expect(value.failed).toBe(true);
  expect(value.state.removed).not.toBe(true);
  expect(value.errors.join(" ")).toContain("Candidate native command failed (4)");
  expect(value.receipt.some((row) => row.event === "driver-closed")).toBe(false);
});
test("actual captured live Node child is terminated and reported as incomplete custody", async () => {
  const value = await controlledSetup("live-child");
  expect(value.failed).toBe(true);
  expect(value.state.removed).toBe(true);
  expect(value.errors.join(" ")).toContain("remained live");
  const started = value.receipt.find((row) => row.event === "child-started" && row.isNode);
  expect(
    value.receipt.some((row) => row.event === "pre-core" && row.pid === started.childPid),
  ).toBe(false);
  // The controller has a separate private receipt; its captured close still
  // proves termination before the parent removes this controlled test HOME.
  expect(
    value.receipt.some((row) => row.event === "child-closed" && row.childPid === started.childPid),
  ).toBe(true);
});
