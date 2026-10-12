// Test-only bootstrap: reviewed ws loads after guards/probes, before the product entry.
import { candidateFile, installDockerCandidateGuard } from "./docker-candidate-guard.mjs";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = candidateFile(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG ?? "", {
  privateFile: process.env.CODESHELL_DOCKER_CANDIDATE_CONTAINER !== "1",
});
if (file.sha256 !== process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH)
  throw new Error("Docker candidate policy digest changed");
const config = JSON.parse(file.bytes);
if (process.env.CODESHELL_DOCKER_CANDIDATE_CONTAINER === "1") {
  if (
    process.platform !== "linux" ||
    config.role !== "runtime" ||
    config.home !== (config.runtime?.offline === "none" ? "/tmp/candidate-home" : "/data/home") ||
    config.dataRoot !== (config.runtime?.offline === "none" ? "/tmp" : "/data") ||
    config.preload !== "/run/codeshell-candidate/docker-candidate-preload.mjs" ||
    !/^sha256:[a-f0-9]{64}$/.test(config.runtime?.imageId)
  )
    throw new Error("Docker candidate container policy refused");
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  chmodSync(config.home, 0o700);
  mkdirSync(`${config.home}/.candidate`, { recursive: true, mode: 0o700 });
  for (const name of [
    "docker-candidate-barrier.mjs",
    "docker-candidate-runtime-child.mjs",
    "docker-candidate-ack-writer.mjs",
    "docker-candidate-native-argv.mjs",
    "docker-candidate-video-argv.mjs",
  ])
    if (
      candidateFile(fileURLToPath(new URL(name, import.meta.url))).sha256 !==
      config.runtime.moduleHashes?.[name]
    )
      throw new Error("Docker candidate bootstrap module digest changed");
  if (!process.env.CODESHELL_DOCKER_CANDIDATE_ROLE && process.argv[1] !== config.runtime.entry)
    process.env.CODESHELL_DOCKER_CANDIDATE_ROLE = "installer";
  config.runtime.nativePrograms = config.runtime.nativePrograms.map((value) =>
    value.sha256 === "IMAGE_PROGRAM"
      ? {
          ...value,
          path: realpathSync(value.path),
          sha256: candidateFile(realpathSync(value.path), { maximum: 128 * 1024 * 1024 }).sha256,
        }
      : value,
  );
  config.children = config.children.map((child) =>
    child.path === "SELF_NODE"
      ? {
          ...child,
          path: realpathSync(process.execPath),
          sha256: candidateFile(realpathSync(process.execPath), { maximum: 128 * 1024 * 1024 })
            .sha256,
        }
      : child,
  );
}
let dockerCommand;
let loadStockWebSocket;
if (config.role === "controller") {
  for (const name of [
    "docker-candidate-controller.mjs",
    "docker-candidate-adapter.mjs",
    "docker-candidate-netns.mjs",
  ])
    if (
      candidateFile(fileURLToPath(new URL(name, import.meta.url))).sha256 !==
      config.controller?.moduleHashes?.[name]
    )
      throw new Error("Docker candidate controller adapter digest changed");
  dockerCommand = (await import("./docker-candidate-controller.mjs")).createCandidateController(
    config,
  );
  if (config.stockWebSocket) {
    if (
      candidateFile(fileURLToPath(new URL("docker-candidate-stock-ws.mjs", import.meta.url)))
        .sha256 !== config.controller.moduleHashes?.["docker-candidate-stock-ws.mjs"]
    )
      throw new Error("Docker candidate stock WebSocket module digest changed");
    const { loadCandidateStockWebSocket } = await import("./docker-candidate-stock-ws.mjs");
    loadStockWebSocket = () => loadCandidateStockWebSocket(config.stockWebSocket);
  }
}
const runtimeChild = config.runtime
  ? (await import("./docker-candidate-runtime-child.mjs")).candidateRuntimeChild
  : undefined;
const installed = installDockerCandidateGuard(config, {
  runtimeChild,
  dockerCommand,
  loadStockWebSocket,
});
if (config.runtime?.offline === "none") {
  if (
    config.origins.length ||
    config.listeners.length ||
    config.runtime.recoveryEntry !== config.runtime.entry ||
    !config.runtime.entry.endsWith("/dist/bin/code-shell-settings-recovery.js")
  )
    throw new Error("Docker candidate offline contract refused");
  installed.record("offline-network-none-entry");
} else if (config.runtime) {
  const writer = process.argv[1] === "/run/codeshell-candidate/docker-candidate-ack-writer.mjs";
  if (writer) {
    if (process.argv.length !== 3 || !/^[A-Za-z0-9_-]{1,65536}$/.test(process.argv[2]))
      throw new Error("Docker candidate ACK writer argv refused");
    installed.record("ack-writer-entry");
  } else {
    const { waitCandidateEgress } = await import("./docker-candidate-barrier.mjs");
    await waitCandidateEgress(config, {
      main: process.argv[1] === config.runtime.entry,
      record: installed.record,
    });
  }
}
