// Private test driver custody. All native calls below are captured, bounded and
// made with the fixture HOME; this module imports no Server/Core entry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateFile,
  candidateHash,
  installDockerCandidateGuard,
} from "./docker-candidate-guard.mjs";
import {
  candidateInspection,
  candidateProjectNames,
  candidateMissingContainer,
} from "./docker-candidate-adapter.mjs";
import { candidateRuntimeModules } from "./docker-candidate-controller.mjs";
import { fixturePorts } from "./docker-candidate-netns.mjs";
import {
  validateCandidateChromiumArguments,
  validateCandidateDriverDocker,
} from "./docker-candidate-driver.mjs";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const nativeSpawn = spawn;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const label = "io.codeshell.project-runtime.installation";
const deny = () => {
  throw new Error("Docker candidate setup custody refused");
};
async function deadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function candidateDockerExecutable(pathValue = process.env.PATH) {
  for (const directory of (pathValue ?? "").split(":")) {
    if (!directory.startsWith("/")) continue;
    const path = join(directory, "docker");
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {
      /* try the next fixed PATH entry */
    }
  }
  throw new Error("A native Docker executable is required");
}

export function candidatePrivateEnvironment(home, endpoint) {
  if (!/^unix:\/\/\/[^?#\0\r\n]+$/.test(endpoint)) deny();
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "DISPLAY"])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CODE_SHELL_HOME: join(home, ".code-shell"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    TMPDIR: join(home, "tmp"),
    NODE_ENV: "production",
    DISABLE_AUTOUPDATER: "1",
    DOCKER_HOST: endpoint,
  };
}

export function candidatePanelEntryHashes(directory) {
  if (!directory) return [];
  const hashes = [];
  const visit = (path, depth = 0) => {
    if (depth > 16) deny();
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) deny();
      if (entry.isDirectory()) visit(child, depth + 1);
      else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name))
        hashes.push(candidateFile(realpathSync(child), { maximum: 8 * 1024 * 1024 }).sha256);
      if (hashes.length > 512) deny();
    }
  };
  visit(realpathSync(directory));
  return [...new Set(hashes)];
}

export async function createDockerCandidateFixture({
  scratch,
  home,
  dataDir,
  root,
  entry,
  controllerArgs,
  image,
  containerCore,
  seccompPath,
  panelRoot,
  fixtureHashes,
  inlinePrograms,
  speechFixture,
  downloadFixture,
  browserRequired = false,
  videoRequired = false,
} = {}) {
  if (process.platform !== "linux")
    throw new Error("Guarded Docker candidate smoke requires Linux network namespaces");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const privateRoot = join(home, ".candidate");
  mkdirSync(privateRoot, { mode: 0o700 });
  mkdirSync(join(home, "tmp"), { mode: 0o700 });
  const env = candidatePrivateEnvironment(
    home,
    process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
  );
  const socketPath = realpathSync(env.DOCKER_HOST.slice("unix://".length));
  if (!statSync(socketPath).isSocket()) deny();
  env.DOCKER_HOST = `unix://${socketPath}`;
  const dockerPath = candidateDockerExecutable(env.PATH);
  const dockerHash = candidateFile(dockerPath, { maximum: 128 * 1024 * 1024 }).sha256;
  const node = realpathSync(process.execPath);
  const children = new Set(),
    allowed = new Map();
  let installed, helperImageId, installationId;
  const ownedResources = new Map(
    ["container", "network", "volume"].map((kind) => [kind, new Set()]),
  );
  const record = (event, data) => installed?.record(event, data);
  const native = (command, args, { input, timeout = 30000, environment = env, descriptor } = {}) =>
    new Promise((resolveResult, reject) => {
      if (
        candidateFile(command, { maximum: descriptor?.maximum ?? 128 * 1024 * 1024 }).sha256 !==
        (descriptor?.sha256 ?? (command === dockerPath ? dockerHash : undefined))
      )
        deny();
      const key = JSON.stringify([command, args]);
      if (installed)
        allowed.set(
          key,
          descriptor ?? { path: dockerPath, sha256: dockerHash, args, role: "driver", environment },
        );
      let proc;
      try {
        proc = (installed ? spawn : nativeSpawn)(command, args, {
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } finally {
        allowed.delete(key);
      }
      children.add(proc);
      let stdout = "",
        stderr = "",
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeout);
      proc.stdout.on("data", (part) => {
        stdout += part;
        if (stdout.length > 2 * 1024 * 1024) proc.kill("SIGKILL");
      });
      proc.stderr.on("data", (part) => {
        stderr = (stderr + part).slice(-20000);
      });
      let spawnError;
      proc.once("error", (error) => {
        spawnError = error;
      });
      proc.once("close", (code, signal) => {
        children.delete(proc);
        clearTimeout(timer);
        if (
          !spawnError &&
          !timedOut &&
          code === 0 &&
          signal === null &&
          stdout.length <= 2 * 1024 * 1024
        )
          resolveResult(stdout.trim());
        else
          reject(
            Object.assign(
              spawnError ??
                new Error(
                  `Candidate native command failed (${code ?? signal}${timedOut ? ", timeout" : ""})`,
                ),
              { stderr, stdout, code, signal, timedOut },
            ),
          );
      });
      proc.stdin.on("error", () => {});
      proc.stdin.end(input);
    });
  const initialDocker = (args, options) => native(dockerPath, args, options);
  let buildNonce, iid;
  try {
    const runtimeImage = JSON.parse(await initialDocker(["image", "inspect", image]))[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(runtimeImage?.Id)) deny();
    const imageId = runtimeImage.Id;
    // Build context contains only three reviewed helper inputs, never the repo,
    // operator HOME, credentials or a production runtime image modification.
    const buildContext = join(privateRoot, "helper-build");
    mkdirSync(join(buildContext, "scripts/fixtures"), { recursive: true, mode: 0o700 });
    const buildInputs = [
      "docker-candidate-netns.mjs",
      "fixtures/docker-candidate-netns-entry.mjs",
      "fixtures/Dockerfile.candidate-netns",
    ];
    const inputHashes = {};
    for (const name of buildInputs) {
      const source = join(moduleRoot, name);
      inputHashes[name] = candidateFile(source).sha256;
      copyFileSync(source, join(buildContext, "scripts", name));
    }
    buildNonce = randomBytes(16).toString("hex");
    iid = join(privateRoot, "helper-image-id");
    await initialDocker(
      [
        "build",
        "--pull=false",
        "--iidfile",
        iid,
        "--label",
        `io.codeshell.candidate-helper-build=${buildNonce}`,
        "-f",
        join(buildContext, "scripts/fixtures/Dockerfile.candidate-netns"),
        buildContext,
      ],
      { timeout: 600000 },
    );
    helperImageId = candidateFile(iid).bytes.toString().trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(helperImageId)) deny();
    const helperImage = JSON.parse(await initialDocker(["image", "inspect", helperImageId]))[0];
    if (
      helperImage?.Id !== helperImageId ||
      helperImage.Config?.Labels?.["io.codeshell.candidate-helper-build"] !== buildNonce
    )
      deny();
    writeFileSync(
      join(privateRoot, "helper-build-receipt.json"),
      JSON.stringify({ version: 1, helperImageId, inputHashes, buildNonce }) + "\n",
      { mode: 0o600 },
    );
    const moduleHashes = {};
    for (const name of [
      ...candidateRuntimeModules,
      "docker-candidate-controller.mjs",
      "docker-candidate-adapter.mjs",
      "docker-candidate-netns.mjs",
    ])
      moduleHashes[name] = candidateFile(join(moduleRoot, name)).sha256;
    const preload = join(moduleRoot, "docker-candidate-preload.mjs");
    const policyBase = {
      version: 1,
      home,
      dataRoot: dataDir,
      preload,
      preloadHash: moduleHashes["docker-candidate-preload.mjs"],
      guardHash: moduleHashes["docker-candidate-guard.mjs"],
      origins: [],
      children: [],
    };
    const nativePrograms = ["ffmpeg", "ffprobe", "chromium"].map((name) => ({
      path: `/usr/bin/${name}`,
      sha256: "IMAGE_PROGRAM",
    }));
    if (speechFixture)
      nativePrograms.push({
        path: "/workspace/.code-shell/smoke-speech-runtime/whisper-server",
        sha256: speechFixture.hashes["whisper-server"],
      });
    if (downloadFixture) {
      const meta = JSON.parse(
        candidateFile(join(realpathSync(downloadFixture), "fixture.json")).bytes,
      );
      if (
        !HASH.test(meta.sha256) ||
        candidateFile(join(realpathSync(downloadFixture), "yt-dlp"), { maximum: 20 * 1024 * 1024 })
          .sha256 !== meta.sha256
      )
        deny();
      nativePrograms.push({ path: "/data/panel-bin/yt-dlp", sha256: meta.sha256 });
    }
    const controllerPolicy = {
      ...policyBase,
      role: "controller",
      receipt: join(privateRoot, "controller.jsonl"),
      listeners: [{ host: "127.0.0.1", port: 0 }],
      docker: { command: "docker" },
      controller: {
        command: "docker",
        dockerPath,
        dockerHash,
        image,
        imageId,
        helperImageId,
        dataDir,
        helperInputHashes: inputHashes,
        containerCore,
        seccompPath: seccompPath
          ? join(
              dataDir,
              "project-runtime-security",
              `${candidateHash(JSON.stringify(JSON.parse(candidateFile(seccompPath).bytes)))}.json`,
            )
          : undefined,
        moduleHashes,
        entryHashes: [...new Set([...fixtureHashes, ...candidatePanelEntryHashes(panelRoot)])],
        inlinePrograms: inlinePrograms.map(candidateHash),
        nativePrograms,
        videoEditorHash:
          panelRoot && existsSync(join(panelRoot, "video-studio/app/tools/editor-runtime.mjs"))
            ? candidateFile(
                realpathSync(join(panelRoot, "video-studio/app/tools/editor-runtime.mjs")),
                { maximum: 8 * 1024 * 1024 },
              ).sha256
            : undefined,
      },
    };
    const policyPath = join(privateRoot, "controller-policy.json");
    const policyBytes = JSON.stringify(controllerPolicy) + "\n";
    writeFileSync(policyPath, policyBytes, { mode: 0o600 });
    const policyHash = candidateHash(policyBytes);
    const controllerEnv = {
      ...env,
      NODE_OPTIONS: `--import=${preload}`,
      CODESHELL_DOCKER_CANDIDATE_CONFIG: policyPath,
      CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: policyHash,
    };
    let browserPin;
    if (browserRequired) {
      const require = createRequire(join(root, "packages/desktop/package.json"));
      if (require("playwright-core/package.json").version !== "1.60.0") deny();
      const executable = realpathSync(require("playwright").chromium.executablePath());
      browserPin = {
        path: executable,
        sha256: candidateFile(executable, { maximum: 1024 * 1024 * 1024 }).sha256,
        maximum: 1024 * 1024 * 1024,
      };
    }
    const driverPath = join(privateRoot, "driver-policy.json");
    const driverPolicy = {
      ...policyBase,
      role: "driver",
      dataRoot: scratch,
      listeners: [],
      receipt: join(privateRoot, "driver.jsonl"),
    };
    writeFileSync(driverPath, JSON.stringify(driverPolicy) + "\n", { mode: 0o600 });
    Object.assign(env, {
      NODE_OPTIONS: `--import=${preload}`,
      CODESHELL_DOCKER_CANDIDATE_CONFIG: driverPath,
      CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: candidateFile(driverPath, { privateFile: true })
        .sha256,
    });
    // Playwright inherits this private environment. Clear provider/proxy/config
    // variables before its module can create a transport or launch Chromium.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    // The host's PDF extractor is a separate reviewed native call. It does not
    // import Core and receives only this candidate's exact generated PDF path.
    let pdfTextPin;
    if (browserRequired) {
      for (const directory of (env.PATH ?? "").split(":")) {
        const file = join(directory, "pdftotext");
        try {
          accessSync(file, constants.X_OK);
          const path = realpathSync(file);
          pdfTextPin = { path, sha256: candidateFile(path, { maximum: 128 * 1024 * 1024 }).sha256 };
          break;
        } catch {
          /* find the reviewed executable */
        }
      }
    }
    installed = installDockerCandidateGuard(driverPolicy, {
      childStarted(proc) {
        children.add(proc);
        proc.once("close", () => children.delete(proc));
      },
      driverChild(command, args, options) {
        const descriptor = allowed.get(JSON.stringify([command, args]));
        if (descriptor) return descriptor;
        if (browserPin && command === browserPin.path && options.detached === true) {
          validateCandidateChromiumArguments(args, {
            temporaryRoot: env.TMPDIR,
            audioPath: speechFixture?.audioPath,
          });
          return { ...browserPin, args, role: "driver", allowDetached: true };
        }
        if (
          pdfTextPin &&
          (command === "pdftotext" || command === pdfTextPin.path) &&
          JSON.stringify(args) ===
            JSON.stringify([join(root, "..", "evidence", "cloud-job-hunt-resume.pdf"), "-"])
        )
          return { ...pdfTextPin, args, role: "driver" };
        return undefined;
      },
    });
    const registry = () => {
      const path = join(dataDir, "project-control/registry.json");
      if (!existsSync(path)) return [];
      const value = JSON.parse(candidateFile(path, { privateFile: true }).bytes);
      if (
        !UUID.test(value.installationId) ||
        (installationId && value.installationId !== installationId) ||
        !Array.isArray(value.projects)
      )
        deny();
      installationId = value.installationId;
      for (const project of value.projects) candidateProjectNames(installationId, project);
      return value.projects;
    };
    const remember = (kind, output) => {
      const resources = JSON.parse(output);
      if (!Array.isArray(resources) || resources.length !== 1) deny();
      const value = resources[0];
      const labels = value.Config?.Labels ?? value.Labels;
      const project = registry().find(
        (project) => project.id === labels?.["io.codeshell.project-runtime.project"],
      );
      if (!project || labels?.[label] !== installationId) deny();
      const names = candidateProjectNames(installationId, project);
      const target = kind === "container" ? value.Name?.slice(1) : value.Name;
      if (!(kind === "volume" ? [names.data, names.workspace] : [names[kind]]).includes(target))
        deny();
      candidateInspection(
        { installationId, imageId },
        { kind: "inspect", resource: kind, project, target },
        output,
      );
      const id = kind === "volume" ? value.Name : value.Id;
      if (typeof id !== "string" || !id) deny();
      ownedResources.get(kind).add(id);
      return { value, project };
    };
    let offline;
    const runtimeRows = new Map();
    const parseRows = (bytes) => {
      const lines = bytes.toString().trim().split("\n");
      if (!lines.length || lines.some((line) => !line)) deny();
      const rows = lines.map((line) => JSON.parse(line));
      if (
        rows.some(
          (row) => !Number.isSafeInteger(row.pid) || row.pid < 1 || typeof row.event !== "string",
        )
      )
        deny();
      return rows;
    };
    const saveOffline = (result) => {
      const prefix = "CANDIDATE_OFFLINE_GUARD ";
      const index = result.indexOf(prefix);
      if (index < 0 || result.indexOf(prefix, index + prefix.length) !== -1) deny();
      const rows = parseRows(result.slice(index + prefix.length));
      if (
        !rows.some((row) => row.event === "offline-network-none-entry") ||
        rows.filter((row) => row.event === "pre-core").length !== 4
      )
        deny();
      runtimeRows.set("offline", rows);
      writeFileSync(
        join(privateRoot, "offline-guard.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        { mode: 0o600 },
      );
    };
    const docker = async (args, options) => {
      const projects = registry();
      const operation = validateCandidateDriverDocker(args, {
        installationId,
        projects,
        image,
        helperImageId,
        ownedResources,
        offline,
      });
      if (operation.kind === "exec") {
        const output = await native(dockerPath, ["container", "inspect", operation.target]);
        const { value, project } = remember("container", output);
        const pin = candidateInspection(
          { installationId, imageId },
          {
            kind: "inspect",
            resource: "container",
            target: value.Name.slice(1),
            project,
          },
          output,
        );
        if (!pin.origin) deny();
        args = [...args];
        args[operation.targetIndex] = pin.id;
      }
      if (operation.kind === "remove") {
        const output = await native(dockerPath, [operation.resource, "inspect", operation.target]);
        const { value } = remember(operation.resource, output);
        args = [...args];
        args[args.length - 1] = operation.resource === "volume" ? value.Name : value.Id;
      }
      let result;
      try {
        result = await native(dockerPath, args, options);
      } catch (error) {
        if (operation.kind === "offline" && typeof error?.stdout === "string") {
          try {
            saveOffline(error.stdout);
          } catch (receiptError) {
            // The operation remains the primary cause; the caught receipt
            // failure is retained alongside it in AggregateError.errors.
            throw new AggregateError(
              [error, receiptError],
              "Offline recovery and its guard receipt failed",
              // eslint-disable-next-line preserve-caught-error
              { cause: error },
            );
          }
        }
        throw error;
      }
      if (operation.kind === "offline") saveOffline(result);
      if (operation.kind === "inspect") remember(operation.resource, result);
      if (operation.kind === "list" && operation.resource) {
        const ids = result.split(/\s+/).filter(Boolean);
        for (const id of ids) {
          if (
            operation.resource === "volume"
              ? !projects.some((project) =>
                  [
                    candidateProjectNames(installationId, project).data,
                    candidateProjectNames(installationId, project).workspace,
                  ].includes(id),
                )
              : !/^[a-f0-9]{12,64}$/.test(id)
          )
            deny();
          // List membership permits inspection only. remember() still proves the
          // complete registry/name/image/owner identity before mutation.
          ownedResources.get(operation.resource).add(id);
        }
      }
      return result;
    };
    return {
      env,
      docker,
      policyPath,
      policyHash,
      helperImageId,
      imageId,
      moduleHashes,
      spawnController() {
        const descriptor = {
          path: node,
          sha256: candidateFile(node, { maximum: 128 * 1024 * 1024 }).sha256,
          args: controllerArgs,
          entry,
          entryHash: candidateFile(entry, { maximum: 8 * 1024 * 1024 }).sha256,
          cwd: scratch,
          role: "controller",
          environment: controllerEnv,
        };
        const key = JSON.stringify([node, controllerArgs]);
        allowed.set(key, descriptor);
        try {
          return spawn(node, controllerArgs, {
            cwd: scratch,
            env: controllerEnv,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } finally {
          allowed.delete(key);
        }
      },
      allowControllerOrigin(origin) {
        installed.allowOrigin(origin);
      },
      async captureRuntime(container) {
        const output = await docker([
          "exec",
          container,
          "node",
          "-e",
          'process.stdout.write(require("node:fs").readFileSync("/data/home/.candidate/guard.jsonl","utf8"))',
        ]);
        const rows = parseRows(output);
        const released = rows.filter((row) => row.event === "bootstrap-released").at(-1);
        if (!released || !HASH.test(released.containerId)) deny();
        runtimeRows.set(released.containerId, rows);
        writeFileSync(join(privateRoot, `runtime-${released.containerId}.jsonl`), output + "\n", {
          mode: 0o600,
        });
      },
      writeSuccessReceipt(evidenceDir) {
        const driver = parseRows(
          candidateFile(join(privateRoot, "driver.jsonl"), {
            privateFile: true,
            maximum: 4 * 1024 * 1024,
          }).bytes,
        );
        const controller = parseRows(
          candidateFile(join(privateRoot, "controller.jsonl"), {
            privateFile: true,
            maximum: 4 * 1024 * 1024,
          }).bytes,
        );
        const acks = controller.filter((row) => row.event === "native-egress-ack");
        if (
          acks.length < 3 ||
          !runtimeRows.has("offline") ||
          !driver.some((row) => row.event === "driver-closed")
        )
          deny();
        const hostEntries = [...driver, ...controller].filter((row) => row.event === "pre-core");
        for (const rows of [driver, controller, ...runtimeRows.values()]) {
          const entries = rows.filter((row) => row.event === "pre-core");
          if (
            !entries.length ||
            entries.some((row) => row.negativeProbes !== 6 || row.dnsNegativeProbes !== 4)
          )
            deny();
          for (const row of rows.filter((row) => row.event === "child-started" && row.isNode))
            if (
              !(rows === driver || rows === controller ? hostEntries : entries).some(
                (entry) =>
                  entry.pid === row.childPid &&
                  entry.ppid === row.pid &&
                  entry.role === row.childRole &&
                  entry.policyHash === row.childPolicyHash &&
                  entry.argvHash === row.argvHash,
              )
            )
              deny();
        }
        for (const rows of runtimeRows.values())
          for (const row of rows.filter((row) => row.event === "bootstrap-released"))
            if (
              !acks.some(
                (ack) =>
                  ack.containerId === row.containerId &&
                  ack.bootNonce === row.bootNonce &&
                  ack.netns === row.netns &&
                  ack.policyHash === row.policyHash,
              )
            )
              deny();
        mkdirSync(evidenceDir, { recursive: true });
        const receipt = {
          version: 1,
          controllerPolicyHash: policyHash,
          helperImageId,
          imageId,
          installationId,
          firewallPorts: [...fixturePorts],
          videoListenerBindings: [...runtimeRows.values()]
            .flat()
            .filter(
              (row) =>
                row.event === "listener" &&
                row.requestedPort === 0 &&
                row.aliasEntryHash === controllerPolicy.controller.videoEditorHash,
            )
            .map(({ pid, policyHash, host, port, aliasEntryHash }) => ({
              pid,
              policyHash,
              host,
              port,
              entryHash: aliasEntryHash,
            })),
          nodePreloads: [...driver, ...controller, ...[...runtimeRows.values()].flat()]
            .filter((row) => row.event === "pre-core")
            .map(({ pid, ppid, role, negativeProbes, dnsNegativeProbes, policyHash }) => ({
              pid,
              ppid,
              role,
              negativeProbes,
              dnsNegativeProbes,
              policyHash,
            })),
          nativeEgressAcks: acks.map(
            ({ containerId, bootNonce, netns, policyHash, receipts, nativeNegativeProbes }) => ({
              containerId,
              bootNonce,
              netns,
              policyHash,
              receipts,
              nativeNegativeProbes,
            }),
          ),
          nativeProcesses: driver
            .filter((row) => row.event === "child-started" && !row.isNode)
            .map(({ childPid }) => ({
              pid: childPid,
              closed: driver.some(
                (row) => row.event === "child-closed" && row.childPid === childPid,
              ),
            })),
        };
        if (receipt.nativeProcesses.some((row) => !row.closed)) deny();
        if (
          videoRequired &&
          (!receipt.videoListenerBindings.length ||
            receipt.videoListenerBindings.some(
              (row) => row.host !== "127.0.0.1" || row.port !== 18794,
            ))
        )
          deny();
        writeFileSync(
          join(evidenceDir, "docker-candidate-guard-receipt.json"),
          JSON.stringify(receipt, null, 2) + "\n",
        );
      },
      offlineRecoveryArguments(workspace, recoveryEntry) {
        const projects = registry();
        if (
          !projects.some(
            (project) => candidateProjectNames(installationId, project).workspace === workspace,
          ) ||
          !/^\/opt\/codeshell\/(?:packages\/server|node_modules\/@cjhyy\/code-shell-server)\/dist\/bin\/code-shell-settings-recovery\.js$/.test(
            recoveryEntry,
          )
        )
          deny();
        const directory = join(privateRoot, `offline-${randomBytes(8).toString("hex")}`);
        mkdirSync(directory, { mode: 0o755 });
        for (const name of candidateRuntimeModules) {
          copyFileSync(join(moduleRoot, name), join(directory, name));
          chmodSync(join(directory, name), 0o444);
        }
        const mount = "/run/codeshell-candidate",
          offlinePreload = `${mount}/docker-candidate-preload.mjs`;
        const policy = {
          version: 1,
          role: "runtime",
          home: "/tmp/candidate-home",
          dataRoot: "/tmp",
          preload: offlinePreload,
          preloadHash: moduleHashes["docker-candidate-preload.mjs"],
          guardHash: moduleHashes["docker-candidate-guard.mjs"],
          receipt: "/tmp/candidate-home/.candidate/guard.jsonl",
          origins: [],
          listeners: [],
          children: [],
          runtime: {
            offline: "none",
            entry: recoveryEntry,
            recoveryEntry,
            imageId,
            nativePrograms: [],
            moduleHashes,
          },
        };
        const bytes = JSON.stringify(policy) + "\n";
        writeFileSync(join(directory, "runtime-policy.json"), bytes, { flag: "wx", mode: 0o444 });
        const nonce = randomBytes(6).toString("hex");
        const name = `candidate-offline-${installationId}-${nonce}`;
        const args = [
          "run",
          "--rm",
          "-i",
          "--name",
          name,
          "--network",
          "none",
          "--user",
          "1000:1000",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--no-healthcheck",
          "--label",
          `io.codeshell.candidate-offline.installation=${installationId}`,
          "--label",
          `io.codeshell.candidate-offline.nonce=${nonce}`,
          "--label",
          `io.codeshell.candidate-offline.workspace=${workspace}`,
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=32m,mode=1777",
          "--workdir",
          "/workspace",
          "--mount",
          `type=volume,source=${workspace},target=/workspace`,
          "--mount",
          `type=bind,source=${directory},target=${mount},readonly`,
          "--env",
          "HOME=/tmp/candidate-home",
          "--env",
          "USERPROFILE=/tmp/candidate-home",
          "--env",
          "CODE_SHELL_HOME=/tmp/candidate-home/.code-shell",
          "--env",
          `NODE_OPTIONS=--import=${offlinePreload}`,
          "--env",
          "CODESHELL_DOCKER_CANDIDATE_CONTAINER=1",
          "--env",
          `CODESHELL_DOCKER_CANDIDATE_CONFIG=${mount}/runtime-policy.json`,
          "--env",
          `CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH=${candidateHash(bytes)}`,
          "--entrypoint",
          "node",
          image,
          "--input-type=module",
        ];
        offline = { args, name, nonce, workspace };
        return args;
      },
      async close() {
        const failures = [];
        for (const proc of children) {
          try {
            const closed = once(proc, "close");
            await deadline(closed, 1000, "Owned native child did not close promptly").catch(
              () => {},
            );
            if (!children.has(proc)) continue;
            failures.push(new Error("An owned native child remained live at fixture close"));
            proc.kill("SIGKILL");
            await deadline(closed, 5000, "Owned native child exit unknown");
          } catch (error) {
            failures.push(error);
          }
        }
        if (offline) {
          try {
            let output;
            try {
              output = await native(dockerPath, ["container", "inspect", offline.name], {
                timeout: 5000,
              });
            } catch (error) {
              if (!candidateMissingContainer(error, offline.name)) throw error;
            }
            if (output) {
              const values = JSON.parse(output),
                value = values[0];
              if (
                values.length !== 1 ||
                value.Image !== imageId ||
                value.Name !== `/${offline.name}` ||
                !HASH.test(value.Id) ||
                value.Config?.Labels?.["io.codeshell.candidate-offline.installation"] !==
                  installationId ||
                value.Config?.Labels?.["io.codeshell.candidate-offline.nonce"] !== offline.nonce ||
                value.Config?.Labels?.["io.codeshell.candidate-offline.workspace"] !==
                  offline.workspace
              )
                deny();
              await native(dockerPath, ["container", "rm", "-f", value.Id], { timeout: 5000 });
            }
          } catch (error) {
            failures.push(error);
          }
        }
        // A terminated controller may have lost the --rm response. Recover only
        // the exact random names recorded before this fixture's helper launch.
        const controllerReceipt = join(privateRoot, "controller.jsonl");
        try {
          if (existsSync(controllerReceipt)) {
            for (const row of parseRows(
              candidateFile(controllerReceipt, { privateFile: true, maximum: 4 * 1024 * 1024 })
                .bytes,
            ).filter((row) => row.event === "helper-starting")) {
              try {
                if (
                  !UUID.test(installationId) ||
                  !row.name?.startsWith(`candidate-helper-${installationId}-`) ||
                  !/^[A-Za-z0-9-]{1,220}$/.test(row.name) ||
                  !HASH.test(row.containerId) ||
                  row.helperImageId !== helperImageId
                )
                  deny();
                let output;
                try {
                  output = await native(dockerPath, ["container", "inspect", row.name], {
                    timeout: 5000,
                  });
                } catch (error) {
                  if (candidateMissingContainer(error, row.name)) continue;
                  throw error;
                }
                const resources = JSON.parse(output);
                const value = resources[0];
                if (
                  resources.length !== 1 ||
                  value.Image !== helperImageId ||
                  value.Name !== `/${row.name}` ||
                  !HASH.test(value.Id) ||
                  value.Config?.Labels?.["io.codeshell.candidate-helper.installation"] !==
                    installationId ||
                  value.Config?.Labels?.["io.codeshell.candidate-helper.target"] !== row.containerId
                )
                  deny();
                await native(dockerPath, ["container", "rm", "-f", value.Id], { timeout: 5000 });
              } catch (error) {
                failures.push(error);
              }
            }
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          await native(dockerPath, ["image", "rm", helperImageId]);
        } catch (error) {
          failures.push(error);
        }
        if (failures.length)
          throw new AggregateError(failures, "Docker candidate custody cleanup failed");
        assert.equal(children.size, 0);
        record("driver-closed");
      },
    };
  } catch (primary) {
    const failures = [];
    try {
      const id =
        helperImageId ??
        (iid && existsSync(iid) ? candidateFile(iid).bytes.toString().trim() : undefined);
      if (id) {
        if (!/^sha256:[a-f0-9]{64}$/.test(id)) deny();
        const value = JSON.parse(await initialDocker(["image", "inspect", id]))[0];
        if (
          value?.Id !== id ||
          value.Config?.Labels?.["io.codeshell.candidate-helper-build"] !== buildNonce
        )
          deny();
        await initialDocker(["image", "rm", id]);
      }
    } catch (error) {
      failures.push(error);
    }
    if (children.size)
      failures.push(new Error("Setup failed with unknown child custody; private HOME retained"));
    if (failures.length)
      throw new AggregateError(
        [primary, ...failures],
        "Docker candidate setup and cleanup failed",
        { cause: primary },
      );
    throw primary;
  }
}
