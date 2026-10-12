// Fixed test-only writer. The preload verifies this entry's bytes and argv.
import { fsyncSync, openSync, closeSync, renameSync, writeFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { candidateFile } from "./docker-candidate-guard.mjs";
import { readCandidateBoot } from "./docker-candidate-barrier.mjs";

const deny = () => {
  throw new Error("Docker candidate ACK writer refused");
};
if (
  process.platform !== "linux" ||
  process.argv.length !== 3 ||
  !/^[A-Za-z0-9_-]{1,65536}$/.test(process.argv[2])
)
  deny();
const config = JSON.parse(candidateFile(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG).bytes);
const receipt = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
const boot = readCandidateBoot(join(config.home, ".candidate/boot.json"));
if (
  boot.state !== "waiting" ||
  receipt.bootNonce !== boot.bootNonce ||
  receipt.policyHash !== boot.policyHash ||
  receipt.policyHash !== process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH ||
  receipt.netns !== boot.netns ||
  receipt.netns !== readlinkSync("/proc/self/ns/net") ||
  receipt.version !== 1 ||
  receipt.nonce !== config.runtime.nonce ||
  receipt.projectId !== config.runtime.projectId ||
  !/^[a-f0-9]{64}$/.test(receipt.containerId) ||
  receipt.preCore !== true ||
  receipt.nativeEgress !== "ipv4-ipv6-output-default-deny" ||
  receipt.receipts?.length !== 2 ||
  receipt.receipts[0]?.family !== 4 ||
  receipt.receipts[1]?.family !== 6 ||
  receipt.receipts.some((value) => !/^[a-f0-9]{64}$/.test(value.rulesHash))
)
  deny();
const path = join(config.home, ".candidate", `ack-${config.runtime.nonce}.json`);
const temporary = `${path}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify(receipt) + "\n", { mode: 0o600, flag: "wx" });
const file = openSync(temporary, "r");
try {
  fsyncSync(file);
} finally {
  closeSync(file);
}
renameSync(temporary, path);
const directory = openSync(join(config.home, ".candidate"), "r");
try {
  fsyncSync(directory);
} finally {
  closeSync(directory);
}
console.log(
  JSON.stringify({
    ackPublished: true,
    bootNonce: boot.bootNonce,
    containerId: receipt.containerId,
  }),
);
