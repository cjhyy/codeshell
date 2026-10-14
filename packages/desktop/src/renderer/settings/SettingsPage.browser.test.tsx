import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// The guarded unit runner isolates HOME. Supply CODESHELL_TEST_CHROMIUM when
// the browser is installed outside that HOME; ordinary unit-only CI can skip.
const executablePath = process.env.CODESHELL_TEST_CHROMIUM || chromium.executablePath();

test.skipIf(!existsSync(executablePath))(
  "real settings navigation and refresh preserve responsive layout in Chromium",
  async () => {
    const child = Bun.spawn({
      cmd: ["node", fileURLToPath(new URL("./SettingsPage.browser.fixture.mjs", import.meta.url))],
      env: { ...process.env, CODESHELL_TEST_CHROMIUM: executablePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr, stdout }).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: expect.stringContaining("PASS: settings computer-use navigation and stable layout"),
    });
  },
  45000,
);
