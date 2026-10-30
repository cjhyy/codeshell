import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function runBoundedChild(command: string[], cwd: string, timeoutMs: number) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Native fixture child failed (${code}): ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

test.each([false, true])(
  "native account relay HTTP and WS stay grant-bound with passcode=%s",
  async (withPasscode) => {
    const temporary = await mkdtemp(join(tmpdir(), "account-relay-native-"));
    try {
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
      await symlink(join(packageRoot, "node_modules"), join(temporary, "node_modules"));
      await runBoundedChild(
        [
          process.execPath,
          "build",
          ...["remote-host-manager", "trusted-device-store", "access-passcode"].map((name) =>
            fileURLToPath(new URL(`${name}.ts`, import.meta.url)),
          ),
          fileURLToPath(new URL("../desktop-web/http-api.ts", import.meta.url)),
          resolve(packageRoot, "../../tests/helpers/network-fixture.ts"),
          "--target=node",
          `--outdir=${temporary}`,
          "--entry-naming=[name].js",
          "--external=ws",
          "--external=@cjhyy/code-shell-core",
          "--external=@cjhyy/code-shell-core/internal",
        ],
        packageRoot,
        10_000,
      );
      await writeFile(join(temporary, "package.json"), '{"type":"module"}');
      await writeFile(
        join(temporary, "fixture.mjs"),
        String.raw`
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import { WebSocket } from "ws";
import { installFixtureNetworkGuard } from "./network-fixture.js";
const guard = installFixtureNetworkGuard();
const guardedRequest = http.request;
http.request = (options, ...args) => {
  if (options?.headers?.Upgrade === "websocket") {
    const {createConnection: _connector, ...direct} = options;
    return guardedRequest(direct, ...args);
  }
  return guardedRequest(options, ...args);
};
const { RemoteHostManager } = await import("./remote-host-manager.js");
const { TrustedDeviceStore } = await import("./trusted-device-store.js");
const { AccessPasscode } = await import("./access-passcode.js");
const { createDesktopWebApi } = await import("./http-api.js");
const withPasscode = ${JSON.stringify(withPasscode)};
const path = new URL("devices.json", import.meta.url).pathname;
const devices = new TrustedDeviceStore(path);
const api = createDesktopWebApi({
  devices, dataDir:new URL("data",import.meta.url).pathname,
  sessionRootDir:new URL("sessions",import.meta.url).pathname,
  resolveWorkspace:() => undefined,
  withConfigurationMutation:async (_cwd,write) => write(),
  isRunning:() => false,
});
let redeemed = 0;
const events = [];
const host = new RemoteHostManager({
  devices,
  webApi:api,
  onClientEvent: (event, socket) => {
    events.push(event);
    socket.send(JSON.stringify({type:"fixture.echo",deviceId:event.deviceId}));
  },
});
host.on("host-error", error => { throw error; });
host.setAccountRelayAccess({
  hostId:"host-a", environmentId:"env-a",accountId:"account-a",
  redeem:async () => {
    redeemed++;
    return {authorizationId:"authorization-a",accountId:"account-a",rootSessionId:"root-a",hostId:"host-a",environmentId:"env-a",leaseId:"lease-a",expiresAt:Date.now()+1200};
  },
  listProjects:async () => [{id:"real-project",name:"Actual project",path:"/actual/project"}],
});
const passcode = new AccessPasscode({filePath:new URL("access.json",import.meta.url).pathname});
if (withPasscode) passcode.set("synthetic-passcode");
const started = await host.start({host:"127.0.0.1",port:0,mode:"relay",...(withPasscode?{passcode}:{})});
guard.allowOrigin(started.url);
const lan = new RemoteHostManager({devices,webApi:api,onClientEvent:() => {throw Error("Unexpected LAN dispatch");}});
const local = await lan.start({host:"127.0.0.1",port:0});
guard.allowOrigin(local.url);
const origin = "https://computer.example.test";
host.setPublicBaseUrl(origin);
const request = (pathname, method="GET", headers={}, input, ordinary=false) => new Promise((resolve,reject) => {
  const body = input === undefined ? undefined : JSON.stringify(input);
  const targetOrigin = ordinary ? local.url : origin;
  const req = http.request((ordinary?local.url:started.url)+pathname, {method,headers:{Host:new URL(targetOrigin).host,Origin:targetOrigin,...(withPasscode?{"X-Access-Passcode":"synthetic-passcode"}:{}),...(body?{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}:{}),...headers}}, response => {
    let text="";
    response.on("data", chunk => text+=chunk);
    response.on("end", () => resolve({status:response.statusCode,headers:response.headers,body:JSON.parse(text)}));
  });
  req.on("error",reject);
  req.setTimeout(2000,() => req.destroy(new Error("Native fixture request deadline")));
  req.end(body);
});
let socket;
let localSocket;
try {
  assert.equal((await request("/api/v1/relay/projects")).status,401);
  assert.equal((await request("/api/v1/relay/session","POST",{Origin:"https://other.example.test"},{handoff:"a".repeat(43)})).status,403);
  assert.equal(redeemed,0);
  const handshake = await request("/api/v1/relay/session","POST",{}, {handoff:"a".repeat(43)});
  assert.equal(handshake.status,200);
  const grant = handshake.body;
  assert.equal(grant.hostId,"host-a");
  assert.equal((await request("/api/v1/relay/session","POST",{}, {handoff:"a".repeat(43)})).status,401);
  assert.equal(redeemed,1);
  assert.equal(existsSync(path),false);
  const headers = {"X-CodeShell-Host-Access":grant.hostAccessToken};
  const credential = {deviceId:grant.deviceId,secretHash:grant.secretHash};
  const browser = await request("/api/v1/desktop/session","POST",headers,credential);
  assert.equal(browser.status,200);
  const cookie = browser.headers["set-cookie"][0].split(";",1)[0];
  assert.equal((await request("/api/v1/auth/status","GET",{...headers,Cookie:cookie})).body.authenticated,true);
  assert.equal((await request("/api/v1/desktop/session","POST",{},credential,true)).status,401);
  assert.equal((await request("/api/v1/desktop/session","POST",{},credential)).status,401);
  assert.notEqual((await request("/api/v1/auth/status","GET",{Cookie:cookie})).body.authenticated,true);
  await request("/api/v1/auth/logout","POST",{Cookie:cookie});
  assert.equal((await request("/api/v1/auth/status","GET",{...headers,Cookie:cookie})).body.authenticated,true);
  assert.equal((await request("/api/v1/auth/status","GET",{Cookie:cookie},undefined,true)).body.authenticated,false);
  assert.equal((await request("/api/v1/environment","GET",{Cookie:cookie},undefined,true)).status,401);
  await request("/api/v1/auth/logout","POST",{Cookie:cookie},undefined,true);
  assert.equal((await request("/api/v1/auth/status","GET",{...headers,Cookie:cookie})).body.authenticated,true);
  localSocket = new WebSocket(local.url.replace("http:","ws:")+"/ws");
  localSocket.on("error",()=>{});
  await once(localSocket,"open",{signal:AbortSignal.timeout(2000)});
  const localReply = once(localSocket,"message",{signal:AbortSignal.timeout(2000)});
  localSocket.send(JSON.stringify({type:"auth.device",...credential}));
  assert.equal(JSON.parse(String((await localReply)[0])).type,"auth.failed");
  assert.equal(lan.handleClientEvent({type:"auth.device",...credential}).type,"auth.failed");
  const projects = await request("/api/v1/relay/projects","GET",headers);
  assert.deepEqual(projects.body,{hostId:"host-a",environmentId:"env-a",projects:[{id:"real-project",name:"Actual project",path:"/actual/project"}]});
  assert.equal((await request("/api/v1/relay/projects","GET",{...headers,Host:"wrong.example.test"})).status,401);
  socket = new WebSocket(started.url.replace("http:","ws:")+"/ws", {headers:{Host:new URL(origin).host,Origin:origin,...headers}});
  socket.on("error",()=>{});
  await once(socket,"open",{signal:AbortSignal.timeout(2000)});
  const exchange = async event => {
    const reply = once(socket,"message",{signal:AbortSignal.timeout(2000)});
    socket.send(JSON.stringify(event));
    return JSON.parse(String((await reply)[0]));
  };
  assert.equal((await exchange({type:"auth.device",deviceId:"foreign-device",secretHash:grant.secretHash})).type,"auth.failed");
  assert.equal((await exchange({type:"auth.device",deviceId:grant.deviceId,secretHash:grant.secretHash})).type,"auth.ok");
  const pairing = host.createPairingUrl();
  assert.equal((await exchange({type:"pair.complete",token:pairing.token,name:"Promoted account",secretHash:grant.secretHash})).type,"auth.failed");
  assert.equal(existsSync(path),false);
  assert.equal((await exchange({type:"session.list"})).deviceId,grant.deviceId);
  assert.equal(events.length,1);
  if (withPasscode) {
    const passcodeSocket = new WebSocket(started.url.replace("http:","ws:")+"/ws", {headers:{Host:new URL(origin).host,Origin:origin,"X-Access-Passcode":"synthetic-passcode"}});
    passcodeSocket.on("error",()=>{});
    try {
      await once(passcodeSocket,"open",{signal:AbortSignal.timeout(2000)});
      const reply = once(passcodeSocket,"message",{signal:AbortSignal.timeout(2000)});
      passcodeSocket.send(JSON.stringify({type:"auth.device",...credential}));
      assert.equal(JSON.parse(String((await reply)[0])).type,"auth.failed");
    } finally {
      passcodeSocket.terminate();
    }
  }
  await once(socket,"close",{signal:AbortSignal.timeout(2000)});
  assert.equal((await request("/api/v1/relay/projects","GET",headers)).status,401);
  assert.equal(devices.authenticate(grant.deviceId,grant.secretHash),undefined);
  assert.equal((await request("/api/v1/auth/status","GET",{Cookie:cookie},undefined,true)).body.authenticated,false);
  assert.deepEqual(host.onlineDeviceIds(),[]);
  console.log(JSON.stringify({ok:true,httpAndWs:true,singleUse:true,expired:true,noPersistentCredential:true}));
} finally {
  socket?.terminate();
  localSocket?.terminate();
  await host.stop();
  await lan.stop();
  guard.restore();
}
`,
      );
      const stdout = await runBoundedChild(
        ["node", join(temporary, "fixture.mjs")],
        temporary,
        10_000,
      );
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        httpAndWs: true,
        singleUse: true,
        expired: true,
        noPersistentCredential: true,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  25_000,
);
