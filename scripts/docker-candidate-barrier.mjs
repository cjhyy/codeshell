// Test-only bootstrap barrier: no Core import until the exact boot has a native ACK.
import { randomBytes } from "node:crypto";
import { mkdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { candidateFile } from "./docker-candidate-guard.mjs";

const refuse = () => {
  throw new Error("Docker candidate pre-Core egress barrier refused");
};
const hash = /^[a-f0-9]{64}$/;
export function readCandidateBoot(path) {
  const boot = JSON.parse(candidateFile(path, { maximum: 8192, privateFile: true }).bytes);
  if (
    boot?.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(boot.bootNonce) ||
    !hash.test(boot.policyHash) ||
    !/^net:\[[0-9]+\]$/.test(boot.netns) ||
    !["waiting", "released"].includes(boot.state) ||
    !Number.isSafeInteger(boot.pid) ||
    boot.pid < 1
  )
    refuse();
  return boot;
}

function publish(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

export async function waitCandidateEgress(
  config,
  { main, record, namespace = () => readlinkSync("/proc/self/ns/net"), timeout = 90000 } = {},
) {
  if (
    !config.runtime ||
    !/^[a-f0-9]{32}$/.test(config.runtime.nonce) ||
    !hash.test(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH)
  )
    refuse();
  const directory = join(config.home, ".candidate");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bootPath = join(directory, "boot.json");
  const netns = namespace();
  const boot = main
    ? {
        version: 1,
        bootNonce: randomBytes(16).toString("hex"),
        policyHash: process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH,
        netns,
        state: "waiting",
        pid: process.pid,
      }
    : readCandidateBoot(bootPath);
  if (main) publish(bootPath, boot);
  if (
    boot.netns !== netns ||
    boot.policyHash !== process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH
  )
    refuse();
  record("bootstrap-waiting", { bootNonce: boot.bootNonce, netns, main: !!main });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let ack;
    try {
      ack = JSON.parse(
        candidateFile(join(directory, `ack-${config.runtime.nonce}.json`), {
          maximum: 32768,
          privateFile: true,
        }).bytes,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (ack && ack.bootNonce === boot.bootNonce) {
      if (
        ack.version !== 1 ||
        ack.nonce !== config.runtime.nonce ||
        ack.policyHash !== boot.policyHash ||
        ack.netns !== netns ||
        ack.projectId !== config.runtime.projectId ||
        !hash.test(ack.containerId) ||
        ack.nativeEgress !== "ipv4-ipv6-output-default-deny" ||
        ack.preCore !== true ||
        !Array.isArray(ack.receipts) ||
        ack.receipts.length !== 2 ||
        ack.receipts[0]?.family !== 4 ||
        ack.receipts[1]?.family !== 6 ||
        ack.receipts.some((entry) => !hash.test(entry.rulesHash))
      )
        refuse();
      if (main) publish(bootPath, { ...boot, state: "released" });
      record("bootstrap-released", {
        bootNonce: boot.bootNonce,
        netns,
        containerId: ack.containerId,
      });
      return ack;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Docker candidate native egress ACK timed out before Core import");
}
