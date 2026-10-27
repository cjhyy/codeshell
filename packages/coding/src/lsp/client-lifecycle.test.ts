import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "codeshell-lsp-lifecycle-"));
  // Exercise native Node streams: Bun's child-process shim can conceal EPIPE.
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "client.ts"), join(import.meta.dir, "manager.ts")],
    outdir: directory,
    target: "node",
  });
  expect(build.success).toBe(true);
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(
    join(directory, "language-server.cjs"),
    `
    let pending = Buffer.alloc(0);
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const header = pending.indexOf('\\r\\n\\r\\n');
        if (header < 0) return;
        const size = Number(pending.subarray(0, header).toString().match(/Content-Length: (\\d+)/)[1]);
        if (pending.length < header + 4 + size) return;
        const message = JSON.parse(pending.subarray(header + 4, header + 4 + size).toString());
        pending = pending.subarray(header + 4 + size);
        if (message.method === 'crash') process.exit(12);
        if (message.method === 'exit') process.exit(0);
        if (message.id !== undefined) {
          const body = JSON.stringify({jsonrpc: '2.0', id: message.id, result: {pid: process.pid, capabilities: {}}});
          process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
        }
      }
    });
  `,
  );
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function nativeFixture(name: string, script: string) {
  const file = join(directory, `${name}.mjs`);
  await writeFile(
    file,
    `
    import assert from 'node:assert/strict';
    import {LSPClient} from './client.js';
    import {LSPServerManager} from './manager.js';
    import {fileURLToPath} from 'node:url';
    const root = fileURLToPath(new URL('.', import.meta.url));
    const server = fileURLToPath(new URL('./language-server.cjs', import.meta.url));
    function manager() {
      const result = new LSPServerManager(root);
      // Replace only the test manager's configuration; no PATH mutation or live LSP binary.
      result.servers.get('typescript').config = {
        ...result.servers.get('typescript').config, command: process.execPath, args: [server],
      };
      return result;
    }
    // Production hosts own their event loop; LSP intentionally unrefs its child.
    const deadline = setTimeout(() => { console.error('LSP fixture timed out'); process.exit(2); }, 10_000);
    try {
      ${script}
      console.log('LSP_LIFECYCLE_OK');
    } finally { clearTimeout(deadline); }
  `,
  );
  const child = Bun.spawn(["node", file], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("LSP_LIFECYCLE_OK");
}

test("exited language servers fail pending work and restart once for concurrent callers", async () => {
  await nativeFixture(
    "restart",
    `
    const m = manager();
    try {
      const first = await m.getClient('typescript');
      assert(first?.isInitialized);
      const firstPid = (await first.request('ping')).pid;
      await assert.rejects(first.request('crash'), /exited/);
      assert.equal(first.isAlive, false);
      assert.equal(first.isInitialized, false);
      assert.equal(m.isConnected(), false);
      assert.equal(m.listServers().find(s => s.name === 'typescript').state, 'error');
      await assert.rejects(first.request('ping'), /exited/);
      const [second, same] = await Promise.all([m.getClient('typescript'), m.getClient('typescript')]);
      assert(second?.isInitialized);
      assert.notEqual(second, first);
      assert.equal(second, same);
      assert.notEqual((await second.request('ping')).pid, firstPid);
      assert.equal(m.listServers().find(s => s.name === 'typescript').state, 'ready');
    } finally { await m.shutdownAll(); }
  `,
  );
});

test("failed spawn rejects start without an uncaught child-process error", async () => {
  await nativeFixture(
    "missing",
    `
    const client = new LSPClient(root + '/missing-lsp');
    try {
      await assert.rejects(client.start(), /ENOENT/);
      assert.equal(client.isAlive, false);
      await assert.rejects(client.request('initialize'), /ENOENT/);
    } finally { await client.shutdown(); }
  `,
  );
});

test("early CLI exit during a large write settles the request without unhandled EPIPE", async () => {
  await nativeFixture(
    "pipe",
    `
    const client = new LSPClient(process.execPath, ['-e', 'process.exit(1)']);
    try {
      await client.start();
      await assert.rejects(client.request('initialize', {text: 'x'.repeat(2 * 1024 * 1024)}));
      assert.equal(client.isAlive, false);
      await assert.rejects(client.request('ping'));
    } finally { await client.shutdown(); }
  `,
  );
});

test("shutdown during startup cannot publish a ready client afterward", async () => {
  await nativeFixture(
    "startup-stop",
    `
    const m = manager();
    const starting = m.getClient('typescript');
    await m.shutdownAll();
    assert.equal(await starting, undefined);
    assert.equal(m.isConnected(), false);
    assert.equal(m.listServers().find(s => s.name === 'typescript').state, 'stopped');
  `,
  );
});
