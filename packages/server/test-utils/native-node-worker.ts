import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Resolve the compiled exports that a native Node worker can actually load. */
export function nativeNodeWorkerFixture() {
  // Bun's root tsconfig maps package imports to TypeScript source. Resolve in
  // Node instead, keeping source aliases for the host side of these tests.
  const [workerUrl, codingUrl] = JSON.parse(
    execFileSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        'console.log(JSON.stringify([import.meta.resolve("@cjhyy/code-shell-core/bin/agent-server-stdio"), import.meta.resolve("@cjhyy/code-shell-capability-coding")]))',
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf8",
        timeout: 5000,
      },
    ),
  ) as [string, string];
  const compiledFile = (url: string, workspacePackage: string) => {
    const path = realpathSync(fileURLToPath(url));
    const dist = realpathSync(
      fileURLToPath(new URL(`../../${workspacePackage}/dist/`, import.meta.url)),
    );
    const withinDist = relative(dist, path);
    if (isAbsolute(withinDist) || withinDist.startsWith("..") || !path.endsWith(".js"))
      throw new Error(
        `Native worker fixture resolved outside its worktree compiled exports: ${path}`,
      );
    return path;
  };
  return {
    workerEntryPath: compiledFile(workerUrl, "core"),
    codingCapabilityModule: `${pathToFileURL(compiledFile(codingUrl, "coding")).href}#createCodingModule`,
  };
}
