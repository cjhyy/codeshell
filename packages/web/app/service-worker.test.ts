import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");
function worker(fetcher: (request: Request) => Promise<Response>, base = "/") {
  const listeners: Record<string, (event: any) => void> = {};
  const matched: string[] = [];
  const context = {
    location: { origin: "https://hub.example", href: `https://hub.example${base}sw.js` },
    addEventListener: (name: string, listener: (event: any) => void) => {
      listeners[name] = listener;
    },
  };
  const caches = {
    match: async (request: Request | string) => {
      matched.push(String(request));
      return new Response("public offline page");
    },
  };
  new Function("self", "caches", "fetch", source)(context, caches, fetcher);
  return { listeners, matched };
}

describe("Hub service worker privacy", () => {
  test("Desktop offline fallback remains inside /mobile and leaves other pages alone", async () => {
    const { listeners, matched } = worker(async () => {
      throw new TypeError("offline");
    }, "/mobile/");
    let response: Promise<Response> | undefined;
    let outside = false;
    listeners.fetch({
      request: { method: "GET", url: "https://hub.example/", mode: "navigate" },
      respondWith: () => {
        outside = true;
      },
    });
    listeners.fetch({
      request: { method: "GET", url: "https://hub.example/mobile/", mode: "navigate" },
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    expect(await (await response)?.text()).toBe("public offline page");
    expect(matched).toEqual(["/mobile/offline.html"]);
    expect(outside).toBe(false);
  });
  test("does not intercept authenticated API, uploads, or cross-origin traffic", () => {
    const { listeners, matched } = worker(async () => new Response("unexpected"));
    let handled = 0;
    for (const url of [
      "https://hub.example/api/v1/auth/status",
      "https://hub.example/api/v1/uploads/id",
      "https://other.example/icon.svg",
    ]) {
      listeners.fetch({ request: new Request(url), respondWith: () => handled++ });
    }
    expect(handled).toBe(0);
    expect(matched).toEqual([]);
  });
  test("serves authenticated navigation from the network without caching it", async () => {
    const { listeners, matched } = worker(async () => new Response("private page"));
    let response: Promise<Response> | undefined;
    listeners.fetch({
      request: { method: "GET", url: "https://hub.example/", mode: "navigate" },
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    expect(await (await response)?.text()).toBe("private page");
    expect(matched).toEqual([]);
  });
  test("offline navigation uses only the public offline page", async () => {
    const { listeners, matched } = worker(async () => {
      throw new TypeError("offline");
    });
    let response: Promise<Response> | undefined;
    listeners.fetch({
      request: { method: "GET", url: "https://hub.example/", mode: "navigate" },
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    expect(await (await response)?.text()).toBe("public offline page");
    expect(matched).toEqual(["/offline.html"]);
  });
});
