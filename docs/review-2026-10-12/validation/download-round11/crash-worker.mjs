import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [repo, origin, destination, helper, sessionId] = process.argv.slice(2);
const { installLocalNetworkGuard } = await import(
  pathToFileURL(join(repo, "scripts/runtime-cost-smoke-isolation.mjs")).href
);
installLocalNetworkGuard(origin);
const { backgroundShellManager } = await import(
  pathToFileURL(join(repo, "packages/core/dist/runtime/background-shell.js")).href
);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const command = `exec ${[process.execPath, helper, origin, destination, repo].map(quote).join(" ")}`;
const started = backgroundShellManager.spawnBackground({
  sessionId,
  command,
  cwd: repo,
  shell: "/bin/sh",
});
if (!started.ok) throw new Error(started.error);
process.stdout.write(JSON.stringify(backgroundShellManager.get(started.shellId)) + "\n");
setInterval(() => {}, 1000);
