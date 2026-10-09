import { createHash } from "node:crypto";
import { appendFileSync, realpathSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isAbsolute, relative } from "node:path";
import { installLocalNetworkGuard } from "../../../scripts/runtime-cost-smoke-isolation.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** JS transport checks only: this does not confine Chromium, raw net/tls, or the OS. */
export async function probeMacosKeychainGuard(origin, receiptFile, role) {
  const root = realpathSync(process.env.CODESHELL_MACOS_ACCEPTANCE_ROOT ?? "");
  const homes = Object.fromEntries(
    ["HOME", "USERPROFILE", "CODE_SHELL_HOME", "CODE_SHELL_TEST_HOME"].map((key) => {
      const value = process.env[key];
      if (!value || !isAbsolute(value)) throw new Error(`Missing private fixture ${key}`);
      const actual = realpathSync(value);
      const within = relative(root, actual);
      if (!within || within.startsWith("..") || isAbsolute(within))
        throw new Error(`Fixture ${key} is outside its private root`);
      return [key, hash(actual)];
    }),
  );
  if (homes.HOME !== homes.USERPROFILE || homes.CODE_SHELL_HOME !== homes.CODE_SHELL_TEST_HOME)
    throw new Error("Fixture storage identities disagree");
  if (process.env.CODE_SHELL_DATA_ROOT !== undefined)
    throw new Error("Fixture inherited an alternate data root");
  installLocalNetworkGuard(origin);
  const probes = [
    () => fetch("https://codeshell-keychain-negative.invalid/"),
    () => http.request("http://codeshell-keychain-negative.invalid/"),
    () => http.get("http://codeshell-keychain-negative.invalid/"),
    () => https.request("https://codeshell-keychain-negative.invalid/"),
    () => https.get("https://codeshell-keychain-negative.invalid/"),
    () =>
      http.request(origin, {
        createConnection() {
          throw new Error("Unexpected connection");
        },
      }),
    () => fetch(origin, { dispatcher: {} }),
  ];
  for (const probe of probes) {
    let rejected = false;
    try {
      await probe();
    } catch (error) {
      rejected = /Cost smoke refused/.test(String(error));
    }
    if (!rejected) throw new Error("A pre-Core network negative probe was not rejected");
  }
  const receipt = {
    role,
    pid: process.pid,
    ppid: process.ppid,
    origin,
    homeId: homes.HOME,
    homes,
    negativeProbes: probes.length,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    guardScope: "fetch/http/https; no Chromium/raw net/tls/OS confinement claim",
  };
  appendFileSync(receiptFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return receipt;
}

if (process.env.CODESHELL_COST_SMOKE_ORIGIN) {
  await probeMacosKeychainGuard(
    process.env.CODESHELL_COST_SMOKE_ORIGIN,
    process.env.CODESHELL_COST_SMOKE_GUARD_LOG,
    process.argv.some((value) => value.includes("agent-server-stdio")) ? "worker" : "Main",
  );
}
