import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("native Node proxy streams HTTP and WS and revokes the real socket pair", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "codeshell-project-proxy-node-"));
  try {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    await symlink(join(packageRoot, "node_modules"), join(temporary, "node_modules"));
    const built = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./proxy.ts", import.meta.url))],
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
import { WebSocket, WebSocketServer, Sender } from 'ws';
import { createProjectRuntimeProxy } from './proxy.js';
const origin = 'https://codeshell.example';
const project = '9f6ebd0c-5589-4cac-84db-bd6c54bf6c91';
const session = { id:'owner', username:'outer', deviceName:'device', createdAt:Date.now(), lastSeenAt:Date.now(), expiresAt:Date.now()+60000 };
const cookie = 'cs_hub_session=' + 'a'.repeat(43);
let logout = 0;
const peers = new Set();
const innerWs = new WebSocketServer({ noServer:true });
const inner = createServer(async (req,res) => {
  if (req.url === '/api/v1/auth/login') {
    let input = ''; for await (const chunk of req) input += chunk;
    assert.equal(JSON.parse(input).password, 'private-password');
    res.setHeader('Set-Cookie', cookie+'; HttpOnly');
    res.end(JSON.stringify({authenticated:true}));
  } else if (req.url === '/api/v1/auth/logout') {
    assert.equal(req.headers.cookie,cookie); logout++;
    for (const peer of peers) peer.terminate();
    res.end('{}');
  } else {
    assert.equal(req.headers.cookie,cookie);
    assert.equal(req.headers.authorization,undefined);
    res.writeHead(200, {'Content-Type':'application/octet-stream'});
    res.write('started');
  }
});
inner.on('upgrade',(req,socket,head) => {
  assert.equal(req.headers.cookie,cookie); assert.equal(req.headers.origin,origin);
  innerWs.handleUpgrade(req,socket,head,(ws) => {
    peers.add(ws); ws.on('close',()=>peers.delete(ws)); ws.on('error',()=>{});
    ws.on('message',(data,binary)=>ws.send(data,{binary}));
    ws.send('initial-snapshot');
  });
});
inner.listen(0,'127.0.0.1'); await once(inner,'listening');
const proxy = createProjectRuntimeProxy({
  auth:{store:{listSessions:()=>[session]},authenticate:async()=>session,isOriginAllowed:req=>req.headers.origin===origin},
  resolveTarget:async()=>({url:'http://127.0.0.1:'+inner.address().port,username:'private-user',password:'private-password',generation:1}),
  publicOrigin:()=>origin
});
const outer=createServer((req,res)=>{void proxy.handle(req,res);});
outer.on('upgrade',(req,socket,head)=>{void proxy.handleUpgrade(req,socket,head);});
outer.listen(0,'127.0.0.1');await once(outer,'listening');
try {
  const base='http://127.0.0.1:'+outer.address().port+'/p/'+project;
  const ws=new WebSocket(base.replace('http','ws')+'/ws',{headers:{origin,cookie:'outer-secret',authorization:'outer-private'}});
  ws.on('error',()=>{});const initial=once(ws,'message');await once(ws,'open');
  assert.equal((await initial)[0].toString(),'initial-snapshot');
  const one=once(ws,'message');ws.send('one');assert.equal((await one)[0].toString(),'one');
  const two=once(ws,'message');ws.send(Buffer.from([1,2,3]));const [bytes,binary]=await two;
  assert.deepEqual([...bytes],[1,2,3]);assert.equal(binary,true);
  // The real ws pause/resume path must preserve a burst without duplication.
  const burst=[];const receive=(data)=>burst.push(data.toString());ws.on('message',receive);
  for(let n=0;n<32;n++)ws.send('burst-'+n);
  for(let n=0;n<200&&burst.length<32;n++)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(burst,Array.from({length:32},(_,n)=>'burst-'+n));ws.off('message',receive);
  // Put a large head and a small following frame into one network write. Pausing
  // ws cannot retract a following frame already parsed from that same buffer.
  const largeFrames=[];const collectLarge=(data,binary)=>largeFrames.push({size:data.length,binary,tail:data.length<100?data.toString():undefined});
  ws.on('message',collectLarge);
  const wire=(data,opcode)=>Sender.frame(data,{fin:true,opcode,mask:false,rsv1:false,readOnly:true});
  [...peers][0]._socket.write(Buffer.concat([...wire(Buffer.alloc(9*1024*1024,122),2),...wire(Buffer.from('after-large-snapshot'),1)]));
  for(let n=0;n<400&&largeFrames.length<2;n++)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(largeFrames,[{size:9*1024*1024,binary:true,tail:undefined},{size:20,binary:false,tail:'after-large-snapshot'}]);
  ws.off('message',collectLarge);
  const oversized=new WebSocket(base.replace('http','ws')+'/ws',{headers:{origin}});
  oversized.on('error',()=>{});const secondInitial=once(oversized,'message');await once(oversized,'open');await secondInitial;
  const oversizedClosed=once(oversized,'close');
  [...peers].at(-1).send(Buffer.alloc(65*1024*1024),()=>{});
  await oversizedClosed;
  const healthy=once(ws,'message');ws.send('still-live');assert.equal((await healthy)[0].toString(),'still-live');
  const response=await fetch(base+'/api/v1/files/stream',{headers:{origin}});
  assert.equal(response.headers.get('set-cookie'),null);
  const reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'started');
  const ended=reader.read().then(value=>value.done,()=>true);const closed=once(ws,'close');
  await proxy.revokeOwner('owner');await closed;assert.equal(await ended,true);assert.equal(logout,1);
  process.stdout.write(JSON.stringify({ok:true,frames:38,oversizeClosed:true,logout}));
} finally {
  await proxy.close();for(const peer of peers)peer.terminate();innerWs.close();
  outer.closeAllConnections();inner.closeAllConnections();
  await Promise.all([new Promise(r=>outer.close(r)),new Promise(r=>inner.close(r))]);
}
`,
    );
    const child = Bun.spawn(["node", join(temporary, "fixture.mjs")], {
      cwd: temporary,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 12_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ok: true, frames: 38, oversizeClosed: true, logout: 1 });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);
