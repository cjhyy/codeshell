import { test } from "bun:test";

type BackendTest = (name: string, run: () => void | Promise<void>, timeoutMs?: number) => void;

/**
 * The monolithic Bun run shares renderer DOM globals and module mocks. These
 * tests exercise the actual server SDK, whose browser guard must stay enabled.
 * Give each test a clean backend process while preserving names and -t filters.
 */
export function isolatedBackendTest(filePath: string): BackendTest {
  if (process.env.CODESHELL_LAB_BACKEND_TEST_FILE === filePath) return test;
  return (name, _run, timeoutMs = 30_000) => {
    test(
      name,
      async () => {
        const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
        const child = Bun.spawn(
          [process.execPath, "test", filePath, "--timeout", String(timeoutMs), "-t", pattern],
          {
            env: { ...process.env, CODESHELL_LAB_BACKEND_TEST_FILE: filePath },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        try {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          const output = `${stdout}\n${stderr}`;
          if (exitCode !== 0 || !/\n\s*1 pass\n/.test(output) || !/\n\s*0 fail\n/.test(output)) {
            throw new Error(`Isolated backend test did not pass: ${name}\n${output.trim()}`);
          }
        } finally {
          child.kill();
        }
      },
      timeoutMs + 10_000,
    );
  };
}
