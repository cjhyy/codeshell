import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import cp from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

const sourceRoot = '/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell';
const serverPath = `${sourceRoot}/packages/desktop/src/main/browser-runtime/chrome-native-server.ts`;
const protocolPath = `${sourceRoot}/packages/desktop/src/main/browser-runtime/chrome-native-protocol.ts`;
const serverURL = pathToFileURL(serverPath).href;
const shutdownURL = pathToFileURL(`${sourceRoot}/packages/desktop/src/main/desktop-shutdown.ts`).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === serverURL && specifier === './chrome-native-protocol.js') {
    return { url: pathToFileURL(protocolPath).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}});

// Install before source imports. Only loopback listeners/peers created below are allowed.
const allowedPorts = new Set();
const nativeCreateConnection = net.createConnection;
net.createConnection = net.connect = function (options, ...args) {
  assert.equal(options.host, '127.0.0.1');
  assert(allowedPorts.has(options.port), 'connection must belong to this fixture');
  return nativeCreateConnection.call(net, options, ...args);
};
const nativeListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, ...args) {
  assert.equal(port, 0);
  assert.equal(host, '127.0.0.1');
  return nativeListen.call(this, port, host, ...args);
};
const deny = () => { throw new Error('fixture denied external network/native process'); };
http.request = http.get = https.request = https.get = deny;
globalThis.fetch = deny;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = deny;
syncBuiltinESMExports();

const { ChromeNativeBridgeServer } = await import(serverURL);
const { CODESHELL_CHROME_EXTENSION_ORIGIN } = await import(pathToFileURL(protocolPath).href);
const { createDesktopShutdownHandler } = await import(shutdownURL);
assert(homedir().includes('codeshell-native-smoke-'), 'maintained HOME isolation must be active');
const directory = await mkdtemp(join(tmpdir(), 'codeshell-remaining-hosts-native-state-'));
const peers = new Set();
const servers = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => access(file).then(() => true, () => false);
async function start(name) {
  const statePath = join(directory, name + '.json');
  const server = new ChromeNativeBridgeServer({ statePath });
  servers.add(server);
  await server.start();
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  allowedPorts.add(state.port);
  // Wait for the actual server-side accept, not only the client's TCP connect.
  const accepted = once(server.server, 'connection');
  const socket = net.createConnection({ host: '127.0.0.1', port: state.port });
  peers.add(socket);
  socket.on('error', () => {});
  await once(socket, 'connect');
  await accepted;
  return { server, socket, statePath, state };
}
try {
  const control = await start('authenticated');
  const authReply = once(control.socket, 'data');
  control.socket.write(JSON.stringify({ type: 'auth', token: control.state.token, origin: CODESHELL_CHROME_EXTENSION_ORIGIN }) + '\n');
  assert.equal(JSON.parse((await authReply)[0].toString()).ok, true);
  assert.equal(control.server.status().connected, true);
  const controlStart = Date.now();
  await control.server.stop();
  assert.equal(await exists(control.statePath), false);
  console.log(JSON.stringify({ case: 'authenticated-control', stopSettled: true, stateRemoved: true, elapsedMs: Date.now() - controlStart }));

  const failed = await start('unauthenticated-idle');
  assert.equal(failed.server.status().connected, false);
  let stopSettled = false;
  let cleanupSettled = false;
  let quitCount = 0;
  let preventCount = 0;
  let stopPromise;
  const errors = [];
  const handler = createDesktopShutdownHandler({
    ownsInstance: () => true,
    flushRenderers: async () => {},
    disposeOperationResolution: async () => {},
    cleanup: async () => {
      stopPromise = failed.server.stop().then(() => { stopSettled = true; });
      await Promise.allSettled([stopPromise]);
      cleanupSettled = true;
    },
    quit: () => { quitCount++; },
    onError: (phase, error) => errors.push({ phase, error: String(error) }),
  });
  const failedStart = Date.now();
  handler({ preventDefault: () => { preventCount++; } });
  await delay(1250);
  console.log(JSON.stringify({ case: 'unauthenticated-idle-before-peer-close', waitedMs: Date.now() - failedStart, stopSettled, cleanupSettled, quitCount, preventCount, stateStillPresent: await exists(failed.statePath), bridgeStatus: failed.server.status(), errors }));
  assert.equal(stopSettled, false);
  assert.equal(cleanupSettled, false);
  assert.equal(quitCount, 0);
  assert.equal(await exists(failed.statePath), true);
  failed.socket.destroy();
  await Promise.race([stopPromise, delay(2000).then(() => { throw new Error('stop did not settle after owned peer close'); })]);
  await delay(10);
  assert.equal(cleanupSettled, true);
  assert.equal(quitCount, 1);
  assert.equal(await exists(failed.statePath), false);
  console.log(JSON.stringify({ case: 'unauthenticated-idle-after-owned-peer-close', stopSettled, cleanupSettled, quitCount, stateRemoved: true, errors }));

  const invalid = await start('invalid-auth');
  const invalidReply = once(invalid.socket, 'data');
  invalid.socket.write(JSON.stringify({ type: 'auth', token: 'invalid', origin: CODESHELL_CHROME_EXTENSION_ORIGIN }) + '\n');
  assert.equal(JSON.parse((await invalidReply)[0].toString()).ok, false);
  await invalid.server.stop();
  assert.equal(await exists(invalid.statePath), false);
  console.log(JSON.stringify({ case: 'invalid-auth-control', stopSettled: true, stateRemoved: true }));
} finally {
  for (const peer of peers) peer.destroy();
  await Promise.allSettled([...servers].map(server => server.stop()));
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: 'owned sockets destroyed; source listeners stopped; temporary state removed' }));
}
