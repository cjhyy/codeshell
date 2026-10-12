import { expect, test } from "bun:test";
import {
  applyCandidateFirewall,
  candidateFirewallHelperArguments,
  candidateFirewallRules,
  fixturePorts,
} from "../scripts/docker-candidate-netns.mjs";

const policy = {
  version: 1,
  containerId: "a".repeat(64),
  projectId: "72b1462d-cb22-4f14-8ecd-d0cf2b2e966a",
  policyHash: "b".repeat(64),
  nonce: "c".repeat(32),
  bootNonce: "e".repeat(32),
  netns: "net:[4026533039]",
};
const namespace = () => policy.netns;

function simulatedKernel(failure?: (command: string, args: string[]) => void) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    failure?.(command, args);
    if (args.includes("-S"))
      return {
        stdout: [
          "-P OUTPUT DROP",
          "-A OUTPUT -m conntrack --ctstate ESTABLISHED -j ACCEPT",
          ...fixturePorts.map((port) => `-A OUTPUT -o lo -p tcp --dport ${port} -j ACCEPT`),
        ].join("\n"),
      };
    return { stdout: "" };
  };
  return { calls, run, probe: async () => "deadline" };
}

test("helper argv joins only the immutable owned container network namespace with NET_ADMIN", () => {
  const installationId = "0a75afde-6478-4fa6-b528-f0273a4a3dca";
  const options = {
    imageId: `sha256:${"d".repeat(64)}`,
    containerId: policy.containerId,
    name: "candidate-helper-owned",
    installationId,
    dataVolume: `codeshell-${installationId}-${policy.projectId}-data`,
    policy,
  };
  const args = candidateFirewallHelperArguments(options);
  expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual([
    "--network",
    `container:${policy.containerId}`,
  ]);
  expect(args.filter((part) => part === "NET_ADMIN")).toHaveLength(1);
  expect(args).not.toContain("--privileged");
  expect(args).not.toContain("--pid");
  expect(args).not.toContain("host");
  expect(args).toContain("--rm");
  for (const change of [
    { containerId: "mutable-name" },
    { imageId: "helper:latest" },
    { dataVolume: "operator-volume" },
    { dataVolume: `codeshell-${installationId}-other-data` },
    { dataVolume: `codeshell-${installationId}-${policy.projectId},target=/other-data` },
    { name: "--network=host" },
  ])
    expect(() => candidateFirewallHelperArguments({ ...options, ...change })).toThrow("refused");
});

test("both families default DROP with only established replies and five exact loopback TCP ports", () => {
  for (const family of [4, 6]) {
    const rules = candidateFirewallRules(family);
    expect(rules).toContain(":OUTPUT DROP [0:0]");
    expect(rules).toContain(":FORWARD DROP [0:0]");
    expect(rules.match(/^-A OUTPUT /gm)).toHaveLength(6);
    expect(rules).not.toContain("--dport 53");
    expect(rules).not.toContain("0.0.0.0/0");
    expect(rules).toContain(family === 4 ? "127.0.0.1/32" : "::1/128");
  }
});

test("publish occurs only after actual command contracts verify both rule families", async () => {
  const kernel = simulatedKernel();
  let published = 0;
  const receipt = await applyCandidateFirewall(policy, {
    ...kernel,
    namespace,
    publish(value) {
      expect(kernel.calls).toHaveLength(16);
      expect(value.receipts.map((entry) => entry.family)).toEqual([4, 6]);
      published++;
    },
  });
  expect(published).toBe(1);
  expect(receipt.nativeEgress).toBe("ipv4-ipv6-output-default-deny");
  expect(
    kernel.calls
      .filter((call) => call.command.endsWith("-restore"))
      .map((call) => call.options.input),
  ).toEqual([candidateFirewallRules(4), candidateFirewallRules(6)]);
});

for (const stage of ["ip6tables-restore", "-C", "-S"])
  test(`failure at ${stage} never publishes a Core bootstrap ACK`, async () => {
    const kernel = simulatedKernel((command, args) => {
      if (command.endsWith(stage) || args.includes(stage))
        throw new Error("injected native command failure");
    });
    let published = false;
    await expect(
      applyCandidateFirewall(policy, {
        ...kernel,
        namespace,
        publish() {
          published = true;
        },
      }),
    ).rejects.toThrow("injected");
    expect(published).toBe(false);
  });

test("unexpected extra accept, wrong namespace and publication failure all remain explicit failures", async () => {
  const kernel = simulatedKernel();
  let published = false;
  await expect(
    applyCandidateFirewall(policy, {
      namespace,
      probe: kernel.probe,
      publish() {
        published = true;
      },
      run: async (...args) => {
        const result = await kernel.run(...args);
        if (args[1].includes("-S")) result.stdout += "\n-A OUTPUT -j ACCEPT";
        return result;
      },
    }),
  ).rejects.toThrow("refused");
  expect(published).toBe(false);
  const other = simulatedKernel();
  await expect(
    applyCandidateFirewall(policy, { ...other, namespace: () => "net:[1]", publish() {} }),
  ).rejects.toThrow("refused");
  expect(other.calls).toHaveLength(0);
  await expect(
    applyCandidateFirewall(policy, {
      ...simulatedKernel(),
      namespace,
      publish() {
        throw new Error("ACK write failed");
      },
    }),
  ).rejects.toThrow("ACK write failed");
});

test("a successful native egress probe prevents ACK publication despite valid rule command responses", async () => {
  let published = false;
  await expect(
    applyCandidateFirewall(policy, {
      ...simulatedKernel(),
      namespace,
      probe: async () => "connected",
      publish() {
        published = true;
      },
    }),
  ).rejects.toThrow("refused");
  expect(published).toBe(false);
});
