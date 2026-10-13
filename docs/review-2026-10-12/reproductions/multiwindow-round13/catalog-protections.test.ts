// Read-only existing contract checks, under the guarded runner and pre-import guard.
const repo = process.cwd();
if (!process.env.CODE_SHELL_TEST_HOME) throw new Error("guarded HOME required");
const isolation = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
isolation.installLocalNetworkGuard("http://127.0.0.1:9");
await import(repo + "/packages/desktop/src/main/session-catalog-store.test.ts");
await import(repo + "/packages/desktop/src/main/session-catalog-ipc.test.ts");
await import(repo + "/packages/desktop/src/renderer/sessionPersistence.test.ts");
await import(repo + "/packages/desktop/src/main/panel-host-routing.test.ts");
