import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const fixtures: string[] = [];
const LOCAL_SECRET = "fixture-local-link-secret";
const IPC_SECRET = "fixture-desktop-only-secret";
const credentialMetadata = {
  id: "fixture-link",
  type: "link",
  label: "Fixture Link",
  hasSecret: true,
  meta: { linkProvider: "github", linkExecutionRuntime: "local" },
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

interface WorkerProbeResult {
  before: { credentials: Array<{ id: string; hasSecret: boolean }>; readable: boolean };
  after: { credentials: Array<{ id: string; hasSecret: boolean }>; readable: boolean };
  resolved: string;
}

/** Launch the real entry point in a child: its timers/stdin/global credential
 * access must never contaminate the Bun test runner or the user's HOME. */
async function probeWorker(mode?: string) {
  // macOS /var is a symlink; IPC snapshots key cwd by exact string.
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "stdio-credentials-")));
  fixtures.push(fixture);
  const userDir = join(fixture, "home");
  const workspace = join(fixture, "workspace");
  const dataRoot = join(fixture, "worker-data");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(workspace, ".code-shell"), { recursive: true });
  writeFileSync(
    join(workspace, ".code-shell", "settings.json"),
    JSON.stringify({
      credentials: [
        {
          id: "fixture-model-key",
          catalogId: "deepseek",
          apiKey: "fixture-key",
          baseUrl: "http://127.0.0.1:9/v1",
        },
      ],
      modelConnections: [
        {
          id: "fixture-model",
          catalogId: "deepseek",
          tag: "text",
          model: "deepseek-v4-flash",
          credentialId: "fixture-model-key",
        },
      ],
      defaults: { text: "fixture-model" },
    }),
  );
  const sourceUrl = (file: string) => pathToFileURL(resolve(import.meta.dir, file)).href;
  const resultPath = join(fixture, "result.json");
  const probePath = join(fixture, "probe.ts");
  writeFileSync(
    probePath,
    `
import { writeFileSync } from "node:fs";
const { CredentialStore } = await import(${JSON.stringify(sourceUrl("../../credentials/store.ts"))});
new CredentialStore(process.cwd()).save("user", {
  id: "fixture-link", type: "link", label: "Fixture Link",
  secret: ${JSON.stringify(LOCAL_SECRET)},
  meta: { linkProvider: "github", linkExecutionRuntime: "local" }
});
await import(${JSON.stringify(sourceUrl("../agent-server-stdio.ts"))});
const { getCredentialAccess } = await import(${JSON.stringify(sourceUrl("../../credentials/access.ts"))});
const access = getCredentialAccess();
const before = access.listMaskedWithStatus(process.cwd(), "full");
if (process.env.CODE_SHELL_CREDENTIAL_ACCESS !== "local") {
  let unsubscribe;
  const snapshotArrived = new Promise(resolve => { unsubscribe = access.subscribe(resolve); });
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/credentialsReady" }) + "\\n");
  await snapshotArrived;
  unsubscribe();
}
const after = access.listMaskedWithStatus(process.cwd(), "full");
const resolved = await access.resolveValue({ cwd: process.cwd(), id: "fixture-link", scope: "full", purpose: "link" });
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, after, resolved }));
process.emit("SIGTERM");
`,
  );

  // An explicit environment prevents a developer's model keys, module hooks,
  // desktop credential-mode override, or actual home directory from leaking in.
  const child = spawn(process.execPath, [probePath], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: userDir,
      AGENT_CWD: workspace,
      CODE_SHELL_DATA_ROOT: dataRoot,
      CODE_SHELL_CAPABILITY_MODULES: "",
      ...(mode === undefined ? {} : { CODE_SHELL_CREDENTIAL_ACCESS: mode }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const requests: Array<{ method: string; params?: unknown }> = [];
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let frame: { id?: string; method?: string; params?: unknown };
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!frame.method) return;
    requests.push({ method: frame.method, params: frame.params });
    if (frame.method === "fixture/credentialsReady") {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "desktop/credentialSnapshot",
          params: {
            revision: 1,
            entries: [
              {
                cwd: workspace,
                full: [credentialMetadata],
                project: [],
                readableFull: true,
                readableProject: true,
                envFull: {},
                envProject: {},
              },
            ],
          },
        }) + "\n",
      );
    } else if (frame.method === "desktop/credentialResolve") {
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { value: IPC_SECRET } }) + "\n",
      );
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Credential worker probe timed out: ${stderr.slice(-4_000)}`));
      }, 15_000);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code !== 0)
          reject(new Error(`Credential worker exited ${code ?? signal}: ${stderr.slice(-4_000)}`));
        else resolve();
      });
    });
    return {
      result: JSON.parse(readFileSync(resultPath, "utf8")) as WorkerProbeResult,
      requests,
      stdout,
    };
  } finally {
    if (timer) clearTimeout(timer);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

describe("real stdio worker credential host selection", () => {
  test("headless local mode lists and resolves its saved Link without desktop IPC", async () => {
    const { result, requests, stdout } = await probeWorker("local");
    expect(result.before.readable).toBe(true);
    expect(result.before.credentials.map((credential) => credential.id)).toEqual(["fixture-link"]);
    expect(result.after.credentials[0]!.hasSecret).toBe(true);
    expect(result.resolved).toBe(LOCAL_SECRET);
    expect(requests.some((request) => request.method.startsWith("desktop/credential"))).toBe(false);
    expect(stdout).not.toContain(LOCAL_SECRET);
  }, 20_000);

  test("default desktop mode requires its host snapshot and resolves secrets over IPC", async () => {
    const { result, requests, stdout } = await probeWorker();
    // A real local credential exists, but the default worker must not read it.
    expect(result.before).toEqual({ credentials: [], readable: false });
    expect(result.after.readable).toBe(true);
    expect(result.after.credentials).toEqual([credentialMetadata]);
    expect(result.resolved).toBe(IPC_SECRET);
    expect(
      requests.filter((request) => request.method === "desktop/credentialResolve"),
    ).toHaveLength(1);
    expect(
      requests.find((request) => request.method === "desktop/credentialResolve")!.params,
    ).toMatchObject({ id: "fixture-link", scope: "full", purpose: "link" });
    expect(stdout).not.toContain(LOCAL_SECRET);
    expect(stdout).not.toContain(IPC_SECRET);
  }, 20_000);
});
