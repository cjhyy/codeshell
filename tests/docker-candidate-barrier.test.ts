import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCandidateBoot, waitCandidateEgress } from "../scripts/docker-candidate-barrier.mjs";

const policyHash = "a".repeat(64);
async function fixture(run) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "candidate-barrier-")));
  chmodSync(home, 0o700);
  mkdirSync(join(home, ".candidate"), { mode: 0o700 });
  const before = process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH;
  process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH = policyHash;
  try {
    await run({
      home,
      runtime: { nonce: "b".repeat(32), projectId: "89386552-c3b6-4c88-9beb-21bab1cabd9b" },
    });
  } finally {
    if (before === undefined) delete process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH;
    else process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH = before;
    rmSync(home, { recursive: true, force: true });
  }
}
const namespace = () => "net:[4026533039]";
function ack(config, boot, extra = {}) {
  writeFileSync(
    join(config.home, ".candidate", `ack-${config.runtime.nonce}.json`),
    JSON.stringify({
      version: 1,
      projectId: config.runtime.projectId,
      nonce: config.runtime.nonce,
      bootNonce: boot.bootNonce,
      policyHash,
      netns: namespace(),
      containerId: "c".repeat(64),
      nativeEgress: "ipv4-ipv6-output-default-deny",
      preCore: true,
      receipts: [
        { family: 4, rulesHash: "d".repeat(64) },
        { family: 6, rulesHash: "e".repeat(64) },
      ],
      ...extra,
    }),
    { mode: 0o600 },
  );
}

test("stale ACK cannot release a new runtime boot; only exact current boot reaches the entry boundary", async () =>
  fixture(async (config) => {
    ack(config, { bootNonce: "0".repeat(32) });
    let released = false;
    const events = [];
    const waiting = waitCandidateEgress(config, {
      main: true,
      namespace,
      timeout: 1000,
      record(event, data) {
        events.push({ event, ...data });
      },
    }).then(() => {
      released = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(released).toBe(false);
      const boot = readCandidateBoot(join(config.home, ".candidate/boot.json"));
      expect(boot.state).toBe("waiting");
      ack(config, boot);
      await waiting;
      expect(released).toBe(true);
      expect(readCandidateBoot(join(config.home, ".candidate/boot.json")).state).toBe("released");
      expect(events.map((entry) => entry.event)).toEqual([
        "bootstrap-waiting",
        "bootstrap-released",
      ]);
    } finally {
      await waiting.catch(() => {});
    }
  }));

for (const [name, extra] of [
  ["different namespace", { netns: "net:[1]" }],
  ["different policy", { policyHash: "f".repeat(64) }],
  ["missing IPv6", { receipts: [{ family: 4, rulesHash: "d".repeat(64) }] }],
  ["wrong container ID", { containerId: "mutable-container" }],
] as const)
  test(`current-boot ACK with ${name} refuses the product entry`, async () =>
    fixture(async (config) => {
      let released = false;
      const waiting = waitCandidateEgress(config, {
        main: true,
        namespace,
        timeout: 500,
        record(event) {
          if (event === "bootstrap-released") released = true;
        },
      });
      void waiting.catch(() => {});
      const boot = JSON.parse(readFileSync(join(config.home, ".candidate/boot.json"), "utf8"));
      ack(config, boot, extra);
      await expect(waiting).rejects.toThrow("refused");
      expect(released).toBe(false);
    }));

test("a missing ACK reaches a bounded explicit timeout while the boot remains waiting", async () =>
  fixture(async (config) => {
    await expect(
      waitCandidateEgress(config, { main: true, namespace, timeout: 75, record() {} }),
    ).rejects.toThrow("timed out before Core import");
    expect(readCandidateBoot(join(config.home, ".candidate/boot.json")).state).toBe("waiting");
  }));
