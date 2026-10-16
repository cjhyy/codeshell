import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import {
  DESKTOP_LINK_PROVIDER_BUNDLE,
  desktopLinkProviderModuleUrl,
} from "../src/main/link-provider-module.js";
import { buildWorkerLinkProviders } from "./build-worker-link-providers.js";

const here = dirname(fileURLToPath(import.meta.url));
const sourceDesktopRoot = resolve(here, "..");
const repoRoot = resolve(sourceDesktopRoot, "../..");

/** Explicit packaging smoke: requires real predist production dependency closures. */
export async function smokeWorkerLinkProviders({
  desktopRoot = sourceDesktopRoot,
}: { desktopRoot?: string } = {}) {
  desktopRoot = await realpath(desktopRoot);
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-link-packaged-smoke-")));
  try {
    const appPath = join(root, "应用 Code Shell.app", "Contents/Resources/app.asar");
    const fromRepository = relative(repoRoot, appPath);
    if (!fromRepository.startsWith("..") || isAbsolute(fromRepository))
      throw new Error("Worker Link smoke application must be outside the repository");
    await mkdir(join(appPath, "node_modules/@cjhyy"), { recursive: true });
    for (const name of ["code-shell-core", "code-shell-link"]) {
      const source = join(desktopRoot, "node_modules/@cjhyy", name);
      const info = await lstat(source).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink())
        throw new Error(
          `Worker Link packaging smoke requires a materialized ${name}; run Desktop predist first or pass --desktop-root <materialized-app-directory>`,
        );
      if (
        name === "code-shell-core" &&
        !(await lstat(join(source, "node_modules")).catch(() => undefined))?.isDirectory()
      )
        throw new Error("Materialized Core is missing its production dependency closure");
      await cp(source, join(appPath, "node_modules/@cjhyy", name), {
        recursive: true,
        dereference: true,
      });
    }
    const outfile = join(appPath, DESKTOP_LINK_PROVIDER_BUNDLE);
    const built = await buildWorkerLinkProviders({ desktopRoot: sourceDesktopRoot, outfile });
    await cp(
      join(here, "__fixtures__/worker-link-provider-bundle.mjs"),
      join(appPath, "probe.mjs"),
    );
    const url = desktopLinkProviderModuleUrl(
      { isPackaged: true, getAppPath: () => appPath },
      () => {
        throw new Error("Packaged smoke cannot use a development workspace resolver");
      },
    );
    const child = spawnSync("node", [join(appPath, "probe.mjs"), url], {
      cwd: appPath,
      env: createBunTestEnvironment(process.env, root),
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    if (child.error || child.status !== 0 || child.signal)
      throw new Error(
        `Isolated packaged Link provider import failed (${child.error ?? child.signal ?? child.status}):\n${child.stderr}`,
      );
    const receipt = JSON.parse(child.stdout);
    return {
      ...receipt,
      bundleSHA256: createHash("sha256")
        .update(await readFile(outfile))
        .digest("hex"),
      bundleExports: Object.values(built.metafile!.outputs)[0]!.exports,
      materializedDesktopRoot: desktopRoot,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const options = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index]!;
    const value = process.argv[index + 1];
    if (!value || !["--desktop-root", "--receipt"].includes(flag) || options.has(flag))
      throw new Error(
        "Usage: smoke-worker-link-providers.ts [--desktop-root <materialized-app-directory>] [--receipt <new-file>]",
      );
    options.set(flag, value);
  }
  const receipt = await smokeWorkerLinkProviders({ desktopRoot: options.get("--desktop-root") });
  const output = JSON.stringify(receipt, null, 2) + "\n";
  const receiptPath = options.get("--receipt");
  if (receiptPath) await writeFile(resolve(receiptPath), output, { flag: "wx", mode: 0o600 });
  // eslint-disable-next-line no-console
  console.log(output.trimEnd());
}
