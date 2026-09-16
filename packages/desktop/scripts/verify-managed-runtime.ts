import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createManagedRuntimeProvider } from "@cjhyy/code-shell-core/internal";

const exec = promisify(execFile);

/** Run against unpacked/package resources without relying on a system node or npm. */
export async function verifyManagedRuntime(root: string) {
  const runtime = await createManagedRuntimeProvider({ root: resolve(root) }).resolve("node");
  if (!runtime) throw new Error("The application has no bundled Node runtime");
  const env: NodeJS.ProcessEnv = { PATH: "" };
  // Windows needs these for process startup; avoid inheriting Node injection variables.
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"])
    if (process.env[key]) env[key] = process.env[key];
  const source = `
    import { spawnSync } from "node:child_process";
    import { createHash } from "node:crypto";
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      "process.stdout.write(JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform}))"
    ], { env: process.env, encoding: "utf8", timeout: 10000 });
    if (child.error || child.status !== 0) throw child.error ?? new Error(child.stderr);
    const input = spawnSync(process.execPath, ["--input-type=module", "-e",
      "let value=''; for await (const part of process.stdin) value+=part; process.stdout.write(JSON.stringify(JSON.parse(value)))"
    ], { input: JSON.stringify({ok:true}), env: process.env, encoding: "utf8", timeout: 10000 });
    if (input.error || input.status !== 0) throw input.error ?? new Error(input.stderr);
    process.stdout.write(JSON.stringify({
      version:process.versions.node, platform:process.platform, arch:process.arch,
      path:process.env.PATH, child:JSON.parse(child.stdout), stdin:JSON.parse(input.stdout),
      crypto:createHash("sha256").update("managed-runtime").digest("hex")
    }));
  `;
  const { stdout } = await exec(runtime.executablePath, ["--input-type=module", "-e", source], {
    env,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  const result = JSON.parse(stdout);
  if (
    result.version !== runtime.version ||
    result.platform !== runtime.platform ||
    result.arch !== runtime.arch ||
    result.path !== "" ||
    result.child.version !== runtime.version ||
    result.child.platform !== runtime.platform ||
    result.child.arch !== runtime.arch ||
    result.stdin.ok !== true
  )
    throw new Error("Bundled Node runtime failed the empty-PATH acceptance check");
  return {
    runtime: runtime.id,
    version: runtime.version,
    platform: runtime.platform,
    arch: runtime.arch,
  };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Usage: bun scripts/verify-managed-runtime.ts <runtimes-directory>");
  console.log(JSON.stringify(await verifyManagedRuntime(root)));
}
