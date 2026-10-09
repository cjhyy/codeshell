import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

// Test-only: upload fixtures use in-process synthetic LLM responses and no server.
// Install before importing Core, including in the cold SDK/ASAR consumer process.
export function denyDocumentSmokeNetwork() {
  const deny = () => {
    throw new Error("Document smoke refused a network request");
  };
  globalThis.fetch = deny;
  http.request = http.get = https.request = https.get = deny;
  net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny;
  syncBuiltinESMExports();
}
