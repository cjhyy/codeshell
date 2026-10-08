import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { createLinkBrowserHandoff } from "./browser-handoff.js";
import type { LinkAuthorization } from "@cjhyy/code-shell-link";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  let now = Date.now();
  const broker = createLinkBrowserHandoff(() => now);
  const server: Server = createServer((req, res) => {
    void broker.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    broker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const state = randomBytes(32).toString("base64url");
  const authorization = new URL("https://link.example/oauth/authorize");
  authorization.search = new URLSearchParams({
    state,
    redirect_uri: origin + "/link/callback",
  }).toString();
  const job: LinkAuthorization = {
    id: randomUUID(),
    providerId: "figma",
    state: "pending",
    redirect: {
      authorizationUrl: authorization.href,
      expiresAt: new Date(now + 60_000).toISOString(),
    },
  };
  const callbacks: string[] = [];
  let valid = true,
    cancelled = 0;
  let completeGate: Promise<void> | undefined;
  const binding = {
    check: async () => {
      if (!valid) throw new Error("revoked");
    },
    complete: async (callback: string) => {
      callbacks.push(callback);
      await completeGate;
      return { ...job, state: "connected" as const };
    },
    cancel: async () => {
      cancelled++;
    },
  };
  const create = () => broker.create(job, binding, origin).launchUrl;
  const fetchUrl = (url: string) => fetch(url, { redirect: "manual" });
  const callback = `${origin}/link/callback?state=${state}&code=one-use-private-code`;
  return {
    broker,
    origin,
    state,
    job,
    callbacks,
    create,
    fetchUrl,
    callback,
    revoke: () => {
      valid = false;
    },
    advance: () => {
      now += 61_000;
    },
    cancelled: () => cancelled,
    delayComplete: (gate: Promise<void>) => {
      completeGate = gate;
    },
  };
}

test("external browser without any owner cookie completes once and cleans the code from history", async () => {
  const f = await fixture();
  const launch = f.create();
  const started = await f.fetchUrl(launch);
  expect(started.status).toBe(303);
  expect(started.headers.get("location")).toBe(f.job.redirect!.authorizationUrl);
  expect(started.headers.get("set-cookie")).toBeNull();
  expect((await f.fetchUrl(launch)).status).toBe(410);
  const result = await f.fetchUrl(f.callback);
  expect(result.status).toBe(303);
  expect(result.headers.get("location")).toBe("/link/authorization-result");
  expect(f.callbacks).toEqual([f.callback]);
  expect((await f.fetchUrl(f.callback)).status).toBe(404);
  const terminal = await f.fetchUrl(f.origin + "/link/authorization-result");
  expect(await terminal.text()).not.toContain("one-use-private-code");
  expect(terminal.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});

test("wrong or duplicate states and callbacks before launch cannot consume the valid attempt", async () => {
  const f = await fixture();
  const launch = f.create();
  expect((await f.fetchUrl(f.callback)).status).toBe(400);
  expect((await f.fetchUrl(f.callback.replace(f.state, "wrong"))).status).toBe(404);
  expect((await f.fetchUrl(launch)).status).toBe(303);
  expect((await f.fetchUrl(f.callback + "&state=" + f.state)).status).toBe(400);
  expect((await f.fetchUrl(f.callback + "&code=second")).status).toBe(400);
  expect(f.callbacks).toHaveLength(0);
  expect((await f.fetchUrl(f.callback)).status).toBe(303);
  expect(f.callbacks).toHaveLength(1);
});

test("revoked, cancelled, expired and closed owners cannot exchange an upstream code", async () => {
  for (const stage of ["before-launch", "after-launch", "expired", "closed"]) {
    const f = await fixture();
    const launch = f.create();
    if (stage !== "before-launch") await f.fetchUrl(launch);
    if (stage === "expired") f.advance();
    else if (stage === "closed") f.broker.close();
    else f.revoke();
    await f.fetchUrl(stage === "before-launch" ? launch : f.callback);
    expect(f.callbacks).toHaveLength(0);
  }
});

test("denial only cancels the captured original attempt; simultaneous callbacks exchange once", async () => {
  const denied = await fixture();
  await denied.fetchUrl(denied.create());
  await denied.fetchUrl(
    denied.callback.replace("code=one-use-private-code", "error=access_denied"),
  );
  expect(denied.cancelled()).toBe(1);
  expect(denied.callbacks).toHaveLength(0);
  const f = await fixture();
  let finish!: () => void;
  f.delayComplete(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await f.fetchUrl(f.create());
  const first = f.fetchUrl(f.callback);
  while (!f.callbacks.length) await new Promise((resolve) => setTimeout(resolve, 1));
  expect((await f.fetchUrl(f.callback)).status).toBe(400);
  finish();
  expect((await first).status).toBe(303);
  expect(f.callbacks).toHaveLength(1);
});

test("launch tickets never accept a callback or arbitrary external target from a different origin", async () => {
  const f = await fixture();
  const bad = {
    ...f.job,
    redirect: {
      ...f.job.redirect!,
      authorizationUrl: f.job.redirect!.authorizationUrl.replace(
        encodeURIComponent(f.origin),
        encodeURIComponent("https://other.example"),
      ),
    },
  };
  expect(() =>
    f.broker.create(
      bad,
      { check: async () => {}, complete: async () => f.job, cancel: async () => {} },
      f.origin,
    ),
  ).toThrow();
});
