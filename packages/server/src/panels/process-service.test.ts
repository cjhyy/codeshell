import { PanelExecutionGate } from "./execution-gate.js";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PanelAppProcessService, type PanelProcessOwner } from "./process-service.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Process fixture did not reach expected state");
    await new Promise((done) => setTimeout(done, 5));
  }
}

describe("shared Panel process lifecycle", () => {
  const roots: string[] = [];
  const services: PanelAppProcessService[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) service.close();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(
    options: Partial<ConstructorParameters<typeof PanelAppProcessService>[0]> = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "panel-process-server-"));
    roots.push(root);
    const binary = join(root, "fixture-tool");
    await writeFile(binary, '#!/bin/sh\nprintf "ran\\n" >> marker\nprintf "output\\n"\n');
    await chmod(binary, 0o755);
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const owner: PanelProcessOwner = {
      guestId: 1,
      appId: "fixture",
      appTitle: "Fixture",
      revision: "r1",
      send: (event, payload) => {
        events.push({ event, payload });
      },
    };
    const service = new PanelAppProcessService({
      env: { PATH: root },
      confirmExecution: async () => true,
      ...options,
    });
    services.push(service);
    const executable = await service.findExecutable(owner, { name: "fixture-tool" });
    const directory = await service.grantDirectory(owner, root);
    const params = {
      executableHandle: executable.handle,
      directoryHandle: directory.handle,
      args: [],
    };
    return { root, binary, service, owner, params, events };
  }

  test("package occupation spans approval, spawned process and revocation cleanup", async () => {
    const gate = new PanelExecutionGate();
    const scope = { appId: "fixture", projectPath: "/process-lease-test" };
    const mutate = () =>
      gate.mutate(
        () => true,
        async () => {},
      );
    const approval = deferred<boolean>();
    let asked = false;
    const f = await fixture({
      acquireExecution: () => gate.enter(scope),
      confirmExecution: async () => {
        asked = true;
        return approval.promise;
      },
    });
    await writeFile(f.binary, "#!/bin/sh\nexec /bin/sleep 30\n");
    const starting = f.service.start(f.owner, f.params);
    try {
      await eventually(() => asked);
      await expect(mutate()).rejects.toThrow("正在提交");
    } finally {
      approval.resolve(true);
    }
    const process = await starting;
    const exited = f.service.waitForExit(f.owner, process);
    await expect(mutate()).rejects.toThrow("正在提交");
    f.service.revokeGuest(f.owner.guestId);
    await expect(mutate()).rejects.toThrow("正在提交");
    await exited;
    await new Promise((done) => setTimeout(done, 0));
    await mutate();
  });

  test("refused execution releases admission, and a package write prevents spawning", async () => {
    const gate = new PanelExecutionGate();
    const f = await fixture({
      acquireExecution: () => gate.enter({ appId: "fixture", projectPath: "/process-refusal" }),
      confirmExecution: async () => false,
    });
    await expect(f.service.start(f.owner, f.params)).rejects.toThrow();
    await gate.mutate(
      () => true,
      async () => {
        await expect(f.service.start(f.owner, f.params)).rejects.toThrow("正在更新");
      },
    );
    expect(f.events).toHaveLength(0);
  });

  test("sealed input changed during process approval is rejected and cleaned before execution", async () => {
    let allowed = true,
      cleaned = 0;
    const decision = deferred<boolean>();
    let asked = false;
    const f = await fixture({
      confirmExecution: async () => {
        asked = true;
        return decision.promise;
      },
    });
    const file = join(f.root, "private-input");
    await writeFile(file, "private-fixture");
    const grant = await f.service.grantFileArgument(f.owner, {
      executableHandle: f.params.executableHandle,
      argumentName: "--input",
      path: file,
      validate: async () => {
        if (!allowed) throw new Error("private authorization details");
      },
      cleanup: () => {
        cleaned++;
      },
    });
    const pending = f.service.start(f.owner, { ...f.params, fileArgumentHandles: [grant.handle] });
    await eventually(() => asked);
    allowed = false;
    decision.resolve(true);
    await expect(pending).rejects.toThrow(/authorization changed/);
    expect(cleaned).toBe(1);
    expect(await readFile(join(f.root, "marker"), "utf8").catch(() => "")).toBe("");
  });

  test("revoking a sealed input stops a running program and leaves no reusable grant", async () => {
    let allowed = true,
      cleaned = 0;
    const f = await fixture();
    const node = Bun.which("node")!;
    await writeFile(f.binary, '#!/bin/sh\nexec "' + node + '" -e "setTimeout(() => {}, 10000)"\n');
    const file = join(f.root, "private-input");
    await writeFile(file, "private-fixture");
    const grant = await f.service.grantFileArgument(f.owner, {
      executableHandle: f.params.executableHandle,
      argumentName: "--input",
      path: file,
      validate: async () => {
        if (!allowed) throw new Error("private authorization details");
      },
      cleanup: () => {
        cleaned++;
      },
    });
    await f.service.start(f.owner, { ...f.params, fileArgumentHandles: [grant.handle] });
    allowed = false;
    await eventually(() => f.events.some((event) => event.event === "process.exit"));
    expect(cleaned).toBe(1);
    expect(JSON.stringify(f.events)).not.toContain("private authorization details");
    await expect(
      f.service.start(f.owner, { ...f.params, fileArgumentHandles: [grant.handle] }),
    ).rejects.toThrow(/handle/);
  });

  test("revocation just before a fast process exits cannot report success", async () => {
    let allowed = true;
    const f = await fixture();
    const send = f.owner.send;
    f.owner.send = (event, payload) => {
      send(event, payload);
      if (event === "process.output") allowed = false;
    };
    const file = join(f.root, "private-input");
    await writeFile(file, "private-fixture");
    const grant = await f.service.grantFileArgument(f.owner, {
      executableHandle: f.params.executableHandle,
      argumentName: "--input",
      path: file,
      validate: async () => {
        if (!allowed) throw new Error("revoked");
      },
    });
    await f.service.start(f.owner, { ...f.params, fileArgumentHandles: [grant.handle] });
    await eventually(() => f.events.some((event) => event.event === "process.exit"));
    expect(f.events.find((event) => event.event === "process.exit")!.payload.code).toBe(1);
  });

  test("revocation during confirmation cannot spawn or cache the approval", async () => {
    const confirmation = deferred<boolean>();
    let approvals = 0;
    let remembered = 0;
    const f = await fixture({
      confirmExecution: async () => {
        approvals++;
        return confirmation.promise;
      },
      rememberExecutionApproval: async () => {
        remembered++;
      },
    });
    const pending = f.service.start(f.owner, f.params);
    await eventually(() => approvals === 1);
    f.service.revokeGuest(f.owner.guestId);
    confirmation.resolve(true);
    await expect(pending).rejects.toThrow(/no longer authorized/);
    expect(remembered).toBe(0);
    expect(await readFile(join(f.root, "marker"), "utf8").catch(() => "")).toBe("");
    const executable = await f.service.findExecutable(f.owner, { name: "fixture-tool" });
    const directory = await f.service.grantDirectory(f.owner, f.root);
    await f.service.start(f.owner, {
      executableHandle: executable.handle,
      directoryHandle: directory.handle,
      args: [],
    });
    await eventually(() => f.events.some(({ event }) => event === "process.exit"));
    expect(approvals).toBe(2);
    expect(remembered).toBe(1);
  });

  test("a closed service rejects pending authorization and later handle requests", async () => {
    const authorization = deferred<boolean>();
    let wait = false;
    let entered = false;
    const f = await fixture({
      isOwnerAuthorized: () => {
        if (!wait) return true;
        entered = true;
        return authorization.promise;
      },
    });
    wait = true;
    const pending = f.service.findExecutable(f.owner, { name: "fixture-tool" });
    await eventually(() => entered);
    f.service.close();
    authorization.resolve(true);
    await expect(pending).rejects.toThrow(/no longer authorized/);
    await expect(f.service.grantDirectory(f.owner, f.root)).rejects.toThrow(/closed/);
    await expect(f.service.start(f.owner, f.params)).rejects.toThrow(/closed/);
  });

  test("revocation during remembered approval lookup cannot admit a process", async () => {
    const approval = deferred<boolean>();
    let entered = false;
    const f = await fixture({
      isExecutionApproved: async () => {
        entered = true;
        return approval.promise;
      },
    });
    const pending = f.service.start(f.owner, f.params);
    await eventually(() => entered);
    f.service.revokeGuest(f.owner.guestId);
    approval.resolve(true);
    await expect(pending).rejects.toThrow(/no longer authorized/);
    expect(f.events).toHaveLength(0);
    expect(await readFile(join(f.root, "marker"), "utf8").catch(() => "")).toBe("");
  });

  test("directory and sealed-file grants cannot reappear after revocation during resolution", async () => {
    for (const method of ["directory", "file"] as const) {
      const authorization = deferred<boolean>();
      let checks = 0;
      let blocked = false;
      let checking = false;
      const f = await fixture({
        isOwnerAuthorized: () => {
          if (checking && ++checks === 2) {
            blocked = true;
            return authorization.promise;
          }
          return true;
        },
      });
      checking = true;
      const pending =
        method === "directory"
          ? f.service.grantDirectory(f.owner, f.root)
          : f.service.grantFileArgument(f.owner, {
              executableHandle: f.params.executableHandle,
              argumentName: "--input",
              path: f.binary,
            });
      await eventually(() => blocked);
      f.service.revokeGuest(f.owner.guestId);
      authorization.resolve(true);
      await expect(pending).rejects.toThrow(/no longer authorized/);
      await expect(f.service.start(f.owner, f.params)).rejects.toThrow(/invalid or belongs/);
    }
  });

  test("external owner authorization is checked after the execution confirmation", async () => {
    let authorized = true;
    const f = await fixture({
      isOwnerAuthorized: () => authorized,
      confirmExecution: async () => {
        authorized = false;
        return true;
      },
    });
    await expect(f.service.start(f.owner, f.params)).rejects.toThrow(/no longer authorized/);
    expect(await readFile(join(f.root, "marker"), "utf8").catch(() => "")).toBe("");
  });

  test("pending starts reserve capacity before awaiting concurrent approvals", async () => {
    const approval = deferred<boolean>();
    let entered = 0;
    const f = await fixture({
      confirmExecution: async () => {
        entered++;
        return approval.promise;
      },
    });
    const pending = [0, 1, 2].map(() => f.service.start(f.owner, f.params));
    await eventually(() => entered === 3);
    await expect(f.service.start(f.owner, f.params)).rejects.toThrow(/at most 3/);
    approval.resolve(true);
    expect(await Promise.all(pending)).toHaveLength(3);
    await eventually(() => f.events.filter(({ event }) => event === "process.exit").length === 3);
    expect((await readFile(join(f.root, "marker"), "utf8")).trim().split("\n")).toHaveLength(3);
    await f.service.start(f.owner, f.params);
    await eventually(() => f.events.filter(({ event }) => event === "process.exit").length === 4);
  });

  test("Web approvals stay with one guest epoch and never read app-wide remembered grants", async () => {
    let approvals = 0;
    let durableReads = 0;
    let durableWrites = 0;
    const f = await fixture({
      approvalScope: "guest",
      confirmExecution: async () => {
        approvals++;
        return true;
      },
      isExecutionApproved: async () => {
        durableReads++;
        return true;
      },
      rememberExecutionApproval: async () => {
        durableWrites++;
      },
    });
    let exits = 0;
    const run = async (owner: PanelProcessOwner) => {
      const executable = await f.service.findExecutable(owner, { name: "fixture-tool" });
      const directory = await f.service.grantDirectory(owner, f.root);
      await f.service.start(owner, {
        executableHandle: executable.handle,
        directoryHandle: directory.handle,
        args: [],
      });
      exits++;
      await eventually(
        () => f.events.filter(({ event }) => event === "process.exit").length === exits,
      );
    };
    await run(f.owner);
    await run(f.owner);
    expect(approvals).toBe(1);
    await run({ ...f.owner, guestId: 2 });
    expect(approvals).toBe(2);
    f.service.revokeGuest(f.owner.guestId);
    await run(f.owner);
    expect(approvals).toBe(3);
    expect(durableReads).toBe(0);
    expect(durableWrites).toBe(0);
  });

  test("an executable replaced during confirmation requires a new approval", async () => {
    const approval = deferred<boolean>();
    let entered = false;
    const f = await fixture({
      confirmExecution: async () => {
        entered = true;
        return approval.promise;
      },
    });
    const pending = f.service.start(f.owner, f.params);
    await eventually(() => entered);
    await writeFile(f.binary, '#!/bin/sh\nprintf "different executable\\n" >> marker\n');
    approval.resolve(true);
    await expect(pending).rejects.toThrow(/executable changed/);
    expect(await readFile(join(f.root, "marker"), "utf8").catch(() => "")).toBe("");
  });

  test("close during durable approval persistence cannot start a process", async () => {
    const persistence = deferred<void>();
    let entered = false;
    const f = await fixture({
      rememberExecutionApproval: async () => {
        entered = true;
        return persistence.promise;
      },
    });
    const pending = f.service.start(f.owner, f.params);
    await eventually(() => entered);
    f.service.close();
    persistence.resolve();
    await expect(pending).rejects.toThrow(/no longer authorized/);
    expect(await readFile(join(f.root, "marker"), "utf8").catch(() => "")).toBe("");
  });
});
