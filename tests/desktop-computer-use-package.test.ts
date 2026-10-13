import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyComputerUsePackage } from "../packages/desktop/scripts/verify-computer-use-package.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "computer-use-package-"));
  directories.push(directory);
  const app = join(directory, "code-shell.app");
  const resources = join(app, "Contents/Resources");
  const driver = join(resources, "cua-driver/cua-driver");
  const permissions = join(resources, "computer-use/codeshell-permissions");
  for (const executable of [driver, permissions]) {
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "fixture executable", { mode: 0o755 });
  }
  const license = join(resources, "cua-driver/LICENSE");
  await writeFile(
    license,
    await readFile(new URL("../packages/desktop/resources/cua-driver.LICENSE", import.meta.url)),
  );
  const calls: { command: string; args: string[] }[] = [];
  const outputs = new Map([
    [driver, "cua-driver 0.34.1\n"],
    [permissions, "codeshell-permissions 1\n"],
  ]);
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "/usr/bin/lipo") return { stdout: "x86_64 arm64\n" };
    return { stdout: outputs.get(command) ?? "" };
  };
  return { app, driver, permissions, license, calls, outputs, run };
}

describe("packaged computer use release acceptance", () => {
  test("checks both universal executables, pinned versions and the final deep signature", async () => {
    const f = await fixture();
    expect(await verifyComputerUsePackage(f.app, { run: f.run })).toEqual({
      app: f.app,
      driverVersion: "0.34.1",
      permissionsVersion: 1,
      architectures: ["arm64", "x64"],
    });
    expect(
      f.calls.filter(({ command }) => command === f.driver || command === f.permissions),
    ).toEqual([
      { command: f.driver, args: ["--version"] },
      { command: f.permissions, args: ["--version"] },
    ]);
    expect(f.calls.filter(({ command }) => command === "/usr/bin/codesign")).toEqual([
      { command: "/usr/bin/codesign", args: ["--verify", "--strict", f.driver] },
      { command: "/usr/bin/codesign", args: ["--verify", "--strict", f.permissions] },
      { command: "/usr/bin/codesign", args: ["--verify", "--deep", "--strict", f.app] },
    ]);
  });

  test("refuses a bundle missing the driver before running any command", async () => {
    const f = await fixture();
    await rm(f.driver);
    await expect(verifyComputerUsePackage(f.app, { run: f.run })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("refuses a non-executable helper", async () => {
    const f = await fixture();
    await chmod(f.permissions, 0o644);
    await expect(verifyComputerUsePackage(f.app, { run: f.run })).rejects.toThrow();
    expect(f.calls.some(({ command }) => command === f.permissions)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("refuses a driver symlink", async () => {
    const f = await fixture();
    await rm(f.driver);
    await symlink(f.permissions, f.driver);
    await expect(verifyComputerUsePackage(f.app, { run: f.run })).rejects.toThrow(
      "missing or empty",
    );
    expect(f.calls).toEqual([]);
  });

  test("refuses a changed or substituted license", async () => {
    const f = await fixture();
    await writeFile(f.license, "incorrect license");
    await expect(verifyComputerUsePackage(f.app, { run: f.run })).rejects.toThrow(
      "license checksum mismatch",
    );
  });

  test("refuses a single-architecture executable", async () => {
    const f = await fixture();
    await expect(
      verifyComputerUsePackage(f.app, {
        run: async (command, args) =>
          command === "/usr/bin/lipo" ? { stdout: "arm64\n" } : f.run(command, args),
      }),
    ).rejects.toThrow("not universal");
  });

  test("refuses mismatched driver or helper versions", async () => {
    for (const executable of ["driver", "permissions"] as const) {
      const f = await fixture();
      f.outputs.set(
        f[executable],
        executable === "driver" ? "cua-driver 0.34.0" : "codeshell-permissions 2",
      );
      await expect(verifyComputerUsePackage(f.app, { run: f.run })).rejects.toThrow(
        "version mismatch",
      );
    }
  });

  test("propagates a failed final signature check", async () => {
    const f = await fixture();
    await expect(
      verifyComputerUsePackage(f.app, {
        run: async (command, args) => {
          if (command === "/usr/bin/codesign" && args.includes("--deep"))
            throw new Error("bundle signature invalid");
          return f.run(command, args);
        },
      }),
    ).rejects.toThrow("bundle signature invalid");
  });
});
