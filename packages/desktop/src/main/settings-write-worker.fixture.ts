/**
 * Test fixture (NOT shipped). A standalone process that writes one key into a
 * shared settings.json via writeSettings, many times. Spawned by
 * settings-service.crossproc.test.ts to prove the cross-process file lock
 * prevents lost updates when several real OS processes do read-modify-write on
 * the same file concurrently.
 *
 * argv: <cwd> <key> <iterations>
 */
import { writeSettings } from "./settings-service.js";

async function main() {
  const [, , cwd, key, iterStr] = process.argv;
  const iterations = Number(iterStr);
  for (let i = 0; i < iterations; i++) {
    // project scope → <cwd>/.code-shell/settings.json
    await writeSettings("project", { [key]: i }, cwd);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
