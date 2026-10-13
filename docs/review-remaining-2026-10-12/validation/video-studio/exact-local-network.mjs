import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync,readFileSync} from 'node:fs';
import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';import dgram from 'node:dgram';
const registry='/tmp/codeshell-panel-video-review-20261012/owned-origins.txt';
const denied=()=>{throw new Error('REVIEW NETWORK DENIED: destination is not an exact test-created origin');};
const origins=()=>new Set(readFileSync(registry,'utf8').split('\n').filter(Boolean));
const allowed=u=>{try{return origins().has(new URL(u).origin);}catch{return false;}};
const server=http.createServer;http.createServer=function(...args){const s=server.apply(this,args);s.on('listening',()=>{const a=s.address();if(a&&typeof a==='object'&&a.address==='127.0.0.1')appendFileSync(registry,`http://127.0.0.1:${a.port}\n`);});return s;};
const resolve=(a,b)=>{if(typeof a==='string'||a instanceof URL)return String(a);const o=a??{};return `${o.protocol??'http:'}//${o.hostname??o.host??'localhost'}:${o.port??80}${o.path??'/'}`;};
for(const m of ['request','get']){const original=http[m];http[m]=function(...a){if(!allowed(resolve(a[0],a[1])))denied();return original.apply(this,a);};https[m]=denied;}
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){const x=Array.isArray(a[0])?a[0]:a;const o=typeof x[0]==='object'?x[0]:{port:x[0],host:typeof x[1]==='string'?x[1]:'localhost'};if(!allowed(`http://${o.host??'localhost'}:${o.port}`))denied();return connect.apply(this,a);};
tls.connect=denied;dgram.createSocket=denied;const f=globalThis.fetch;globalThis.fetch=(input,...a)=>{if(!allowed(input?.url??input))denied();return f(input,...a);};syncBuiltinESMExports();
