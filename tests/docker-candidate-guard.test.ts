import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { candidateHash, candidateFile } from "../scripts/docker-candidate-guard.mjs";
import {
  candidateCreateArguments,
  candidateInspection,
  candidateProjectNames,
  createCandidateDockerAdapter,
  validateCandidateDockerArguments,
} from "../scripts/docker-candidate-adapter.mjs";

const root = resolve(import.meta.dir, "..");
const node = realpathSync(Bun.which("node")!);
const installationId = "7fd72c35-cf18-498b-9bb7-f06705d59cca";
const project = {
  id: "a1de6837-ce16-4d5c-a320-180b9cb38b58",
  ownerId: "fixture-owner",
  generation: 1,
};
const policy = {
  installationId,
  dataDir: "/private/synthetic/data",
  image: "fixture:immutable",
  imageId: `sha256:${"a".repeat(64)}`,
};

async function actualNode(change: (config: any, env: Record<string, string>) => void = () => {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "docker-candidate-guard-")));
  chmodSync(home, 0o700);
  const bundle = join(home, "bundle");
  mkdirSync(bundle, { mode: 0o700 });
  for (const file of ["docker-candidate-guard.mjs", "docker-candidate-preload.mjs"])
    copyFileSync(join(root, "scripts", file), join(bundle, file));
  const childEntry = join(home, "child.mjs");
  writeFileSync(
    childEntry,
    `import assert from 'node:assert/strict';
assert.equal(globalThis[Symbol.for('codeshell.docker-candidate.pre-core')].role,'worker');
assert.throws(()=>fetch('https://external.invalid/'),/Docker candidate refused/);
console.log('child guarded');`,
    { mode: 0o600 },
  );
  const preload = join(bundle, "docker-candidate-preload.mjs");
  const configPath = join(home, "policy.json");
  const receipt = join(home, "receipt.jsonl");
  const config = {
    version: 1,
    role: "installer",
    home,
    dataRoot: home,
    preload,
    preloadHash: candidateHash(readFileSync(preload)),
    guardHash: candidateHash(readFileSync(join(bundle, "docker-candidate-guard.mjs"))),
    receipt,
    origins: [],
    listeners: [{ host: "127.0.0.1", port: 0 }],
    children: [
      {
        path: node,
        sha256: candidateFile(node, { maximum: 128 * 1024 * 1024 }).sha256,
        args: [childEntry],
        entry: childEntry,
        entryHash: candidateHash(readFileSync(childEntry)),
        cwd: home,
        role: "worker",
      },
    ],
  };
  const env: Record<string, string> = {
    PATH: dirname(node),
    HOME: home,
    USERPROFILE: home,
    CODE_SHELL_HOME: join(home, ".code-shell"),
    NODE_OPTIONS: `--import=${preload}`,
    CODESHELL_DOCKER_CANDIDATE_CONFIG: configPath,
    CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: "",
  };
  change(config, env);
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH = candidateHash(readFileSync(configPath));
  let child;
  let closed = false;
  try {
    child = spawn(node, [join(root, "tests/fixtures/docker-candidate-guard-case.mjs")], {
      cwd: home,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => {
      stdout += part;
    });
    child.stderr.on("data", (part) => {
      stderr += part;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const [code, signal] = await once(child, "close").finally(() => clearTimeout(timer));
    closed = true;
    return {
      code,
      signal,
      stdout,
      stderr,
      reached: existsSync(join(home, "entry-reached")),
      receipt: existsSync(receipt)
        ? readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse)
        : [],
    };
  } finally {
    if (child && !closed) {
      child.kill("SIGKILL");
      await once(child, "close");
      closed = true;
    }
    if (!child || closed) rmSync(home, { recursive: true, force: true });
  }
}

test("real Node installs guard before entry and every permitted descendant, with PID receipts", async () => {
  const value = await actualNode();
  expect(value.stderr).toBe("");
  expect(value.code).toBe(0);
  expect(value.reached).toBe(true);
  expect(
    value.receipt.filter((event) => event.event === "pre-core").map((event) => event.role),
  ).toEqual(["installer", "worker"]);
  const started = value.receipt.find((event) => event.event === "child-started");
  expect(
    value.receipt.some((event) => event.event === "pre-core" && event.pid === started.childPid),
  ).toBe(true);
});

for (const [name, change] of [
  [
    "wrong HOME",
    (_config, env) => {
      env.HOME = "/";
    },
  ],
  [
    "preload digest",
    (config) => {
      config.preloadHash = "0".repeat(64);
    },
  ],
  [
    "non-private receipt parent",
    (config) => {
      config.receipt = "/tmp/unowned-candidate-receipt";
    },
  ],
  [
    "wrong role",
    (_config, env) => {
      env.CODESHELL_DOCKER_CANDIDATE_ROLE = "unknown";
    },
  ],
] as const)
  test(`unsafe ${name} fails before the actual entry`, async () => {
    const value = await actualNode(change);
    expect(value.code).not.toBe(0);
    expect(value.reached).toBe(false);
  });

test("Docker adapter accepts only frozen production argv and fresh registry identities", () => {
  const args = candidateCreateArguments(policy, project, "b".repeat(64));
  expect(validateCandidateDockerArguments(policy, [project], args).kind).toBe("create");
  for (const changed of [
    [...args, "--privileged"],
    args.map((part) => (part === "1000:1000" ? "0:0" : part)),
    args.map((part) => (part === "127.0.0.1::8790" ? "0.0.0.0::8790" : part)),
    args.map((part) => (part === policy.image ? "external:mutable" : part)),
    args.map((part) =>
      part.startsWith("type=bind,") ? "type=bind,source=/,target=/host,readonly" : part,
    ),
  ])
    expect(() => validateCandidateDockerArguments(policy, [project], changed)).toThrow("refused");
  expect(() => validateCandidateDockerArguments(policy, [], args)).toThrow("refused");
  expect(() =>
    validateCandidateDockerArguments(policy, [project], ["run", "--privileged", policy.image]),
  ).toThrow("refused");
});

test("container inspection only mints exact loopback ports for a pinned image and owned generation", () => {
  const names = candidateProjectNames(installationId, project);
  const operation = validateCandidateDockerArguments(
    policy,
    [project],
    ["container", "inspect", names.container],
  );
  const resource = {
    Id: "c".repeat(64),
    Name: `/${names.container}`,
    Image: policy.imageId,
    State: { Running: true },
    Config: {
      Labels: {
        "io.codeshell.project-runtime.installation": installationId,
        "io.codeshell.project-runtime.project": project.id,
        "io.codeshell.project-runtime.owner": project.ownerId,
        "io.codeshell.project-runtime.generation": "1",
        "io.codeshell.project-runtime.configuration": "b".repeat(64),
      },
    },
    NetworkSettings: { Ports: { "8790/tcp": [{ HostIp: "127.0.0.1", HostPort: "32941" }] } },
  };
  expect(candidateInspection(policy, operation, JSON.stringify([resource])).origin).toBe(
    "http://127.0.0.1:32941",
  );
  for (const mutate of [
    (copy) => {
      copy.Config.Labels["io.codeshell.project-runtime.owner"] = "other";
    },
    (copy) => {
      copy.NetworkSettings.Ports["8790/tcp"][0].HostIp = "0.0.0.0";
    },
    (copy) => {
      copy.Image = `sha256:${"f".repeat(64)}`;
    },
    (copy) => {
      copy.Id = "mutable-name";
    },
  ]) {
    const copy = structuredClone(resource);
    mutate(copy);
    expect(() => candidateInspection(policy, operation, JSON.stringify([copy]))).toThrow("refused");
  }
});

test("container start cannot be issued without a native pre-Core egress ACK implementation", () => {
  const adapter = createCandidateDockerAdapter(
    {
      ...policy,
      command: "docker",
      dockerPath: node,
      dockerHash: candidateFile(node, { maximum: 128 * 1024 * 1024 }).sha256,
    },
    { projects: () => [project] },
  );
  let calls = 0;
  expect(() =>
    adapter({
      command: "docker",
      args: ["container", "start", candidateProjectNames(installationId, project).container],
      callback() {},
      original() {
        calls++;
      },
      record() {},
    }),
  ).toThrow("refused");
  expect(calls).toBe(0);
});
