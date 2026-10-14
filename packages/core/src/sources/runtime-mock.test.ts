import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

test.each(["production", "development", "unset", "test"])(
  "mock source authority is confined to the test runtime: %s",
  async (mode) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "source-runtime-mode-")));
    const home = join(scratch, "home");
    const cwd = join(scratch, "workspace");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
    try {
      // Do not inherit credentials, provider URLs, module hooks or operator HOME.
      const { stdout, stderr } = await execute(
        process.execPath,
        [join(import.meta.dir, "__fixtures__", "runtime-mock.fixture.ts")],
        {
          cwd,
          env: {
            HOME: home,
            USERPROFILE: home,
            CODE_SHELL_HOME: join(home, ".code-shell"),
            XDG_CONFIG_HOME: join(home, ".config"),
            ...(mode === "unset" ? {} : { NODE_ENV: mode }),
          },
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        },
      );
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({ mode, testFixturesEnabled: mode === "test" });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
