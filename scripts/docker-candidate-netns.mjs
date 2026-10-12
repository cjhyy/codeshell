// Fixture-only Linux namespace firewall. Never used by a production image.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  readlinkSync,
  writeFileSync,
  renameSync,
  chmodSync,
  chownSync,
  readFileSync,
} from "node:fs";

const HASH = /^[a-f0-9]{64}$/;
const refuse = () => {
  throw new Error("Docker candidate namespace policy refused");
};
export const fixturePorts = Object.freeze([8790, 18791, 18792, 18793]);

export function candidateFirewallRules(family) {
  if (![4, 6].includes(family)) refuse();
  const loopback = family === 4 ? "127.0.0.1/32" : "::1/128";
  return [
    "*filter",
    ":INPUT ACCEPT [0:0]",
    ":FORWARD DROP [0:0]",
    ":OUTPUT DROP [0:0]",
    "-A OUTPUT -m conntrack --ctstate ESTABLISHED -j ACCEPT",
    ...fixturePorts.map(
      (port) => `-A OUTPUT -o lo -d ${loopback} -p tcp --dport ${port} -j ACCEPT`,
    ),
    "COMMIT",
    "",
  ].join("\n");
}

/** No host, PID, mount or user namespace is entered by this helper. */
export function candidateFirewallHelperArguments({
  imageId,
  containerId,
  name,
  installationId,
  dataVolume,
  policy,
}) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !HASH.test(containerId) ||
    !/^[a-f0-9-]{36}$/.test(installationId) ||
    !/^[A-Za-z0-9-]{1,220}$/.test(name) ||
    !dataVolume.startsWith(`codeshell-${installationId}-`) ||
    !dataVolume.endsWith("-data")
  )
    refuse();
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--label",
    `io.codeshell.candidate-helper.installation=${installationId}`,
    "--label",
    `io.codeshell.candidate-helper.target=${containerId}`,
    "--network",
    `container:${containerId}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "32",
    "--memory",
    "128m",
    "--mount",
    `type=volume,source=${dataVolume},target=/data`,
    "--entrypoint",
    "node",
    imageId,
    "/helper/docker-candidate-netns-entry.mjs",
    Buffer.from(JSON.stringify(policy)).toString("base64url"),
  ];
}

export async function applyCandidateFirewall(
  policy,
  {
    run = firewallNativeCommand,
    namespace = () => readlinkSync("/proc/self/ns/net"),
    publish,
  } = {},
) {
  if (
    policy?.version !== 1 ||
    !HASH.test(policy.containerId) ||
    !HASH.test(policy.policyHash) ||
    !/^[a-f0-9]{32}$/.test(policy.nonce) ||
    !/^net:\[[0-9]+\]$/.test(policy.netns) ||
    namespace() !== policy.netns ||
    !/^[a-f0-9-]{36}$/.test(policy.projectId)
  )
    refuse();
  const receipts = [];
  for (const family of [4, 6]) {
    const prefix = family === 4 ? "iptables" : "ip6tables";
    const rules = candidateFirewallRules(family);
    await run(`/usr/sbin/${prefix}-restore`, ["--wait", "5"], { input: rules, timeout: 10000 });
    // -C verifies exact permits; -S rejects extra accepts or a changed policy.
    await run(
      `/usr/sbin/${prefix}`,
      [
        "--wait",
        "5",
        "-C",
        "OUTPUT",
        "-m",
        "conntrack",
        "--ctstate",
        "ESTABLISHED",
        "-j",
        "ACCEPT",
      ],
      { timeout: 5000 },
    );
    for (const port of fixturePorts)
      await run(
        `/usr/sbin/${prefix}`,
        [
          "--wait",
          "5",
          "-C",
          "OUTPUT",
          "-o",
          "lo",
          "-d",
          family === 4 ? "127.0.0.1/32" : "::1/128",
          "-p",
          "tcp",
          "--dport",
          String(port),
          "-j",
          "ACCEPT",
        ],
        { timeout: 5000 },
      );
    const { stdout } = await run(`/usr/sbin/${prefix}`, ["--wait", "5", "-S", "OUTPUT"], {
      timeout: 5000,
    });
    const lines = stdout.trim().split("\n");
    if (
      lines[0] !== "-P OUTPUT DROP" ||
      lines.length !== 2 + fixturePorts.length ||
      lines.slice(1).some((line) => !line.startsWith("-A OUTPUT ") || !line.endsWith(" -j ACCEPT"))
    )
      refuse();
    receipts.push({ family, rulesHash: createHash("sha256").update(rules).digest("hex") });
  }
  if (namespace() !== policy.netns) refuse();
  const receipt = {
    version: 1,
    projectId: policy.projectId,
    containerId: policy.containerId,
    policyHash: policy.policyHash,
    nonce: policy.nonce,
    netns: policy.netns,
    nativeEgress: "ipv4-ipv6-output-default-deny",
    preCore: true,
    receipts,
  };
  if (!publish) refuse();
  await publish(receipt);
  return receipt;
}

/** Only called by the helper entry after both firewall families were verified. */
export function publishCandidateFirewall(receipt) {
  const path = `/data/.candidate-egress-${receipt.nonce}.json`;
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
  chownSync(temporary, 1000, 1000);
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

// execFile does not support an input option. Keep stdin and its close custody
// in a native adapter instead of spawning a shell or leaving restore running.
export function firewallNativeCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: options.timeout, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

export function candidateHelperInventory() {
  return JSON.parse(readFileSync("/helper/inventory.json", "utf8"));
}
