import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dgram from 'node:dgram';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('REVIEW_NETWORK_DENIED'); };
globalThis.fetch = async () => { throw new Error('REVIEW_NETWORK_DENIED'); };
for (const item of [http, https]) { item.request = deny; item.get = deny; }
net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
tls.connect = deny; dgram.createSocket = deny;
syncBuiltinESMExports();
