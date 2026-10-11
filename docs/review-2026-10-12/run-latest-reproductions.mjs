import { readdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const baseline = "a66f4ef291f304ee4df9da8095a90671d9a8f140";
if (spawnSync("git", ["merge-base", "--is-ancestor", baseline, "HEAD"], { cwd: root }).status !== 0) {
  console.error("These fixtures require the 0.9.33 review snapshot or a descendant. Copy this report directory into that isolated checkout first; do not switch the original report checkout.");
  process.exit(2);
}
function collect(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? collect(join(folder, entry.name)) : /\.test\.(ts|tsx)$/.test(entry.name) ? [join(folder, entry.name)] : [],
  );
}
const results = [];
for (const file of collect(join(directory, "latest-reproductions")).sort()) {
  const log = file + ".log";
  const descriptor = openSync(log, "w");
  const child = spawn(process.execPath, ["scripts/run-bun-test-shard.mjs", "--timeout", "30000", file], {
    cwd: root, stdio: ["ignore", descriptor, descriptor],
  });
  const result = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  });
  closeSync(descriptor);
  results.push({ baseline, file: relative(root, file), log: relative(root, log), ...result });
  console.log(`${result.code === 0 ? "PASS" : "FAILED"} ${relative(root, file)}`);
  writeFileSync(join(directory, "validation/latest-reproduction-results.json"), JSON.stringify(results, null, 2) + "\n");
}
process.exitCode = results.some((result) => result.code !== 0 || result.signal) ? 1 : 0;
