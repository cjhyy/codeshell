import { expect, test } from "bun:test";
import { accessSync, constants, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../scripts/bun-test-completion.mjs";

function gitBinary(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of process.platform === "win32" ? ["git.exe", "git"] : ["git"]) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // Continue through the inherited executable search path, without executing it.
      }
    }
  }
  throw new Error("The actual plugin installer regression requires Git");
}

test.each(["path", "git", "git-subdir"])(
  "native marketplace installation keeps %s aliases inside the installed copy",
  async (source) => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "plugin-symlink-install-")));
    let safeToRemove = false;
    try {
      const built = await Bun.build({
        entrypoints: [
          resolve("packages/core/src/plugins/pluginInstaller.ts"),
          resolve("packages/core/src/plugins/marketplaceManager.ts"),
        ],
        outdir: root,
        naming: "[name].mjs",
        target: "node",
        packages: "external",
      });
      expect(built.success, built.logs.map(String).join("\n")).toBe(true);
      await symlink(resolve("packages/core/node_modules"), join(root, "node_modules"), "junction");
      const entryHashes = Object.fromEntries(
        await Promise.all(
          ["pluginInstaller.mjs", "marketplaceManager.mjs"].map(async (name) => [
            name,
            createHash("sha256")
              .update(await readFile(join(root, name)))
              .digest("hex"),
          ]),
        ),
      );
      await writeFile(join(root, "entries.json"), JSON.stringify(entryHashes), { mode: 0o600 });
      const executable = gitBinary();
      const child = Bun.spawnSync({
        cmd: [
          "node",
          "--unhandled-rejections=strict",
          fileURLToPath(new URL("./fixtures/plugin-installer-symlinks.mjs", import.meta.url)),
          source,
          root,
        ],
        env: {
          ...createBunTestEnvironment(process.env, root),
          TMPDIR: join(root, "home"),
          FIXTURE_GIT_BINARY: executable,
          FIXTURE_GIT_SHA256: createHash("sha256")
            .update(await readFile(executable))
            .digest("hex"),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 1_048_576,
      });
      const lastLine = child.stdout.toString().trim().split("\n").at(-1);
      const result = lastLine?.startsWith("{") ? JSON.parse(lastLine) : undefined;
      const confirmedClose =
        child.exitCode === 0 &&
        child.signalCode === undefined &&
        result?.ownedGitChildrenClosed === true;
      console.info(JSON.stringify({ compiledEntryHashes: entryHashes }));
      console.info(child.stdout.toString().trim());
      expect({
        exit: child.exitCode,
        stderr: child.stderr.toString(),
        preserved: confirmedClose ? undefined : root,
      }).toEqual({ exit: 0, stderr: "", preserved: undefined });
      expect(result).toMatchObject({
        passed: true,
        source,
        aliasText: "CLAUDE.md",
        selfContainedAfterSourceRemoval: true,
        hookApprovalUnchanged: true,
        negativeProbes: 8,
        ownedGitChildrenClosed: true,
      });
      safeToRemove = confirmedClose;
    } finally {
      if (safeToRemove) await rm(root, { recursive: true, force: true });
      else console.error(`Plugin installer evidence preserved: ${root}`);
    }
  },
  35_000,
);
