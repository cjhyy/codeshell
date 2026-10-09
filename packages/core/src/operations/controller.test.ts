import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OperationController, OperationFailure, type OperationAdapter } from "./controller.js";
import { canonicalOperationValue, OperationLedger, type OperationPlan } from "./ledger.js";
import { PlaintextCipher } from "../credentials/cipher.js";
import { OperationRecoveryFiles } from "./recovery.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "codeshell-operations-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const plan = (overrides: Partial<OperationPlan> = {}): OperationPlan => ({
  sessionId: "private-session",
  intentId: "trusted-intent",
  service: "fixture",
  action: "create",
  channel: "link",
  account: "private-account",
  target: "private-target",
  parameters: { body: "PRIVATE_BODY" },
  postcondition: { kind: "matches", body: "PRIVATE_BODY" },
  ...overrides,
});
function adapter(overrides: Partial<OperationAdapter> = {}): OperationAdapter {
  return {
    assertAuthorized() {},
    preflight: async () => {},
    validate: async () => {},
    authorize: async () => true,
    execute: async () => ({ id: "123" }),
    verify: async () => true,
    ...overrides,
  };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("original private recovery inputs persist before the one send and survive a cold lost response", async () => {
  const directory = root();
  const cipher = new PlaintextCipher();
  const ledger = new OperationLedger(directory, cipher);
  let sends = 0;
  const input = { authority: "original-account-grant", identity: { targetId: 42 } };
  const receipt = await new OperationController(ledger).run(
    plan(),
    adapter({
      recoveryInput: (phase) => (phase === "prepared" ? input : undefined),
      execute: async () => {
        sends++;
        const snapshot = JSON.parse(
          readFileSync(join(directory, ".operations/ledger.json"), "utf8"),
        );
        expect(snapshot.records[Object.keys(snapshot.records)[0]!].recovery.prepared).toHaveLength(
          64,
        );
        throw new Error("lost response");
      },
    }),
  );
  expect(receipt.state).toBe("unknown");
  const snapshot = JSON.parse(readFileSync(join(directory, ".operations/ledger.json"), "utf8"));
  const key = Buffer.from(cipher.decrypt(snapshot.key), "hex");
  const coldInput = JSON.parse(
    new OperationRecoveryFiles(join(directory, ".operations")).read(
      key,
      receipt.id,
      receipt.recovery!.prepared,
    ),
  );
  expect(coldInput).toEqual({ schema: 1, plan: plan(), payload: input });
  expect(ledger.provePlan(receipt, coldInput.plan)).toBe(true);
  expect(ledger.provePlan(receipt, { ...coldInput.plan, account: "different" })).toBe(false);
  expect(ledger.provePlan(receipt, { ...coldInput.plan, parameters: { body: "changed" } })).toBe(
    false,
  );
  expect(
    (await new OperationController(new OperationLedger(directory, cipher)).run(plan(), adapter()))
      .state,
  ).toBe("unknown");
  expect(sends).toBe(1);
  expect(() => ledger.captureRecovery(plan(), receipt.id, "identity", input)).toThrow();
  expect(
    JSON.parse(readFileSync(join(directory, ".operations/ledger.json"), "utf8")).records[
      receipt.id
    ],
  ).toEqual(receipt);
});

test("private input checkpoint failure blocks before send; failed verification still saves its original identity", async () => {
  const directory = root();
  const ledger = new OperationLedger(directory);
  let sends = 0;
  const original = ledger.captureRecovery.bind(ledger);
  ledger.captureRecovery = () => {
    throw new Error("storage unavailable");
  };
  const blocked = await new OperationController(ledger).run(
    plan(),
    adapter({
      recoveryInput: () => ({ prepared: true }),
      execute: async () => {
        sends++;
        return { id: "123" };
      },
    }),
  );
  expect(blocked.state).toBe("blocked");
  expect(sends).toBe(0);
  ledger.captureRecovery = original;
  const nextPlan = plan({ intentId: "separate-intent" });
  const receipt = await new OperationController(ledger).run(
    nextPlan,
    adapter({
      recoveryInput: (phase) =>
        phase === "prepared" ? { identity: null } : { identity: { id: 123 } },
      verify: async () => false,
    }),
  );
  expect(receipt.state).toBe("succeeded");
  expect(receipt.recovery!.identity).toHaveLength(64);
  ledger.sealForFinalization(nextPlan.sessionId);
  expect(() =>
    ledger.captureRecovery(nextPlan, receipt.id, "identity", { identity: { id: 999 } }),
  ).toThrow("finalized");
});

test("durable verified receipt replays without another send; raw input is absent and ownership is isolated", async () => {
  const directory = root();
  const ledger = new OperationLedger(directory, new PlaintextCipher());
  let writes = 0,
    reads = 0;
  const services = adapter({
    execute: async () => {
      writes++;
      return { id: "123" };
    },
    verify: async () => {
      reads++;
      return true;
    },
  });
  const first = await new OperationController(ledger).run(plan(), services);
  const second = await new OperationController(new OperationLedger(directory)).run(
    plan(),
    services,
  );
  expect(first.state).toBe("verified");
  expect(second).toEqual(first);
  expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
  expect(ledger.hasUnverifiedWrites("private-session")).toBe(false);
  const serialized = readFileSync(join(directory, ".operations/ledger.json"), "utf8");
  for (const value of [
    "PRIVATE_BODY",
    "private-session",
    "private-account",
    "private-target",
    "trusted-intent",
  ])
    expect(serialized).not.toContain(value);
  if (process.platform !== "win32") {
    expect(statSync(join(directory, ".operations")).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, ".operations/ledger.json")).mode & 0o777).toBe(0o600);
  }
});

test("lost response is durably unknown, cannot replay, and changed payload/account/target conflicts", async () => {
  const directory = root();
  let sends = 0;
  const services = adapter({
    execute: async () => {
      sends++;
      throw new Error("request consumed before disconnect");
    },
  });
  const first = await new OperationController(new OperationLedger(directory)).run(plan(), services);
  expect(first.state).toBe("unknown");
  const restarted = new OperationController(new OperationLedger(directory));
  expect((await restarted.run(plan(), services)).state).toBe("unknown");
  for (const changed of [
    { parameters: { body: "PRIVATE_BODY." } },
    { account: "different" },
    { target: "other" },
  ])
    await expect(restarted.run(plan(changed), services)).rejects.toThrow("immutable plan");
  expect(sends).toBe(1);
  expect(restarted.ledger.hasUnverifiedWrites("private-session")).toBe(true);
  expect(restarted.ledger.hasUnverifiedWrites("other-session")).toBe(false);
});

test("only successful independent reads verify; a failed read resumes without repeating the write", async () => {
  const ledger = new OperationLedger(root());
  let sends = 0,
    matches = false;
  const services = adapter({
    execute: async () => {
      sends++;
      return { id: "123" };
    },
    verify: async () => matches,
  });
  const controller = new OperationController(ledger);
  expect((await controller.run(plan(), services)).state).toBe("succeeded");
  expect(ledger.hasUnverifiedWrites("private-session")).toBe(true);
  matches = true;
  expect((await controller.run(plan(), services)).state).toBe("verified");
  expect(sends).toBe(1);
});

test("two failed verification reads exhaust the Run budget without a third read or another write", async () => {
  const controller = new OperationController(new OperationLedger(root()));
  let reads = 0,
    sends = 0;
  const services = adapter({
    execute: async () => {
      sends++;
      return { id: "123" };
    },
    verify: async () => {
      reads++;
      return false;
    },
  });
  for (let attempt = 0; attempt < 5; attempt++)
    expect((await controller.run(plan(), services)).state).toBe("succeeded");
  expect({ reads, sends }).toEqual({ reads: 2, sends: 1 });
});

test("competing async intents cannot claim after another Session write has become unknown", async () => {
  const directory = root();
  const ready = deferred(),
    release = deferred();
  const second = new OperationController(new OperationLedger(directory)).run(
    plan({ intentId: "second" }),
    adapter({
      validate: async () => {
        ready.resolve();
        await release.promise;
      },
      execute: async () => {
        throw new Error("second send must never occur");
      },
    }),
  );
  await ready.promise;
  const first = await new OperationController(new OperationLedger(directory)).run(
    plan(),
    adapter({
      execute: async () => {
        throw new Error("first write consumed then disconnected");
      },
    }),
  );
  expect(first.state).toBe("unknown");
  release.resolve();
  expect((await second).state).toBe("blocked");
});

test("parallel invocation seals uncertainty and late completion cannot upgrade it", async () => {
  const directory = root();
  const started = deferred(),
    release = deferred();
  let sends = 0,
    reads = 0;
  const services = adapter({
    execute: async () => {
      sends++;
      started.resolve();
      await release.promise;
      return { id: "123" };
    },
    verify: async () => {
      reads++;
      return true;
    },
  });
  const first = new OperationController(new OperationLedger(directory)).run(plan(), services);
  await started.promise;
  const second = await new OperationController(new OperationLedger(directory)).run(
    plan(),
    services,
  );
  expect(second.state).toBe("unknown");
  release.resolve();
  expect((await first).state).toBe("unknown");
  expect({ sends, reads }).toEqual({ sends: 1, reads: 0 });
  expect(new OperationLedger(directory).hasUnverifiedWrites("private-session")).toBe(true);
});

test("Run finalization seals a pending verification against a late read", async () => {
  const ledger = new OperationLedger(root());
  const started = deferred(),
    release = deferred();
  const running = new OperationController(ledger).run(
    plan(),
    adapter({
      verify: async () => {
        started.resolve();
        await release.promise;
        return true;
      },
    }),
  );
  await started.promise;
  expect(ledger.sealForFinalization("private-session")).toBe(true);
  release.resolve();
  expect((await running).state).toBe("unknown");
});

test("Run finalization prevents an awaited planned operation from making its first send", async () => {
  const directory = root(),
    ledger = new OperationLedger(directory);
  const started = deferred(),
    release = deferred();
  let sends = 0;
  const services = adapter({
    validate: async () => {
      started.resolve();
      await release.promise;
    },
    execute: async () => {
      sends++;
      return { id: "123" };
    },
  });
  const running = new OperationController(ledger).run(plan(), services);
  await started.promise;
  expect(ledger.sealForFinalization("private-session")).toBe(false);
  release.resolve();
  expect((await running).state).toBe("blocked");
  expect(
    (await new OperationController(new OperationLedger(directory)).run(plan(), services)).state,
  ).toBe("blocked");
  expect(sends).toBe(0);
});

test("revocation after an awaited send keeps its receipt but never performs the independent read", async () => {
  const ledger = new OperationLedger(root());
  let authorized = true,
    reads = 0;
  const result = await new OperationController(ledger).run(
    plan(),
    adapter({
      assertAuthorized: () => {
        if (!authorized) throw new OperationFailure("permission");
      },
      execute: async () => {
        authorized = false;
        return { id: "123" };
      },
      verify: async () => {
        reads++;
        return true;
      },
    }),
  );
  expect(result.state).toBe("succeeded");
  expect(result.error).toBe("permission");
  expect(reads).toBe(0);
  expect(ledger.hasUnverifiedWrites("private-session")).toBe(true);
});

test("failed terminal checkpoint still fences this controller's late verification in memory", async () => {
  const directory = root(),
    ledger = new OperationLedger(directory);
  const started = deferred(),
    release = deferred();
  const running = new OperationController(ledger).run(
    plan(),
    adapter({
      verify: async () => {
        started.resolve();
        await release.promise;
        return true;
      },
    }),
  );
  await started.promise;
  const file = join(directory, ".operations/ledger.json"),
    saved = readFileSync(file, "utf8");
  writeFileSync(file, "{}");
  expect(() => ledger.sealForFinalization("private-session")).toThrow();
  writeFileSync(file, saved);
  release.resolve();
  expect((await running).state).toBe("unknown");
  expect(new OperationLedger(directory).hasUnverifiedWrites("private-session")).toBe(true);
});

test("a new user turn cannot blindly create another write while the Session has an unknown send", async () => {
  const ledger = new OperationLedger(root());
  let sends = 0;
  const controller = new OperationController(ledger);
  const services = adapter({
    execute: async () => {
      sends++;
      throw new Error("consumed");
    },
  });
  expect((await controller.run(plan(), services)).state).toBe("unknown");
  const later = await controller.run(plan({ intentId: "later-continue" }), services);
  expect(later.state).toBe("blocked");
  expect(sends).toBe(1);
});

test("failed checkpoint leaves a durable running/unknown claim, never an unclaimed retry", async () => {
  class FailingLedger extends OperationLedger {
    override settle(): never {
      throw new Error("fixture disk write failure");
    }
  }
  const directory = root();
  let sends = 0;
  const services = adapter({
    execute: async () => {
      sends++;
      return { id: "123" };
    },
  });
  expect(
    (await new OperationController(new FailingLedger(directory)).run(plan(), services)).state,
  ).toBe("unknown");
  expect(
    (await new OperationController(new OperationLedger(directory)).run(plan(), services)).state,
  ).toBe("unknown");
  expect(sends).toBe(1);
});

test("cancelled/preflight-denied plans send nothing and cannot borrow new authority", async () => {
  let sends = 0;
  const ledger = new OperationLedger(root());
  const services = adapter({
    preflight: async () => {
      throw new OperationFailure("permission");
    },
    execute: async () => {
      sends++;
      return { id: "123" };
    },
  });
  expect((await new OperationController(ledger).run(plan(), services)).state).toBe("blocked");
  expect(ledger.hasUnverifiedWrites("private-session")).toBe(false);
  expect(sends).toBe(0);
});

test("same physical ledger through a symlink shares the same idempotency identity", async () => {
  if (process.platform === "win32") return; // Unprivileged Windows symlink creation is not portable.
  const directory = root(),
    aliases = root();
  const alias = join(aliases, "alias");
  symlinkSync(directory, alias, "dir");
  let sends = 0;
  const services = adapter({
    execute: async () => {
      sends++;
      return { id: "123" };
    },
  });
  const first = await new OperationController(new OperationLedger(directory)).run(plan(), services);
  const second = await new OperationController(new OperationLedger(alias)).run(plan(), services);
  expect(second.id).toBe(first.id);
  expect(sends).toBe(1);
});

test("corrupt or foreign-key state fails closed before any send", async () => {
  const directory = root();
  new OperationLedger(directory).prepare(plan());
  let sends = 0;
  const services = adapter({
    execute: async () => {
      sends++;
      return { id: "123" };
    },
  });
  const ledger = new OperationLedger(directory, {
    encrypt: (text) => text,
    decrypt: () => {
      throw new Error("foreign key");
    },
  });
  await expect(new OperationController(ledger).run(plan(), services)).rejects.toThrow(
    "foreign key",
  );
  writeFileSync(join(directory, ".operations/ledger.json"), "{}");
  await expect(
    new OperationController(new OperationLedger(directory)).run(plan(), services),
  ).rejects.toThrow();
  expect(sends).toBe(0);
});

test("canonical request validation rejects accessors, cycles, nonfinite values, and oversized bodies", () => {
  expect(canonicalOperationValue({ b: 2, a: 1 })).toBe(canonicalOperationValue({ a: 1, b: 2 }));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    cycle,
    {
      get secret() {
        throw new Error("must not evaluate");
      },
    },
    NaN,
    undefined,
    "x".repeat(70_000),
  ])
    expect(() => canonicalOperationValue(value)).toThrow();
});

test("independent processes atomically claim one send without holding locks over async IO", async () => {
  const directory = root();
  const receipt = new OperationLedger(directory).prepare(plan());
  const moduleUrl = new URL("./ledger.ts", import.meta.url).href;
  const code = `import { OperationLedger } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(new OperationLedger(process.argv[1]).claim(process.argv[2]).claimed));`;
  const children = Array.from(
    { length: 8 },
    () =>
      new Promise<boolean>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", code, directory, receipt.id], {
          env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "",
          error = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          error += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) =>
          status === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)),
        );
      }),
  );
  expect((await Promise.all(children)).filter(Boolean)).toHaveLength(1);
  expect(new OperationLedger(directory).sealForFinalization("private-session")).toBe(true);
});
