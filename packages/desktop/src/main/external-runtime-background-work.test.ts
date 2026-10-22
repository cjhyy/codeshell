import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager, backgroundJobRegistry } from "@cjhyy/code-shell-core/internal";
import { createExternalRuntimeBackgroundWork } from "./external-runtime-background-work.js";

let home: string;
let previousHome: string | undefined;
let shells: BackgroundShellManager;

beforeEach(() => {
  previousHome = process.env.CODE_SHELL_HOME;
  home = mkdtempSync(join(tmpdir(), "codeshell-external-bg-"));
  process.env.CODE_SHELL_HOME = home;
  shells = new BackgroundShellManager();
});
afterEach(async () => {
  await shells.killAll();
  backgroundJobRegistry.dropForSession("sess-shell");
  backgroundJobRegistry.dropForSession("sess-job");
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test("an explicit wait_for_exit shell is running work; a service is not", async () => {
  const delivery = createExternalRuntimeBackgroundWork(shells);
  const service = shells.spawnBackground({
    command: "sleep 30",
    cwd: home,
    sessionId: "sess-shell",
  });
  expect(service.ok).toBe(true);
  expect(delivery.hasRunning("sess-shell")).toBe(false);

  const finite = shells.spawnBackground({
    command: "sleep 30",
    cwd: home,
    sessionId: "sess-shell",
    waitForExit: true,
  });
  expect(delivery.hasRunning("sess-shell")).toBe(true);
  expect(delivery.hasRunning("sess-other")).toBe(false);
  if (finite.ok) await shells.kill(finite.shellId, "sess-shell");
  expect(delivery.hasRunning("sess-shell")).toBe(false);
});

test("delegated jobs still count as running work", () => {
  const delivery = createExternalRuntimeBackgroundWork(shells);
  backgroundJobRegistry.start("job-1", "sess-job", "delegated task", {
    kind: "drive-agent",
    abort: () => undefined,
  });
  expect(delivery.hasRunning("sess-job")).toBe(true);
  delivery.dropSession("sess-job");
  expect(delivery.hasRunning("sess-job")).toBe(false);
});
