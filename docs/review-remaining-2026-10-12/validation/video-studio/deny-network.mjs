import {syncBuiltinESMExports} from 'node:module';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram';
const denied=()=>{throw new Error('REVIEW NETWORK DENIED: no test-owned origin registered');};
http.request=denied;http.get=denied;https.request=denied;https.get=denied;net.connect=denied;net.createConnection=denied;net.Socket.prototype.connect=denied;tls.connect=denied;dgram.createSocket=denied;globalThis.fetch=async()=>denied();syncBuiltinESMExports();
