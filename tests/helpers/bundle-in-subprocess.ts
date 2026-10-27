/**
 * Bundles entry points for a native Node fixture with the `bun build` CLI in a child
 * process. An in-process `Bun.build` shares the test runner's resolver cache: on Linux,
 * once the runner had also scanned the bundled packages' directories, later suites in the
 * same `bun test` process could no longer resolve `@cjhyy/code-shell-capability-coding`
 * or read `packages/core/dist/index.internal.js`, though every suite passed alone.
 */
export function bundleInSubprocess(
  entrypoints: string[],
  outdir: string,
  options: { naming?: string; external?: string[] } = {},
): void {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      ...entrypoints,
      "--target=node",
      `--outdir=${outdir}`,
      ...(options.naming ? [`--entry-naming=${options.naming}`] : []),
      ...(options.external ?? []).map((name) => `--external=${name}`),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0)
    throw new Error(`bun build failed (${result.exitCode}): ${result.stderr.toString()}`);
}
