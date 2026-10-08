import { expect, test } from "bun:test";
import {
  CapabilityResolver,
  OperationErrorBudget,
  type CapabilityAdapter,
  type CapabilityBinding,
} from "./resolver.js";
const intent = { service: "fixture", intent: "write", risk: "write" as const, account: "account" };
const binding = (
  id: string,
  channel: CapabilityBinding["channel"] = "link",
): CapabilityBinding => ({
  channel,
  bindingId: id,
  account: "account",
  authority: { scope: ["read", "write"] },
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
test("trusted discovery follows link, MCP, CLI, browser order, then pins the exact account/binding", async () => {
  const resolver = new CapabilityResolver();
  const called: string[] = [];
  let current = binding("cli", "cli");
  const adapters = (["browser", "cli", "mcp", "link"] as const).map(
    (channel): CapabilityAdapter => ({
      channel,
      discover: async () => {
        called.push(channel);
        return channel === "cli" ? current : undefined;
      },
    }),
  );
  const selected = await resolver.resolve(intent, adapters);
  expect(called).toEqual(["link", "mcp", "cli"]);
  selected.bindingId = "caller-mutation";
  expect((await resolver.resolve(intent, [])).bindingId).toBe("cli");
  current = binding("other", "cli");
  await expect(resolver.resolve(intent, adapters)).rejects.toThrow("stale_reference");
  resolver.invalidate(intent);
  expect((await resolver.resolve(intent, adapters)).bindingId).toBe("other");
});
test("concurrent resolution shares one discovery and never selects two accounts", async () => {
  const resolver = new CapabilityResolver(),
    release = deferred();
  let count = 0;
  const adapters: CapabilityAdapter[] = [
    {
      channel: "link",
      discover: async () => {
        count++;
        await release.promise;
        return binding(String(count));
      },
    },
  ];
  const first = resolver.resolve(intent, adapters),
    second = resolver.resolve(intent, adapters);
  release.resolve();
  expect(await first).toEqual(await second);
  expect(count).toBe(1);
});
test("invalidating an awaited discovery prevents a late binding from resurrecting revoked authority", async () => {
  const resolver = new CapabilityResolver(),
    started = deferred(),
    release = deferred();
  const first = resolver.resolve(intent, [
    {
      channel: "link",
      discover: async () => {
        started.resolve();
        await release.promise;
        return binding("old");
      },
    },
  ]);
  const rejected = first.then(
    () => undefined,
    (error: unknown) => error,
  );
  await started.promise;
  resolver.invalidate(intent);
  expect(
    (await resolver.resolve(intent, [{ channel: "link", discover: async () => binding("fresh") }]))
      .bindingId,
  ).toBe("fresh");
  release.resolve();
  expect(String(await rejected)).toContain("stale_reference");
  expect((await resolver.resolve(intent, [])).bindingId).toBe("fresh");
});
test("mismatched accounts fail authentication rather than silently falling through to browser", async () => {
  let browser = 0;
  await expect(
    new CapabilityResolver().resolve(intent, [
      { channel: "link", discover: async () => ({ ...binding("wrong"), account: "other" }) },
      {
        channel: "browser",
        discover: async () => {
          browser++;
          return binding("browser", "browser");
        },
      },
    ]),
  ).rejects.toThrow("authentication");
  expect(browser).toBe(0);
});
test("ordinary errors and strategy changes are bounded; declared polling does not exhaust their budget", () => {
  const budget = new OperationErrorBudget();
  expect(budget.observe({ fingerprint: "same", strategy: "link" })).toBe(true);
  expect(budget.observe({ fingerprint: "same", strategy: "link" })).toBe(true);
  expect(budget.observe({ fingerprint: "same", strategy: "link" })).toBe(false);
  expect(
    budget.observe({ fingerprint: "poll", strategy: "browser", pollingWithStopCondition: true }),
  ).toBe(true);
  expect(budget.observe({ fingerprint: "other", strategy: "mcp" })).toBe(true);
  expect(budget.observe({ fingerprint: "another", strategy: "browser" })).toBe(false);
  expect(budget.restartBrowser()).toBe(true);
  expect(budget.restartBrowser()).toBe(false);
});
