import { runBunTestShard } from "./bun-test-completion.mjs";

try {
  await runBunTestShard(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
