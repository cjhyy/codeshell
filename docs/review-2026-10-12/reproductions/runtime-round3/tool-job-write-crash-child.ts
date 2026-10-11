import { chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { PanelToolJobService } from "../../../../packages/server/src/panels/tool-jobs.ts";
const root = process.argv[2]!;
const scope = { appId: "fixture", projectPath: root, revision: "r1" };
const service = new PanelToolJobService({
  rootDir: root,
  execute: async (_job, context) => {
    await chmod(dirname(context.workDir), 0o500);
    return { output: "finished before Host exited" };
  },
});
const job = await service.start(scope, {
  entry: { name: "fixture", sha256: "a".repeat(64) },
  input: {},
  recovery: "retry",
});
const deadline = Date.now() + 3000;
while (
  Date.now() < deadline &&
  (!(service as any).jobs.has(job.id) ||
    (service as any).active.size ||
    (await service.get(scope, job.id)).status === "queued")
)
  await Bun.sleep(5);
console.log(JSON.stringify({ id: job.id, status: (await service.get(scope, job.id)).status }));
// Intentionally emulate a Host process ending without its graceful service shutdown.
process.exit(0);
