import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { createSigningHooks } = require("../packages/desktop/scripts/managed-node-signing.cjs");
const directories: string[] = [];
const main = "Contents/MacOS/codeshell-computer-use";
const resource = "Contents/Resources/fixture.txt";
const seal = "Contents/_CodeSignature/CodeResources";
const files = [main, resource, seal, "Contents/Resources/cua-driver", "Contents/Info.plist"];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codeshell-helper-hardlinks-"));
  directories.push(directory);
  const source = join(directory, "source.app");
  for (const path of files) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), `source ${path}`, { mode: path === main ? 0o750 : 0o640 });
  }
  await chmod(join(source, "Contents/Resources"), 0o750);
  const targets: Array<{
    app: string;
    helper: string;
    context: any;
    calls: string[][];
    hooks: (run?: (command: string, args: string[]) => Promise<unknown>) => any;
  }> = [];
  for (const arch of ["arm64", "x64"]) {
    const appOutDir = join(directory, arch);
    const app = join(appOutDir, "code-shell.app");
    const helper = join(app, "Contents/Library/CodeShell Computer Use.app");
    for (const path of files) {
      await mkdir(dirname(join(helper, path)), { recursive: true });
      await link(join(source, path), join(helper, path));
    }
    await chmod(join(helper, "Contents/Resources"), 0o750);
    await symlink("fixture.txt", join(helper, "Contents/Resources/alias"));
    await symlink("alias", join(helper, "Contents/Resources/chained"));
    await symlink("Resources", join(helper, "Contents/SharedResources"));
    const calls: string[][] = [];
    const context = {
      appOutDir,
      arch,
      electronPlatformName: "darwin",
      packager: { appInfo: { productFilename: "code-shell" } },
    };
    const hooks = (
      run: (command: string, args: string[]) => Promise<unknown> = async (_command, args) => {
        calls.push(args);
      },
    ) =>
      createSigningHooks({
        env: {},
        run,
        supply: {
          packagingTarget: () => ({ platform: "darwin", arch }),
          packagedRuntimeDirectory: () => join(app, "Contents/Resources/runtimes/node"),
          stageRuntime: async () => {},
          refreshManifest: async () => {},
          verifyRuntime: async () => {},
        },
      });
    targets.push({ app, helper, context, calls, hooks });
  }
  return { directory, source, targets };
}

test.skipIf(process.platform === "win32")(
  "each target owns every helper file before the first codesign and later signing preserves the first target",
  async () => {
    const f = await fixture();
    for (const path of files)
      expect((await lstat(join(f.targets[0].helper, path))).ino).toBe(
        (await lstat(join(f.source, path))).ino,
      );
    for (const [index, target] of f.targets.entries()) {
      let first = true;
      await target
        .hooks(async (_command, _args) => {
          if (!first) return;
          first = false;
          for (const path of files) {
            const current = await lstat(join(target.helper, path));
            expect(current.ino).not.toBe((await lstat(join(f.source, path))).ino);
            expect(current.ino).not.toBe(
              (await lstat(join(f.targets[1 - index].helper, path))).ino,
            );
            expect(current.nlink).toBe(1);
            expect(current.mode & 0o777).toBe(path === main ? 0o750 : 0o640);
          }
          expect((await lstat(join(target.helper, "Contents/Resources"))).mode & 0o777).toBe(0o750);
          expect(await readlink(join(target.helper, "Contents/Resources/alias"))).toBe(
            "fixture.txt",
          );
          expect(await readlink(join(target.helper, "Contents/SharedResources"))).toBe("Resources");
          expect(await readlink(join(target.helper, "Contents/Resources/chained"))).toBe("alias");
          expect(
            await readFile(join(target.helper, "Contents/SharedResources/alias"), "utf8"),
          ).toBe(`source ${resource}`);
          // Model codesign's in-place resource-seal write using real file inodes.
          for (const path of [main, resource, seal])
            await writeFile(join(target.helper, path), `signed ${index}`);
        })
        .afterPack(target.context);
    }
    for (const path of [main, resource, seal]) {
      expect(await readFile(join(f.source, path), "utf8")).toBe(`source ${path}`);
      expect(await readFile(join(f.targets[0].helper, path), "utf8")).toBe("signed 0");
      expect(await readFile(join(f.targets[1].helper, path), "utf8")).toBe("signed 1");
    }
    for (const target of f.targets)
      expect(await readdir(dirname(target.helper))).toEqual(["CodeShell Computer Use.app"]);
  },
);

for (const kind of [
  "root symlink",
  "non-directory parent",
  "escaping symlink",
  "indirect escaping symlink",
  "symlink parent traversal",
  "symlink cycle",
  "fifo",
] as const) {
  test.skipIf(process.platform === "win32")(
    `unsafe ${kind} fails before codesign without replacing the target`,
    async () => {
      const f = await fixture();
      const target = f.targets[0];
      const bad = join(target.helper, "Contents/Resources/unsafe");
      if (kind === "root symlink") {
        await rm(target.helper, { recursive: true });
        await symlink(f.source, target.helper);
      } else if (kind === "non-directory parent") {
        await writeFile(join(target.helper, "Contents/Resources/plain-file"), "file");
        await symlink("plain-file/..", bad);
      } else if (kind === "escaping symlink") {
        await symlink(join(f.source, resource), bad);
      } else if (kind === "indirect escaping symlink") {
        await symlink(f.source, join(target.helper, "Contents/outside"));
        await symlink("../outside/Contents/Resources/fixture.txt", bad);
      } else if (kind === "symlink parent traversal") {
        await writeFile(join(dirname(target.helper), "outside"), "must remain outside");
        await symlink("..", join(target.helper, "Contents/Resources/shallow"));
        await symlink("shallow/../../outside", bad);
      } else if (kind === "symlink cycle") {
        await symlink("unsafe", bad);
      } else execFileSync("mkfifo", [bad]);
      const original = await lstat(target.helper);
      const siblings = await readdir(dirname(target.helper));
      await expect(target.hooks().afterPack(target.context)).rejects.toThrow();
      expect(target.calls).toEqual([]);
      expect((await lstat(target.helper)).ino).toBe(original.ino);
      expect(await readFile(join(f.source, resource), "utf8")).toBe(`source ${resource}`);
      expect(await readdir(dirname(target.helper))).toEqual(siblings);
    },
  );
}
