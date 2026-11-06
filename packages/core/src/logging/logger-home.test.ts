import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { getLogsDir, setLogsDir } from "./logger.js";

const prev = process.env.CODE_SHELL_HOME;
afterEach(() => {
  if (prev === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prev;
});

test("default logs dir follows CODE_SHELL_HOME", () => {
  setLogsDir(null);
  process.env.CODE_SHELL_HOME = "/tmp/some-code-shell-home";
  expect(getLogsDir()).toBe(join("/tmp/some-code-shell-home", "logs"));
});
