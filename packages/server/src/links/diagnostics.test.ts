import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { LinkAuthorizationDiagnostic } from "./diagnostics.js";
import type { LinkHttpOptions } from "./http.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const secret = "private-diagnostic-secret";
const input = {
  providerId: "figma",
  methodId: "remote-link",
  authModeId: "remote-link",
  label: `Private label ${secret}`,
  expectedRevision: null,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(options: Partial<LinkHttpOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "link-authorization-diagnostics-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const events: LinkAuthorizationDiagnostic[] = [];
  const catalogEntered = deferred();
  let catalogGate: Promise<void> | undefined;
  let catalogStatus = 200;
  let catalogBody: unknown = {
    version: 1,
    providers: [
      {
        id: "figma",
        methods: [
          {
            id: "remote-link",
            authKind: "oauth",
            defaultAuthModeId: "browser",
            authModes: [{ id: "browser", kind: "redirect" }],
          },
        ],
        actions: ["get_file"],
        scopes: ["figma:get_file"],
      },
    ],
  };
  let catalogRequests = 0;
  const issuer = await listen(
    createServer(async (request, response) => {
      if (request.url !== "/api/v1/links/providers") {
        response.writeHead(404).end();
        return;
      }
      catalogRequests++;
      catalogEntered.resolve();
      await catalogGate;
      response.writeHead(catalogStatus, { "Content-Type": "application/json" });
      response.end(typeof catalogBody === "string" ? catalogBody : JSON.stringify(catalogBody));
    }),
  );
  const origin = await listen(
    createServer((request, response) => {
      if (request.headers.origin !== origin) {
        response.writeHead(403).end();
        return;
      }
      void http.handle(request, response).then((handled) => {
        if (!handled) response.writeHead(404).end();
      });
    }),
  );
  // Deny every origin except these exact loopback fixtures before importing Core.
  const originalFetch = globalThis.fetch;
  const origins = new Set([issuer, origin]);
  globalThis.fetch = Object.assign(
    ((url: string | URL | Request, init?: RequestInit) => {
      if (!origins.has(new URL(url instanceof Request ? url.url : url).origin))
        throw new Error("Unexpected network origin in Link diagnostics fixture");
      return originalFetch(url, init);
    }) as typeof fetch,
    { preconnect: originalFetch.preconnect },
  );
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
  });
  const [{ CredentialStore, PlaintextCipher }, { createLinkHttp }] = await Promise.all([
    import("@cjhyy/code-shell-core"),
    import("./http.js"),
  ]);
  const store = new CredentialStore(directory, new PlaintextCipher(), join(directory, "user"));
  let authorized = true;
  let owner: string | undefined = `private-owner-${secret}`;
  let configured = true;
  const config = {
    issuer,
    clientId: `private-client-${secret}`,
    clientSecret: `private-client-secret-${secret}`,
    redirectUri: "http://127.0.0.1:4900/link/callback",
  };
  const http = createLinkHttp({
    store,
    remoteLink: () => (configured ? config : undefined),
    ownerId: async () => owner,
    isAuthorized: async () => authorized,
    onAuthorizationDiagnostic: (event) => {
      events.push(event);
    },
    ...options,
  });
  cleanups.push(() => http.close());
  const api = (body: unknown = input, headers: Record<string, string> = {}) =>
    fetch(origin + "/api/v1/links/authorizations", {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return {
    api,
    http,
    store,
    events,
    origin,
    issuer,
    directory,
    catalogEntered,
    catalogRequests: () => catalogRequests,
    catalog: (body: unknown, status = 200) => {
      catalogBody = body;
      catalogStatus = status;
    },
    gateCatalog: (gate: Promise<void>) => {
      catalogGate = gate;
    },
    disableRemote: () => {
      configured = false;
    },
    revoke: () => {
      authorized = false;
    },
    changeOwner: () => {
      owner = `different-owner-${secret}`;
    },
  };
}

function terminal(events: LinkAuthorizationDiagnostic[], requestId: string) {
  const requestEvents = events.filter((event) => event.requestId === requestId);
  const completed = requestEvents.filter((event) => event.outcome !== "stage");
  expect(completed).toHaveLength(1);
  expect(requestEvents.at(-1)).toEqual(completed[0]);
  for (const event of requestEvents) {
    expect(event.event).toBe("link_authorization");
    expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(event.elapsedMs)).toBe(true);
  }
  return completed[0]!;
}

function privateFieldsAbsent(events: LinkAuthorizationDiagnostic[], values: string[] = []) {
  const serialized = JSON.stringify(events);
  for (const value of [secret, input.label, ...values]) expect(serialized).not.toContain(value);
  for (const event of events) {
    for (const key of Object.keys(event))
      expect([
        "event",
        "transport",
        "requestId",
        "outcome",
        "stage",
        "elapsedMs",
        "internalCode",
        "publicCode",
        "httpStatus",
        "upstreamStatus",
        "providerId",
        "methodId",
        "authModeId",
        "authorizationState",
      ]).toContain(key);
  }
}

describe("Link authorization request diagnostics", () => {
  test("missing Remote Link configuration preserves a concrete failure stage", async () => {
    const f = await fixture();
    f.disableRemote();
    const response = await f.api();
    expect(response.status).toBe(503);
    const requestId = response.headers.get("x-request-id")!;
    expect(requestId).toMatch(uuid);
    expect(await response.json()).toMatchObject({ code: "unavailable", requestId });
    expect(terminal(f.events, requestId)).toMatchObject({
      outcome: "failure",
      stage: "remote_configuration",
      internalCode: "remote_configuration_missing",
      publicCode: "unavailable",
      httpStatus: 503,
    });
    expect(f.catalogRequests()).toBe(0);
    privateFieldsAbsent(f.events, [f.issuer, f.directory]);
  });

  test("unreadable Host storage is distinguishable from provider discovery failure", async () => {
    const f = await fixture();
    const original = f.store.listWithStatus.bind(f.store);
    f.store.listWithStatus = () => ({ ...original("full"), readable: false });
    const response = await f.api();
    expect(response.status).toBe(503);
    expect(terminal(f.events, response.headers.get("x-request-id")!)).toMatchObject({
      outcome: "failure",
      stage: "host_store_read",
      internalCode: "host_store_unreadable",
      publicCode: "unavailable",
      httpStatus: 503,
    });
    privateFieldsAbsent(f.events, [f.issuer, f.directory]);
  });

  test.each([
    {
      body: `Upstream body ${secret}`,
      status: 502,
      upstreamStatus: 502,
      internalCode: "catalog_http_status",
    },
    {
      body: `Invalid JSON ${secret}`,
      status: 200,
      upstreamStatus: undefined,
      internalCode: "catalog_invalid_json",
    },
    {
      body: { version: 9, providers: [], secret },
      status: 200,
      upstreamStatus: undefined,
      internalCode: "catalog_invalid_schema",
    },
  ])("catalog errors retain reviewed reasons and upstream status ($status)", async (failure) => {
    const f = await fixture();
    f.catalog(failure.body, failure.status);
    const response = await f.api();
    expect(response.status).toBe(503);
    const event = terminal(f.events, response.headers.get("x-request-id")!);
    expect(event).toMatchObject({
      outcome: "failure",
      stage: "remote_catalog",
      publicCode: "unavailable",
      httpStatus: 503,
    });
    expect(event.internalCode).toBe(failure.internalCode);
    expect(event.upstreamStatus).toBe(failure.upstreamStatus);
    privateFieldsAbsent(f.events, [f.issuer, f.directory]);
    expect(await response.text()).not.toContain(secret);
  });

  test("unknown exceptions cannot expose provider messages or error properties", async () => {
    const f = await fixture({
      remoteLink: () => {
        const error = new Error(`Bearer ${secret} https://private.invalid/?code=${secret}`);
        Object.assign(error, { token: secret, status: 503, code: secret });
        throw error;
      },
    });
    const response = await f.api();
    expect(response.status).toBe(503);
    const event = terminal(f.events, response.headers.get("x-request-id")!);
    expect(event).toMatchObject({ outcome: "failure", publicCode: "unavailable", httpStatus: 503 });
    privateFieldsAbsent(f.events, [f.issuer, f.directory, "private.invalid", "Bearer"]);
    expect(await response.text()).not.toContain(secret);
  });

  test("attacker-controlled provider and mode identifiers cannot enter logs", async () => {
    const f = await fixture();
    const response = await f.api({
      ...input,
      providerId: secret,
      methodId: secret,
      authModeId: secret,
    });
    expect(response.status).toBe(400);
    expect(terminal(f.events, response.headers.get("x-request-id")!)).toMatchObject({
      outcome: "failure",
      publicCode: "invalid_request",
      httpStatus: 400,
    });
    privateFieldsAbsent(f.events);
  });

  test("a valid catalog without the requested capability keeps its distinct failure", async () => {
    const f = await fixture();
    f.catalog({ version: 1, providers: [] });
    const response = await f.api();
    expect(response.status).toBe(400);
    expect(terminal(f.events, response.headers.get("x-request-id")!)).toMatchObject({
      outcome: "failure",
      stage: "mode_selection",
      internalCode: "provider_capability_missing",
      publicCode: "invalid_request",
      httpStatus: 400,
    });
    privateFieldsAbsent(f.events);
  });

  test("successful redirect traces contain no authorization URL, state, challenge, or secrets", async () => {
    const f = await fixture();
    const response = await f.api();
    expect(response.status).toBe(200);
    const job = await response.json();
    expect(job.step.kind).toBe("redirect");
    const authorizationUrl = new URL(job.step.authorizationUrl);
    expect(terminal(f.events, response.headers.get("x-request-id")!)).toMatchObject({
      outcome: "success",
      providerId: "figma",
      methodId: "remote-link",
      authModeId: "remote-link",
      httpStatus: 200,
    });
    privateFieldsAbsent(f.events, [
      f.issuer,
      f.directory,
      job.id,
      authorizationUrl.href,
      authorizationUrl.searchParams.get("state")!,
      authorizationUrl.searchParams.get("code_challenge")!,
    ]);
    expect(f.store.list()).toEqual([]);
  });

  test.each(["1adc84e3-dbe1-4e12-9874-b7dabf1fc07d", `forged-${secret}`])(
    "client request ID %s is ignored while response IDs correlate their own events",
    async (forgedId) => {
      const f = await fixture();
      const response = await f.api(input, { "x-request-id": forgedId });
      expect(response.status).toBe(200);
      const requestId = response.headers.get("x-request-id")!;
      expect(requestId).toMatch(uuid);
      expect(requestId).not.toBe(forgedId);
      expect(f.events.every((event) => event.requestId === requestId)).toBe(true);
      terminal(f.events, requestId);
      privateFieldsAbsent(f.events, [forgedId]);
    },
  );

  test("native Host service callers receive their own safe success and failure traces", async () => {
    const f = await fixture();
    const context = { ownerId: `private-native-owner-${secret}`, authorize: () => true };
    const result = await f.http.service.startAuthorization(context, input, input.authModeId);
    expect(result.step?.kind).toBe("redirect");
    const firstId = f.events[0]!.requestId;
    expect(firstId).toMatch(uuid);
    expect(terminal(f.events, firstId)).toMatchObject({
      transport: "host",
      outcome: "success",
      httpStatus: 200,
    });
    f.disableRemote();
    await expect(
      f.http.service.startAuthorization(context, input, input.authModeId),
    ).rejects.toMatchObject({ status: 503, code: "unavailable" });
    const secondId = f.events.at(-1)!.requestId;
    expect(secondId).toMatch(uuid);
    expect(secondId).not.toBe(firstId);
    expect(terminal(f.events, secondId)).toMatchObject({
      transport: "host",
      outcome: "failure",
      stage: "remote_configuration",
      internalCode: "remote_configuration_missing",
      publicCode: "unavailable",
      httpStatus: 503,
    });
    expect(f.events.every((event) => event.transport === "host")).toBe(true);
    privateFieldsAbsent(f.events, [f.issuer, f.directory, result.id]);
  });

  test("a failed Host OAuth job stays distinct from a successful HTTP response", async () => {
    const f = await fixture({
      hostOAuthAdapters: [
        {
          providerId: "figma",
          methodId: "mcp",
          authModeId: "mcp-oauth",
          label: `Private adapter ${secret}`,
          authorize: async () => {
            throw new Error(`Token exchange rejected ${secret}`);
          },
          openAuthorizationUrl: async () => {},
        },
      ],
    });
    const response = await f.api({ ...input, methodId: "mcp", authModeId: "mcp-oauth" });
    expect(response.status).toBe(200);
    const job = await response.json();
    expect(job).toMatchObject({ state: "failed", errorCode: "authorization_failed" });
    expect(terminal(f.events, response.headers.get("x-request-id")!)).toMatchObject({
      outcome: "success",
      httpStatus: 200,
      authorizationState: "failed",
    });
    privateFieldsAbsent(f.events);
    expect(JSON.stringify(job)).not.toContain(secret);
  });

  test("a detached Host OAuth completion cannot append to the finished request trace", async () => {
    const gate = deferred();
    const authorizationUrl = `https://www.figma.com/oauth/mcp?state=${secret}&code=${secret}`;
    const f = await fixture({
      hostOAuthAdapters: [
        {
          providerId: "figma",
          methodId: "mcp",
          authModeId: "mcp-oauth",
          label: `Private adapter ${secret}`,
          authorize: async (request) => {
            await request.onAuthorizationUrl(
              authorizationUrl,
              new Date(Date.now() + 600_000).toISOString(),
            );
            await gate.promise;
            return {
              id: request.id,
              type: "oauth",
              label: request.label,
              secret: JSON.stringify({
                version: 1,
                accessToken: secret,
                tokenType: "Bearer",
                expiresAt: "2099-01-01T00:00:00Z",
              }),
              meta: {
                linkProvider: "figma",
                linkConnectionMethod: "mcp",
                linkAuthSource: "mcp-oauth",
                linkExecutionBackend: "mcp",
                linkExecutionRuntime: "local",
                agentExposable: false,
                linkAccountId: `private-account-${secret}`,
                linkCapabilityIds: ["figma.get_metadata"],
              },
            };
          },
          openAuthorizationUrl: async () => {},
        },
      ],
    });
    const response = await f.api({ ...input, methodId: "mcp", authModeId: "mcp-oauth" });
    expect(response.status).toBe(200);
    const job = await response.json();
    expect(job).toMatchObject({ state: "pending", step: { kind: "redirect" } });
    expect(terminal(f.events, response.headers.get("x-request-id")!)).toMatchObject({
      outcome: "success",
      authorizationState: "pending",
    });
    const completedTrace = structuredClone(f.events);
    gate.resolve();
    let state = "pending";
    for (let count = 0; count < 100 && state === "pending"; count++) {
      const current = await f.http.service.authorization(
        { ownerId: `private-owner-${secret}`, authorize: () => true },
        job.id,
      );
      state = current.state;
      if (state === "pending") await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(state).toBe("connected");
    expect(f.events).toEqual(completedTrace);
    privateFieldsAbsent(f.events, [authorizationUrl, f.issuer, f.directory]);
  });

  test.each([200, 502])(
    "concurrent requests sharing a %i catalog retain independent request IDs",
    async (status) => {
      const f = await fixture();
      if (status !== 200) f.catalog(`Upstream private body ${secret}`, status);
      const gate = deferred();
      f.gateCatalog(gate.promise);
      const first = f.api();
      await f.catalogEntered.promise;
      const second = f.api();
      // Wait until the second request has joined the same in-flight catalog operation.
      for (let count = 0; count < 100; count++) {
        if (f.events.filter((event) => event.stage === "remote_catalog").length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(f.events.filter((event) => event.stage === "remote_catalog")).toHaveLength(2);
      gate.resolve();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual(
        status === 200 ? [200, 200] : [503, 503],
      );
      const ids = responses.map((response) => response.headers.get("x-request-id")!);
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) {
        expect(id).toMatch(uuid);
        const event = terminal(f.events, id);
        if (status === 200) expect(event.outcome).toBe("success");
        else
          expect(event).toMatchObject({
            outcome: "failure",
            stage: "remote_catalog",
            internalCode: "catalog_http_status",
            upstreamStatus: status,
            httpStatus: 503,
          });
      }
      expect(f.catalogRequests()).toBe(1);
      privateFieldsAbsent(f.events);
    },
  );

  test.each(["throw", "reject"] as const)(
    "a diagnostic sink that can %s cannot change HTTP success or error responses",
    async (failure) => {
      let calls = 0;
      const f = await fixture({
        onAuthorizationDiagnostic: () => {
          calls++;
          if (failure === "throw") throw new Error(secret);
          return Promise.reject(new Error(secret));
        },
      });
      expect((await f.api()).status).toBe(200);
      f.disableRemote();
      const response = await f.api();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "unavailable" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBeGreaterThan(0);
    },
  );

  test("malformed bodies finish one request trace without reflecting body or headers", async () => {
    const f = await fixture();
    const response = await fetch(f.origin + "/api/v1/links/authorizations", {
      method: "POST",
      headers: {
        origin: f.origin,
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: `{"private":"${secret}",`,
    });
    expect(response.status).toBe(400);
    const requestId = response.headers.get("x-request-id")!;
    expect(await response.json()).toMatchObject({ code: "invalid_request", requestId });
    expect(terminal(f.events, requestId)).toMatchObject({
      outcome: "failure",
      stage: "body_validation",
      publicCode: "invalid_request",
      httpStatus: 400,
    });
    expect(f.catalogRequests()).toBe(0);
    privateFieldsAbsent(f.events);
  });

  test.each(["revoke", "changeOwner"] as const)(
    "owner authority changed with %s during discovery prevents job creation",
    async (invalidate) => {
      const f = await fixture();
      const gate = deferred();
      f.gateCatalog(gate.promise);
      const result = f.api();
      await f.catalogEntered.promise;
      f[invalidate]();
      gate.resolve();
      const response = await result;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "login_required" });
      expect(terminal(f.events, response.headers.get("x-request-id")!)).toMatchObject({
        outcome: "failure",
        publicCode: "login_required",
        httpStatus: 401,
      });
      expect(f.catalogRequests()).toBe(1);
      expect(f.store.list()).toEqual([]);
      privateFieldsAbsent(f.events);
    },
  );

  test("native disconnect settles one failure trace when shared discovery resumes", async () => {
    // Bun does not reliably emit Node's response close event after client.destroy().
    const directory = mkdtempSync(join(tmpdir(), "link-diagnostics-native-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const source = `
      import assert from "node:assert/strict";
      import {createServer,request} from "node:http";
      let entered, release, closed, finished;
      const enteredP=new Promise(r=>entered=r), gate=new Promise(r=>release=r), closedP=new Promise(r=>closed=r), finishedP=new Promise(r=>finished=r);
      const issuerServer=createServer(async(req,res)=>{
        assert.equal(req.url,"/api/v1/links/providers");entered();await gate;
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({version:1,providers:[{id:"figma",methods:[{id:"remote-link",authKind:"oauth",defaultAuthModeId:"browser",authModes:[{id:"browser",kind:"redirect"}]}],actions:["get_file"],scopes:["figma:get_file"]}]}));
      });
      await new Promise(r=>issuerServer.listen(0,"127.0.0.1",r));
      const issuer="http://127.0.0.1:"+issuerServer.address().port;
      const originalFetch=globalThis.fetch;
      globalThis.fetch=(url,init)=>{
        assert.equal(new URL(url instanceof Request?url.url:url).origin,issuer);
        return originalFetch(url,init);
      };
      const [{CredentialStore,PlaintextCipher},{createLinkHttp}]=await Promise.all([
        import("@cjhyy/code-shell-core"),
        import(${JSON.stringify(new URL("../../dist/links/http.js", import.meta.url).href)})
      ]);
      const store=new CredentialStore(${JSON.stringify(directory)},new PlaintextCipher(),${JSON.stringify(join(directory, "user"))});
      const events=[];
      const http=createLinkHttp({store,ownerId:async()=>"owner",isAuthorized:async()=>true,remoteLink:()=>({issuer,clientId:"fixture",redirectUri:"http://127.0.0.1:4900/link/callback"}),onAuthorizationDiagnostic:event=>events.push(event)});
      const host=createServer((req,res)=>{res.once("close",closed);void http.handle(req,res).finally(finished)});
      await new Promise(r=>host.listen(0,"127.0.0.1",r));
      const req=request({host:"127.0.0.1",port:host.address().port,path:"/api/v1/links/authorizations",method:"POST",headers:{"content-type":"application/json"}});
      req.on("error",()=>{});req.end(${JSON.stringify(JSON.stringify(input))});
      await enteredP;req.destroy();await closedP;
      release();await finishedP;
      assert.equal(events.filter(event=>event.outcome!=="stage").length,1);
      assert.equal(events.at(-1).outcome,"failure");
      assert.equal(events.at(-1).publicCode,"login_required");
      assert.equal(events.at(-1).httpStatus,401);
      const settled=structuredClone(events);await new Promise(r=>setTimeout(r,0));
      assert.deepEqual(events,settled);
      assert.equal(store.list().length,0);
      await http.close();
      for(const server of [host,issuerServer]){server.closeAllConnections();await new Promise(r=>server.close(r))}
      console.log("closed trace passed");
    `;
    const result = await promisify(execFile)("node", ["--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      timeout: 10_000,
    });
    expect(result.stdout).toContain("closed trace passed");
  });
});
