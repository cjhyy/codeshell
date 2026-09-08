import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("native Node shutdown revokes before stopping and accepts only confirmed runtime termination", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "codeshell-control-shutdown-"));
  try {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    await symlink(join(packageRoot, "node_modules"), join(temporary, "node_modules"));
    const built = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("./control-server.ts", import.meta.url)),
        fileURLToPath(new URL("./registry.ts", import.meta.url)),
      ],
      outdir: temporary,
      target: "node",
      external: ["ws", "@cjhyy/code-shell-core/internal"],
    });
    expect(built.success).toBe(true);
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    await writeFile(
      join(temporary, "fixture.mjs"),
      `
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { startProjectControlServer } from './control-server.js';
import { ProjectRegistry } from './registry.js';
const mode = process.argv[2];
const events = [];
let running = false;
let control;
let innerClosed;
const inner = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  if (req.url === '/api/v1/auth/login') {
    res.setHeader('Set-Cookie', 'cs_hub_session='+'a'.repeat(43)+'; HttpOnly');
    res.end(JSON.stringify({ authenticated: true }));
  } else if (req.url === '/api/v1/auth/logout') {
    events.push('logout-request');
    // This makes concurrent transport.close()/provider.stop() reproducibly
    // shut down the inner listener before its logout reply can finish.
    await new Promise(resolve => setTimeout(resolve, 75));
    if (mode !== 'normal') {
      events.push('logout-failed');
      req.socket.destroy();
    } else {
      events.push('logout-complete');
      res.end('{}');
    }
  } else {
    assert.match(req.headers.cookie ?? '', /^cs_hub_session=/);
    res.end(JSON.stringify({ ok: true }));
  }
});
function closeInner() {
  return innerClosed ??= new Promise(resolve => {
    inner.closeAllConnections();
    inner.close(resolve);
  });
}
inner.listen(0, '127.0.0.1');
await once(inner, 'listening');
const innerUrl = 'http://127.0.0.1:' + inner.address().port;
const dataDir = join(process.cwd(), mode);
const provider = {
  availability: async () => ({ available: true }),
  async ensure(record) {
    running = true;
    return { url: innerUrl, username: record.runtimeUsername, password: record.runtimePassword, generation: record.generation };
  },
  async status() { return running ? { state: 'running', url: innerUrl } : { state: 'stopped' }; },
  async stop() {
    events.push('stop');
    if (mode === 'stop-failure') throw new Error('Docker termination failed');
    await closeInner();
    running = false;
  },
  async close() { events.push('provider-close'); },
};
try {
  control = await startProjectControlServer({ host: '127.0.0.1', port: 0, dataDir, provider });
  const setup = await fetch(control.url+'/api/v1/auth/setup', {
    method:'POST', headers:{'Content-Type':'application/json', Origin:control.url},
    body:JSON.stringify({token:control.bootstrapToken,username:'alice',password:'Shutdown-test-password-23940'})
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  await setup.arrayBuffer();
  async function request(path, method='GET', body) {
    const response=await fetch(control.url+path, {
      method, headers:{Cookie:cookie,Origin:control.url,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    assert.ok(response.ok, 'fixture HTTP '+response.status);
    return response.json();
  }
  const { project } = await request('/api/v1/projects','POST',{name:'Shutdown test'});
  await request('/api/v1/projects/'+project.id+'/start','POST',{});
  assert.equal((await request('/p/'+project.id+'/api/v1/sessions')).ok, true);
  const shutdown = new Promise(resolve => {
    process.once('SIGTERM', () => {
      void (async () => {
        const first = control.close();
        assert.equal(control.close(), first);
        let error;
        try { await first; } catch (failure) { error = failure.message; }
        // The listener and controller lock must be released on both paths.
        await assert.rejects(fetch(control.url+'/health'));
        const registry = new ProjectRegistry(dataDir);
        const status = registry.get('alice', project.id).status;
        registry.close();
        if (error) process.exitCode = 1;
        process.stdout.write(JSON.stringify({events,running,status,error:error??null}));
      })().then(resolve, failure => { console.error(failure); process.exitCode=2; resolve(); });
    });
  });
  process.kill(process.pid, 'SIGTERM');
  await shutdown;
} finally {
  await control?.close().catch(() => {});
  await closeInner();
}
`,
    );
    for (const mode of ["normal", "logout-failure", "stop-failure"]) {
      const child = Bun.spawn(["node", join(temporary, "fixture.mjs"), mode], {
        cwd: temporary,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 10_000);
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).toBe("");
        const result = JSON.parse(stdout);
        expect(result.events).toEqual([
          "logout-request",
          mode === "normal" ? "logout-complete" : "logout-failed",
          "stop",
          "provider-close",
        ]);
        if (mode === "stop-failure") {
          expect(exit).toBe(1);
          expect(result.running).toBe(true);
          expect(result.status).toBe("error");
          expect(result.error).toContain("尚未确认停止");
        } else {
          expect(exit).toBe(0);
          expect(result.running).toBe(false);
          expect(result.status).toBe("stopped");
          expect(result.error).toBeNull();
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 35_000);
