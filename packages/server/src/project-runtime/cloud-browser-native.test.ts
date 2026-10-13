import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("native Node browser authority isolates WebSockets and closes only revoked transports", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-browser-native-"));
  try {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    await symlink(join(packageRoot, "node_modules"), join(root, "node_modules"));
    const built = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("./control-server.ts", import.meta.url)),
        fileURLToPath(new URL("./__fixtures__/cloud-control-confinement.ts", import.meta.url)),
      ],
      outdir: root,
      naming: "[name].js",
      target: "node",
      external: [
        "ws",
        "@cjhyy/code-shell-core",
        "@cjhyy/code-shell-core/internal",
        "@cjhyy/code-shell-link",
        "@cjhyy/code-shell-web",
      ],
    });
    expect(built.success).toBe(true);
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "fixture.mjs"),
      `
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { installCloudControlConfinement } from './cloud-control-confinement.js';
const guard = installCloudControlConfinement({nativeWebSockets:true});
const { startProjectControlServer } = await import('./control-server.js');
const origin = 'https://native-cloud.invalid', accountOrigin = 'https://native-account.invalid';
const dataDir = await mkdtemp(join(tmpdir(), 'codeshell-browser-node-state-'));
const tickets = new Map(), active = new Set(), running = new Set(), peers = new Map();
const innerWss = new WebSocketServer({noServer:true});
const inner = createServer(async(req,res) => {
  let raw=''; for await(const chunk of req) raw+=chunk;
  assert.equal(req.headers.authorization,undefined);
  if(req.url==='/api/v1/auth/login') {
    const cookie='cs_hub_session='+randomBytes(32).toString('base64url');
    res.setHeader('Set-Cookie',cookie+'; HttpOnly'); res.end(JSON.stringify({authenticated:true}));
  } else if(req.url==='/api/v1/auth/logout') {
    for(const [peer,cookie] of peers) if(cookie===req.headers.cookie) peer.terminate();
    res.end('{}');
  } else res.end('{}');
});
inner.on('upgrade',(req,socket,head)=>innerWss.handleUpgrade(req,socket,head,ws=>{
  assert.equal(req.headers.authorization,undefined);
  assert.match(req.headers.cookie,/^cs_hub_session=/);
  peers.set(ws,req.headers.cookie); ws.on('error',()=>{}); ws.on('close',()=>peers.delete(ws));
  ws.on('message',data=>ws.send(data)); ws.send('ready');
}));
await new Promise(resolve=>inner.listen(0,'127.0.0.1',resolve));
const innerOrigin='http://127.0.0.1:'+inner.address().port; guard.allow(innerOrigin);
let control;
try {
  control = await startProjectControlServer({host:'127.0.0.1',port:0,dataDir,publicOrigin:origin,accountMode:'multi-account',
    accountAuthority:{accountOrigin,
      async redeem(ticket){const value=tickets.get(ticket);tickets.delete(ticket);if(!value||!active.has(value.rootSessionId))throw Error('private');return {...value};},
      async validate(value){if(!active.has(value.rootSessionId))throw Error('private');return {...value};}},
    provider:{async availability(){return {available:true};},async ensure(project){running.add(project.id);return {url:innerOrigin,username:project.runtimeUsername,password:project.runtimePassword,generation:project.generation};},async stop(project){running.delete(project.id);},async status(project){return running.has(project.id)?{state:'running',url:innerOrigin}:{state:'stopped'};},async close(){}}});
  guard.allow(control.url);
  const request=(path,body,cookie)=>new Promise((resolve,reject)=>{
    const raw=body===undefined?undefined:JSON.stringify(body);
    const request=httpRequest(control.url+path,{method:body===undefined?'GET':'POST',headers:{Host:new URL(origin).host,Origin:origin,'Sec-Fetch-Site':'same-origin',...(raw===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw)}),...(cookie?{Cookie:cookie}:{})}},response=>{
      let value='';response.on('data',chunk=>{value+=chunk;if(value.length>1048576)response.destroy(Error('fixture reply too large'));});response.on('error',reject);response.on('end',()=>{try{resolve({status:response.statusCode,value:JSON.parse(value),cookie:response.headers['set-cookie']?.[0]?.split(';',1)[0]});}catch(error){reject(error);}});
    });request.on('error',reject);request.end(raw);
  });
  const login=async()=>{
    const rootSessionId=randomUUID(),ticket=randomBytes(32).toString('base64url');active.add(rootSessionId);
    tickets.set(ticket,{accountOrigin,accountId:randomUUID(),sessionId:rootSessionId,rootSessionId,authorityEpoch:randomUUID(),expiresAt:Date.now()+900000});
    const result=await request('/api/v1/cloud-browser/session',{ticket});assert.equal(result.status,201);assert.equal(result.value.token,undefined);return {rootSessionId,cookie:result.cookie};};
  const a=await login(),b=await login();
  const create=async(grant,name)=>{const result=await request('/api/v1/projects',{name},grant.cookie);assert.equal(result.status,201);await request('/api/v1/projects/'+result.value.project.id+'/start',{},grant.cookie);return result.value.project.id;};
  const pa=await create(a,'A'),pb=await create(b,'B');
  const socket=(grant,project)=>{const ws=new WebSocket(control.url.replace('http:','ws:')+'/p/'+project+'/ws',{headers:{Host:new URL(origin).host,Origin:origin,'Sec-Fetch-Site':'same-origin',Cookie:grant.cookie}});ws.on('error',()=>{});return ws;};
  const foreign=socket(b,pa);await new Promise(resolve=>foreign.once('close',resolve));
  const open=async(grant,project)=>{const ws=socket(grant,project),ready=once(ws,'message');await once(ws,'open');assert.equal((await ready)[0].toString(),'ready');return ws;};
  const wa=await open(a,pa),wb=await open(b,pb),aClosed=once(wa,'close');
  active.delete(a.rootSessionId);
  assert.equal((await request('/api/v1/projects',undefined,a.cookie)).status,401);
  await aClosed;
  const echo=once(wb,'message');wb.send('B remains authorized');assert.equal((await echo)[0].toString(),'B remains authorized');
  assert.equal((await request('/p/'+pb+'/api/v1/sessions',undefined,b.cookie)).status,200);
  const bClosed=once(wb,'close');await control.close();await bClosed;
  assert.equal(running.size,0);
  process.stdout.write(JSON.stringify({ok:true,foreignRefused:true,revokedSocketClosed:true,otherSocketRetained:true,shutdownClosed:true}));
} finally {
  await control?.close();for(const peer of peers.keys())peer.terminate();innerWss.close();inner.closeAllConnections();
  await new Promise(resolve=>inner.close(resolve));await rm(dataDir,{recursive:true,force:true});guard.restore();
}
`,
    );
    const child = Bun.spawn(["node", join(root, "fixture.mjs")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        foreignRefused: true,
        revokedSocketClosed: true,
        otherSocketRetained: true,
        shutdownClosed: true,
      });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
