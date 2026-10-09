import http, { get as httpGet, request as httpRequest } from "node:http";
import https, { get as httpsGet, request as httpsRequest } from "node:https";
import net, { connect, createConnection } from "node:net";
import tls, { connect as tlsConnect } from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { lstatSync } from "node:fs";
import { MAX_DOCUMENT_BYTES } from "./types.js";

// Only byte input crosses the process boundary. No source paths or inherited
// credentials are needed. These JS API guards precede parser dependencies;
// they are not an OS sandbox or a restriction on arbitrary native libraries.
const deny = () => {
  throw new Error("Document parser refused a network request");
};
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = deny;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny;
tls.TLSSocket.prototype.connect = deny;
// Bun's syncBuiltinESMExports does not update captured named HTTP exports.
// Its ClientRequest calls getHeaders before its native HTTP client can start.
http.ClientRequest.prototype.getHeaders = deny;
syncBuiltinESMExports();
for (const method of ["log", "warn", "info", "error"] as const) console[method] = () => undefined;

try {
  const probes = [
    () => fetch("https://document-parser.invalid/"),
    () => http.request("http://127.0.0.1:9/").end(),
    () => httpRequest("http://127.0.0.1:9/").end(),
    () => http.get("http://127.0.0.1:9/"),
    () => httpGet("http://127.0.0.1:9/"),
    () => https.request("https://document-parser.invalid/").end(),
    () => httpsRequest("https://document-parser.invalid/").end(),
    () => https.get("https://document-parser.invalid/"),
    () => httpsGet("https://document-parser.invalid/"),
    () => net.connect({ host: "127.0.0.1", port: 9 }),
    () => connect({ host: "127.0.0.1", port: 9 }),
    () => net.createConnection({ host: "127.0.0.1", port: 9 }),
    () => createConnection({ host: "127.0.0.1", port: 9 }),
    () => new net.Socket().connect({ host: "127.0.0.1", port: 9 }),
    () => tls.connect({ host: "document-parser.invalid", port: 443 }),
    () => tlsConnect({ host: "document-parser.invalid", port: 443 }),
    () => new tls.TLSSocket(new net.Socket()).connect({ host: "127.0.0.1", port: 9 }),
  ];
  for (const probe of probes) {
    let refused = false;
    try {
      probe();
    } catch (error) {
      refused =
        error instanceof Error && error.message === "Document parser refused a network request";
    }
    if (!refused) throw new Error("Document parser network guard verification failed");
  }
  const environment = Object.fromEntries(
    [
      "HOME",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "XDG_RUNTIME_DIR",
      "APPDATA",
      "LOCALAPPDATA",
      "CODE_SHELL_HOME",
      "TMPDIR",
      "TEMP",
      "TMP",
    ].map((key) => [key, process.env[key]]),
  );
  process.stdout.write(
    JSON.stringify({
      runtime: {
        pid: process.pid,
        ppid: process.ppid,
        executable: process.execPath,
        home: homedir(),
        cwd: process.cwd(),
        environment,
        directoryModes: Object.fromEntries(
          Object.entries(environment).map(([key, directory]) => {
            if (!directory) throw new Error("Document parser private environment is missing");
            const stat = lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink())
              throw new Error("Document parser private directory is invalid");
            return [key, stat.mode & 0o777];
          }),
        ),
        networkProbesBeforeImport: probes.length,
        node: process.versions.node,
        bun: process.versions.bun,
        electron: process.versions.electron,
      },
    }) + "\n",
  );
  const input: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_DOCUMENT_BYTES * 1.5 + 4096)
      throw new Error("Document input exceeds its size limit");
    input.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(input).toString("utf8"));
  const { parseDocument } = await import("./parse.js");
  const result = await parseDocument(Buffer.from(request.bytes, "base64"), request.filename);
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: error instanceof Error ? error.message : "Document parsing failed" }),
  );
}
