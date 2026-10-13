import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const isolation = await import(repo + '/scripts/runtime-cost-smoke-isolation.mjs');
isolation.installLocalNetworkGuard('http://127.0.0.1:9');
await import(repo + '/packages/core/src/protocol/server.askuser-async.test.ts');
await import(repo + '/packages/core/src/protocol/server.askuser-session-isolation.test.ts');
await import(repo + '/packages/desktop/src/main/cc-room/approval-bridge.integration.test.ts');
