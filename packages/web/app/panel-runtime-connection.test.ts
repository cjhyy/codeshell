import { afterEach, expect, spyOn, test } from "bun:test";
import { connectPanelRuntime, type PanelRuntimeEvent } from "./panel-runtime-connection.js";

const originalFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  globalThis.fetch = originalFetch;
});
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
function fixture(
  options: {
    renew?: () => Response | Promise<Response>;
    events?: (after: number) => Response | Promise<Response>;
  } = {},
) {
  let now = 1_000_000;
  let id = 0;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  const date = spyOn(Date, "now").mockImplementation(() => now);
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay = 0,
  ) => {
    const timer = ++id;
    scheduled.set(timer, { at: now + delay, callback });
    return timer;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: number) => {
    scheduled.delete(timer);
  }) as typeof clearTimeout);
  cleanups.push(() => {
    date.mockRestore();
    set.mockRestore();
    clear.mockRestore();
  });
  const requests: Array<{
    path: string;
    after: number;
    workspace: string | null;
    body?: BodyInit | null;
    contentType: string | null;
    signal?: AbortSignal | null;
  }> = [];
  const delivered: PanelRuntimeEvent[] = [];
  const errors: Error[] = [];
  const statuses: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    requests.push({
      path: url.pathname,
      after: Number(url.searchParams.get("after")),
      workspace: url.searchParams.get("workspace"),
      body: init?.body,
      contentType: new Headers(init?.headers).get("content-type"),
      signal: init?.signal,
    });
    if (url.pathname.endsWith("/renew"))
      return options.renew?.() ?? Response.json({ expiresAt: now + 30 * 60_000 });
    if (url.pathname.endsWith("/events"))
      return (
        options.events?.(Number(url.searchParams.get("after"))) ??
        Response.json({ events: [], cursor: Number(url.searchParams.get("after")) })
      );
    throw new Error(`Unexpected route ${url.pathname}`);
  }) as typeof fetch;
  const connection = connectPanelRuntime({
    instanceId: "synthetic-instance",
    expiresAt: now + 30 * 60_000,
    workspace: "/workspace/original",
    onEvents: (events) => delivered.push(...events),
    onStatus: (status) => statuses.push(status),
    onTerminal: (error) => errors.push(error),
  });
  cleanups.push(connection.stop);
  return {
    connection,
    requests,
    delivered,
    errors,
    statuses,
    scheduled,
    get now() {
      return now;
    },
    async advance(ms: number) {
      const target = now + ms;
      await flush();
      for (;;) {
        const next = [...scheduled]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        scheduled.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

test("automatically renews sixty seconds before expiry and re-arms the same grant", async () => {
  const view = fixture();
  await view.advance(29 * 60_000 - 1);
  expect(view.requests.filter((request) => request.path.endsWith("/renew"))).toHaveLength(0);
  await view.advance(1);
  expect(view.requests.filter((request) => request.path.endsWith("/renew"))).toHaveLength(1);
  expect(view.requests.find((request) => request.path.endsWith("/renew"))).toMatchObject({
    body: "{}",
    contentType: "application/json",
  });
  await view.advance(60_001);
  expect(view.errors).toHaveLength(0);
  expect(view.requests.every((request) => request.workspace === "/workspace/original")).toBe(true);
  await view.advance(28 * 60_000 - 1);
  expect(view.requests.filter((request) => request.path.endsWith("/renew"))).toHaveLength(2);
});

test("transient renewal failure retries within the valid lease and recovers", async () => {
  let attempts = 0;
  const view = fixture({
    renew: () => {
      attempts++;
      return attempts === 1
        ? Response.json({ error: "temporary" }, { status: 503 })
        : Response.json({ expiresAt: view.now + 30 * 60_000 });
    },
  });
  await view.advance(29 * 60_000);
  expect(attempts).toBe(1);
  expect(view.statuses.at(-1)).toContain("当前内容会保留");
  expect(view.errors).toHaveLength(0);
  view.connection.refresh();
  await flush();
  expect(attempts).toBe(1);
  await view.advance(5_000);
  expect(attempts).toBe(2);
  expect(view.statuses.at(-1)).toBe("");
  await view.advance(55_001);
  expect(view.errors).toHaveLength(0);
});

test("continued renewal failures stop at expiry without an endless retry loop", async () => {
  const view = fixture({ renew: () => Response.json({ error: "temporary" }, { status: 503 }) });
  await view.advance(30 * 60_000);
  const attempts = view.requests.filter((request) => request.path.endsWith("/renew")).length;
  expect(attempts).toBeGreaterThan(1);
  expect(attempts).toBeLessThanOrEqual(5);
  expect(view.errors).toHaveLength(1);
  expect(view.errors[0].message).toContain("连接已到期");
  expect(view.scheduled.size).toBe(0);
  await view.advance(60_000);
  expect(view.requests.filter((request) => request.path.endsWith("/renew"))).toHaveLength(attempts);
});

for (const status of [401, 403, 410])
  test(`renewal rejection ${status} terminates once and cancels polling`, async () => {
    const view = fixture({ renew: () => Response.json({ error: "rejected" }, { status }) });
    await view.advance(29 * 60_000);
    expect(view.errors).toHaveLength(1);
    expect(view.errors[0]).toMatchObject({ status });
    expect(view.scheduled.size).toBe(0);
    const count = view.requests.length;
    view.connection.refresh();
    await view.advance(60_000);
    expect(view.requests).toHaveLength(count);
  });

test("polling advances its cursor after delivery and retries transient failures without duplicates", async () => {
  let attempts = 0;
  const view = fixture({
    events: (after) => {
      attempts++;
      if (attempts === 1)
        return Response.json({
          cursor: 1,
          events: [{ id: 1, event: "process.output", payload: "first" }],
        });
      if (attempts === 2) return Response.json({ error: "temporary" }, { status: 503 });
      return Response.json({
        cursor: 2,
        events: after === 1 ? [{ id: 2, event: "process.exit", payload: { code: 0 } }] : [],
      });
    },
  });
  await flush();
  expect(view.delivered.map((event) => event.id)).toEqual([1]);
  await view.advance(1_000);
  expect(view.errors).toHaveLength(0);
  expect(view.statuses.at(-1)).toContain("暂时中断");
  await view.advance(2_000);
  expect(view.delivered.map((event) => event.id)).toEqual([1, 2]);
  expect(
    view.requests
      .filter((request) => request.path.endsWith("/events"))
      .map((request) => request.after),
  ).toEqual([0, 1, 1]);
  expect(view.statuses.at(-1)).toBe("");
});

test("lost event backlog revokes the connection while stop aborts inflight requests", async () => {
  const view = fixture({
    events: () => Response.json({ error: "Panel event backlog expired" }, { status: 410 }),
  });
  await flush();
  expect(view.errors).toHaveLength(1);
  expect(view.scheduled.size).toBe(0);
});

test("stop cancels pending polling and ignores a late response", async () => {
  let resolve!: (response: Response) => void;
  const view = fixture({
    events: () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  });
  view.connection.stop();
  expect(view.requests[0].signal?.aborted).toBe(true);
  expect(view.scheduled.size).toBe(0);
  resolve(
    Response.json({ cursor: 1, events: [{ id: 1, event: "process.output", payload: "late" }] }),
  );
  await flush();
  await view.advance(60_000);
  expect(view.delivered).toHaveLength(0);
  expect(view.requests).toHaveLength(1);
  expect(view.errors).toHaveLength(0);
});
