import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, PlaintextCipher } from "@cjhyy/code-shell-core";
import { createLinkHttp, type LinkHttpOptions } from "./http.js";

const directories: string[] = [];
const hosts: Array<{ http: ReturnType<typeof createLinkHttp>; server: Server }> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.http.close();
    host.server.closeAllConnections();
    await new Promise<void>((resolve) => host.server.close(() => resolve()));
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const input = {
  providerId: "github",
  methodId: "fine-grained-pat",
  label: "HTTP fixture",
  token: "synthetic-http-token",
  expectedRevision: null,
};
async function fixture(options: Partial<LinkHttpOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "link-http-"));
  directories.push(directory);
  const store = new CredentialStore(undefined, new PlaintextCipher(), directory);
  let authorized = true;
  const http = createLinkHttp({
    store,
    ownerId: async (request) => (request.headers["x-test-owner"] === "owner" ? "owner" : undefined),
    isAuthorized: async () => authorized,
    validateToken: async () => ({
      providerId: "github",
      identity: { externalAccountId: "42", label: "fixture" },
      capabilityIds: ["github.list_repos"],
      verifiedAt: new Date().toISOString(),
    }),
    ...options,
  });
  const server = createServer((request, response) => {
    // The shared route is mounted behind the same origin policy as the real hosts.
    if (request.headers.origin !== origin) {
      response.writeHead(403).end();
      return;
    }
    void http.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  hosts.push({ http, server });
  const api = (path = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(origin + "/api/v1/links" + path, {
      method,
      headers: {
        origin,
        "x-test-owner": "owner",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    api,
    http,
    store,
    origin,
    revoke: () => {
      authorized = false;
    },
  };
}

describe("shared Link HTTP boundary", () => {
  test("requires authenticated owner and the host origin boundary", async () => {
    const { api } = await fixture();
    expect((await api("", "GET", undefined, { "x-test-owner": "unknown" })).status).toBe(401);
    expect((await api("", "GET", undefined, { origin: "https://foreign.invalid" })).status).toBe(
      403,
    );
    expect((await api()).status).toBe(200);
  });
  test("token connect, masked refresh, rename and CAS delete form one usable flow", async () => {
    const { api, store } = await fixture();
    const saved = await api("/connections/token", "POST", input);
    expect(saved.status).toBe(200);
    const connection = await saved.json();
    const snapshot = await (await api()).json();
    expect(snapshot.connections[0].id).toBe(connection.id);
    expect(JSON.stringify(snapshot)).not.toContain(input.token);
    const renamed = await (
      await api("/connections/" + connection.id, "PATCH", {
        label: "New name",
        expectedRevision: connection.revision,
      })
    ).json();
    expect(renamed.label).toBe("New name");
    expect(
      (
        await api("/connections/" + connection.id, "DELETE", {
          expectedRevision: connection.revision,
        })
      ).status,
    ).toBe(409);
    expect(
      (await api("/connections/" + connection.id, "DELETE", { expectedRevision: renamed.revision }))
        .status,
    ).toBe(200);
    expect(store.list()).toEqual([]);
  });
  test("rejects arbitrary URLs, CLI arguments, credential metadata and excessive payloads", async () => {
    let calls = 0;
    const { api } = await fixture({
      validateToken: async () => {
        calls++;
        throw new Error("must not call provider");
      },
    });
    for (const extra of [
      { url: "https://untrusted.invalid" },
      { args: ["--unsafe"] },
      { meta: { agentExposable: true } },
      { cwd: "/private" },
    ])
      expect((await api("/connections/token", "POST", { ...input, ...extra })).status).toBe(400);
    expect(
      (await api("/connections/token", "POST", { ...input, token: "x".repeat(40_000) })).status,
    ).toBe(413);
    expect(
      (await api("/connections/token", "POST", input, { "content-type": "text/plain" })).status,
    ).toBe(400);
    expect(calls).toBe(0);
  });
  test("provider failures never reflect raw bodies or credentials to the browser", async () => {
    const { api } = await fixture({
      validateToken: async () => {
        throw new Error("upstream says " + input.token);
      },
    });
    const response = await api("/connections/token", "POST", input);
    expect(response.status).toBe(422);
    const raw = await response.text();
    expect(raw).toContain("provider_rejected");
    expect(raw).not.toContain(input.token);
  });

  test("bounds chunked bodies without accidentally finishing a 200 response", async () => {
    const { origin } = await fixture();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        origin + "/api/v1/links/connections/token",
        {
          method: "POST",
          headers: {
            origin,
            "x-test-owner": "owner",
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      request.on("error", reject);
      request.write('{"token":"' + "x".repeat(40_000));
      request.end('"}');
    });
    expect(status).toBe(413);
  });

  test("native Node detects a disconnected requester before persisting a provider response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "link-http-native-"));
    directories.push(directory);
    // Bun's HTTP compatibility layer does not reliably emit the native response
    // close event on client.destroy(); exercise this deployment boundary in Node.
    const source = `
      import assert from "node:assert/strict";
      import {createServer,request} from "node:http";
      import {createLinkHttp} from ${JSON.stringify(new URL("../../dist/links/http.js", import.meta.url).href)};
      import {CredentialStore,PlaintextCipher} from "@cjhyy/code-shell-core";
      const store=new CredentialStore(undefined,new PlaintextCipher(),${JSON.stringify(directory)});
      let started, release, closed, finished;
      const startedP=new Promise(r=>started=r), gate=new Promise(r=>release=r), closedP=new Promise(r=>closed=r), finishedP=new Promise(r=>finished=r);
      const http=createLinkHttp({store,ownerId:async()=>"owner",isAuthorized:async()=>true,validateToken:async()=>{started();await gate;return {providerId:"github",identity:{externalAccountId:"42",label:"fixture"},capabilityIds:[],verifiedAt:new Date().toISOString()}}});
      const server=createServer((req,res)=>{res.once("close",closed);void http.handle(req,res).finally(finished)});
      await new Promise(r=>server.listen(0,"127.0.0.1",r));
      const req=request({host:"127.0.0.1",port:server.address().port,path:"/api/v1/links/connections/token",method:"POST",headers:{"content-type":"application/json"}});
      req.on("error",()=>{});req.end(${JSON.stringify(JSON.stringify(input))});
      await startedP;req.destroy();await closedP;release();await finishedP;
      assert.equal(store.list().length,0);http.close();server.closeAllConnections();await new Promise(r=>server.close(r));console.log("native disconnect passed");
    `;
    const result = await promisify(execFile)("node", ["--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      timeout: 10_000,
    });
    expect(result.stdout).toContain("native disconnect passed");
  });
  test("reauthorizes a request after its body arrived", async () => {
    const { origin, revoke, store } = await fixture();
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        origin + "/api/v1/links/connections/token",
        {
          method: "POST",
          headers: { origin, "x-test-owner": "owner", "content-type": "application/json" },
        },
        (response) => {
          let body = "";
          response.on("data", (part) => {
            body += part;
          });
          response.on("end", () => resolve({ status: response.statusCode!, body }));
        },
      );
      request.on("error", reject);
      request.write(JSON.stringify(input).slice(0, -1));
      setTimeout(() => {
        revoke();
        request.end("}");
      }, 10);
    });
    expect((await result).status).toBe(401);
    expect(store.list()).toEqual([]);
  });
  test("closing during the final asynchronous authorization cannot return stale success", async () => {
    let calls = 0;
    let close = () => {};
    const { api, http } = await fixture({
      isAuthorized: async () => {
        if (++calls >= 2) close();
        return true;
      },
    });
    close = () => http.close();
    expect((await api()).status).toBe(503);
  });
  test("malformed escaped route ids get a bounded request error", async () => {
    const { api } = await fixture();
    const response = await api("/providers/%EF/cli");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });
});
