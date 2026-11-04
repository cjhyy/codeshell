import { expect, test } from "bun:test";
import { AccountFeatureService, type AccountFeatureAuthority } from "./feature-service.js";
import type { CloudAccountStatus } from "./types.js";
const origin = "https://account.example";
const offered = {
  "links.remote": { version: 1, enabled: true },
  "devices.dispatch": { version: 1, enabled: true },
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(initial: CloudAccountStatus = { state: "signed-out" }) {
  let status = initial;
  const listeners = new Set<() => void>();
  let publicCalls = 0;
  let privateCalls = 0;
  let fail = false;
  let overview: AccountFeatureAuthority["overview"] = async () => ({
    account: { id: status.account!.id, username: "user" },
    capabilities: { links: true },
    features: offered,
  });
  const authority: AccountFeatureAuthority = {
    status: () => status,
    onStatus: (cb) => {
      listeners.add(cb as () => void);
      return () => {
        listeners.delete(cb as () => void);
      };
    },
    capabilities: async () => {
      publicCalls++;
      if (fail) throw Error("offline");
      return { registrationAllowed: true, githubEnabled: false, features: offered };
    },
    overview: async (...args) => {
      privateCalls++;
      return overview(...args);
    },
  };
  const service = new AccountFeatureService({
    account: authority,
    origin,
    supported: ["links.remote", "devices.dispatch"],
  });
  return {
    service,
    authority,
    calls: () => [publicCalls, privateCalls],
    setFail: (value: boolean) => {
      fail = value;
    },
    setOverview: (value: typeof overview) => {
      overview = value;
    },
    change: (value: CloudAccountStatus) => {
      status = value;
      for (const listener of listeners) listener();
    },
  };
}
const signed = (id = "A", serviceOrigin = origin): CloudAccountStatus => ({
  state: "signed-in",
  origin: serviceOrigin,
  account: { id, username: id },
});
test("construction and snapshots are local; explicit anonymous discovery shows sign-in", async () => {
  const f = fixture();
  try {
    expect(f.service.snapshot()["links.remote"].state).toBe("hidden");
    expect(f.calls()).toEqual([0, 0]);
    const view = await f.service.refresh();
    expect(view["links.remote"].state).toBe("sign-in");
    expect(f.calls()).toEqual([1, 0]);
    expect(view["cloud.projects"].state).toBe("hidden");
  } finally {
    f.service.dispose();
  }
});
test("refresh shares requests, caches offline display and recovers", async () => {
  const f = fixture(signed());
  try {
    await Promise.all([f.service.refresh(), f.service.refresh()]);
    expect(f.calls()).toEqual([1, 1]);
    expect(f.service.snapshot()["links.remote"].state).toBe("ready");
    f.setFail(true);
    await f.service.refresh();
    expect(f.service.snapshot()["links.remote"]).toMatchObject({
      state: "pending",
      reason: "service_unreachable",
    });
    f.setFail(false);
    await f.service.refresh();
    expect(f.service.snapshot()["links.remote"].state).toBe("ready");
  } finally {
    f.service.dispose();
  }
});
test("late account A response cannot overwrite account B or restore a logged-out identity", async () => {
  const f = fixture(signed());
  let finish!: (value: any) => void;
  let seenSignal: AbortSignal | undefined;
  f.setOverview(async (_input, _authorized, signal) => {
    seenSignal = signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  try {
    const first = f.service.refresh();
    await tick();
    f.setOverview(async () => ({
      account: { id: "B", username: "B" },
      capabilities: { links: false },
      features: {},
    }));
    f.change(signed("B"));
    await tick();
    expect(seenSignal?.aborted).toBe(true);
    finish({
      account: { id: "A", username: "A" },
      capabilities: { links: true },
      features: offered,
    });
    await first;
    expect(f.service.snapshot()["links.remote"].state).toBe("hidden");
    f.change({ state: "signed-out" });
    await tick();
    expect(f.service.snapshot()["links.remote"].state).toBe("sign-in");
  } finally {
    f.service.dispose();
  }
});
test("same account id on a different origin drops cached deployment immediately", async () => {
  const f = fixture(signed());
  try {
    await f.service.refresh();
    f.setFail(true);
    f.change(signed("A", "https://other.example"));
    expect(f.service.snapshot()["links.remote"].state).toBe("hidden");
    await tick();
    expect(f.service.snapshot()["links.remote"].state).toBe("hidden");
  } finally {
    f.service.dispose();
  }
});
test("only an absent old overview uses fallback, not authentication or network failures", async () => {
  const f = fixture(signed());
  try {
    f.setOverview(async () => {
      throw Object.assign(Error("old"), { status: 404 });
    });
    await f.service.refresh();
    expect(f.service.snapshot()["links.remote"].state).toBe("ready");
    f.setOverview(async () => {
      throw Object.assign(Error("denied"), { status: 401 });
    });
    await f.service.refresh();
    expect(f.service.snapshot()["links.remote"].state).toBe("pending");
  } finally {
    f.service.dispose();
  }
});
test("setup entitlement ignores local readiness but business operations do not", async () => {
  const f = fixture(signed());
  const localService = new AccountFeatureService({
    account: f.authority,
    supported: ["devices.dispatch"],
    local: () => ({ "devices.dispatch": { ready: false, reason: "device_not_registered" } }),
  });
  try {
    await localService.refresh();
    expect(() => localService.requireEntitled("devices.dispatch")).not.toThrow();
    expect(() => localService.requireReady("devices.dispatch")).toThrow();
  } finally {
    localService.dispose();
    f.service.dispose();
  }
});

test("disposing removes cached permission and prevents late host work", async () => {
  const f = fixture(signed());
  await f.service.refresh();
  expect(f.service.snapshot()["links.remote"].state).toBe("ready");
  f.service.dispose();
  expect(f.service.snapshot()["links.remote"].state).toBe("hidden");
  expect(() => f.service.requireReady("links.remote")).toThrow("关闭");
  expect(() => f.service.requireEntitled("links.remote")).toThrow("关闭");
  const calls = f.calls();
  await f.service.refresh();
  expect(f.calls()).toEqual(calls);
});

test("construction does not load OS credentials before the host is ready", () => {
  let reads = 0;
  const authority = {
    status: () => {
      reads++;
      throw new Error("keychain not ready");
    },
    onStatus: () => () => {},
    capabilities: async () => {
      throw new Error("network");
    },
    overview: async () => {
      throw new Error("network");
    },
  };
  const service = new AccountFeatureService({ account: authority, supported: [] });
  expect(reads).toBe(0);
  service.dispose();
  service.snapshot();
  expect(reads).toBe(0);
});
