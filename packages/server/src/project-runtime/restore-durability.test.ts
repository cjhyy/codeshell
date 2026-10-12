import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../scripts/bun-test-completion.mjs";

test.each(["durability", "barriers", "legacy", "cleanup-failure"])(
  "actual offline restore: %s",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-bun-completion-restore-"));
    let safeToRemove = false;
    try {
      const fixture = fileURLToPath(
        new URL("./__fixtures__/restore-durability.ts", import.meta.url),
      );
      const adapter = fileURLToPath(
        new URL("./__fixtures__/restore-durability-adapters.ts", import.meta.url),
      );
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await symlink(resolve("packages/server/node_modules"), join(root, "node_modules"));
      for (const entry of [fixture, adapter]) {
        const built = await Bun.build({
          entrypoints: [entry],
          outdir: root,
          naming: "[name].mjs",
          target: "node",
          packages: "external",
        });
        expect(built.success, built.logs.map(String).join("\n")).toBe(true);
      }
      for (const name of ["backup", "control"]) {
        const original = fileURLToPath(
          new URL(`./__fixtures__/restore-durability-${name}-v1.txt`, import.meta.url),
        );
        await cp(original, join(root, `restore-durability-${name}-v1.txt`));
        const source = (await readFile(original, "utf8")).replace(
          /from "(\.\.?\/[^"]+)"/g,
          'from "./restore-durability-adapters.mjs"',
        );
        const entry = join(root, `historical-${name}.ts`);
        await writeFile(entry, source);
        const built = await Bun.build({
          entrypoints: [entry],
          outdir: root,
          naming: "[name].mjs",
          target: "node",
          packages: "external",
          external: ["./restore-durability-adapters.mjs"],
        });
        expect(built.success, built.logs.map(String).join("\n")).toBe(true);
      }
      const child = Bun.spawnSync({
        cmd: [
          "node",
          "--unhandled-rejections=strict",
          join(root, "restore-durability.mjs"),
          scenario,
          root,
        ],
        env: createBunTestEnvironment(process.env, root),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 40_000,
        killSignal: "SIGKILL",
        maxBuffer: 1_048_576,
      });
      const reported = child.stdout.toString().trim().split("\n").at(-1);
      const result = reported?.startsWith("{") ? JSON.parse(reported) : undefined;
      const expectedExit = scenario === "cleanup-failure" ? 1 : 0;
      safeToRemove =
        child.exitCode === expectedExit &&
        result?.ownedDockerChildrenExited === true &&
        (expectedExit === 0 || result.actualPostRestoreFailure === true);
      expect({
        exit: child.exitCode,
        stderr: child.stderr.toString(),
        preservedEvidence: safeToRemove ? undefined : root,
      }).toEqual({
        exit: expectedExit,
        stderr: "",
        preservedEvidence: undefined,
      });
      expect(result).toMatchObject({ scenario, passed: true, ownedDockerChildrenExited: true });
      console.info(JSON.stringify(result));
    } finally {
      if (safeToRemove) await rm(root, { recursive: true, force: true });
      else console.error(`Restore fixture exit was not confirmed; preserved evidence: ${root}`);
    }
  },
  45_000,
);
